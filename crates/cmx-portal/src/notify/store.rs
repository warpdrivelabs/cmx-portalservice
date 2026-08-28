//! 通知存储:平台库 `cmx_notification`(主体)+ `cmx_notification_recipient`(收件明细,写扩散)。
//!
//! - 建表走 sql-guide 治理通道(`docs/sql/v2/platform/migrations/20260826_001_通知中心建表.up.sql`),
//!   迁移引擎启动时自动执行;本模块**不执行任何 DDL**,首用时仅做表存在性校验。
//! - 未读统计:`GROUP BY center` + 零填充,SQL 直出,无进程内缓存。
//! - 群发:发布时解析收件人(指定人/部门含子部门/角色/全员),收件人 ≥ 阈值转 `pending` 后台异步展开。
//! - 集群广播:publish 落库后经 Redis pub/sub(`cmx:notify` 频道)广播,各实例订阅后转发进本进程
//!   hub(照抄 cmx-plugin 集群广播先例);Redis 不可达降级为进程内广播。
//! - 多实例安全:清理/展开任务幂等可重入;无本地状态、无内存业务缓存。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::OnceCell;

use cmx_core::model::cell::DataValue;
use cmx_core::model::data::dataset::DataSet;

use crate::error::{PortalError, PortalResult};
use crate::notify::hub::{self, NotifyEvent};
use crate::now_millis;

/// Redis 集群广播频道。
const NOTIFY_CHANNEL: &str = "cmx:notify";

/// 单条通知直接逐收件人广播的事件上限(含 notify+counts 各一),超出改发 kind=fanout 提示事件。
const PER_RECIPIENT_EVENT_CAP: usize = 100;

/// 同步落库的收件人分批大小(单事务内多行 VALUES)。
const RECIPIENT_CHUNK_SYNC: usize = 250;

/// 异步展开每批行数(每批独立事务)。
const RECIPIENT_CHUNK_ASYNC: usize = 1000;

/// 指定人发布(免管理员校验)的收件人数上限。
const DIRECT_RECIPIENT_LIMIT: usize = 20;

/// 聚合时间窗(毫秒):同 agg_key 同收件人集在窗内合并计数。
const AGG_WINDOW_MS: i64 = 3_600_000;

// ───────────────────── 类型定义 ─────────────────────

/// 三个中心。值即业务标识;label 为前端默认显示名。
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
    /// 返回中心业务标识。
    ///
    /// # Returns
    ///
    /// 中心的小写标识字符串。
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
    /// * `s` - 待解析的字符串(task/message/log)。
    ///
    /// # Returns
    ///
    /// 匹配到的中心枚举;无法匹配时返回 `None`。
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

/// 一条通知(输出结构,落盘行的 JOIN 投影)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyItem {
    /// 通知唯一标识(雪花号字符串,避免 JS 精度丢失)。
    pub id: String,
    /// 所属中心(task/message/log)。
    pub center: String,
    /// 业务类型(如 system / mdm.dead_letter / flow.approval)。
    #[serde(rename = "type")]
    pub msg_type: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文。
    pub body: String,
    /// 业务等级:info | success | warning | error。
    pub level: String,
    /// 点击跳转目标(node:<id> / menu:<key> / https://...)。
    pub link: String,
    /// 当前用户是否已读。
    pub read: bool,
    /// 聚合命中次数(同 agg_key 时间窗内合并;1=未聚合)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agg_count: Option<i64>,
    /// 发送者显示名(服务名/用户名)。
    pub sender_name: String,
    /// 来源服务标识(portal/mdm/flow...)。
    pub source: String,
    /// 创建/最近聚合时间(epoch 毫秒)。
    pub created_at: i64,
}

/// 发布目标:指定人 / 部门(含子部门) / 角色 / 全员,多来源并集去重。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyTargets {
    /// 指定收件用户 id 列表(cmx_user.id)。
    #[serde(default)]
    pub user_ids: Vec<String>,
    /// 指定收件用户名列表(服务端解析为 id;不存在者丢弃并 warn)。
    #[serde(default)]
    pub usernames: Vec<String>,
    /// 按部门 id 列表(cmx_org.id)。
    #[serde(default)]
    pub org_ids: Vec<String>,
    /// 部门目标是否含子部门(递归 parent_id)。
    #[serde(default)]
    pub include_children: bool,
    /// 按角色 code 列表(cmx_role.code)。
    #[serde(default)]
    pub role_codes: Vec<String>,
    /// 全员(status=1 且未归档)。
    #[serde(default)]
    pub all: bool,
}

impl NotifyTargets {
    /// 是否为群发目标(部门/角色/全员)——需要管理员权限的发布形态。
    fn is_mass(&self) -> bool {
        self.all || !self.org_ids.is_empty() || !self.role_codes.is_empty()
    }

    /// 全部目标字段是否为空。
    fn is_empty_targets(&self) -> bool {
        !self.all
            && self.user_ids.is_empty()
            && self.usernames.is_empty()
            && self.org_ids.is_empty()
            && self.role_codes.is_empty()
    }

    /// 规范化(排序去重)目标形——聚合匹配时比较"同收件人集"用。
    fn canonical(&self) -> String {
        let norm = |v: &[String]| -> Vec<String> {
            let s: BTreeSet<String> = v.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
            s.into_iter().collect()
        };
        json!({
            "uids": norm(&self.user_ids),
            "uns": norm(&self.usernames),
            "orgs": norm(&self.org_ids),
            "inc": self.include_children,
            "roles": norm(&self.role_codes),
            "all": self.all,
        })
        .to_string()
    }
}

/// 发布入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyInput {
    /// 目标用户(旧单发契约;等价 targets.userIds)。兼容历史 snake_case `user_id` 入参。
    #[serde(default, alias = "user_id")]
    pub user_id: Option<String>,
    /// 通知中心(task/message/log)。
    pub center: String,
    /// 通知标题。
    pub title: String,
    /// 通知正文(可选)。
    #[serde(default)]
    pub body: Option<String>,
    /// 业务等级(info/success/warning/error,可选)。
    #[serde(default)]
    pub level: Option<String>,
    /// 点击跳转目标(可选)。
    #[serde(default)]
    pub link: Option<String>,
    /// 业务类型(可选,默认 system)。
    #[serde(default)]
    #[serde(rename = "type")]
    pub msg_type: Option<String>,
    /// 发布目标(群发/指定人;与 userId 并集)。
    #[serde(default)]
    pub targets: Option<NotifyTargets>,
    /// 聚合键(可选):同键同收件人集时间窗内合并计数,防通知风暴。
    #[serde(default)]
    pub agg_key: Option<String>,
    /// 过期时间(epoch 毫秒,可选;缺省按 notify.retention_days 倒推)。
    #[serde(default)]
    pub expire_at: Option<i64>,
    /// 来源服务标识(服务代发时必填,如 mdm)。
    #[serde(default)]
    pub source: Option<String>,
}

/// 发布方身份上下文(handler 从认证上下文构建)。
#[derive(Debug, Clone)]
pub struct PublishCtx {
    /// 发布者用户 id;空 = 纯服务身份(api_key 未绑定用户)。
    pub user_id: String,
    /// 发布者用户名。
    pub username: String,
    /// 是否管理员(has_role("admin") 或 system:all)。
    pub is_admin: bool,
    /// 是否服务身份(auth_method == "api_key";群发豁免管理员校验)。
    pub is_service: bool,
}

