//! agent 工具 schema（与 Node `agentTools.js` 一致）。

use serde_json::{Value, json};

/// Agent 工具公开 schema（capabilities 返回）。
///
/// # Returns
///
/// 返回一个 JSON 数组，每个元素描述一个工具的名称、描述、是否需要审批以及输入 schema。
pub fn public_tool_schemas() -> Value {
    json!([
        {
            "name": "search_files", "description": "搜索项目文件内容", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "搜索关键词或文件名" },
                "limit": { "type": "number", "description": "最多返回条数" }
            }, "required": ["query"] }
        },
        {
            "name": "read_file", "description": "读取项目内指定文件", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "相对 CMXPortalManager 根目录的文件路径" }
            }, "required": ["path"] }
        },
        {
            "name": "list_definitions", "description": "列出定义中心元数据文件摘要", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["DCT", "DOC", "BASE"] },
                "domain": { "type": "string" }, "module": { "type": "string" }, "limit": { "type": "number" }
            } }
        },
        {
            "name": "list_html_pages", "description": "列出自定义 HTML 页面/设计系统页面摘要", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "page": { "type": "number", "description": "页码，默认 1" },
                "pageSize": { "type": "number", "description": "每页数量，默认 20，最大 50" }
            } }
        },
        {
            "name": "read_html_page", "description": "读取指定自定义 HTML 页面源码", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string", "description": "HTML 页面 ID，如 fi.cmxfico.gl.demo-page 或 welcome" }
            }, "required": ["id"] }
        },
        {
            "name": "validate_metadata", "description": "检查元数据 JSON 是否可解析", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "可选，指定要检查的文件或目录" }
            } }
        },
        {
            "name": "list_modules", "description": "列出 DAM/模块清单摘要", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "application": { "type": "string" },
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "get_module_manifest", "description": "读取指定模块 module.json 清单", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "application": { "type": "string" },
                "module": { "type": "string" }
            }, "required": ["domain", "module"] }
        },
        {
            "name": "get_module_resource", "description": "解析模块指定类型资源并标注存在性", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "application": { "type": "string" },
                "module": { "type": "string" }, "type": { "type": "string" }
            }, "required": ["domain", "module", "type"] }
        },
        {
            "name": "list_dict_schemas", "description": "列出字典 schema 注册表", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "dict_search", "description": "按字典 ID 检索字典项", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "dictId": { "type": "string" }, "q": { "type": "string" }, "query": { "type": "string" },
                "limit": { "type": "number" }, "body": { "type": "object" }
            }, "required": ["dictId"] }
        },
        {
            "name": "dict_suggest", "description": "按字典 ID 获取输入建议", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "dictId": { "type": "string" }, "q": { "type": "string" }
            }, "required": ["dictId"] }
        },
        {
            "name": "list_facts", "description": "列出事实数据文件", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "get_fact", "description": "读取指定事实数据 JSON", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "file": { "type": "string" }
            }, "required": ["domain", "app", "module", "file"] }
        },
        {
            "name": "service_catalog_list", "description": "列出服务目录摘要", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "service_catalog_get", "description": "读取指定服务目录详情", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" }
            }, "required": ["id"] }
        },
        {
            "name": "flexible_combination_list", "description": "列出弹性组合", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "flexible_combination_get", "description": "读取指定弹性组合", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "scenario": { "type": "string" }
            }, "required": ["domain", "app", "module"] }
        },
        {
            "name": "flexible_combination_validate", "description": "校验弹性组合配置", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "scenario": { "type": "string" }, "combination": { "type": "object" }
            } }
        },
        {
            "name": "flexible_combination_preview", "description": "预览弹性组合解析结果", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "scenario": { "type": "string" }, "combination": { "type": "object" }, "anchor": { "type": "object" }
            } }
        },
        {
            "name": "flexible_combination_resolve", "description": "按锚点解析弹性组合字段/列模型", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "scenario": { "type": "string" }, "anchor": { "type": "object" }
            }, "required": ["domain", "app", "module"] }
        },
        {
            "name": "flexible_combination_rule", "description": "按锚点获取命中的上下文规则", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "domain": { "type": "string" }, "app": { "type": "string" }, "module": { "type": "string" },
                "scenario": { "type": "string" }, "anchor": { "type": "object" }
            }, "required": ["domain", "app", "module"] }
        },
        {
            "name": "git_status", "description": "读取 git 工作区状态", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "git_diff", "description": "读取 git diff，可指定文件路径", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "staged": { "type": "boolean" }, "maxBytes": { "type": "number" }
            } }
        },
        {
            "name": "git_log", "description": "读取最近 git 提交摘要", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "list_local_plugins", "description": "扫描本地插件 manifest / mcpdata / .agents 目录", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "number" }
            } }
        },
        {
            "name": "inspect_plugin_manifest", "description": "读取本地插件 manifest.json", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "pluginId": { "type": "string" }
            } }
        },
        {
            "name": "call_plugin_function", "description": "审批后调用插件函数（需要运行时桥接）", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "serviceName": { "type": "string" }, "pluginId": { "type": "string" },
                "functionName": { "type": "string" }, "input": { "type": "object" }
            }, "required": ["pluginId", "functionName"] }
        },
        {
            "name": "call_service_flow", "description": "审批后调用服务编排流程（需要运行时桥接）", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "serviceName": { "type": "string" }, "serviceKey": { "type": "string" },
                "input": { "type": "object" }, "timeoutMs": { "type": "number" }
            }, "required": ["serviceKey"] }
        },
        {
            "name": "generate_api_doc", "description": "生成服务编排 API 文档（需要插件运行时上下文）", "requiresApproval": false,
            "inputSchema": { "type": "object", "properties": {
                "pluginId": { "type": "string" }, "version": { "type": "string" },
                "orchestration": { "type": "object" }, "installPath": { "type": "string" }
            } }
        },
        {
            "name": "cargo_check", "description": "审批后执行 cargo check", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "package": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "cargo_build", "description": "审批后执行 cargo build", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "package": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "cargo_test", "description": "审批后执行 cargo test", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "package": { "type": "string" }, "test": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "cargo_clippy", "description": "审批后执行 cargo clippy", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "package": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "npm_test", "description": "审批后执行 npm test，可指定 workspace", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "workspace": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "npm_build_workspace", "description": "审批后执行 npm run build，可指定 workspace 或根脚本", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "workspace": { "type": "string" }, "script": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "run_playwright", "description": "审批后执行 Playwright 测试", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "project": { "type": "string" }, "grep": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "capture_page_screenshot", "description": "审批后用 Playwright 对 URL 截图", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "url": { "type": "string" }, "output": { "type": "string" }, "timeoutMs": { "type": "number" }
            }, "required": ["url"] }
        },
        {
            "name": "inspect_dom", "description": "审批后用 Playwright 读取页面标题和指定选择器文本", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "url": { "type": "string" }, "selector": { "type": "string" }, "timeoutMs": { "type": "number" }
            }, "required": ["url"] }
        },
        {
            "name": "check_accessibility", "description": "审批后运行可访问性检查入口（当前通过 Playwright grep 约定执行）", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "url": { "type": "string" }, "timeoutMs": { "type": "number" }
            } }
        },
        {
            "name": "apply_file_patch", "description": "审批后应用 unified diff patch", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "patch": { "type": "string" }
            }, "required": ["patch"] }
        },
        {
            "name": "format_file", "description": "审批后格式化指定文件（rustfmt / prettier）", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "timeoutMs": { "type": "number" }
            }, "required": ["path"] }
        },
        {
            "name": "create_file", "description": "审批后创建项目内文本文件", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "content": { "type": "string" }, "overwrite": { "type": "boolean" }
            }, "required": ["path", "content"] }
        },
        {
            "name": "rename_file", "description": "审批后重命名/移动项目内文件", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "from": { "type": "string" }, "to": { "type": "string" }
            }, "required": ["from", "to"] }
        },
        {
            "name": "run_command", "description": "审批后执行预置安全命令", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string", "enum": ["npm", "cargo", "git", "npx", "node"] },
                "args": { "type": "array", "items": { "type": "string" }, "description": "白名单命令参数" },
                "timeoutMs": { "type": "number" }
            }, "required": ["command", "args"] }
        },
        {
            "name": "apply_json_patch", "description": "审批后应用 JSON Pointer 补丁", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" },
                "pointer": { "type": "string", "description": "JSON Pointer，如 /moduleMeta/isDefault" },
                "value": { "description": "要写入的 JSON 值" }
            }, "required": ["path", "pointer", "value"] }
        },
        {
            "name": "apply_text_replace", "description": "审批后应用文本替换补丁", "requiresApproval": true,
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" }, "oldText": { "type": "string" }, "newText": { "type": "string" },
                "occurrence": { "type": "string", "enum": ["first", "all"] }
            }, "required": ["path", "oldText", "newText"] }
        }
    ])
}
