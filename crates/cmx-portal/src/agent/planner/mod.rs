//! LocalRulePlanner —— 正则意图抽取（复刻 `agentPlanner.js` 的 LocalRulePlanner）。
//!
//! 把用户消息转成 decision：analysis（只读工具组合）或 approval（写文件/跑命令）。
//! LlmPlanner（CMX_AGENT_PLANNER=llm）暂不实现，默认走本地规则。
//!
//! 模块组织：
//! - 本文件（mod.rs）：公共基建（`cached_re!` 宏、正则工厂、`value_to_string`/`default_plan`）、
//!   对外入口 [`latest_user_text`] / [`plan`]、本地规则 [`local_plan`]。
//! - [`intent`]：意图抽取（补丁/替换/命令/只读分析线索）。
//! - [`llm`]：LlmPlanner（LLM 规划 + decision 归一）。
//! - [`summary`]：Agent 流程总结（LLM 流式 + 本地兜底）。

use serde_json::{Value, json};

const TEXT_FILE_EXT_PATTERN: &str = "json|html|mjs|cjs|css|md|ts|js";

/// 字面量正则编译为 `&'static Regex`（OnceLock 缓存，仅首次编译）。
///
/// 用法：`cached_re!(RE_NAME, r"pattern")` 展开为一个 `&'static regex::Regex`。
/// 字面量正则编译失败属于程序错误，用 `expect` 直接 panic（与原 `.unwrap()` 语义一致）。
///
/// 定义在子模块声明之前，intent / plan 等子模块与 local_plan 均可直接使用。
macro_rules! cached_re {
    ($name:ident, $pat:expr) => {{
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| regex::Regex::new($pat).expect("字面量正则编译失败"))
    }};
}

/// 匹配文本文件相对路径（扩展名白名单随 `TEXT_FILE_EXT_PATTERN`）。多处共享，OnceLock 缓存。
pub(super) fn text_file_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(&format!(
            r"([a-zA-Z0-9_.@/-]+\.(?:{TEXT_FILE_EXT_PATTERN}))"
        ))
        .expect("字面量正则编译失败")
    })
}

/// 匹配尾部「在/到 <file>」后缀（用于剥离文本替换尾部的位置说明）。多处共享，OnceLock 缓存。
pub(super) fn trailing_file_suffix_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(&format!(
            r"(?i)\s*(?:在|到)\s*[a-zA-Z0-9_.@/-]+\.(?:{TEXT_FILE_EXT_PATTERN})\s*$"
        ))
        .expect("字面量正则编译失败")
    })
}

/// 值转字符串（数字/布尔也转，对象/数组保持 JSON）。
pub(super) fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 返回默认的三步计划模板。
pub(super) fn default_plan() -> Value {
    json!([
        "理解请求与当前工作区上下文",
        "选择只读工具收集证据",
        "汇总下一步建议或定位结果"
    ])
}

mod intent;
mod llm;
mod summary;
pub use summary::build_summary;

