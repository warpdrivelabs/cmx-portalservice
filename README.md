# cmx-portalservice

> 独立门户微服务 —— 企业业务门户与可视化设计器的后端能力中心。
>
> **MEGA Portal · 企业业务门户**（:8080）

`cmx-portalservice` 是一个独立的 Cargo workspace，承载门户微服务。它把原本内嵌在 `cmx-container` 里的门户后端剥离成可独立部署的服务：`cmx-container` 从此只剩公用库 crate、不再有可执行 server bin，门户/流程/报表/主数据都成为「代码极少、跨 workspace 复用公用库」的独立应用。

---

## 定位

平台后端的微服务化拆分，让每个能力中心成为独立进程：

| 能力中心 | workspace | bin | 端口 |
|---|---|---|---|
| **门户**（本仓） | `cmx-portalservice` | `cmx-portal-server` | 8080 |
| 流程引擎 | `cmx-flowengine` | `cmx-flow-server` | 8091 |
| 报表 / 主数据 | （规划中） | report / mdm | — |

各微服务 **同一套装配核**（`run_platform` / `run`）、**同一套配置制度**（`CONFIG_FILE` → ConfigManager）、**同一套启动脚本契约**，只是服务身份（banner / 业务路由）不同。

---

## 架构：薄壳 + 业务层 + keep-wired 跨 workspace

本 workspace 两类成员：

```
cmx-portalservice/                        （独立 workspace）
├── crates/
│   ├── cmx-portal-server/   薄 bin —— 只定义门户专属 banner，调 run_platform(banner)
│   └── cmx-portal/          门户/设计器业务层（JSON 存储的 store 层）
│
└──（跨 workspace path 引用，仍是 cmx-container 成员）
     cmx-platform-app        平台总装配器：20 步有序 init + CmxAppState + 路由 + serve + 优雅关闭
     cmx-web-chassis         通用 HTTP 骨架：BannerSpec / ServiceSpec / run / 日志 / 中间件
     cmx-jsonstore/form/     cmx-portal 依赖的基础库（config / error / 表单中心 / 模型中心 / DB …）
     model-meta/database/
     core/utils
```

**薄 bin（`cmx-portal-server`）** —— 全部装配逻辑在跨 workspace 的 `cmx-platform-app::run_platform()`，本 bin 只做一件事：定义门户专属的字符画 banner（靛蓝→青渐变），然后 `run_platform(banner).await`。对偶于 `cmx-flow-server`（流程微服务薄壳，有自己的 flow banner）。

**keep-wired 反向引用** —— `cmx-portal`（业务层，P-S1 从 cmx-container 迁入）的唯一依赖者 `cmx-api` 仍留在 `cmx-container`，经跨 workspace path **反向引用**它。这与流程引擎「引擎核在独立 ws、`cmx-flow-api` 壳留 container」是同一模式。彻底解耦（`cmx-api` 改 HTTP 反代、不再 path 引 `cmx-portal`）留待后续阶段（P-S4）。

**依赖策略** —— `cmx-portal` 依赖的 `cmx-*` 基础库仍是 `cmx-container` 成员，经跨 ws path 引用；外部 crate 走 aliyun 镜像，版本与 `cmx-container` 根对齐。因此**构建本仓需 `../cmx-container/` 并排存在**。

---

## 业务层 `cmx-portal`

承接 `CMXPortalManager`（门户管理）/ `CMXHTMLDesigner`（可视化设计器）两个原 Node.js 后端迁移而来的门户业务。已按业务边界拆分——基础设施下沉、表单/模型两个子中心拆出，但对外 API 路径不变（re-export 门面，`cmx_portal::pages::*` / `::definitions::*` 等旧路径继续有效）。

**资源域**：

| 域 | 职责 |
|---|---|
| `meta` | 门户导航元数据：menu / activities / domains / registry / dam_registry / modules / workspace_nodes |
| `pages`（← `cmx-form`） | 表单中心：form / html / native 页面 |
| `definitions` / `dict`（← `cmx-model-meta`） | 模型中心：定义 / 弹性组合 / 数据字典 |
| `dam` | DAM 注册表（主数据已迁数据库） |
| `notify` | 通知中心（hub + store + 未读计数缓存） |
| `help` / `fact` / `launcher` / `service_catalog` | 帮助 / 事实 / 启动器 / 服务目录 |
| `agent` / `ai` | AI 本地编辑代理 / 对话中继 |

