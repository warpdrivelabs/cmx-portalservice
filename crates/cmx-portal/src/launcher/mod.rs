//! launcher：把「自然语言意图」解析成「可直接打开的功能」。
//!
//! 功能目录来源 = 所有 menu-pages 里 `type:"workspace-node"` 的菜单项（每项内联 `workspace`，
//! 可被前端 openWorkspaceNode 直接打开）。AI 助手浮窗说「我要录入凭证」即调 resolve：
//! - 先把功能清单(id+caption+keywords，**不含 workspace 正文**)喂给 AI(json 模式)选最佳匹配；
//! - AI 未配置/失败 → 纯关键词规则兜底；
//! - 命中后从菜单里取出该项**完整 workspace** 一并返回，前端据此打开。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai;
use crate::error::{PortalError, PortalResult};
use crate::meta::menu_pages::get_menu_page_json;

/// 功能目录项（轻量，供匹配 + 展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherItem {
    /// 功能项唯一标识（取自菜单节点 id）。
    pub id: String,
    /// 展示标题（取自菜单节点 caption，回退 name）。
    pub caption: String,
    /// 图标名（取自菜单节点 icon，可能为空）。
    pub icon: String,
    /// 该项来自哪个菜单文件（点分 menuRef），用于二次取完整 workspace。
    pub menu_ref: String,
    /// 关键词（caption 分词 + 同义词），供规则兜底与提示。
    pub keywords: Vec<String>,
}

/// resolve 入参。
#[derive(Debug, Clone, Deserialize)]
pub struct ResolveInput {
    /// 用户输入的自然语言意图描述。
    #[serde(default)]
    pub query: String,
}

/// 所有 menu-pages 文件的点分 menuRef。
///
/// 当前固定枚举（与 data/menu-pages 对齐）；未来菜单增多可改为扫描目录。
/// 保持与 get_menu_page_json 的 menuRef 语义一致。
const MENU_REFS: &[&str] = &[
    "fi.cmxfico.gl.explorer-menu",
    "fi.cmxfico.report.report-menu",
    "basic.dataplatform.mdm.mdm-menu",
];

/// 递归收集一棵菜单树里所有 `type:"workspace-node"` 且带 workspace 的项。
fn collect_nodes(items: &[Value], menu_ref: &str, out: &mut Vec<LauncherItem>) {
    for it in items {
        let is_node = it.get("type").and_then(|v| v.as_str()) == Some("workspace-node");
        let has_ws = it.get("workspace").map(|w| w.is_object()).unwrap_or(false);
        if is_node && has_ws {
            let id = it
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let caption = it
                .get("caption")
                .and_then(|v| v.as_str())
                .or_else(|| it.get("name").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            if !id.is_empty() && !caption.is_empty() {
                out.push(LauncherItem {
                    keywords: derive_keywords(&caption, &id),
                    id,
                    caption,
                    icon: it
                        .get("icon")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    menu_ref: menu_ref.to_string(),
                });
            }
        }
        if let Some(children) = it.get("children").and_then(|v| v.as_array()) {
            collect_nodes(children, menu_ref, out);
        }
    }
}

/// 取出字符串里所有「连续中文」子串（用于在混合 token 内提取中文短语）。
fn split_cjk_runs(s: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            cur.push(c);
        } else if !cur.is_empty() {
            runs.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    runs
}

/// 从 caption / id 派生关键词（去括号注释、按非字母数字切分、对中文短语补 2~4 字 n-gram）。
fn derive_keywords(caption: &str, id: &str) -> Vec<String> {
    let mut kws: Vec<String> = Vec::new();
    // caption 去掉括号内容后整体保留 + 切词
    let base: String = caption
        .chars()
        .filter(|c| !matches!(c, '(' | ')' | '（' | '）'))
        .collect();
    for tok in base.split(|c: char| !c.is_alphanumeric() && !('\u{4e00}'..='\u{9fff}').contains(&c))
    {
        let t = tok.trim();
        if t.chars().count() < 2 {
            continue;
        }
        kws.push(t.to_string());
        // 对 token 内的每一段连续中文再补 2~4 字滑窗 n-gram，
        // 便于「会计核算管理」命中「会计核算」、「ERP凭证…」命中「凭证」。
        for run in split_cjk_runs(t) {
            let chars: Vec<char> = run.chars().collect();
            if chars.len() >= 2 {
                kws.push(run.clone());
            }
            if chars.len() > 2 {
                for n in 2..=4usize.min(chars.len().saturating_sub(1)) {
                    for w in chars.windows(n) {
                        kws.push(w.iter().collect());
                    }
                }
            }
        }
    }
    // id 的连字符段
    for seg in id.split(['-', '_', '.']) {
        if seg.len() >= 2 {
            kws.push(seg.to_string());
        }
    }
    kws.push(caption.to_string());
    kws.sort();
    kws.dedup();
    kws
}

/// 列出全部可打开功能（轻量目录）。
///
/// # Returns
///
/// 功能目录列表（已按 id 去重，同 id 取第一个）。
///
/// # Errors
///
/// 数据库读取失败时返回底层错误。
pub async fn list_catalog() -> PortalResult<Vec<LauncherItem>> {
    let mut out: Vec<LauncherItem> = Vec::new();
    for menu_ref in MENU_REFS {
        // 从 cmx_menu 数据库回源（替代原 menu-pages 文件读取）
        let doc = get_menu_page_json(menu_ref).await?;
        if let Some(items) = doc.get("items").and_then(|v| v.as_array()) {
            collect_nodes(items, menu_ref, &mut out);
        }
    }
    // 去重（同 id 取第一个）
    let mut seen = std::collections::HashSet::new();
    out.retain(|x| seen.insert(x.id.clone()));
    Ok(out)
}

/// 从菜单（cmx_menu 数据库回源）里按 id 取出某功能项的**完整**节点（含 workspace）。
///
/// # Arguments
///
/// * `menu_ref` - 点分菜单引用，用于定位菜单。
/// * `id` - 目标功能项 id。
///
/// # Returns
///
/// 找到时返回 `Some(完整节点)`；未命中时返回 `None`。
///
/// # Errors
///
/// 数据库读取失败时返回底层错误。
async fn find_full_node(menu_ref: &str, id: &str) -> PortalResult<Option<Value>> {
    // 从 cmx_menu 数据库回源（替代原 menu-pages 文件读取）
    let doc = get_menu_page_json(menu_ref).await?;
    fn dfs(items: &[Value], id: &str) -> Option<Value> {
        for it in items {
            if it.get("id").and_then(|v| v.as_str()) == Some(id) {
                return Some(it.clone());
            }
            if let Some(ch) = it.get("children").and_then(|v| v.as_array())
                && let Some(found) = dfs(ch, id)
            {
                return Some(found);
            }
        }
        None
    }
    Ok(doc
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|items| dfs(items, id)))
}

