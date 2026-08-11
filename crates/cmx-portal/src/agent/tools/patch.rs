use super::*;

// ── lineDiff（复刻 Node lineDiff）─────────────────────────────────

/// 生成简易行级 diff（前后各保留 3 行上下文）。
///
/// # Arguments
///
/// * `before` - 修改前的文本。
/// * `after` - 修改后的文本。
///
/// # Returns
///
/// 返回 unified diff 风格的差异字符串。
pub(crate) fn line_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end_a = a.len() as isize - 1;
    let mut end_b = b.len() as isize - 1;
    while end_a >= start as isize
        && end_b >= start as isize
        && a[end_a as usize] == b[end_b as usize]
    {
        end_a -= 1;
        end_b -= 1;
    }
    let from = start.saturating_sub(3);
    let to_a = ((end_a + 3).max(0) as usize).min(a.len().saturating_sub(1));
    let to_b = ((end_b + 3).max(0) as usize).min(b.len().saturating_sub(1));
    let mut out: Vec<String> = Vec::new();
    out.push(format!(
        "@@ {},{} -> {},{} @@",
        from + 1,
        (to_a as isize - from as isize + 1).max(0),
        from + 1,
        (to_b as isize - from as isize + 1).max(0)
    ));
    let max = to_a.max(to_b);
    let change_end = (end_a.max(end_b)).max(0) as usize;
    for i in from..=max {
        let old_line = if i <= to_a { Some(a[i]) } else { None };
        let new_line = if i <= to_b { Some(b[i]) } else { None };
        if i < start || i > change_end {
            if let Some(ol) = old_line {
                out.push(format!(" {ol}"));
            }
            continue;
        }
        if old_line == new_line {
            if let Some(ol) = old_line {
                out.push(format!(" {ol}"));
            }
        } else {
            if let Some(ol) = old_line {
                out.push(format!("-{ol}"));
            }
            if let Some(nl) = new_line {
                out.push(format!("+{nl}"));
            }
        }
    }
    out.join("\n")
}

// ── JSON Pointer（复刻 setJsonPointer）────────────────────────────

