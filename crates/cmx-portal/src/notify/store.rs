//! 通知存储：`notification-center/<userId>/<center>/<file>.json`，一条通知一个文件。

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use crate::config::data_path;
use crate::error::{PortalError, PortalResult};
use crate::fsutil::{read_json, write_json_atomic};
use crate::notify::hub::{self, NotifyEvent};
use crate::now_millis;
use crate::util::{is_safe_segment, write_lock};

/// 三个中心。值即落盘目录名；label 为前端默认显示名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyCenter {
    /// 任务中心。
    Task,
    /// 消息中心。
    Message,
    /// 日志中心。
    Log,
}

impl NotifyCenter {
    /// 返回中心对应的落盘目录名。
    ///
    /// # Returns
    ///
    /// 中心的小写目录名字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyCenter::Task => "task",
            NotifyCenter::Message => "message",
            NotifyCenter::Log => "log",
        }
    }
    /// 返回中心的前端默认显示名。
    ///
    /// # Returns
    ///
    /// 中心的中文显示名。
    pub fn label(self) -> &'static str {
        match self {
            NotifyCenter::Task => "任务中心",
            NotifyCenter::Message => "消息中心",
            NotifyCenter::Log => "日志中心",
        }
    }
    /// 将字符串解析为中心枚举。
    ///
    /// # Arguments
    ///
    /// * `s` - 待解析的字符串（task/message/log）。
    ///
    /// # Returns
    ///
    /// 匹配到的中心枚举；无法匹配时返回 `None`。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "task" => Some(NotifyCenter::Task),
            "message" => Some(NotifyCenter::Message),
            "log" => Some(NotifyCenter::Log),
            _ => None,
        }
    }
    /// 返回全部三个中心。
    ///
    /// # Returns
    ///
    /// 包含任务、消息、日志中心的数组。
    pub fn all() -> [NotifyCenter; 3] {
        [NotifyCenter::Task, NotifyCenter::Message, NotifyCenter::Log]
    }
}

/// 一条通知（落盘结构 = API 返回结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyItem {
    /// 通知唯一标识。
    pub id: String,
    /// 所属中心（task/message/log）。
    pub center: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文（可选）。
    #[serde(default)]
    pub body: String,
    /// 业务等级：info | success | warning | error。
    #[serde(default = "default_level")]
    pub level: String,
    /// 点击通知后可跳转/打开的目标（可选，前端按需用，如 help:/node: 等）。
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub read: bool,
    /// 创建时间（epoch 毫秒）。
    #[serde(default)]
    pub created_at: i64,
}

/// 返回默认的业务等级。
fn default_level() -> String {
    "info".to_string()
}

/// 发布入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyInput {
    /// 目标用户；缺省时由 handler 用当前登录用户回填。
    #[serde(default)]
    pub user_id: Option<String>,
    /// 通知中心（task/message/log）。
    pub center: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文（可选）。
    #[serde(default)]
    pub body: Option<String>,
    /// 业务等级（info/success/warning/error，可选）。
    #[serde(default)]
    pub level: Option<String>,
    /// 点击跳转目标（可选）。
    #[serde(default)]
    pub link: Option<String>,
}

/// 计数（前端角标用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyCounts {
    /// 任务中心未读数。
    pub task: i64,
    /// 消息中心未读数。
    pub message: i64,
    /// 日志中心未读数。
    pub log: i64,
    /// 三中心未读合计 = shellbar 红色数字。
    pub total: i64,
}

/// 校验并清洗用户标识（非空 + 仅允许安全字符）。
///
/// # Arguments
///
/// * `user_id` - 待校验的用户标识。
///
/// # Returns
///
/// 清洗后的合法用户标识。
///
/// # Errors
///
/// 用户标识为空或含非法字符时返回 `PortalError`。
fn safe_user(user_id: &str) -> PortalResult<String> {
    let u = user_id.trim();
    if u.is_empty() {
        return Err(PortalError::bad_request("缺少用户标识"));
    }
    if !is_safe_segment(u) {
        return Err(PortalError::bad_request(format!(
            "用户标识非法（仅允许字母数字 _-）：\"{user_id}\""
        )));
    }
    Ok(u.to_string())
}

/// 构造某用户某中心的通知目录路径。
fn center_dir(user_id: &str, center: NotifyCenter) -> std::path::PathBuf {
    data_path(["notification-center", user_id, center.as_str()])
}

