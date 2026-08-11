use super::*;

/// 执行 cargo check。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 package、timeoutMs 字段。
///
/// # Returns
///
/// 返回 cargo check 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn cargo_check(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["check".to_string()];
    if let Some(pkg) = opt_str(args, "package") {
        argv.extend(["-p".to_string(), pkg.to_string()]);
    }
    run_process(
        &cargo_root(root),
        "cargo",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(120_000),
    )
    .await
}

/// 执行 cargo build。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 package、timeoutMs 字段。
///
/// # Returns
///
/// 返回 cargo build 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn cargo_build(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["build".to_string()];
    if let Some(pkg) = opt_str(args, "package") {
        argv.extend(["-p".to_string(), pkg.to_string()]);
    }
    run_process(
        &cargo_root(root),
        "cargo",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(180_000),
    )
    .await
}

/// 执行 cargo test。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 package、test、timeoutMs 字段。
///
/// # Returns
///
/// 返回 cargo test 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn cargo_test(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["test".to_string()];
    if let Some(pkg) = opt_str(args, "package") {
        argv.extend(["-p".to_string(), pkg.to_string()]);
    }
    if let Some(test) = opt_str(args, "test") {
        argv.push(test.to_string());
    }
    run_process(
        &cargo_root(root),
        "cargo",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(180_000),
    )
    .await
}

/// 执行 cargo clippy（-D warnings）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 package、timeoutMs 字段。
///
/// # Returns
///
/// 返回 cargo clippy 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn cargo_clippy(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["clippy".to_string()];
    if let Some(pkg) = opt_str(args, "package") {
        argv.extend(["-p".to_string(), pkg.to_string()]);
    }
    argv.extend(["--".to_string(), "-D".to_string(), "warnings".to_string()]);
    run_process(
        &cargo_root(root),
        "cargo",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(180_000),
    )
    .await
}

/// 执行 npm test，可指定 workspace。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 workspace、timeoutMs 字段。
///
/// # Returns
///
/// 返回 npm test 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn npm_test(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["test".to_string()];
    if let Some(workspace) = opt_str(args, "workspace") {
        argv.extend(["-w".to_string(), workspace.to_string()]);
    }
    run_process(
        &npm_root(root),
        "npm",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(120_000),
    )
    .await
}

/// 执行 npm run build，可指定 workspace 或根脚本。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 workspace、script、timeoutMs 字段。
///
/// # Returns
///
/// 返回 npm run build 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当脚本名不在白名单或命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn npm_build_workspace(root: &Path, args: &Value) -> PortalResult<Value> {
    let script = opt_str(args, "script").unwrap_or("build");
    if ![
        "build",
        "build:runtime",
        "build:portal",
        "build:html",
        "build:apps",
    ]
    .contains(&script)
    {
        return Err(bad("npm_build_workspace 仅允许 build/build:* 预置脚本"));
    }
    let mut argv = vec!["run".to_string(), script.to_string()];
    if let Some(workspace) = opt_str(args, "workspace") {
        argv.extend(["-w".to_string(), workspace.to_string()]);
    }
    run_process(
        &npm_root(root),
        "npm",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(180_000),
    )
    .await
}

// ── run_command（白名单）─────────────────────────────────────────

/// 命令白名单校验，返回 (command, args)。
fn normalize_command(args: &Value) -> PortalResult<(String, Vec<String>)> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let argv: Vec<String> = args
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default();
    let allowed: &[(&str, &[&str])] = &[
        ("npm", &["run", "lint", "-w", "cmx-portal-manager"]),
        ("npm", &["run", "build", "-w", "cmx-portal-manager"]),
        ("npm", &["run", "build:runtime"]),
        ("npm", &["run", "build:portal"]),
        ("npm", &["run", "build:html"]),
        ("npm", &["run", "build:apps"]),
        ("cargo", &["check"]),
        ("cargo", &["build"]),
        ("cargo", &["test"]),
        ("cargo", &["clippy", "--", "-D", "warnings"]),
        ("git", &["status", "--short"]),
    ];
    let hit = allowed.iter().any(|(c, a)| {
        *c == command && a.len() == argv.len() && a.iter().zip(&argv).all(|(x, y)| *x == y)
    });
    if !hit {
        let joined = std::iter::once(command.clone())
            .chain(argv.clone())
            .collect::<Vec<_>>()
            .join(" ");
        return Err(bad(format!(
            "命令不在允许列表中：{}",
            if joined.trim().is_empty() {
                "(empty)".to_string()
            } else {
                joined
            }
        )));
    }
    Ok((command, argv))
}

