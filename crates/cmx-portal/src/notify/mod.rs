//! 通知中心：按用户隔离的「任务中心 / 消息中心 / 日志中心」三类通知。
//!
//! - 存储：`notification-center/<userId>/<center>/<file>.json`，一条通知一个文件。
//!   center ∈ {task, message, log}（对应 任务中心/消息中心/日志中心）。
//! - 读取：list（按中心或全部）、counts（各中心未读数 + 合计，shellbar 红色角标用）。
//! - 写入：publish（新增一条 + 广播 SSE）、mark_read（标记已读）、mark_all_read。
//! - 推送：进程内全局 broadcast 通道（[`hub`]），SSE handler 订阅它向浏览器实时下发。
//!   选 SSE 而非 WebSocket：通知是「服务端→客户端」单向，SSE 自带重连 + KeepAlive，
//!   且本仓库 agent 流式已用 axum SSE，前端用 fetch+流读（自动带鉴权头），无需新协议。

pub mod hub;
pub mod store;

pub use store::{NotifyCenter, NotifyInput, NotifyItem};
