//! 意图抽取：把用户消息文本解析为可执行的 decision 输入（补丁/替换/命令/只读分析线索）。
//!
//! 这些函数被 [`super`] 的 `local_plan` 调用，均为纯函数（无 IO），可独立单测。

use serde_json::{Value, json};

use super::{text_file_re, trailing_file_suffix_re};

/// 猜测搜索关键词（引号 > 路径 > 末尾 token）。
pub(super) fn guess_search_query(text: &str) -> String {
    // 引号内 2-120 字符
    let quoted = cached_re!(QUOTED, r#"["'`“”‘’]([^"'`“”‘’]{2,120})["'`“”‘’]"#);
    if let Some(c) = quoted.captures(text) {
        return c[1].trim().to_string();
    }
    let path_like = text_file_re();
    if let Some(c) = path_like.captures(text) {
        return c[1].trim().to_string();
    }
    let stop = cached_re!(STOP, r"^(请|帮我|如何|怎么|一下|实现|方案|这个|那个)$");
    let cleaned = cached_re!(PUNCT, r"[，。！？；：、]").replace_all(text, " ");
    let tokens: Vec<&str> = cleaned
        .split_whitespace()
        .map(|s| s.trim())
        .filter(|s| s.chars().count() >= 2 && !stop.is_match(s))
        .collect();
    if tokens.is_empty() {
        text.chars().take(80).collect()
    } else {
        tokens
            .iter()
            .rev()
            .take(4)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// 宽松解析值（JSON / bool / null / number / 去引号字符串）。
fn parse_loose_value(raw: &str) -> Value {
    let text = raw.trim();
    if text.is_empty() {
        return json!("");
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return v;
    }
    let lower = text.to_lowercase();
    if lower == "true" {
        return json!(true);
    }
    if lower == "false" {
        return json!(false);
    }
    if lower == "null" {
        return Value::Null;
    }
    if cached_re!(NUM, r"^-?\d+(\.\d+)?$").is_match(text)
        && let Ok(n) = text.parse::<f64>()
    {
        return json!(n);
    }
    json!(text.trim_matches(|c| "\"'“”‘’".contains(c)))
}

/// 去除 `CMXPortalManager/` 路径前缀。
fn strip_portal_prefix(s: &str) -> String {
    s.strip_prefix("CMXPortalManager/").unwrap_or(s).to_string()
}

/// 抽取 JSON 补丁请求（file + pointer + value）。
pub(super) fn extract_json_patch_request(text: &str) -> Option<Value> {
    let file = cached_re!(JSON_FILE, r"([a-zA-Z0-9_.@/-]+\.json)")
        .captures(text)
        .map(|c| strip_portal_prefix(&c[1]))?;
    let pointer = cached_re!(
        PTR,
        r"(?i)(?:pointer|路径|字段|json\s*pointer)\s*[:：]?\s*(/[^\s，。；]+)"
    )
    .captures(text)
    .map(|c| c[1].to_string())
    .or_else(|| {
        cached_re!(
            PTR2,
            r"(?i)(/[a-zA-Z0-9_~/-]+)\s*(?:改为|设置为|set\s+to)\s*"
        )
        .captures(text)
        .map(|c| c[1].to_string())
    })?;
    let value_str = cached_re!(VAL, r"(?i)(?:值|value)\s*[:：]\s*([\s\S]+)$")
        .captures(text)
        .map(|c| c[1].to_string())
        .or_else(|| {
            cached_re!(VAL2, r"(?i)(?:改为|设置为|set\s+to)\s*([\s\S]+)$")
                .captures(text)
                .map(|c| c[1].to_string())
        })?;
    Some(json!({ "path": file, "pointer": pointer, "value": parse_loose_value(&value_str) }))
}

/// 抽取引号片段（最多 6 个，按出现顺序）。
///
/// Rust `regex` 不支持反向引用 `\1`，故对三种引号各跑一次非贪婪匹配，再按起始位置排序合并，
/// 等价于 Node 的 `(["'`])([\s\S]*?)\1`。
fn extract_quoted_parts(text: &str) -> Vec<String> {
    let normalized = text.replace(['“', '”'], "\"").replace(['‘', '’'], "'");
    let mut found: Vec<(usize, String)> = Vec::new();
    for re in [
        cached_re!(DQUOTE, r#""([\s\S]*?)""#),
        cached_re!(SQUOTE, r#"'([\s\S]*?)'"#),
        cached_re!(BTICK, r#"`([\s\S]*?)`"#),
    ] {
        for c in re.captures_iter(&normalized) {
            let m = c.get(0).unwrap();
            let inner = c.get(1).map(|x| x.as_str().to_string()).unwrap_or_default();
            if !inner.is_empty() {
                found.push((m.start(), inner));
            }
        }
    }
    found.sort_by_key(|(pos, _)| *pos);
    found.into_iter().map(|(_, s)| s).take(6).collect()
}

/// 抽取文本替换请求。
pub(super) fn extract_text_replace_request(text: &str) -> Option<Value> {
    if !cached_re!(REPLACE_KW, r"(?i)(替换|replace|改成|改为)").is_match(text) {
        return None;
    }
    let file = text_file_re()
        .captures(text)
        .map(|c| strip_portal_prefix(&c[1]))?;
    let all = cached_re!(ALL_KW, r"(?iu)全部|所有|all|global").is_match(text);
    let occurrence = if all { "all" } else { "first" };
    let quoted = extract_quoted_parts(text);
    if quoted.len() >= 2 {
        return Some(
            json!({ "path": file, "oldText": quoted[0], "newText": quoted[1], "occurrence": occurrence }),
        );
    }
    let m = cached_re!(
        BA_REP,
        r"把\s+([\s\S]+?)\s*(?:替换为|替换成|改成|改为)\s*([\s\S]+)$"
    )
    .captures(text)?;
    let new_text = trailing_file_suffix_re()
        .replace(m[2].trim(), "")
        .to_string();
    Some(
        json!({ "path": file, "oldText": m[1].trim(), "newText": new_text.trim(), "occurrence": occurrence }),
    )
}

/// 推断命令审批（lint / build）。
pub(super) fn infer_command_approval(text: &str) -> Option<Value> {
    if cached_re!(LINT, r"(?i)lint|eslint|代码检查|静态检查").is_match(text) {
        return Some(json!({
            "title": "运行 CMXPortalManager lint",
            "risk": "只读检查命令，会读取源码并输出诊断，不写业务文件。",
            "args": { "command": "npm", "args": ["run", "lint", "-w", "cmx-portal-manager"] }
        }));
    }
    if cached_re!(BUILD, r"(?i)build|构建|打包").is_match(text) {
        return Some(json!({
            "title": "构建 CMXPortalManager",
            "risk": "构建命令可能写入 dist 等构建产物，耗时也更长。",
            "args": { "command": "npm", "args": ["run", "build", "-w", "cmx-portal-manager"], "timeoutMs": 120000 }
        }));
    }
    None
}

/// 判断用户消息是否涉及自定义 HTML 页面上下文。
pub(super) fn wants_html_page_context(text: &str) -> bool {
    cached_re!(
        HTML_CTX,
        r"(?i)自定义页面|html\s*page|html页面|页面设计|设计器|html_pages|页面资产"
    )
    .is_match(text)
}

/// 从用户消息中抽取 HTML 页面 ID。
pub(super) fn extract_html_page_id(text: &str) -> String {
    if let Some(c) = cached_re!(
        PAGE_ID,
        r"(?i)(?:页面\s*ID|html\s*page\s*id|pageId|id)\s*[:：=]\s*([a-zA-Z0-9._-]{1,128})"
    )
    .captures(text)
    {
        return c[1].to_string();
    }
    let stop = cached_re!(
        STOP_ID,
        r"(?i)^(json|html|css|js|ts|md|lint|build|agent|deepseek)$"
    );
    for c in
        cached_re!(TOKEN_ID, r"\b([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,5})\b").captures_iter(text)
    {
        let s = c[1].to_string();
        if stop.is_match(&s) {
            continue;
        }
        if s.contains('.') || s.contains('-') || s.contains('_') {
            return s;
        }
    }
    String::new()
}

/// 从用户消息中抽取存在的可读文件相对路径。
///
/// # Arguments
///
/// * `text` - 用户消息文本。
/// * `root` - agent 根目录，用于拼接并校验候选路径是否存在。
///
/// # Returns
///
/// 返回存在文件的相对路径，不存在时返回空字符串。
pub(super) async fn extract_readable_path(text: &str, root: &std::path::Path) -> String {
    let re = text_file_re();
    let Some(c) = re.captures(text) else {
        return String::new();
    };
    let candidate = strip_portal_prefix(&c[1]);
    let abs = root.join(candidate.trim_start_matches('/'));
    if tokio::fs::metadata(&abs).await.is_ok() {
        candidate
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_patch_request_basic() {
        let text = "请把 pages/home.json 的 /title 改为 首页";
        let v = extract_json_patch_request(text).expect("应抽取到补丁请求");
        assert_eq!(v["path"], json!("pages/home.json"));
        assert_eq!(v["pointer"], json!("/title"));
        assert_eq!(v["value"], json!("首页"));
    }

    #[test]
    fn extract_json_patch_request_none_when_no_file() {
        assert!(extract_json_patch_request("随便聊聊，没有文件").is_none());
    }

    #[test]
    fn extract_text_replace_request_with_quotes() {
        let text = "请把 config.json 里的 \"oldValue\" 替换为 \"newValue\"";
        let v = extract_text_replace_request(text).expect("应抽取到替换请求");
        assert_eq!(v["path"], json!("config.json"));
        assert_eq!(v["oldText"], json!("oldValue"));
        assert_eq!(v["newText"], json!("newValue"));
    }

    #[test]
    fn extract_text_replace_request_none_without_keyword() {
        assert!(extract_text_replace_request("读取 config.json").is_none());
    }

    #[test]
    fn infer_command_approval_lint() {
        let v = infer_command_approval("帮我跑一下 lint 检查").expect("应识别为 lint 审批");
        // 返回结构含 title/risk/args（action 由 local_plan 包装时补，此处不校验）。
        assert!(v["title"].as_str().unwrap().contains("lint"));
        assert_eq!(v["args"]["command"].as_str(), Some("npm"));
    }

    #[test]
    fn infer_command_approval_build() {
        let v = infer_command_approval("构建一下项目 build").expect("应识别为 build 审批");
        assert!(v["title"].as_str().unwrap().contains("构建"));
    }

    #[test]
    fn infer_command_approval_none_for_unrelated() {
        assert!(infer_command_approval("今天天气如何").is_none());
    }

    #[test]
    fn wants_html_page_context_keywords() {
        assert!(wants_html_page_context("帮我看看自定义页面"));
        assert!(wants_html_page_context("打开 html_pages"));
        assert!(!wants_html_page_context("查询字典定义"));
    }

    #[test]
    fn extract_html_page_id_explicit() {
        let id = extract_html_page_id("查看页面ID: my-page-1");
        assert_eq!(id, "my-page-1");
    }

    #[test]
    fn guess_search_query_quoted() {
        assert_eq!(guess_search_query("查找 \"登录逻辑\" 相关代码"), "登录逻辑");
    }
}
