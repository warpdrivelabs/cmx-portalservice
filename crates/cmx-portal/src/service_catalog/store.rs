//! service-catalog store 实现：mini `.bru` 解析器 + 目录遍历 + DAM 分类。

use std::sync::OnceLock;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::data_path;
use crate::error::PortalResult;
use crate::util::is_safe_segment;

/// 预览环境名称（用于展开 urlPreview 的变量）。
const PREVIEW_ENV: &str = "dev";
/// HTTP 方法块名集合（用于识别 .bru 中的请求定义块）。
const METHOD_BLOCKS: &[&str] = &["get", "post", "put", "patch", "delete", "head", "options"];

/// 顶层块 `<name> { ... }`。
struct BruBlock {
    /// 块名（如 meta、get、headers 等）。
    name: String,
    /// 块体文本（花括号内的原始内容）。
    body: String,
}

/// 把 .bru 文本切成顶层块（嵌套 `{}` 用括号配对计数）。
fn split_bru_blocks(text: &str) -> Vec<BruBlock> {
    let s: Vec<char> = text.chars().collect();
    let n = s.len();
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < n {
        while i < n && s[i].is_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        let name_start = i;
        while i < n && s[i] != '{' && !s[i].is_whitespace() {
            i += 1;
        }
        let name: String = s[name_start..i]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        while i < n && s[i] != '{' {
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut depth = 0;
        let body_start = i + 1;
        while i < n {
            if s[i] == '{' {
                depth += 1;
            } else if s[i] == '}' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            i += 1;
        }
        let body: String = s[body_start..i.min(n)].iter().collect();
        i += 1; // skip `}`
        if !name.is_empty() {
            blocks.push(BruBlock { name, body });
        }
    }
    blocks
}

/// 解析 `key: value` 行块（保留顺序，值里允许含冒号）。
fn parse_kv_block(body: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        match line.find(':') {
            None => out.push((line.to_string(), String::new())),
            Some(ci) => {
                let key = line[..ci].trim().to_string();
                let value = line[ci + 1..].trim().to_string();
                if !key.is_empty() {
                    out.push((key, value));
                }
            }
        }
    }
    out
}

/// 将键值对列表转为 JSON 对象。
fn kv_to_object(kv: &[(String, String)]) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    for (k, v) in kv {
        m.insert(k.clone(), json!(v));
    }
    m
}

