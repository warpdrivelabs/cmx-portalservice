//! 模块清单与资源解析。
//!
//! 复刻 Node `lib/moduleResourceResolver.js`：
//! - `list_module_manifests`：DAM 优先（映射注册表 modules），回退 `modules/` 目录扫描。
//! - `load_module_manifest`：读 `modules/<d>/<a>/<m>/module.json`（注册表 manifestPath 优先）。
//! - `resolve_module_resource`：按 type 解析 manifest.resources，标注每项 exists/kind。

use serde_json::json;

use crate::config::{data_path, data_root};
use crate::dam::store::list_modules;
use crate::error::{PortalError, PortalResult};
use crate::fsutil::read_json;
use crate::util::{is_safe_segment, resolve_within};

/// 校验路径段非空且仅含安全字符，返回 trim 后的字符串。
fn assert_seg(name: &str, value: &str) -> PortalResult<String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(PortalError::bad_request(format!("缺少必填参数 {name}")));
    }
    if !is_safe_segment(v) {
        return Err(PortalError::bad_request(format!(
            "参数 {name} 非法（仅允许字母、数字、_-）：\"{value}\""
        )));
    }
    Ok(v.to_string())
}

/// 列出模块清单（DAM 优先）。
///
/// # Arguments
///
/// * `domain` - 可选域过滤。
/// * `application` - 可选应用过滤。
///
/// # Returns
///
/// DAM 有模块时返回映射后的清单列表（已排序）；DAM 为空时回退文件系统扫描。
///
/// # Errors
///
/// 列举 DAM 模块或文件系统扫描失败时返回底层错误。
pub async fn list_module_manifests(
    domain: Option<&str>,
    application: Option<&str>,
) -> PortalResult<Vec<serde_json::Value>> {
    let modules = list_modules(domain, application, true).await?;
    if !modules.is_empty() {
        let mut items: Vec<serde_json::Value> = modules
            .iter()
            .map(|m| {
                json!({
                    "domain": m.domain,
                    "application": m.application,
                    "app": m.application,
                    "module": m.id,
                    "id": m.id,
                    "name": if m.name.is_empty() { m.id.clone() } else { m.name.clone() },
                    "title": if !m.title.is_empty() { m.title.clone() } else if !m.name.is_empty() { m.name.clone() } else { m.id.clone() },
                    "icon": m.icon,
                    "status": if m.status.is_empty() { "active".to_string() } else { m.status.clone() },
                    "description": m.description,
                    "resourceRoot": if m.resource_root.is_empty() { format!("{}/{}/{}", m.domain, m.application, m.id) } else { m.resource_root.clone() },
                    "aliases": m.aliases,
                    "manifestPath": if m.manifest_path.is_empty() { format!("modules/{}/{}/{}/module.json", m.domain, m.application, m.id) } else { m.manifest_path.clone() },
                })
            })
            .collect();
        items.sort_by(|a, b| {
            let ka = format!(
                "{}/{}/{}",
                a["domain"].as_str().unwrap_or(""),
                a["application"].as_str().unwrap_or(""),
                a["module"].as_str().unwrap_or("")
            );
            let kb = format!(
                "{}/{}/{}",
                b["domain"].as_str().unwrap_or(""),
                b["application"].as_str().unwrap_or(""),
                b["module"].as_str().unwrap_or("")
            );
            ka.cmp(&kb)
        });
        return Ok(items);
    }
    // 回退：扫描 modules/ 目录
    list_manifests_from_fs(domain, application).await
}

