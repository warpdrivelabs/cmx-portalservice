//! AI 对话中继（复刻 portalManagerService `requestAiChatCompletion`）。
//!
//! 把前端 messages + context 转发到 OpenAI 兼容服务（默认 DeepSeek），返回 assistant 回复。
//! 配置环境变量：CMX_AI_BASE_URL / CMX_AI_API_KEY|DEEPSEEK_API_KEY / CMX_AI_MODEL /
//! CMX_AI_TIMEOUT_MS / CMX_AI_MAX_HISTORY / CMX_AI_SYSTEM_PROMPT。

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::RequestBuilder;
use serde_json::{Value, json};

use crate::error::{PortalError, PortalResult};

/// 单例 HTTP 客户端（复用连接池 keep-alive，避免每次请求重新 TLS 握手）。
fn ai_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_millis(ai_timeout_ms()))
            .build()
            .expect("AI HTTP 客户端初始化不应失败")
    })
}

/// 读取上游错误响应体为 JSON；解析失败不阻塞错误构造，仅记录告警。
async fn error_body(resp: reqwest::Response) -> Value {
    match resp.json::<Value>().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "上游错误响应体非合法 JSON，按空对象处理");
            Value::Object(serde_json::Map::new())
        }
    }
}
///
/// 4xx（除 429 外）视为不可重试错误，直接返回响应由调用方按状态码处理。
/// 连接/超时类 `reqwest::Error` 也会重试——上游抖动常见于此。
async fn send_with_retry(req: RequestBuilder) -> PortalResult<reqwest::Response> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let res = req
            .try_clone()
            .ok_or_else(|| PortalError::business("AI 请求不可重试（body 非可克隆流）"))?
            .send()
            .await;
        match res {
            Ok(r) => {
                let code = r.status().as_u16();
                let retryable = code == 429 || (500..600).contains(&code);
                if retryable && attempt < MAX_ATTEMPTS {
                    let backoff = 500u64 * 2u64.pow(attempt - 1);
                    tracing::warn!(
                        code = code,
                        attempt = attempt,
                        backoff_ms = backoff,
                        "AI 上游返回可重试状态码，退避后重试"
                    );
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    continue;
                }
                return Ok(r);
            }
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    let backoff = 500u64 * 2u64.pow(attempt - 1);
                    tracing::warn!(error = %e, attempt = attempt, backoff_ms = backoff, "AI 请求发送失败，退避后重试");
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    continue;
                }
                return Err(if e.is_timeout() {
                    PortalError::business("AI 服务请求超时")
                } else {
                    PortalError::business(format!("AI 服务请求失败：{e}"))
                });
            }
        }
    }
}

