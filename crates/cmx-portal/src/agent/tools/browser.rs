use super::*;

/// 执行 Playwright 测试。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 project、grep、timeoutMs 字段。
///
/// # Returns
///
/// 返回 playwright test 的执行结果 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn run_playwright(root: &Path, args: &Value) -> PortalResult<Value> {
    let mut argv = vec!["playwright".to_string(), "test".to_string()];
    if let Some(project) = opt_str(args, "project") {
        argv.extend(["--project".to_string(), project.to_string()]);
    }
    if let Some(grep) = opt_str(args, "grep") {
        argv.extend(["--grep".to_string(), grep.to_string()]);
    }
    run_process(
        &npm_root(root),
        "npx",
        &argv,
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(180_000),
    )
    .await
}

/// 用 Playwright 对指定 URL 截图。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 url，可选 output、timeoutMs 字段。
///
/// # Returns
///
/// 返回含 output 和 result 的 JSON 对象。
///
/// # Errors
///
/// 当缺少 url、路径越界或截图命令执行失败时返回 `PortalError`。
pub(crate) async fn capture_page_screenshot(root: &Path, args: &Value) -> PortalResult<Value> {
    let url = opt_str(args, "url").ok_or_else(|| bad("capture_page_screenshot 需要 url"))?;
    require_http_url(url)?;
    let output = opt_str(args, "output").unwrap_or("agent-screenshot.png");
    let out_abs = resolve_inside_root(root, output)?;
    if let Some(parent) = out_abs.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PortalError::Io)?;
    }
    let script = r#"
const { chromium } = require('playwright');
(async () => {
  const [url, output] = process.argv.slice(1);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: output, fullPage: true });
  await browser.close();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
"#;
    let res = run_process(
        &npm_root(root),
        "node",
        &[
            "-e".to_string(),
            script.to_string(),
            url.to_string(),
            out_abs.to_string_lossy().to_string(),
        ],
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(60_000),
    )
    .await?;
    Ok(json!({ "output": relative_from_root(root, &out_abs), "result": res }))
}

/// 用 Playwright 读取页面标题和指定选择器文本。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，需包含 url，可选 selector、timeoutMs 字段。
///
/// # Returns
///
/// 返回 node 命令的执行结果 JSON 对象。
///
/// # Errors
///
/// 当缺少 url 或命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn inspect_dom(root: &Path, args: &Value) -> PortalResult<Value> {
    let url = opt_str(args, "url").ok_or_else(|| bad("inspect_dom 需要 url"))?;
    require_http_url(url)?;
    let selector = opt_str(args, "selector").unwrap_or("body");
    let script = r#"
const { chromium } = require('playwright');
(async () => {
  const [url, selector] = process.argv.slice(1);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const text = await page.locator(selector).first().innerText({ timeout: 5000 }).catch(() => '');
  console.log(JSON.stringify({ title, selector, text: text.slice(0, 12000) }));
  await browser.close();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
"#;
    run_process(
        &npm_root(root),
        "node",
        &[
            "-e".to_string(),
            script.to_string(),
            url.to_string(),
            selector.to_string(),
        ],
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(60_000),
    )
    .await
}

/// 运行可访问性检查（无 URL 时通过 Playwright grep 约定执行）。
///
/// # Arguments
///
/// * `root` - 项目根目录。
/// * `args` - 工具参数，可选 url、timeoutMs 字段。
///
/// # Returns
///
/// 返回可访问性检查结果的 JSON 对象。
///
/// # Errors
///
/// 当命令执行发生 IO 错误时返回 `PortalError`。
pub(crate) async fn check_accessibility(root: &Path, args: &Value) -> PortalResult<Value> {
    let url = opt_str(args, "url").unwrap_or("");
    if url.is_empty() {
        return run_playwright(root, &json!({ "grep": "accessibility", "timeoutMs": args.get("timeoutMs").cloned().unwrap_or(json!(180000)) })).await;
    }
    require_http_url(url)?;
    let script = r#"
const { chromium } = require('playwright');
(async () => {
  const [url] = process.argv.slice(1);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const result = await page.evaluate(() => {
    const imgsMissingAlt = [...document.images].filter((img) => !img.hasAttribute('alt')).length;
    const unnamedButtons = [...document.querySelectorAll('button,[role="button"]')].filter((el) => !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title')).length;
    const inputsMissingLabel = [...document.querySelectorAll('input,textarea,select')].filter((el) => !el.id || !document.querySelector(`label[for="${CSS.escape(el.id)}"]`)).length;
    return { imgsMissingAlt, unnamedButtons, inputsMissingLabel };
  });
  console.log(JSON.stringify(result));
  await browser.close();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
"#;
    run_process(
        &npm_root(root),
        "node",
        &["-e".to_string(), script.to_string(), url.to_string()],
        args.get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(60_000),
    )
    .await
}
