//! 菜单页读取：每个菜单对应一个 `.json` 文件，支持点分命名空间映射到分层目录；
//! 另支持 `dam:<domain>/<app>[/<module>]` 形式从 DAM 注册表 + 模块 manifest 派生菜单。
//!
//! 复刻 Node `lib/menuPagesStore.js`：`parseMenuRef`（文件读）+ `getDamMenuPageJson`（DAM 派生）。

use std::collections::HashMap;

use cmx_core::model::cell::DataValue;
use serde_json::{Value, json};

use crate::dam::store::list_modules;
use crate::error::{PortalError, PortalResult};
use crate::meta::module_theme::resolve_module_theme;
use crate::meta::modules::load_module_manifest;
use crate::util::is_safe_segment;

/// 资源类型中文名（与 Node resourceCaption 一致，仅列常用）。
fn resource_caption(t: &str) -> &str {
    match t {
        "activities" => "活动入口",
        "menus" => "菜单",
        "htmlPages" => "HTML 页面",
        "htmlPageIndex" => "页面索引",
        "metaDefinitions" => "元数据定义",
        "flexibleCombinations" => "弹性组合",
        "dictRegistry" => "字典注册",
        "dictEntries" => "字典条目",
        "dictSeeds" => "字典种子",
        "facts" => "事实数据",
        "serviceCatalog" => "服务目录",
        "tools" => "工具",
        other => other,
    }
}

/// 从 DB 获取默认 DatabaseManager + db_id（与 `dam::store::db_handle` 同模式）。
async fn db_handle() -> PortalResult<(&'static cmx_database::DatabaseManager, String)> {
    let mm = cmx_database::get_default_db_manager();
    let db_id = mm.get_default_db_id().await;
    Ok((mm, db_id))
}

/// 解析点分 menuRef 前 3 段为 `(domain, application, module)`。
///
/// 段不足 3 或含非法字符返回 `None`（短 ref 不支持 DB 回源）。
fn parse_module_menu_ref(menu_ref: &str) -> Option<(&str, &str, &str)> {
    let segs: Vec<&str> = menu_ref.trim().split('.').collect();
    if segs.len() < 3 {
        return None;
    }
    for s in &segs[..3] {
        if s.is_empty() || !is_safe_segment(s) {
            return None;
        }
    }
    Some((segs[0], segs[1], segs[2]))
}