/// 列表过滤 + 分页参数(cursor 游标 / offset 页码两模式)。
#[derive(Debug, Clone, Default)]
pub struct NotifyListFilter {
    /// 通知中心;`None` 表示三中心全部。
    pub center: Option<NotifyCenter>,
    /// 业务类型过滤。
    pub msg_type: Option<String>,
    /// 等级过滤。
    pub level: Option<String>,
    /// 已读状态过滤;`None` 表示全部。
    pub is_read: Option<bool>,
    /// 页大小(1..=200,缺省 50)。
    pub limit: Option<i64>,
    /// 游标(`created_at_id` 编码;首页 `None`)。
    pub cursor: Option<String>,
    /// 页码分页偏移(0 起 = (页码-1)*页大小);有 cursor 时忽略。
    /// 页码模式下响应恒带 total,供分页条计算总页数。
    pub offset: Option<i64>,
}

/// 列表结果(items + 分页游标 + 总数)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyListResult {
    /// 当前页通知列表(按创建时间倒序)。
    pub items: Vec<NotifyItem>,
    /// 下一页游标;`None` 表示没有更多。
    pub next_cursor: Option<String>,
    /// 总条数(游标模式仅首页返回,offset 页码模式每页都返回)。
    pub total: i64,
}

/// 计数(前端角标用)。
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

// ───────────────────── 基础设施 ─────────────────────

/// 从 DB 获取默认 DatabaseManager + db_id(与 dam/store.rs 同模式)。
async fn db_handle() -> PortalResult<(&'static cmx_database::DatabaseManager, String)> {
    let mm = cmx_database::get_default_db_manager();
    let db_id = mm.get_default_db_id().await;
    Ok((mm, db_id))
}

/// 执行 SQL(无返回行),错误包装为业务错误。
async fn exec(
    mm: &cmx_database::DatabaseManager,
    db_id: &str,
    txn_id: Option<&str>,
    label: &str,
    sql: &str,
    params: Vec<DataValue>,
) -> PortalResult<u64> {
    mm.execute_sql_with_datavalues(db_id, txn_id, sql, params)
        .await
        .map_err(|e| PortalError::business(format!("通知存储-{label}失败: {e}")))
}

/// 查询 SQL(返回 DataSet),错误包装为业务错误。
async fn query(
    mm: &cmx_database::DatabaseManager,
    db_id: &str,
    label: &str,
    sql: &str,
    params: Vec<DataValue>,
) -> PortalResult<DataSet> {
    mm.query_sql_with_datavalues(db_id, None, sql, params, label)
        .await
        .map_err(|e| PortalError::business(format!("通知存储-{label}失败: {e}")))
}

/// 读字符串列(缺失回空串)。
fn row_str(ds: &DataSet, i: usize, name: &str) -> String {
    ds.rows[i].get_by_name_as(ds.schema.as_ref(), name).unwrap_or_default()
}

/// 读 i64 列(缺失回 0)。
fn row_i64(ds: &DataSet, i: usize, name: &str) -> i64 {
    ds.rows[i].get_by_name_as(ds.schema.as_ref(), name).unwrap_or_default()
}

/// 读布尔列(缺失回 false)。
fn row_bool(ds: &DataSet, i: usize, name: &str) -> bool {
    ds.rows[i]
        .get_by_name_as::<bool>(ds.schema.as_ref(), name)
        .unwrap_or(false)
}

/// 读字符串列的可选形式。
fn row_str_opt(ds: &DataSet, i: usize, name: &str) -> Option<String> {
    ds.rows[i].get_by_name_as(ds.schema.as_ref(), name)
}

