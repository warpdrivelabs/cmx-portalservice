//! LlmPlanner：调用 LLM（DeepSeek）把用户请求转成归一后的 decision JSON。
//!
//! 仅当 CMX_AGENT_PLANNER=llm 且 AI 服务已配置时启用；失败时由 [`super`] 的 plan 回退到本地规则。

use serde_json::{Value, json};

use crate::error::PortalResult;

use super::{default_plan, value_to_string};

/// Planner 系统提示词（复刻 Node buildPlannerSystemPrompt，含工具 schema + 安全规则）。
///
/// 支持环境变量 `CMX_AGENT_PLANNER_PROMPT` 覆盖：设置时以其值作为完整提示词（不再注入工具
/// schema，便于运维自定义）；未设置时用内置默认模板并自动拼接当前可用工具 schema。
pub(super) fn planner_system_prompt() -> String {
    if let Ok(p) = std::env::var("CMX_AGENT_PLANNER_PROMPT") {
        let p = p.trim();
        if !p.is_empty() {
            return p.to_string();
        }
    }
    let tools = crate::agent::schemas::public_tool_schemas();
    format!(
        r#"你是 CMXPortalManager 网页 Agent 的 Planner。你只输出 JSON，不要输出 Markdown。

你的任务是把用户请求转换为一个 decision。不要执行工具，不要编造工具结果。

允许的 JSON 格式：
1. 只读分析：
{{
  "kind": "analysis",
  "intro": "简短中文说明",
  "plan": ["步骤1", "步骤2"],
  "wantsDefinitions": false,
  "wantsHtmlPages": false,
  "htmlPagesFilter": {{"domain": "fi", "app":"cmxfico","module":"gl", "page": 1, "pageSize": 20}} 或 null,
  "readHtmlPage": {{"id": "page.id"}} 或 null,
  "wantsValidate": false,
  "readFile": {{"path": "relative/file.js"}} 或 null,
  "search": {{"query": "keyword", "limit": 20}} 或 null
}}

2. 需要审批的操作：
{{
  "kind": "approval",
  "action": "run_command" | "apply_json_patch" | "apply_text_replace",
  "args": {{}},
  "intro": "简短中文说明",
  "plan": ["步骤1", "步骤2"],
  "title": "审批标题",
  "risk": "风险说明",
  "outro": "提示用户审批"
}}

安全规则：
- 写文件只能使用 apply_json_patch 或 apply_text_replace。
- 命令只能使用 run_command，且只能请求 npm run lint/build -w cmx-portal-manager。
- 不要请求任意 shell，不要请求删除文件，不要越过审批。
- 文件路径必须是相对 CMXPortalManager 根目录的相对路径。
- 用户提到自定义页面、HTML 页面、页面设计器、html_pages 时，优先使用 wantsHtmlPages/readHtmlPage。
- 不确定时选择 analysis + search。

可用工具 schema：
{tools}"#,
        tools = serde_json::to_string_pretty(&tools).unwrap_or_default()
    )
}

/// 从 LLM 文本里抽取 JSON（容错：截首个 `{` 到末个 `}`）。
pub(super) fn parse_planner_json(content: &str) -> Option<Value> {
    let text = content.trim();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        serde_json::from_str::<Value>(&text[start..=end]).ok()
    } else {
        None
    }
}

/// 取字符串值，空则返回兜底值。
fn string_or(v: Option<&Value>, fallback: &str) -> String {
    let s = v.map(value_to_string).unwrap_or_default();
    let s = s.trim();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s.to_string()
    }
}

/// 取字符串数组值，空或非法则返回兜底值。
fn string_array_or(v: Option<&Value>, fallback: Value) -> Value {
    match v.and_then(|x| x.as_array()) {
        Some(arr) => {
            let items: Vec<Value> = arr
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.trim()))
                .filter(|s| !s.is_empty())
                .take(8)
                .map(|s| json!(s))
                .collect();
            if items.is_empty() {
                fallback
            } else {
                Value::Array(items)
            }
        }
        None => fallback,
    }
}

/// 可选对象：required 键须为非空字符串，否则 null。
fn normalize_optional_object(v: Option<&Value>, required: &[&str]) -> Value {
    let Some(obj) = v.filter(|x| x.is_object()) else {
        return Value::Null;
    };
    for key in required {
        let ok = obj
            .get(*key)
            .map(value_to_string)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !ok {
            return Value::Null;
        }
    }
    obj.clone()
}