/// 从 `cmx_menu` 按 `domain/application/module` 查询并重建菜单页文档。
///
/// 行列直接映射为 ExplorerMenuNode（id←code, name←name, icon←icon, permissionId←fun_code,
/// children←parent_id 组装, _cmxId←id）；仅 `workspace`/`dialogspace`/`type`/`expanded`
/// 4 个富字段从 definition JSONB 取（表无独立列）。`caption` 直接用 name 列。
///
/// 输出 `{version:1, source:"db", items:[<ExplorerMenuNode>]}`，每个节点嵌入
/// `_cmxId`（`cmx_menu` 主键）供编辑弹框调 `/api/menu/update` 定位。
///
/// # Arguments
///
/// * `menu_ref` - 点分菜单引用（前 3 段为 domain/application/module）。
///
/// # Returns
///
/// 重建后的菜单 JSON 文档。
///
/// # Errors
///
/// `menu_ref` 段不足 3 返回 `bad_request`；数据库查询失败返回底层错误。
async fn get_menu_page_json_from_db(menu_ref: &str) -> PortalResult<Value> {
    let Some((domain, application, module)) = parse_module_menu_ref(menu_ref) else {
        return Err(PortalError::bad_request(format!(
            "DB 菜单引用需至少含 domain.application.module 三段：{menu_ref}"
        )));
    };
    let (mm, db_id) = db_handle().await?;
    let sql = "SELECT id, code, name, icon, fun_code, parent_id, definition \
               FROM cmx_menu WHERE domain_code = $1 AND application_code = $2 \
               AND module_code = $3 AND archived = 0 ORDER BY sort_order";
    let ds = mm
        .query_sql_with_datavalues(
            &db_id,
            None,
            sql,
            vec![
                DataValue::String(domain.to_string()),
                DataValue::String(application.to_string()),
                DataValue::String(module.to_string()),
            ],
            "menu_pages_db",
        )
        .await
        .map_err(|e| PortalError::business(format!("查询菜单失败: {e}")))?;

    let schema = ds.schema.as_ref();
    // pk -> 节点 JSON；parent pk -> 子 pk 列表（保留 sort_order 顺序）
    let mut nodes: HashMap<String, Value> = HashMap::new();
    let mut children_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut roots: Vec<String> = Vec::new();
    for row in ds.iter() {
        let pk: String = row.get_by_name_as(schema, "id").unwrap_or_default();
        let code: String = row.get_by_name_as(schema, "code").unwrap_or_default();
        let name: String = row.get_by_name_as(schema, "name").unwrap_or_default();
        let icon: Option<String> = row.get_by_name_as(schema, "icon");
        let fun_code: Option<String> = row.get_by_name_as(schema, "fun_code");
        let parent_id: Option<String> = row.get_by_name_as(schema, "parent_id");
        let definition: Value = row
            .get_by_name_as::<Value>(schema, "definition")
            .unwrap_or(Value::Null);
        let def_obj = definition.as_object();

        // 行列直接映射；caption 直接用 name 列（迁移数据中 caption 与 name 一致）
        let mut node = serde_json::Map::new();
        node.insert("id".into(), json!(code));
        node.insert("caption".into(), json!(name));
        if let Some(ic) = icon {
            node.insert("icon".into(), json!(ic));
        }
        if let Some(fc) = fun_code {
            node.insert("permissionId".into(), json!(fc));
        }
        // 仅 4 个富字段从 definition 取（表无独立列）
        if let Some(def) = def_obj {
            for k in ["workspace", "dialogspace", "expanded", "type"] {
                if let Some(v) = def.get(k) {
                    node.insert(k.into(), v.clone());
                }
            }
        }
        node.insert("_cmxId".into(), json!(pk));
        node.insert("children".into(), json!([]));

        match &parent_id {
            None => roots.push(pk.clone()),
            Some(pid) => children_of.entry(pid.clone()).or_default().push(pk.clone()),
        }
        nodes.insert(pk, Value::Object(node));
    }

    // 递归组装树（按 sort_order 顺序填充 children）
    fn assemble(
        pk: &str,
        nodes: &HashMap<String, Value>,
        children_of: &HashMap<String, Vec<String>>,
    ) -> Value {
        let mut node = nodes.get(pk).cloned().unwrap_or(Value::Null);
        if let Some(obj) = node.as_object_mut() {
            let children: Vec<Value> = children_of
                .get(pk)
                .map(|cs| cs.iter().map(|c| assemble(c, nodes, children_of)).collect())
                .unwrap_or_default();
            obj.insert("children".into(), Value::Array(children));
        }
        node
    }
    if roots.is_empty() {
        // 无数据：返回 NotFound，让 DAM 派生回退到资源菜单（与原菜单文件不存在行为一致）
        return Err(PortalError::not_found(format!(
            "菜单数据不存在：{menu_ref}"
        )));
    }
    let items: Vec<Value> = roots
        .iter()
        .map(|pk| assemble(pk, &nodes, &children_of))
        .collect();
    Ok(json!({ "version": 1, "source": "db", "items": items }))
}

/// 解析 `dam:<domain>/<app>[/<module>]`。
fn parse_dam_menu_ref(menu_name: &str) -> Option<(String, String, String)> {
    let ref_ = menu_name.trim();
    let rest = ref_.strip_prefix("dam:")?;
    let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let seg = |i: usize| parts.get(i).map(|s| s.to_string()).unwrap_or_default();
    let domain = seg(0);
    if domain.is_empty() || !is_safe_segment(&domain) {
        return None;
    }
    let app = seg(1);
    let module = seg(2);
    if !app.is_empty() && !is_safe_segment(&app) {
        return None;
    }
    if !module.is_empty() && !is_safe_segment(&module) {
        return None;
    }
    Some((domain, app, module))
}

/// 从 manifest.resources.menus 取第一个 menuRef / path。
fn first_menu_ref(manifest: &Value) -> String {
    let menus = manifest.get("resources").and_then(|r| r.get("menus"));
    let list: Vec<Value> = match menus {
        Some(Value::Array(a)) => a.clone(),
        Some(v @ Value::Object(_)) => vec![v.clone()],
        Some(Value::String(s)) => vec![json!({ "path": s })],
        _ => vec![],
    };
    for item in list {
        if let Some(mr) = item
            .get("menuRef")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return mr.to_string();
        }
        if let Some(p) = item
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return menu_ref_from_path(p);
        }
    }
    String::new()
}