/// 读配置整数(缺省回默认值)。
fn cfg_i64(key: &str, default: i64) -> i64 {
    cmx_utils::ConfigManager::try_global()
        .and_then(|c| c.get_int(key).ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// 首用惰性初始化:表存在性校验 + 后台任务 + Redis 集群订阅。
///
/// 错误不缓存(手动 OnceCell 检查),失败透传首个请求、后续请求自动重试;
/// Redis 订阅注册失败仅 warn 降级进程内广播,不影响初始化成功。
pub async fn ensure_ready() -> PortalResult<()> {
    static READY: OnceCell<()> = OnceCell::const_new();
    if READY.get().is_some() {
        return Ok(());
    }
    let (mm, db_id) = db_handle().await?;
    // 表存在性校验(建表由迁移引擎负责;缺失时给出可操作的错误提示)。
    let ds = query(
        mm,
        &db_id,
        "表存在性校验",
        "SELECT to_regclass('public.cmx_notification') IS NOT NULL AS t1, \
         to_regclass('public.cmx_notification_recipient') IS NOT NULL AS t2",
        vec![],
    )
    .await?;
    if ds.rows.is_empty() || !row_bool(&ds, 0, "t1") || !row_bool(&ds, 0, "t2") {
        return Err(PortalError::business(
            "通知表未建:请启用 [migration] 迁移(20260826_001_通知中心建表)或手工执行 platform/init_ddl.sql",
        ));
    }
    // 后台任务:过期/保留清理 + pending 异步展开(幂等可重入,多实例安全)。
    tokio::spawn(cleanup_loop());
    tokio::spawn(expansion_loop());
    // Redis 集群订阅:跨实例事件转发进本进程 hub(失败降级,不影响初始化)。
    register_cluster_subscriber().await;
    let _ = READY.set(());
    Ok(())
}

// ───────────────────── 收件人解析 ─────────────────────

/// 查询用户 id 列表(单列 id 结果集)。
async fn query_ids(
    mm: &cmx_database::DatabaseManager,
    db_id: &str,
    label: &str,
    sql: &str,
    params: Vec<DataValue>,
) -> PortalResult<Vec<String>> {
    let ds = query(mm, db_id, label, sql, params).await?;
    Ok((0..ds.rows.len())
        .filter_map(|i| row_str_opt(&ds, i, "id").filter(|s| !s.is_empty()))
        .collect())
}

/// 字符串数组参数(DataValue::Array → PG 数组,`= ANY($N)` 绑定)。
fn str_array(v: &[String]) -> DataValue {
    DataValue::Array(v.iter().map(|s| DataValue::String(s.clone())).collect())
}

/// 解析发布目标为收件用户 id 集合(多来源并集去重)。
///
/// # Arguments
///
/// * `targets` - 发布目标(指定人/部门/角色/全员)。
///
/// # Returns
///
/// 去重后的收件用户 id 列表。
///
/// # Errors
///
/// 查询失败时返回 `PortalError`。
pub async fn resolve_targets(targets: &NotifyTargets) -> PortalResult<Vec<String>> {
    let (mm, db_id) = db_handle().await?;
    let mut set: BTreeSet<String> = BTreeSet::new();

    if !targets.user_ids.is_empty() {
        // 指定 id:做存在性校验,不存在的丢弃并 warn(防脏数据静默扩面)。
        let sql = "SELECT id FROM cmx_user WHERE id = ANY($1) AND archived = 0";
        let ids = query_ids(mm, &db_id, "解析userIds", sql, vec![str_array(&targets.user_ids)]).await?;
        for id in &ids {
            set.insert(id.clone());
        }
        if ids.len() < targets.user_ids.len() {
            tracing::warn!(target: "cmx_portal::notify",
                given = targets.user_ids.len(), hit = ids.len(), "部分 userIds 不存在或已归档,已丢弃");
        }
    }
    if !targets.usernames.is_empty() {
        let sql = "SELECT id FROM cmx_user WHERE username = ANY($1) AND archived = 0";
        let ids = query_ids(mm, &db_id, "解析usernames", sql, vec![str_array(&targets.usernames)]).await?;
        for id in &ids {
            set.insert(id.clone());
        }
        if ids.len() < targets.usernames.len() {
            tracing::warn!(target: "cmx_portal::notify",
                given = targets.usernames.len(), hit = ids.len(), "部分 usernames 不存在或已归档,已丢弃");
        }
    }
    if !targets.org_ids.is_empty() {
        // 部门目标:不含子部门 = org_id 精确匹配;含子部门 = 按 parent_id 递归展开组织树。
        let sql = if targets.include_children {
            "WITH RECURSIVE org_tree AS ( \
               SELECT id FROM cmx_org WHERE id = ANY($1) AND archived = 0 \
               UNION ALL \
               SELECT o.id FROM cmx_org o JOIN org_tree t ON o.parent_id = t.id WHERE o.archived = 0 \
             ) SELECT DISTINCT u.id FROM cmx_user u JOIN org_tree ot ON u.org_id = ot.id \
             WHERE u.status = 1 AND u.archived = 0"
        } else {
            "SELECT id FROM cmx_user WHERE org_id = ANY($1) AND status = 1 AND archived = 0"
        };
        let ids = query_ids(mm, &db_id, "解析orgIds", sql, vec![str_array(&targets.org_ids)]).await?;
        for id in &ids {
            set.insert(id.clone());
        }
    }
    if !targets.role_codes.is_empty() {
        let sql = "SELECT DISTINCT ur.user_id AS id FROM cmx_user_role ur \
                   JOIN cmx_role r ON r.id = ur.role_id \
                   JOIN cmx_user u ON u.id = ur.user_id \
                   WHERE r.code = ANY($1) AND ur.archived = 0 AND u.status = 1 AND u.archived = 0";
        let ids = query_ids(mm, &db_id, "解析roleCodes", sql, vec![str_array(&targets.role_codes)]).await?;
        for id in &ids {
            set.insert(id.clone());
        }
    }
    if targets.all {
        let ids = query_ids(
            mm,
            &db_id,
            "解析全员",
            "SELECT id FROM cmx_user WHERE status = 1 AND archived = 0",
            vec![],
        )
        .await?;
        for id in &ids {
            set.insert(id.clone());
        }
    }
    Ok(set.into_iter().collect())
}

// ───────────────────── 广播 ─────────────────────

/// 广播一条事件:优先 Redis pub/sub(全集群),不可达降级进程内。
///
/// Redis 发布成功时本实例的事件由订阅回调转发进 hub,不重复直投。
async fn broadcast_event(ev: NotifyEvent) {
    if let Some(cm) = cmx_buffer::GlobalCacheManager::try_get()
        && cm.pubsub().publish_json(NOTIFY_CHANNEL, &ev).await.is_ok()
    {
        return;
    }
    hub::publish_event(ev);
}

/// 注册 Redis 集群订阅:收到的事件转发进本进程 hub(SSE 消费)。
///
/// 失败仅 warn 降级进程内广播(单实例语义),不影响通知主流程。注意
/// `GlobalSubscriberManager::initialize()` 内部会 `GlobalCacheManager::get()`(未初始化时
/// panic),故先以 `try_get()` 判定本进程是否配置了 Redis,未配置直接降级。
async fn register_cluster_subscriber() {
    if cmx_buffer::GlobalCacheManager::try_get().is_none() {
        tracing::warn!(target: "cmx_portal::notify", "本进程未初始化 Redis 缓存管理器,通知广播降级为进程内");
        return;
    }
    if !cmx_buffer::GlobalSubscriberManager::is_initialized()
        && cmx_buffer::GlobalSubscriberManager::initialize().await.is_err()
    {
        tracing::warn!(target: "cmx_portal::notify", "Redis 订阅管理器初始化失败,通知广播降级为进程内");
        return;
    }
    let subscriber = cmx_buffer::GlobalSubscriberManager::get();
    if let Err(e) = subscriber
        .register_channel_fn(NOTIFY_CHANNEL, |channel, payload| {
            if let Ok(ev) = serde_json::from_str::<NotifyEvent>(payload) {
                hub::publish_event(ev);
            } else {
                tracing::debug!(channel, "忽略无法解析的集群通知事件");
            }
        })
        .await
    {
        tracing::warn!(target: "cmx_portal::notify", error = %e, "注册通知集群订阅失败,广播降级为进程内");
    }
}

/// 对收件人逐人广播 notify + counts 事件(超上限改发 fanout 提示)。
async fn broadcast_to_recipients(item: &NotifyItem, recipients: &[String]) {
    if recipients.len() > PER_RECIPIENT_EVENT_CAP {
        // 大 fanout:不逐人发(避免广播风暴),发一条 fanout 提示,由各 SSE 连接按本人拉取 counts。
        broadcast_event(NotifyEvent {
            user_id: String::new(),
            kind: "fanout".to_string(),
            data: json!({}),
        })
        .await;
        return;
    }
    let value = serde_json::to_value(item).unwrap_or(serde_json::Value::Null);
    for uid in recipients {
        broadcast_event(NotifyEvent {
            user_id: uid.clone(),
            kind: "notify".to_string(),
            data: value.clone(),
        })
        .await;
    }
    // 逐人 counts 事件(一次批量 GROUP BY):驱动各端 shellbar 铃铛角标即时 +1。
    // 事件量与 notify 同级,同样受 PER_RECIPIENT_EVENT_CAP 约束。
    if let Ok(list) = counts_for_users(recipients).await {
        for (uid, c) in list {
            broadcast_event(NotifyEvent {
                user_id: uid,
                kind: "counts".to_string(),
                data: serde_json::to_value(c).unwrap_or(json!({})),
            })
            .await;
        }
    }
}

// ───────────────────── 发布限流 ─────────────────────

/// 发布限流:Redis 计数窗口 60s,超限返回 false。
///
/// 用户身份按 user_id 计数;纯服务身份按 source 维度计数(空 user 不共享单桶)。
/// Redis 不可用时 fail-open(放行)。
async fn rate_limit_pass(ctx: &PublishCtx, source: &str) -> bool {
    let Some(cm) = cmx_buffer::GlobalCacheManager::try_get() else {
        return true;
    };
    let key = if !ctx.user_id.trim().is_empty() {
        format!("notify:rl:{}", ctx.user_id)
    } else {
        format!("notify:rl:src:{}", if source.is_empty() { "anon" } else { source })
    };
    let limit = cfg_i64("notify.rate_limit_per_min", 30);
    match cm.ops().incr(&key, 1).await {
        Ok(n) => {
            if n == 1 {
                let _ = cm.ttl().expire(&key, std::time::Duration::from_secs(60)).await;
            }
            n <= limit
        }
        Err(_) => true,
    }
}

// ───────────────────── 发布 ─────────────────────

/// 发布一条通知:权限矩阵 → 收件人解析 → 限流 → 聚合 → 落库(同步/异步展开)→ 广播。
///
/// 发布矩阵:
/// - 用户身份 + 目标均空 → 回填当前用户(兼容旧单发契约);
/// - 用户身份 + 指定人 ≤20 → 放行;>20 或群发(部门/角色/全员)→ 要求管理员,否则 403;
/// - 服务身份(api_key)→ 放行群发,但必须显式给收件目标(空 → 400,非 401)。
///
/// # Arguments
///
/// * `ctx` - 发布方身份(handler 从认证上下文构建)。
/// * `input` - 通知发布入参。
///
/// # Returns
///
/// 已落库(或聚合命中)的通知项。
///
/// # Errors
///
/// 权限不足(403)、收件目标缺失/解析为空(400)、限流(429)或存储失败时返回 `PortalError`。
#[tracing::instrument(skip(ctx, input))]
pub async fn publish(ctx: &PublishCtx, input: NotifyInput) -> PortalResult<NotifyItem> {
    ensure_ready().await?;
    let center = NotifyCenter::parse(input.center.trim())
        .ok_or_else(|| PortalError::bad_request("center 仅支持 task/message/log"))?;
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(PortalError::bad_request("title 不能为空"));
    }
    let mut targets = input.targets.clone().unwrap_or_default();
    // 旧单发字段并入 targets.userIds(等价语义)。
    if let Some(uid) = input.user_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        targets.user_ids.push(uid.to_string());
    }
    let source = input.source.as_deref().map(str::trim).unwrap_or("").to_string();

    // 纯服务身份必须显式给收件目标(401 语义修正为 400)。
    if ctx.user_id.trim().is_empty() {
        if !ctx.is_service {
            return Err(PortalError::bad_request("缺少发布者身份(未登录)"));
        }
        if targets.is_empty_targets() {
            return Err(PortalError::bad_request("服务发布缺少收件目标(userId/targets 至少一项)"));
        }
    }

    // 权限短路:群发(部门/角色/全员)先校验管理员,不进解析;服务身份豁免。
    if targets.is_mass() && !ctx.is_service && !ctx.is_admin {
        return Err(PortalError::forbidden("群发通知(部门/角色/全员)需要管理员权限"));
    }

    // 目标均空 → 回填当前用户(旧单发契约)。
    if targets.is_empty_targets() && !ctx.user_id.trim().is_empty() {
        targets.user_ids.push(ctx.user_id.trim().to_string());
    }

    // 限流(429)。
    if !rate_limit_pass(ctx, &source).await {
        return Err(PortalError::too_many_requests(format!(
            "发布频率超限(每分钟 {} 条)",
            cfg_i64("notify.rate_limit_per_min", 30)
        )));
    }

    let ts = now_millis();

    // 聚合:同 agg_key + 同目标形 + 时间窗内未读通知 → 原子合并计数,不新增行。
    let agg_key = input.agg_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(agg) = agg_key
        && let Some(hit) = try_aggregate(
            agg,
            &targets.canonical(),
            input.body.as_deref().unwrap_or(""),
            ts,
        )
        .await?
    {
        let recipients = notification_recipients(hit_id(&hit)?).await?;
        broadcast_to_recipients(&hit, &recipients).await;
        return Ok(hit);
    }

    // 解析收件人(并集去重)。
    let recipients = resolve_targets(&targets).await?;
    if recipients.is_empty() {
        return Err(PortalError::bad_request("收件人为空(目标不存在或无有效成员)"));
    }
    // 指定人超上限同样要求管理员(防绕过群发权限)。
    if recipients.len() > DIRECT_RECIPIENT_LIMIT && !ctx.is_service && !ctx.is_admin {
        return Err(PortalError::forbidden(format!(
            "指定收件人超过 {DIRECT_RECIPIENT_LIMIT} 人需要管理员权限"
        )));
    }

    let id = cmx_utils::id::snowflake_id();
    let msg_type = input
        .msg_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("system")
        .to_string();
    let level = input
        .level
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("info")
        .to_string();
    let expire_at = input
        .expire_at
        .filter(|v| *v > ts)
        .unwrap_or_else(|| ts + cfg_i64("notify.retention_days", 90) * 86_400_000);
    let sender_name = if !ctx.user_id.trim().is_empty() && !ctx.username.is_empty() {
        ctx.username.clone()
    } else if !source.is_empty() {
        source.clone()
    } else {
        "system".to_string()
    };
    let mut ext = json!({});
    if agg_key.is_some() {
        ext["count"] = json!(1);
        ext["targets_hash"] = json!(targets.canonical());
    }

    let (mm, db_id) = db_handle().await?;
    let threshold = cfg_i64("notify.async_fanout_threshold", 2000) as usize;

    let item = if recipients.len() >= threshold {
        // 大 fanout:主体落库 pending 立即返回,后台任务展开(渐进可见,幂等)。
        exec(
            mm,
            &db_id,
            None,
            "插入pending主体",
            "INSERT INTO cmx_notification \
             (id, center, type, level, title, body, link, ext, agg_key, sender_id, sender_name, source, \
              target_type, target_refs, recipient_count, status, created_at, expire_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,0,'pending',$15,$16)",
            vec![
                DataValue::Int(id),
                DataValue::String(center.as_str().to_string()),
                DataValue::String(msg_type.clone()),
                DataValue::String(level.clone()),
                DataValue::String(title.clone()),
                DataValue::String(input.body.clone().unwrap_or_default()),
                DataValue::String(input.link.clone().unwrap_or_default()),
                DataValue::Json(ext.to_string()),
                DataValue::String(agg_key.unwrap_or_default().to_string()),
                DataValue::String(ctx.user_id.clone()),
                DataValue::String(sender_name.clone()),
                DataValue::String(source.clone()),
                DataValue::String(target_type_of(&targets).to_string()),
                DataValue::Json(serde_json::to_string(&targets).unwrap_or_else(|_| "[]".into())),
                DataValue::Int(ts),
                DataValue::Int(expire_at),
            ],
        )
        .await?;
        NotifyItem {
            id: id.to_string(),
            center: center.as_str().to_string(),
            msg_type,
            title,
            body: input.body.clone().unwrap_or_default(),
            level,
            link: input.link.clone().unwrap_or_default(),
            read: false,
            agg_count: agg_key.map(|_| 1),
            sender_name,
            source,
            created_at: ts,
        }
    } else {
        // 小 fanout:单事务主体 + 收件人分批落库。
        let tx = mm
            .get_transaction_context()
            .begin_with_guard(&db_id)
            .await
            .map_err(|e| PortalError::business(format!("通知存储-开启事务失败: {e}")))?;
        let txn_id = tx.txn_id().to_string();
        let main_result = exec(
            mm,
            &db_id,
            Some(&txn_id),
            "插入主体",
            "INSERT INTO cmx_notification \
             (id, center, type, level, title, body, link, ext, agg_key, sender_id, sender_name, source, \
              target_type, target_refs, recipient_count, status, created_at, expire_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15,'done',$16,$17)",
            vec![
                DataValue::Int(id),
                DataValue::String(center.as_str().to_string()),
                DataValue::String(msg_type.clone()),
                DataValue::String(level.clone()),
                DataValue::String(title.clone()),
                DataValue::String(input.body.clone().unwrap_or_default()),
                DataValue::String(input.link.clone().unwrap_or_default()),
                DataValue::Json(ext.to_string()),
                DataValue::String(agg_key.unwrap_or_default().to_string()),
                DataValue::String(ctx.user_id.clone()),
                DataValue::String(sender_name.clone()),
                DataValue::String(source.clone()),
                DataValue::String(target_type_of(&targets).to_string()),
                DataValue::Json(serde_json::to_string(&targets).unwrap_or_else(|_| "[]".into())),
                DataValue::Int(recipients.len() as i64),
                DataValue::Int(ts),
                DataValue::Int(expire_at),
            ],
        )
        .await;
        let ins_result = match main_result {
            Ok(_) => {
                let mut n = 0u64;
                for chunk in recipients.chunks(RECIPIENT_CHUNK_SYNC) {
                    n += insert_recipient_chunk(mm, &db_id, Some(&txn_id), id, center.as_str(), ts, chunk)
                        .await?;
                }
                Ok(n)
            }
            Err(e) => Err(e),
        };
        match ins_result {
            Ok(_) => tx
                .commit()
                .await
                .map_err(|e| PortalError::business(format!("通知存储-提交事务失败: {e}")))?,
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(e);
            }
        }
        NotifyItem {
            id: id.to_string(),
            center: center.as_str().to_string(),
            msg_type,
            title,
            body: input.body.clone().unwrap_or_default(),
            level,
            link: input.link.clone().unwrap_or_default(),
            read: false,
            agg_count: agg_key.map(|_| 1),
            sender_name,
            source,
            created_at: ts,
        }
    };

    // 广播:小 fanout 逐收件人(受上限),大 fanout 走 fanout 提示事件。
    broadcast_to_recipients(&item, &recipients).await;
    Ok(item)
}

