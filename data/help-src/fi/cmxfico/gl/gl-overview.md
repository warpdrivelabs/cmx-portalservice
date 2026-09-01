---
title: 总账模块概述
summary: cmx-fico 总账(GL)模块的定位、核心对象与典型业务流。本页含跳转到其它帮助主题的链接。
keywords:
  - 总账
  - GL
  - 概述
  - 凭证
  - fico
examples:
  - title: 凭证 JSON 结构（最小示例）
    lang: json
    note: 一张借贷平衡的凭证最小骨架。
    code: |-
      {
        "header": { "date": "2026-06-27", "type": "SA", "memo": "报销" },
        "lines": [
          { "account": "6602", "dc": "D", "amount": 100.00 },
          { "account": "1001", "dc": "C", "amount": 100.00 }
        ]
      }
---

# 总账(GL)模块概述

总账模块是 **cmx-fico** 的核心，负责凭证的录入、校验、过账与账簿汇总。

## 核心对象

- **凭证批(batch)**：一次提交的一组凭证。
- **凭证头(header)**：单张凭证的抬头信息（日期、凭证类型、摘要）。
- **科目行(account line)**：借贷分录行，挂接 [会计科目](help:master-account)。
- **辅助行(auxiliary line)**：成本中心、项目等辅助核算维度。

## 典型业务流

1. 先维护好 [会计科目](help:master-account) 主数据。
2. 在 [录入凭证](help:voucher-entry) 界面填写凭证头与分录行。
3. 系统校验 **借贷平衡** 与科目有效性。
4. [过账与冲销](help:voucher-post) 后写入总账，生成余额。

## 关键约束

- 每张凭证 `借方合计 == 贷方合计`，详见 [录入凭证](help:voucher-entry) 的校验规则。
- 已过账凭证不可直接修改，需 [冲销](help:voucher-post) 后重做。

> 提示：以上紫色带「›」的链接为 **站内帮助跳转**，点击后可用上方标题区的 **后退/前进** 返回。平台整体用法见 [快速开始](help:portal/portal/overview/getting-started)。