/// 返回 AI 服务的 base URL（CMX_AI_BASE_URL，默认 DeepSeek）。
fn ai_base_url() -> String {
    std::env::var("CMX_AI_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// 返回 AI 模型名（CMX_AI_MODEL，默认 deepseek-v4-flash）。
fn ai_model() -> String {
    std::env::var("CMX_AI_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".to_string())
}

/// 返回 AI 请求超时毫秒（CMX_AI_TIMEOUT_MS，下限 1000）。
fn ai_timeout_ms() -> u64 {
    std::env::var("CMX_AI_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30000)
        .max(1000)
}

/// 返回 AI 最大历史消息数（CMX_AI_MAX_HISTORY，范围 1..=50）。
fn ai_max_history() -> usize {
    std::env::var("CMX_AI_MAX_HISTORY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
        .clamp(1, 50)
}

/// 返回 AI 系统提示词（CMX_AI_SYSTEM_PROMPT，默认 CMXPortalManager 助手）。
fn ai_system_prompt() -> String {
    std::env::var("CMX_AI_SYSTEM_PROMPT").unwrap_or_else(|_| {
        "你是 CMXPortalManager 的 AI 助手。请使用简洁、准确的中文回答用户问题，必要时结合传入的门户工作区上下文。".to_string()
    })
}

/// 取 AI API Key（CMX_AI_API_KEY 优先，DEEPSEEK_API_KEY 兜底）。
pub fn ai_api_key() -> String {
    std::env::var("CMX_AI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok())
        .unwrap_or_default()
}

/// 是否已配置 AI 服务。
pub fn is_configured() -> bool {
    !ai_api_key().is_empty()
}

/// 调用 OpenAI 兼容 chat/completions，返回 assistant 文本（供 agent LlmPlanner 复用）。
///
/// `messages` 为完整消息数组（含 system）。`json_mode` 为 true 时请求 `response_format: json_object`。
///
/// # Arguments
///
/// * `messages` - 完整消息数组（含 system 消息）。
/// * `json_mode` - 是否请求 JSON 对象响应格式。
/// * `temperature` - 采样温度。
///
/// # Returns
///
/// 成功时返回 assistant 文本内容。
///
/// # Errors
///
/// 当 AI 服务未配置、请求失败或上游未返回有效回复时返回 `PortalError`。
#[tracing::instrument(skip(messages))]
pub async fn raw_chat_completion(
    messages: Value,
    json_mode: bool,
    temperature: f64,
) -> PortalResult<String> {
    if !is_configured() {
        return Err(PortalError::business("AI 服务未配置"));
    }
    let mut payload = serde_json::json!({
        "model": ai_model(),
        "messages": messages,
        "temperature": temperature,
    });
    if json_mode {
        payload
            .as_object_mut()
            .expect("payload 由 json! 宏构造，必为 object")
            .insert(
                "response_format".to_string(),
                serde_json::json!({ "type": "json_object" }),
            );
    }
    let resp = send_with_retry(
        ai_client()
            .post(format!("{}/chat/completions", ai_base_url()))
            .bearer_auth(ai_api_key())
            .json(&payload),
    )
    .await?;
    let status = resp.status();
    let data: Value = error_body(resp).await;
    if !status.is_success() {
        let msg = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("上游 AI 服务返回 {}", status.as_u16()));
        return Err(PortalError::business(msg));
    }
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    content
        .map(|s| s.to_string())
        .ok_or_else(|| PortalError::business("上游 AI 服务没有返回有效回复"))
}

/// 流式调用 OpenAI 兼容 chat/completions（DeepSeek `stream:true`）。
///
/// 每收到一个 token 增量即调用 `on_delta(&str)`，返回拼接后的完整文本。用于 agent 逐字输出。
/// 任一环节失败返回 Err（调用方可回退到非流式或本地总结）。
///
/// # Arguments
///
/// * `messages` - 完整消息数组（含 system 消息）。
/// * `temperature` - 采样温度。
/// * `on_delta` - 每收到一个 token 增量时调用的回调。
///
/// # Returns
///
/// 成功时返回拼接后的完整 assistant 文本。
///
/// # Errors
///
/// 当 AI 服务未配置、请求失败或上游未返回有效回复时返回 `PortalError`。
#[tracing::instrument(skip(messages, on_delta))]
pub async fn stream_chat_completion<F>(
    messages: Value,
    temperature: f64,
    mut on_delta: F,
) -> PortalResult<String>
where
    F: FnMut(&str),
{
    use futures_util::StreamExt;

    if !is_configured() {
        return Err(PortalError::business("AI 服务未配置"));
    }
    let payload = serde_json::json!({
        "model": ai_model(),
        "messages": messages,
        "temperature": temperature,
        "stream": true,
    });
    let resp = send_with_retry(
        ai_client()
            .post(format!("{}/chat/completions", ai_base_url()))
            .bearer_auth(ai_api_key())
            .json(&payload),
    )
    .await?;
    let status = resp.status();
    if !status.is_success() {
        let data: Value = error_body(resp).await;
        let msg = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("上游 AI 服务返回 {}", status.as_u16()));
        return Err(PortalError::business(msg));
    }

    // SSE 解析：字节缓冲累积，按行切分 `data: {...}` / `data: [DONE]`，提取 choices[0].delta.content。
    // 用 Vec<u8> 在换行边界解码，避免 from_utf8_lossy 逐 chunk 解码导致多字节 UTF-8（如中文）跨 chunk 损坏。
    let mut full = String::new();
    let mut bytes_buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| PortalError::business(format!("AI 流读取失败：{e}")))?;
        bytes_buf.extend_from_slice(&bytes);
        // 按换行边界切行；不完整的尾段留在 bytes_buf 等下一 chunk 补齐。
        while let Some(nl) = bytes_buf.iter().position(|&b| b == b'\n') {
            // 先把行内容拷成 owned，再 drain，避免 from_utf8 的不可变借用与 drain 冲突。
            let line = std::str::from_utf8(&bytes_buf[..nl])
                .unwrap_or("")
                .trim()
                .to_string();
            bytes_buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data)
                && let Some(delta) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|s| s.as_str())
                && !delta.is_empty()
            {
                full.push_str(delta);
                on_delta(delta);
            }
        }
    }
    if full.trim().is_empty() {
        return Err(PortalError::business("上游 AI 服务没有返回有效回复"));
    }
    Ok(full)
}