/// 按键名查找首个匹配的值。
fn kv_get(kv: &[(String, String)], key: &str) -> String {
    kv.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// 原始文本块（body:json / docs）：去首尾空行 + 去公共前导缩进。
fn dedent_raw_block(body: &str) -> String {
    let trimmed = body.trim_matches('\n');
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let mut min = usize::MAX;
    for l in &lines {
        if l.trim().is_empty() {
            continue;
        }
        let indent = l.len() - l.trim_start().len();
        min = min.min(indent);
    }
    if min == usize::MAX || min == 0 {
        return lines.join("\n").trim().to_string();
    }
    lines
        .iter()
        .map(|l| if l.len() >= min { &l[min..] } else { *l })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// 解析单个 .bru 中间结构。
struct Bru {
    /// meta 块解析出的元信息。
    meta: serde_json::Map<String, Value>,
    /// HTTP 方法（大写）。
    method: String,
    /// 请求 URL。
    url: String,
    /// 请求体模式（none/json 等）。
    body_mode: String,
    /// 请求头集合。
    headers: serde_json::Map<String, Value>,
    /// 查询参数列表。
    query: Vec<(String, String)>,
    /// JSON 请求体模板。
    body_json: String,
    /// WebSocket URL。
    ws_url: String,
    /// 文档说明。
    docs: String,
}

/// 解析 .bru 文本为中间结构。
fn parse_bru(text: &str) -> Bru {
    let mut res = Bru {
        meta: serde_json::Map::new(),
        method: String::new(),
        url: String::new(),
        body_mode: "none".to_string(),
        headers: serde_json::Map::new(),
        query: Vec::new(),
        body_json: String::new(),
        ws_url: String::new(),
        docs: String::new(),
    };
    for b in split_bru_blocks(text) {
        let name = b.name.to_lowercase();
        if name == "meta" {
            res.meta = kv_to_object(&parse_kv_block(&b.body));
        } else if METHOD_BLOCKS.contains(&name.as_str()) {
            let kv = parse_kv_block(&b.body);
            res.method = name.to_uppercase();
            res.url = kv_get(&kv, "url");
            let bm = kv_get(&kv, "body");
            res.body_mode = if bm.is_empty() {
                "none".to_string()
            } else {
                bm
            };
        } else if name == "ws" || name == "websocket" {
            let kv = parse_kv_block(&b.body);
            res.ws_url = kv_get(&kv, "url");
        } else if name == "headers" {
            res.headers = kv_to_object(&parse_kv_block(&b.body));
        } else if name == "params:query" {
            res.query = parse_kv_block(&b.body);
        } else if name == "body:json" {
            res.body_json = dedent_raw_block(&b.body);
        } else if name == "docs" {
            res.docs = dedent_raw_block(&b.body);
        }
    }
    res
}

/// 解析 environment .bru 的 vars 块。
fn parse_env_vars(text: &str) -> serde_json::Map<String, Value> {
    for b in split_bru_blocks(text) {
        if b.name.to_lowercase() == "vars" {
            return kv_to_object(&parse_kv_block(&b.body));
        }
    }
    serde_json::Map::new()
}

/// 用 env 变量展开 `{{var}}`（缺失原样保留）。
fn expand_vars(s: &str, vars: &serde_json::Map<String, Value>) -> String {
    let re = {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| {
            regex::Regex::new(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}").expect("字面量正则编译失败")
        })
    };
    re.replace_all(s, |c: &regex::Captures| {
        let name = &c[1];
        vars.get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| c[0].to_string())
    })
    .to_string()
}

/// 推导服务类型：websocket / jsonrpc / rest。
fn derive_service_type(bru: &Bru) -> &'static str {
    let t = bru
        .meta
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if t == "ws" || t == "websocket" || !bru.ws_url.is_empty() {
        return "websocket";
    }
    if bru.body_mode == "json" && {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| regex::Regex::new(r#""jsonrpc"\s*:"#).expect("字面量正则编译失败"))
            .is_match(&bru.body_json)
    } {
        return "jsonrpc";
    }
    "rest"
}

/// 由相对路径段推 domain/app/module/page。
fn derive_dam(rel_parts: &[String], file_name: &str) -> (String, String, String, String) {
    let page = file_name
        .strip_suffix(".bru")
        .unwrap_or(file_name)
        .to_string();
    let domain = rel_parts.first().cloned().unwrap_or_default();
    let app = rel_parts.get(1).cloned().unwrap_or_default();
    let module = if rel_parts.len() > 3 {
        rel_parts[2..].join("/")
    } else {
        rel_parts.get(2).cloned().unwrap_or_default()
    };
    (domain, app, module, page)
}

/// 递归收集 .bru 文件（跳过根 environments/、folder.bru、隐藏文件）。
///
/// # Arguments
///
/// * `root` - 服务目录根路径。
///
/// # Returns
///
/// 元组列表：(相对路径段, 文件名, 绝对路径)。
///
/// # Errors
///
/// 读取目录项失败时返回 `PortalError`。
async fn collect_bru_files(
    root: &std::path::Path,
) -> PortalResult<Vec<(Vec<String>, String, std::path::PathBuf)>> {
    let mut out = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, Vec<String>)> = vec![(root.to_path_buf(), Vec::new())];
    while let Some((dir, parts)) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(crate::error::PortalError::Io)?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if parts.is_empty() && name == "environments" {
                continue;
            }
            let ft = entry
                .file_type()
                .await
                .map_err(crate::error::PortalError::Io)?;
            if ft.is_dir() {
                let mut next = parts.clone();
                next.push(name);
                stack.push((entry.path(), next));
            } else if ft.is_file() {
                let lower = name.to_lowercase();
                if lower.ends_with(".bru") && lower != "folder.bru" {
                    out.push((parts.clone(), name, entry.path()));
                }
            }
        }
    }
    Ok(out)
}

