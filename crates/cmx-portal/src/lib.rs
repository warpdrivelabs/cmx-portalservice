//! cmx-portal —— 门户/设计器业务层（门面 + 门户本体）。
//!
//! 承接 CMXPortalManager / CMXHTMLDesigner 两个 Node.js 后端迁移而来的门户业务。
//! 数据为 JSON 文件存储（`data/**.json`），通过 `tokio::fs` 读写，原子写用「临时文件 + rename」。
//!
//! 本 crate 已按业务边界拆分，物理代码分布在三个 crate，但对外 API 路径保持不变（re-export 门面）：
//! - 基础设施下沉至 [`cmx_jsonstore`]（config / error / fsutil / util）。
//! - 表单中心拆至 [`cmx_form`]（`pages`：form / html / native）。
//! - 模型中心拆至 [`cmx_model_meta`]（`definitions` / `flexible_combination` / `dict`）。
//!
//! 下列 `pub use` 把基础设施与两个子中心再导出回本 crate 命名空间，于是
//! `cmx_portal::pages::*` / `cmx_portal::definitions::*` / `cmx_portal::PortalError` 等旧路径
//! 以及 `agent` 内部的 `crate::pages` / `crate::flexible_combination` 引用均无需改动。
//!
//! 仍属门户本体的资源域（保留在本 crate）：
//! - [`meta`]   —— menu/activities/domains/registry/dam_registry/modules/workspace_nodes（门户导航元数据）。
//! - [`dam`]    —— DAM 注册表。
//! - [`fact`] / [`help`] / [`launcher`] / [`notify`] / [`service_catalog`]。
//! - [`agent`] / [`ai`] —— AI 本地编辑代理 / 对话中继。
//!
//! ## 部署假设：单实例
//!
//! 本 crate 以 **JSON 文件存储** 为持久层（`data/**/*.json`，`tokio::fs` 读写 + 临时文件 rename
//! 原子写），并发安全依赖**进程内全局锁**（`util::write_lock` 的 `OnceLock<Mutex<()>>`、
//! `notify::store` 的未读计数缓存、`agent::flow` 的 pending 审批表等）。这些机制**仅在单进程内
//! 串行化写操作**，**不支持多实例水平扩展**——多实例并发写同一数据根会相互覆盖、丢失更新。
//!
//! 部署时须保证：**同一 data root 同一时刻只被一个本服务进程持有**。需要多副本时，应前置共享
//! 文件系统（且保证单写）或将对应资源域迁至数据库（DAM 主数据已完成此迁移，见 [`dam`]）。

#![recursion_limit = "256"]

// 基础设施从 base 再导出：保持 crate::config / crate::PortalError / cmx_portal::data_root 等旧路径。
pub use cmx_jsonstore::{
    PortalError, PortalResult, cache, config, data_root, error, fsutil, now_millis, util,
};

// 拆出的子中心再导出：保持 cmx_portal::pages / ::definitions / ::flexible_combination / ::dict
// 以及 agent 内部 crate::pages 等引用有效。
pub use cmx_form::pages;
pub use cmx_model_meta::{definitions, dict, flexible_combination};

// 仍属门户本体的资源域。
pub mod agent;
pub mod ai;
pub mod dam;
pub mod fact;
pub mod help;
pub mod launcher;
pub mod meta;
pub mod notify;
pub mod service_catalog;