/// 目标类型(审计冗余)。
fn target_type_of(t: &NotifyTargets) -> &'static str {
    if t.all {
        "all"
    } else if !t.org_ids.is_empty() {
        "org"
    } else if !t.role_codes.is_empty() {
        "role"
    } else {
        "user"
    }
}

/// 单批收件人多行 INSERT(ON CONFLICT 兜住重复展开)。
#[allow(clippy::too_many_arguments)]
async fn insert_recipient_chunk(
    mm: &cmx_database::DatabaseManager,
    db_id: &str,
    txn_id: Option<&str>,
    notification_id: i64,
    center: &str,
    created_at: i64,
    chunk: &[String],
) -> PortalResult<u64> {
    let mut sql = String::from(
        "INSERT INTO cmx_notification_recipient \
         (id, notification_id, user_id, center, is_read, read_at, created_at) VALUES ",
    );
    let mut params: Vec<DataValue> = Vec::with_capacity(chunk.len() * 5);
    for (i, uid) in chunk.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        let b = i * 5;
        sql.push_str(&format!(
            "(${},${},${},${},false,0,${})",
            b + 1,
            b + 2,
            b + 3,
            b + 4,
            b + 5
        ));
        params.push(DataValue::Int(cmx_utils::id::snowflake_id()));
        params.push(DataValue::Int(notification_id));
        params.push(DataValue::String(uid.clone()));
        params.push(DataValue::String(center.to_string()));
        params.push(DataValue::Int(created_at));
    }
    sql.push_str(" ON CONFLICT (notification_id, user_id) DO NOTHING");
    exec(mm, db_id, txn_id, "插入收件人", &sql, params).await
}

