//! agent 工具实现（复刻 `agentRoutes.js` 的 tool* 函数）。
//!
//! 路径穿越保护：所有文件操作限制在 rootDir 内。命令白名单：npm run lint/build -w cmx-portal-manager。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::error::{PortalError, PortalResult};

mod browser;
mod git;
mod meta_query;
mod patch;
mod plugin;
mod process;
mod read;
mod search;

// flow.rs 直接调用 tools::prepare_json_patch / tools::prepare_text_replace，需在此重导出。
pub(crate) use patch::{prepare_json_patch, prepare_text_replace};

/// 单文件读取的最大字节数。
pub(super) const MAX_FILE_BYTES: u64 = 180_000;
/// 命令输出（stdout/stderr）保留的最大字符数。
pub(super) const MAX_COMMAND_OUTPUT: usize = 60_000;
/// 补丁操作（文本替换/JSON 补丁/创建文件）的最大字节数。
pub(super) const MAX_PATCH_BYTES: u64 = 120_000;
/// 单次文本替换补丁允许的最大替换次数。
pub(super) const MAX_TEXT_REPLACEMENTS: usize = 200;
/// 视为文本文件进行搜索的扩展名白名单。
pub(super) const TEXT_FILE_EXTS: &[&str] = &["json", "html", "mjs", "cjs", "css", "md", "ts", "js"];
/// 通用进程输出保留的最大字符数。
pub(super) const MAX_GENERIC_OUTPUT: usize = 80_000;

/// 构造一个 bad_request 错误。
pub(super) fn bad(msg: impl Into<String>) -> PortalError {
    PortalError::bad_request(msg)
}

/// 校验 URL 仅允许 http(s) 协议，阻止 file:// / 内网/非预期协议的 SSRF。
///
/// planner 侧虽有同样校验，但 tools 层是命令执行的最后一道防线，绕过 planner 直接调
/// tools 时仍需拦截。
pub(super) fn require_http_url(url: &str) -> PortalResult<()> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err(bad(format!(
            "browser 工具仅允许 http(s) URL，收到：\"{url}\""
        )))
    }
}

/// 把相对路径解析为 rootDir 内的绝对路径，防穿越。
pub(super) fn resolve_inside_root(root: &Path, input: &str) -> PortalResult<PathBuf> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(bad("缺少文件路径"));
    }
    let cleaned = raw.trim_start_matches('/');
    let abs = root.join(cleaned);
    // 规范化判断：用 components 消除 .. 后必须仍在 root 下
    let normalized = normalize_path(&abs);
    if normalized != root && !normalized.starts_with(root) {
        return Err(bad("文件路径超出允许范围"));
    }
    Ok(normalized)
}

/// 纯词法路径规范化（不触盘）：消除 `.` / `..`。
pub(super) fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 将绝对路径转换为相对于 root 的正斜杠路径字符串。
pub(super) fn relative_from_root(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().to_string())
}

/// 判断文件名是否具有可搜索的文本扩展名。
pub(super) fn has_text_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    TEXT_FILE_EXTS
        .iter()
        .any(|e| lower.ends_with(&format!(".{e}")))
}

/// 从参数对象中提取非空字符串字段。
pub(super) fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 从参数中提取 app 或 application 字段（兼容两种命名）。
pub(super) fn app_arg(args: &Value) -> Option<&str> {
    opt_str(args, "app").or_else(|| opt_str(args, "application"))
}

/// 从参数中提取 limit 字段并钳制到 `[1, max]` 区间。
pub(super) fn limit_arg(args: &Value, default: usize, max: usize) -> usize {
    args.get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(default as u64)
        .clamp(1, max as u64) as usize
}

/// 从参数对象构造弹性组合引用 FcRef。
pub(super) fn fc_ref_from_args(args: &Value) -> crate::flexible_combination::store::FcRef {
    crate::flexible_combination::store::FcRef {
        domain: opt_str(args, "domain").map(str::to_string),
        app: app_arg(args).map(str::to_string),
        module: opt_str(args, "module").map(str::to_string),
        scenario: opt_str(args, "scenario").map(str::to_string),
    }
}

