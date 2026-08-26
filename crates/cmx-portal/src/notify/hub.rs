//! 通知推送中枢：进程内全局 broadcast 通道。
//!
//! publish 时把「某用户的某条通知 + 该用户最新 counts」投递到通道；每个 SSE 连接订阅通道、
//! 只挑选「属于自己 userId」的消息下发给浏览器。用全局 OnceLock 单例（与 util::write_lock 同风格），
//! 避免改动 CmxAppState / 路由 state 这类共享基建。

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// 经通道广播的一条推送事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyEvent {
    /// 目标用户(SSE 连接据此过滤,仅下发本人事件;fanout 事件为空串,所有连接都处理)。
    pub user_id: String,
    /// 事件类型:`notify`(新通知)/`counts`(角标刷新)/`fanout`(大群发提示,连接方自行拉取 counts)。
    pub kind: String,
    /// 负载:notify 为新通知项;counts 为 { task, message, log, total };fanout 为空对象。
    pub data: serde_json::Value,
}

/// 全局广播发送端（容量有限的环形缓冲；滞后的订阅者会丢最旧消息，但不影响计数--
/// 计数始终以落盘文件为准，SSE 仅作即时提醒）。
///
/// # Returns
///
/// 全局广播通道的静态发送端引用。
pub fn sender() -> &'static broadcast::Sender<NotifyEvent> {
    static TX: OnceLock<broadcast::Sender<NotifyEvent>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, _rx) = broadcast::channel::<NotifyEvent>(256);
        tx
    })
}

/// 订阅广播（每个 SSE 连接调用一次）。
///
/// # Returns
///
/// 新的广播接收端。
pub fn subscribe() -> broadcast::Receiver<NotifyEvent> {
    sender().subscribe()
}

/// 广播一条事件（无订阅者时静默忽略）。
///
/// # Arguments
///
/// * `ev` - 待广播的通知事件。
pub fn publish_event(ev: NotifyEvent) {
    let _ = sender().send(ev);
}
