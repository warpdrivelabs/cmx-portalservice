//! DAM 主数据（domain / application / module）的只读查询。
//!
//! 历史上 Node 端的 `damRegistryStore.js` 负责 registry.json 的读写、三级 upsert（含改名
//! 级联与 DAM 树根目录搬移）、删除与引用完整性校验、`ensureDamTreeDirs`。迁移到 Rust 后，
//! **写操作已迁至 cmx-biz 的 Service 层**，主数据落库到 `cmx_domain` / `cmx_application` /
//! `cmx_module` 三张表。
//!
//! 本模块仅保留**只读读路径**：从数据库查询并反向映射回原 registry shape
//! （`list_domains` / `list_applications` / `list_modules` / `get_dam_registry`），
//! 供 `/api/registry/dam` 等只读消费方使用。详见 [`store`]。

pub mod store;