/// 从聚合命中行取主体 id(内部辅助)。
fn hit_id(hit: &NotifyItem) -> PortalResult<i64> {
    hit.id
        .parse::<i64>()
        .map_err(|_| PortalError::business("通知 id 非法"))
}

/// 聚合命中:同 agg_key + 同目标形 + 时间窗内 + done 的最新一条,原子合并计数并返回投影。
///
/// # Returns
///
/// 命中返回聚合后的通知项;未命中返回 `None`。
async fn try_aggregate(
    agg_key: &str,
    targets_hash: &str,
    body: &str,
    ts: i64,
) -> PortalResult<Option<NotifyItem>> {
    let (mm, db_id) = db_handle().await?;
    let window_from = ts - AGG_WINDOW_MS;
    let ds = query(
        mm,
        &db_id,
        "聚合命中",
        "UPDATE cmx_notification SET \
           ext = jsonb_set(jsonb_set(ext, '{count}', \
             to_jsonb(COALESCE((ext->>'count')::bigint, 1) + 1)), '{lastAt}', to_jsonb($4::bigint)), \
           body = $5, created_at = $4 \
         WHERE id = ( \
           SELECT id FROM cmx_notification \
           WHERE agg_key = $1 AND status = 'done' AND created_at >= $2 \
             AND ext->>'targets_hash' = $3 \
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE) \
         RETURNING id::text, center, type, level, title, body, link, ext, sender_name, source, created_at",
        vec![
            DataValue::String(agg_key.to_string()),
            DataValue::Int(window_from),
            DataValue::String(targets_hash.to_string()),
            DataValue::Int(ts),
            DataValue::String(body.to_string()),
        ],
    )
    .await?;
    if ds.rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(row_to_item(&ds, 0)))
}

/// 查询某通知的全部收件人 id(聚合广播用)。
async fn notification_recipients(notification_id: i64) -> PortalResult<Vec<String>> {
    let (mm, db_id) = db_handle().await?;
    query_ids(
        mm,
        &db_id,
        "查收件人",
        "SELECT user_id AS id FROM cmx_notification_recipient WHERE notification_id = $1",
        vec![DataValue::Int(notification_id)],
    )
    .await
}

// ───────────────────── 查询 ─────────────────────

/// DataSet 行 → NotifyItem 投影。
fn row_to_item(ds: &DataSet, i: usize) -> NotifyItem {
    let ext_count = ds.rows[i]
        .get_by_name_as::<i64>(ds.schema.as_ref(), "ext_count")
        .or_else(|| {
            row_str(ds, i, "ext")
                .parse::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("count").and_then(|c| c.as_i64()))
        })
        .filter(|c| *c > 1);
    NotifyItem {
        id: row_str(ds, i, "id"),
        center: row_str(ds, i, "center"),
        msg_type: row_str(ds, i, "type"),
        title: row_str(ds, i, "title"),
        body: row_str(ds, i, "body"),
        level: row_str(ds, i, "level"),
        link: row_str(ds, i, "link"),
        read: row_bool(ds, i, "is_read"),
        agg_count: ext_count,
        sender_name: row_str(ds, i, "sender_name"),
        source: row_str(ds, i, "source"),
        created_at: row_i64(ds, i, "created_at"),
    }
}

/// 解析 keyset 游标(`created_at_id`)。
fn parse_cursor(s: &str) -> Option<(i64, i64)> {
    let (ts, id) = s.split_once('_')?;
    Some((ts.parse().ok()?, id.parse().ok()?))
}

/// 列出某用户的通知(过滤 + 分页:cursor 游标 / offset 页码两模式)。
///
/// # Arguments
///
/// * `user_id` - 用户标识(cmx_user.id)。
/// * `filter` - 过滤与分页参数。
///
/// # Returns
///
/// 当前页列表 + 下一页游标 + 总数(游标模式仅首页;offset 页码模式每页)。
///
/// # Errors
///
/// 表未就绪或查询失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn list(user_id: &str, filter: &NotifyListFilter) -> PortalResult<NotifyListResult> {
    ensure_ready().await?;
    let uid = user_id.trim();
    if uid.is_empty() {
        return Err(PortalError::bad_request("缺少用户标识"));
    }
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let cursor = filter.cursor.as_deref().and_then(parse_cursor);
    // offset 页码模式仅在无游标时生效(游标优先,保持旧客户端行为)。
    let offset = if cursor.is_none() {
        filter.offset.unwrap_or(0).clamp(0, 1_000_000)
    } else {
        0
    };

    // 动态 WHERE(参数化):user 必选,center/type/level/is_read/游标可选。
    let mut cond: Vec<String> = vec!["r.user_id = $1".to_string()];
    let mut params: Vec<DataValue> = vec![DataValue::String(uid.to_string())];
    if let Some(c) = filter.center {
        params.push(DataValue::String(c.as_str().to_string()));
        cond.push(format!("n.center = ${}", params.len()));
    }
    if let Some(t) = filter.msg_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(DataValue::String(t.to_string()));
        cond.push(format!("n.type = ${}", params.len()));
    }
    if let Some(l) = filter.level.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(DataValue::String(l.to_string()));
        cond.push(format!("n.level = ${}", params.len()));
    }
    if let Some(r) = filter.is_read {
        params.push(DataValue::Bool(r));
        cond.push(format!("r.is_read = ${}", params.len()));
    }
    let where_no_cursor = cond.join(" AND ");

    let (mm, db_id) = db_handle().await?;
    let total = if cursor.is_none() {
        let sql = format!(
            "SELECT COUNT(*) AS cnt FROM cmx_notification_recipient r \
             JOIN cmx_notification n ON n.id = r.notification_id WHERE {where_no_cursor}"
        );
        let ds = query(mm, &db_id, "列表计数", &sql, params.clone()).await?;
        row_i64(&ds, 0, "cnt")
    } else {
        0
    };

    let mut sql = format!(
        "SELECT n.id::text, n.center, n.type, n.level, n.title, n.body, n.link, n.ext, \
                n.sender_name, n.source, r.is_read, n.created_at \
         FROM cmx_notification_recipient r JOIN cmx_notification n ON n.id = r.notification_id \
         WHERE {where_no_cursor}"
    );
    if let Some((ts, id)) = cursor {
        params.push(DataValue::Int(ts));
        params.push(DataValue::Int(id));
        sql.push_str(&format!(" AND (n.created_at, n.id) < (${}, ${})", params.len() - 1, params.len()));
    }
    if offset > 0 {
        params.push(DataValue::Int(offset));
        sql.push_str(&format!(" OFFSET ${}", params.len()));
    }
    params.push(DataValue::Int(limit + 1)); // 多取一条判断是否有下一页
    sql.push_str(&format!(
        " ORDER BY n.created_at DESC, n.id DESC LIMIT ${}",
        params.len()
    ));
    let ds = query(mm, &db_id, "通知列表", &sql, params).await?;

    let mut items = Vec::with_capacity(ds.rows.len());
    for i in 0..ds.rows.len() {
        items.push(row_to_item(&ds, i));
    }
    let has_more = items.len() as i64 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        items.last().map(|it| format!("{}_{}", it.created_at, it.id))
    } else {
        None
    };
    Ok(NotifyListResult {
        items,
        next_cursor,
        total,
    })
}

