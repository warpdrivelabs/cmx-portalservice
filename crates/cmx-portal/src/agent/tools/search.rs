use super::*;

/// search_files：优先 ripgrep（若可用），回退目录遍历。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 `query` 字段，可选 `limit` 字段。
///
/// # Returns
///
/// 返回匹配文件列表的 JSON 数组，每项含 file、line、text 字段。
///
/// # Errors
///
/// 当缺少 query 参数或遍历目录发生 IO 错误时返回 `PortalError`。
pub(crate) async fn search_files(root: &Path, args: &Value) -> PortalResult<Value> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Err(bad("search_files 需要 query"));
    }
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 50) as usize;
    // 直接走目录遍历（不依赖外部 rg，跨平台稳定）
    let results = walk_search(root, &query, limit).await?;
    Ok(Value::Array(results))
}

/// 递归遍历目录搜索文本文件中匹配查询关键词的行。
///
/// 跳过 node_modules、dist、.git、target 目录，仅搜索文本扩展名文件。
async fn walk_search(root: &Path, query: &str, limit: usize) -> PortalResult<Vec<Value>> {
    let q = query.to_lowercase();
    let skip = ["node_modules", "dist", ".git", "target"];
    let mut out: Vec<Value> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
            if out.len() >= limit {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if skip.contains(&name.as_str()) {
                continue;
            }
            let ft = entry.file_type().await.map_err(PortalError::Io)?;
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() && has_text_ext(&name) {
                if name.to_lowercase().contains(&q) {
                    out.push(json!({ "file": relative_from_root(root, &entry.path()), "line": 1, "text": "文件名匹配" }));
                    continue;
                }
                let content = match tokio::fs::read_to_string(entry.path()).await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if let Some((idx, line)) = content
                    .lines()
                    .enumerate()
                    .find(|(_, l)| l.to_lowercase().contains(&q))
                {
                    let text: String = line.trim().chars().take(240).collect();
                    out.push(json!({ "file": relative_from_root(root, &entry.path()), "line": idx + 1, "text": text }));
                }
            }
        }
    }
    Ok(out)
}