/// 返回 service-catalog 目录树的最新 mtime（递归取所有 .bru 与目录的 max mtime）。
///
/// 用于缓存键：mtime 未变即可安全复用上次解析结果，避免每次全量读盘 + 解析。
/// 目录不存在或无法读取时返回 `None`（调用方退化为不缓存）。
async fn catalog_dir_mtime(root: &std::path::Path) -> Option<std::time::SystemTime> {
    let mut latest: Option<std::time::SystemTime> = None;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await.ok()?;
        while let Some(entry) = rd.next_entry().await.ok()? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let ft = entry.file_type().await.ok()?;
            if ft.is_dir() {
                if let Ok(m) = entry.metadata().await.and_then(|m| m.modified()) {
                    latest = Some(latest.map_or(m, |l| if m > l { m } else { l }));
                }
                stack.push(entry.path());
            } else if ft.is_file() {
                let lower = name.to_lowercase();
                if !lower.ends_with(".bru") || lower == "folder.bru" {
                    continue;
                }
                if let Ok(m) = entry.metadata().await.and_then(|m| m.modified()) {
                    latest = Some(latest.map_or(m, |l| if m > l { m } else { l }));
                }
            }
        }
    }
    latest
}

/// 目录树 mtime + 解析结果，作为 service-catalog 的缓存条目。
type CatalogCacheEntry = (std::time::SystemTime, Vec<Value>);

/// 全局解析缓存：`(目录树 mtime, 解析结果)`，mtime 未变即复用。
fn catalog_cache() -> &'static Mutex<Option<CatalogCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<CatalogCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 解析全部服务（带 mtime 缓存：目录树未变化时复用上次结果，避免全量读盘）。
///
/// # Returns
///
/// 全部服务的 JSON 值列表。
///
/// # Errors
///
/// 收集 .bru 文件失败时返回 `PortalError`。
async fn load_all_cached() -> PortalResult<Vec<Value>> {
    let dir = data_path(["service-catalog"]);
    // 目录树最新 mtime 作为缓存键；缺失（目录不存在等）则不缓存，每次实时算。
    let key = catalog_dir_mtime(&dir).await;
    if let Some(mtime) = key
        && let Some((cached_mtime, ref cached)) = *catalog_cache().lock().await
        && cached_mtime == mtime
    {
        return Ok(cached.clone());
    }
    let fresh = load_all().await?;
    if let Some(mtime) = key {
        *catalog_cache().lock().await = Some((mtime, fresh.clone()));
    }
    Ok(fresh)
}