/// 计算某用户各中心未读数 + 合计(GROUP BY + 零填充)。
///
/// # Arguments
///
/// * `user_id` - 用户标识(cmx_user.id)。
///
/// # Returns
///
/// 各中心未读数及合计。
///
/// # Errors
///
/// 表未就绪或查询失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn counts(user_id: &str) -> PortalResult<NotifyCounts> {
    ensure_ready().await?;
    let uid = user_id.trim();
    if uid.is_empty() {
        return Err(PortalError::bad_request("缺少用户标识"));
    }
    let (mm, db_id) = db_handle().await?;
    let ds = query(
        mm,
        &db_id,
        "未读计数",
        "SELECT center, COUNT(*) AS cnt FROM cmx_notification_recipient \
         WHERE user_id = $1 AND is_read = false GROUP BY center",
        vec![DataValue::String(uid.to_string())],
    )
    .await?;
    let mut c = NotifyCounts {
        task: 0,
        message: 0,
        log: 0,
        total: 0,
    };
    for i in 0..ds.rows.len() {
        let center = row_str(&ds, i, "center");
        let n = row_i64(&ds, i, "cnt");
        match center.as_str() {
            "task" => c.task = n,
            "message" => c.message = n,
            "log" => c.log = n,
            _ => {}
        }
    }
    c.total = c.task + c.message + c.log;
    Ok(c)
}

/// 批量取多用户未读数(逐人 counts 事件用;单条 GROUP BY 而非 N 次查询)。
async fn counts_for_users(user_ids: &[String]) -> PortalResult<Vec<(String, NotifyCounts)>> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let (mm, db_id) = db_handle().await?;
    let ds = query(
        mm,
        &db_id,
        "批量未读计数",
        "SELECT user_id, center, COUNT(*) AS cnt FROM cmx_notification_recipient \
         WHERE user_id = ANY($1) AND is_read = false GROUP BY user_id, center",
        vec![str_array(user_ids)],
    )
    .await?;
    let mut map: std::collections::HashMap<String, NotifyCounts> = user_ids
        .iter()
        .map(|u| {
            (
                u.clone(),
                NotifyCounts {
                    task: 0,
                    message: 0,
                    log: 0,
                    total: 0,
                },
            )
        })
        .collect();
    for i in 0..ds.rows.len() {
        let uid = row_str(&ds, i, "user_id");
        let center = row_str(&ds, i, "center");
        let n = row_i64(&ds, i, "cnt");
        if let Some(c) = map.get_mut(&uid) {
            match center.as_str() {
                "task" => c.task = n,
                "message" => c.message = n,
                "log" => c.log = n,
                _ => {}
            }
        }
    }
    Ok(map
        .into_iter()
        .map(|(u, mut c)| {
            c.total = c.task + c.message + c.log;
            (u, c)
        })
        .collect())
}

/// 已读状态变化后广播本人 counts 事件(驱动 shellbar 铃铛角标刷新);失败仅 warn 不影响主流程。
async fn broadcast_counts(user_id: &str) {
    match counts(user_id).await {
        Ok(c) => {
            broadcast_event(NotifyEvent {
                user_id: user_id.to_string(),
                kind: "counts".to_string(),
                data: serde_json::to_value(c).unwrap_or(json!({})),
            })
            .await;
        }
        Err(e) => tracing::warn!(target: "cmx_portal::notify", error = %e, "广播 counts 事件失败"),
    }
}

// ───────────────────── 已读 ─────────────────────

/// 标记单条已读(按 notification_id 定位本人收件行)。返回是否发生变化。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `id` - 通知标识(雪花号字符串)。
///
/// # Returns
///
/// 通知是否由未读变为已读。
///
/// # Errors
///
/// id 非法、通知不存在或更新失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn mark_read(user_id: &str, id: &str) -> PortalResult<bool> {
    ensure_ready().await?;
    let uid = user_id.trim();
    let nid = id
        .trim()
        .parse::<i64>()
        .map_err(|_| PortalError::bad_request("通知 id 非法"))?;
    let (mm, db_id) = db_handle().await?;
    let n = exec(
        mm,
        &db_id,
        None,
        "标记已读",
        "UPDATE cmx_notification_recipient SET is_read = true, read_at = $3 \
         WHERE user_id = $1 AND notification_id = $2 AND is_read = false",
        vec![
            DataValue::String(uid.to_string()),
            DataValue::Int(nid),
            DataValue::Int(now_millis()),
        ],
    )
    .await?;
    let changed = n > 0;
    if changed {
        broadcast_counts(uid).await;
    }
    Ok(changed)
}

/// 标记某用户全部(或某中心)已读。返回标记的条数。
///
/// # Arguments
///
/// * `user_id` - 用户标识。
/// * `center` - 通知中心;`None` 表示三中心全部。
///
/// # Returns
///
/// 本次标记已读的条数。
///
/// # Errors
///
/// 更新失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn mark_all_read(user_id: &str, center: Option<NotifyCenter>) -> PortalResult<i64> {
    ensure_ready().await?;
    let uid = user_id.trim();
    let (mm, db_id) = db_handle().await?;
    let (sql, params) = match center {
        Some(c) => (
            "UPDATE cmx_notification_recipient SET is_read = true, read_at = $2 \
             WHERE user_id = $1 AND center = $3 AND is_read = false",
            vec![
                DataValue::String(uid.to_string()),
                DataValue::Int(now_millis()),
                DataValue::String(c.as_str().to_string()),
            ],
        ),
        None => (
            "UPDATE cmx_notification_recipient SET is_read = true, read_at = $2 \
             WHERE user_id = $1 AND is_read = false",
            vec![DataValue::String(uid.to_string()), DataValue::Int(now_millis())],
        ),
    };
    let n = exec(mm, &db_id, None, "全部已读", sql, params).await?;
    if n > 0 {
        broadcast_counts(uid).await;
    }
    Ok(n as i64)
}

// ───────────────────── 后台任务 ─────────────────────

/// 过期/保留清理循环(10 分钟一轮,多实例安全:分批 + SKIP LOCKED,PG 无 DELETE...LIMIT)。
async fn cleanup_loop() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        if let Err(e) = cleanup_once().await {
            tracing::warn!(target: "cmx_portal::notify", error = %e, "通知清理任务执行失败");
        }
    }
}