/// 规则兜底匹配：query 与各项 caption/keywords 的字符重叠打分，取最高。
fn rule_match<'a>(query: &str, catalog: &'a [LauncherItem]) -> Option<(&'a LauncherItem, f64)> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    let mut best: Option<(&LauncherItem, f64)> = None;
    for item in catalog {
        let mut score = 0.0;
        // caption 直接包含 query 或反之
        if item.caption.contains(q) || q.contains(&item.caption) {
            score += 5.0;
        }
        for kw in &item.keywords {
            if kw.is_empty() {
                continue;
            }
            if q.contains(kw.as_str()) {
                // 越长的关键词命中越可信
                score += 1.0 + (kw.chars().count() as f64) * 0.4;
            }
        }
        if score > 0.0 && best.as_ref().map(|(_, s)| score > *s).unwrap_or(true) {
            best = Some((item, score));
        }
    }
    best
}

/// 让 AI 从功能清单里选最匹配 query 的 id（json 模式）。返回 (id, confidence, reason)。
///
/// # Arguments
///
/// * `query` - 用户自然语言意图描述。
/// * `catalog` - 可选功能目录清单（仅传 id/caption/keywords 给 AI）。
///
/// # Returns
///
/// AI 未配置或未命中时返回 `Ok(None)`；命中时返回 `Ok(Some((id, confidence, reason)))`。
///
/// # Errors
///
/// AI 请求失败或返回非法 JSON 时返回对应错误。
async fn ai_match(
    query: &str,
    catalog: &[LauncherItem],
) -> PortalResult<Option<(String, f64, String)>> {
    if !ai::is_configured() {
        return Ok(None);
    }
    // 只给 id + caption + keywords，控制 token。
    let list: Vec<Value> = catalog
        .iter()
        .map(|i| json!({ "id": i.id, "caption": i.caption, "keywords": i.keywords }))
        .collect();
    let sys = "你是门户功能启动助手。用户会用自然语言描述想做的事，你要从给定的功能清单里选出**唯一最匹配**的一项。\
        只能从清单的 id 中选择；若没有合适项，id 返回空字符串。\
        必须只输出 JSON：{\"id\":\"<功能id或空>\",\"confidence\":<0~1小数>,\"reason\":\"<简短中文理由>\"}。";
    let user = json!({ "query": query, "functions": list });
    let messages = json!([
        { "role": "system", "content": sys },
        { "role": "user", "content": user.to_string() },
    ]);
    let raw = ai::raw_chat_completion(messages, true, 0.0).await?;
    let parsed: Value = serde_json::from_str(raw.trim()).map_err(|e| {
        PortalError::business(format!(
            "AI 返回非法 JSON：{e}；原文：{}",
            raw.chars().take(200).collect::<String>()
        ))
    })?;
    let id = parsed
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Ok(None);
    }
    let confidence = parsed
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.6);
    let reason = parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 防 AI 编造不存在的 id
    if !catalog.iter().any(|c| c.id == id) {
        return Ok(None);
    }
    Ok(Some((id, confidence, reason)))
}