/// run_command：执行白名单命令（cwd = rootDir 的父目录，与 Node 一致）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 command、args，可选 timeoutMs 字段。
///
/// # Returns
///
/// 返回含 command、exitCode、stdout、stderr、diagnostics 的 JSON 对象。
///
/// # Errors
///
/// 当命令不在白名单或执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn run_command(root: &Path, args: &Value) -> PortalResult<Value> {
    let (command, argv) = normalize_command(args)?;
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(60000)
        .clamp(1000, 120000);
    let cwd = match command.as_str() {
        "cargo" => cargo_root(root),
        "git" => repo_root(root),
        _ => npm_root(root),
    };
    let cmd_str = std::iter::once(command.clone())
        .chain(argv.clone())
        .collect::<Vec<_>>()
        .join(" ");

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&argv)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn();
    let output = match child {
        Ok(c) => {
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                c.wait_with_output(),
            )
            .await
            {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    return Ok(
                        json!({ "command": cmd_str, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "diagnostics": [], "timedOut": false }),
                    );
                }
                Err(_) => {
                    return Ok(
                        json!({ "command": cmd_str, "exitCode": 1, "stdout": "", "stderr": "命令执行超时", "diagnostics": [], "timedOut": true }),
                    );
                }
            }
        }
        Err(e) => {
            return Ok(
                json!({ "command": cmd_str, "exitCode": 1, "stdout": "", "stderr": e.to_string(), "diagnostics": [], "timedOut": false }),
            );
        }
    };
    let stdout = tail_str(&String::from_utf8_lossy(&output.stdout), MAX_COMMAND_OUTPUT);
    let stderr = tail_str(&String::from_utf8_lossy(&output.stderr), MAX_COMMAND_OUTPUT);
    let exit_code = output.status.code().unwrap_or(1);
    let combined = format!("{stdout}\n{stderr}");
    Ok(json!({
        "command": cmd_str, "exitCode": exit_code, "stdout": stdout, "stderr": stderr,
        "diagnostics": parse_lint_diagnostics(&cmd_str, &combined),
    }))
}

/// 解析 eslint 风格诊断（仅 lint 命令）。
fn parse_lint_diagnostics(cmd: &str, output: &str) -> Vec<Value> {
    if !cmd.contains("lint") {
        return vec![];
    }
    // 字面量正则：OnceLock 缓存，避免每次调用重新编译。
    let re = {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| {
            regex::Regex::new(r"^\s+(\d+):(\d+)\s+(warning|error)\s+(.+?)\s+([@\w/-]+)$")
                .expect("字面量正则编译失败")
        })
    };
    let file_re = {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| {
            regex::Regex::new(r"^/.+\.(?:js|mjs|cjs|ts|json|css|html)$")
                .expect("字面量正则编译失败")
        })
    };
    let mut diagnostics = Vec::new();
    let mut current_file = String::new();
    for line in output.split('\n') {
        let trimmed = line.trim();
        if file_re.is_match(trimmed) {
            current_file = trimmed.to_string();
            continue;
        }
        if let Some(c) = re.captures(line)
            && !current_file.is_empty()
        {
            diagnostics.push(json!({
                "file": current_file,
                "line": c[1].parse::<i64>().unwrap_or(0),
                "column": c[2].parse::<i64>().unwrap_or(0),
                "severity": &c[3],
                "message": c[4].trim(),
                "rule": &c[5],
            }));
        }
    }
    diagnostics
}
