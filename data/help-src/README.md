# 帮助文档源（help-src）

这里是帮助中心文档的**可手写源文件**（Markdown + YAML frontmatter）。
后端真正读取的是构建产物 `../help/**/*.json`——**不要直接改那些 JSON**，改这里的 `.md`，再跑构建脚本生成。

## 为什么有这一层

后端按 `help/<域>/<应用>/<模块>/<文件>.json` 读文档，`content` 当 markdown、`examples[].code`
当代码字符串直接用。JSON 里这些字段满是 `\n` 转义、代码还要双重转义，人手几乎没法编辑。
本目录让你用自然 markdown + YAML 写（正文不转义、代码用 `|` 块标量原样贴），构建成等价 JSON。
**不改任何后端/前端运行代码**，所有功能（搜索/分级目录/前进后退/`help:`跳转/`node:menu:wsnode:`执行/AI 问答与打开功能）不受影响。

## 目录约定

源路径决定 DAM 归属，无需在 frontmatter 重复写：

```
help-src/<域>/<应用>/<模块>/<id>.md   →   help/<域>/<应用>/<模块>/<id>.json
例：help-src/fi/cmxfico/gl/voucher-entry.md → help/fi/cmxfico/gl/voucher-entry.json
```

## 文件格式

```markdown
---
title: 录入凭证                 # 标题（缺省用文件名 id）
summary: 一句话简介             # explorer 列表/搜索用
keywords: [凭证, 录入]          # 搜索关键词
path: 凭证管理                  # 模块内分级目录（斜杠分级，可空）
order: 1                        # 同级排序（默认 0）
actions:                        # 可选：wsnode:#key 引用的内联工作区节点 / node: / menu:
  damRegistry: { kind: node, id: portal-dam-registry }
examples:                       # 可选：property 区样例，code 用 | 块标量免转义
  - title: 请求体
    lang: json
    note: 说明（可选）
    code: |
      { "batchId": "B-1", "amount": 1200 }
---

# 正文标题

这里是 **真·markdown** 正文，可写：
- 站内跳转：[会计科目](help:master-account)
- 跨域跳转：[总账概述](help:fi/cmxfico/gl/gl-overview)
- 执行功能：[打开DAM](wsnode:#damRegistry) / [打开节点](node:节点id) / [执行菜单](menu:菜单key)
```

字段与产物 JSON 一一对应：`domain/app/module/id/file` 由路径推导，其余来自 frontmatter，
正文 → `content`，`updatedAt` 构建时自动写。

## 构建

```bash
cd cmx-container
node scripts/build-help.mjs           # .md → .json（只重建有变化的）
node scripts/build-help.mjs --check   # 只校验产物是否与源一致（提交前/CI 用，不写盘）
node scripts/build-help.mjs --clean   # 构建并删除「源已不存在」的孤儿 json
```

新增一篇：在对应 `域/应用/模块/` 下建 `<id>.md`，跑构建即可（目录会自动创建）。
