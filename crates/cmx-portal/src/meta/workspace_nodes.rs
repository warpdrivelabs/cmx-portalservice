//! 工作区节点存储：所有节点汇总在 `node/nodes.json`（单一文件）。
//!
//! 文件结构：`{ "version": 1, "nodes": { [id]: WorkspaceNodeRecord } }`。
//! 复刻 Node `lib/workspaceNodesStore.js`：list（摘要，按 updatedAt 倒序）/ get（完整）/
//! save（upsert，updatedAt 由服务端维护）/ delete。写操作走全局写锁 + 原子写。

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::data_path;
use crate::error::{PortalError, PortalResult};
use crate::fsutil::{read_json_opt, write_json_atomic};
use crate::util::{validate_id, write_lock};

/// 节点完整记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceNodeRecord {
    /// 节点唯一标识。
    pub id: String,
    /// 节点名称。
    #[serde(default)]
    pub name: String,
    /// 图标名。
    #[serde(default)]
    pub icon: String,
    /// 详情描述。
    #[serde(default)]
    pub details: String,
    /// 工作区配置（完整 workspace 定义）。
    #[serde(default)]
    pub workspace: serde_json::Value,
    /// 最后更新时间（RFC3339，服务端维护）。
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
}

/// 列表摘要项（不含 workspace 内容）。
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceNodeSummary {
    /// 节点唯一标识。
    pub id: String,
    /// 节点名称。
    pub name: String,
    /// 图标名。
    pub icon: String,
    /// 详情描述。
    pub details: String,
    /// 最后更新时间（RFC3339）。
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 保存入参（来自 HTTP body）。
#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceNodeInput {
    /// 节点唯一标识（新建时可为空，由服务端生成）。
    #[serde(default)]
    pub id: String,
    /// 节点名称。
    #[serde(default)]
    pub name: Option<String>,
    /// 图标名。
    #[serde(default)]
    pub icon: Option<String>,
    /// 详情描述。
    #[serde(default)]
    pub details: Option<String>,
    /// 工作区配置（必须为对象）。
    #[serde(default)]
    pub workspace: Option<serde_json::Value>,
}

/// 返回节点存储文件的绝对路径（`node/nodes.json`）。
fn nodes_path() -> std::path::PathBuf {
    data_path(["node", "nodes.json"])
}

/// 读取节点文档（容错：缺失 / 结构非法时返回空文档）。
///
/// # Returns
///
/// 节点文档 JSON（保证含 `version` 和 `nodes` 对象字段）。
///
/// # Errors
///
/// 读取文件失败（非 NotFound）时返回底层 IO/解析错误。
async fn read_doc() -> PortalResult<serde_json::Value> {
    match read_json_opt(&nodes_path()).await? {
        Some(v) if v.get("nodes").map(|n| n.is_object()).unwrap_or(false) => Ok(v),
        _ => Ok(json!({ "version": 1, "nodes": {} })),
    }
}

/// 列出节点摘要，按 updatedAt 倒序。
///
/// # Returns
///
/// `{ items: [WorkspaceNodeSummary], total: usize }`，按 updatedAt 字典序倒序。
///
/// # Errors
///
/// 读取节点文档失败时返回底层错误。
pub async fn list_workspace_nodes() -> PortalResult<serde_json::Value> {
    let doc = read_doc().await?;
    let mut items: Vec<WorkspaceNodeSummary> = doc["nodes"]
        .as_object()
        .map(|m| {
            m.values()
                .map(|row| WorkspaceNodeSummary {
                    id: row
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: row
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    icon: row
                        .get("icon")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    details: row
                        .get("details")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    updated_at: row
                        .get("updatedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    // updatedAt 倒序（与 Node 的 localeCompare 倒序等价：字典序逆序）
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let total = items.len();
    Ok(json!({ "items": items, "total": total }))
}

/// 按 id 读取完整节点定义。
///
/// # Arguments
///
/// * `id` - 节点唯一标识。
///
/// # Returns
///
/// 节点完整记录（含 workspace 内容）。
///
/// # Errors
///
/// `id` 非法返回 `bad_request`；节点不存在返回 `not_found`；读取/反序列化失败返回底层错误。
pub async fn get_workspace_node_by_id(id: &str) -> PortalResult<WorkspaceNodeRecord> {
    let key = validate_id(id, "id")?;
    let doc = read_doc().await?;
    let row = doc["nodes"]
        .get(&key)
        .cloned()
        .ok_or_else(|| PortalError::not_found(format!("workspace-node 不存在：{key}")))?;
    let record: WorkspaceNodeRecord = serde_json::from_value(row)?;
    Ok(record)
}

/// upsert 保存节点（updatedAt 由服务端写当前时间）。
///
/// # Arguments
///
/// * `input` - 保存入参（来自 HTTP body），id 可为空（新建）。
///
/// # Returns
///
/// 保存后的节点完整记录。
///
/// # Errors
///
/// `id` 非法或 workspace 非对象返回 `bad_request`；读取/写入文件失败返回底层错误。
pub async fn save_workspace_node(input: WorkspaceNodeInput) -> PortalResult<WorkspaceNodeRecord> {
    let id = validate_id(&input.id, "id")?;
    let workspace = match input.workspace {
        Some(w) if w.is_object() => w,
        _ => return Err(PortalError::bad_request("workspace 必须为对象")),
    };
    let record = WorkspaceNodeRecord {
        id: id.clone(),
        name: input.name.unwrap_or_default(),
        icon: input.icon.map(|s| s.trim().to_string()).unwrap_or_default(),
        details: input.details.unwrap_or_default(),
        workspace,
        updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };

    let _guard = write_lock().lock().await;
    let mut doc = read_doc().await?;
    doc["nodes"][&id] = serde_json::to_value(&record)?;
    write_json_atomic(&nodes_path(), &doc, true).await?;
    Ok(record)
}

/// 删除节点。
///
/// # Arguments
///
/// * `id` - 待删除节点唯一标识。
///
/// # Returns
///
/// `{ id, removed }`，`removed` 为 `true` 表示已删除，`false` 表示节点不存在。
///
/// # Errors
///
/// `id` 非法返回 `bad_request`；读取/写入文件失败返回底层错误。
pub async fn delete_workspace_node(id: &str) -> PortalResult<serde_json::Value> {
    let key = validate_id(id, "id")?;
    let _guard = write_lock().lock().await;
    let mut doc = read_doc().await?;
    let had = doc["nodes"].get(&key).is_some();
    if !had {
        return Ok(json!({ "id": key, "removed": false }));
    }
    if let Some(map) = doc["nodes"].as_object_mut() {
        map.remove(&key);
    }
    write_json_atomic(&nodes_path(), &doc, true).await?;
    Ok(json!({ "id": key, "removed": true }))
}