/// 取最近一条 user 消息文本。
///
/// # Arguments
///
/// * `messages` - 消息数组。
///
/// # Returns
///
/// 返回最近一条 user 消息的文本，无则返回空字符串。
pub fn latest_user_text(messages: &[Value]) -> String {
    for m in messages.iter().rev() {
        if m.get("role").and_then(|v| v.as_str()) == Some("user") {
            return m
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }
    String::new()
}

/// 计划 decision：CMX_AGENT_PLANNER=llm 时走 LLM 规划（失败回退本地规则），否则纯本地规则。
///
/// # Arguments
///
/// * `messages` - 消息数组。
/// * `root` - agent 根目录，用于本地规则判断路径是否存在。
///
/// # Returns
///
/// 返回包含 kind（analysis / approval）及相应字段的 decision JSON 对象。
pub async fn plan(messages: &[Value], root: &std::path::Path) -> Value {
    if std::env::var("CMX_AGENT_PLANNER").ok().as_deref() == Some("llm")
        && crate::ai::is_configured()
    {
        match llm::llm_plan(messages).await {
            Ok(decision) => return decision,
            Err(e) => {
                tracing::warn!("[agentPlanner] LLM 规划失败，回退本地规则：{e}");
            }
        }
    }
    local_plan(messages, root).await
}

/// 本地规则规划（LocalRulePlanner）。`root` 用于判断 readFile 候选路径是否存在。
///
/// # Arguments
///
/// * `messages` - 消息数组。
/// * `root` - agent 根目录，用于判断 readFile 候选路径是否存在。
///
/// # Returns
///
/// 返回基于正则意图抽取的 decision JSON 对象。
pub async fn local_plan(messages: &[Value], root: &std::path::Path) -> Value {
    use intent::*;
    let text = latest_user_text(messages);

    if let Some(json_patch) = extract_json_patch_request(&text) {
        return json!({
            "kind": "approval", "action": "apply_json_patch", "args": json_patch,
            "intro": "我已根据你的描述生成 JSON 补丁预览，确认后才会写入文件。",
            "plan": ["解析目标 JSON 文件与字段路径", "生成修改前后 diff", "等待用户审批后写入文件"],
            "title": null,
            "risk": "审批通过后会写入项目文件；写入前已确认目标文件是合法 JSON。",
            "outro": "请在审批卡片中查看 diff。确认无误后点同意，我再应用补丁。",
        });
    }
    if let Some(text_replace) = extract_text_replace_request(&text) {
        return json!({
            "kind": "approval", "action": "apply_text_replace", "args": text_replace,
            "intro": "我已生成文本替换补丁预览，确认后才会写入文件。",
            "plan": ["定位目标文本文件", "生成替换前后 diff", "等待用户审批后写入文件"],
            "title": null, "risk": null,
            "outro": "请在审批卡片中查看 diff。确认无误后点同意，我再应用文本补丁。",
        });
    }
    if let Some(command) = infer_command_approval(&text) {
        return json!({
            "kind": "approval", "action": "run_command", "args": command.get("args").cloned().unwrap_or(json!({})),
            "intro": "这一步需要执行本地命令，我先生成审批请求，确认后再运行。",
            "plan": ["确认命令与影响范围", "等待用户审批", "执行命令并回填输出"],
            "title": command.get("title").cloned().unwrap_or(Value::Null),
            "risk": command.get("risk").cloned().unwrap_or(Value::Null),
            "outro": "请在审批卡片中选择同意或拒绝。当前仅允许预置安全命令，不会执行任意 shell 文本。",
        });
    }

    // 只读分析：抽取可读路径（存在才用）
    let readable_path = extract_readable_path(&text, root).await;
    let html_id = if wants_html_page_context(&text) {
        extract_html_page_id(&text)
    } else {
        String::new()
    };
    let wants_html = wants_html_page_context(&text);
    json!({
        "kind": "analysis",
        "intro": "我先按只读方式查看项目上下文，尽量把定位结果和下一步动作说清楚。",
        "plan": default_plan(),
        "wantsDefinitions": cached_re!(WANTS_DEF, r"(?i)定义|字典|单据|metadata|meta|definition").is_match(&text),
        "wantsHtmlPages": wants_html,
        "htmlPagesFilter": if wants_html { json!({ "page": 1, "pageSize": 20 }) } else { Value::Null },
        "readHtmlPage": if !html_id.is_empty() { json!({ "id": html_id }) } else { Value::Null },
        "wantsValidate": cached_re!(WANTS_VAL, r"(?i)校验|验证|validate|检查").is_match(&text),
        "readFile": if !readable_path.is_empty() { json!({ "path": readable_path }) } else { Value::Null },
        "search": if readable_path.is_empty() { json!({ "query": guess_search_query(&text), "limit": 20 }) } else { Value::Null },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_user_text_picks_most_recent_user() {
        let msgs = json!([
            { "role": "user", "content": "旧的" },
            { "role": "assistant", "content": "回复" },
            { "role": "user", "content": "  新的提问  " },
        ]);
        let arr: Vec<Value> = msgs.as_array().unwrap().clone();
        assert_eq!(latest_user_text(&arr), "新的提问");
    }

    #[test]
    fn latest_user_text_empty_or_no_user() {
        assert_eq!(latest_user_text(&[]), "");
        let arr: Vec<Value> = json!([{ "role": "assistant", "content": "x" }])
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(latest_user_text(&arr), "");
    }
}
