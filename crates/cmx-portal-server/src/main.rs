//! cmx-portal-server —— 门户微服务 bin（薄壳，独立 workspace cmx-portalservice）。
//!
//! 平台聚合服务的全部装配（20 步有序 init + CmxAppState + 路由 + serve + 优雅关闭）在跨 workspace
//! 库 cmx-platform-app（平台总装配器，仍是 cmx-container 成员），本 bin 只定义**门户专属 banner**
//! 并调 `run_platform(banner)`。对偶于 cmx-flow-server（流程微服务薄壳，有自己的 flow banner）。
//!
//! banner 由各微服务 bin 自持：门户/流程/报表/主数据各打印自己的字符画与配色——同一套装配核
//! （run_platform），不同的服务身份。

// macOS Apple 链接器（ld-1267+）对超大 debug 二进制会报 `__eh_frame section too large
// (max 16MB)`：本依赖闭包大 + 完整 debuginfo 使 DWARF 栈展开段超 16MB，compact unwind
// 表偏移量装不下。后果仅为「panic 展开性能*可能*下降」，不影响正确性/运行。Rust 1.97 起
// `linker_messages` lint 把链接器 stderr 抬成告警才使其显现（代码未变差）。此处按其良性静音。
#![allow(linker_messages)]

use cmx_web_chassis::BannerSpec;

/// 门户专属字符画（MEGA PORTAL，区别于 flow/report/mdm 各自的 banner）。
const PORTAL_ART: &str = r#"
███╗   ███╗███████╗ ██████╗  █████╗     ██████╗  ██████╗ ██████╗ ████████╗ █████╗ ██╗
████╗ ████║██╔════╝██╔════╝ ██╔══██╗    ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██╔══██╗██║
██╔████╔██║█████╗  ██║  ███╗███████║    ██████╔╝██║   ██║██████╔╝   ██║   ███████║██║
██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║    ██╔═══╝ ██║   ██║██╔══██╗   ██║   ██╔══██║██║
██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║    ██║     ╚██████╔╝██║  ██║   ██║   ██║  ██║███████╗
╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝    ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝
"#;

#[tokio::main]
async fn main() -> cmx_platform_app::Result<()> {
    // 门户专属 banner：靛蓝 → 青 渐变 + 门户标语。
    let banner = BannerSpec::defaults("portal")
        .art(PORTAL_ART)
        .tagline("  MEGA Portal · 企业业务门户 ")
        .stops(vec![(99, 102, 241), (14, 165, 233), (34, 211, 238)]);

    cmx_platform_app::run_platform(banner).await
}
