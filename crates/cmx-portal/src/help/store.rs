//! help store 实现：按 DAM(domain/app/module) 组织的帮助文档。
//!
//! 借鉴 `fact` store 的目录布局与校验：文档落盘在
//! `help/<domain>/<app>/<module>/<file>.json`，一个文件 = 模块内一项具体功能的帮助。
//! 模块内的多级目录由文档的 `path` 字段（斜杠分级）表达，目录深度固定为 domain/app/module。
//!
//! - catalog：遍历整棵 help 树，投影出轻量目录项（不含正文/示例），供 explorer 搜索与建树。
//! - doc：读取/保存/删除单个完整帮助文档（含 content 详细内容 + examples 样例）。

use serde::{Deserialize, Serialize};

use crate::config::data_path;
use crate::error::{PortalError, PortalResult};
use crate::fsutil::{read_json, write_json_atomic};
use crate::now_millis;
use crate::util::{is_safe_json_file, is_safe_segment, write_lock};

/// 帮助文档引用（domain/app/module/file）。
#[derive(Debug, Clone, Deserialize)]
pub struct HelpRef {
    /// 所属域 id。
    pub domain: String,
    /// 所属应用 id。
    pub app: String,
    /// 所属模块 id。
    pub module: String,
    /// 帮助文件名（须 `*.json`）。
    pub file: String,
}

/// catalog 查询过滤（任一缺省则该级放宽）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct HelpQuery {
    /// 可选域 id 过滤条件。
    #[serde(default)]
    pub domain: Option<String>,
    /// 可选应用 id 过滤条件。
    #[serde(default)]
    pub app: Option<String>,
    /// 可选模块 id 过滤条件。
    #[serde(default)]
    pub module: Option<String>,
}

/// catalog 轻量目录项（不含正文/示例，供 explorer 建树+搜索）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpCatalogItem {
    /// 所属域 id。
    pub domain: String,
    /// 所属应用 id。
    pub app: String,
    /// 所属模块 id。
    pub module: String,
    /// 帮助文件名。
    pub file: String,
    /// 文件名去掉 `.json` 后缀，作为模块内主题 id。
    pub id: String,
    /// 模块内分级路径（斜杠分级，如 `voucher/create`），用于多级目录。
    pub path: String,
    /// 文档标题（显示用）。
    pub title: String,
    /// 文档摘要。
    pub summary: String,
    /// 关键词列表（供搜索）。
    pub keywords: Vec<String>,
    /// 排序序号。
    pub order: i64,
    /// 是否含样例/示例（property 区是否有内容）。
    pub has_examples: bool,
}

/// 完整帮助文档（含详细内容与样例）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpDoc {
    /// 所属域 id。
    pub domain: String,
    /// 所属应用 id。
    pub app: String,
    /// 所属模块 id。
    pub module: String,
    /// 帮助文件名。
    pub file: String,
    /// 模块内主题 id（文件名去掉 `.json`）。
    pub id: String,
    /// 模块内分级路径（斜杠分级）。
    #[serde(default)]
    pub path: String,
    /// 文档标题（显示用）。
    #[serde(default)]
    pub title: String,
    /// 文档摘要。
    #[serde(default)]
    pub summary: String,
    /// 关键词列表（供搜索）。
    #[serde(default)]
    pub keywords: Vec<String>,
    /// 排序序号。
    #[serde(default)]
    pub order: i64,
    /// 详细内容（markdown），渲染在 content 区。
    #[serde(default)]
    pub content: String,
    /// 样例/示例数组，渲染在 property 区；每项形如 `{ title, lang, code, note }`。
    #[serde(default)]
    pub examples: Vec<serde_json::Value>,
    /// 文档内联定义的「可执行动作」（工作区节点/菜单），按 key 索引，供 content 里
    /// `wsnode:#key` 链接直接 seed 打开。每个 value 是一个菜单节点对象（含 `workspace`）
    /// 或 `{ kind:"node"|"menu", id|key }` 引用。空对象表示无内联动作。
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub actions: serde_json::Value,
    /// 最后更新时间（epoch 毫秒），保存时由服务端写入。
    #[serde(default)]
    pub updated_at: i64,
}