/// 构造某用户某中心单条通知的文件路径。
fn item_path(user_id: &str, center: NotifyCenter, file: &str) -> std::path::PathBuf {
    data_path(["notification-center", user_id, center.as_str(), file])
}

// now_millis 复用 cmx-jsonstore 下沉的实现（见 crate 根 re-export）。

// ───────────────────── 未读计数内存索引 ─────────────────────
//
// counts() 原先每次都全量读盘 + filter 未读；角标查询是高频读路径。这里维护一个进程内
// 未读计数缓存：counts 命中则 O(1) 返回，未命中时全量回填；**写路径（publish/mark_read/
// mark_all_read）成功后直接让该用户的缓存失效**，下次 counts 重新全量回填。
//
// 采用「写即失效」而非「写即增量」：增量更新与全量回填混用会引入 TOCTOU 竞态（落盘后
// 释放写锁、增量更新前，若并发 counts 回填，会导致计数重复）。失效策略让缓存永远等价于
// 「最近一次全量读盘的快照」，写后第一次 counts 才读盘，写本身低频，代价可接受。
//
// 同进程单实例假设（与 util::write_lock 全局锁一致）。进程重启后首次 counts 触发回填。

/// 某用户三中心的未读计数缓存（None 表示尚未加载，需全量回填）。
type UnreadMap = HashMap<String, Option<NotifyCounts>>;

/// 返回全局未读计数缓存的静态引用。
fn unread_cache() -> &'static Mutex<UnreadMap> {
    static CACHE: OnceLock<Mutex<UnreadMap>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 把某中心未读数写进指定 counts 结构（就地更新）。
fn set_center_unread(c: &mut NotifyCounts, center: NotifyCenter, n: i64) {
    match center {
        NotifyCenter::Task => c.task = n,
        NotifyCenter::Message => c.message = n,
        NotifyCenter::Log => c.log = n,
    }
    c.total = c.task + c.message + c.log;
}

/// 标记某用户缓存失效（下次 counts 重新全量回填）。写路径成功后调用。
async fn invalidate_unread(user_id: &str) {
    unread_cache().lock().await.remove(user_id);
}

/// 读取某用户某中心的全部通知（按 createdAt 倒序）。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `center` - 通知中心。
///
/// # Returns
///
/// 该中心全部通知列表（按创建时间倒序）。
///
/// # Errors
///
/// 读取目录失败时返回 `PortalError`；目录不存在时返回空列表。
async fn read_center(user_id: &str, center: NotifyCenter) -> PortalResult<Vec<NotifyItem>> {
    let dir = center_dir(user_id, center);
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(PortalError::Io(e)),
    };
    let mut out = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        match read_json::<NotifyItem>(&entry.path()).await {
            Ok(mut it) => {
                it.center = center.as_str().to_string(); // 以目录为准回填
                out.push(it);
            }
            Err(e) => {
                // 单条损坏不影响其余，但记录告警便于排查落盘异常。
                tracing::warn!(error = %e, path = %entry.path().display(), "通知文件解析失败，跳过");
                continue;
            }
        }
    }
    out.sort_by_key(|b| Reverse(b.created_at));
    Ok(out)
}

/// 列出某用户的通知。center=None 表示三中心全部。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `center` - 通知中心；`None` 表示三中心全部。
///
/// # Returns
///
/// 通知列表（按创建时间倒序）。
///
/// # Errors
///
/// 用户标识非法时返回 `PortalError`。
#[tracing::instrument]
pub async fn list(user_id: &str, center: Option<NotifyCenter>) -> PortalResult<Vec<NotifyItem>> {
    let u = safe_user(user_id)?;
    let mut out = Vec::new();
    match center {
        Some(c) => out.extend(read_center(&u, c).await?),
        None => {
            for c in NotifyCenter::all() {
                out.extend(read_center(&u, c).await?);
            }
            out.sort_by_key(|b| Reverse(b.created_at));
        }
    }
    Ok(out)
}

