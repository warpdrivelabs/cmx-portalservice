//! 域清单（domains）读取。
//!
//! 复刻 Node `lib/domainsStore.js` 的 `getDomainsDoc()`：
//! 1. 优先从数据库（cmx_domain 表，经 store::list_domains 查询）派生 —— 过滤掉 `status=disabled`，
//!    映射为前端期望的 `{ id, icon, label, title, description, application, activitie }`。
//! 2. DB 无域时回退读 `activities/domains.json` 原样返回。

use serde::{Deserialize, Serialize};

use crate::config::data_path;
use crate::error::PortalResult;
use crate::fsutil::read_json;

/// 单个域条目（对前端输出形状，与 Node 完全一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainItem {
    /// 域唯一标识。
    pub id: String,
    /// 图标名（回退 `folder`）。
    pub icon: String,
    /// 短标签（取 name，回退 title，再回退 id）。
    pub label: String,
    /// 完整标题。
    pub title: String,
    /// 域描述。
    pub description: String,
    /// 应用标识（与 id 相同，前端约定字段）。
    pub application: String,
    /// 活动栏标识（与 id 相同，前端约定字段）。
    pub activitie: String,
}

/// `/api/domains` 响应文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainsDoc {
    /// 文档版本号。
    pub version: u32,
    /// 数据来源（`"dam"` 或文件原始来源）。
    pub source: String,
    /// 域条目列表。
    pub domains: Vec<DomainItem>,
}

/// 获取域清单文档。DB 优先，回退 `activities/domains.json`。
///
/// # Returns
///
/// DAM 注册表有域时返回派生文档（`source="dam"`）；否则回退读文件原样返回。
///
/// # Errors
///
/// 读取 DAM 注册表或回退文件失败时返回底层 IO/解析错误。
pub async fn get_domains_doc() -> PortalResult<serde_json::Value> {
    // 1) 从数据库查启用域（active_only=true，只返回 status=1）
    let dam_domains = crate::dam::store::list_domains(true).await?;
    let domains: Vec<DomainItem> = dam_domains
        .into_iter()
        .map(|d| {
            let label = if d.name.is_empty() {
                if d.title.is_empty() {
                    d.id.clone()
                } else {
                    d.title.clone()
                }
            } else {
                d.name.clone()
            };
            DomainItem {
                application: d.id.clone(),
                activitie: d.id.clone(),
                icon: if d.icon.is_empty() {
                    "folder".to_string()
                } else {
                    d.icon
                },
                label,
                title: d.title,
                description: d.description,
                id: d.id,
            }
        })
        .collect();
    if !domains.is_empty() {
        let doc = DomainsDoc {
            version: 1,
            source: "dam".to_string(),
            domains,
        };
        return Ok(serde_json::to_value(doc)?);
    }

    // 2) 回退：activities/domains.json 原样返回
    let file = data_path(["activities", "domains.json"]);
    let raw: serde_json::Value = read_json(&file).await?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 CMXPortalManager 的真实 `data/` 目录验证 DAM 派生逻辑与 Node 等价：
    /// 必须 `source=dam`、版本=1、domains 非空，且每个域含完整字段且 application==activitie==id。
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn domains_derived_from_dam_registry() {
        // 串行化对 CMX_PORTAL_DATA_ROOT 的修改，避免与其它切换数据根的测试并行污染。
        let _env = crate::util::test_data_root_lock().lock().unwrap();
        // 指向 Node 后端的真实数据目录（相对 cmx-portal crate 根：../../../../CMXPortalManager/...）
        let crate_dir = env!("CARGO_MANIFEST_DIR");
        let data_root = std::path::Path::new(crate_dir)
            .join("../../../../CMXPortalManager/cmx-node-server/data");
        // 该数据目录来自旧的 monorepo 布局，独立检出 cmx-container 时并不存在——
        // 缺失时优雅跳过（对齐 PG 集成测试「无 TEST_PG_URL 即跳过」的做法），
        // 避免把「缺测试夹具」误报成「代码回归」，也不污染共享的 CMX_PORTAL_DATA_ROOT。
        if !data_root.join("dam").exists() && !data_root.exists() {
            eprintln!(
                "跳过 domains_derived_from_dam_registry：未找到夹具目录 {}",
                data_root.display()
            );
            return;
        }
        // SAFETY: 测试单线程设置进程环境变量；data_root() 读取它。
        unsafe { std::env::set_var("CMX_PORTAL_DATA_ROOT", data_root) };

        let doc = get_domains_doc().await.expect("应成功派生域清单");
        assert_eq!(doc["source"], "dam", "应优先从 DAM 注册表派生");
        assert_eq!(doc["version"], 1);
        let domains = doc["domains"].as_array().expect("domains 应为数组");
        assert!(!domains.is_empty(), "应至少派生出一个域");

        // 校验首个域字段完整 + application==activitie==id（与 Node 映射一致）
        let first = &domains[0];
        for key in [
            "id",
            "icon",
            "label",
            "title",
            "description",
            "application",
            "activitie",
        ] {
            assert!(first.get(key).is_some(), "域缺少字段: {key}");
        }
        assert_eq!(first["application"], first["id"]);
        assert_eq!(first["activitie"], first["id"]);

        // 不应包含被禁用的域
        for d in domains {
            assert_ne!(d["id"], serde_json::Value::Null);
        }
    }
}
