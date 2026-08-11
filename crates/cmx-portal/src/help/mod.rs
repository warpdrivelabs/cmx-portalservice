//! 帮助中心（按 DAM domain/app/module 组织的帮助文档）。
//!
//! 数据落盘在 `help/<domain>/<app>/<module>/<file>.json`，一个文件 = 模块内一项具体功能的帮助，
//! 含详细内容（content）与样例（examples）。catalog 提供轻量目录投影供 explorer 搜索建树。

pub mod store;
