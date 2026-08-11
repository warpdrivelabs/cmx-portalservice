//! DAM 注册表 store 实现。
//!
//! 原先读写 `dam-registry/registry.json` 的实现已废弃：DAM 主数据（域/应用/模块）
//! 已迁入数据库（`cmx_domain`/`cmx_application`/`cmx_module` 三表），写操作走
//! `cmx-biz` 的 Service。本模块只保留从数据库查询并反向映射回原 registry shape
//! 的只读读路径（`get_dam_registry`/`list_domains`/`list_applications`/`list_modules`），
//! 供 `/api/registry/dam` 等只读消费方使用。

use serde::{Deserialize, Serialize};

// ───────────────────────── 实体结构 ─────────────────────────

/// 域。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DamDomain {
    /// 数据库真实主键（雪花号，update/delete 操作用）。
    #[serde(default)]
    #[serde(rename = "dbId")]
    pub db_id: String,
    /// 域唯一标识（业务键，即 DB 的 code，显示用）。
    pub id: String,
    /// 域名称。
    pub name: String,
    /// 域标题（显示用）。
    pub title: String,
    /// 域图标标识。
    pub icon: String,
    /// 域状态（active 等）。
    pub status: String,
    /// 域描述。
    pub description: String,
    /// 排序值（数值小的靠前）。
    #[serde(default)]
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
}

/// 应用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DamApplication {
    /// 数据库真实主键（雪花号，update/delete 操作用）。
    #[serde(default)]
    #[serde(rename = "dbId")]
    pub db_id: String,
    /// 所属域 id。
    pub domain: String,
    /// 应用唯一标识（业务键，即 cmx_application.code 纯净短码，显示用）。
    pub id: String,
    /// 应用名称。
    pub name: String,
    /// 应用标题（显示用）。
    pub title: String,
    /// 应用图标标识。
    pub icon: String,
    /// 应用状态（active 等）。
    pub status: String,
    /// 应用描述。
    pub description: String,
    /// 排序值（数值小的靠前）。
    #[serde(default)]
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
}

/// 模块（含 app/module 别名字段，与 Node 输出一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DamModule {
    /// 数据库真实主键（雪花号，update/delete 操作用）。
    #[serde(default)]
    #[serde(rename = "dbId")]
    pub db_id: String,
    /// 所属域 id。
    pub domain: String,
    /// 所属应用 id。
    pub application: String,
    /// 应用别名字段（与 application 同值，兼容 Node 输出）。
    pub app: String,
    /// 模块唯一标识。
    pub id: String,
    /// 模块别名字段（与 id 同值，兼容 Node 输出）。
    pub module: String,
    /// 模块名称。
    pub name: String,
    /// 模块标题（显示用）。
    pub title: String,
    /// 模块图标标识。
    pub icon: String,
    /// 模块状态（active 等）。
    pub status: String,
    /// 模块描述。
    pub description: String,
    /// 资源根路径（相对 data root）。
    #[serde(rename = "resourceRoot")]
    pub resource_root: String,
    /// manifest 文件路径（相对 data root）。
    #[serde(rename = "manifestPath")]
    pub manifest_path: String,
    /// 模块别名列表。
    #[serde(default)]
    pub aliases: Vec<String>,
    /// 模块主题配置（可选 JSON 对象）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<serde_json::Value>,
    /// 主题色标识。
    #[serde(rename = "themeColor")]
    pub theme_color: String,
    /// 排序值（数值小的靠前）。
    #[serde(default)]
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
}

/// 规范化后的完整注册表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DamRegistry {
    /// 注册表版本号。
    pub version: u32,
    /// 域列表。
    pub domains: Vec<DamDomain>,
    /// 应用列表。
    pub applications: Vec<DamApplication>,
    /// 模块列表。
    pub modules: Vec<DamModule>,
}

// ───────────────────────── 读 ─────────────────────────