/// 清理一轮:①过期主体的收件行 → ②已读超保留期的收件行 → ③无收件人且过期/超保留期的主体。
async fn cleanup_once() -> PortalResult<()> {
    let (mm, db_id) = db_handle().await?;
    let now = now_millis();
    let read_cutoff = now - cfg_i64("notify.retention_read_days", 30) * 86_400_000;
    let keep_cutoff = now - cfg_i64("notify.retention_days", 90) * 86_400_000;

    exec(
        mm,
        &db_id,
        None,
        "清理过期收件行",
        "DELETE FROM cmx_notification_recipient WHERE notification_id IN ( \
           SELECT id FROM cmx_notification WHERE expire_at > 0 AND expire_at < $1 \
           LIMIT 100 FOR UPDATE SKIP LOCKED)",
        vec![DataValue::Int(now)],
    )
    .await?;
    exec(
        mm,
        &db_id,
        None,
        "清理已读收件行",
        "DELETE FROM cmx_notification_recipient WHERE id IN ( \
           SELECT id FROM cmx_notification_recipient \
           WHERE is_read = true AND read_at > 0 AND read_at < $1 \
           LIMIT 2000 FOR UPDATE SKIP LOCKED)",
        vec![DataValue::Int(read_cutoff)],
    )
    .await?;
    exec(
        mm,
        &db_id,
        None,
        "清理空主体",
        "DELETE FROM cmx_notification WHERE id IN ( \
           SELECT id FROM cmx_notification \
           WHERE (expire_at > 0 AND expire_at < $1 OR created_at < $2) \
             AND NOT EXISTS (SELECT 1 FROM cmx_notification_recipient r \
                             WHERE r.notification_id = cmx_notification.id) \
           LIMIT 100 FOR UPDATE SKIP LOCKED)",
        vec![DataValue::Int(now), DataValue::Int(keep_cutoff)],
    )
    .await?;
    Ok(())
}

/// pending 异步展开循环(5 秒一轮)。
///
/// 展开幂等(INSERT ON CONFLICT DO NOTHING),并发重复展开无害;完成后 status='pending'
/// 条件更新防重复置 done。崩溃/多实例下 pending 行自然被下一轮重拾。
async fn expansion_loop() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Err(e) = expand_pending_once().await {
            tracing::warn!(target: "cmx_portal::notify", error = %e, "通知异步展开任务执行失败");
        }
    }
}

/// 展开一轮 pending 主体(每轮至多 5 条,防单实例长期独占)。
async fn expand_pending_once() -> PortalResult<()> {
    let (mm, db_id) = db_handle().await?;
    let ds = query(
        mm,
        &db_id,
        "认领pending",
        "SELECT id::text, center, target_refs::text FROM cmx_notification \
         WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5",
        vec![],
    )
    .await?;
    for i in 0..ds.rows.len() {
        let id_str = row_str(&ds, i, "id");
        let center = row_str(&ds, i, "center");
        let refs = row_str(&ds, i, "target_refs");
        let Ok(nid) = id_str.parse::<i64>() else {
            continue;
        };
        let Ok(targets) = serde_json::from_str::<NotifyTargets>(&refs) else {
            // 目标损坏:直接置 done(空收件)避免死循环占用。
            tracing::warn!(target: "cmx_portal::notify", id = %id_str, "pending 主体 target_refs 解析失败,置 done");
            let _ = exec(
                mm,
                &db_id,
                None,
                "坏目标置done",
                "UPDATE cmx_notification SET status = 'done', recipient_count = 0 WHERE id = $1 AND status = 'pending'",
                vec![DataValue::Int(nid)],
            )
            .await;
            continue;
        };
        let recipients = match resolve_targets(&targets).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "cmx_portal::notify", id = %id_str, error = %e, "pending 展开解析失败,下轮重试");
                continue;
            }
        };
        let ts = now_millis();
        for chunk in recipients.chunks(RECIPIENT_CHUNK_ASYNC.max(1)) {
            // 每批独立事务:失败即停,下轮从断点续插(ON CONFLICT 幂等)。
            insert_recipient_chunk(mm, &db_id, None, nid, &center, ts, chunk).await?;
        }
        // 完成置 done + 回写实插行数(count 以库为准);条件 status='pending' 防并发重复。
        let cnt_ds = query(
            mm,
            &db_id,
            "实插行数",
            "SELECT COUNT(*) AS cnt FROM cmx_notification_recipient WHERE notification_id = $1",
            vec![DataValue::Int(nid)],
        )
        .await?;
        let cnt = row_i64(&cnt_ds, 0, "cnt");
        exec(
            mm,
            &db_id,
            None,
            "展开完成",
            "UPDATE cmx_notification SET status = 'done', recipient_count = $2 WHERE id = $1 AND status = 'pending'",
            vec![DataValue::Int(nid), DataValue::Int(cnt)],
        )
        .await?;
        tracing::info!(target: "cmx_portal::notify", id = %id_str, recipients = cnt, "异步展开完成");
    }
    Ok(())
}

// ───────────────────── 元信息 ─────────────────────