/// 将 JSON Pointer 字符串拆分为已反转义的路径段列表。
fn json_pointer_parts(pointer: &str) -> PortalResult<Vec<String>> {
    let p = pointer.trim();
    if !p.starts_with('/') {
        return Err(bad("JSON Pointer 必须以 / 开头"));
    }
    Ok(p.split('/')
        .skip(1)
        .map(|seg| seg.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// 按 JSON Pointer 在文档中写入指定值，自动补建中间节点。
fn set_json_pointer(doc: &mut Value, pointer: &str, value: Value) -> PortalResult<()> {
    let parts = json_pointer_parts(pointer)?;
    if parts.is_empty() {
        *doc = value;
        return Ok(());
    }
    let mut cur = doc;
    for i in 0..parts.len() - 1 {
        let key = &parts[i];
        let next_is_index = parts[i + 1].chars().all(|c| c.is_ascii_digit());
        match cur {
            Value::Object(obj) => {
                if !obj.contains_key(key) {
                    obj.insert(
                        key.clone(),
                        if next_is_index { json!([]) } else { json!({}) },
                    );
                }
                cur = obj.get_mut(key).unwrap();
            }
            Value::Array(arr) => {
                let idx: usize = key.parse().map_err(|_| {
                    bad(format!(
                        "JSON Pointer 数组下标非法：/{}",
                        parts[..=i].join("/")
                    ))
                })?;
                if idx >= arr.len() {
                    return Err(bad(format!(
                        "JSON Pointer 中间节点不存在：/{}",
                        parts[..=i].join("/")
                    )));
                }
                cur = &mut arr[idx];
            }
            _ => {
                return Err(bad(format!(
                    "JSON Pointer 中间节点不存在：/{}",
                    parts[..=i].join("/")
                )));
            }
        }
    }
    let last = &parts[parts.len() - 1];
    match cur {
        Value::Object(obj) => {
            obj.insert(last.clone(), value);
            Ok(())
        }
        Value::Array(arr) => {
            if last == "-" {
                arr.push(value);
                return Ok(());
            }
            let idx: usize = last
                .parse()
                .map_err(|_| bad(format!("JSON Pointer 父节点不可写：{pointer}")))?;
            if idx < arr.len() {
                arr[idx] = value;
            } else if idx == arr.len() {
                arr.push(value);
            } else {
                return Err(bad(format!("JSON Pointer 数组下标越界：{pointer}")));
            }
            Ok(())
        }
        _ => Err(bad(format!("JSON Pointer 父节点不可写：{pointer}"))),
    }
}

// ── 补丁预览/应用 ────────────────────────────────────────────────

/// 文本替换补丁预览（不写盘）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path、oldText、newText，可选 occurrence 字段。
///
/// # Returns
///
/// 返回含 path、oldText、newText、occurrence、replacements、before、after、diff 的 JSON 对象。
///
/// # Errors
///
/// 当路径越界、文件过大、未找到文本或替换过多时返回 `PortalError`。
pub(crate) async fn prepare_text_replace(root: &Path, args: &Value) -> PortalResult<Value> {
    let p = resolve_inside_root(
        root,
        args.get("path").and_then(|v| v.as_str()).unwrap_or(""),
    )?;
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|_| bad("只能修改文件"))?;
    if !meta.is_file() {
        return Err(bad("只能修改文件"));
    }
    if meta.len() > MAX_PATCH_BYTES {
        return Err(bad(format!(
            "文件过大，当前补丁限制 {MAX_PATCH_BYTES} bytes"
        )));
    }
    let old_text = args
        .get("oldText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let new_text = args
        .get("newText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if old_text.is_empty() {
        return Err(bad("文本替换补丁需要 oldText"));
    }
    let before = tokio::fs::read_to_string(&p)
        .await
        .map_err(PortalError::Io)?;
    let count = before.matches(&old_text).count();
    if count == 0 {
        return Err(bad("未找到要替换的文本"));
    }
    let occurrence = if args.get("occurrence").and_then(|v| v.as_str()) == Some("all") {
        "all"
    } else {
        "first"
    };
    if occurrence == "all" && count > MAX_TEXT_REPLACEMENTS {
        return Err(bad(format!(
            "匹配过多，当前限制 {MAX_TEXT_REPLACEMENTS} 处"
        )));
    }
    let replacements = if occurrence == "all" {
        count.min(MAX_TEXT_REPLACEMENTS)
    } else {
        1
    };
    let after = if occurrence == "all" {
        before.replace(&old_text, &new_text)
    } else {
        before.replacen(&old_text, &new_text, 1)
    };
    Ok(json!({
        "path": relative_from_root(root, &p), "oldText": old_text, "newText": new_text,
        "occurrence": occurrence, "replacements": replacements,
        "before": before, "after": after, "diff": line_diff(&before, &after),
    }))
}

/// 应用文本替换补丁（写盘）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path、oldText、newText，可选 occurrence 字段。
///
/// # Returns
///
/// 返回含 path、occurrence、replacements、bytes、diff 的 JSON 对象。
///
/// # Errors
///
/// 当预览失败或写盘发生 IO 错误时返回 `PortalError`。
pub(crate) async fn apply_text_replace(root: &Path, args: &Value) -> PortalResult<Value> {
    let preview = prepare_text_replace(root, args).await?;
    let rel = preview.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let after = preview.get("after").and_then(|v| v.as_str()).unwrap_or("");
    let abs = resolve_inside_root(root, rel)?;
    tokio::fs::write(&abs, after)
        .await
        .map_err(PortalError::Io)?;
    Ok(json!({
        "path": rel, "occurrence": preview.get("occurrence"), "replacements": preview.get("replacements"),
        "bytes": after.len(), "diff": preview.get("diff"),
    }))
}

/// JSON 补丁预览。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path、pointer、value 字段。
///
/// # Returns
///
/// 返回含 path、pointer、value、before、after、diff 的 JSON 对象。
///
/// # Errors
///
/// 当路径越界、文件过大、JSON 解析失败或指针写入失败时返回 `PortalError`。
pub(crate) async fn prepare_json_patch(root: &Path, args: &Value) -> PortalResult<Value> {
    let p = resolve_inside_root(
        root,
        args.get("path").and_then(|v| v.as_str()).unwrap_or(""),
    )?;
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|_| bad("只能修改文件"))?;
    if !meta.is_file() {
        return Err(bad("只能修改文件"));
    }
    if meta.len() > MAX_PATCH_BYTES {
        return Err(bad(format!(
            "文件过大，当前补丁限制 {MAX_PATCH_BYTES} bytes"
        )));
    }
    let before = tokio::fs::read_to_string(&p)
        .await
        .map_err(PortalError::Io)?;
    let mut doc: Value =
        serde_json::from_str(&before).map_err(|_| bad("当前仅支持可解析的 JSON 文件补丁"))?;
    let pointer = args.get("pointer").and_then(|v| v.as_str()).unwrap_or("");
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    set_json_pointer(&mut doc, pointer, value.clone())?;
    let after = format!("{}\n", serde_json::to_string_pretty(&doc)?);
    Ok(json!({
        "path": relative_from_root(root, &p), "pointer": pointer, "value": value,
        "before": before, "after": after, "diff": line_diff(&before, &after),
    }))
}

/// 应用 JSON 补丁（写盘）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path、pointer、value 字段。
///
/// # Returns
///
/// 返回含 path、pointer、bytes、diff 的 JSON 对象。
///
/// # Errors
///
/// 当预览失败或写盘发生 IO 错误时返回 `PortalError`。
pub(crate) async fn apply_json_patch(root: &Path, args: &Value) -> PortalResult<Value> {
    let preview = prepare_json_patch(root, args).await?;
    let rel = preview.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let after = preview.get("after").and_then(|v| v.as_str()).unwrap_or("");
    let abs = resolve_inside_root(root, rel)?;
    tokio::fs::write(&abs, after)
        .await
        .map_err(PortalError::Io)?;
    Ok(
        json!({ "path": rel, "pointer": preview.get("pointer"), "bytes": after.len(), "diff": preview.get("diff") }),
    )
}

/// 创建文本文件。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path、content，可选 overwrite 字段。
///
/// # Returns
///
/// 返回含 path、bytes、created 的 JSON 对象。
///
/// # Errors
///
/// 当路径越界、文件已存在且未设置 overwrite、内容过大或写盘失败时返回 `PortalError`。
pub(crate) async fn create_file(root: &Path, args: &Value) -> PortalResult<Value> {
    let path = opt_str(args, "path").ok_or_else(|| bad("create_file 需要 path"))?;
    let abs = resolve_inside_root(root, path)?;
    if tokio::fs::metadata(&abs).await.is_ok()
        && !args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    {
        return Err(bad("目标文件已存在；如需覆盖请设置 overwrite=true"));
    }
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PortalError::Io)?;
    }
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.len() as u64 > MAX_PATCH_BYTES {
        return Err(bad(format!(
            "文件内容过大，当前限制 {MAX_PATCH_BYTES} bytes"
        )));
    }
    tokio::fs::write(&abs, content)
        .await
        .map_err(PortalError::Io)?;
    Ok(json!({ "path": relative_from_root(root, &abs), "bytes": content.len(), "created": true }))
}