/// 把门户上下文序列化为文本（最多 20 项 / 4000 字符）。
fn serialize_ai_context(context: Option<&Value>) -> String {
    let Some(Value::Object(map)) = context else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in map.iter().take(20) {
        let empty = v.is_null() || v == "";
        if empty {
            continue;
        }
        let vs = match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        parts.push(format!("{k}: {vs}"));
    }
    let mut joined = parts.join("\n");
    if joined.chars().count() > 4000 {
        joined = joined.chars().take(4000).collect();
    }
    joined
}

/// 截断字符串到指定字符数。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 执行 AI 对话补全。body 形如 `{ messages:[{role,content}], context?, model? }`。
///
/// # Arguments
///
/// * `body` - 请求体，包含 messages、可选 context 与 model。
///
/// # Returns
///
/// 成功时返回包含 id、model、message、usage 的 JSON 对象。
///
/// # Errors
///
/// 当 AI 服务未配置、messages 为空、请求失败或上游未返回有效回复时返回 `PortalError`。
#[tracing::instrument(skip(body))]
pub async fn chat(body: &Value) -> PortalResult<Value> {
    if !is_configured() {
        return Err(PortalError::business(
            "AI 服务未配置：请设置 CMX_AI_API_KEY 或 DEEPSEEK_API_KEY".to_string(),
        ));
    }
    let raw_messages = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_messages.is_empty() {
        return Err(PortalError::bad_request("messages 不能为空"));
    }
    let max_hist = ai_max_history();
    // 过滤合法 role + 截断 content + 取最近 N 条
    let filtered: Vec<Value> = raw_messages
        .iter()
        .filter(|m| matches!(m.get("role").and_then(|v| v.as_str()), Some("user" | "assistant" | "system")))
        .map(|m| {
            json!({
                "role": m.get("role").and_then(|v| v.as_str()).unwrap_or("user"),
                "content": truncate_chars(&m.get("content").map(|c| match c { Value::String(s) => s.clone(), o => o.to_string() }).unwrap_or_default(), 8000),
            })
        })
        .collect();
    let safe_messages: Vec<Value> = if filtered.len() > max_hist {
        filtered[filtered.len() - max_hist..].to_vec()
    } else {
        filtered
    };

    let context_text = serialize_ai_context(body.get("context"));
    let system_content = if context_text.is_empty() {
        ai_system_prompt()
    } else {
        format!(
            "{}\n\n当前门户上下文：\n{}",
            ai_system_prompt(),
            context_text
        )
    };
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(ai_model);

    let mut messages = vec![json!({ "role": "system", "content": system_content })];
    messages.extend(
        safe_messages
            .into_iter()
            .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some("system")),
    );

    let payload = json!({ "model": model, "messages": messages, "temperature": 0.7 });

    let resp = send_with_retry(
        ai_client()
            .post(format!("{}/chat/completions", ai_base_url()))
            .bearer_auth(ai_api_key())
            .json(&payload),
    )
    .await?;

    let status = resp.status();
    let data: Value = error_body(resp).await;
    if !status.is_success() {
        let msg = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| data.get("message").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("上游 AI 服务返回 {}", status.as_u16()));
        return Err(PortalError::business(msg));
    }
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    let Some(content) = content else {
        return Err(PortalError::business("上游 AI 服务没有返回有效回复"));
    };
    Ok(json!({
        "id": data.get("id").cloned().unwrap_or(Value::Null),
        "model": data.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or(model),
        "message": { "role": "assistant", "content": content },
        "usage": data.get("usage").cloned().unwrap_or(Value::Null),
    }))
}