/// 从 args 中提取白名单键构造新对象。
fn passthrough_object(args: &Value, allowed_keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for key in allowed_keys {
        if let Some(v) = args.get(*key) {
            out.insert((*key).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

/// 校验审批 args（命令白名单 / patch 必填字段）；非法时 Err。
pub(super) fn normalize_approval_args(action: &str, args: Option<&Value>) -> Result<Value, String> {
    let args = args
        .filter(|v| v.is_object())
        .ok_or_else(|| "approval args must be an object".to_string())?;
    match action {
        "run_command" => {
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let argv: Vec<String> = args
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().map(value_to_string).collect())
                .unwrap_or_default();
            let joined = std::iter::once(command.to_string())
                .chain(argv.clone())
                .collect::<Vec<_>>()
                .join(" ");
            if joined == "npm run lint -w cmx-portal-manager" {
                Ok(json!({ "command": command, "args": argv }))
            } else if joined == "npm run build -w cmx-portal-manager" {
                Ok(json!({ "command": command, "args": argv, "timeoutMs": 120000 }))
            } else if matches!(
                joined.as_str(),
                "npm run build:runtime"
                    | "npm run build:portal"
                    | "npm run build:html"
                    | "npm run build:apps"
                    | "cargo check"
                    | "cargo build"
                    | "cargo test"
                    | "cargo clippy -- -D warnings"
                    | "git status --short"
            ) {
                Ok(
                    json!({ "command": command, "args": argv, "timeoutMs": args.get("timeoutMs").cloned().unwrap_or(Value::Null) }),
                )
            } else {
                Err(format!("command is not allowed: {joined}"))
            }
        }
        "apply_json_patch" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let pointer = args
                .get("pointer")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if path.is_empty() || !pointer.starts_with('/') {
                return Err("invalid json patch args".to_string());
            }
            Ok(
                json!({ "path": path, "pointer": pointer, "value": args.get("value").cloned().unwrap_or(Value::Null) }),
            )
        }
        "apply_text_replace" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
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
            if path.is_empty() || old_text.is_empty() {
                return Err("invalid text replace args".to_string());
            }
            let occ = if args.get("occurrence").and_then(|v| v.as_str()) == Some("all") {
                "all"
            } else {
                "first"
            };
            Ok(json!({ "path": path, "oldText": old_text, "newText": new_text, "occurrence": occ }))
        }
        "cargo_check" | "cargo_build" | "cargo_test" | "cargo_clippy" => {
            Ok(passthrough_object(args, &["package", "test", "timeoutMs"]))
        }
        "npm_test" | "npm_build_workspace" => Ok(passthrough_object(
            args,
            &["workspace", "script", "timeoutMs"],
        )),
        "run_playwright" => Ok(passthrough_object(args, &["project", "grep", "timeoutMs"])),
        "capture_page_screenshot" | "inspect_dom" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("browser tool requires http(s) url".to_string());
            }
            Ok(passthrough_object(
                args,
                &["url", "output", "selector", "timeoutMs"],
            ))
        }
        "check_accessibility" => Ok(passthrough_object(args, &["url", "timeoutMs"])),
        "apply_file_patch" => {
            let patch = args.get("patch").and_then(|v| v.as_str()).unwrap_or("");
            if patch.trim().is_empty() {
                return Err("apply_file_patch requires patch".to_string());
            }
            Ok(json!({ "patch": patch }))
        }
        "format_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                return Err("format_file requires path".to_string());
            }
            Ok(passthrough_object(args, &["path", "timeoutMs"]))
        }
        "create_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                return Err("create_file requires path".to_string());
            }
            Ok(passthrough_object(args, &["path", "content", "overwrite"]))
        }
        "rename_file" => {
            let from = args
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("").trim();
            if from.is_empty() || to.is_empty() {
                return Err("rename_file requires from/to".to_string());
            }
            Ok(passthrough_object(args, &["from", "to"]))
        }
        "call_plugin_function" => {
            let plugin_id = args
                .get("pluginId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let function_name = args
                .get("functionName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if plugin_id.is_empty() || function_name.is_empty() {
                return Err("call_plugin_function requires pluginId/functionName".to_string());
            }
            Ok(passthrough_object(
                args,
                &["serviceName", "pluginId", "functionName", "input"],
            ))
        }
        "call_service_flow" => {
            let service_key = args
                .get("serviceKey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if service_key.is_empty() {
                return Err("call_service_flow requires serviceKey".to_string());
            }
            Ok(passthrough_object(
                args,
                &["serviceName", "serviceKey", "input", "timeoutMs"],
            ))
        }
        other => Err(format!("unsupported action: {other}")),
    }
}

