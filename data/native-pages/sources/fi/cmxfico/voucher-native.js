/**
 * cmxfico 会计凭证业务单据 —— native_pages 模式（程序化 .js）
 *
 * 基于 fico-db 已有的 cmx-fico 总账凭证表（cv_batch → cv_header → cv_acc_line → cv_aux_line，
 * 四层 id→upper_id 主从），通过后端 /api/doc/* 端点装载/回存：
 *   - 装载：GET  /api/doc/data/sqlx-dataset-json?domain=fi&application=cmxfico&module=gl&file=cmxfico_doc_meta_v1.json
 *   - 回存：POST /api/doc/save（merge 双模式 changeset）
 * db_id 头固定 fico-db。
 *
 * 用 CmxMasterSlave + cmx-revo-grid 呈现四层主从联动；字典列 id→name 走 CmxDictCache（L0）。
 *
 * 契约：export default { defaultView, views:{ name(ctx) } }；ctx.host.renderRoot 挂载。
 * CMX 类经 globalThis.__cmxDataComp 取用（原生页由 Blob import 预挂）。
 */

const DEF = { domain: 'fi', application: 'cmxfico', module: 'gl', file: 'cmxfico_doc_meta_v1.json' }
const DB_ID = 'fico-db'
const ROOT_TABLE = 'cv_batch'

