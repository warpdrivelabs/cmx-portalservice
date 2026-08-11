//! Agent 流程总结：基于工具事件生成简洁中文总结。
//!
//! - [`build_summary`]：对外入口，LLM 可用时流式生成，失败回退本地规则总结。
//! - [`build_local_summary`]：纯本地规则总结（无 LLM 依赖）。
//! - [`llm_summary`]：调用 LLM 流式接口生成总结。

use serde_json::{Value, json};

use crate::error::PortalResult;

/// 本地规则总结（无 LLM 时）：聚合 tool_result 事件，按成败分别组织文案。
pub(super) fn build_local_summary(events: &[Value], context: &Value) -> String {
    let results: Vec<&Value> = events
        .iter()
        .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
        .collect();
    let failed: Vec<&&Value> = results
        .iter()
        .filter(|e| e.get("status").and_then(|v| v.as_str()) == Some("error"))
        .collect();
    let ok: Vec<&&Value> = results
        .iter()
        .filter(|e| e.get("status").and_then(|v| v.as_str()) != Some("error"))
        .collect();
    let ctx_title = context
        .get("workspaceTitle")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|t| format!("当前工作区：{t}。\n"))
        .unwrap_or_default();
    if !failed.is_empty() && ok.is_empty() {
        let msgs: Vec<String> = failed
            .iter()
            .map(|e| {
                e.get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        return format!("{ctx_title}工具调用失败：{}。", msgs.join("；"));
    }
    let lines: Vec<String> = ok
        .iter()
        .map(|e| {
            format!(
                "- {}",
                e.get("summary").and_then(|v| v.as_str()).unwrap_or("")
            )
        })
        .collect();
    format!(
        "{ctx_title}已完成这轮只读分析：\n{}\n\n目前这个 Agent Gateway 已具备对话协议、计划、工具调用和结果展示；写文件、运行命令、审批流可以在这个协议上继续扩展。",
        lines.join("\n")
    )
}

/// 生成 agent 流程总结。LLM 可用时流式生成（`on_delta` 逐 token 回调），失败回退本地总结。
///
/// # Arguments
///
/// * `events` - agent 流程产生的事件列表。
/// * `context` - 门户上下文 JSON 对象。
/// * `messages` - 消息数组。
/// * `on_delta` - token 增量回调。
///
/// # Returns
///
/// 返回中文总结文本。
pub async fn build_summary<F>(
    events: &[Value],
    context: &Value,
    messages: &[Value],
    on_delta: F,
) -> String
where
    F: FnMut(&str),
{
    if std::env::var("CMX_AGENT_PLANNER").ok().as_deref() == Some("llm")
        && crate::ai::is_configured()
    {
        match llm_summary(events, context, messages, on_delta).await {
            Ok(s) => return s,
            Err(e) => tracing::warn!("[agentPlanner] LLM 总结失败，回退本地：{e}"),
        }
    }
    build_local_summary(events, context)
}

/// 调用 LLM 流式接口生成中文总结。
///
/// # Arguments
///
/// * `events` - agent 流程产生的事件列表。
/// * `context` - 门户上下文 JSON 对象。
/// * `messages` - 消息数组。
/// * `on_delta` - token 增量回调。
///
/// # Returns
///
/// 成功时返回流式拼接的中文总结文本（最多 6000 字符）。
///
/// # Errors
///
/// 当 LLM 流式请求失败或上游未返回有效回复时返回 `PortalError`。
async fn llm_summary<F>(
    events: &[Value],
    context: &Value,
    messages: &[Value],
    on_delta: F,
) -> PortalResult<String>
where
    F: FnMut(&str),
{
    // 压缩工具事件（截断大字段）
    let tool_events: Vec<Value> = events
        .iter()
        .filter(|e| matches!(e.get("type").and_then(|v| v.as_str()), Some("tool_call" | "tool_result")))
        .map(|e| {
            let mut data = e.get("data").cloned().unwrap_or(Value::Null);
            if let Some(obj) = data.as_object_mut() {
                for (k, max) in [("content", 12000usize), ("html", 12000), ("stdout", 12000), ("stderr", 12000)] {
                    if let Some(s) = obj.get(k).and_then(|v| v.as_str()) {
                        obj.insert(k.to_string(), json!(s.chars().take(max).collect::<String>()));
                    }
                }
            }
            json!({ "type": e.get("type"), "name": e.get("name"), "status": e.get("status"), "summary": e.get("summary"), "args": e.get("args"), "data": data })
        })
        .collect();
    let recent: Vec<Value> = messages.iter().rev().take(8).rev().map(|m| json!({ "role": m.get("role"), "content": m.get("content").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect::<String>() })).collect();
    let user = serde_json::to_string_pretty(
        &json!({ "context": context, "messages": recent, "toolEvents": tool_events }),
    )
    .unwrap_or_default();
    let req = json!([
        { "role": "system", "content": "你是 CMXPortalManager 网页 Agent。请基于工具结果用简洁中文总结，指出关键文件/发现/下一步。不要编造工具结果，不要要求用户复制文件。" },
        { "role": "user", "content": user },
    ]);
    let content = crate::ai::stream_chat_completion(req, 0.2, on_delta).await?;
    Ok(content.trim().chars().take(6000).collect())
}
