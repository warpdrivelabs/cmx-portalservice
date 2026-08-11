use super::*;

/// 扫描本地插件 manifest / mcpdata / .agents 目录。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 limit 字段。
///
/// # Returns
///
/// 返回含 plugins 数组的 JSON 对象，每项含 path、pluginId、name、version 等字段。
///
/// # Errors
///
/// 当遍历目录发生 IO 错误时返回 `PortalError`。
pub(crate) async fn list_local_plugins(root: &Path, args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 80, 300);
    let mut items = Vec::new();
    let mut stack = vec![repo_root(root)];
    let skip = ["target", "node_modules", ".git", "dist"];
    while let Some(dir) = stack.pop() {
        if items.len() >= limit {
            break;
        }
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
            if items.len() >= limit {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if skip.contains(&name.as_str()) {
                continue;
            }
            let ft = entry.file_type().await.map_err(PortalError::Io)?;
            if ft.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !ft.is_file() || name != "manifest.json" {
                continue;
            }
            let path = entry.path();
            let content = match tokio::fs::read_to_string(&path).await {
                Ok(c) => c,
                Err(_) => continue,
            };
            let doc: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
            let parent = path.parent().unwrap_or(&path);
            let has_mcpdata = parent.join("mcpdata").exists();
            let has_agents = parent.join(".agents").exists();
            items.push(json!({
                "path": relative_from_root(root, &path),
                "pluginId": doc.get("plugin_id").or_else(|| doc.get("pluginId")).or_else(|| doc.get("id")),
                "name": doc.get("name"),
                "version": doc.get("version"),
                "hasMcpData": has_mcpdata,
                "hasAgents": has_agents,
            }));
        }
    }
    Ok(json!({ "plugins": items }))
}

/// 读取本地插件 manifest.json。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需提供 path 或 pluginId 字段。
///
/// # Returns
///
/// 返回含 path 和 manifest 的 JSON 对象。
///
/// # Errors
///
/// 当缺少参数、插件未找到或文件读取失败时返回 `PortalError`。
pub(crate) async fn inspect_plugin_manifest(root: &Path, args: &Value) -> PortalResult<Value> {
    if let Some(path) = opt_str(args, "path") {
        return super::read::read_file(root, &json!({ "path": path }))
            .await
            .and_then(|v| {
                let content = v.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let manifest: Value = serde_json::from_str(content)?;
                Ok(json!({ "path": v.get("path"), "manifest": manifest }))
            });
    }
    let plugin_id = opt_str(args, "pluginId")
        .ok_or_else(|| bad("inspect_plugin_manifest 需要 path 或 pluginId"))?;
    let list = list_local_plugins(root, &json!({ "limit": 300 })).await?;
    let hit = list
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|p| {
                p.get("pluginId")
                    .map(|v| {
                        v.as_str().map(|s| s == plugin_id).unwrap_or_else(|| {
                            v.get("plugin_id").and_then(|x| x.as_str()) == Some(plugin_id)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .and_then(|p| p.get("path").and_then(|v| v.as_str()))
        .ok_or_else(|| PortalError::not_found(format!("未找到插件 manifest：{plugin_id}")))?;
    super::read::read_file(root, &json!({ "path": hit }))
        .await
        .and_then(|v| {
            let content = v.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let manifest: Value = serde_json::from_str(content)?;
            Ok(json!({ "path": v.get("path"), "manifest": manifest }))
        })
}

/// 声明插件函数调用能力（当前返回占位响应，需运行时桥接后启用）。
///
/// # Arguments
///
/// * `_root` - 项目根目录（未使用）。
/// * `args` - 工具参数，需包含 pluginId、functionName，可选 serviceName、input 字段。
///
/// # Returns
///
/// 返回含 configured=false 的占位 JSON 对象。
///
/// # Errors
///
/// 当缺少 pluginId 或 functionName 时返回 `PortalError`。
pub(crate) async fn call_plugin_function_tool(_root: &Path, args: &Value) -> PortalResult<Value> {
    let plugin_id =
        opt_str(args, "pluginId").ok_or_else(|| bad("call_plugin_function 需要 pluginId"))?;
    let function_name = opt_str(args, "functionName")
        .ok_or_else(|| bad("call_plugin_function 需要 functionName"))?;
    Ok(json!({
        "configured": false,
        "pluginId": plugin_id,
        "functionName": function_name,
        "serviceName": opt_str(args, "serviceName"),
        "input": args.get("input").cloned().unwrap_or(Value::Null),
        "message": "cmx-portal Agent 工具已声明该能力，但当前 crate 未持有 RuntimeInvoker/ServiceOrchestrationClient 句柄；需要在 API/AppState 层注入运行时桥接后启用真实调用。",
    }))
}

/// 声明服务编排流程调用能力（当前返回占位响应，需注入客户端后启用）。
///
/// # Arguments
///
/// * `_root` - 项目根目录（未使用）。
/// * `args` - 工具参数，需包含 serviceKey，可选 serviceName、input、timeoutMs 字段。
///
/// # Returns
///
/// 返回含 configured=false 的占位 JSON 对象。
///
/// # Errors
///
/// 当缺少 serviceKey 时返回 `PortalError`。
pub(crate) async fn call_service_flow_tool(_root: &Path, args: &Value) -> PortalResult<Value> {
    let service_key =
        opt_str(args, "serviceKey").ok_or_else(|| bad("call_service_flow 需要 serviceKey"))?;
    Ok(json!({
        "configured": false,
        "serviceKey": service_key,
        "serviceName": opt_str(args, "serviceName"),
        "input": args.get("input").cloned().unwrap_or(Value::Null),
        "message": "cmx-portal Agent 工具已声明该能力，但当前 crate 未持有服务编排客户端；需要在 API/AppState 层注入 ServiceOrchestrationClient 后启用真实调用。",
    }))
}

/// 生成服务编排 API 文档（当前返回占位响应，需插件运行时上下文）。
///
/// # Arguments
///
/// * `_root` - 项目根目录（未使用）。
/// * `args` - 工具参数，可选 pluginId、version、orchestration、installPath 字段。
///
/// # Returns
///
/// 返回含 configured=false 的占位 JSON 对象。
///
/// # Errors
///
/// 该函数当前不返回错误（始终返回占位 JSON）。
pub(crate) async fn generate_api_doc_tool(_root: &Path, args: &Value) -> PortalResult<Value> {
    Ok(json!({
        "configured": false,
        "pluginId": opt_str(args, "pluginId"),
        "version": opt_str(args, "version"),
        "hasOrchestration": args.get("orchestration").is_some(),
        "installPath": opt_str(args, "installPath"),
        "message": "cmx-plugin::ApiDocGenerator 需要 PluginQuery、插件安装根目录和 ServiceOrchestration 上下文；当前 agent 工具入口已预留，后续应在持有插件管理器的层完成桥接。",
    }))
}