const cmx = () => (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}
const { apiJson: _apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js）

/* ── 后端 API ─────────────────────────────────────────────────────────── */
/* 注意：CMXPortalManager 的 api-client 全局 patch 了 window.fetch，成功时会
   透明拆掉 ApiResp 信封 → res.json() 直接拿到内层 data（res.ok=true）；
   业务错误 → 非 2xx + { error }。这里同时兼容「已拆包」与「原始信封」两种形态。 */

/** GET JSON（带本页 db_id 头）：共享封装负责信封解包与错误透传，
 *  双模式（门户拦截器已拆包的裸 data / 原始 {code,msg,data} 信封）均兼容。 */
async function apiGet (url) {
  return _apiJson(url, { headers: { db_id: DB_ID } })
}

/** POST JSON（带本页 db_id 头）。 */
async function apiPost (url, payload) {
  return _apiJson(url, { method: 'POST', headers: { db_id: DB_ID }, body: JSON.stringify(payload || {}) })
}

const dataQuery = (extra = {}) => {
  const p = new URLSearchParams({ domain: DEF.domain, application: DEF.application, module: DEF.module, file: DEF.file, ...extra })
  return `/api/doc/data/sqlx-dataset-json?${p.toString()}`
}
const saveQuery = () => {
  const p = new URLSearchParams({ domain: DEF.domain, application: DEF.application, module: DEF.module, file: DEF.file })
  return `/api/doc/save?${p.toString()}`
}

/* ── 列模型定义（各层展示列，与凭证定义字段对齐） ─────────────────────────── */

const COLUMN_DEFS = {
  cv_batch: [
    { id: 'doc_no', caption: '凭证批号', type: 'text', width: '140px' },
    { id: 'batch_name', caption: '批名称', type: 'text', width: '180px' },
    { id: 'comp_unit_id', caption: '公司代码', type: 'text', width: '110px' },
    { id: 'period_code', caption: '会计期间', type: 'text', width: '100px' },
    { id: 'posting_date', caption: '过账日期', type: 'date', width: '120px' },
    { id: 'doc_status', caption: '状态', type: 'text', width: '90px', editMode: 'readonly' },
  ],
  cv_header: [
    { id: 'doc_no', caption: '凭证号', type: 'text', width: '130px' },
    { id: 'fiscal_year', caption: '会计年度', type: 'text', width: '90px' },
    { id: 'posting_period', caption: '记账期间', type: 'number', width: '90px', align: 'right' },
    { id: 'doc_currency_code', caption: '凭证货币', type: 'text', width: '90px' },
    { id: 'local_dr', caption: '本位币借方', type: 'number', width: '130px', align: 'right' },
    { id: 'local_cr', caption: '本位币贷方', type: 'number', width: '130px', align: 'right' },
  ],
  cv_acc_line: [
    { id: 'line_no', caption: '行号', type: 'number', width: '60px', align: 'right' },
    { id: 'gl_account_id', caption: '总账科目', type: 'text', width: '120px' },
    { id: 'debit_credit_code', caption: '借贷', type: 'text', width: '70px' },
    { id: 'item_text', caption: '行项目文本', type: 'text', width: '200px' },
    { id: 'local_dr', caption: '本位币借方', type: 'number', width: '130px', align: 'right' },
    { id: 'local_cr', caption: '本位币贷方', type: 'number', width: '130px', align: 'right' },
  ],
  cv_aux_line: [
    { id: 'line_no', caption: '行号', type: 'number', width: '60px', align: 'right' },
    { id: 'profit_ctr_id', caption: '利润中心', type: 'text', width: '110px' },
    { id: 'cost_center_id', caption: '成本中心', type: 'text', width: '110px' },
    { id: 'segment_id', caption: '段', type: 'text', width: '100px' },
    { id: 'local_dr', caption: '本位币借方', type: 'number', width: '120px', align: 'right' },
    { id: 'local_cr', caption: '本位币贷方', type: 'number', width: '120px', align: 'right' },
  ],
}

/* ── 物理表名 → 中文层名（校验失败提示定位「哪一层」用） ─────────────────── */
const TABLE_NAMES = {
  cv_batch: '凭证批',
  cv_header: '凭证头',
  cv_acc_line: '科目行',
  cv_aux_line: '辅助核算行',
}

/* ── 主从 schema（与后端 relations 对齐：id→upper_id 四层） ───────────────── */

const SCHEMA = [{
  id: 'cv_batch',
  children: [{
    id: 'cv_header',
    children: [{
      id: 'cv_acc_line',
      children: [{ id: 'cv_aux_line' }],
    }],
  }],
}]

/* ── 页面状态 ─────────────────────────────────────────────────────────── */

const state = { ms: null, collector: null, grids: {}, loading: false, message: '' }

/* ── HTML 骨架 ───────────────────────────────────────────────────────── */

function pageHtml () {
  return `
${styleHtml()}
<div class="vch-root">
  <ui5-bar design="Header" class="vch-bar">
    <span slot="startContent" class="vch-title">会计凭证（cmx-fico 总账 · native_pages）</span>
    <span slot="startContent" class="vch-msg" id="vchMsg"></span>
    <ui5-button slot="endContent" design="Emphasized" id="btnLoad">加载凭证</ui5-button>
    <ui5-button slot="endContent" design="Default" id="btnSave">保存</ui5-button>
  </ui5-bar>
  <div class="vch-grids">
    <div class="vch-pane"><ui5-title level="H5" size="H5">凭证批（L1）</ui5-title>
      <cmx-revo-grid id="gBatch" class="vch-grid"></cmx-revo-grid></div>
    <div class="vch-pane"><ui5-title level="H5" size="H5">凭证头（L2）</ui5-title>
      <cmx-revo-grid id="gHeader" class="vch-grid"></cmx-revo-grid></div>
    <div class="vch-pane"><ui5-title level="H5" size="H5">科目行（L3）</ui5-title>
      <cmx-revo-grid id="gAcc" class="vch-grid"></cmx-revo-grid></div>
    <div class="vch-pane"><ui5-title level="H5" size="H5">辅助核算行（L4）</ui5-title>
      <cmx-revo-grid id="gAux" class="vch-grid"></cmx-revo-grid></div>
  </div>
</div>`
}

function styleHtml () {
  return `<style>
.vch-root{display:flex;flex-direction:column;height:100%;gap:6px;padding:8px;box-sizing:border-box;min-width:0}
.vch-bar{flex:0 0 auto}
.vch-title{font-weight:600}
.vch-msg{margin-left:12px;color:#0854a0;font-size:12px}
.vch-grids{flex:1;display:flex;flex-direction:column;gap:6px;min-height:0;min-width:0;overflow:hidden}
.vch-pane{flex:1 1 0;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.vch-grid{display:block;width:100%;flex:1;min-height:0;min-width:0}
</style>`
}

/* ── 绑定与数据 ───────────────────────────────────────────────────────── */

function setMsg (root, text) {
  const el = root.querySelector('#vchMsg')
  if (el) {
    // 多行提示（校验明细）需保留换行；span 默认不换行，置 pre-wrap。
    el.style.whiteSpace = 'pre-wrap'
    el.textContent = text || ''
  }
}

function buildColumnModel (C, datasetId, cols) {
  return new C.CmxColumnModel({
    datasetId,
    members: cols.map((c) => new C.CmxColumn(c)),
  })
}

/** 建协调器 + 列模型 + 绑定四层 grid（幂等）。先于装载执行，保证表头立即显示。 */
function setupGrids (root) {
  const C = cmx()
  if (!C.CmxMasterSlave) { setMsg(root, 'CMX 数据类未加载'); return null }
  if (state.ms) return state.ms   // 已建好，复用

  const ms = new C.CmxMasterSlave({ schema: SCHEMA })
  const gBatch = root.querySelector('#gBatch')
  const gHeader = root.querySelector('#gHeader')
  const gAcc = root.querySelector('#gAcc')
  const gAux = root.querySelector('#gAux')
  if (!gBatch || !gHeader || !gAcc || !gAux) { setMsg(root, '网格元素未就绪'); return null }

  // 先设列模型 → 表头立即渲染（不依赖数据）
  gBatch.setColumnModel(buildColumnModel(C, 'cv_batch', COLUMN_DEFS.cv_batch))
  gHeader.setColumnModel(buildColumnModel(C, 'cv_batch.cv_header', COLUMN_DEFS.cv_header))
  gAcc.setColumnModel(buildColumnModel(C, 'cv_batch.cv_header.cv_acc_line', COLUMN_DEFS.cv_acc_line))
  gAux.setColumnModel(buildColumnModel(C, 'cv_batch.cv_header.cv_acc_line.cv_aux_line', COLUMN_DEFS.cv_aux_line))

  for (const g of [gBatch, gHeader, gAcc, gAux]) {
    g.setOptions({ selectionMode: 'single', fillHeight: true, showRowIndex: true, editable: true, stretch: false })
  }

  ms.bindTable('cv_batch', gBatch)
  ms.bindTable('cv_batch.cv_header', gHeader)
  ms.bindTable('cv_batch.cv_header.cv_acc_line', gAcc)
  ms.bindTable('cv_batch.cv_header.cv_acc_line.cv_aux_line', gAux)

  state.ms = ms
  state.grids = { gBatch, gHeader, gAcc, gAux }
  return ms
}

/** 拉后端数据灌入协调器。表头已由 setupGrids 建好，此处只负责数据。 */
async function loadVoucher (root) {
  const C = cmx()
  const ms = setupGrids(root)          // 幂等：先保证表头 + 协调器就位
  if (!ms) return
  setMsg(root, '装载中…')

  let dsMap
  try {
    const pkg = await apiGet(dataQuery({ limit: '50' }))
    if (!pkg || pkg.datasetId == null) throw new Error('返回数据为空')
    dsMap = { [pkg.datasetId]: C.CmxDataSet.fromJSON(pkg) }
  } catch (e) {
    setMsg(root, `装载失败：${e.message}`)
    return
  }

  ms.setDataSet(dsMap)   // 灌数据 + 首行级联点亮

  // 变更收集器（保存用）
  state.collector = C.ChangeSetCollector ? new C.ChangeSetCollector(ms).attach() : null

  const rootDs = ms.getRootDataSet('cv_batch')
  setMsg(root, `已装载 ${rootDs ? rootDs.length : 0} 个凭证批`)
}

async function saveVoucher (root) {
  const C = cmx()
  if (!state.ms) { setMsg(root, '请先加载凭证'); return }
  if (!state.collector) { setMsg(root, '变更收集器未就绪'); return }
  const changes = state.collector.export()
  if (!Object.keys(changes).length) { setMsg(root, '无变更可保存'); return }
  setMsg(root, '保存中…')
  try {
    let result
    if (typeof C.saveDocData === 'function') {
      result = await C.saveDocData(null, { ...DEF, dbId: DB_ID }, { saveMode: 'merge', changes, tableNames: TABLE_NAMES })
    } else {
      result = await apiPost(saveQuery(), { saveMode: 'merge', changes })
    }
    state.collector.reset()
    setMsg(root, `保存成功：影响 ${result.affected} 行`)
  } catch (e) {
    // 校验失败：e.message 已含多行明细（层/列/原因）；e.violations 为结构化数组。
    // 不 reset collector —— 用户改动保留，改完可重存。
    setMsg(root, e && e.violations ? `数据校验未通过：\n${C.formatViolations(e.violations, TABLE_NAMES)}` : `保存失败：${e.message}`)
  }
}

function bindPage (root) {
  root.querySelector('#btnLoad')?.addEventListener('click', () => loadVoucher(root))
  root.querySelector('#btnSave')?.addEventListener('click', () => saveVoucher(root))
  // 先建表头（不依赖数据），下一帧再自动装载数据
  Promise.resolve().then(() => {
    setupGrids(root)                       // 表头立即显示
    setMsg(root, '就绪，正在装载…')
    return loadVoucher(root)               // 再灌数据
  })
}

/* ── mount + export ──────────────────────────────────────────────────── */
/*
 * native_pages 契约（关键）：
 *   views.content(ctx) 只**返回 HTML 字符串**；宿主 cmx-native-pages-host 会：
 *     ① 清空 shadowRoot、新建 .native-page-root
 *     ② 把返回的 HTML 挂进 root（此时 host.renderRoot 才指向该 root）
 *     ③ 执行 HTML 里的 <script>
 *   所以【不能】在 content 里自己 root.innerHTML（会产生两份 DOM，且被宿主清空覆盖）。
 *   绑定/装数据必须等宿主渲染完成——这里用 rAF 轮询等待 host.renderRoot 出现本页 DOM 后再绑定。
 */

function whenRendered (host, selector, cb, tries) {
  const t = tries == null ? 60 : tries
  const root = host && host.renderRoot
  if (root && root.querySelector(selector)) { cb(root); return }
  if (t <= 0) return
  requestAnimationFrame(() => whenRendered(host, selector, cb, t - 1))
}

export default {
  defaultView: 'content',
  views: {
    async content (ctx) {
      const host = ctx && ctx.host
      // 宿主渲染完本页 DOM 后再绑定（本页根节点 .vch-root 出现即就绪）
      if (host) {
        // 每次进入视图重置模块级状态，避免复用上一实例的协调器/网格引用
        state.ms = null
        state.collector = null
        state.grids = {}
        whenRendered(host, '.vch-root', (root) => bindPage(root))
      }
      // 只返回 HTML 字符串，交给宿主渲染
      return pageHtml()
    },
  },
}
