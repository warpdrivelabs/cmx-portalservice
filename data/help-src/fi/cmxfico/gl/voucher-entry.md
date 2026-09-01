---
title: 录入凭证
summary: 在三区工作台录入一张总账凭证的步骤与校验规则。
keywords:
  - 凭证
  - 录入
  - 分录
  - 借贷平衡
  - voucher
path: 凭证管理
order: 1
examples:
  - title: 录入接口请求体
    lang: json
    note: POST 提交一张凭证（伪示例）。
    code: |-
      {
        "batchId": "B-2026-0627-001",
        "header": { "date": "2026-06-27", "type": "SA", "memo": "差旅报销" },
        "lines": [
          { "account": "660203", "dc": "D", "amount": 1200, "costCenter": "CC-FIN" },
          { "account": "100201", "dc": "C", "amount": 1200 }
        ]
      }
  - title: 借贷平衡校验（伪代码）
    lang: javascript
    code: |-
      const debit = lines.filter(l => l.dc === 'D').reduce((s, l) => s + l.amount, 0)
      const credit = lines.filter(l => l.dc === 'C').reduce((s, l) => s + l.amount, 0)
      if (debit !== credit) throw new Error('借贷不平衡')
---

# 录入凭证

在 **ERP凭证(三区工作台)** 中录入凭证：左侧选择凭证批，中间编辑凭证头与分录，右侧维护辅助核算。整体背景见 [总账模块概述](help:gl-overview)。

## 步骤

1. 在 explorer 选择或新建 **凭证批**。
2. 在 content 区填写凭证头：`记账日期`、`凭证类型`、`摘要`。
3. 逐行添加 **科目行**，录入借/贷方向与金额；科目来自 [会计科目](help:master-account)。
4. 需要辅助核算的行，在 property 区补充 `成本中心` / `项目`。

## 校验规则

- 借方合计必须等于贷方合计，否则无法保存。
- 科目必须是 **末级科目** 且处于启用状态（见 [会计科目](help:master-account)）。
- 外币凭证需录入 `汇率`，本位币金额自动折算。

## 下一步

录入完成并校验通过后，进入 [过账与冲销](help:voucher-post)。
