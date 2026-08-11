//! 域应用清单读取：`activities/<name>.json`。
//!
//! 复刻 Node `lib/activitiesStore.js`：DAM 派生优先（从 dam-registry 列举 applications/modules
//! 合成 `{ version, source:"dam", domain, applications }`），回退文件读取。

use serde_json::json;

use crate::config::data_path;
use crate::dam::store::{DamApplication, list_applications, list_domains, list_modules};
use crate::error::{PortalError, PortalResult};
use crate::fsutil::read_json;
use crate::util::is_safe_id;

/// 去掉 `.json` 后缀和结尾 `portal`，得到 domain（与 Node normalizeActivitySetName 一致）。
fn normalize_set_name(name: &str) -> String {
    let n = name.strip_suffix(".json").unwrap_or(name);
    if n.len() >= 6 && n[n.len() - 6..].eq_ignore_ascii_case("portal") {
        n[..n.len() - 6].to_string()
    } else {
        n.to_string()
    }
}

/// 把一组应用合成活动栏条目（每个 app 一项，sideNav 走 `dam:<domain>/<app>` 模块菜单）。
fn build_applications(
    apps: &[DamApplication],
    all_modules: &[crate::dam::store::DamModule],
) -> Vec<serde_json::Value> {
    apps.iter()
        .map(|app| {
            let first_module = all_modules.iter().find(|m| m.domain == app.domain && m.application == app.id);
            let label = if !app.name.is_empty() { app.name.clone() } else { app.id.clone() };
            let icon = if !app.icon.is_empty() {
                app.icon.clone()
            } else {
                first_module.map(|m| m.icon.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "application".to_string())
            };
            json!({
                "id": app.id,
                "domain": app.domain,
                "icon": icon,
                "label": label,
                "position": "top",
                "sideNav": { "type": "module", "menu": format!("dam:{}/{}", app.domain, app.id), "title": label },
            })
        })
        .collect()
}

/// DAM 派生活动栏文档（无可用应用时返回 None 以回退文件）。
///
/// # Arguments
///
/// * `name` - 活动栏名称，归一出非空域（如 `fiportal`->`fi`）时只取该域的应用；
///   归一为空域（如门户级 `portal`）时聚合**全部启用域**的应用，门户即全域聚合。
///
/// # Returns
///
/// 有可用应用时返回 `Some(文档)`；无可用应用时返回 `None` 以回退文件读取。
///
/// # Errors
///
/// 列举 DAM 域/应用/模块失败时返回底层错误。
async fn dam_activities_doc(name: &str) -> PortalResult<Option<serde_json::Value>> {
    let domain = normalize_set_name(name);

    if domain.is_empty() {
        // 门户级：聚合所有启用域的应用。
        let domains: Vec<_> = list_domains(true).await?;
        let mut apps: Vec<DamApplication> = Vec::new();
        for d in &domains {
            let mut da: Vec<DamApplication> = list_applications(Some(&d.id), true).await?;
            apps.append(&mut da);
        }
        if apps.is_empty() {
            return Ok(None);
        }
        let all_modules: Vec<_> = list_modules(None, None, true).await?;
        let applications = build_applications(&apps, &all_modules);
        return Ok(Some(
            json!({ "version": 1, "source": "dam", "applications": applications }),
        ));
    }

    let apps: Vec<DamApplication> = list_applications(Some(&domain), true).await?;
    if apps.is_empty() {
        return Ok(None);
    }
    let all_modules: Vec<_> = list_modules(Some(&domain), None, true).await?;
    let applications = build_applications(&apps, &all_modules);
    Ok(Some(
        json!({ "version": 1, "source": "dam", "domain": domain, "applications": applications }),
    ))
}

/// 读取活动栏（域应用清单）文档。
///
/// # Arguments
///
/// * `name` - 活动栏名称（如 `fiportal`、`portal`），仅允许字母、数字、._-。
///
/// # Returns
///
/// DAM 派生优先；无可用应用时回退读 `activities/<name>.json` 文件原样返回。
///
/// # Errors
///
/// `name` 为空或非法返回 `bad_request`；文件不存在返回 `not_found`；读取失败返回底层错误。
pub async fn get_activities_doc(name: &str) -> PortalResult<serde_json::Value> {
    let n = name.trim();
    if n.is_empty() {
        return Err(PortalError::bad_request("缺少必填查询参数 name"));
    }
    if !is_safe_id(n) {
        return Err(PortalError::bad_request(
            "name 仅允许字母、数字、._-，长度 1–128",
        ));
    }
    if let Some(doc) = dam_activities_doc(n).await? {
        return Ok(doc);
    }
    let path = data_path(["activities", &format!("{n}.json")]);
    match read_json::<serde_json::Value>(&path).await {
        Ok(v) => Ok(v),
        Err(PortalError::NotFound(_)) => {
            Err(PortalError::not_found(format!("活动栏定义不存在：{n}")))
        }
        Err(e) => Err(e),
    }
}
