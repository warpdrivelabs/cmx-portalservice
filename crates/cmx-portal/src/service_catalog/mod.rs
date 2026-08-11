//! 服务目录（Service Catalog）—— 解析 Bruno collection（`.bru`）为 DAM 分类的服务清单。
//!
//! 复刻 Node `lib/serviceCatalogStore.js`：零依赖 mini `.bru` 解析器（块状语法 `<name> { ... }`，
//! 嵌套 `{}` 用括号配对切分）+ 目录即 DAM（`<domain>/<app>/<module>/<service>.bru`）+
//! environments/dev.bru 展开 `{{var}}` 得 urlPreview。只读，按 domain/app/module 过滤。

pub mod store;