/// 从资源 path（`menu-pages/<...>.json`）反推点分 menuRef。
fn menu_ref_from_path(entry_path: &str) -> String {
    let rel = entry_path
        .trim_start_matches('/')
        .strip_prefix("data/")
        .unwrap_or(entry_path.trim_start_matches('/'));
    let prefix = "menu-pages/";
    if !rel.starts_with(prefix) || !rel.ends_with(".json") {
        return String::new();
    }
    rel[prefix.len()..rel.len() - 5]
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

/// 从菜单文档取 items 数组。
fn menu_items_of(doc: &Value) -> Value {
    if doc.is_array() {
        doc.clone()
    } else if let Some(items) = doc.get("items").filter(|v| v.is_array()) {
        items.clone()
    } else {
        json!([])
    }
}

/// 用 manifest.resources 合成一棵资源菜单（无 menus 资源时的回退）。
fn build_dam_resource_menu(manifest: &Value) -> Value {
    let title = manifest
        .get("title")
        .or_else(|| manifest.get("name"))
        .or_else(|| manifest.get("module"))
        .and_then(|v| v.as_str())
        .unwrap_or("模块资源")
        .to_string();
    let domain = manifest
        .get("domain")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let application = manifest
        .get("application")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let module = manifest
        .get("module")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut types: Vec<String> = manifest
        .get("resources")
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    types.sort_by(|a, b| resource_caption(a).cmp(resource_caption(b)));
    let children: Vec<Value> = types
        .iter()
        .map(|t| {
            let cap = resource_caption(t);
            json!({
                "id": format!("resource-{t}"),
                "name": t,
                "caption": cap,
                "icon": "documents",
                "workspace": { "content": { "caption": cap, "icon": "documents", "views": [
                    { "tabLabel": "资源", "type": "json", "data": { "value": {
                        "domain": domain, "application": application, "module": module, "type": t,
                        "resources": manifest.get("resources").and_then(|r| r.get(t)).cloned().unwrap_or(json!([]))
                    }}}
                ]}}
            })
        })
        .collect();
    json!({
        "version": 1, "source": "dam",
        "items": [ { "id": format!("{domain}-{application}-{module}"), "name": module, "caption": title, "icon": "folder", "expanded": true, "children": children } ]
    })
}

/// 构建单模块菜单组。
///
/// # Arguments
///
/// * `domain` - 域标识。
/// * `application` - 应用标识。
/// * `module` - 模块标识。
/// * `registry_module` - DAM 注册表中的模块信息（可选，用于取 name/icon/theme）。
/// * `index` - 模块在列表中的序号（用于稳定配色）。
///
/// # Returns
///
/// 单模块菜单组 JSON（含 id/domain/application/module/title/icon/theme/items）。
///
/// # Errors
///
/// 加载模块 manifest 失败时返回底层错误（manifest 缺失时用空 manifest 兜底）。
async fn build_dam_module_group(
    domain: &str,
    application: &str,
    module: &str,
    registry_module: Option<&crate::dam::store::DamModule>,
    index: usize,
) -> PortalResult<Value> {
    let manifest = load_module_manifest(domain, application, module)
        .await
        .unwrap_or(json!({
            "domain": domain, "application": application, "module": module, "resources": {}
        }));
    let menu_ref = first_menu_ref(&manifest);
    let doc = if !menu_ref.is_empty() {
        // 递归读引用的菜单文件
        get_menu_page_json_inner(&menu_ref, 1)
            .await
            .unwrap_or_else(|_| build_dam_resource_menu(&manifest))
    } else {
        build_dam_resource_menu(&manifest)
    };
    let key = format!("{domain}/{application}/{module}");
    let theme_color = registry_module
        .map(|m| m.theme_color.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            manifest
                .get("themeColor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let raw_theme = registry_module
        .and_then(|m| m.theme.clone())
        .or_else(|| manifest.get("theme").filter(|v| v.is_object()).cloned());
    let theme = resolve_module_theme(&key, raw_theme.as_ref(), index, &theme_color);
    let title = registry_module
        .map(|m| {
            if !m.name.is_empty() {
                m.name.clone()
            } else if !m.title.is_empty() {
                m.title.clone()
            } else {
                m.id.clone()
            }
        })
        .filter(|s| !s.is_empty())
        .or_else(|| {
            manifest
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            manifest
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| module.to_string());
    let icon = registry_module
        .map(|m| m.icon.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            manifest
                .get("icon")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "folder".to_string());
    Ok(json!({
        "id": format!("{domain}-{application}-{module}"),
        "domain": domain, "application": application, "module": module,
        "title": title, "icon": icon, "theme": theme,
        "items": menu_items_of(&doc),
    }))
}

/// DAM 派生菜单文档（None 表示非 dam: 引用）。
///
/// # Arguments
///
/// * `menu_name` - 菜单引用，支持 `dam:<domain>/<app>[/<module>]` 形式。
///
/// # Returns
///
/// 非 `dam:` 前缀返回 `Ok(None)`；应用级返回聚合多模块的菜单文档；模块级返回单组菜单文档。
///
/// # Errors
///
/// `dam:` 引用缺少 application 或段非法时返回 `bad_request`；列举模块失败返回底层错误。
async fn get_dam_menu_page_json(menu_name: &str) -> PortalResult<Option<Value>> {
    let Some((domain, application, module)) = parse_dam_menu_ref(menu_name) else {
        return Ok(None);
    };
    if application.is_empty() {
        return Err(PortalError::bad_request(format!(
            "DAM 菜单引用需至少包含 domain/application：{menu_name}"
        )));
    }
    if module.is_empty() {
        // 应用级：列出该 app 下所有模块各成一组
        let modules = list_modules(Some(&domain), Some(&application), true).await?;
        let mut groups = Vec::new();
        for (i, m) in modules.iter().enumerate() {
            groups
                .push(build_dam_module_group(&m.domain, &m.application, &m.id, Some(m), i).await?);
        }
        return Ok(Some(json!({
            "version": 1, "source": "dam", "domain": domain, "application": application, "modules": groups
        })));
    }
    // 模块级：单组
    let modules = list_modules(Some(&domain), Some(&application), true).await?;
    let reg_mod = modules.iter().find(|m| m.id == module);
    let group = build_dam_module_group(&domain, &application, &module, reg_mod, 0).await?;
    Ok(Some(json!({
        "version": 1, "source": "dam", "domain": domain, "application": application, "modules": [group]
    })))
}

/// 内部读取实现（带递归深度保护，避免 menu->module->menu 循环）。
///
/// 返回 boxed future：async fn 自递归（经 build_dam_module_group）需要装箱。
///
/// # Arguments
///
/// * `menu_name` - 菜单引用（点分或 `dam:` 前缀）。
/// * `depth` - 递归深度，顶层为 0（仅顶层尝试 DAM 派生，递归只走文件）。
///
/// # Returns
///
/// 菜单 JSON 文档。
///
/// # Errors
///
/// `menu_name` 非法返回 `bad_request`；菜单文件不存在返回 `not_found`；读取失败返回底层错误。
fn get_menu_page_json_inner(
    menu_name: &str,
    depth: u8,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = PortalResult<Value>> + Send + '_>> {
    Box::pin(async move {
        if depth == 0 {
            // 顶层才尝试 DAM 派生；递归读引用菜单时只走 DB，避免无限递归
            if let Some(doc) = get_dam_menu_page_json(menu_name).await? {
                return Ok(doc);
            }
        }
        // 点分 menuRef：从 cmx_menu 数据库回源（替代原文件读取）
        get_menu_page_json_from_db(menu_name).await
    })
}

/// 读取菜单 JSON 文档（DAM 派生优先，回退文件）。
///
/// # Arguments
///
/// * `menu_name` - 菜单引用（点分或 `dam:<domain>/<app>[/<module>]`）。
///
/// # Returns
///
/// 菜单 JSON 文档（DAM 派生或文件读取）。
///
/// # Errors
///
/// `menu_name` 非法返回 `bad_request`；菜单不存在返回 `not_found`；读取失败返回底层错误。
pub async fn get_menu_page_json(menu_name: &str) -> PortalResult<serde_json::Value> {
    get_menu_page_json_inner(menu_name, 0).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_module_menu_ref_ok() {
        let (d, a, m) = parse_module_menu_ref("fi.cmxfico.gl.explorer-menu").unwrap();
        assert_eq!((d, a, m), ("fi", "cmxfico", "gl"));
    }

    #[test]
    fn parse_module_menu_ref_three_segs() {
        // 恰好 3 段也支持（无文件名后缀）
        let (d, a, m) = parse_module_menu_ref("fi.cmxfico.report").unwrap();
        assert_eq!((d, a, m), ("fi", "cmxfico", "report"));
    }

    #[test]
    fn parse_module_menu_ref_short() {
        assert!(parse_module_menu_ref("explorer-menu").is_none());
        assert!(parse_module_menu_ref("fi.cmxfico").is_none());
    }

    #[test]
    fn parse_module_menu_ref_unsafe() {
        assert!(parse_module_menu_ref("fi.cmx fico.gl").is_none());
    }
}
