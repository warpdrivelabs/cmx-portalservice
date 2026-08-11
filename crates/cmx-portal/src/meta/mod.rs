//! 元数据资源域：menu / activities / domains / registry / dam_registry /
//! modules / service_catalog / workspace_nodes。
//!
//! domains / activities 模块已随 /api/domains、/api/activities 路由弃用而注释
//! （POST /api/domains/tree 统一替代）。menu_pages 保留——launcher 服务依赖
//! get_menu_page_json。

// pub mod activities; // 已弃用（/api/activities 由 /api/domains/tree 替代）
// pub mod domains;    // 已弃用（/api/domains 由 /api/domains/tree 替代）
pub mod menu_pages;
pub mod module_theme;
pub mod modules;
pub mod workspace_nodes;