/// 解析意图 → 命中的功能（含完整 workspace 节点），供前端直接打开。
///
/// # Arguments
///
/// * `input` - 解析入参，包含用户自然语言 query。
///
/// # Returns
///
/// - 命中：`{ matched:true, id, caption, icon, confidence, reason, source, node:{...} }`
/// - 未命中：`{ matched:false, query, candidates:[{id,caption}...] }`（给前端兜底提示/选择）
///
/// # Errors
///
/// query 为空返回 `bad_request`；加载目录或读取完整节点失败时返回底层错误。
pub async fn resolve(input: ResolveInput) -> PortalResult<Value> {
    let query = input.query.trim().to_string();
    if query.is_empty() {
        return Err(PortalError::bad_request("query 不能为空"));
    }
    let catalog = list_catalog().await?;
    if catalog.is_empty() {
        return Ok(json!({ "matched": false, "query": query, "candidates": [] }));
    }

    // 1) AI 语义匹配优先
    let mut hit: Option<(String, f64, String, &'static str)> = None;
    match ai_match(&query, &catalog).await {
        Ok(Some((id, conf, reason))) => hit = Some((id, conf, reason, "ai")),
        Ok(None) => {}
        Err(e) => tracing::warn!("[launcher] AI 匹配失败，回退规则：{e}"),
    }
    // 2) 规则兜底
    if hit.is_none()
        && let Some((item, score)) = rule_match(&query, &catalog)
    {
        // 把分数归一到 0~1 的粗略置信
        let conf = (score / 8.0).min(0.95);
        hit = Some((item.id.clone(), conf, "关键词匹配".to_string(), "rule"));
    }

    let Some((id, confidence, reason, source)) = hit else {
        // 未命中：返回少量候选给前端做提示
        let candidates: Vec<Value> = catalog
            .iter()
            .take(8)
            .map(|i| json!({ "id": i.id, "caption": i.caption }))
            .collect();
        return Ok(json!({ "matched": false, "query": query, "candidates": candidates }));
    };

    let item = catalog.iter().find(|c| c.id == id).cloned();
    let (caption, icon, menu_ref) = item
        .as_ref()
        .map(|i| (i.caption.clone(), i.icon.clone(), i.menu_ref.clone()))
        .unwrap_or_default();
    let node = find_full_node(&menu_ref, &id).await?;
    let Some(node) = node else {
        return Ok(json!({ "matched": false, "query": query, "candidates": [] }));
    };

    Ok(json!({
        "matched": true,
        "id": id,
        "caption": caption,
        "icon": icon,
        "confidence": confidence,
        "reason": reason,
        "source": source,
        "node": node,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keywords_and_rule_match() {
        let catalog = vec![
            LauncherItem {
                id: "fi-gl-fico-ws".into(),
                caption: "ERP凭证(三区工作台)".into(),
                icon: "".into(),
                menu_ref: "m".into(),
                keywords: derive_keywords("ERP凭证(三区工作台)", "fi-gl-fico-ws"),
            },
            LauncherItem {
                id: "fi-gl-acct-ws".into(),
                caption: "会计核算管理".into(),
                icon: "".into(),
                menu_ref: "m".into(),
                keywords: derive_keywords("会计核算管理", "fi-gl-acct-ws"),
            },
        ];
        // “录入凭证” 应命中含“凭证”的项
        let (hit, _score) = rule_match("我要录入凭证", &catalog).expect("应命中");
        assert_eq!(hit.id, "fi-gl-fico-ws");
        // “会计核算” 命中另一项
        let (hit2, _) = rule_match("打开会计核算", &catalog).expect("应命中");
        assert_eq!(hit2.id, "fi-gl-acct-ws");
        // 完全不相关 → 无命中
        assert!(rule_match("今天天气怎么样", &catalog).is_none());
    }
}