/// 归一 LLM decision（防止越权 action / 缺字段）。
pub(super) fn normalize_decision(raw: &Value) -> Result<Value, String> {
    let kind = raw.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "analysis" => Ok(json!({
            "kind": "analysis",
            "intro": string_or(raw.get("intro"), "我先按只读方式查看项目上下文。"),
            "plan": string_array_or(raw.get("plan"), default_plan()),
            "wantsDefinitions": raw.get("wantsDefinitions").and_then(|v| v.as_bool()).unwrap_or(false),
            "wantsHtmlPages": raw.get("wantsHtmlPages").and_then(|v| v.as_bool()).unwrap_or(false),
            "htmlPagesFilter": normalize_optional_object(raw.get("htmlPagesFilter"), &[]),
            "readHtmlPage": normalize_optional_object(raw.get("readHtmlPage"), &["id"]),
            "wantsValidate": raw.get("wantsValidate").and_then(|v| v.as_bool()).unwrap_or(false),
            "readFile": normalize_optional_object(raw.get("readFile"), &["path"]),
            "search": normalize_optional_object(raw.get("search"), &["query"]),
        })),
        "approval" => {
            let action = raw.get("action").and_then(|v| v.as_str()).unwrap_or("");
            if ![
                "run_command",
                "apply_json_patch",
                "apply_text_replace",
                "apply_file_patch",
                "format_file",
                "create_file",
                "rename_file",
                "cargo_check",
                "cargo_build",
                "cargo_test",
                "cargo_clippy",
                "npm_test",
                "npm_build_workspace",
                "run_playwright",
                "capture_page_screenshot",
                "inspect_dom",
                "check_accessibility",
                "call_plugin_function",
                "call_service_flow",
            ]
            .contains(&action)
            {
                return Err(format!("unsafe planner action: {action}"));
            }
            let args = normalize_approval_args(action, raw.get("args"))?;
            Ok(json!({
                "kind": "approval",
                "action": action,
                "args": args,
                "intro": string_or(raw.get("intro"), "这一步需要审批。"),
                "plan": string_array_or(raw.get("plan"), json!(["确认操作", "等待审批", "执行并回填结果"])),
                "title": raw.get("title").filter(|v| !v.is_null()).map(value_to_string).map(Value::String).unwrap_or(Value::Null),
                "risk": raw.get("risk").filter(|v| !v.is_null()).map(value_to_string).map(Value::String).unwrap_or(Value::Null),
                "outro": string_or(raw.get("outro"), "请在审批卡片中选择同意或拒绝。"),
            }))
        }
        other => Err(format!("unsupported planner decision kind: {other}")),
    }
}

/// LLM 规划：调 DeepSeek 出 decision JSON，归一后返回（失败 Err 让上层回退）。
///
/// # Arguments
///
/// * `messages` - 消息数组，取最近 12 条构造请求。
///
/// # Returns
///
/// 成功时返回归一后的 decision JSON 对象。
///
/// # Errors
///
/// 当 LLM 请求失败、未返回 JSON 或归一校验失败时返回 `PortalError`。
pub(super) async fn llm_plan(messages: &[Value]) -> PortalResult<Value> {
    let safe_messages: Vec<Value> = messages
        .iter()
        .rev()
        .take(12)
        .rev()
        .map(|m| json!({ "role": m.get("role").and_then(|v| v.as_str()).unwrap_or("user"), "content": m.get("content").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect::<String>() }))
        .collect();
    let user_prompt =
        serde_json::to_string_pretty(&json!({ "messages": safe_messages })).unwrap_or_default();
    let req_messages = json!([
        { "role": "system", "content": planner_system_prompt() },
        { "role": "user", "content": user_prompt },
    ]);
    let content = crate::ai::raw_chat_completion(req_messages, true, 0.1).await?;
    let raw = parse_planner_json(&content)
        .ok_or_else(|| crate::error::PortalError::business("LLM planner 未返回 JSON"))?;
    normalize_decision(&raw).map_err(crate::error::PortalError::business)
}