/// 重命名/移动文件。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 from、to 字段。
///
/// # Returns
///
/// 返回含 from、to、renamed 的 JSON 对象。
///
/// # Errors
///
/// 当路径越界、源文件不存在、目标已存在或重命名失败时返回 `PortalError`。
pub(crate) async fn rename_file(root: &Path, args: &Value) -> PortalResult<Value> {
    let from = resolve_inside_root(
        root,
        opt_str(args, "from").ok_or_else(|| bad("rename_file 需要 from"))?,
    )?;
    let to = resolve_inside_root(
        root,
        opt_str(args, "to").ok_or_else(|| bad("rename_file 需要 to"))?,
    )?;
    let meta = tokio::fs::metadata(&from)
        .await
        .map_err(|_| bad("源文件不存在"))?;
    if !meta.is_file() {
        return Err(bad("当前仅允许移动文件"));
    }
    if tokio::fs::metadata(&to).await.is_ok() {
        return Err(bad("目标路径已存在"));
    }
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PortalError::Io)?;
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(PortalError::Io)?;
    Ok(
        json!({ "from": relative_from_root(root, &from), "to": relative_from_root(root, &to), "renamed": true }),
    )
}

/// 应用 unified diff patch（stdin 传给 git apply）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 patch 字段。
///
/// # Returns
///
/// 返回含 applied、check、result 的 JSON 对象。
///
/// # Errors
///
/// 当 patch 为空、过大或 git apply 执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn apply_file_patch(root: &Path, args: &Value) -> PortalResult<Value> {
    let patch = args.get("patch").and_then(|v| v.as_str()).unwrap_or("");
    if patch.trim().is_empty() {
        return Err(bad("apply_file_patch 需要 patch"));
    }
    if patch.len() as u64 > MAX_PATCH_BYTES * 4 {
        return Err(bad("patch 过大"));
    }
    let cwd = repo_root(root);
    // 把 git apply 可改写范围钉死在 rootDir 内：追加 --directory=<root 相对 repo_root 的路径>。
    // 这样 patch 内若含 `../` 或绝对路径前缀，git 会拒绝应用，阻止越界写。
    // root 即是 repo_root 时退化为 `.`（cwd 本身）。
    let dir_arg = match root.strip_prefix(&cwd) {
        Ok(rel) if !rel.as_os_str().is_empty() => {
            format!("--directory={}", rel.to_string_lossy().replace('\\', "/"))
        }
        _ => {
            tracing::warn!(
                root = %root.display(),
                repo_root = %cwd.display(),
                "apply_file_patch 无法计算相对目录，未施加 --directory 限制"
            );
            "--directory=.".to_string()
        }
    };
    let check = run_process_with_stdin(
        &cwd,
        "git",
        &["apply".to_string(), "--check".to_string(), dir_arg.clone()],
        patch,
        60_000,
    )
    .await?;
    if check.get("exitCode").and_then(|v| v.as_i64()) != Some(0) {
        return Ok(json!({ "applied": false, "check": check }));
    }
    let result = run_process_with_stdin(
        &cwd,
        "git",
        &[
            "apply".to_string(),
            "--whitespace=nowarn".to_string(),
            dir_arg,
        ],
        patch,
        60_000,
    )
    .await?;
    Ok(
        json!({ "applied": result.get("exitCode").and_then(|v| v.as_i64()) == Some(0), "check": check, "result": result }),
    )
}

/// 格式化单个文件。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 path，可选 timeoutMs 字段。
///
/// # Returns
///
/// 返回格式化命令的执行结果 JSON 对象。
///
/// # Errors
///
/// 当路径越界、扩展名不支持或格式化命令执行失败时返回 `PortalError`。
pub(crate) async fn format_file(root: &Path, args: &Value) -> PortalResult<Value> {
    let path = opt_str(args, "path").ok_or_else(|| bad("format_file 需要 path"))?;
    let abs = resolve_inside_root(root, path)?;
    let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("");
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(60_000);
    if ext == "rs" {
        run_process(
            &cargo_root(root),
            "rustfmt",
            &[abs.to_string_lossy().to_string()],
            timeout_ms,
        )
        .await
    } else if ["js", "ts", "json", "css", "html", "md"].contains(&ext) {
        run_process(
            &npm_root(root),
            "npx",
            &[
                "prettier".to_string(),
                "--write".to_string(),
                abs.to_string_lossy().to_string(),
            ],
            timeout_ms,
        )
        .await
    } else {
        Err(bad(format!("暂不支持格式化 .{ext} 文件")))
    }
}
