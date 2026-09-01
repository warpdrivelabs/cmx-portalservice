---
title: 会计科目
summary: 会计科目表的层级结构、科目类型与启用/停用维护。
keywords:
  - 会计科目
  - 科目表
  - 主数据
  - account
  - 末级科目
path: 主数据
order: 1
examples:
  - title: 科目节点结构
    lang: json
    code: |-
      {
        "code": "1001",
        "name": "库存现金",
        "account_type_code": "ASSET",
        "parent": "10",
        "is_leaf": true,
        "status": "active"
      }
---

# 会计科目

会计科目表(Chart of Accounts)是总账的基础主数据，按 **资产 / 负债 / 权益 / 成本 / 损益** 分类，呈树形层级。它是 [录入凭证](help:voucher-entry) 时分录行可选科目的来源。

## 要点

- 仅 **末级科目** 可用于凭证分录。
- 科目类型决定其在报表中的归属与余额方向。
- 会计等式恒成立：`资产 = 负债 + 权益`。

## 维护

在 **会计核算管理工作台** 左侧科目树中新增/编辑科目，按 `account_type_code` 派生 6 类过滤视图。

相关：[总账模块概述](help:gl-overview) · [过账与冲销](help:voucher-post)。