/// 从参数对象中提取 anchor 字段并克隆为 Map。
pub(super) fn anchor_from_args(args: &Value) -> Map<String, Value> {
    args.get("anchor")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

/// 探测仓库根目录（含 Cargo.toml / package.json / .git 的目录）。
pub(super) fn repo_root(root: &Path) -> PathBuf {
    if root.join("Cargo.toml").exists()
        || root.join("package.json").exists()
        || root.join(".git").exists()
    {
        return root.to_path_buf();
    }
    if root.join("cmx-container").join("Cargo.toml").exists() || root.join("package.json").exists()
    {
        return root.to_path_buf();
    }
    root.parent().unwrap_or(root).to_path_buf()
}

/// 探测 Cargo 工作区根目录。
pub(super) fn cargo_root(root: &Path) -> PathBuf {
    if root.join("Cargo.toml").exists() {
        root.to_path_buf()
    } else if root.join("cmx-container").join("Cargo.toml").exists() {
        root.join("cmx-container")
    } else {
        repo_root(root)
    }
}

/// 探测 npm 项目根目录（含 package.json 的目录）。
pub(super) fn npm_root(root: &Path) -> PathBuf {
    if root.join("package.json").exists() {
        root.to_path_buf()
    } else if root
        .parent()
        .map(|p| p.join("package.json").exists())
        .unwrap_or(false)
    {
        root.parent().unwrap_or(root).to_path_buf()
    } else {
        repo_root(root)
    }
}

/// 在指定工作目录异步执行外部命令并收集输出。
///
/// # Arguments
///
/// * `cwd` - 子进程工作目录。
/// * `command` - 可执行程序名称。
/// * `argv` - 命令行参数列表。
/// * `timeout_ms` - 超时毫秒数，钳制到 `[1000, 300000]`。
///
/// # Returns
///
/// 返回包含 command、cwd、exitCode、stdout、stderr、timedOut 的 JSON 对象。
///
/// # Errors
///
/// 当子进程 spawn 或等待输出发生 IO 错误时返回 `PortalError`；超时和 spawn 失败以 JSON 形式返回而非报错。
pub(super) async fn run_process(
    cwd: &Path,
    command: &str,
    argv: &[String],
    timeout_ms: u64,
) -> PortalResult<Value> {
    let timeout_ms = timeout_ms.clamp(1000, 300000);
    let cmd_str = std::iter::once(command.to_string())
        .chain(argv.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(argv)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn();
    let output = match child {
        Ok(c) => match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            c.wait_with_output(),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                return Ok(
                    json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "timedOut": false }),
                );
            }
            Err(_) => {
                return Ok(
                    json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": "命令执行超时", "timedOut": true }),
                );
            }
        },
        Err(e) => {
            return Ok(
                json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "timedOut": false }),
            );
        }
    };
    Ok(json!({
        "command": cmd_str,
        "cwd": cwd.to_string_lossy(),
        "exitCode": output.status.code().unwrap_or(1),
        "stdout": tail_str(&String::from_utf8_lossy(&output.stdout), MAX_GENERIC_OUTPUT),
        "stderr": tail_str(&String::from_utf8_lossy(&output.stderr), MAX_GENERIC_OUTPUT),
        "timedOut": false,
    }))
}

/// 在指定工作目录异步执行外部命令，写入 stdin 后收集输出。
///
/// # Arguments
///
/// * `cwd` - 子进程工作目录。
/// * `command` - 可执行程序名称。
/// * `argv` - 命令行参数列表。
/// * `stdin` - 写入子进程标准输入的内容。
/// * `timeout_ms` - 超时毫秒数，钳制到 `[1000, 300000]`。
///
/// # Returns
///
/// 返回包含 command、cwd、exitCode、stdout、stderr、timedOut 的 JSON 对象。
///
/// # Errors
///
/// 当写入 stdin 或等待输出发生 IO 错误时返回 `PortalError`；超时和 spawn 失败以 JSON 形式返回而非报错。
pub(super) async fn run_process_with_stdin(
    cwd: &Path,
    command: &str,
    argv: &[String],
    stdin: &str,
    timeout_ms: u64,
) -> PortalResult<Value> {
    use tokio::io::AsyncWriteExt;

    let timeout_ms = timeout_ms.clamp(1000, 300000);
    let cmd_str = std::iter::once(command.to_string())
        .chain(argv.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(argv)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(
                json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "timedOut": false }),
            );
        }
    };
    if let Some(mut child_stdin) = child.stdin.take() {
        child_stdin
            .write_all(stdin.as_bytes())
            .await
            .map_err(PortalError::Io)?;
    }
    let output = match tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Ok(
                json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "timedOut": false }),
            );
        }
        Err(_) => {
            return Ok(
                json!({ "command": cmd_str, "cwd": cwd, "exitCode": 1, "stdout": "", "stderr": "命令执行超时", "timedOut": true }),
            );
        }
    };
    Ok(json!({
        "command": cmd_str,
        "cwd": cwd.to_string_lossy(),
        "exitCode": output.status.code().unwrap_or(1),
        "stdout": tail_str(&String::from_utf8_lossy(&output.stdout), MAX_GENERIC_OUTPUT),
        "stderr": tail_str(&String::from_utf8_lossy(&output.stderr), MAX_GENERIC_OUTPUT),
        "timedOut": false,
    }))
}

