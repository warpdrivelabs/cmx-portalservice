use super::*;

/// 列出 DAM/模块清单摘要。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、limit 字段。
///
/// # Returns
///
/// 返回含 items 数组的 JSON 对象。
///
/// # Errors
///
/// 当底层模块清单查询失败时返回 `PortalError`。
pub(crate) async fn list_modules_tool(args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 80, 200);
    let items =
        crate::meta::modules::list_module_manifests(opt_str(args, "domain"), app_arg(args)).await?;
    Ok(json!({ "items": items.into_iter().take(limit).collect::<Vec<_>>() }))
}

/// 读取指定模块的 module.json 清单。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 domain、app/application、module 字段。
///
/// # Returns
///
/// 返回模块清单 JSON 对象。
///
/// # Errors
///
/// 当缺少必要参数或加载清单失败时返回 `PortalError`。
pub(crate) async fn get_module_manifest_tool(args: &Value) -> PortalResult<Value> {
    let domain = opt_str(args, "domain").ok_or_else(|| bad("get_module_manifest 需要 domain"))?;
    let app = app_arg(args).ok_or_else(|| bad("get_module_manifest 需要 app/application"))?;
    let module = opt_str(args, "module").ok_or_else(|| bad("get_module_manifest 需要 module"))?;
    crate::meta::modules::load_module_manifest(domain, app, module).await
}

/// 解析模块指定类型资源并标注存在性。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 domain、app/application、module、type 字段。
///
/// # Returns
///
/// 返回资源解析结果的 JSON 对象。
///
/// # Errors
///
/// 当缺少必要参数或解析资源失败时返回 `PortalError`。
pub(crate) async fn get_module_resource_tool(args: &Value) -> PortalResult<Value> {
    let domain = opt_str(args, "domain").ok_or_else(|| bad("get_module_resource 需要 domain"))?;
    let app = app_arg(args).ok_or_else(|| bad("get_module_resource 需要 app/application"))?;
    let module = opt_str(args, "module").ok_or_else(|| bad("get_module_resource 需要 module"))?;
    let res_type = opt_str(args, "type").ok_or_else(|| bad("get_module_resource 需要 type"))?;
    crate::meta::modules::resolve_module_resource(domain, app, module, res_type).await
}

/// 列出字典 schema 注册表。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 limit 字段。
///
/// # Returns
///
/// 返回含 schemas 数组的 JSON 对象。
///
/// # Errors
///
/// 当底层 schema 查询失败时返回 `PortalError`。
pub(crate) async fn list_dict_schemas_tool(args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 200, 500);
    let schemas = crate::dict::schema::list_schemas_json().await?;
    let items = schemas
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(limit)
        .collect::<Vec<_>>();
    Ok(json!({ "schemas": items }))
}

/// 按字典 ID 检索字典项。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 dictId，可选 q/query、limit、body 字段。
///
/// # Returns
///
/// 返回字典搜索结果的 JSON 值。
///
/// # Errors
///
/// 当缺少 dictId 或底层搜索失败时返回 `PortalError`。
pub(crate) async fn dict_search_tool(args: &Value) -> PortalResult<Value> {
    let dict_id = opt_str(args, "dictId").ok_or_else(|| bad("dict_search 需要 dictId"))?;
    let mut body = args
        .get("body")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(q) = opt_str(args, "q").or_else(|| opt_str(args, "query")) {
        body.as_object_mut()
            .unwrap()
            .insert("q".to_string(), json!(q));
    }
    if let Some(limit) = args.get("limit").and_then(|v| v.as_u64()) {
        body.as_object_mut()
            .unwrap()
            .insert("limit".to_string(), json!(limit));
    }
    crate::dict::api::search_endpoint(dict_id, &body).await
}

/// 按字典 ID 获取输入建议。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 dictId，可选 q 字段。
///
/// # Returns
///
/// 返回字典建议结果的 JSON 值。
///
/// # Errors
///
/// 当缺少 dictId 或底层建议查询失败时返回 `PortalError`。
pub(crate) async fn dict_suggest_tool(args: &Value) -> PortalResult<Value> {
    let dict_id = opt_str(args, "dictId").ok_or_else(|| bad("dict_suggest 需要 dictId"))?;
    crate::dict::api::suggest_endpoint(dict_id, opt_str(args, "q").unwrap_or("")).await
}

/// 列出事实数据文件。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、limit 字段。
///
/// # Returns
///
/// 返回含 items 数组的 JSON 对象。
///
/// # Errors
///
/// 当底层事实数据查询失败时返回 `PortalError`。
pub(crate) async fn list_facts_tool(args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 100, 500);
    let q = crate::fact::store::FactQuery {
        domain: opt_str(args, "domain").map(str::to_string),
        app: app_arg(args).map(str::to_string),
        module: opt_str(args, "module").map(str::to_string),
    };
    let items = crate::fact::store::list_facts(&q).await?;
    let values = items
        .into_iter()
        .take(limit)
        .map(|x| serde_json::to_value(x).unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    Ok(json!({ "items": values }))
}

/// 读取指定事实数据 JSON。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 domain、app/application、module、file 字段。
///
/// # Returns
///
/// 返回事实数据 JSON 值。
///
/// # Errors
///
/// 当缺少必要参数或读取失败时返回 `PortalError`。
pub(crate) async fn get_fact_tool(args: &Value) -> PortalResult<Value> {
    let r = crate::fact::store::FactRef {
        domain: opt_str(args, "domain")
            .ok_or_else(|| bad("get_fact 需要 domain"))?
            .to_string(),
        app: app_arg(args)
            .ok_or_else(|| bad("get_fact 需要 app/application"))?
            .to_string(),
        module: opt_str(args, "module")
            .ok_or_else(|| bad("get_fact 需要 module"))?
            .to_string(),
        file: opt_str(args, "file")
            .ok_or_else(|| bad("get_fact 需要 file"))?
            .to_string(),
    };
    crate::fact::store::get_fact(&r).await
}