/// 计算某用户各中心未读数 + 合计。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
///
/// # Returns
///
/// 各中心未读数及合计。
///
/// # Errors
///
/// 用户标识非法时返回 `PortalError`。
#[tracing::instrument]
pub async fn counts(user_id: &str) -> PortalResult<NotifyCounts> {
    let u = safe_user(user_id)?;
    // 优先读缓存；命中则避免全量读盘。
    if let Some(Some(c)) = unread_cache().lock().await.get(u.as_str()).cloned() {
        return Ok(c);
    }
    // 缓存未命中：全量回填后写入缓存。
    let mut c = NotifyCounts {
        task: 0,
        message: 0,
        log: 0,
        total: 0,
    };
    for center in NotifyCenter::all() {
        let unread = read_center(&u, center)
            .await?
            .iter()
            .filter(|x| !x.read)
            .count() as i64;
        set_center_unread(&mut c, center, unread);
    }
    unread_cache()
        .lock()
        .await
        .insert(u.clone(), Some(c.clone()));
    Ok(c)
}

/// 发布一条通知：落盘 + 广播 SSE（新通知事件 + 最新 counts 事件）。
///
/// # Arguments
///
/// * `input` - 通知发布入参。
///
/// # Returns
///
/// 已落盘的通知项。
///
/// # Errors
///
/// 用户标识非法、center 不支持或 title 为空时返回 `PortalError`。
#[tracing::instrument(skip(input))]
pub async fn publish(input: NotifyInput) -> PortalResult<NotifyItem> {
    let user_id = safe_user(input.user_id.as_deref().unwrap_or(""))?;
    let center = NotifyCenter::parse(input.center.trim())
        .ok_or_else(|| PortalError::bad_request("center 仅支持 task/message/log"))?;
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(PortalError::bad_request("title 不能为空"));
    }
    let ts = now_millis();
    // 复用项目雪花 id 生成器：全局唯一、有序，避免同毫秒并发 publish 撞号致通知丢失。
    let id = format!("n_{}", cmx_utils::id::snowflake_id_str());
    let item = NotifyItem {
        id: id.clone(),
        center: center.as_str().to_string(),
        title,
        body: input.body.unwrap_or_default(),
        level: input
            .level
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(default_level),
        link: input.link.unwrap_or_default(),
        read: false,
        created_at: ts,
    };

    {
        let _guard = write_lock().lock().await;
        write_json_atomic(
            &item_path(&user_id, center, &format!("{id}.json")),
            &item,
            true,
        )
        .await?;
    }
    // 落盘成功后让该用户缓存失效：下次 counts 重新全量回填，避免增量更新与并发回填的 TOCTOU。
    invalidate_unread(&user_id).await;

    // 广播：先发新通知，再发最新计数（前端据此更新列表与红色角标）。
    hub::publish_event(NotifyEvent {
        user_id: user_id.clone(),
        kind: "notify".to_string(),
        data: serde_json::to_value(&item).unwrap_or(serde_json::Value::Null),
    });
    if let Ok(c) = counts(&user_id).await {
        hub::publish_event(NotifyEvent {
            user_id: user_id.clone(),
            kind: "counts".to_string(),
            data: serde_json::to_value(&c).unwrap_or(serde_json::Value::Null),
        });
    }
    Ok(item)
}

/// 标记单条已读。返回是否发生变化。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `center` - 通知中心。
/// * `id` - 通知标识。
///
/// # Returns
///
/// 通知是否由未读变为已读。
///
/// # Errors
///
/// 用户标识或通知 id 非法、通知不存在时返回 `PortalError`。
#[tracing::instrument]
pub async fn mark_read(user_id: &str, center: NotifyCenter, id: &str) -> PortalResult<bool> {
    let u = safe_user(user_id)?;
    let file = format!("{}.json", id.trim());
    if !crate::util::is_safe_json_file(&file) {
        return Err(PortalError::bad_request("通知 id 非法"));
    }
    let path = item_path(&u, center, &file);
    let _guard = write_lock().lock().await;
    let mut item = match read_json::<NotifyItem>(&path).await {
        Ok(it) => it,
        Err(PortalError::NotFound(_)) => return Err(PortalError::not_found("通知不存在")),
        Err(e) => return Err(e),
    };
    if item.read {
        return Ok(false);
    }
    item.read = true;
    write_json_atomic(&path, &item, true).await?;
    drop(_guard);
    // 写盘成功后让该用户缓存失效：下次 counts 重新全量回填。
    invalidate_unread(&u).await;
    broadcast_counts(&u).await;
    Ok(true)
}