/// 截取字符串末尾最多 max 个字符。
pub(super) fn tail_str(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

/// 派发工具调用。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `name` - 工具名称。
/// * `args` - 工具参数 JSON 值。
///
/// # Returns
///
/// 返回对应工具的执行结果 JSON 值。
///
/// # Errors
///
/// 当工具名称未知或对应工具执行出错时返回 `PortalError`。
pub(crate) async fn run_tool(root: &Path, name: &str, args: &Value) -> PortalResult<Value> {
    match name {
        "search_files" => search::search_files(root, args).await,
        "read_file" => read::read_file(root, args).await,
        "list_definitions" => read::list_definitions(args).await,
        "list_html_pages" => read::list_html_pages(args).await,
        "read_html_page" => read::read_html_page(args).await,
        "validate_metadata" => meta_query::validate_metadata(root, args).await,
        "list_modules" => meta_query::list_modules_tool(args).await,
        "get_module_manifest" => meta_query::get_module_manifest_tool(args).await,
        "get_module_resource" => meta_query::get_module_resource_tool(args).await,
        "list_dict_schemas" => meta_query::list_dict_schemas_tool(args).await,
        "dict_search" => meta_query::dict_search_tool(args).await,
        "dict_suggest" => meta_query::dict_suggest_tool(args).await,
        "list_facts" => meta_query::list_facts_tool(args).await,
        "get_fact" => meta_query::get_fact_tool(args).await,
        "service_catalog_list" => meta_query::service_catalog_list_tool(args).await,
        "service_catalog_get" => meta_query::service_catalog_get_tool(args).await,
        "flexible_combination_list" => meta_query::flexible_combination_list_tool(args).await,
        "flexible_combination_get" => meta_query::flexible_combination_get_tool(args).await,
        "flexible_combination_validate" => {
            meta_query::flexible_combination_validate_tool(args).await
        }
        "flexible_combination_preview" => meta_query::flexible_combination_preview_tool(args).await,
        "flexible_combination_resolve" => meta_query::flexible_combination_resolve_tool(args).await,
        "flexible_combination_rule" => meta_query::flexible_combination_rule_tool(args).await,
        "git_status" => git::git_status_tool(root, args).await,
        "git_diff" => git::git_diff_tool(root, args).await,
        "git_log" => git::git_log_tool(root, args).await,
        "list_local_plugins" => plugin::list_local_plugins(root, args).await,
        "inspect_plugin_manifest" => plugin::inspect_plugin_manifest(root, args).await,
        "call_plugin_function" => plugin::call_plugin_function_tool(root, args).await,
        "call_service_flow" => plugin::call_service_flow_tool(root, args).await,
        "generate_api_doc" => plugin::generate_api_doc_tool(root, args).await,
        "cargo_check" => process::cargo_check(root, args).await,
        "cargo_build" => process::cargo_build(root, args).await,
        "cargo_test" => process::cargo_test(root, args).await,
        "cargo_clippy" => process::cargo_clippy(root, args).await,
        "npm_test" => process::npm_test(root, args).await,
        "npm_build_workspace" => process::npm_build_workspace(root, args).await,
        "run_playwright" => browser::run_playwright(root, args).await,
        "capture_page_screenshot" => browser::capture_page_screenshot(root, args).await,
        "inspect_dom" => browser::inspect_dom(root, args).await,
        "check_accessibility" => browser::check_accessibility(root, args).await,
        "apply_file_patch" => patch::apply_file_patch(root, args).await,
        "format_file" => patch::format_file(root, args).await,
        "create_file" => patch::create_file(root, args).await,
        "rename_file" => patch::rename_file(root, args).await,
        "run_command" => process::run_command(root, args).await,
        "apply_json_patch" => patch::apply_json_patch(root, args).await,
        "apply_text_replace" => patch::apply_text_replace(root, args).await,
        other => Err(bad(format!("未知工具：{other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_resolves_parent_and_dot() {
        let p = normalize_path(std::path::Path::new("/a/b/../c/./d"));
        assert_eq!(p, std::path::PathBuf::from("/a/c/d"));
    }

    #[test]
    fn normalize_path_pop_to_root_on_excess_parent() {
        // 超出根的 .. 被吞掉（不越界）。
        let p = normalize_path(std::path::Path::new("a/../../../b"));
        assert_eq!(p, std::path::PathBuf::from("b"));
    }

    #[test]
    fn resolve_inside_root_accepts_relative() {
        let root = std::path::Path::new("/proj/root");
        let abs = resolve_inside_root(root, "src/main.rs").unwrap();
        assert_eq!(abs, std::path::PathBuf::from("/proj/root/src/main.rs"));
    }

    #[test]
    fn resolve_inside_root_strips_leading_slash() {
        let root = std::path::Path::new("/proj/root");
        let abs = resolve_inside_root(root, "/src/a.rs").unwrap();
        assert_eq!(abs, std::path::PathBuf::from("/proj/root/src/a.rs"));
    }

    #[test]
    fn resolve_inside_root_rejects_traversal() {
        let root = std::path::Path::new("/proj/root");
        assert!(resolve_inside_root(root, "../etc/passwd").is_err());
        assert!(resolve_inside_root(root, "src/../../etc").is_err());
    }

    #[test]
    fn resolve_inside_root_rejects_empty() {
        let root = std::path::Path::new("/proj/root");
        assert!(resolve_inside_root(root, "   ").is_err());
    }

    #[test]
    fn line_diff_identical_text_no_minus_plus() {
        let diff = patch::line_diff("a\nb\nc", "a\nb\nc");
        // 完全相同：不应有删除行（`-xxx`）或新增行（`+xxx`）。
        // 注意 diff 头 `@@ ... -> ... @@` 含 `->`，故按行首字符判断而非整体 contains。
        assert!(diff.starts_with("@@"));
        for line in diff.lines() {
            assert!(!line.starts_with('-'), "相同文本不应有删除行：{line}");
            assert!(!line.starts_with('+'), "相同文本不应有新增行：{line}");
        }
    }

    #[test]
    fn line_diff_marks_changes() {
        let diff = patch::line_diff("a\nold\nc", "a\nnew\nc");
        assert!(diff.contains("-old"), "应含被删行：{diff}");
        assert!(diff.contains("+new"), "应含新增行：{diff}");
    }

    #[test]
    fn opt_str_skips_empty_and_whitespace() {
        let args = json!({ "a": "x", "b": "  ", "c": "" });
        assert_eq!(opt_str(&args, "a"), Some("x"));
        assert_eq!(opt_str(&args, "b"), None);
        assert_eq!(opt_str(&args, "c"), None);
        assert_eq!(opt_str(&args, "missing"), None);
    }

    #[test]
    fn app_arg_accepts_both_names() {
        let a = json!({ "app": "fi" });
        let b = json!({ "application": "fi" });
        assert_eq!(app_arg(&a), Some("fi"));
        assert_eq!(app_arg(&b), Some("fi"));
    }

    #[test]
    fn limit_arg_clamps() {
        let args = json!({ "limit": 0 });
        assert_eq!(limit_arg(&args, 10, 100), 1);
        let args = json!({ "limit": 9999 });
        assert_eq!(limit_arg(&args, 10, 100), 100);
        let args = json!({});
        assert_eq!(limit_arg(&args, 10, 100), 10);
    }

    #[test]
    fn has_text_ext_matches_whitelist() {
        assert!(has_text_ext("README.md"));
        assert!(has_text_ext("app.JS"));
        assert!(!has_text_ext("image.png"));
        assert!(!has_text_ext("binary"));
    }
}