/// 三中心元信息(前端下拉用:值/标签/图标)。静态注册。
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

    /// 服务身份上下文(测试用)。
    fn svc_ctx() -> PublishCtx {
        PublishCtx {
            user_id: String::new(),
            username: String::new(),
            is_admin: true,
            is_service: true,
        }
    }

    /// 普通用户上下文(测试用)。
    fn user_ctx(uid: &str) -> PublishCtx {
        PublishCtx {
            user_id: uid.to_string(),
            username: uid.to_string(),
            is_admin: false,
            is_service: false,
        }
    }

    fn input(center: &str, title: &str, uid: &str) -> NotifyInput {
        NotifyInput {
            user_id: Some(uid.to_string()),
            center: center.to_string(),
            title: title.to_string(),
            body: Some("b".into()),
            level: None,
            link: None,
            msg_type: None,
            targets: None,
            agg_key: None,
            expire_at: None,
            source: Some("test".into()),
        }
    }

    /// 初始化测试数据源并校验通知表就绪;不可用则跳过(单测不硬性依赖 PG)。
    ///
    /// 优先取 `CMX_TEST_DB_URL`;缺省从 `../../portal-server-dev.toml` 提取首个非注释
    /// `db_url`(即 default=true 的平台库)手工注册——测试进程不经服务启动链初始化
    /// DatabaseManager,须自注册。
    async fn ready_or_skip() -> bool {
        static DB: OnceCell<bool> = OnceCell::const_new();
        let ok = *DB
            .get_or_init(|| async {
                let url = match std::env::var("CMX_TEST_DB_URL") {
                    Ok(u) if !u.trim().is_empty() => u,
                    _ => {
                        let Ok(text) = std::fs::read_to_string("../../portal-server-dev.toml") else {
                            return false;
                        };
                        let re = regex::Regex::new(r#"^\s*db_url\s*=\s*"([^"]+)"\s*$"#).unwrap();
                        match text.lines().find_map(|l| {
                            if l.trim_start().starts_with('#') {
                                None
                            } else {
                                re.captures(l)
                            }
                        }) {
                            Some(c) => c[1].to_string(),
                            None => return false,
                        }
                    }
                };
                let cfg = cmx_database::DbConfig {
                    db_type: cmx_database::DbType::Postgres,
                    db_url: url,
                    db_id: "notify-test".to_string(),
                    db_name: None,
                    db_schema: Some("public".to_string()),
                    default: true,
                    // cfg!(test) 下 PoolConfig::default() 的 max=1/min=2 会让并行测试互卡
                    // (acquire 超时),显式给可用池参数。
                    pool_config: cmx_database::PoolConfig {
                        max_connections: 5,
                        min_connections: 1,
                        connect_timeout: 10,
                        acquire_timeout: 30,
                        idle_timeout: 600,
                        max_lifetime: 1800,
                    },
                    health_check_interval: 60,
                    health_check_timeout: 5,
                    domain_code: None,
                    application_code: None,
                    module_code: None,
                    source_type: None,
                };
                cmx_database::get_default_db_manager()
                    .register_data_source(cfg)
                    .await
                    .is_ok()
            })
            .await;
        ok && ensure_ready().await.is_ok()
    }

    /// DB 测试串行锁(避免并行测试共用 admin/同一池互相污染)。
    async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        LOCK.lock().await
    }

    /// 建专用测试用户(收件人存在性校验需要真实 cmx_user 行;测完删除)。
    async fn create_test_user() -> Option<String> {
        let (mm, db_id) = db_handle().await.ok()?;
        let id = cmx_utils::id::snowflake_id().to_string();
        let username = format!("notify_test_{}", cmx_utils::id::snowflake_id());
        exec(
            mm,
            &db_id,
            None,
            "测试建用户",
            "INSERT INTO cmx_user (id, username, status, archived) VALUES ($1, $2, 1, 0)",
            vec![DataValue::String(id.clone()), DataValue::String(username)],
        )
        .await
        .ok()?;
        Some(id)
    }

    /// 清理测试产物:按主体 id 删收件行与主体,再删测试用户。
    async fn cleanup_test(notif_ids: &[String], uid: &str) {
        if let Ok((mm, db_id)) = db_handle().await {
            for id in notif_ids {
                if let Ok(nid) = id.parse::<i64>() {
                    let _ = exec(
                        mm,
                        &db_id,
                        None,
                        "测试清理收件行",
                        "DELETE FROM cmx_notification_recipient WHERE notification_id = $1",
                        vec![DataValue::Int(nid)],
                    )
                    .await;
                    let _ = exec(
                        mm,
                        &db_id,
                        None,
                        "测试清理主体",
                        "DELETE FROM cmx_notification WHERE id = $1",
                        vec![DataValue::Int(nid)],
                    )
                    .await;
                }
            }
            let _ = exec(
                mm,
                &db_id,
                None,
                "测试删用户",
                "DELETE FROM cmx_user WHERE id = $1",
                vec![DataValue::String(uid.to_string())],
            )
            .await;
        }
    }

    #[tokio::test]
    async fn publish_count_read_roundtrip() {
        if !ready_or_skip().await {
            return;
        }
        let _lock = test_lock().await;
        let Some(uid) = create_test_user().await else {
            eprintln!("skip: 无法创建测试用户");
            return;
        };
        let mut created: Vec<String> = Vec::new();

        // 初始 0
        assert_eq!(counts(&uid).await.unwrap().total, 0);

        // 单发 2 条 task + 1 条 message(服务身份,targets.userId 走存在性校验)
        let a = publish(&svc_ctx(), input("task", "t1", &uid)).await.unwrap();
        let b = publish(&svc_ctx(), input("task", "t2", &uid)).await.unwrap();
        let m = publish(&svc_ctx(), input("message", "m1", &uid)).await.unwrap();
        created.extend([a.id.clone(), b.id.clone(), m.id.clone()]);

        let c1 = counts(&uid).await.unwrap();
        assert_eq!((c1.task, c1.message, c1.log, c1.total), (2, 1, 0, 3));

        // 列表(全部)倒序 + 分页游标
        let all = list(&uid, &NotifyListFilter::default()).await.unwrap();
        assert_eq!(all.items.len(), 3);
        assert_eq!(all.total, 3);
        let page1 = list(&uid, &NotifyListFilter { limit: Some(2), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(page1.items.len(), 2);
        assert!(page1.next_cursor.is_some());
        let page2 = list(
            &uid,
            &NotifyListFilter {
                limit: Some(2),
                cursor: page1.next_cursor.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page1.items.len() + page2.items.len(), 3);

        // 过滤:仅 message / 仅 error 级别
        let only_m = list(
            &uid,
            &NotifyListFilter {
                center: Some(NotifyCenter::Message),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(only_m.items.len(), 1);

        // 标记单条已读 → message 未读归零
        assert!(mark_read(&uid, &m.id).await.unwrap());
        let c2 = counts(&uid).await.unwrap();
        assert_eq!((c2.message, c2.total), (0, 2));

        // 全部已读 → 0;用户隔离
        let n = mark_all_read(&uid, None).await.unwrap();
        assert_eq!(n, 2);
        assert_eq!(counts(&uid).await.unwrap().total, 0);

        // 非法 center
        let bad = NotifyInput { center: "bad".into(), ..input("task", "x", &uid) };
        assert!(publish(&svc_ctx(), bad).await.is_err());

        // 旧 snake_case user_id 入参兼容(alias)
        let raw = json!({
            "user_id": uid,          // snake_case(历史 MDM 契约)
            "center": "task",
            "title": "legacy",
            "body": "b",
        });
        let parsed: NotifyInput = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.user_id.as_deref(), Some(uid.as_str()));

        cleanup_test(&created, &uid).await;
    }

    #[tokio::test]
    async fn publish_permission_matrix() {
        if !ready_or_skip().await {
            return;
        }
        let uid = format!("notify-p-{}", cmx_utils::id::snowflake_id());

        // 普通用户群发(全员)→ 403(短路,不进解析)
        let mut i1 = input("message", "mass", &uid);
        i1.targets = Some(NotifyTargets { all: true, ..Default::default() });
        let err = publish(&user_ctx(&uid), i1).await.unwrap_err();
        assert!(matches!(err, PortalError::Forbidden(_)), "普通用户全员群发应 403: {err:?}");

        // 服务身份无目标 → 400(非 401)
        let i2 = NotifyInput {
            user_id: None,
            center: "message".into(),
            title: "svc-no-target".into(),
            body: None,
            level: None,
            link: None,
            msg_type: None,
            targets: None,
            agg_key: None,
            expire_at: None,
            source: Some("mdm".into()),
        };
        let mut svc_anon = svc_ctx();
        svc_anon.is_admin = false;
        let err = publish(&svc_anon, i2).await.unwrap_err();
        assert!(matches!(err, PortalError::BadRequest(_)), "服务身份无目标应 400: {err:?}");

        // 不存在的收件人 → 400 收件人为空
        let mut i3 = input("message", "ghost", &uid);
        i3.targets = Some(NotifyTargets {
            usernames: vec!["__no_such_user__".into()],
            ..Default::default()
        });
        i3.user_id = None;
        let err = publish(&svc_ctx(), i3).await.unwrap_err();
        assert!(matches!(err, PortalError::BadRequest(_)), "幽灵收件人应 400: {err:?}");
    }

    #[tokio::test]
    async fn aggregation_merges_same_key() {
        if !ready_or_skip().await {
            return;
        }
        let _lock = test_lock().await;
        let Some(uid) = create_test_user().await else {
            eprintln!("skip: 无法创建测试用户");
            return;
        };
        let agg = format!("agg-{}", cmx_utils::id::snowflake_id());
        let mk = |t: &str| NotifyInput {
            user_id: Some(uid.clone()),
            center: "message".into(),
            title: t.to_string(),
            body: Some("死信".into()),
            level: Some("error".into()),
            link: None,
            msg_type: Some("mdm.dead_letter".into()),
            targets: None,
            agg_key: Some(agg.clone()),
            expire_at: None,
            source: Some("mdm".into()),
        };
        let first = publish(&svc_ctx(), mk("first")).await.unwrap();
        let second = publish(&svc_ctx(), mk("second")).await.unwrap();

        // 第二次发布命中聚合:同一 id、count=2、列表仍只有一条
        let items = list(&uid, &NotifyListFilter::default()).await.unwrap().items;
        assert_eq!(items.len(), 1, "聚合后应只有一条通知");
        assert_eq!(items[0].id, second.id);
        assert_eq!(items[0].id, first.id);
        assert_eq!(items[0].agg_count, Some(2));

        cleanup_test(&[first.id], &uid).await;
    }
}
