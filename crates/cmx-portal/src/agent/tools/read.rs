use super::*;

/// 读取项目内指定文件内容。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 `path` 字段。
///
/// # Returns
///
/// 返回含 path、bytes、content 的 JSON 对象。
///
/// # Errors
///
/// 当路径越界、目标非文件、文件过大或读取失败时返回 `PortalError`。
pub(crate) async fn read_file(root: &Path, args: &Value) -> PortalResult<Value> {
    let p = resolve_inside_root(
        root,
        args.get("path").and_then(|v| v.as_str()).unwrap_or(""),
    )?;
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|_| bad("只能读取文件"))?;
    if !meta.is_file() {
        return Err(bad("只能读取文件"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(bad(format!("文件过大，当前限制 {MAX_FILE_BYTES} bytes")));
    }
    let content = tokio::fs::read_to_string(&p)
        .await
        .map_err(PortalError::Io)?;
    Ok(json!({ "path": relative_from_root(root, &p), "bytes": meta.len(), "content": content }))
}

/// list_definitions：复用 definitions store。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 kind、domain、module、limit 字段。
///
/// # Returns
///
/// 返回定义摘要列表的 JSON 数组。
///
/// # Errors
///
/// 当底层 store 查询失败时返回 `PortalError`。
pub(crate) async fn list_definitions(args: &Value) -> PortalResult<Value> {
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_uppercase());
    let domain = args.get("domain").and_then(|v| v.as_str());
    let module = args.get("module").and_then(|v| v.as_str());
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(60)
        .clamp(1, 100) as usize;
    let items =
        crate::definitions::store::list_definitions(kind.as_deref(), domain, None, module).await?;
    Ok(Value::Array(items.into_iter().take(limit).collect()))
}

/// list_html_pages：复用 html store（裁剪字段）。
///
/// # Arguments
///
/// * `args` - 工具参数，可选 page、pageSize/limit、domain、app、module 字段。
///
/// # Returns
///
/// 返回分页 HTML 页面摘要 JSON 对象，items 中每项仅保留 id、name 等裁剪字段。
///
/// # Errors
///
/// 当底层 html store 查询失败时返回 `PortalError`。
pub(crate) async fn list_html_pages(args: &Value) -> PortalResult<Value> {
    let page = args
        .get("page")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        .max(1);
    let page_size = args
        .get("pageSize")
        .or_else(|| args.get("limit"))
        .and_then(|v| v.as_i64())
        .unwrap_or(20)
        .clamp(1, 50);
    let domain = args.get("domain").and_then(|v| v.as_str());
    let app = args.get("app").and_then(|v| v.as_str());
    let module = args.get("module").and_then(|v| v.as_str());
    let keyword = args.get("keyword").and_then(|v| v.as_str());
    let out = crate::pages::html::list_html_pages_paged(
        Some(page),
        Some(page_size),
        domain,
        app,
        module,
        keyword,
    )
    .await?;
    // 裁剪 items 字段
    let items: Vec<Value> = out
        .get("items")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|it| {
                    json!({
                        "id": it.get("id"), "name": it.get("name"), "details": it.get("details"),
                        "domain": it.get("domain"), "app": it.get("app"), "module": it.get("module"),
                        "relPath": it.get("relPath"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut res = out;
    res.as_object_mut()
        .unwrap()
        .insert("items".to_string(), Value::Array(items));
    Ok(res)
}

/// read_html_page：复用 html store（截断 html 到 24000 字符）。
///
/// # Arguments
///
/// * `args` - 工具参数，需包含 `id` 字段。
///
/// # Returns
///
/// 返回含 id、name、html（截断）等字段的 JSON 对象。
///
/// # Errors
///
/// 当缺少 id 或页面不存在时返回 `PortalError`。
pub(crate) async fn read_html_page(args: &Value) -> PortalResult<Value> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err(bad("read_html_page 需要 id"));
    }
    let page = crate::pages::html::get_html_page_by_id(&id).await?;
    let html = page.get("html").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = html.len();
    let truncated: String = html.chars().take(24000).collect();
    Ok(json!({
        "id": page.get("id"), "name": page.get("name"), "details": page.get("details"),
        "domain": page.get("domain"), "app": page.get("app"), "module": page.get("module"),
        "relPath": page.get("relPath"), "bytes": bytes, "html": truncated,
    }))
}