/// 保存入参（file 可缺省，缺省时由 id 推导为 `<id>.json`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpDocInput {
    /// 所属域 id。
    pub domain: String,
    /// 所属应用 id。
    pub app: String,
    /// 所属模块 id。
    pub module: String,
    /// 帮助文件名（缺省时由 id 推导为 `<id>.json`）。
    #[serde(default)]
    pub file: Option<String>,
    /// 模块内主题 id（缺省时由 file 推导）。
    #[serde(default)]
    pub id: Option<String>,
    /// 模块内分级路径（斜杠分级）。
    #[serde(default)]
    pub path: Option<String>,
    /// 文档标题（显示用）。
    #[serde(default)]
    pub title: Option<String>,
    /// 文档摘要。
    #[serde(default)]
    pub summary: Option<String>,
    /// 关键词列表（供搜索）。
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    /// 排序序号。
    #[serde(default)]
    pub order: Option<i64>,
    /// 详细内容（markdown），渲染在 content 区。
    #[serde(default)]
    pub content: Option<String>,
    /// 样例/示例数组，渲染在 property 区。
    #[serde(default)]
    pub examples: Option<Vec<serde_json::Value>>,
    /// 文档内联定义的可执行动作（JSON 对象）。
    #[serde(default)]
    pub actions: Option<serde_json::Value>,
}

/// 校验 DAM 三段，返回规范化后的 [domain, app, module]。
fn validate_dam(domain: &str, app: &str, module: &str) -> PortalResult<[String; 3]> {
    let mut out: [String; 3] = Default::default();
    for (i, (k, v)) in [("domain", domain), ("app", app), ("module", module)]
        .iter()
        .enumerate()
    {
        let t = v.trim();
        if t.is_empty() {
            return Err(PortalError::bad_request(format!("缺少必填参数 {k}")));
        }
        if !is_safe_segment(t) {
            return Err(PortalError::bad_request(format!(
                "参数 {k} 非法（仅允许字母、数字、_-）：\"{v}\""
            )));
        }
        out[i] = t.to_string();
    }
    Ok(out)
}

/// 校验 file（须 *.json，安全字符集）。
fn validate_file(file: &str) -> PortalResult<String> {
    let f = file.trim();
    if !is_safe_json_file(f) {
        return Err(PortalError::bad_request(format!(
            "参数 file 非法（须 *.json，仅允许字母、数字、._-）：\"{file}\""
        )));
    }
    Ok(f.to_string())
}

/// 校验引用并返回 [domain, app, module, file]。
fn validate_ref(r: &HelpRef) -> PortalResult<[String; 4]> {
    let [d, a, m] = validate_dam(&r.domain, &r.app, &r.module)?;
    let f = validate_file(&r.file)?;
    Ok([d, a, m, f])
}

/// 文件名去 `.json` 后缀。
fn id_from_file(file: &str) -> String {
    file.strip_suffix(".json").unwrap_or(file).to_string()
}

// now_millis 复用 cmx-jsonstore 下沉的实现（见 crate 根 re-export）。

/// 读取某 DAM+file 的完整帮助文档。
///
/// # Arguments
///
/// * `r` - 帮助文档引用（domain/app/module/file）。
///
/// # Returns
///
/// 返回该文件的完整 `HelpDoc`（含正文与样例）。
///
/// # Errors
///
/// 参数非法返回 `PortalError::BadRequest`；文件不存在返回 `PortalError::NotFound`。
#[tracing::instrument]
pub async fn get_doc(r: &HelpRef) -> PortalResult<HelpDoc> {
    let [d, a, m, f] = validate_ref(r)?;
    let path = data_path(["help", &d, &a, &m, &f]);
    match read_json::<HelpDoc>(&path).await {
        Ok(mut doc) => {
            // 落盘字段可能与目录/文件名不一致，以路径为准回填，保证前端拿到的引用正确。
            doc.domain = d;
            doc.app = a;
            doc.module = m;
            doc.id = id_from_file(&f);
            doc.file = f;
            Ok(doc)
        }
        Err(PortalError::NotFound(_)) => Err(PortalError::not_found(format!(
            "帮助文档不存在：{}/{}/{}/{}",
            r.domain, r.app, r.module, r.file
        ))),
        Err(e) => Err(e),
    }
}