### ⚠️ 部署假设：单实例

`cmx-portal` 以 **JSON 文件存储** 为持久层（`data/**/*.json`，`tokio::fs` 读写 + 「临时文件 + rename」原子写），并发安全依赖**进程内全局锁**（`OnceLock<Mutex<()>>` 写锁、notify 未读计数缓存、agent pending 审批表等）。这些机制**仅在单进程内串行化写操作，不支持多实例水平扩展**——多实例并发写同一 data root 会相互覆盖、丢失更新。

**部署须保证：同一 data root 同一时刻只被一个本服务进程持有。** 需要多副本时应前置共享文件系统（且保证单写），或将资源域迁至数据库（DAM 主数据已完成此迁移）。

---

## 快速开始

### 依赖
- **Rust**（见 `rust-toolchain.toml`，Edition 2024）
- **PostgreSQL**（`cmx` + `fico` 两库）
- **Redis**
- **`../cmx-container/` 并排存在**（跨 workspace path 依赖）

### 启动

```bash
./portal.sh            # 开发模式（debug，增量编译）
./portal.sh --release  # 发布模式
```

`portal.sh` 遵循统一启动契约：`cd` 到 workspace 根（`.env` / `*-server.toml` 相对路径基准）→ `cargo run -p cmx-portal-server`（bin 自动读 `.env`，无需手动 source）。

启动后访问 **http://127.0.0.1:8080/portal/**（门户）与 `/html/`（设计器）。

---

## 配置

三层来源，优先级 **环境变量 > `CONFIG_FILE` 指定的 toml > 内置默认**：

| 文件 | 作用 |
|---|---|
| `.env` | 环境变量。`dotenvy` 在启动最前读 cwd 的 `.env`。关键项：`CONFIG_FILE="./portal-server.toml"`、`WEB_FOLDER`、`RUST_LOG`、`NACOS_*` |
| `portal-server.toml` | 主配置（`CONFIG_FILE` 指向）：`[server]`（host/port）、`[portal]`（前端 dist 托管）、`[[databases]]`、`[redis]`、`[storage]`、`[plugin]`、`[center_client]`… |

配置装配统一走 `ConfigManager`（与 flow/report/mdm 同一制度：`CONFIG_FILE` toml + env → 全局 ConfigManager，Nacos 启用时叠加远程源）。

### 微服务开关 `[center_client]`

门户对下游能力中心「内嵌 vs 独立微服务」只看这一段配置——服务定位为**自由键值表**（urls 手动基址 /
discovery.services Nacos 服务名，新增微服务只加一行键值），`mode` 驱动导入器传输与反代目标来源
（local → 不挂反代；http_url → urls 基址；http_discovery/grpc → Nacos 服务发现选例）：

```toml
[center_client]
mode = "http_url"

[center_client.urls]
# 导入器目标（自环门户统一端点）
menu = "http://127.0.0.1:8080"
# 反代目标：非空 → 独立微服务模式，门户的 /api/flow/* 转发到此基址；不配 → 门户无该路由。
flow = "http://127.0.0.1:8091"
report = "http://127.0.0.1:8092"
rules = "http://127.0.0.1:8094"

[center_client.discovery.services]
# mode = "http_discovery"/"grpc" 时改查此表（Nacos 注册名）
flow = "cmx-flow-server"
```

---

## 目录结构

```
cmx-portalservice/
├── crates/
│   ├── cmx-portal-server/       # 薄 bin：门户 banner + run_platform
│   └── cmx-portal/              # 门户业务层（meta/pages/dam/notify/agent/…）
├── bash/                        # 部署/运维脚本（appctl / deploy）
├── portal.sh                    # 统一启动脚本
├── portal-server.toml           # 主配置（CONFIG_FILE 指向）
├── .env                         # 环境变量（CONFIG_FILE / WEB_FOLDER / Nacos …）
├── .cargo/config.toml           # aliyun 镜像 + nora registry 定义（跨 ws 解析所需）
├── Cargo.toml                   # workspace 定义（2 成员 + 跨 ws path 依赖）
└── Cargo.lock                   # 锁定依赖（可复现构建）
```

> `target/`（18G+）、`logs/`、`storage/` 经 `.gitignore` 排除。`.cargo/config.toml` 与 `Cargo.lock` 刻意保留（前者跨 workspace 解析必需，后者保可复现构建）。

---

## 许可

[Apache-2.0](LICENSE)。