/// 标记某用户全部（或某中心）已读。返回标记的条数。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `center` - 通知中心；`None` 表示三中心全部。
///
/// # Returns
///
/// 本次标记已读的条数。
///
/// # Errors
///
/// 用户标识非法时返回 `PortalError`。
#[tracing::instrument]
pub async fn mark_all_read(user_id: &str, center: Option<NotifyCenter>) -> PortalResult<i64> {
    let u = safe_user(user_id)?;
    let centers: Vec<NotifyCenter> = match center {
        Some(c) => vec![c],
        None => NotifyCenter::all().to_vec(),
    };
    let mut n = 0i64;
    {
        let _guard = write_lock().lock().await;
        for c in centers {
            for item in read_center(&u, c).await? {
                if !item.read {
                    let mut it = item;
                    it.read = true;
                    write_json_atomic(&item_path(&u, c, &format!("{}.json", it.id)), &it, true)
                        .await?;
                    n += 1;
                }
            }
        }
    }
    if n > 0 {
        // 写盘成功后让该用户缓存失效：下次 counts 重新全量回填。
        invalidate_unread(&u).await;
        broadcast_counts(&u).await;
    }
    Ok(n)
}

/// 重新计算并广播某用户的 counts（标记已读后刷新角标）。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
async fn broadcast_counts(user_id: &str) {
    if let Ok(c) = counts(user_id).await {
        hub::publish_event(NotifyEvent {
            user_id: user_id.to_string(),
            kind: "counts".to_string(),
            data: serde_json::to_value(&c).unwrap_or(serde_json::Value::Null),
        });
    }
}

/// 三中心元信息（前端下拉用：值/标签/图标）。静态注册。
///
/// # Returns
///
/// 包含三中心元信息的 JSON 值。
pub fn centers_meta() -> serde_json::Value {
    json!({
        "centers": [
            { "id": "task", "label": "任务中心", "icon": "task" },
            { "id": "message", "label": "消息中心", "icon": "email" },
            { "id": "log", "label": "日志中心", "icon": "history" }
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn publish_count_read_roundtrip() {
        let _env = crate::util::test_data_root_lock().lock().unwrap();
        let unique = format!("notify-it-{}-{}", std::process::id(), now_millis());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-data")
            .join(unique);
        unsafe { std::env::set_var("ASSETS__ROOT", &root) };

        let uid = "u1";
        // 初始计数为 0
        let c0 = counts(uid).await.unwrap();
        assert_eq!(c0.total, 0);

        // 发布 2 条 task + 1 条 message
        for t in ["t1", "t2"] {
            publish(NotifyInput {
                user_id: Some(uid.into()),
                center: "task".into(),
                title: t.into(),
                body: None,
                level: None,
                link: None,
            })
            .await
            .unwrap();
        }
        let m = publish(NotifyInput {
            user_id: Some(uid.into()),
            center: "message".into(),
            title: "m1".into(),
            body: None,
            level: None,
            link: None,
        })
        .await
        .unwrap();

        let c1 = counts(uid).await.unwrap();
        assert_eq!(
            (c1.task, c1.message, c1.log, c1.total),
            (2, 1, 0, 3),
            "未读计数"
        );

        // 列表（全部）应有 3 条，倒序
        let all = list(uid, None).await.unwrap();
        assert_eq!(all.len(), 3);

        // 标记 message 这条已读 → 合计降到 2
        assert!(mark_read(uid, NotifyCenter::Message, &m.id).await.unwrap());
        let c2 = counts(uid).await.unwrap();
        assert_eq!((c2.message, c2.total), (0, 2));

        // 全部已读 → 0
        let n = mark_all_read(uid, None).await.unwrap();
        assert_eq!(n, 2, "剩余 2 条 task 未读被标记");
        assert_eq!(counts(uid).await.unwrap().total, 0);

        // 用户隔离：u2 看不到 u1 的通知
        assert_eq!(counts("u2").await.unwrap().total, 0);

        // 非法 center / 用户
        assert!(
            publish(NotifyInput {
                user_id: Some(uid.into()),
                center: "bad".into(),
                title: "x".into(),
                body: None,
                level: None,
                link: None
            })
            .await
            .is_err()
        );
        assert!(counts("../etc").await.is_err());

        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}
