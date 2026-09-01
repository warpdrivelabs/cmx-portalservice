---
title: 从帮助直接执行功能
summary: 演示帮助正文里的「执行功能」链接：点击直接打开工作区节点或菜单，而不是跳到另一篇帮助。
keywords:
  - 执行
  - 跳转
  - 工作区节点
  - 菜单
  - launch
  - node
  - menu
path: 进阶
order: 5
actions:
  damRegistry:
    id: portal-dam-registry
    name: dam-registry
    caption: DAM 注册管理中心
    icon: tree
    workspace:
      explorer:
        caption: DAM 导航
        icon: tree
        views:
          - tabLabel: DAM
            icon: tree
            type: native_pages
            native_page: portal.dam.registry-center
            view: explorer
            props: {}
      content:
        caption: DAM 注册管理中心
        icon: tree
        views:
          - tabLabel: 注册中心
            icon: tree
            type: native_pages
            native_page: portal.dam.registry-center
            view: manager
            props: {}
      property:
        caption: 资源
        icon: documents
        views:
          - tabLabel: 资源
            icon: documents
            type: native_pages
            native_page: portal.dam.registry-center
            view: property
            props: {}
  helpCenter:
    id: portal-help-center
    name: help-center
    caption: 帮助中心
    icon: sys-help
    workspace:
      explorer:
        caption: 帮助目录
        icon: tree
        views:
          - tabLabel: 目录
            icon: tree
            type: native_pages
            native_page: portal.help.center
            view: explorer
            props: {}
      content:
        caption: 帮助中心
        icon: sys-help
        views:
          - tabLabel: 详细内容
            icon: sys-help
            type: native_pages
            native_page: portal.help.center
            view: content
            props: {}
      property:
        caption: 样例 / 示例
        icon: example
        views:
          - tabLabel: 样例
            icon: example
            type: native_pages
            native_page: portal.help.center
            view: property
            props: {}
examples:
  - title: 在帮助文档里声明可执行动作（actions 字段）
    lang: json
    note: actions 的每个 value 是一个菜单节点对象（含 workspace），wsnode:#key 即引用它。
    code: |-
      {
        "id": "launch-demo",
        "content": "...点 [打开](wsnode:#damRegistry)...",
        "actions": {
          "damRegistry": {
            "id": "portal-dam-registry",
            "caption": "DAM 注册管理中心",
            "icon": "tree",
            "workspace": { "explorer": { "...": "..." }, "content": { "...": "..." } }
          }
        }
      }
---

# 从帮助直接执行功能

帮助正文的链接有两类：

- **站内跳转**（紫色带「›」）：打开另一篇帮助，可用标题区 后退/前进 返回。例如 [快速开始](help:getting-started)。
- **执行功能**（薄荷绿胶囊带运行图标）：直接打开某个工作区节点或菜单，等同于点左侧菜单/节点库。

## 一、文档内联定义的节点 `wsnode:#key`

下面两个按钮的目标定义在本帮助文档的 `actions` 字段里，点击直接 seed 打开，无需后端先建节点：

- 打开 [DAM 注册管理中心](wsnode:#damRegistry) —— 三区注册主数据维护。
- 打开 [帮助中心本身](wsnode:#helpCenter) —— 即当前这个三区帮助页。

## 二、已保存的工作区节点 `node:<id>`

引用节点库中已保存的节点（`/api/workspace-nodes/{id}`）：

- 打开 [示例工作台](node:help-demo-node)。

## 三、菜单 / 活动 `menu:<menuKey>`

按 menu-pages 文件名执行某侧边栏菜单（与点活动等效）：

- 打开 [总账浏览菜单](menu:explorer-menu)。

> 写法：`[文字](wsnode:#key)`、`[文字](node:节点id)`、`[文字](menu:菜单key)`。目标无法解析时链接会显示为删除线，避免静默失效。