/// 遍历 help 树，按 domain/app/module 逐级过滤，投影出轻量目录项。
///
/// # Arguments
///
/// * `q` - 查询过滤条件，任一字段缺省则该级放宽。
///
/// # Returns
///
/// 返回匹配的轻量目录项列表，按 domain/app/module -> order -> path -> id 排序。
///
/// # Errors
///
/// 目录读取失败时返回 `PortalError::Io`。
#[tracing::instrument]
pub async fn list_catalog(q: &HelpQuery) -> PortalResult<Vec<HelpCatalogItem>> {
    let root = data_path(["help"]);
    let want_domain = q.domain.as_deref().unwrap_or("").trim().to_string();
    let want_app = q.app.as_deref().unwrap_or("").trim().to_string();
    let want_module = q.module.as_deref().unwrap_or("").trim().to_string();

    let mut out: Vec<HelpCatalogItem> = Vec::new();
    // 深度固定为 domain/app/module/file：三层目录 + 文件。
    let mut dirs: Vec<(std::path::PathBuf, Vec<String>)> = vec![(root, Vec::new())];
    while let Some((dir, parts)) = dirs.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(PortalError::Io(e)),
        };
        while let Some(entry) = rd.next_entry().await.map_err(PortalError::Io)? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let ft = entry.file_type().await.map_err(PortalError::Io)?;
            let mut next = parts.clone();
            next.push(name.clone());
            if ft.is_dir() {
                if next.len() == 1 && !want_domain.is_empty() && want_domain != name {
                    continue;
                }
                if next.len() == 2 && !want_app.is_empty() && want_app != name {
                    continue;
                }
                if next.len() == 3 && !want_module.is_empty() && want_module != name {
                    continue;
                }
                // 下探到 module 目录（深度 3）以读取其中的文件；更深目录不再下探。
                if next.len() <= 3 {
                    dirs.push((entry.path(), next));
                }
            } else if ft.is_file() && name.ends_with(".json") && parts.len() == 3 {
                // 读取文件投影轻量目录项；单个文件损坏不影响其余目录项，但记录告警便于排查。
                let doc = match read_json::<serde_json::Value>(&entry.path()).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!(error = %e, path = %entry.path().display(), "help 文档解析失败，跳过");
                        continue;
                    }
                };
                {
                    let id = id_from_file(&name);
                    let title = doc
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    out.push(HelpCatalogItem {
                        domain: parts[0].clone(),
                        app: parts[1].clone(),
                        module: parts[2].clone(),
                        file: name,
                        title: if title.is_empty() { id.clone() } else { title },
                        id,
                        path: doc
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        summary: doc
                            .get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        keywords: doc
                            .get("keywords")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        order: doc.get("order").and_then(|v| v.as_i64()).unwrap_or(0),
                        has_examples: doc
                            .get("examples")
                            .and_then(|v| v.as_array())
                            .map(|a| !a.is_empty())
                            .unwrap_or(false),
                    });
                }
            }
        }
    }
    // 排序：domain/app/module → order → path → id，便于 explorer 稳定建树。
    out.sort_by(|a, b| {
        (
            a.domain.as_str(),
            a.app.as_str(),
            a.module.as_str(),
            a.order,
            a.path.as_str(),
            a.id.as_str(),
        )
            .cmp(&(
                b.domain.as_str(),
                b.app.as_str(),
                b.module.as_str(),
                b.order,
                b.path.as_str(),
                b.id.as_str(),
            ))
    });
    Ok(out)
}

/// 保存帮助文档（写 `help/<domain>/<app>/<module>/<file>.json`，原子写）。
///
/// # Arguments
///
/// * `input` - 保存入参（file 可缺省，缺省时由 id 推导为 `<id>.json`）。
///
/// # Returns
///
/// 返回保存后的完整 `HelpDoc`（含服务端写入的 `updated_at`）。
///
/// # Errors
///
/// 参数非法或缺少 file/id 时返回 `PortalError::BadRequest`；写入失败返回对应 `PortalError`。
#[tracing::instrument(skip(input))]
pub async fn save_doc(input: HelpDocInput) -> PortalResult<HelpDoc> {
    let [d, a, m] = validate_dam(&input.domain, &input.app, &input.module)?;
    // file 优先取 input.file，否则由 id 推导 `<id>.json`。
    let id_hint = input.id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let file = match input
        .file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(f) => f.to_string(),
        None => {
            let id = id_hint.ok_or_else(|| PortalError::bad_request("缺少 file 或 id"))?;
            format!("{id}.json")
        }
    };
    let file = validate_file(&file)?;
    let id = id_from_file(&file);

    let doc = HelpDoc {
        domain: d.clone(),
        app: a.clone(),
        module: m.clone(),
        file: file.clone(),
        id,
        path: input
            .path
            .unwrap_or_default()
            .trim()
            .trim_matches('/')
            .to_string(),
        title: input.title.unwrap_or_default(),
        summary: input.summary.unwrap_or_default(),
        keywords: input.keywords.unwrap_or_default(),
        order: input.order.unwrap_or(0),
        content: input.content.unwrap_or_default(),
        examples: input.examples.unwrap_or_default(),
        actions: input.actions.unwrap_or(serde_json::Value::Null),
        updated_at: now_millis(),
    };

    let _guard = write_lock().lock().await;
    let path = data_path(["help", &d, &a, &m, &file]);
    write_json_atomic(&path, &doc, true).await?;
    Ok(doc)
}

