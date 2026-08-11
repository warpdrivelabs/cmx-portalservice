//! 事实交易数据读取：`fact/<domain>/<app>/<module>/<file>.json`。
//!
//! 复刻 Node `lib/factStore.js`：get（按 DAM+file 读原样 JSON）+ list（目录遍历，逐级过滤）。
//! 路径穿越保护：domain/app/module 段 `[a-zA-Z0-9_-]+`，file 须 `*.json`。

pub mod store;