/// 文件系统扫描回退（DAM 为空时）。
///
/// # Arguments
///
/// * `domain` - 可选域过滤。
/// * `application` - 可选应用过滤。
///
/// # Returns
///
/// 扫描 `modules/` 目录下所有 `module.json` 的清单列表（已排序）。
///
/// # Errors
///
/// 读取目录或文件失败时返回底层 IO 错误。
async fn list_manifests_from_fs(
    domain: Option<&str>,
    application: Option<&str>,
) -> PortalResult<Vec<serde_json::Value>> {
    let root = data_path(["modules"]);
    let wd = domain.unwrap_or("").trim().to_string();
    let wa = application.unwrap_or("").trim().to_string();
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, Vec<String>)> = vec![(root, Vec::new())];
    while let Some((dir, parts)) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(PortalError::Io(e)),
        };
        while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let ft = entry.file_type().await.map_err(PortalError::Io)?;
            let mut next = parts.clone();
            next.push(name.clone());
            if ft.is_dir() {
                if next.len() == 1 && !wd.is_empty() && wd != name {
                    continue;
                }
                if next.len() == 2 && !wa.is_empty() && wa != name {
                    continue;
                }
                stack.push((entry.path(), next));
            } else if ft.is_file() && name == "module.json" && parts.len() == 3 {
                let rel = format!("modules/{}/{}/{}/module.json", parts[0], parts[1], parts[2]);
                match read_json::<serde_json::Value>(&entry.path()).await {
                    Ok(doc) => out.push(json!({
                        "domain": doc.get("domain").and_then(|v| v.as_str()).unwrap_or(&parts[0]),
                        "application": doc.get("application").and_then(|v| v.as_str()).unwrap_or(&parts[1]),
                        "module": doc.get("module").and_then(|v| v.as_str()).unwrap_or(&parts[2]),
                        "title": doc.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                        "status": doc.get("status").and_then(|v| v.as_str()).unwrap_or("active"),
                        "aliases": doc.get("aliases").cloned().unwrap_or(json!([])),
                        "resourceTypes": doc.get("resources").and_then(|r| r.as_object()).map(|o| {
                            let mut keys: Vec<&String> = o.keys().collect();
                            keys.sort();
                            keys
                        }).unwrap_or_default(),
                        "manifestPath": rel,
                    })),
                    Err(e) => out.push(json!({ "domain": parts[0], "application": parts[1], "module": parts[2], "error": e.to_string() })),
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let ka = format!(
            "{}/{}/{}",
            a["domain"].as_str().unwrap_or(""),
            a["application"].as_str().unwrap_or(""),
            a["module"].as_str().unwrap_or("")
        );
        let kb = format!(
            "{}/{}/{}",
            b["domain"].as_str().unwrap_or(""),
            b["application"].as_str().unwrap_or(""),
            b["module"].as_str().unwrap_or("")
        );
        ka.cmp(&kb)
    });
    Ok(out)
}

/// 解析注册表中模块的 manifestPath（相对 data 根），无则用默认路径。
///
/// # Arguments
///
/// * `domain` - 域标识。
/// * `application` - 应用标识。
/// * `module` - 模块标识。
///
/// # Returns
///
/// manifest 文件的绝对路径（注册表有 manifestPath 时用之，否则用默认 `modules/<d>/<a>/<m>/module.json`）。
///
/// # Errors
///
/// 列举 DAM 模块失败时返回底层错误。
async fn registered_manifest_path(
    domain: &str,
    application: &str,
    module: &str,
) -> PortalResult<std::path::PathBuf> {
    let hit = list_modules(Some(domain), Some(application), false)
        .await?
        .into_iter()
        .find(|m| m.id == module);
    let rel = hit
        .map(|m| m.manifest_path)
        .filter(|s| !s.trim().is_empty());
    match rel {
        Some(r) => {
            // 用 resolve_within 校验：拒绝 `..` / 绝对路径穿越，保证落在 data root 内。
            resolve_within(&data_root(), &r)
        }
        None => Ok(data_path([
            "modules",
            domain,
            application,
            module,
            "module.json",
        ])),
    }
}