/// 删除帮助文档。
///
/// # Arguments
///
/// * `r` - 帮助文档引用（domain/app/module/file）。
///
/// # Returns
///
/// 成功返回 `Ok(())`。
///
/// # Errors
///
/// 参数非法返回 `PortalError::BadRequest`；文件不存在返回 `PortalError::NotFound`。
#[tracing::instrument]
pub async fn delete_doc(r: &HelpRef) -> PortalResult<()> {
    let [d, a, m, f] = validate_ref(r)?;
    let _guard = write_lock().lock().await;
    let path = data_path(["help", &d, &a, &m, &f]);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(PortalError::not_found(format!(
            "帮助文档不存在：{}/{}/{}/{}",
            r.domain, r.app, r.module, r.file
        ))),
        Err(e) => Err(PortalError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用一个唯一的临时数据根验证 help store 的 save → catalog → get → delete 全链路 + 校验。
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn help_doc_roundtrip_and_validation() {
        // 串行化对 ASSETS__ROOT 的修改，避免与其它切换数据根的测试并行污染。
        let _env = crate::util::test_data_root_lock().lock().unwrap();
        // 唯一临时数据根（放 crate target 下，避免与其它测试/真实数据互相污染）。
        let crate_dir = env!("CARGO_MANIFEST_DIR");
        let unique = format!(
            "help-it-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let data_root = std::path::Path::new(crate_dir)
            .join("target")
            .join("test-data")
            .join(unique);
        // SAFETY: 测试内单线程设置进程环境变量；data_root() 读取它。
        unsafe { std::env::set_var("ASSETS__ROOT", &data_root) };

        // 1) 保存一份文档（file 由 id 推导）。
        let saved = save_doc(HelpDocInput {
            domain: "fi".into(),
            app: "cmxfico".into(),
            module: "gl".into(),
            file: None,
            id: Some("voucher-entry".into()),
            path: Some("/凭证管理/".into()),
            title: Some("录入凭证".into()),
            summary: Some("摘要".into()),
            keywords: Some(vec!["凭证".into(), "录入".into()]),
            order: Some(2),
            content: Some("# 标题\n正文".into()),
            examples: Some(vec![
                serde_json::json!({"title":"e1","lang":"json","code":"{}"}),
            ]),
            actions: Some(serde_json::json!({"open": {"id": "n1", "workspace": {"content": {}}}})),
        })
        .await
        .expect("save 应成功");
        assert_eq!(saved.file, "voucher-entry.json", "file 应由 id 推导");
        assert_eq!(saved.id, "voucher-entry");
        assert_eq!(saved.path, "凭证管理", "path 前后斜杠应被裁剪");
        assert!(saved.updated_at > 0, "updatedAt 应被写入");

        // 2) catalog 应投影出该项，且 hasExamples=true、不含正文。
        let items = list_catalog(&HelpQuery::default())
            .await
            .expect("catalog 应成功");
        let it = items
            .iter()
            .find(|x| {
                x.domain == "fi"
                    && x.app == "cmxfico"
                    && x.module == "gl"
                    && x.id == "voucher-entry"
            })
            .expect("catalog 应含已保存项");
        assert_eq!(it.title, "录入凭证");
        assert!(it.has_examples, "应标记含示例");
        assert_eq!(it.order, 2);

        // 3) catalog 过滤：错误 domain 应过滤掉。
        let none = list_catalog(&HelpQuery {
            domain: Some("hr".into()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(
            !none.iter().any(|x| x.id == "voucher-entry"),
            "domain 过滤应生效"
        );

        // 4) get 完整文档应含正文与示例。
        let got = get_doc(&HelpRef {
            domain: "fi".into(),
            app: "cmxfico".into(),
            module: "gl".into(),
            file: "voucher-entry.json".into(),
        })
        .await
        .expect("get 应成功");
        assert_eq!(got.content, "# 标题\n正文");
        assert_eq!(got.examples.len(), 1);
        assert_eq!(got.actions["open"]["id"], "n1", "actions 应原样回读");

        // 5) 路径穿越/非法段应被拒绝。
        assert!(
            get_doc(&HelpRef {
                domain: "..".into(),
                app: "cmxfico".into(),
                module: "gl".into(),
                file: "voucher-entry.json".into(),
            })
            .await
            .is_err()
        );
        assert!(
            get_doc(&HelpRef {
                domain: "fi".into(),
                app: "cmxfico".into(),
                module: "gl".into(),
                file: "evil".into(), // 非 .json
            })
            .await
            .is_err()
        );

        // 6) 删除后 get 应 NotFound。
        delete_doc(&HelpRef {
            domain: "fi".into(),
            app: "cmxfico".into(),
            module: "gl".into(),
            file: "voucher-entry.json".into(),
        })
        .await
        .expect("delete 应成功");
        assert!(matches!(
            get_doc(&HelpRef {
                domain: "fi".into(),
                app: "cmxfico".into(),
                module: "gl".into(),
                file: "voucher-entry.json".into(),
            })
            .await,
            Err(PortalError::NotFound(_))
        ));

        // 清理临时目录。
        let _ = tokio::fs::remove_dir_all(&data_root).await;
    }
}
