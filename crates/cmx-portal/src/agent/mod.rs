//! AI 本地编辑代理（复刻 Node `lib/agent/*`）。
//!
//! - [`schemas`]：8 个工具的公开 schema（capabilities 返回）。
//! - [`tools`]：工具实现（搜索/读文件/列定义·页面/校验/run_command/JSON·文本补丁），含路径穿越保护。
//! - [`planner`]：LocalRulePlanner —— 正则意图抽取（analysis / approval）。
//! - [`flow`]：agent 流程（planner → 事件序列 + 审批态），message/stream/approvals 端点编排。
//!
//! 安全：仅允许白名单命令（npm run lint/build -w cmx-portal-manager）；写文件经审批；
//! 文件路径限制在 rootDir 内。rootDir 由 `CMX_AGENT_ROOT` 或进程工作目录给出。

pub mod flow;
pub mod planner;
pub mod schemas;
pub mod tools;

/// agent 操作的根目录（CMX_AGENT_ROOT 或当前工作目录）。
///
/// # Returns
///
/// 返回规范化后的根目录路径，失败时回退到 `.`。
pub fn root_dir() -> std::path::PathBuf {
    std::env::var("CMX_AGENT_ROOT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        })
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}
