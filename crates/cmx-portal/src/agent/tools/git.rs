use super::*;

/// 读取 git 工作区状态。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `_args` - 工具参数（未使用）。
///
/// # Returns
///
/// 返回 git status --short 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当 git 命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn git_status_tool(root: &Path, _args: &Value) -> PortalResult<Value> {
    run_process(
        &repo_root(root),
        "git",
        &["status".to_string(), "--short".to_string()],
        30_000,
    )
    .await
}

/// 读取 git diff，可指定文件路径和是否暂存区。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 staged、path、maxBytes 字段。
///
/// # Returns
///
/// 返回 git diff 的执行结果 JSON 对象，stdout 按 maxBytes 截断。
///
/// # Errors
///
/// 当路径越界或 git 命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn git_diff_tool(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["diff".to_string()];
    if args
        .get("staged")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        argv.push("--staged".to_string());
    }
    if let Some(path) = opt_str(args, "path") {
        // 只允许 repo 内相对路径作为 pathspec。
        let _ = resolve_inside_root(root, path)?;
        argv.push("--".to_string());
        argv.push(path.trim_start_matches('/').to_string());
    }
    let mut out = run_process(&repo_root(root), "git", &argv, 30_000).await?;
    let max = args
        .get("maxBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(80_000)
        .clamp(1_000, 200_000) as usize;
    if let Some(stdout) = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    {
        out.as_object_mut()
            .unwrap()
            .insert("stdout".to_string(), json!(tail_str(&stdout, max)));
    }
    Ok(out)
}

/// 读取最近 git 提交摘要。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 limit 字段（默认 10，最大 50）。
///
/// # Returns
///
/// 返回 git log --oneline 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当 git 命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn git_log_tool(root: &Path, args: &Value) -> PortalResult<Value> {
    let limit = limit_arg(args, 10, 50).to_string();
    run_process(
        &repo_root(root),
        "git",
        &[
            "log".to_string(),
            "--oneline".to_string(),
            "-n".to_string(),
            limit,
        ],
        30_000,
    )
    .await
}