/// 读取模块 manifest（含 manifestPath 字段，相对 data 根）。
///
/// # Arguments
///
/// * `domain` - 域标识。
/// * `application` - 应用标识。
/// * `module` - 模块标识。
///
/// # Returns
///
/// 模块 manifest JSON（已注入 `manifestPath` 字段）。
///
/// # Errors
///
/// 参数为空或非法返回 `bad_request`；manifest 不存在返回 `not_found`；读取失败返回底层错误。
pub async fn load_module_manifest(
    domain: &str,
    application: &str,
    module: &str,
) -> PortalResult<serde_json::Value> {
    let d = assert_seg("domain", domain)?;
    let a = assert_seg("application", application)?;
    let m = assert_seg("module", module)?;
    let path = registered_manifest_path(&d, &a, &m).await?;
    match read_json::<serde_json::Value>(&path).await {
        Ok(mut doc) => {
            // 计算相对 data 根的 manifestPath
            let rel = path
                .strip_prefix(data_root())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if let Some(obj) = doc.as_object_mut() {
                obj.insert("manifestPath".to_string(), json!(rel));
            }
            Ok(doc)
        }
        Err(PortalError::NotFound(_)) => Err(PortalError::not_found(format!(
            "模块清单不存在：{d}/{a}/{m}"
        ))),
        Err(e) => Err(e),
    }
}

/// 解析模块某类资源（标注每项 exists/kind）。
///
/// # Arguments
///
/// * `domain` - 域标识。
/// * `application` - 应用标识。
/// * `module` - 模块标识。
/// * `res_type` - 资源类型（如 `menus`、`htmlPages` 等）。
///
/// # Returns
///
/// 资源列表 JSON（每项含 path/absPath/exists/kind 字段）。
///
/// # Errors
///
/// `res_type` 非法返回 `bad_request`；加载 manifest 失败返回底层错误。
///
/// # 弃用资源类型
///
/// 以下资源类型对应的目录已废弃（文档《data 目录结构》+ AGENTS 第十八章），
/// 前端 DAM 资源态势已移除展示，保留此处仅为存量 module.json 兼容：
/// - `dictEntries` / `dictSeeds` / `dictRegistry` → `dict/`（已被 `/api/dict/*` 替代）
/// - `facts` → `fact/`（已被数据库凭证接口替代）
///
/// 新功能不应再向 manifest 声明这些资源类型。
pub async fn resolve_module_resource(
    domain: &str,
    application: &str,
    module: &str,
    res_type: &str,
) -> PortalResult<serde_json::Value> {
    let t = assert_seg("type", res_type)?;
    let manifest = load_module_manifest(domain, application, module).await?;
    let raw = manifest.get("resources").and_then(|r| r.get(&t));
    let entries: Vec<serde_json::Value> = match raw {
        Some(serde_json::Value::Array(arr)) => arr.clone(),
        Some(v @ serde_json::Value::Object(_)) => vec![v.clone()],
        Some(serde_json::Value::String(s)) => vec![json!({ "path": s })],
        _ => vec![],
    };
    let mut resources = Vec::new();
    for item in entries {
        let entry = if item.is_string() {
            json!({ "path": item })
        } else {
            item
        };
        let raw_path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let rel = raw_path.trim_start_matches('/').to_string();
        // 用 resolve_within 校验：拒绝 `..` / 绝对路径穿越，保证 absPath 落在 data root 内。
        let abs = resolve_within(&data_root(), &rel)?;
        let meta = tokio::fs::metadata(&abs).await.ok();
        let exists = meta.is_some();
        let mut kind = entry
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if kind.is_empty()
            && let Some(m) = &meta
        {
            kind = if m.is_dir() {
                "directory".to_string()
            } else if m.is_file() {
                "file".to_string()
            } else {
                "other".to_string()
            };
        }
        let mut out = entry.clone();
        if let Some(o) = out.as_object_mut() {
            o.insert("path".to_string(), json!(rel));
            o.insert("absPath".to_string(), json!(abs.to_string_lossy()));
            o.insert("exists".to_string(), json!(exists));
            o.insert("kind".to_string(), json!(kind));
        }
        resources.push(out);
    }
    Ok(json!({
        "domain": manifest.get("domain"),
        "application": manifest.get("application"),
        "module": manifest.get("module"),
        "type": t,
        "resources": resources,
    }))
}