/// 列出服务目录摘要。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、limit 字段。
///
/// # Returns
///
/// 返回含 services 数组的 JSON 对象。
///
/// # Errors
///
/// 当底层服务目录查询失败时返回 `PortalError`。
pub(crate) async fn service_catalog_list_tool(args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 80, 200);
    let services = crate::service_catalog::store::list_services(
        opt_str(args, "domain"),
        app_arg(args),
        opt_str(args, "module"),
    )
    .await?;
    Ok(json!({ "services": services.into_iter().take(limit).collect::<Vec<_>>() }))
}

/// 读取指定服务目录详情。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 `id` 字段。
///
/// # Returns
///
/// 返回服务详情 JSON 对象。
///
/// # Errors
///
/// 当缺少 id 或服务不存在时返回 `PortalError`。
pub(crate) async fn service_catalog_get_tool(args: &Value) -> PortalResult<Value> {
    let id = opt_str(args, "id").ok_or_else(|| bad("service_catalog_get 需要 id"))?;
    match crate::service_catalog::store::get_service_by_id(id).await? {
        Some(svc) => Ok(svc),
        None => Err(PortalError::not_found(format!("服务不存在：{id}"))),
    }
}

/// 列出弹性组合。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、limit 字段。
///
/// # Returns
///
/// 返回含 items 数组的 JSON 对象。
///
/// # Errors
///
/// 当底层弹性组合查询失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_list_tool(args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 80, 200);
    let items = crate::flexible_combination::store::list_flexible_combinations(
        opt_str(args, "domain"),
        app_arg(args),
        opt_str(args, "module"),
    )
    .await?;
    Ok(json!({ "items": items.into_iter().take(limit).collect::<Vec<_>>() }))
}

/// 读取指定弹性组合。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、scenario 字段。
///
/// # Returns
///
/// 返回弹性组合 JSON 对象。
///
/// # Errors
///
/// 当底层弹性组合查询失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_get_tool(args: &Value) -> PortalResult<Value> {
    crate::flexible_combination::store::get_flexible_combination(&fc_ref_from_args(args)).await
}

/// 校验弹性组合配置。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 combination、domain、app/application、module、scenario 字段。
///
/// # Returns
///
/// 返回校验结果的 JSON 值。
///
/// # Errors
///
/// 当底层校验失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_validate_tool(args: &Value) -> PortalResult<Value> {
    let body = args
        .get("combination")
        .cloned()
        .unwrap_or_else(|| json!({}));
    crate::flexible_combination::api::validate(&body, &fc_ref_from_args(args)).await
}

/// 预览弹性组合解析结果。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 combination、anchor、domain、app/application、module、scenario 字段。
///
/// # Returns
///
/// 返回预览结果的 JSON 值。
///
/// # Errors
///
/// 当底层预览失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_preview_tool(args: &Value) -> PortalResult<Value> {
    let mut body = args
        .get("combination")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(anchor) = args.get("anchor").filter(|v| v.is_object()) {
        if !body.is_object() {
            body = json!({});
        }
        body.as_object_mut()
            .unwrap()
            .insert("anchor".to_string(), anchor.clone());
    }
    crate::flexible_combination::api::preview(&body, &fc_ref_from_args(args)).await
}

/// 按锚点解析弹性组合字段/列模型。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、scenario、anchor 字段。
///
/// # Returns
///
/// 返回解析结果的 JSON 值。
///
/// # Errors
///
/// 当底层解析失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_resolve_tool(args: &Value) -> PortalResult<Value> {
    crate::flexible_combination::api::resolve(&fc_ref_from_args(args), &anchor_from_args(args))
        .await
}

/// 按锚点获取命中的上下文规则。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 domain、app/application、module、scenario、anchor 字段。
///
/// # Returns
///
/// 返回命中规则的 JSON 值。
///
/// # Errors
///
/// 当底层规则查询失败时返回 `PortalError`。
pub(crate) async fn flexible_combination_rule_tool(args: &Value) -> PortalResult<Value> {
    crate::flexible_combination::api::rule(&fc_ref_from_args(args), &anchor_from_args(args)).await
}

/// validate_metadata：递归校验 JSON 可解析性。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 `path` 字段指定目标文件或目录。
///
/// # Returns
///
/// 返回含 checked（检查文件数）和 errors（诊断列表）的 JSON 对象。
///
/// # Errors
///
/// 当路径越界或遍历目录发生 IO 错误时返回 `PortalError`。
pub(crate) async fn validate_metadata(root: &Path, args: &Value) -> PortalResult<Value> {
    let target = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => resolve_inside_root(root, p)?,
        _ => root
            .join("cmx-node-server")
            .join("data")
            .join("meta")
            .join("definitions"),
    };
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![target];
    while let Some(p) = stack.pop() {
        let meta = match tokio::fs::metadata(&p).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_file() {
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                files.push(p);
            }
        } else if meta.is_dir() {
            let mut rd = match tokio::fs::read_dir(&p).await {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                stack.push(entry.path());
            }
        }
    }
    let mut diagnostics: Vec<Value> = Vec::new();
    for file in files.iter().take(200) {
        if let Ok(content) = tokio::fs::read_to_string(file).await
            && let Err(e) = serde_json::from_str::<Value>(&content)
        {
            diagnostics
                .push(json!({ "file": relative_from_root(root, file), "error": e.to_string() }));
        }
    }
    Ok(json!({ "checked": files.len(), "errors": diagnostics }))
}