/// 完整注册表（从数据库聚合，保持与原 registry.json 相同的返回形状）。
///
/// 数据主数据已迁入 cmx_domain/cmx_application/cmx_module 三表，
/// 此函数查 DB 后反向映射回 DamRegistry shape（供 /api/registry/dam 等只读消费方）。
///
/// `active_only` 为 true 时只返回 status=1（启用）的记录。
#[tracing::instrument]
pub async fn get_dam_registry(active_only: bool) -> crate::error::PortalResult<DamRegistry> {
    // 三表查询互不依赖，并行执行缩短 RTT。
    let (domains, applications, modules) = tokio::try_join!(
        list_domains(active_only),
        list_applications(None, active_only),
        list_modules(None, None, active_only),
    )?;
    Ok(DamRegistry {
        version: 1,
        domains,
        applications,
        modules,
    })
}

/// 从 DB 获取默认 DatabaseManager + db_id。
async fn db_handle() -> crate::error::PortalResult<(&'static cmx_database::DatabaseManager, String)>
{
    let mm = cmx_database::get_default_db_manager();
    let db_id = mm.get_default_db_id().await;
    Ok((mm, db_id))
}

/// 从 DataSet 行提取字符串字段。
fn row_str(
    row: &cmx_core::model::data::dataset::Row,
    schema: &cmx_core::model::data::dataset::Schema,
    name: &str,
) -> String {
    row.get_by_name_as(schema, name).unwrap_or_default()
}

/// 从 DataSet 行提取可选字符串字段。
fn row_str_opt(
    row: &cmx_core::model::data::dataset::Row,
    schema: &cmx_core::model::data::dataset::Schema,
    name: &str,
) -> Option<String> {
    row.get_by_name_as(schema, name)
}

/// 从 DataSet 行提取 i32 status 并转为 "active"/"disabled" 字符串。
fn row_status(
    row: &cmx_core::model::data::dataset::Row,
    schema: &cmx_core::model::data::dataset::Schema,
) -> String {
    let v: Option<i32> = row.get_by_name_as(schema, "status");
    match v {
        Some(0) => "disabled".to_string(),
        _ => "active".to_string(),
    }
}

/// 从 DataSet 行提取 i32 字段（缺失回 0）。
fn row_i32(
    row: &cmx_core::model::data::dataset::Row,
    schema: &cmx_core::model::data::dataset::Schema,
    name: &str,
) -> i32 {
    row.get_by_name_as(schema, name).unwrap_or(0)
}

/// 域列表（查 cmx_domain，反向映射回 DamDomain shape）。
///
/// `active_only` 为 true 时只返回 status=1（启用）的记录。
#[tracing::instrument]
pub async fn list_domains(active_only: bool) -> crate::error::PortalResult<Vec<DamDomain>> {
    let (mm, db_id) = db_handle().await?;
    let sql = if active_only {
        "SELECT id, code, name, title, icon, description, status, sort_order FROM cmx_domain WHERE status = 1 ORDER BY sort_order, code"
    } else {
        "SELECT id, code, name, title, icon, description, status, sort_order FROM cmx_domain ORDER BY sort_order, code"
    };
    let ds = mm
        .query_sql(&db_id, None, sql, "dam_domains")
        .await
        .map_err(|e| crate::error::PortalError::business(format!("查询域失败: {}", e)))?;
    let schema = ds.schema.as_ref();
    let mut out = Vec::new();
    for row in ds.iter() {
        let code = row_str(row, schema, "code");
        out.push(DamDomain {
            db_id: row_str(row, schema, "id"),
            id: code,
            name: row_str(row, schema, "name"),
            title: row_str(row, schema, "title"),
            icon: row_str(row, schema, "icon"),
            status: row_status(row, schema),
            description: row_str(row, schema, "description"),
            sort_order: row_i32(row, schema, "sort_order"),
        });
    }
    Ok(out)
}

/// 应用列表（按 domain 过滤，查 cmx_application，映射回 DamApplication shape）。
///
/// DB 的 `code` 即纯净短码（如 `cmxfico`），直接作为 id 返回，无需反拆。
/// `active_only` 为 true 时只返回 status=1（启用）的记录。
#[tracing::instrument]
pub async fn list_applications(
    domain: Option<&str>,
    active_only: bool,
) -> crate::error::PortalResult<Vec<DamApplication>> {
    let (mm, db_id) = db_handle().await?;
    let d = domain.unwrap_or("").trim();
    // 组合 WHERE 条件：domain_code 和 status（参数化，避免 SQL 注入）。
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<cmx_core::model::cell::DataValue> = Vec::new();
    if !d.is_empty() {
        params.push(d.to_string().into());
        conditions.push(format!("domain_code = ${}", params.len()));
    }
    if active_only {
        conditions.push("status = 1".to_string());
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, code, domain_code, name, title, icon, description, status, sort_order FROM cmx_application{} ORDER BY sort_order, code",
        where_clause
    );
    let ds = mm
        .query_sql_with_datavalues(&db_id, None, &sql, params, "dam_applications")
        .await
        .map_err(|e| crate::error::PortalError::business(format!("查询应用失败: {}", e)))?;
    let schema = ds.schema.as_ref();
    let mut out = Vec::new();
    for row in ds.iter() {
        let code = row_str(row, schema, "code");
        let domain_code = row_str(row, schema, "domain_code");
        out.push(DamApplication {
            db_id: row_str(row, schema, "id"),
            domain: domain_code,
            id: code,
            name: row_str(row, schema, "name"),
            title: row_str(row, schema, "title"),
            icon: row_str(row, schema, "icon"),
            status: row_status(row, schema),
            description: row_str(row, schema, "description"),
            sort_order: row_i32(row, schema, "sort_order"),
        });
    }
    Ok(out)
}

/// 模块列表（按 domain/application 过滤，查 cmx_module，映射回 DamModule shape）。
///
/// DB 的 `code` 即纯净短码（如 `gl`），`application_code` 即应用短码（如 `cmxfico`），
/// 直接作为 id / application 返回，无需反拆。
/// `active_only` 为 true 时只返回 status=1（启用）的记录。
#[tracing::instrument]
pub async fn list_modules(
    domain: Option<&str>,
    application: Option<&str>,
    active_only: bool,
) -> crate::error::PortalResult<Vec<DamModule>> {
    let (mm, db_id) = db_handle().await?;
    let d = domain.unwrap_or("").trim();
    let a = application.unwrap_or("").trim();
    // 组合 WHERE 条件：domain_code / application_code / status（参数化，避免 SQL 注入）。
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<cmx_core::model::cell::DataValue> = Vec::new();
    if !d.is_empty() {
        params.push(d.to_string().into());
        conditions.push(format!("domain_code = ${}", params.len()));
    }
    if !a.is_empty() {
        // a 是应用短码，DB 的 application_code 也是短码，直接精确匹配。
        params.push(a.to_string().into());
        conditions.push(format!("application_code = ${}", params.len()));
    }
    if active_only {
        conditions.push("status = 1".to_string());
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, code, domain_code, application_code, name, title, icon, description, tags, resource_root, manifest_path, theme, theme_color, status, sort_order FROM cmx_module{} ORDER BY sort_order, code",
        where_clause
    );
    let ds = mm
        .query_sql_with_datavalues(&db_id, None, &sql, params, "dam_modules")
        .await
        .map_err(|e| crate::error::PortalError::business(format!("查询模块失败: {}", e)))?;
    let schema = ds.schema.as_ref();
    let mut out = Vec::new();
    for row in ds.iter() {
        let code = row_str(row, schema, "code");
        let domain_code = row_str(row, schema, "domain_code");
        let app_code = row_str(row, schema, "application_code");
        let tags_str = row_str(row, schema, "tags");
        let aliases: Vec<String> = if tags_str.is_empty() {
            Vec::new()
        } else {
            match serde_json::from_str::<Vec<String>>(&tags_str) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, tags = %tags_str, "cmx_module.tags 解析失败，按空别名处理");
                    Vec::new()
                }
            }
        };
        let resource_root = row_str(row, schema, "resource_root");
        let manifest_path = row_str(row, schema, "manifest_path");
        out.push(DamModule {
            db_id: row_str(row, schema, "id"),
            domain: domain_code,
            application: app_code.clone(),
            app: app_code,
            id: code.clone(),
            module: code,
            name: row_str(row, schema, "name"),
            title: row_str(row, schema, "title"),
            icon: row_str(row, schema, "icon"),
            status: row_status(row, schema),
            description: row_str(row, schema, "description"),
            resource_root,
            manifest_path,
            aliases,
            theme: row_str_opt(row, schema, "theme")
                .filter(|s| !s.is_empty())
                .map(|s| serde_json::json!({"name": s})),
            theme_color: row_str(row, schema, "theme_color"),
            sort_order: row_i32(row, schema, "sort_order"),
        });
    }
    Ok(out)
}