/// 解析全部服务（无缓存--按需读盘；由 [`load_all_cached`] 包装缓存层）。
///
/// # Returns
///
/// 全部服务的 JSON 值列表。
///
/// # Errors
///
/// 收集 .bru 文件失败时返回 `PortalError`。
async fn load_all() -> PortalResult<Vec<Value>> {
    let dir = data_path(["service-catalog"]);
    if tokio::fs::metadata(&dir).await.is_err() {
        return Ok(Vec::new());
    }
    // preview 环境变量
    let mut env_vars = serde_json::Map::new();
    let env_path = dir.join("environments").join(format!("{PREVIEW_ENV}.bru"));
    if let Ok(text) = tokio::fs::read_to_string(&env_path).await {
        env_vars = parse_env_vars(&text);
    }

    let mut files = collect_bru_files(&dir).await?;
    // 稳定顺序：按相对路径排序（Node fs 顺序不定，但 id 去重依赖遍历序；这里排序保证确定性）
    files.sort_by(|a, b| {
        let ka = format!("{}/{}", a.0.join("/"), a.1);
        let kb = format!("{}/{}", b.0.join("/"), b.1);
        ka.cmp(&kb)
    });

    let mut out = Vec::new();
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (rel_parts, file_name, abs) in files {
        let text = match tokio::fs::read_to_string(&abs).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, path = %abs.display(), "service-catalog .bru 读取失败，跳过");
                continue;
            }
        };
        let bru = parse_bru(&text);
        let (domain, app, module, page) = derive_dam(&rel_parts, &file_name);
        let stype = derive_service_type(&bru);
        let url = if stype == "websocket" {
            bru.ws_url.clone()
        } else {
            bru.url.clone()
        };
        // id：domain.app.module.page 点分（合法段），缺级跳过；冲突加 #k
        let id_parts: Vec<&str> = [&domain, &app, &module, &page]
            .into_iter()
            .filter(|x| !x.is_empty() && is_safe_segment(x))
            .map(|x| x.as_str())
            .collect();
        let mut id = id_parts.join(".");
        if id.is_empty() {
            id = page.clone();
        }
        if taken.contains(&id) {
            let mut k = 2;
            while taken.contains(&format!("{id}#{k}")) {
                k += 1;
            }
            id = format!("{id}#{k}");
        }
        taken.insert(id.clone());

        let params: Vec<Value> = bru
            .query
            .iter()
            .map(|(k, v)| json!({ "key": k, "value": v }))
            .collect();
        out.push(json!({
            "id": id,
            "domain": domain,
            "app": app,
            "module": module,
            "page": page,
            "label": bru.meta.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&page),
            "type": stype,
            "url": url,
            "urlPreview": expand_vars(&url, &env_vars),
            "method": if stype == "websocket" { String::new() } else if bru.method.is_empty() { "GET".to_string() } else { bru.method.clone() },
            "headers": bru.headers,
            "bodyTemplate": if bru.body_mode == "json" { bru.body_json.clone() } else { String::new() },
            "params": params,
            "description": bru.docs,
        }));
    }
    Ok(out)
}

/// 列出服务（按 domain/app/module 过滤）。
///
/// # Arguments
///
/// * `domain` - 领域过滤；`None` 或空表示不过滤。
/// * `app` - 应用过滤；`None` 或空表示不过滤。
/// * `module` - 模块过滤；`None` 或空表示不过滤。
///
/// # Returns
///
/// 符合过滤条件的服务列表。
///
/// # Errors
///
/// 加载全部服务失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn list_services(
    domain: Option<&str>,
    app: Option<&str>,
    module: Option<&str>,
) -> PortalResult<Vec<Value>> {
    let all = load_all_cached().await?;
    let d = domain.unwrap_or("").trim();
    let a = app.unwrap_or("").trim();
    let m = module.unwrap_or("").trim();
    Ok(all
        .into_iter()
        .filter(|s| {
            (d.is_empty() || s.get("domain").and_then(|v| v.as_str()) == Some(d))
                && (a.is_empty() || s.get("app").and_then(|v| v.as_str()) == Some(a))
                && (m.is_empty() || s.get("module").and_then(|v| v.as_str()) == Some(m))
        })
        .collect())
}

/// 按 id 取单个服务（不存在返回 None）。
///
/// # Arguments
///
/// * `id` - 服务标识。
///
/// # Returns
///
/// 匹配到的服务；不存在时返回 `None`。
///
/// # Errors
///
/// 加载全部服务失败时返回 `PortalError`。
#[tracing::instrument]
pub async fn get_service_by_id(id: &str) -> PortalResult<Option<Value>> {
    let all = load_all_cached().await?;
    Ok(all
        .into_iter()
        .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id)))
}
