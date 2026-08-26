//! 通知中心:按用户隔离的「任务中心 / 消息中心 / 日志中心」三类通知。
//!
//! - 存储:平台库 `cmx_notification`(主体)+ `cmx_notification_recipient`(收件明细,写扩散),
//!   建表走 sql-guide 治理通道(`docs/sql/v2/platform/migrations/20260826_001_通知中心建表.up.sql`)。
//! - 读取:list(过滤 + keyset 分页)、counts(各中心未读数 + 合计,shellbar 红色角标用)。
//! - 写入:publish(单发/部门/角色/全员群发 + 权限矩阵 + 聚合防风暴)、mark_read、mark_all_read;
//!   大 fanout 转 pending 后台异步展开,过期/超保留期由清理任务分批删除。
//! - 推送:Redis pub/sub(`cmx:notify` 频道)跨实例广播 → 各实例进程内 hub → SSE handler 下发浏览器;
//!   Redis 不可达降级进程内。选 SSE 而非 WebSocket:通知是「服务端→客户端」单向,SSE 自带重连 +
//!   KeepAlive,且前端用 fetch+流读(自动带鉴权头),无需新协议。

pub mod hub;
pub mod store;

pub use store::{
    NotifyCenter, NotifyCounts, NotifyInput, NotifyItem, NotifyListFilter, NotifyListResult,
    PublishCtx, NotifyTargets,
};
