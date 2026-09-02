/**
 * 集群数据源浏览（cluster datasource browser）—— native_pages 三区只读功能。
 *
 * explorer：顶部 domain/app（一行）+ module（单独一行）三个 DAM 下拉（含「全部」）；
 *           下方为上下可调分割：上=<cmx-ignite-list> 数据库列表（按 db_type 设图标），
 *           下=选中数据库概览（dbSummaryHtml：标题区 + 连接健康 + 指标卡片），中间 .cds-splitter 拖动调高。
 * content：三个视图（数据字典 DCT / 业务单据 DOC / 弹性组合 profile），
 *           顶部标题区下拉「选具体档案 + 版本」，下方只读展示其详情（参考三大功能的展示，去掉编辑）。
 * property：展示 content 区当前选中项的只读详情。
 *
 * 跨区通信：模块级 state 单例（三区共用）+ data-bus-scope（content↔property 嵌入式组件总线）
 *           + 框架级事件（hideProperty / syncPropertyView，见 menu-node 配置）。
 *           数据组件（CmxDataSet / cmx-ignite-list / cmx-ui5-form / CmxColumnModel）经
 *           globalThis.__cmxDataComp 取用--原生页由 Blob import 加载，无法裸引 'cmx-data-comp'。
 *
 * 说明：DAM 下拉同时过滤「数据库列表」与 content 区——数据库列表按所选 domain/app/module
 *       调用 /api/sys-datasource/list 的 filters（domain_code/application_code/module_code）过滤；
 *       三者均为空时展示集群全部数据源。列表项标题展示「db_id-db_name」。
 */

// ─── 共享状态（模块级单例，三区共用） ─────────────────────────────────────
const state = {
  dam: { domains: [], apps: [], modules: [] },
  filter: { domain: '', app: '', module: '' }, // '' = 全部
  datasources: [],           // /api/sys-datasource/list 的 rows
  dsLoading: false,
  selectedDsId: '',          // 选中的数据源 id
  explorer: { splitPct: Number(localStorage.getItem('cds-explorer-splitPct')) || 52 }, // explorer 上下分割：上半占比 %（持久化到 localStorage）
  // 数据库运维工作台（概览页下方）：场景由「数据库态 × 每模块每 kind 版本态」组合推导，真实落库。
  build: {
    loaded: false, loading: false, error: '',
    loadingPromise: null,    // loadDbState 的在途 Promise（防并发/防循环调用）
    dbState: null,           // { db_id, page_mode, db_status, meta_version, expected_meta_version, scenario_counts, modules[] }
    dsKey: '',               // 当前 dbState 对应的 db_id（切库时失效重算）
    dbStateAbort: null,      // loadDbState 的 AbortController（切库时取消上一个请求，避免竞态）
    opTab: '',               // 顶部 tab：''=运维总览 / init=初始化
    query: '',               // 模块矩阵搜索
    scenarioFilter: '',      // 徽标过滤：''=全部 / create / upgrade / current / retry / drift
    picked: {},              // 选中的格：`${moduleKey}:${kind}` -> true
    forceRecreate: {},       // 已创建模块点击“重新创建”的格
    versionPick: {},         // 选中的定义版本：`${moduleKey}:${kind}` -> { version, file }
    plan: null,              // 部署执行结果
    review: null,            // 执行计划审核：{ key, kind, status, approved, payload, log, plan }
    running: false,          // 初始化/部署进行中
    initAbort: null,         // 初始化的 AbortController（用于随时停止）
    initLog: null,           // 当前 tab 的运行进度引用，实际存于 runLogs
    runLogs: { init: null, overview: null },
    runTitle: '运行进度',
    collapsed: { installed: false, available: false, overviewLog: false, initLog: false, plan: false },
  },
  message: '',
  hosts: new Set(),
}

// db_type → 图标名 + 中文标签（cmx-ignite-list 的 row.icon / 展示用）
const DB_TYPE_META = {
  postgres:   { icon: 'database', label: 'PostgreSQL', short: 'PG' },
  postgresql: { icon: 'database', label: 'PostgreSQL', short: 'PG' },
  pg:         { icon: 'database', label: 'PostgreSQL', short: 'PG' },
  mysql:      { icon: 'database', label: 'MySQL', short: 'MySQL' },
  mariadb:    { icon: 'database', label: 'MariaDB', short: 'MariaDB' },
  oracle:     { icon: 'database', label: 'Oracle', short: 'Oracle' },
  sqlserver:  { icon: 'database', label: 'SQL Server', short: 'MSSQL' },
  mssql:      { icon: 'database', label: 'SQL Server', short: 'MSSQL' },
  sqlite:     { icon: 'database', label: 'SQLite', short: 'SQLite' },
  mongodb:    { icon: 'tree', label: 'MongoDB', short: 'Mongo' },
  redis:      { icon: 'multiselect-all', label: 'Redis', short: 'Redis' },
}
const dbTypeMeta = (t) => DB_TYPE_META[String(t || '').toLowerCase()] || { icon: 'database', label: String(t || '未知'), short: String(t || '?') }

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

/** DAM 下拉选项文案：名称（ID）。名称取 name/label/title，缺省回退 ID。 */
const damOptionLabel = (o) => {
  const id = o?.id ?? o?.module ?? ''
  const name = o?.name || o?.label || o?.title || ''
  return name && name !== id ? `${name}（${id}）` : String(id)
}
/** DAM 图标名（供 ui5-option icon 属性）；缺省按层级回退。 */
const damOptionIcon = (o, fallback) => String(o?.icon || fallback || '')
/** 一个 DAM ui5-option（含图标）。 */
const damOptionHtml = (o, val, selected, icon) => `<ui5-option value="${esc(val)}" icon="${esc(damOptionIcon(o, icon))}" ${selected ? 'selected' : ''}>${esc(damOptionLabel(o))}</ui5-option>`

const cmxClasses = () => (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

// ─── 数据加载 ──────────────────────────────────────────────────────────────
async function loadDam () {
  try {
    const dam = await apiJson('/api/registry/dam?active_only=true')
    state.dam = {
      domains: Array.isArray(dam.domains) ? dam.domains : [],
      apps: Array.isArray(dam.apps) ? dam.apps : (Array.isArray(dam.applications) ? dam.applications : []),
      modules: Array.isArray(dam.modules) ? dam.modules : [],
    }
  } catch (err) { state.message = 'DAM 加载失败：' + err.message }
}

async function loadDatasources () {
  state.dsLoading = true
  try {
    // 通用 CRUD list 是 POST；返回 { id, schema, rows:[...] }（经 fetch 拦截器拆 ApiResp）。
    // 按所选 domain/app/module 过滤：filters 为单元素数组，对象内各字段 AND。
    //   字段名对齐后端 SysDatasourceFilter：domain_code / application_code / module_code。
    const f = state.filter || {}
    const cond = {}
    if (f.domain) cond.domain_code = f.domain
    if (f.app) cond.application_code = f.app
    if (f.module) cond.module_code = f.module
    const body = Object.keys(cond).length ? { filters: [cond] } : {}
    const data = await apiJson('/api/sys-datasource/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const rows = Array.isArray(data?.rows) ? data.rows : []
    // 归一：补 id（cmx-ignite-list 需要）+ 展示字段。
    state.datasources = rows.map((r, i) => {
      const meta = dbTypeMeta(r.db_type)
      // 标题：db_id-db_name（db_name 缺省时只展示 db_id，避免出现 "id-"）。
      const dbId = r.db_id || r.id || `ds_${i}`
      const dbName = r.db_name || ''
      const title = dbName ? `${dbId}-${dbName}` : String(dbId)
      return {
        ...r,
        id: String(r.id || r.db_id || `ds_${i}`),
        icon: meta.icon,
        title,
        subtitle: `${meta.label}${r.default_flag === 1 ? ' · 默认' : ''}${r.status === 0 ? ' · 已禁用' : ''}`,
        _typeLabel: meta.label,
      }
    })
    if (state.datasources.length && (!state.selectedDsId || !state.datasources.some((d) => d.id === state.selectedDsId))) {
      state.selectedDsId = state.datasources[0].id
      resetBuildStateForDatasource()
    } else if (!state.datasources.length && state.selectedDsId) {
      // 当前过滤下无数据源：清空选中态与工作台状态，避免残留指向已不存在的项。
      state.selectedDsId = ''
      resetBuildStateForDatasource()
    }
  } catch (err) {
    state.datasources = []
    state.message = '数据源加载失败：' + err.message
  } finally { state.dsLoading = false }
}

function resetBuildStateForDatasource () {
  const b = state.build
  // 切库时取消正在进行的 db-state 请求
  if (b.dbStateAbort) { try { b.dbStateAbort.abort() } catch {} b.dbStateAbort = null }
  // loadingPromise 不主动 abort（让其自然结束），但清空引用即可——切库后下次进 bindOverview
  // 会按 force=false 走"非强制"路径，看到旧 in-flight Promise 不会重新发起新请求；
  // 旧 Promise 完成时内部 `b.dbStateAbort !== abort` 校验会让它静默丢弃结果，不会污染新库状态。
  b.loadingPromise = null
  b.loaded = false
  b.loading = false
  b.error = ''
  b.dbState = null
  b.dsKey = ''
  b.picked = {}
  b.forceRecreate = {}
  b.versionPick = {}
  b.plan = null
  b.review = null
  b.scenarioFilter = ''
  b.initLog = null
  b.runLogs = { init: null, overview: null }
}

// ─── 渲染工具 ──────────────────────────────────────────────────────────────
function mcCollapsed (key) {
  return !!state.build.collapsed?.[key]
}

function mcCollapseButton (key, label) {
  const folded = mcCollapsed(key)
  return `<button type="button" class="mc-collapse-btn" data-mc-collapse="${esc(key)}" title="${folded ? '展开' : '收起'}${esc(label || '面板')}"><ui5-icon name="${folded ? 'navigation-right-arrow' : 'navigation-down-arrow'}"></ui5-icon></button>`
}

function refreshAll () {
  for (const host of Array.from(state.hosts)) {
    if (host && host.isConnected) renderInto(host)
    else state.hosts.delete(host)
  }
}

function mount (ctx, html, after) {
  const bindWhenReady = (tries = 0) => {
    if (ctx.host) {
      state.hosts.add(ctx.host)
      // host 从 DOM 移除时清理引用，避免 state.hosts 累积已断开的 host 造成内存泄漏
      if (typeof ctx.host.onDispose !== 'function') {
        ctx.host.onDispose = () => { state.hosts.delete(ctx.host) }
      }
    }
    const root = ctx.host?.renderRoot || ctx.host?.shadowRoot?.querySelector('.native-page-root')
    if (root && root.isConnected && typeof after === 'function') { after(root); return }
    if (tries < 20) requestAnimationFrame(() => bindWhenReady(tries + 1))
  }
  requestAnimationFrame(() => bindWhenReady())
  return `${styleHtml()}${html}`
}

/**
 * property 栏显隐与内部 tab 联动由框架级支持：
 * - 显隐：content view spec 声明 hideProperty: true（见 menu-node 配置）。
 * - 内部 tab：content view spec 声明 syncPropertyView: '<property-viewId>'。
 *
 * 见 workspace-view-renderer.js 的 data-hide-property / data-sync-property-view
 * 属性输出 + handleWorkspaceRegionTabBarClick 派发的 portal-content-view-change 事件，
 * portal-app 监听事件后自动切换 property region 的内部 tab。
 */


function viewOf (host) {
  const v = host?.getAttribute?.('view') || ''
  if (v === 'explorer') return v
  if (v.startsWith('content') || v.startsWith('property')) return v
  return 'content-dct'
}

function renderInto (host) {
  const root = host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root')
  if (!root) return
  const view = viewOf(host)
  let html = ''
  if (view === 'explorer') html = explorerHtml()
  else if (view.startsWith('property')) html = propertyHtml(view.replace('property-', '') || 'dct')
  else html = contentHtml(view.replace('content-', '') || 'dct')
  root.innerHTML = `${styleHtml()}${html}`
  bindView(root, view)
}

// ─── explorer 区 ───────────────────────────────────────────────────────────
function damSelectsHtml () {
  const domains = state.dam.domains || []
  const apps = (state.dam.apps || []).filter((a) => !state.filter.domain || a.domain === state.filter.domain)
  const modules = (state.dam.modules || []).filter((m) =>
    (!state.filter.domain || m.domain === state.filter.domain) &&
    (!state.filter.app || (m.application || m.app) === state.filter.app))
  // ui5-option 支持 icon 属性 → 下拉项显示 DAM 图标（原生 <option> 无法显示图标）。
  return `
    <div class="cds-dam-row">
      <ui5-select class="cds-select" data-dam="domain" title="域">
        <ui5-option value="" icon="filter" ${!state.filter.domain ? 'selected' : ''}>全部域</ui5-option>
        ${domains.map((d) => damOptionHtml(d, d.id, d.id === state.filter.domain, 'folder')).join('')}
      </ui5-select>
      <ui5-select class="cds-select" data-dam="app" title="应用">
        <ui5-option value="" icon="filter" ${!state.filter.app ? 'selected' : ''}>全部应用</ui5-option>
        ${apps.map((a) => damOptionHtml(a, a.id, a.id === state.filter.app, 'grid')).join('')}
      </ui5-select>
    </div>
    <div class="cds-dam-row cds-dam-row-module">
      <ui5-select class="cds-select" data-dam="module" title="模块">
        <ui5-option value="" icon="filter" ${!state.filter.module ? 'selected' : ''}>全部模块</ui5-option>
        ${modules.map((m) => damOptionHtml(m, m.id || m.module, (m.id || m.module) === state.filter.module, 'product')).join('')}
      </ui5-select>
    </div>`
}

function explorerHtml () {
  const selected = state.datasources.find((d) => d.id === state.selectedDsId) || null
  const pct = Math.max(20, Math.min(80, Number(state.explorer.splitPct) || 52))
  // 列表范围文案：有任一 DAM 筛选时显示筛选维度，否则「集群全部」。
  const f = state.filter || {}
  const scopeParts = [
    ['域', f.domain], ['应用', f.app], ['模块', f.module],
  ].filter(([, v]) => v).map(([k, v]) => `${k}:${esc(v)}`)
  const scopeHint = scopeParts.length ? `（筛选 ${scopeParts.join(' · ')}）` : '（集群全部）'
  const emptyHint = scopeParts.length ? '当前筛选下无数据源' : '暂无已配置数据源'
  return `
    <div class="cds-neo cds-wrap">
      <div class="cds-banner"><ui5-icon name="database" class="cds-banner-ic"></ui5-icon><span class="cds-banner-title">集群数据源</span><span class="cds-kpi">${state.datasources.length}</span></div>
      <div class="cds-dam">${damSelectsHtml()}</div>
      <div class="cds-split" style="--cds-split:${pct}%">
        <div class="cds-split-top">
          <div class="cds-section-label">数据库列表<span class="cds-hint">${scopeHint}</span></div>
          <div class="cds-list-region" data-ds-list-host>
            ${state.dsLoading ? '<cmx-empty-state icon="synchronize" title="加载中…" size="sm"></cmx-empty-state>'
              : (state.datasources.length ? '<cmx-ignite-list data-cmx-layout="card" data-cmx-density="compact" id="cds-list"></cmx-ignite-list>' : `<cmx-empty-state icon="database" title="${emptyHint}" size="sm"></cmx-empty-state>`)}
          </div>
        </div>
        <div class="cds-splitter" data-cds-splitter title="拖动调整上下高度"><span class="cds-splitter-grip"></span></div>
        <div class="cds-split-bot">
          <div class="cds-summary-region">${dbSummaryHtml(selected)}</div>
        </div>
      </div>
      ${state.message ? `<div class="cds-msg">${esc(state.message)}</div>` : ''}
    </div>`
}

// ─── content 区（三视图共用）：直接嵌入真实功能组件（只读） ───────────────────
// DAM 过滤经属性传入；同页 content↔property 用 data-bus-scope 共享一条私有总线，与真实功能页隔离。
const BUS_SCOPE = { dct: 'cds-dct', doc: 'cds-doc', profile: 'cds-profile' }

function damFilterAttrs () {
  const f = state.filter
  return `${f.domain ? ` data-filter-domain="${esc(f.domain)}"` : ''}${f.app ? ` data-filter-app="${esc(f.app)}"` : ''}${f.module ? ` data-filter-module="${esc(f.module)}"` : ''}`
}

/** content 视图：整块交给真实组件渲染（100% 原样，只读）。 */
function contentHtml (tab) {
  if (tab === 'overview') return overviewHtml()
  const scope = BUS_SCOPE[tab]
  const filters = damFilterAttrs()
  if (tab === 'profile') {
    return `<div class="cds-embed-host"><portal-flexible-combination-manager data-embed data-readonly data-bus-scope="${scope}"${filters}></portal-flexible-combination-manager></div>`
  }
  const kind = tab === 'doc' ? 'DOC' : 'DCT'
  return `<div class="cds-embed-host"><portal-definition-manager data-kind="${kind}" data-embed data-readonly data-bus-scope="${scope}"${filters}></portal-definition-manager></div>`
}

// ─── content · 数据源概览（第一个视图） ─────────────────────────────────────
/** 概览视图：现仅承载「建表工作台」（数据库摘要已移到 explorer 下半）。 */
function overviewHtml () {
  const ds = state.datasources.find((d) => d.id === state.selectedDsId) || null
  if (!ds) {
    return `<div class="cds-neo cds-wrap"><cmx-empty-state icon="database" title="请在左侧「数据源」列表中选择一个数据库" size="sm"></cmx-empty-state></div>`
  }
  return `
    <div class="cds-neo cds-wrap">
      <div class="cds-ov-body cds-ov-body-plain">
        ${buildPanelHtml(ds)}
      </div>
    </div>`
}

/** 数据库摘要（原概览上部内容）：标题区 + 连接健康 + 指标卡片 + 概览占位。 */
function dbSummaryHtml (ds) {
  if (!ds) return `<cmx-empty-state icon="database" title="选择数据库查看概览" size="sm"></cmx-empty-state>`
  const meta = dbTypeMeta(ds.db_type)
  const statusOn = ds.status !== 0
  const isDefault = ds.default_flag === 1
  const dbId = ds.db_id || ds.id || ''
  // 标题统一为「db_id-db_name」，与左侧列表项一致；db_name 缺省时回退 description，再缺省只显 db_id。
  const dbName = ds.db_name || ds.description || ''
  const name = dbName ? `${dbId}-${dbName}` : String(dbId)
  // 从连接 URL 脱敏提取「主机:端口/库名」——必须剥离 userinfo（账号密码），避免泄露凭据。
  //   例：postgres://dbuser_dba:hkO4****@192.168.1.14:5432/cmxlocal → 192.168.1.14:5432/cmxlocal
  const safeHostFromUrl = (raw) => {
    const s = String(raw || '').trim()
    if (!s) return ''
    // 优先用 URL 解析（标准 scheme://user:pass@host:port/path）；解析失败再回退正则。
    try {
      const u = new URL(s)
      // host 含端口（URL.host 形如 192.168.1.14:5432），pathname 形如 /cmxlocal
      const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
      return `${u.host}${path}`
    } catch { /* 非 URL 或无 scheme，回退正则 */ }
    // 回退：从最后一个 '@' 之后取（确保剥离 userinfo），到第一个 '?' 或 '#' 前。
    const afterAt = s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    const end = afterAt.search(/[?#]/)
    return end >= 0 ? afterAt.slice(0, end) : afterAt
  }
  const safeHost = safeHostFromUrl(ds.db_url)
  // 「连接健康」为示意演示：按状态给个稳定的百分比（非真实指标）。
  const healthPct = statusOn ? 96 : 0
  const poolMax = Number(ds.max_connections) || 0
  const poolMin = Number(ds.min_connections) || 0
  const chip = (icon, text) => `<span class="cds-ov-chip"><ui5-icon name="${esc(icon)}"></ui5-icon>${esc(text)}</span>`
  const tile = (icon, label, value, tone) => `<div class="cds-ov-tile${tone ? ' t-' + tone : ''}">
    <div class="cds-ov-tile-ic"><ui5-icon name="${esc(icon)}"></ui5-icon></div>
    <div class="cds-ov-tile-main"><div class="cds-ov-tile-val">${esc(value)}</div><div class="cds-ov-tile-lbl">${esc(label)}</div></div>
  </div>`
  return `
    <div class="cds-ov-head">
      <div class="cds-ov-avatar"><ui5-icon name="${esc(meta.icon)}"></ui5-icon></div>
      <div class="cds-ov-id">
        <div class="cds-ov-name">${esc(name)}${isDefault ? '<span class="cds-ov-badge default"><ui5-icon name="favorite"></ui5-icon>默认</span>' : ''}</div>
        <div class="cds-ov-sub"><span class="cds-ov-dbid">${esc(dbId)}</span></div>
      </div>
    </div>

    <div class="cds-ov-body">
      <section class="cds-ov-card cds-ov-hero">
        <div class="cds-ov-hero-left">
          <div class="cds-ov-hero-title">连接健康<span class="cds-ov-demo">示意</span></div>
          <div class="cds-ov-gauge"><div class="cds-ov-gauge-fill" style="width:${healthPct}%"></div></div>
          <div class="cds-ov-hero-metrics">
            <span><b>${healthPct}%</b> 可用</span>
            <span><b>${poolMin}–${poolMax || '—'}</b> 连接池</span>
            <span><b>${esc((ds.connect_timeout ?? '—') + '')}s</b> 连接超时</span>
          </div>
        </div>
        <div class="cds-ov-hero-right">
          ${chip('cloud', safeHost || '本地/未知主机')}
          ${chip(statusOn ? 'accept' : 'decline', statusOn ? '在线' : '离线')}
          ${chip('fob-watch', `健康检查 ${esc((ds.health_check_interval ?? '—') + '')}s`)}
        </div>
      </section>

      <div class="cds-ov-tiles">
        ${tile('database', '数据库类型', meta.label, 'blue')}
        ${tile(statusOn ? 'status-positive' : 'status-inactive', '状态', statusOn ? '启用' : '禁用', statusOn ? 'green' : 'gray')}
        ${tile('grid', 'Schema', ds.db_schema || '—', 'violet')}
        ${tile('source-code', '来源', ds.source === 'config' ? '配置文件' : (ds.source || '手动'), 'amber')}
        ${tile('chain-link', '最大连接', poolMax || '—', 'teal')}
        ${tile('favorite', '默认数据源', isDefault ? '是' : '否', isDefault ? 'green' : 'gray')}
      </div>

      <section class="cds-ov-card">
        <div class="cds-ov-card-h"><ui5-icon name="hint"></ui5-icon>概览<span class="cds-ov-demo">占位 · 后续接入</span></div>
        <div class="cds-ov-feats">
          <div class="cds-ov-feat"><ui5-icon name="bar-chart"></ui5-icon><div><div class="ff-t">用量趋势</div><div class="ff-s">连接数 / QPS / 慢查询（规划中）</div></div></div>
          <div class="cds-ov-feat"><ui5-icon name="table-view"></ui5-icon><div><div class="ff-t">对象清单</div><div class="ff-s">表 / 视图 / 索引概况（规划中）</div></div></div>
          <div class="cds-ov-feat"><ui5-icon name="shield"></ui5-icon><div><div class="ff-t">权限与安全</div><div class="ff-s">账户 / 角色 / 加密状态（规划中）</div></div></div>
          <div class="cds-ov-feat"><ui5-icon name="history"></ui5-icon><div><div class="ff-t">变更历史</div><div class="ff-s">DDL / 迁移记录时间线（规划中）</div></div></div>
        </div>
        <div class="cds-ov-tags">
          ${chip('database', meta.label)}
          ${ds.db_schema ? chip('grid', 'schema=' + ds.db_schema) : ''}
          ${chip('process', '连接池 ' + poolMin + '/' + (poolMax || '—'))}
          ${chip('fob-watch', '生命周期 ' + esc((ds.max_lifetime ?? '—') + '') + 's')}
        </div>
      </section>
    </div>`
}

// ─── content · 概览页下方：建表工作台 ────────────────────────────────────────
// ─── content · 概览页下方：建表工作台（场景组合驱动） ─────────────────────────
// 场景 = 「数据库态(page_mode)」×「每模块每 kind(DCT/DOC/SEED) 版本态」组合推导。
// 数据库态由后端 GET /api/model/db-state?db_id= 提供（库门闸 + 每模块每 kind scenario 由后端算好）。

const MC_KINDS = [
  { id: 'DCT',  label: '数据字典',   icon: 'dimension' },
  { id: 'DOC',  label: '业务单据',   icon: 'document-text' },
  // RPT 报表列暂隐藏：后端 db_state 已停止返回 rpt 字段（模板型 RPT 仅建表链路、无运行期消费，
  // 展示会造成"可部署但无业务价值"的误导）。待运行期打通后，取消下行注释即可恢复。
  // { id: 'RPT',  label: '报表',       icon: 'excel-attachment' },
  { id: 'SEED', label: '初始化数据', icon: 'course-book' },
  { id: 'MENU', label: '菜单同步',   icon: 'list' },
]
// 矩阵中默认展示的 kind（可勾选执行的主 kind）；RPT 等扩展 kind 仍参与 scenario 统计，
// 但矩阵只渲染 MC_KINDS 中 pick=true 的场景格。布局改为块状自适应（flex wrap），不再固定列数。
// 场景元数据：文案 / 图标 / 色调 / 是否可勾选执行
const MC_SCENARIO = {
  create:    { label: '创建',  short: '创建',  icon: 'add',             tone: 'blue',  pick: true  },
  upgrade:   { label: '升级',  short: '升级',  icon: 'trend-up',        tone: 'amber', pick: true  },
  current:   { label: '已就绪', short: '已就绪', icon: 'status-positive', tone: 'green', pick: false },
  retry:     { label: '重试',  short: '失败',  icon: 'restart',         tone: 'red',   pick: true  },
  drift:     { label: '漂移',  short: '漂移',  icon: 'alert',           tone: 'amber', pick: true  },
  downgrade: { label: '降级',  short: '较新',  icon: 'down',            tone: 'gray',  pick: false },
  none:      { label: '无定义', short: '无定义', icon: 'less',            tone: 'gray',  pick: false },
}
/** 运维工作台顶部 tab：总览（模块矩阵） / 初始化（数据库初始化状态与操作）。 */
const MC_OP_TABS = [
  { value: '',     label: '运维总览', icon: 'table-view' },
  { value: 'init', label: '初始化',   icon: 'add-activity' },
]
const MC_PAGE_MODE = {
  normal:       { },
  init:         { icon: 'add-activity', title: '该数据库尚未初始化模型中心', desc: '将创建台账系统表；初始化完成后方可建表/升级', btn: '初始化数据库', tone: 'blue' },
  meta_upgrade: { icon: 'synchronize',  title: '基础管理需要升级', desc: '检测到旧版模型中心台账结构；升级前会先生成计划并说明影响，确认后才会执行', btn: '升级基础管理', tone: 'amber' },
  conflict:     { icon: 'alert',        title: '检测到冲突：该库存在非本台账管理的 cmx_ 表', desc: '为避免误操作，模块部署已锁定；请先纳管或人工确认', btn: '', tone: 'red' },
}

/** 由 applied/latest/status 推导场景（前端兜底；正常态 scenario 由后端 db-state 直接给出）。 */
function mcScenario (applied, latest, status) {
  if (status === 'failed') return 'retry'
  if (applied == null || applied === '') return latest ? 'create' : 'none'
  if (latest == null || latest === '') return 'current'
  const c = (Number(applied) || 0) - (Number(latest) || 0)
  if (c < 0) return 'upgrade'
  if (c > 0) return 'downgrade'
  if (status === 'drift') return 'drift'
  return 'current'
}

function mcEmptyCell () {
  return { applied: null, latest: null, status: 'none', scenario: 'none', file: '' }
}

function mcNormalizeCell (cell) {
  const c = (cell && typeof cell === 'object') ? cell : {}
  const applied = c.applied ?? c.version ?? null
  const latest = c.latest ?? null
  const status = c.status || 'none'
  return {
    ...mcEmptyCell(),
    ...c,
    applied,
    latest,
    status,
    scenario: c.scenario || mcScenario(applied, latest, status),
    versions: Array.isArray(c.versions) ? c.versions : [],
  }
}

function mcActiveLogKey () {
  return (state.build.opTab || '') === 'init' ? 'init' : 'overview'
}

function mcSetRunLog (key, title, log) {
  const b = state.build
  b.runLogs[key] = log
  if (mcActiveLogKey() === key) {
    b.initLog = log
    b.runTitle = title
  }
}

function mcSyncActiveRunLog () {
  const key = mcActiveLogKey()
  state.build.initLog = state.build.runLogs[key] || null
  state.build.runTitle = key === 'init' ? '初始化进度' : '部署进度'
}

function mcReviewKey () {
  return mcActiveLogKey()
}

function mcSetReview (review) {
  state.build.review = review
}

function mcScrollReviewIntoView (target = '.mc-review') {
  setTimeout(() => {
    for (const host of Array.from(state.hosts)) {
      if (!host || !host.isConnected || viewOf(host) !== 'content-overview') continue
      const root = host.renderRoot || host.shadowRoot?.querySelector('.native-page-root')
      const el = root && root.querySelector(target)
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        break
      }
    }
  }, 60)
}

function mcClearReview () {
  const b = state.build
  b.review = null
  b.running = false
  b.initAbort = null
}

function mcCellSelectedVersion (m, kind) {
  const cell = m.cells?.[kind] || mcEmptyCell()
  const picked = state.build.versionPick[mcCellKey(m.key, kind)]
  const versions = Array.isArray(cell.versions) ? cell.versions : []
  const hit = picked?.file
    ? versions.find((v) => v.file === picked.file)
    : (picked?.version ? versions.find((v) => String(v.version) === String(picked.version)) : null)
  return hit || versions.find((v) => String(v.version) === String(cell.latest)) || versions[0] || null
}

function mcVersionOptionsHtml (m, kind) {
  if (kind === 'SEED' || kind === 'MENU') return ''
  const versions = Array.isArray(m.cells?.[kind]?.versions) ? m.cells[kind].versions : []
  if (!versions.length) return ''
  const selected = mcCellSelectedVersion(m, kind)
  // ui5-select：与顶部 DAM 下拉保持一致（UI5 主题/暗色适配），替代原生 <select>。
  //   事件用 'change'，detail.selectedOption 携带 .value 与 dataset.file。
  return `<ui5-select class="mc-ver-select" data-mc-version="${esc(mcCellKey(m.key, kind))}" title="选择定义版本">
    ${versions.map((v) => `<ui5-option value="${esc(v.version)}" data-file="${esc(v.file || '')}" ${selected && String(selected.version) === String(v.version) && String(selected.file || '') === String(v.file || '') ? 'selected' : ''}>v${esc(v.version)}${v.is_default ? ' 默认' : ''}</ui5-option>`).join('')}
  </ui5-select>`
}

/**
 * 模块矩阵单元格 HTML（buildPanelHtml 与 mcAvailablePanelHtml 共用）。
 * @param {object} m  模块对象
 * @param {object} k  MC_KINDS 元素 { id, label, icon }
 * @param {object} [opts]
 * @param {boolean} [opts.withVersionSelector=false]  是否渲染版本选择器并使用 selectedVersion 显示版本文本
 */
function mcCellHtml (m, k, opts = {}) {
  const b = state.build
  const c = m.cells[k.id]; const sc = c.scenario; const sm = MC_SCENARIO[sc]
  const pickable = sm.pick && (!b.scenarioFilter || sc === b.scenarioFilter)
  const on = !!b.picked[mcCellKey(m.key, k.id)]
  const selectedVersion = opts.withVersionSelector ? mcCellSelectedVersion(m, k.id) : null
  let verText = ''
  const hasVersion = k.id === 'DCT' || k.id === 'DOC' /* || k.id === 'RPT' */ // RPT 暂隐藏
  if (!hasVersion) {
    const unit = k.id === 'MENU' ? '节点' : '行'
    if (sc === 'create' || sc === 'current' || sc === 'drift') {
      verText = c.row_count != null ? `${c.row_count} ${unit}` : ''
    } else {
      verText = ''
    }
  } else {
    if (sc === 'create') verText = selectedVersion ? `v${selectedVersion.version}` : `v${c.latest}`
    else if (sc === 'upgrade') verText = `v${c.applied}->v${selectedVersion?.version || c.latest}`
    else if (sc === 'downgrade') verText = `v${c.applied}(库) / v${selectedVersion?.version || c.latest}(定义)`
    else if (sc === 'none') verText = ''
    else verText = `v${c.applied || selectedVersion?.version || c.latest}`
  }
  const selector = opts.withVersionSelector ? mcVersionOptionsHtml(m, k.id) : ''
  const kindBadgeCls = k.id === 'DOC' ? 'doc' : (k.id === 'RPT' ? 'rpt' : (k.id === 'SEED' ? 'seed' : (k.id === 'MENU' ? 'menu' : 'dct')))
  return `<div class="mc-cell t-${sm.tone} ${pickable ? 'pickable' : ''} ${on ? 'on' : ''}" ${pickable ? `data-mc-cell="${esc(mcCellKey(m.key, k.id))}"` : ''}>
    <div class="mc-cell-head"><span class="cds-bd-kbadge ${kindBadgeCls}">${esc(k.label)}</span><span class="mc-cell-sc"><ui5-icon name="${sm.icon}"></ui5-icon>${sm.short}</span>${pickable ? `<span class="mc-cell-ck"><ui5-icon name="accept"></ui5-icon></span>` : ''}</div>
    <div class="mc-cell-body">${verText ? `<span class="mc-cell-ver">${esc(verText)}</span>` : ''}${selector}</div>
  </div>`
}

function mcPickLatestVersion (moduleKey, kind, cell) {
  const versions = Array.isArray(cell?.versions) ? cell.versions : []
  const latest = cell?.latest
  const hit = versions.find((v) => String(v.version) === String(latest)) || versions[0]
  if (hit) state.build.versionPick[mcCellKey(moduleKey, kind)] = { version: hit.version, file: hit.file }
}

function mcUpgradeVersions (cell) {
  const applied = Number(cell?.applied ?? cell?.version ?? 0) || 0
  return (Array.isArray(cell?.versions) ? cell.versions : [])
    .filter((v) => (Number(v.version) || 0) > applied)
    .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))
}

function mcInstalledUpgradeSelectHtml (moduleKey, kind, cell) {
  const versions = mcUpgradeVersions(cell)
  if (!versions.length) return ''
  const key = mcCellKey(moduleKey, kind)
  const picked = state.build.versionPick[key]
  const latest = cell?.latest
  const selected = (picked?.file
    ? versions.find((v) => v.file === picked.file)
    : (picked?.version ? versions.find((v) => String(v.version) === String(picked.version)) : null)) ||
    versions.find((v) => String(v.version) === String(latest)) ||
    versions[0]
  return `<details class="mc-action-menu">
    <summary class="mc-action-summary t-amber" title="${selected ? `当前选择 v${esc(selected.version)}${selected.is_default ? ' 默认' : ''}` : '选择升级版本'}">升级</summary>
    <div class="mc-action-options">
      ${versions.map((v) => `<button type="button" class="${selected && String(selected.version) === String(v.version) && String(selected.file || '') === String(v.file || '') ? 'active' : ''}" data-mc-upgrade-pick="${esc(key)}" data-mc-upgrade-version="${esc(v.version)}" data-mc-upgrade-file="${esc(v.file || '')}">v${esc(v.version)}${v.is_default ? '<b>默认</b>' : ''}</button>`).join('')}
    </div>
  </details>`
}

function mcNormalizeDbState (raw, dbId) {
  const st = (raw && typeof raw === 'object') ? { ...raw } : {}
  const counts = { create: 0, upgrade: 0, current: 0, retry: 0, drift: 0, downgrade: 0, none: 0 }
  st.modules = (Array.isArray(st.modules) ? st.modules : []).map((m) => {
    const domain = m.domain || m.domain_code || ''
    const app = m.app || m.application || m.application_code || ''
    const module = m.module || m.module_code || ''
    const cells = {
      DCT:  mcNormalizeCell(m.cells?.DCT  || m.cells?.dct  || m.DCT  || m.dct),
      DOC:  mcNormalizeCell(m.cells?.DOC  || m.cells?.doc  || m.DOC  || m.doc),
      RPT:  mcNormalizeCell(m.cells?.RPT  || m.cells?.rpt  || m.RPT  || m.rpt || mcEmptyCell()),
      SEED: mcNormalizeCell(m.cells?.SEED || m.cells?.seed || m.SEED || m.seed || mcEmptyCell()),
      MENU: mcNormalizeCell(m.cells?.MENU || m.cells?.menu || m.MENU || m.menu || mcEmptyCell()),
    }
    for (const k of MC_KINDS) {
      const sc = cells[k.id]?.scenario
      if (sc) counts[sc] = (counts[sc] || 0) + 1
    }
    return {
      ...m,
      key: m.key || `${domain}/${app}/${module}`,
      domain,
      app,
      application: app,
      module,
      module_name: m.module_name || m.moduleName || module || '未命名模块',
      table_count: Number(m.table_count ?? m.tableCount ?? 0) || 0,
      cells,
    }
  })
  st.installed_modules = (Array.isArray(st.installed_modules) ? st.installed_modules : []).map((m) => {
    const domain = m.domain || m.domain_code || ''
    const app = m.app || m.application || m.application_code || ''
    const module = m.module || m.module_code || ''
    return {
      ...m,
      key: m.key || `${domain}/${app}/${module}`,
      domain,
      app,
      application: app,
      module,
      module_name: m.module_name || m.moduleName || module || '未命名模块',
      table_count: Number(m.table_count ?? m.tableCount ?? 0) || 0,
      cells: {
        DCT:  mcNormalizeCell(m.dct  || m.cells?.DCT  || m.cells?.dct),
        DOC:  mcNormalizeCell(m.doc  || m.cells?.DOC  || m.cells?.doc),
        RPT:  mcNormalizeCell(m.rpt  || m.cells?.RPT  || m.cells?.rpt || mcEmptyCell()),
        SEED: mcNormalizeCell(m.seed || m.cells?.SEED || m.cells?.seed),
        MENU: mcNormalizeCell(m.menu || m.cells?.MENU || m.cells?.menu || mcEmptyCell()),
      },
    }
  })
  st.db_id = st.db_id || dbId || ''
  st.scenario_counts = { ...counts, ...(st.scenario_counts || {}) }
  return st
}

function mcShortDate (value) {
  if (!value) return '-'
  const s = String(value)
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return s.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16)
}

function mcKindDetailHtml (cell, kind, moduleKey = '') {
  const c = cell || mcEmptyCell()
  const applied = c.applied || c.version || ''
  const latest = c.latest || ''
  const scenario = c.scenario || mcScenario(applied, latest, c.status || 'none')
  const sm = MC_SCENARIO[scenario] || MC_SCENARIO.current
  const title = c.title || ''
  const file = c.file || ''
  const tables = c.table_count != null ? Number(c.table_count) || 0 : 0
  // SEED/MENU 无版本概念：只显示数据量（行数 / 节点数），不显示版本号
  const rowCount = c.row_count != null ? Number(c.row_count) || 0 : 0
  const isSeedOrMenu = kind === 'SEED' || kind === 'MENU'
  const bits = isSeedOrMenu
    ? (rowCount ? (kind === 'MENU' ? `${rowCount} 节点` : `${rowCount} 行`) : '-')
    : [
        applied ? `库 v${esc(applied)}` : '',
        latest ? `定义 v${esc(latest)}` : '',
        tables ? `${tables} 表` : '',
      ].filter(Boolean).join(' / ')
  const canRecreate = !!moduleKey && (applied || latest || file)
  const canUpgrade = !!moduleKey && scenario === 'upgrade'
  const canRetry = !!moduleKey && scenario === 'retry'
  const canDrift = !!moduleKey && scenario === 'drift'
  const actionLabel = canRetry ? '重试' : (canDrift ? '重应用' : '')
  const actionIcon = canUpgrade ? 'trend-up' : (canRetry ? 'restart' : 'alert')
  const upgradeSelect = canUpgrade ? mcInstalledUpgradeSelectHtml(moduleKey, kind, c) : ''
  return `<div class="mc-kind-detail">
    <div class="mc-kd-head">
      <span class="cds-bd-kbadge ${kind === 'DOC' ? 'doc' : (kind === 'RPT' ? 'rpt' : (kind === 'SEED' ? 'seed' : (kind === 'MENU' ? 'menu' : 'dct')))}">${esc(MC_KINDS.find((k) => k.id === kind)?.label || kind)}</span>
      <span class="mc-kd-actions">
        ${upgradeSelect}
        ${actionLabel ? `<button class="mc-action-btn t-${esc(sm.tone)}" data-mc-upgrade="${esc(moduleKey)}:${esc(kind)}" title="${esc(actionLabel)}到所选定义版本"><ui5-icon name="${actionIcon}"></ui5-icon>${esc(actionLabel)}</button>` : ''}
        ${canRecreate ? `<button class="mc-mini-btn" data-mc-recreate="${esc(moduleKey)}:${esc(kind)}" title="重新创建"><ui5-icon name="restart"></ui5-icon></button>` : ''}
      </span>
    </div>
    <div class="mc-kd-main">
      <div class="mc-kd-ver">${bits || '-'}</div>
      <div class="mc-kd-sub">${scenario === 'upgrade' ? `有新版本可升级：v${esc(applied || '-')} → v${esc(latest || '-')}` : esc(title || file || '无定义')}${scenario === 'upgrade' ? '' : (title && file ? ` · ${esc(file)}` : '')}</div>
    </div>
  </div>`
}

function mcModuleMatchesFilter (m) {
  const f = state.filter
  const q = state.build.query.trim().toLowerCase()
  return (!f.domain || m.domain === f.domain) &&
    (!f.app || m.app === f.app) &&
    (!f.module || m.module === f.module) &&
    (!q || `${m.module_name} ${m.key}`.toLowerCase().includes(q))
}

/**
 * 拉取数据库态（后端 GET /api/model/db-state 提供库门闸 + 每模块每 kind scenario）。
 *
 * 防重入 / 防循环调用：
 * 1. `b.loadingPromise` 记录当前在途请求；并发调用直接复用同一 Promise，不再发起新请求。
 * 2. `b.dbStateAbort === abort` 在 await 之后二次校验：旧请求 abort 后即便 race-window resolve，
 *    也不会写回 b.dbState / b.loaded / b.error，避免与新请求互相覆盖引发死循环。
 * 3. early-return 始终返回 `null`（明确不做事），调用方须容忍 null 而非依赖 then。
 */
async function loadDbState (ds, force = false) {
  const b = state.build
  const key = ds ? (ds.db_id || ds.id) : ''
  // ★ 防重入：已在途且非强制刷新 → 复用同一 Promise（并发触发共用结果）
  if (b.loadingPromise && !force) return b.loadingPromise
  if (b.loaded && b.dsKey === key && !force) return null
  // 取消上一个未完成的请求，避免快速切库时后发先至导致状态错乱
  if (b.dbStateAbort) { try { b.dbStateAbort.abort() } catch {} }
  const abort = new AbortController()
  b.dbStateAbort = abort
  b.loading = true; b.error = ''; b.dsKey = key
  const promise = (async () => {
    try {
      const data = await apiJson(`/api/model/db-state?db_id=${encodeURIComponent(key)}`, { signal: abort.signal })
      // abort 后 race-window 仍可能 resolve：必须是当前在途 abort 才落库，否则丢弃
      if (b.dbStateAbort !== abort) return
      b.dbState = mcNormalizeDbState(data, key)
      b.loaded = true
    } catch (err) {
      // 仅当仍是当前在途请求时记录错误；已被新请求替代的旧请求不污染状态
      if (b.dbStateAbort !== abort) return
      if (err?.name === 'AbortError') return
      b.error = '模型态加载失败：' + (err?.message || err)
    } finally {
      // 仅当仍是当前在途请求时清 loading/abort 句柄；旧请求 finally 不去覆盖新请求的状态
      if (b.dbStateAbort === abort) {
        b.dbStateAbort = null
        b.loading = false
      }
    }
  })()
  b.loadingPromise = promise
  promise.finally(() => { if (b.loadingPromise === promise) b.loadingPromise = null })
  return promise
}

/** 当前 tab 生效的显示模式：init tab -> 始终进初始化视图；总览 tab -> 始终进模块矩阵（系统表操作统一到初始化 tab）。 */
function mcPageMode () {
  if ((state.build.opTab || '') === 'init') return 'init'
  return 'normal'
}
/** DAM + 搜索 + 场景 过滤后的模块（含每模块保留的命中格）。 */
function mcFilteredModules () {
  const b = state.build
  const f = state.filter
  const q = b.query.trim().toLowerCase()
  const modules = b.dbState?.modules || []
  return modules.filter((m) =>
    (!f.domain || m.domain === f.domain) &&
    (!f.app || m.app === f.app) &&
    (!f.module || m.module === f.module) &&
    (!q || `${m.module_name} ${m.key}`.toLowerCase().includes(q)) &&
    (!b.scenarioFilter || MC_KINDS.some((k) => m.cells[k.id].scenario === b.scenarioFilter)))
}
const mcCellKey = (mkey, kind) => `${mkey}:${kind}`
/** 收集勾选的可执行格。 */
function mcPickedCells () {
  const b = state.build; const out = []
  for (const m of (b.dbState?.modules || [])) {
    for (const k of MC_KINDS) {
      const key = mcCellKey(m.key, k.id)
      if (b.picked[key] && (MC_SCENARIO[m.cells[k.id].scenario]?.pick || b.forceRecreate[key])) {
        out.push({ module: m, kind: k.id, cell: m.cells[k.id] })
      }
    }
  }
  return out
}

/** 建表工作台 HTML（库门闸 + 场景徽标 + 模块矩阵 + 执行抽屉）。 */
function buildPanelHtml (ds) {
  const b = state.build
  const meta = dbTypeMeta(ds.db_type)
  const pageMode = mcPageMode()

  // 顶部 tab：运维总览 / 初始化
  const opTab = b.opTab || ''
  const tabBar = `<div class="mc-tabs">${MC_OP_TABS.map((t) =>
    `<button class="mc-tab ${opTab === t.value ? 'active' : ''}" data-mc-optab="${t.value}"><ui5-icon name="${t.icon}"></ui5-icon>${esc(t.label)}</button>`).join('')}</div>`

  const targetBar = `
    <div class="cds-bd-target">
      <div class="cds-bd-target-ic"><ui5-icon name="${esc(meta.icon)}"></ui5-icon></div>
      <div class="cds-bd-target-main">
        <div class="cds-bd-target-l">目标数据库</div>
        <div class="cds-bd-target-v">${esc(ds.description || ds.db_id || ds.id)} <span class="cds-bd-target-id">${esc(ds.db_id || ds.id)}</span></div>
      </div>
      <span class="cds-ov-type">${esc(meta.label)}</span>
    </div>`

  const head = `<div class="cds-ov-card-h"><ui5-icon name="wrench"></ui5-icon>数据库运维工作台</div>`

  // ── 初始化 tab（或库需初始化）：显示真实初始化状态 + 初始化/停止 ──
  if (pageMode !== 'normal') {
    const g = MC_PAGE_MODE[pageMode] || {}
    const running = b.running
    const reviewing = b.review && b.review.key === 'init'
    const planning = running && reviewing && b.review?.status === 'streaming'
    const executingReview = running && reviewing && b.review?.status === 'executing'
    const st = b.dbState || {}
    const initialized = !!st.initialized
    const statusPanel = mcInitStatusHtml(st)
    let actions = ''
    if (planning) {
      actions = `<button class="cds-bd-btn primary" disabled><ui5-icon name="pending"></ui5-icon>生成计划中…</button>`
    } else if (executingReview) {
      actions = `<button class="cds-bd-btn danger" data-mc-stop><ui5-icon name="stop"></ui5-icon>停止</button>`
    } else if (running) {
      actions = `<button class="cds-bd-btn danger" data-mc-stop><ui5-icon name="stop"></ui5-icon>停止</button>`
    } else if (pageMode === 'init') {
      actions = initialized
        ? `<button class="cds-bd-btn primary" data-mc-gate="init" ${reviewing ? 'disabled' : ''}><ui5-icon name="synchronize"></ui5-icon>${reviewing ? '等待审核' : '校验/升级系统表'}</button>`
        : `<button class="cds-bd-btn primary" data-mc-gate="init" ${reviewing ? 'disabled' : ''}><ui5-icon name="begin"></ui5-icon>${reviewing ? '等待审核' : '初始化数据库'}</button>`
    } else if (g.btn) {
      actions = `<button class="cds-bd-btn primary" data-mc-gate="${pageMode}" ${reviewing ? 'disabled' : ''}><ui5-icon name="begin"></ui5-icon>${reviewing ? '等待审核' : esc(g.btn)}</button>`
    }
    const okInit = pageMode === 'init' && initialized
    const gTitle = okInit ? '模型中心已初始化' : (g.title || '')
    const gDesc = okInit ? '台账系统表已就绪；可在此校验/升级，或切到「运维总览」部署模块' : (g.desc || '')
    const gTone = okInit ? 'green' : (g.tone || 'blue')
    const gIcon = okInit ? 'sys-enter-2' : (g.icon || 'information')
    return `<section class="cds-ov-card cds-bd">
      ${head}${tabBar}${targetBar}
      <div class="mc-gate mc-gate-${gTone}">
        <ui5-icon name="${esc(gIcon)}" class="mc-gate-ic"></ui5-icon>
        <div class="mc-gate-main">
          <div class="mc-gate-title">${esc(gTitle)}</div>
          <div class="mc-gate-desc">${esc(gDesc)}</div>
        </div>
        ${actions}
      </div>
      ${statusPanel}
      ${mcReviewHtml('init')}
      ${mcInitLogHtml()}
      <div class="mc-gate-note"><ui5-icon name="message-information"></ui5-icon>初始化会实时推送连接与建表进度，可随时停止；重复初始化仅做加性升级，不会删除任何数据。</div>
    </section>`
  }

  // ── 运维总览：场景徽标 + 模块矩阵 ──
  if (b.loading) return `<section class="cds-ov-card cds-bd">${head}${tabBar}${targetBar}<cmx-empty-state icon="pending" title="模型态加载中…" size="sm"></cmx-empty-state></section>`
  if (b.error) return `<section class="cds-ov-card cds-bd">${head}${tabBar}${targetBar}<cmx-empty-state icon="message-warning" title="${esc(b.error)}" size="sm"></cmx-empty-state><div style="text-align:center;margin-top:8px"><button type="button" class="cds-bd-btn ghost" data-mc-retry-dbstate><ui5-icon name="refresh"></ui5-icon>重试</button></div></section>`

  const counts = b.dbState?.scenario_counts || {}
  const badge = (sc, extra) => {
    const m = MC_SCENARIO[sc]; const n = counts[sc] || 0
    return `<button class="mc-badge t-${m.tone} ${b.scenarioFilter === sc ? 'active' : ''} ${extra || ''}" data-mc-badge="${sc}"><ui5-icon name="${m.icon}"></ui5-icon>${m.label} <b>${n}</b></button>`
  }
  const badges = `<div class="mc-badges">
    <button class="mc-badge t-all ${!b.scenarioFilter ? 'active' : ''}" data-mc-badge=""><ui5-icon name="multiselect-all"></ui5-icon>全部</button>
    ${badge('create')}${badge('upgrade')}${badge('current')}${badge('retry')}${badge('drift')}
  </div>`

  // 两个受搜索词影响的面板抽成共享构建函数（搜索时局部重渲见 mcRerenderQueryRegions）
  const installedPanel = mcInstalledPanelHtml()
  const availablePanel = mcAvailablePanelHtml()

  const picked = mcPickedCells()
  const nCreate = picked.filter((p) => p.cell.scenario === 'create').length
  const nUpgrade = picked.filter((p) => p.cell.scenario === 'upgrade' || p.cell.scenario === 'drift').length
  const nRetry = picked.filter((p) => p.cell.scenario === 'retry').length
  const overviewReview = b.review && b.review.key === 'overview' ? b.review : null
  const drawerSummary = picked.length
    ? { create: nCreate, upgrade: nUpgrade, retry: nRetry }
    : (overviewReview?.summary || { create: 0, upgrade: 0, retry: 0 })
  const drawerHasWork = !!(picked.length || overviewReview)
  const drawerStatus = overviewReview?.status || ''
  const drawerBusy = b.running && !['ready', 'executed', 'error'].includes(drawerStatus)
  const drawerBtn = (() => {
    if (drawerStatus === 'executed') {
      return '<button class="cds-bd-btn primary" disabled><ui5-icon name="status-positive"></ui5-icon>执行完毕</button>'
    }
    if (drawerStatus === 'error') {
      return '<button class="cds-bd-btn danger" disabled><ui5-icon name="message-error"></ui5-icon>执行中出现错误</button>'
    }
    if (drawerStatus === 'executing') {
      return '<button class="cds-bd-btn primary" disabled><ui5-icon name="pending"></ui5-icon>执行中…</button>'
    }
    if (drawerStatus === 'streaming' || drawerBusy) {
      return '<button class="cds-bd-btn primary" disabled><ui5-icon name="pending"></ui5-icon>生成计划中…</button>'
    }
    if (overviewReview) {
      return '<button class="cds-bd-btn primary" disabled><ui5-icon name="pending"></ui5-icon>等待审核</button>'
    }
    return '<button class="cds-bd-btn primary" data-mc-run><ui5-icon name="begin"></ui5-icon>生成执行计划</button>'
  })()
  const drawer = drawerHasWork ? `
    <div class="mc-drawer">
      <div class="mc-drawer-info"><ui5-icon name="begin"></ui5-icon>将执行：${drawerSummary.create ? `创建 <b>${drawerSummary.create}</b> 格` : ''}${drawerSummary.upgrade ? `${drawerSummary.create ? ' · ' : ''}升级 <b>${drawerSummary.upgrade}</b> 格` : ''}${drawerSummary.retry ? `${(drawerSummary.create || drawerSummary.upgrade) ? ' · ' : ''}重试 <b>${drawerSummary.retry}</b> 格` : ''} → <b>${esc(ds.db_id || ds.id)}</b></div>
      <div class="mc-drawer-btns">
        <button class="cds-bd-btn ghost" data-mc-clear><ui5-icon name="decline"></ui5-icon>清空</button>
        ${drawerBtn}
      </div>
    </div>` : ''

  // 系统表状态提示横幅（运维总览不直接操作系统表，引导到初始化 tab）
  const rawMode = b.dbState?.page_mode || 'normal'
  const gateHint = rawMode !== 'normal' ? (() => {
    const hint = MC_PAGE_MODE[rawMode] || {}
    const tone = hint.tone || 'blue'
    const title = rawMode === 'init'
      ? (b.dbState?.initialized ? '基础管理需要校验/升级' : '该数据库尚未初始化模型中心')
      : (hint.title || '系统表需要处理')
    const desc = rawMode === 'init'
      ? (b.dbState?.initialized ? '台账系统表结构有更新，建议校验/升级。' : '请先初始化后才能部署模块。')
      : (hint.desc || '请到「初始化」tab 处理。')
    return `<div class="mc-gate mc-gate-${tone} mc-gate-hint">
      <ui5-icon name="${esc(hint.icon || 'alert')}" class="mc-gate-ic"></ui5-icon>
      <div class="mc-gate-main"><div class="mc-gate-title">${esc(title)}</div><div class="mc-gate-desc">${esc(desc)}</div></div>
      <button class="cds-bd-btn primary" data-mc-optab="init"><ui5-icon name="navigation-right-arrow"></ui5-icon>前往初始化</button>
    </div>`
  })() : ''

  return `
    <section class="cds-ov-card cds-bd">
      ${head}${tabBar}${targetBar}
      ${gateHint}
      <div class="mc-toolbar">
        ${badges}
        <input class="cds-bd-search" data-mc-search placeholder="搜索模块名 / 域·应用·模块…" value="${esc(b.query)}">
      </div>
      <div class="mc-quick"><span>快捷：</span><button class="cds-bd-link" data-mc-pick-scenario="create">全选可创建</button><button class="cds-bd-link" data-mc-pick-scenario="upgrade">全选可升级</button><button class="cds-bd-link" data-mc-pick-scenario="retry">全选失败</button></div>
      ${installedPanel}
      ${availablePanel}
      ${mcReviewHtml('overview')}
      ${b.initLog ? mcInitLogHtml() : ''}
      ${drawer}
      ${mcPlanHtml()}
    </section>`
}

/** 初始化实时进度日志（库门闸内，SSE 逐行推进）。 */
function mcInitLogHtml () {
  const lg = state.build.initLog
  if (!lg) return ''
  const collapseKey = state.build.opTab === 'init' ? 'initLog' : 'overviewLog'
  const folded = mcCollapsed(collapseKey)
  const icon = (k) => k === 'error' ? 'message-error' : (k === 'done' ? 'status-positive' : (k === 'progress' ? 'sys-enter-2' : (k === 'connect' ? 'connected' : 'busy')))
  const rows = lg.lines.map((l) => {
    const prog = (l.index != null && l.total != null) ? ` <span class="mc-il-prog">${l.index}/${l.total}</span>` : ''
    return `<div class="mc-il-row mc-il-${l.kind}"><ui5-icon name="${icon(l.kind)}"></ui5-icon><span class="mc-il-msg">${esc(l.message || '')}</span>${prog}</div>`
  }).join('')
  const foot = lg.error
    ? `<div class="mc-il-foot err"><ui5-icon name="message-error"></ui5-icon>${esc(lg.error)}</div>`
    : (lg.stopped ? `<div class="mc-il-foot err"><ui5-icon name="stop"></ui5-icon>已停止</div>`
       : (lg.done ? `<div class="mc-il-foot ok"><ui5-icon name="status-positive"></ui5-icon>完成</div>`
                  : `<div class="mc-il-foot run"><ui5-icon name="busy"></ui5-icon>进行中 …</div>`))
  return `<div class="mc-initlog" data-mc-initlog><div class="mc-il-head"><span><ui5-icon name="activity-items"></ui5-icon>${esc(state.build.runTitle || '运行进度')}</span>${mcCollapseButton(collapseKey, '运行进度')}</div>${folded ? '' : `<div class="mc-il-body" data-mc-il-body>${rows}</div>${foot}`}</div>`
}

function mcResultDetailHtml (r, summary = '查看详情') {
  const changes = Array.isArray(r.changes) ? r.changes : []
  const tableNames = Array.isArray(r.table_names) ? r.table_names : []
  if (r.kind === 'SEED' && Array.isArray(r.detail)) {
    return `<div class="mc-change-table"><div class="mc-change-sec">
      <b>种子表 (${r.detail.length} · 共 ${r.rows} 行)</b>
      <div class="mc-change-tags">${r.detail.map((d) =>
        `<span>${esc(d.table)} · ${d.rows}</span>`
      ).join('')}</div>
    </div></div>`
  }
  if (r.kind === 'MENU' && Array.isArray(r.detail)) {
    return `<div class="mc-change-table"><div class="mc-change-sec">
      <b>菜单文件 (${r.detail.length} · 共 ${r.nodes} 节点)</b>
      <div class="mc-change-tags">${r.detail.map((d) =>
        `<span>${esc(d.file)} · ${d.nodes}</span>`
      ).join('')}</div>
    </div></div>`
  }
  if (!changes.length && !tableNames.length && !r.error) return ''
  const rows = changes.length
    ? changes.map((ch) => {
        const action = ch.action === 'create_table' ? '创建表' : (ch.action === 'upgrade_table' ? '升级表' : '无变化')
        const tone = ch.action === 'create_table' ? 'green' : (ch.action === 'upgrade_table' ? 'amber' : 'gray')
        const added = Array.isArray(ch.addedColumns) ? ch.addedColumns : []
        const modified = Array.isArray(ch.modifiedColumns) ? ch.modifiedColumns : []
        const unchanged = Array.isArray(ch.unchangedColumns) ? ch.unchangedColumns : []
        const addedIdx = Array.isArray(ch.addedIndexes) ? ch.addedIndexes : []
        const droppedIdx = Array.isArray(ch.droppedIndexes) ? ch.droppedIndexes : []
        const preservedIdx = Array.isArray(ch.preservedIndexes) ? ch.preservedIndexes : []
        const cmt = ch.commentChange || null
        const colCmts = Array.isArray(ch.modifiedColumnComments) ? ch.modifiedColumnComments : []
        const addedHtml = added.length
          ? `<div class="mc-change-sec"><b>新增列 ${added.length}</b><div class="mc-change-tags">${added.map((c) => `<span title="${esc(c.dataType || '')}${c.nullable === false ? ' · NOT NULL' : ''}">${esc(c.name || '')}${c.label ? `<em>${esc(c.label)}</em>` : ''}</span>`).join('')}</div></div>`
          : ''
        const modifiedHtml = modified.length
          ? `<div class="mc-change-sec"><b>修改列 ${modified.length}</b>${modified.map((c) => {
              const diffs = Array.isArray(c.changes) ? c.changes : []
              return `<div class="mc-mod-col"><span>${esc(c.name || '')}${c.label ? `<em>${esc(c.label)}</em>` : ''}</span>${diffs.map((d) => `<code>${esc(d.field || '')}: ${esc(d.from || '∅')} → ${esc(d.to || '∅')}</code>`).join('')}</div>`
            }).join('')}</div>`
          : ''
        // 索引变更：按列+类型匹配，名字可能不同（设计期名 vs PG 自动名），展示列与唯一性。
        const idxLabel = (i) => `${i.unique ? '唯一' : '普通'} (${(Array.isArray(i.columns) ? i.columns : []).join(', ')})`
        const addedIdxHtml = addedIdx.length
          ? `<div class="mc-change-sec"><b>新增索引 ${addedIdx.length}</b><div class="mc-change-tags">${addedIdx.map((i) => `<span title="${esc(idxLabel(i))}">${esc(i.name || '')}<em>${esc(idxLabel(i))}</em></span>`).join('')}</div></div>`
          : ''
        const droppedIdxHtml = droppedIdx.length
          ? `<div class="mc-change-sec"><b>删除索引 ${droppedIdx.length}</b><div class="mc-change-tags">${droppedIdx.map((i) => `<span title="${esc(idxLabel(i))}">${esc(i.name || '')}<em>${esc(idxLabel(i))}</em></span>`).join('')}</div></div>`
          : ''
        // 手工索引保护：非系统命名（uk_/idx_ 前缀）且不在定义中的索引视为用户手工创建，保留不删。
        const preservedIdxHtml = preservedIdx.length
          ? `<div class="mc-change-sec"><b>保留手工索引 ${preservedIdx.length}</b><div class="mc-change-tags">${preservedIdx.map((i) => `<span title="${esc(idxLabel(i))}" class="mc-tag-preserved">${esc(i.name || '')}<em>${esc(i.message || '用户手工创建的索引，部署不会删除；如不再需要请手工 DROP')}</em></span>`).join('')}</div></div>`
          : ''
        const commentHtml = cmt
          ? `<div class="mc-change-sec"><b>表注释</b><div class="mc-mod-col"><code>${esc(cmt.from || '∅')} → ${esc(cmt.to || '∅')}</code></div></div>`
          : ''
        // 列注释变更：label 不一致（DB 缺失/不一致 → 设计期 caption）。
        const colCommentHtml = colCmts.length
          ? `<div class="mc-change-sec"><b>列注释 ${colCmts.length}</b>${colCmts.map((c) => `<div class="mc-mod-col"><span>${esc(c.name || '')}</span><code>${esc(c.from || '∅')} → ${esc(c.to || '∅')}</code></div>`).join('')}</div>`
          : ''
        // 列+索引+注释全无变更时才显示「一致性校验通过」。
        const noChangeHtml = (!added.length && !modified.length && !addedIdx.length && !droppedIdx.length && !cmt && !colCmts.length)
          ? `<cmx-empty-state icon="status-positive" title="未发现需执行的列级变更" description="已完成一致性校验。${unchanged.length ? ` ${unchanged.length} 列一致` : ''}" size="sm"></cmx-empty-state>`
          : ''
        return `<div class="mc-change-table">
          <div class="mc-change-table-h">
            <span class="mc-badge t-${tone} sm">${action}</span>
            <b>${esc(ch.table || '')}</b>
            ${ch.displayName ? `<small>${esc(ch.displayName)}</small>` : ''}
            <i>${Number(ch.columnCount || 0)} 列</i>
          </div>
          ${addedHtml}${modifiedHtml}${addedIdxHtml}${droppedIdxHtml}${preservedIdxHtml}${commentHtml}${colCommentHtml}${noChangeHtml}
        </div>`
      }).join('')
    : `<div class="mc-change-table"><div class="mc-change-sec"><b>涉及表</b><div class="mc-change-tags">${tableNames.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div></div>`
  return `<details class="mc-result-detail">
    <summary><ui5-icon name="detail-view"></ui5-icon>${esc(summary)}</summary>
    ${r.error ? `<div class="mc-change-error">${esc(r.error)}</div>` : ''}
    ${rows}
  </details>`
}

function mcReviewPlanDetailHtml (rv) {
  const results = Array.isArray(rv?.plan?.results) ? rv.plan.results : []
  if (!results.length) return ''
  const stIcon = (s) => s === 'planned' ? 'checklist' : (s === 'success' ? 'status-positive' : (s === 'failed' ? 'status-negative' : 'less'))
  const stTone = (s) => s === 'failed' ? 'red' : (s === 'skipped' ? 'gray' : 'blue')
  const totalTables = results.reduce((n, r) => n + (Number(r.tables) || 0), 0)
  return `<div class="mc-review-detail">
    <div class="mc-review-detail-h"><span><ui5-icon name="detail-view"></ui5-icon>详细计划</span><b>${results.length} 项 · ${totalTables} 张表</b></div>
    ${results.map((r) => {
      const km = r.kind === 'SYS'
        ? { id: 'SYS', label: '基础管理', icon: 'database' }
        : (MC_KINDS.find((k) => k.id === r.kind) || MC_KINDS[0])
      return `<div class="cds-bd-plan-grp">
        <div class="cds-bd-plan-grp-h">
          <span class="mc-badge t-${stTone(r.status)} sm"><ui5-icon name="${stIcon(r.status)}"></ui5-icon>${r.status === 'failed' ? '失败' : (r.status === 'skipped' ? '跳过' : '计划')}</span>
          <span class="cds-bd-kbadge ${r.kind === 'DOC' ? 'doc' : (r.kind === 'RPT' ? 'rpt' : (r.kind === 'SEED' ? 'seed' : (r.kind === 'MENU' ? 'menu' : (r.kind === 'SYS' ? 'seed' : 'dct'))))}"><ui5-icon name="${km.icon}"></ui5-icon>${km.label}</span>
          <span class="cds-bd-plan-grp-t">${esc(r.module)}${r.version != null ? ' · v' + esc(r.version) : ''}</span>
          <span class="cds-bd-plan-grp-n">${r.tables != null ? r.tables + ' 张表' : (r.note ? esc(r.note) : '')}</span>
        </div>
        ${mcResultDetailHtml(r, '详情：表与列变更')}
      </div>`
    }).join('')}
  </div>`
}

/** 执行计划审核面板：计划 SSE 逐行展示，审核同意后才出现执行按钮。 */
function mcReviewHtml (key) {
  const rv = state.build.review
  if (!rv || rv.key !== key) return ''
  const lg = rv.log || { lines: [] }
  const icon = (k) => k === 'error' ? 'message-error' : (k === 'done' ? 'status-positive' : (k === 'progress' ? 'sys-enter-2' : (k === 'connect' ? 'connected' : 'checklist')))
  const rows = (lg.lines || []).map((l) => {
    const prog = (l.index != null && l.total != null) ? ` <span class="mc-il-prog">${l.index}/${l.total}</span>` : ''
    return `<div class="mc-il-row mc-il-${l.kind} mc-phase-${esc(l.phase || 'plan')}"><ui5-icon name="${icon(l.kind)}"></ui5-icon><span class="mc-il-msg">${esc(l.message || '')}</span>${prog}</div>`
  }).join('')
  const waiting = rv.status === 'streaming'
  const ready = rv.status === 'ready'
  const approved = rv.status === 'approved'
  const executing = rv.status === 'executing'
  const executed = rv.status === 'executed'
  const failed = rv.status === 'error'
  const sum = rv.plan?.results
    ? `计划 ${rv.plan.results.length} 项 · ${rv.plan.tables || 0} 张表`
    : (rv.plan?.ddl_count ? `计划 ${rv.plan.ddl_count} 条 DDL` : '逐步生成中')
  const foot = failed
    ? `<div class="mc-il-foot err"><ui5-icon name="message-error"></ui5-icon>${esc(lg.error || '执行计划生成失败')}</div>`
    : (waiting ? `<div class="mc-il-foot run"><ui5-icon name="busy"></ui5-icon>生成计划中 …</div>`
       : (executing ? `<div class="mc-il-foot run"><ui5-icon name="busy"></ui5-icon>执行中 …</div>`
          : `<div class="mc-il-foot ok"><ui5-icon name="status-positive"></ui5-icon>${executed ? '执行完成' : (approved ? '已同意，等待执行' : '计划已生成，等待审核')}</div>`))
  return `<div class="mc-review">
    <div class="mc-review-head">
      <span><ui5-icon name="checklist"></ui5-icon>${esc(rv.title || '执行计划审核')}</span>
      <b>${esc(sum)}</b>
    </div>
    <div class="mc-il-body mc-review-body">${rows}</div>
    ${mcReviewPlanDetailHtml(rv)}
    ${foot}
    <div class="mc-review-actions">
      <button class="cds-bd-btn ghost" data-mc-review-back ${(waiting || executing) ? 'disabled' : ''}><ui5-icon name="navigation-left-arrow"></ui5-icon>返回</button>
      ${ready ? `<button class="cds-bd-btn primary" data-mc-review-approve><ui5-icon name="accept"></ui5-icon>同意</button>` : ''}
      ${approved ? `<button class="cds-bd-btn primary" data-mc-review-execute><ui5-icon name="begin"></ui5-icon>执行</button>` : ''}
      ${failed ? `<button class="cds-bd-btn primary" data-mc-review-back><ui5-icon name="refresh"></ui5-icon>重新选择</button>` : ''}
    </div>
  </div>`
}

/** 真实初始化状态卡（读 db-state：是否已初始化 / 台账版本 / 已纳管模块数）。 */
function mcInitStatusHtml (st) {
  const initialized = !!st.initialized
  const rows = [
    { label: '初始化状态', value: initialized ? '已初始化' : '未初始化', tone: initialized ? 'ok' : 'warn', icon: initialized ? 'status-positive' : 'status-critical' },
    { label: '台账版本', value: (st.meta_version != null ? 'v' + st.meta_version : '—') + (st.expected_meta_version != null ? ` / 期望 v${st.expected_meta_version}` : ''), tone: (initialized && st.meta_version < st.expected_meta_version) ? 'warn' : 'muted', icon: 'history' },
    { label: '已纳管模块', value: `${(st.modules || []).filter((m) => (m.dct?.applied || m.doc?.applied || m.seed?.applied)).length} / ${(st.modules || []).length}`, tone: 'muted', icon: 'org-chart' },
    { label: '数据库标识', value: st.db_id || '—', tone: 'muted', icon: 'database' },
  ]
  return `<div class="mc-status">${rows.map((r) =>
    `<div class="mc-status-cell mc-st-${r.tone}"><ui5-icon name="${r.icon}"></ui5-icon><div class="mc-st-tx"><div class="mc-st-l">${esc(r.label)}</div><div class="mc-st-v">${esc(r.value)}</div></div></div>`).join('')}</div>`
}

/** 停止正在进行的初始化（abort SSE fetch）。 */
function stopMcInit () {
  const b = state.build
  if (!b.running) return
  try { if (b.initAbort) b.initAbort.abort() } catch { /* ignore */ }
  if (b.review?.status === 'executing') {
    b.review.log.lines.push({ kind: 'error', phase: 'execute', message: '已手动停止（已建对象不回滚；可重新执行做加性补齐）' })
    b.review.log.error = '已停止'
    b.review.status = 'error'
    b.review.log.done = true
    updateReviewPanel()
  } else if (b.initLog) {
    b.initLog.lines.push({ kind: 'error', message: '已手动停止（已建对象不回滚；可重新初始化做加性补齐）' })
    b.initLog.stopped = true
    b.initLog.done = true
    refreshOverviewHosts()
  }
  b.running = false
}

/** 局部更新执行计划审核区。 */
function updateReviewPanel () {
  const key = state.build.review?.key
  if (!key) return
  for (const host of Array.from(state.hosts)) {
    if (!host || !host.isConnected) { state.hosts.delete(host); continue }
    if (viewOf(host) !== 'content-overview') continue
    const root = host.renderRoot || host.shadowRoot?.querySelector('.native-page-root')
    const wrap = root && root.querySelector('.mc-review')
    // .mc-review 尚未渲染时跳过本次局部更新，不调 renderInto：
    // SSE 流处理期间（progress/done 事件）中间态调 renderInto 会触发 bindOverview，
    // 若此时 b.loaded/b.dsKey 处于过渡态可能与 finally 的 refreshOverviewHosts 叠加引发重复加载。
    // 完整重渲由调用方 finally 块的 refreshOverviewHosts 统一负责。
    if (!wrap) continue
    const tmp = document.createElement('template')
    tmp.innerHTML = mcReviewHtml(key)
    const fresh = tmp.content.firstElementChild
    if (fresh) {
      wrap.replaceWith(fresh)
      const body = fresh.querySelector('.mc-review-body')
      if (body) body.scrollTop = body.scrollHeight
    }
  }
}

/** 局部更新初始化日志区（追加行 + 滚动到底，不整块重渲）。 */
function updateInitLog () {
  for (const host of Array.from(state.hosts)) {
    if (!host || !host.isConnected) { state.hosts.delete(host); continue }
    if (viewOf(host) !== 'content-overview') continue
    const root = host.renderRoot || host.shadowRoot?.querySelector('.native-page-root')
    const wrap = root && root.querySelector('.mc-initlog')
    // 同 updateReviewPanel：找不到时跳过，不调 renderInto，避免流处理期间中间态重渲
    if (!wrap) continue
    const tmp = document.createElement('template')
    tmp.innerHTML = mcInitLogHtml()
    const fresh = tmp.content.firstElementChild
    if (fresh) {
      wrap.replaceWith(fresh)
      const body = fresh.querySelector('[data-mc-il-body]')
      if (body) body.scrollTop = body.scrollHeight
    }
  }
}

async function readSseStream (res, onEvent) {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let ended = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let evName = 'message'; let dataStr = ''
      for (const raw of frame.split('\n')) {
        if (raw.startsWith('event:')) evName = raw.slice(6).trim()
        else if (raw.startsWith('data:')) dataStr += raw.slice(5).trim()
      }
      let data = {}
      try { data = dataStr ? JSON.parse(dataStr) : {} } catch { data = { message: dataStr } }
      onEvent(evName, data)
      if (evName === 'end') { ended = true; buf = ''; break }
    }
    if (ended) break
  }
}

/** 执行结果（真实落库）：逐项 success/failed/skipped。 */
function mcPlanHtml () {
  const plan = state.build.plan
  if (!plan) return ''
  const folded = mcCollapsed('plan')
  const results = Array.isArray(plan.results) ? plan.results : []
  const ok = results.filter((r) => r.status === 'success').length
  const failed = results.filter((r) => r.status === 'failed').length
  const totalTables = results.reduce((n, r) => n + (Number(r.tables) || 0), 0)
  const stIcon = (s) => s === 'success' ? 'status-positive' : (s === 'failed' ? 'status-negative' : 'less')
  const stTone = (s) => s === 'success' ? 'green' : (s === 'failed' ? 'red' : 'gray')
  const detailHtml = (r) => {
    const changes = Array.isArray(r.changes) ? r.changes : []
    const tableNames = Array.isArray(r.table_names) ? r.table_names : []
    if (!changes.length && !tableNames.length && !r.error) return ''
    const rows = changes.length
      ? changes.map((ch) => {
          const action = ch.action === 'create_table' ? '创建表' : (ch.action === 'upgrade_table' ? '升级表' : '无变化')
          const tone = ch.action === 'create_table' ? 'green' : (ch.action === 'upgrade_table' ? 'amber' : 'gray')
          const added = Array.isArray(ch.addedColumns) ? ch.addedColumns : []
          const modified = Array.isArray(ch.modifiedColumns) ? ch.modifiedColumns : []
          const unchanged = Array.isArray(ch.unchangedColumns) ? ch.unchangedColumns : []
          const addedIdx = Array.isArray(ch.addedIndexes) ? ch.addedIndexes : []
          const droppedIdx = Array.isArray(ch.droppedIndexes) ? ch.droppedIndexes : []
          const preservedIdx = Array.isArray(ch.preservedIndexes) ? ch.preservedIndexes : []
          const cmt = ch.commentChange || null
          const colCmts = Array.isArray(ch.modifiedColumnComments) ? ch.modifiedColumnComments : []
          const addedHtml = added.length
            ? `<div class="mc-change-sec"><b>新增列 ${added.length}</b><div class="mc-change-tags">${added.map((c) => `<span title="${esc(c.dataType || '')}${c.nullable === false ? ' · NOT NULL' : ''}">${esc(c.name || '')}${c.label ? `<em>${esc(c.label)}</em>` : ''}</span>`).join('')}</div></div>`
            : ''
          const modifiedHtml = modified.length
            ? `<div class="mc-change-sec"><b>修改列 ${modified.length}</b>${modified.map((c) => {
                const diffs = Array.isArray(c.changes) ? c.changes : []
                return `<div class="mc-mod-col"><span>${esc(c.name || '')}${c.label ? `<em>${esc(c.label)}</em>` : ''}</span>${diffs.map((d) => `<code>${esc(d.field || '')}: ${esc(d.from || '∅')} → ${esc(d.to || '∅')}</code>`).join('')}</div>`
              }).join('')}</div>`
            : ''
          // 索引变更：按列+类型匹配，名字可能不同（设计期名 vs PG 自动名），展示列与唯一性。
          const idxLabel = (i) => `${i.unique ? '唯一' : '普通'} (${(Array.isArray(i.columns) ? i.columns : []).join(', ')})`
          const addedIdxHtml = addedIdx.length
            ? `<div class="mc-change-sec"><b>新增索引 ${addedIdx.length}</b><div class="mc-change-tags">${addedIdx.map((i) => `<span title="${esc(idxLabel(i))}">${esc(i.name || '')}<em>${esc(idxLabel(i))}</em></span>`).join('')}</div></div>`
            : ''
          const droppedIdxHtml = droppedIdx.length
            ? `<div class="mc-change-sec"><b>删除索引 ${droppedIdx.length}</b><div class="mc-change-tags">${droppedIdx.map((i) => `<span title="${esc(idxLabel(i))}">${esc(i.name || '')}<em>${esc(idxLabel(i))}</em></span>`).join('')}</div></div>`
            : ''
          // 手工索引保护：非系统命名（uk_/idx_ 前缀）且不在定义中的索引视为用户手工创建，保留不删。
          const preservedIdxHtml = preservedIdx.length
            ? `<div class="mc-change-sec"><b>保留手工索引 ${preservedIdx.length}</b><div class="mc-change-tags">${preservedIdx.map((i) => `<span title="${esc(idxLabel(i))}" class="mc-tag-preserved">${esc(i.name || '')}<em>${esc(i.message || '用户手工创建的索引，部署不会删除；如不再需要请手工 DROP')}</em></span>`).join('')}</div></div>`
            : ''
          const commentHtml = cmt
            ? `<div class="mc-change-sec"><b>表注释</b><div class="mc-mod-col"><code>${esc(cmt.from || '∅')} → ${esc(cmt.to || '∅')}</code></div></div>`
            : ''
          // 列注释变更：label 不一致（DB 缺失/不一致 → 设计期 caption）。
          const colCommentHtml = colCmts.length
            ? `<div class="mc-change-sec"><b>列注释 ${colCmts.length}</b>${colCmts.map((c) => `<div class="mc-mod-col"><span>${esc(c.name || '')}</span><code>${esc(c.from || '∅')} → ${esc(c.to || '∅')}</code></div>`).join('')}</div>`
            : ''
          // 列+索引+注释全无变更时才显示「一致性校验通过」。
          const noChangeHtml = (!added.length && !modified.length && !addedIdx.length && !droppedIdx.length && !cmt && !colCmts.length)
            ? `<cmx-empty-state icon="status-positive" title="未发现需执行的列级变更" description="已完成一致性校验。${unchanged.length ? ` ${unchanged.length} 列一致` : ''}" size="sm"></cmx-empty-state>`
            : ''
          return `<div class="mc-change-table">
            <div class="mc-change-table-h">
              <span class="mc-badge t-${tone} sm">${action}</span>
              <b>${esc(ch.table || '')}</b>
              ${ch.displayName ? `<small>${esc(ch.displayName)}</small>` : ''}
              <i>${Number(ch.columnCount || 0)} 列</i>
            </div>
            ${addedHtml}${modifiedHtml}${addedIdxHtml}${droppedIdxHtml}${preservedIdxHtml}${commentHtml}${colCommentHtml}${noChangeHtml}
          </div>`
        }).join('')
      : `<div class="mc-change-table"><div class="mc-change-sec"><b>涉及表</b><div class="mc-change-tags">${tableNames.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div></div>`
    return `<details class="mc-result-detail">
      <summary><ui5-icon name="detail-view"></ui5-icon>查看详情</summary>
      ${r.error ? `<div class="mc-change-error">${esc(r.error)}</div>` : ''}
      ${rows}
    </details>`
  }
  return `
    <div class="cds-bd-plan">
      <div class="cds-bd-plan-h">
        <span><ui5-icon name="checklist"></ui5-icon>执行结果</span>
        <span class="cds-bd-plan-sum">成功 ${ok} · 失败 ${failed} · 建/改 ${totalTables} 张表 · <span class="mc-badge t-green sm">已落库</span></span>
        ${mcCollapseButton('plan', '执行结果')}
      </div>
      ${folded ? '' : `${plan.errors && plan.errors.length ? `<div class="cds-bd-plan-err"><ui5-icon name="message-warning"></ui5-icon>${esc(plan.errors.join('；'))}</div>` : ''}
      ${results.map((r) => {
        const km = MC_KINDS.find((k) => k.id === r.kind) || MC_KINDS[0]
        return `<div class="cds-bd-plan-grp">
          <div class="cds-bd-plan-grp-h">
            <span class="mc-badge t-${stTone(r.status)} sm"><ui5-icon name="${stIcon(r.status)}"></ui5-icon>${r.status === 'success' ? '成功' : (r.status === 'failed' ? '失败' : '跳过')}</span>
            <span class="cds-bd-kbadge ${r.kind === 'DOC' ? 'doc' : (r.kind === 'RPT' ? 'rpt' : (r.kind === 'SEED' ? 'seed' : (r.kind === 'MENU' ? 'menu' : 'dct')))}"><ui5-icon name="${km.icon}"></ui5-icon>${km.label}</span>
            <span class="cds-bd-plan-grp-t">${esc(r.module)}${r.version != null ? ' · v' + esc(r.version) : ''}</span>
            <span class="cds-bd-plan-grp-n">${r.tables != null ? r.tables + ' 张表' : (r.note ? esc(r.note) : '')}</span>
          </div>
          ${r.error ? `<div class="cds-bd-plan-tables"><span class="cds-bd-plan-empty">${esc(r.error)}</span></div>` : ''}
          ${detailHtml(r)}
        </div>`
      }).join('')}
      <div class="cds-bd-plan-foot"><ui5-icon name="message-information"></ui5-icon>已按数据库内省逐列增量建表/升级（additive，不删表）；源定义 JSON 已完整留档，操作记入部署历史。</div>`}
    </div>`
}

/** 库门闸动作（初始化 / 系统表升级）：先流式生成执行计划，等待用户审核。 */
async function runMcGate (mode) {
  const b = state.build
  const ds = state.datasources.find((d) => d.id === state.selectedDsId)
  if (!ds || b.running || b.review) return
  if (mode !== 'init' && mode !== 'meta_upgrade') { window.alert('该状态暂不支持自动处理，请先人工确认。'); return }

  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null
  b.initAbort = ac
  b.running = true
  b.initLog = null
  b.runLogs.init = null
  mcSetReview({
    key: 'init',
    kind: 'init',
    title: mode === 'meta_upgrade' ? '基础管理升级执行计划' : '初始化/系统表升级执行计划',
    status: 'streaming',
    approved: false,
    payload: { db_id: ds.db_id || ds.id },
    log: { lines: [{ kind: 'connect', message: '准备生成执行计划 …' }], done: false, error: '' },
    plan: null,
  })
  refreshOverviewHosts()
  mcScrollReviewIntoView()

  const pushLine = (line) => {
    if (!b.review?.log) return
    b.review.log.lines.push(line)
    updateReviewPanel()
  }
  try {
    const res = await fetch('/api/model/init-plan-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ db_id: ds.db_id || ds.id }),
      signal: ac ? ac.signal : undefined,
    })
    await readSseStream(res, (evName, data) => handleReviewEvent(evName, data, pushLine))
  } catch (err) {
    const aborted = err && err.name === 'AbortError'
    if (!aborted && b.review?.log) {
      b.review.status = 'error'
      b.review.log.error = '计划生成失败：' + (err.message || err)
      b.review.log.done = true
      updateReviewPanel()
    }
  } finally {
    b.running = false
    b.initAbort = null
    updateReviewPanel()
  }
}

/** 审核通过后执行初始化/系统表升级：沿用现有后端执行 SSE。 */
async function executeMcGateAfterReview () {
  const b = state.build
  const rv = b.review
  const ds = state.datasources.find((d) => d.id === state.selectedDsId)
  if (!ds || b.running || !rv || rv.key !== 'init' || rv.status !== 'approved') return

  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null
  b.initAbort = ac
  b.running = true
  rv.status = 'executing'
  rv.log.done = false
  rv.log.error = ''
  rv.log.lines.push({ kind: 'step', phase: 'execute', message: '开始执行，以下为执行日志 …' })
  updateReviewPanel()

  const pushLine = (line) => {
    if (!b.review?.log) return
    b.review.log.lines.push({ ...line, phase: 'execute' })
    updateReviewPanel()
  }
  try {
    const res = await fetch('/api/model/init-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(rv.payload || { db_id: ds.db_id || ds.id }),
      signal: ac ? ac.signal : undefined,
    })
    await readSseStream(res, (evName, data) => handleReviewExecuteEvent(evName, data, pushLine))
  } catch (err) {
    const aborted = err && err.name === 'AbortError'
    if (!aborted && b.review?.log) {
      b.review.status = 'error'
      b.review.log.error = '初始化失败：' + (err.message || err)
      b.review.log.done = true
      updateReviewPanel()
    }
  } finally {
    b.running = false
    b.initAbort = null
    updateReviewPanel()
  }
}

/** 处理一个计划 SSE 事件。 */
function handleReviewEvent (kind, data, pushLine) {
  const b = state.build
  if (!b.review || b.review.status === 'approved') return
  if (kind === 'connect' || kind === 'step' || kind === 'progress') {
    pushLine({ kind, phase: 'plan', message: data.message || '', index: data.index, total: data.total })
  } else if (kind === 'done') {
    b.review.status = 'ready'
    b.review.plan = data || {}
    b.review.log.done = true
    pushLine({ kind: 'done', phase: 'plan', message: data.message || '执行计划已生成' })
    updateReviewPanel()
    mcScrollReviewIntoView('.mc-review-detail')
  } else if (kind === 'error') {
    b.review.status = 'error'
    b.review.log.error = data.message || '计划生成出错'
    b.review.log.done = true
    pushLine({ kind: 'error', phase: 'plan', message: `${data.stage ? '[' + data.stage + '] ' : ''}${data.message || '未知错误'}` })
  }
}

/** 处理审核通过后的执行 SSE 事件，保留在同一个审核面板中展示。 */
function handleReviewExecuteEvent (kind, data, pushLine) {
  const b = state.build
  const rv = b.review
  if (!rv || rv.status !== 'executing') return
  if (kind === 'connect' || kind === 'step' || kind === 'progress') {
    pushLine({ kind, message: data.message || '', index: data.index, total: data.total })
  } else if (kind === 'done') {
    rv.status = 'executed'
    rv.log.done = true
    b.running = false
    b.initAbort = null
    if (data.db_state) b.dbState = mcNormalizeDbState(data.db_state, b.dsKey)
    pushLine({ kind: 'done', message: data.message || '执行完成' })
  } else if (kind === 'error') {
    rv.status = 'error'
    rv.log.error = data.message || '执行出错'
    rv.log.done = true
    b.running = false
    b.initAbort = null
    pushLine({ kind: 'error', message: `${data.stage ? '[' + data.stage + '] ' : ''}${data.message || '未知错误'}` })
  }
}

/** 处理一个初始化 SSE 事件。 */
function handleInitEvent (kind, data, pushLine) {
  const b = state.build
  if (!b.initLog || b.initLog.stopped) return   // 已手动停止 → 丢弃后续事件
  if (kind === 'connect' || kind === 'step' || kind === 'progress') {
    pushLine({ kind, message: data.message || '', index: data.index, total: data.total })
  } else if (kind === 'done') {
    // 先置完成态再渲染最后一行，避免页脚仍显示「进行中」。
    b.initLog.done = true
    b.running = false          // 立即解除运行态（按钮恢复可点，不再卡"初始化中…"）
    b.initAbort = null
    if (data.db_state) { b.dbState = mcNormalizeDbState(data.db_state, b.dsKey) } // 交还真实 db-state（含 initialized）
    pushLine({ kind: 'done', message: data.message || '初始化完成' })
    // 保留完成日志，作为初始化/升级的运行详情；只刷新状态，不自动收起详情面板。
    refreshOverviewHosts()
  } else if (kind === 'error') {
    b.initLog.error = data.message || '初始化出错'
    b.initLog.done = true
    b.running = false
    b.initAbort = null
    pushLine({ kind: 'error', message: `${data.stage ? '[' + data.stage + '] ' : ''}${data.message || '未知错误'}` })
  }
}

function mcPickedDeployItems () {
  return mcPickedCells().map((p) => {
    const selected = mcCellSelectedVersion(p.module, p.kind)
    return {
      kind: p.kind,
      domain: p.module.domain,
      application: p.module.app,
      module: p.module.module,
      file: selected?.file || p.cell.file,
      version: selected?.version || p.cell.latest,
    }
  })
}

/** 生成部署执行计划：POST /api/model/deploy-plan-stream。 */
async function runMcPlan () {
  const b = state.build
  const ds = state.datasources.find((d) => d.id === state.selectedDsId)
  const picked = mcPickedCells()
  // review 处于终态（executed/error）时自动清理，允许立即发起新一轮计划；
  // 否则上一次部署完成后未点「返回/清空」就会卡住按钮（b.review 非空导致守卫 return）。
  if (b.review && (b.review.status === 'executed' || b.review.status === 'error')) {
    b.review = null
  }
  if (!ds || !picked.length || b.running || b.review) return
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null
  b.initAbort = ac
  b.running = true
  const items = mcPickedDeployItems()
  const summary = {
    create: picked.filter((p) => p.cell.scenario === 'create').length,
    upgrade: picked.filter((p) => p.cell.scenario === 'upgrade' || p.cell.scenario === 'drift').length,
    retry: picked.filter((p) => p.cell.scenario === 'retry').length,
  }
  b.initLog = null
  b.runLogs.overview = null
  mcSetReview({
    key: 'overview',
    kind: 'deploy',
    title: '模块部署执行计划',
    status: 'streaming',
    approved: false,
    payload: { db_id: ds.db_id || ds.id, items },
    summary,
    log: { lines: [{ kind: 'connect', message: '准备生成模块部署计划 …' }], done: false, error: '' },
    plan: null,
  })
  refreshOverviewHosts()
  mcScrollReviewIntoView()
  const pushLine = (line) => {
    if (!b.review?.log) return
    b.review.log.lines.push(line)
    updateReviewPanel()
  }
  try {
    const res = await fetch('/api/model/deploy-plan-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ db_id: ds.db_id || ds.id, items }),
      signal: ac ? ac.signal : undefined,
    })
    await readSseStream(res, (evName, data) => handleReviewEvent(evName, data, pushLine))
  } catch (err) {
    const aborted = err && err.name === 'AbortError'
    if (!aborted) {
      if (b.review?.log) {
        b.review.status = 'error'
        b.review.log.error = '计划生成失败：' + (err.message || err)
        b.review.log.done = true
        updateReviewPanel()
      }
    }
  } finally {
    b.running = false
    b.initAbort = null
    refreshOverviewHosts({ preserveScroll: true })
  }
}

/** 审核通过后执行选中模块部署：沿用现有 deploy-stream。 */
async function executeMcPlanAfterReview () {
  const b = state.build
  const rv = b.review
  const ds = state.datasources.find((d) => d.id === state.selectedDsId)
  if (!ds || b.running || !rv || rv.key !== 'overview' || rv.status !== 'approved') return
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null
  b.initAbort = ac
  b.running = true
  rv.status = 'executing'
  rv.log.done = false
  rv.log.error = ''
  rv.log.lines.push({ kind: 'step', phase: 'execute', message: '开始执行，以下为执行日志 …' })
  updateReviewPanel()
  const payload = rv.payload || { db_id: ds.db_id || ds.id, items: mcPickedDeployItems() }
  const pushLine = (line) => {
    if (!b.review?.log) return
    b.review.log.lines.push({ ...line, phase: 'execute' })
    updateReviewPanel()
  }
  try {
    const res = await fetch('/api/model/deploy-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: ac ? ac.signal : undefined,
    })
    await readSseStream(res, (evName, data) => {
      if (evName === 'connect' || evName === 'step' || evName === 'progress') {
        pushLine({ kind: evName, message: data.message || '', index: data.index, total: data.total })
      } else if (evName === 'error') {
        if (b.review?.log) b.review.log.error = data.message || '部署出错'
        if (b.review) {
          b.review.status = 'error'
          b.review.log.done = true
        }
        pushLine({ kind: 'error', message: `${data.stage ? '[' + data.stage + '] ' : ''}${data.message || '未知错误'}` })
      } else if (evName === 'done') {
        if (b.review) {
          b.review.status = 'executed'
          b.review.log.done = true
        }
        // 立即解除运行态（与 handleReviewExecuteEvent 一致），不等 finally：
        // 否则 readSseStream 等待流关闭期间 b.running 仍为 true，阻碍后续操作。
        b.running = false
        b.initAbort = null
        b.plan = { results: Array.isArray(data.results) ? data.results : [], errors: [] }
        b.picked = {}
        b.forceRecreate = {}
        b.versionPick = {}
        if (data.db_state) b.dbState = mcNormalizeDbState(data.db_state, ds.db_id || ds.id)
        pushLine({ kind: 'done', message: data.message || '部署执行完成' })
      }
    })
  } catch (err) {
    const aborted = err && err.name === 'AbortError'
    if (!aborted) {
      b.plan = { results: [], errors: [String(err.message || err)] }
      if (b.review?.log) {
        b.review.status = 'error'
        b.review.log.error = '部署失败：' + (err.message || err)
        b.review.log.done = true
        updateReviewPanel()
      }
    }
  } finally {
    b.running = false
    b.initAbort = null
    refreshOverviewHosts({ preserveScroll: true })
  }
}

// ─── property 区：三 tab，各嵌真实检查器（与同名 content tab 同 scope 共享总线，只读） ──
function propertyHtml (tab) {
  const scope = BUS_SCOPE[tab] || BUS_SCOPE.dct
  let inspector
  if (tab === 'profile') inspector = `<portal-flexible-combination-inspector data-readonly data-bus-scope="${scope}"></portal-flexible-combination-inspector>`
  else inspector = `<portal-definition-inspector data-kind="${tab === 'doc' ? 'DOC' : 'DCT'}" data-readonly data-bus-scope="${scope}"></portal-definition-inspector>`
  return `<div class="cds-embed-host cds-prop-host">${inspector}</div>`
}

// ─── 绑定（事件 + 数据组件挂载） ────────────────────────────────────────────
function bindView (root, view) {
  if (view === 'explorer') return bindExplorer(root)
  if (view === 'content-overview') return bindOverview(root)
  // content / property：各自嵌入的真实组件（及其检查器）自管，无需页面级绑定。
}

/** 概览页事件：下方「建表工作台」场景交互。 */
function bindOverview (root) {
  const b = state.build
  const ds = state.datasources.find((d) => d.id === state.selectedDsId) || null
  // 首次进入 / 切库 → 加载模型态（真实 db-state），拉到后局部重渲染工作台。
  // ★ 三重防重入：
  //   (1) `!b.error` 失败短路（避免 bindOverview 与失败的 loadDbState 互踢死循环）；
  //   (2) `!b.loadingPromise` 在途短路（并发触发共用同一 Promise，不发起新请求）；
  //   (3) `!b.loading` 保留兜底（防御 loadingPromise 字段缺失场景）。
  //   切库时 resetBuildStateForDatasource 会清 error/loadingPromise，可正常重载新库。
  if (ds && (!b.loaded || b.dsKey !== (ds.db_id || ds.id)) && !b.loading && !b.loadingPromise && !b.error) {
    const p = loadDbState(ds)
    if (p) p.then(() => refreshOverviewHosts())
  }
  // 局部重渲：只重画工作台卡片，保留概览容器（避免整块闪烁）。
  const rerender = () => {
    const cur = state.datasources.find((d) => d.id === state.selectedDsId)
    const host = root.querySelector('.cds-bd')
    if (cur && host) { const tmp = document.createElement('template'); tmp.innerHTML = buildPanelHtml(cur); const fresh = tmp.content.firstElementChild; if (fresh) { host.replaceWith(fresh); return } }
    refreshOverviewHosts()
  }
  // ★ 事件只绑一次：root(.native-page-root) 跨多次 renderInto 持久存在，重复绑定会累积导致点击多发。
  if (root.__mcBound) return
  root.__mcBound = true
  root.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-mc-version]')) return
    const t = e.target instanceof Element
      ? e.target.closest('[data-mc-upgrade-pick],[data-mc-collapse],[data-mc-optab],[data-mc-badge],[data-mc-cell],[data-mc-pick-scenario],[data-mc-clear],[data-mc-run],[data-mc-gate],[data-mc-stop],[data-mc-retry-dbstate],[data-mc-recreate],[data-mc-upgrade],[data-mc-review-back],[data-mc-review-approve],[data-mc-review-execute]')
      : null
    if (!t) return
    if (t.hasAttribute('data-mc-upgrade-pick')) {
      const key = t.getAttribute('data-mc-upgrade-pick')
      const version = t.getAttribute('data-mc-upgrade-version') || ''
      const file = t.getAttribute('data-mc-upgrade-file') || ''
      b.versionPick[key] = { version, file }
      b.picked[key] = true
      b.scenarioFilter = ''
      rerender()
      return
    }
    if (t.hasAttribute('data-mc-collapse')) {
      const key = t.getAttribute('data-mc-collapse')
      if (key) b.collapsed[key] = !b.collapsed[key]
      rerender()
      return
    }
    if (t.hasAttribute('data-mc-optab')) {
      const tab = t.getAttribute('data-mc-optab') || ''
      if (b.opTab === tab) return
      b.opTab = tab
      mcSyncActiveRunLog()
      // 切到「初始化」tab → 拉取最新真实状态再渲染，确保状态准确。
      if (tab === 'init') {
        const p = loadDbState(state.datasources.find((d) => d.id === state.selectedDsId), true)
        if (p) p.then(rerender)
        else rerender()
      } else { rerender() }
      return
    }
    if (t.hasAttribute('data-mc-stop')) { stopMcInit(); return }
    if (t.hasAttribute('data-mc-retry-dbstate')) {
      // 手动重试：清 error 后强制重载（绕过 bindOverview 的 !b.error 短路）。
      const cur = state.datasources.find((d) => d.id === state.selectedDsId)
      if (cur) {
        const p = loadDbState(cur, true)
        if (p) p.then(() => refreshOverviewHosts())
      }
      rerender()
      return
    }
    if (t.hasAttribute('data-mc-review-back')) { mcClearReview(); rerender(); return }
    if (t.hasAttribute('data-mc-review-approve')) {
      if (b.review && b.review.status === 'ready') {
        b.review.status = 'approved'
        b.review.approved = true
        updateReviewPanel()
      }
      return
    }
    if (t.hasAttribute('data-mc-review-execute')) {
      if (b.review?.key === 'init') void executeMcGateAfterReview()
      else if (b.review?.key === 'overview') void executeMcPlanAfterReview()
      return
    }
    if (t.hasAttribute('data-mc-gate')) { void runMcGate(t.getAttribute('data-mc-gate')); return }
    if (t.hasAttribute('data-mc-badge')) { b.scenarioFilter = t.getAttribute('data-mc-badge'); rerender(); return }
    if (t.hasAttribute('data-mc-cell')) { const k = t.getAttribute('data-mc-cell'); if (b.picked[k]) delete b.picked[k]; else b.picked[k] = true; rerender(); return }
    if (t.hasAttribute('data-mc-recreate')) {
      const k = t.getAttribute('data-mc-recreate')
      b.picked[k] = true
      b.forceRecreate[k] = true
      b.scenarioFilter = ''
      rerender()
      return
    }
    if (t.hasAttribute('data-mc-upgrade')) {
      const key = t.getAttribute('data-mc-upgrade')
      const [moduleKey, kind] = String(key || '').split(':')
      const mod = (b.dbState?.modules || []).find((m) => m.key === moduleKey)
      if (key) b.picked[key] = true
      if (mod && kind && !b.versionPick[key]) mcPickLatestVersion(moduleKey, kind, mod.cells?.[kind])
      b.scenarioFilter = ''
      rerender()
      return
    }
    if (t.hasAttribute('data-mc-pick-scenario')) {
      const sc = t.getAttribute('data-mc-pick-scenario')
      mcFilteredModules().forEach((m) => MC_KINDS.forEach((k) => { if (m.cells[k.id].scenario === sc) b.picked[mcCellKey(m.key, k.id)] = true }))
      rerender(); return
    }
    if (t.hasAttribute('data-mc-clear')) { b.picked = {}; b.forceRecreate = {}; b.versionPick = {}; b.plan = null; b.review = null; rerender(); return }
    if (t.hasAttribute('data-mc-run')) { void runMcPlan(); return }
  })
  // 搜索输入：只局部重渲受查询影响的两个面板，不整片替换 .cds-bd —— 保住输入框焦点；
  // 中文输入法组词期间（compositionstart→compositionend）跳过重渲，避免拼音被打断。
  let composing = false
  root.addEventListener('compositionstart', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-mc-search')) composing = true
  })
  root.addEventListener('compositionend', (e) => {
    if (!(e.target instanceof Element) || !e.target.hasAttribute('data-mc-search')) return
    composing = false
    b.query = e.target.value
    mcRerenderQueryRegions(root)
  })
  root.addEventListener('input', (e) => {
    const el = e.target
    if (!(el instanceof Element)) return
    if (el.hasAttribute('data-mc-search')) {
      b.query = el.value
      if (!composing) mcRerenderQueryRegions(root)
    }
  })
  // 版本选择器为 ui5-select：触发 'change'，detail.selectedOption 带 .value 与 dataset.file。
  root.addEventListener('change', (e) => {
    const el = e.target
    if (!(el instanceof Element)) return
    if (el.hasAttribute('data-mc-version')) {
      const key = el.getAttribute('data-mc-version')
      const opt = e.detail?.selectedOption
      const version = opt?.value ?? el.value ?? ''
      const file = opt?.getAttribute?.('data-file') || opt?.dataset?.file || ''
      b.versionPick[key] = { version, file }
      b.picked[key] = true
      rerender()
    }
  })
}

/** 「已创建模块」面板 HTML（buildPanelHtml 与搜索局部重渲共用）。 */
function mcInstalledPanelHtml () {
  const b = state.build
  const installed = (b.dbState?.installed_modules || []).filter(mcModuleMatchesFilter)
  const collapsed = mcCollapsed('installed')
  return `
    <div class="mc-panel mc-panel-installed">
      <div class="mc-panel-h"><span><ui5-icon name="status-positive"></ui5-icon>当前数据库已创建模块</span><span class="mc-panel-actions"><b>${installed.length}</b>${mcCollapseButton('installed', '当前数据库已创建模块')}</span></div>
      ${collapsed ? '' : (installed.length ? `<div class="mc-installed">
        <div class="mc-installed-head"><span>模块</span><span>版本与明细</span><span>创建 / 更新</span><span>表数</span></div>
        ${installed.map((m) => {
          // 表数 = DCT 字典表数 + DOC 单据表数（SEED/MENU 不计入物理表数）
          const cellTables = (kind) => Number(m.cells?.[kind]?.table_count) || 0
          const totalTables = cellTables('DCT') + cellTables('DOC')
          const tblText = totalTables || m.table_count || '-'
          // 已安装面板只展示"真正装过"的 kind：status 非 none 且 applied 有值（含版本号/日期）。
          // 未装的 kind 不在此面板出现——它们会以下方「可创建 / 安装 / 升级」面板按 scenario=create 列出。
          const installedKinds = MC_KINDS.filter((k) => {
            const c = m.cells?.[k.id]
            if (!c) return false
            const applied = c.applied ?? c.version
            return c.status && c.status !== 'none' && applied != null && applied !== ''
          })
          const kindsHtml = installedKinds.length
            ? installedKinds.map((k) => mcKindDetailHtml(m.cells?.[k.id], k.id, m.key)).join('')
            : `<div class="mc-kind-detail mc-kind-empty">该模块无已安装的资源</div>`
          return `<div class="mc-installed-row">
          <div class="mc-installed-mod"><div class="mc-mmod-t">${esc(m.module_name)}</div><div class="mc-mmod-s">${esc(m.domain)}/${esc(m.app)}/${esc(m.module)}</div><div class="mc-mmod-s">${esc(m.deployed_name || m.deployed_by || '')}</div></div>
          <div class="mc-installed-kinds">${kindsHtml}</div>
          <div class="mc-installed-time"><span>${mcShortDate(m.created_at || m.first_deployed_at || m.create_time)}</span><span>${mcShortDate(m.updated_at || m.current_deployed_at || m.update_time)}</span></div>
          <div class="mc-mtbl">${tblText}</div>
        </div>`
        }).join('')}
      </div>` : `<cmx-empty-state icon="database" title="当前数据库尚未创建符合筛选条件的模块" size="sm"></cmx-empty-state>`)}
    </div>`
}

/** 「可创建 / 安装 / 升级模块」面板 HTML（buildPanelHtml 与搜索局部重渲共用）。 */
function mcAvailablePanelHtml () {
  const modules = mcFilteredModules()
  const actionable = modules.filter((m) => MC_KINDS.some((k) => {
    const sc = m.cells[k.id].scenario
    return sc === 'create' || sc === 'upgrade' || sc === 'retry' || sc === 'drift'
  }))
  const collapsed = mcCollapsed('available')
  return `
    <div class="mc-panel mc-panel-available">
      <div class="mc-panel-h"><span><ui5-icon name="add-activity"></ui5-icon>当前选择下可创建 / 安装 / 升级模块</span><span class="mc-panel-actions"><b>${actionable.length}</b>${mcCollapseButton('available', '当前选择下可创建 / 安装 / 升级模块')}</span></div>
      ${collapsed ? '' : (actionable.length ? `<div class="mc-available">
        <div class="mc-available-head"><span>模块</span><span>可创建 / 安装 / 升级的资源（点击勾选）</span><span></span><span>表数</span></div>
        ${actionable.map((m) => {
          // 只渲染有动作的 kind 格（create/upgrade/retry/drift），none/current 不显示
          const activeKinds = MC_KINDS.filter((k) => {
            const sc = m.cells[k.id]?.scenario
            return sc === 'create' || sc === 'upgrade' || sc === 'retry' || sc === 'drift'
          })
          return `<div class="mc-available-row">
          <div class="mc-available-mod"><div class="mc-mmod-t">${esc(m.module_name)}</div><div class="mc-mmod-s">${esc(m.domain)}/${esc(m.app)}/${esc(m.module)}</div></div>
          <div class="mc-available-kinds">${activeKinds.map((k) => mcCellHtml(m, k, { withVersionSelector: true })).join('')}</div>
          <div class="mc-available-spacer"></div>
          <div class="mc-mtbl">${m.table_count}</div>
        </div>`
        }).join('')}
      </div>` : `<cmx-empty-state icon="status-positive" title="当前筛选下没有待创建、安装或升级的模块" size="sm"></cmx-empty-state>`)}
    </div>`
}

/** 搜索局部重渲：只替换受搜索词影响的两个面板，不触碰工具条输入框（保焦点与输入法组词）。 */
function mcRerenderQueryRegions (root) {
  const bd = root.querySelector('.cds-bd')
  if (!bd) return
  const tmp = document.createElement('template')
  const installedEl = bd.querySelector('.mc-panel-installed')
  if (installedEl) {
    tmp.innerHTML = mcInstalledPanelHtml()
    const fresh = tmp.content.firstElementChild
    if (fresh) installedEl.replaceWith(fresh)
  }
  const availableEl = bd.querySelector('.mc-panel-available')
  if (availableEl) {
    tmp.innerHTML = mcAvailablePanelHtml()
    const fresh = tmp.content.firstElementChild
    if (fresh) availableEl.replaceWith(fresh)
  }
}

function bindExplorer (root) {
  root.querySelectorAll('[data-dam]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const kind = sel.getAttribute('data-dam')
      // ui5-select：值在 detail.selectedOption.value；回退到元素 value。
      const val = e.detail?.selectedOption?.value ?? sel.value ?? ''
      if (kind === 'domain') { state.filter.domain = val; state.filter.app = ''; state.filter.module = '' }
      else if (kind === 'app') { state.filter.app = val; state.filter.module = '' }
      else state.filter.module = val
      // DAM 变化 → 数据源列表按新过滤重新拉取，content 区各 embed 组件重挂，property 跟随。
      //   loadDatasources 内部会校正 selectedDsId（命中失效则回退首个；结果为空则清空）。
      loadDatasources().finally(refreshAll)
    })
  })
  // 数据源列表 → cmx-ignite-list + CmxDataSet
  const listEl = root.querySelector('#cds-list')
  if (listEl) {
    // 列表项在 cmx-ignite-list 自身 shadow DOM 内，页面 CSS 无法穿透 → 用 setSkinStyles 注入皮肤。
    if (typeof listEl.setSkinStyles === 'function') listEl.setSkinStyles(DS_LIST_SKIN)
    const { CmxDataSet } = cmxClasses()
    if (CmxDataSet) {
      const ds = new CmxDataSet()
      ds.setRows(state.datasources)
      listEl.setDataSet(ds)
      if (state.selectedDsId && ds.moveToId) ds.moveToId(state.selectedDsId)
    } else {
      listEl.setDataSet(state.datasources) // 回退：直接给行数组
    }
    listEl.addEventListener('cmx-row-selected', (e) => {
      const nextId = e.detail?.id || e.detail?.row?.id || ''
      if (!nextId || nextId === state.selectedDsId) return
      state.selectedDsId = nextId
      resetBuildStateForDatasource()
      updateSummaryRegion(root)  // 只更新下半概览区，不整块重渲染（保列表滚动/选中）
      refreshOverviewHosts()     // 概览视图（content 区）跟随选中项刷新
    })
  }
  updateSummaryRegion(root)
  wireExplorerSplitter(root)
}

/** 局部更新 explorer 下半的「数据库概览」区。 */
function updateSummaryRegion (root) {
  const region = root.querySelector('.cds-summary-region')
  if (!region) return
  const ds = state.datasources.find((d) => d.id === state.selectedDsId) || null
  region.innerHTML = dbSummaryHtml(ds)
}

/** explorer 上下分割：拖动 .cds-splitter 调整列表/概览高度（存 state.explorer.splitPct）。 */
function wireExplorerSplitter (root) {
  const bar = root.querySelector('[data-cds-splitter]')
  const split = root.querySelector('.cds-split')
  if (!bar || !split) return
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const rect = split.getBoundingClientRect()
    if (rect.height < 40) return
    bar.setPointerCapture?.(e.pointerId)
    split.classList.add('dragging')
    const move = (ev) => {
      const pct = Math.max(20, Math.min(80, ((ev.clientY - rect.top) / rect.height) * 100))
      state.explorer.splitPct = pct
      split.style.setProperty('--cds-split', pct + '%')
    }
    const up = () => {
      split.classList.remove('dragging')
      bar.releasePointerCapture?.(e.pointerId)
      try { localStorage.setItem('cds-explorer-splitPct', String(state.explorer.splitPct)) } catch {}
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}

/** 仅刷新「数据源概览」content 视图的 host（选中数据库变化时跟随）。 */
function refreshOverviewHosts (options = {}) {
  const preserveScroll = !!options.preserveScroll
  for (const host of Array.from(state.hosts)) {
    if (!host || !host.isConnected) { state.hosts.delete(host); continue }
    if (viewOf(host) !== 'content-overview') continue
    const root = host.renderRoot || host.shadowRoot?.querySelector('.native-page-root')
    const scroller = preserveScroll && root ? root.querySelector('.cds-ov-body') : null
    const top = scroller ? scroller.scrollTop : 0
    renderInto(host)
    if (scroller) {
      const freshRoot = host.renderRoot || host.shadowRoot?.querySelector('.native-page-root')
      const freshScroller = freshRoot && freshRoot.querySelector('.cds-ov-body')
      if (freshScroller) {
        freshScroller.scrollTop = top
        requestAnimationFrame(() => { freshScroller.scrollTop = top })
      }
    }
  }
}

/** 数据源列表皮肤（注入 cmx-ignite-list 的 shadow DOM，突出选中态）。 */
const DS_LIST_SKIN = `
  .cmx-list{gap:5px;padding:2px 0}
  .cmx-list-item{
    position:relative;border:1px solid var(--sapList_BorderColor,#e0e0e0);border-radius:8px;
    padding:9px 12px 9px 14px;gap:10px;background:var(--sapList_Background,#fff);
    transition:background .12s,border-color .12s,box-shadow .12s,transform .08s;
  }
  .cmx-list-item::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:8px 0 0 8px;
    background:transparent;transition:background .12s;
  }
  .cmx-list-item:hover{background:var(--sapList_Hover_Background,#eef4fb);border-color:#9dc3ec}
  /* 选中态：实心蓝底 + 白字，强对比，一眼可辨 */
  .cmx-list-item.is-selected{
    background:var(--sapButton_Emphasized_Background,#0a6ed1);
    border-color:var(--sapButton_Emphasized_Background,#0a6ed1);
    box-shadow:0 2px 8px rgba(10,110,209,.35);
  }
  .cmx-list-item.is-selected::before{background:#ffd83d}
  .cmx-list-item__ic{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 12%,transparent)}
  .cmx-list-item__ic ui5-icon{width:1.15rem;height:1.15rem;color:var(--sapInformationColor,#0a6ed1)}
  .cmx-list-item.is-selected .cmx-list-item__ic{background:rgba(255,255,255,.25)}
  .cmx-list-item.is-selected .cmx-list-item__ic ui5-icon{color: #fff}
  .cmx-list-item__title{font-weight:600;font-size:13px;color:var(--sapTextColor,#1d2d3e)}
  .cmx-list-item.is-selected .cmx-list-item__title{font-weight:700;color: #fff}
  .cmx-list-item__desc{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:2px}
  .cmx-list-item.is-selected .cmx-list-item__desc{color:rgba(255,255,255,.85)}
`

// ─── 皮肤 ──────────────────────────────────────────────────────────────────
function styleHtml () {
  return `<style>
    .cds-wrap{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font:13px/1.45 var(--sapFontFamily,Arial,sans-serif);color:var(--sapTextColor,#1d2d3e);background:var(--sapBackgroundColor,#f5f6f7);overflow:hidden}
    .cds-banner{display:flex;align-items:center;gap:8px;flex:0 0 40px;height:40px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#d9d9d9);background:var(--sapList_HeaderBackground,#eef2f6)}
    .cds-banner-ic{width:1.05rem;height:1.05rem;color:var(--sapInformationColor,#0a6ed1)}
    .cds-banner-title{font-weight:700;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cds-kpi{font-size:11px;font-weight:700;background:var(--sapInformationBackground,#eaf4ff);color:var(--sapInformationColor,#0a6ed1);border-radius:9px;padding:1px 9px}
    .cds-dam{padding:8px 10px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
    .cds-dam-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .cds-dam-row-module{grid-template-columns:1fr}
    .cds-select{height:28px;border:1px solid var(--sapField_BorderColor,#89919a);border-radius:4px;padding:0 6px;background:var(--sapField_Background,#fff);color:var(--sapField_TextColor,var(--sapTextColor,#1d2d3e));font-size:12px;box-sizing:border-box;width:100%;min-width:0}
    ui5-select.cds-select{height:auto;border:0;padding:0;background:transparent}
    .cds-section-label{padding:6px 12px 2px;font-size:11px;font-weight:700;color:var(--sapContent_LabelColor,#6a6d70);text-transform:uppercase;letter-spacing:.03em;flex:0 0 auto}
    .cds-section-label .cds-hint{font-weight:400;text-transform:none;letter-spacing:0;margin-left:4px}
    /* explorer 上下可调分割：上=列表，下=数据库概览 */
    .cds-split{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
    .cds-split-top{height:var(--cds-split,52%);min-height:60px;display:flex;flex-direction:column;overflow:hidden}
    .cds-split-bot{flex:1 1 auto;min-height:60px;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5)}
    .cds-splitter{flex:0 0 12px;height:12px;cursor:row-resize;display:flex;align-items:center;justify-content:center;background:var(--sapList_HeaderBackground,#f2f4f7);border-top:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-bottom:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);touch-action:none;user-select:none}
    .cds-splitter:hover,.cds-split.dragging .cds-splitter{background:#e2ecf7}
    .cds-splitter-grip{width:34px;height:4px;border-radius:3px;background:var(--sapContent_LabelColor,#9aa4b0)}
    .cds-splitter:hover .cds-splitter-grip,.cds-split.dragging .cds-splitter-grip{background:var(--sapInformationElementColor, #0a6ed1)}
    .cds-list-region{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 6px}
    .cds-summary-region{flex:1 1 auto;min-height:0;overflow:auto}
    #cds-list{--cmx-list-item-gap:2px}
    .cds-list-region .cmx-list-item{border:1px solid transparent;border-radius:6px;padding:6px 8px;gap:8px}
    .cds-list-region .cmx-list-item:hover{background:var(--sapList_Hover_Background,#f5f6f7)}
    .cds-list-region .cmx-list-item.is-selected{border-color:var(--sapContent_FocusColor,#0a6ed1);background:color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 10%,var(--sapList_Background,#fff))}
    .cds-list-region .cmx-list-item__ic ui5-icon{width:1.1rem;height:1.1rem;color:var(--sapInformationColor,#0a6ed1)}
    .cds-list-region .cmx-list-item__title{font-weight:600;font-size:12px}
    .cds-list-region .cmx-list-item__desc{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70)}
    .cds-embed-host{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}
    .cds-embed-host>portal-definition-manager,.cds-embed-host>portal-flexible-combination-manager,.cds-embed-host>portal-definition-inspector,.cds-embed-host>portal-flexible-combination-inspector{flex:1 1 auto;min-height:0;display:block}
    .cds-kv{width:100%;border-collapse:collapse;font-size:12px}
    .cds-kv th{text-align:left;width:120px;color:var(--sapContent_LabelColor,#6a6d70);font-weight:600;padding:5px 10px;vertical-align:top;background:color-mix(in srgb,var(--sapList_HeaderBackground,#f7f7f7) 40%,transparent)}
    .cds-kv td{padding:5px 10px;word-break:break-all}
    .cds-muted{color:var(--sapContent_LabelColor,#9a9d9f)}
    .cds-empty{padding:18px 12px;color:var(--sapContent_LabelColor,#6a6d70);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;min-height:60px}
    .cds-empty ui5-icon{width:1.4rem;height:1.4rem;opacity:.7}
    .cds-msg{padding:6px 12px;font-size:12px;color:var(--sapNegativeTextColor,#b00)}
    /* ── 数据源概览视图 ── */
    .cds-ov-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--sapContent_LabelColor,#6a6d70);font-size:13px}
    .cds-ov-empty ui5-icon{width:2.2rem;height:2.2rem;opacity:.5}
    .cds-ov-head{display:flex;align-items:center;gap:14px;flex:0 0 auto;padding:14px 16px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#d9d9d9);background:linear-gradient(120deg,color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 10%,var(--sapList_HeaderBackground,#eef2f6)),var(--sapList_HeaderBackground,#eef2f6))}
    .cds-ov-avatar{width:48px;height:48px;flex:0 0 auto;border-radius:12px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--sapInformationElementColor, #0a6ed1),var(--sapInformationElementColor, #4aa3ff));box-shadow:0 3px 10px rgba(10,110,209,.35)}
    .cds-ov-avatar ui5-icon{width:1.5rem;height:1.5rem;color: #fff}
    .cds-ov-id{flex:1;min-width:0}
    .cds-ov-name{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:700;color:var(--sapTextColor,#1d2d3e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cds-ov-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;background:var(--sapCriticalElementColor, #fff3cd);color:var(--sapCriticalElementColor, #a15c00)}
    .cds-ov-badge ui5-icon{width:.7rem;height:.7rem;color:var(--sapCriticalTextColor, #f0a500)}
    .cds-ov-sub{display:flex;align-items:center;gap:10px;margin-top:3px;font-size:12px}
    .cds-ov-dbid{display:inline-flex;align-items:center;gap:3px;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--sapContent_LabelColor,#5a6570)}
    .cds-ov-dbid ui5-icon{width:.8rem;height:.8rem;opacity:.7}
    .cds-ov-type{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:9px;background:var(--sapInformationBackground,#eaf4ff);color:var(--sapInformationColor,#0a6ed1);font-weight:600;font-size:11px}
    .cds-ov-status{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700}
    .cds-ov-status ui5-icon{width:.9rem;height:.9rem}
    .cds-ov-status.on{background:color-mix(in srgb,var(--sapPositiveColor,#107e3e) 14%,transparent);color:var(--sapPositiveColor,#107e3e)}
    .cds-ov-status.off{background:color-mix(in srgb,var(--sapNegativeColor,#bb0000) 12%,transparent);color:var(--sapNegativeColor,#bb0000)}
    .cds-ov-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:14px}
    /* 摘要移入 explorer 下半（窄列）：外层区域已滚动，内容紧凑、hero 竖排 */
    .cds-summary-region .cds-ov-head{padding:10px 12px;gap:10px}
    .cds-summary-region .cds-ov-avatar{width:40px;height:40px}
    .cds-summary-region .cds-ov-name{font-size:15px}
    .cds-summary-region .cds-ov-body{flex:0 0 auto;overflow:visible;padding:10px 12px;gap:10px}
    .cds-summary-region .cds-ov-card{padding:11px 12px;border-radius:10px}
    .cds-summary-region .cds-ov-hero{flex-direction:column;align-items:stretch;gap:12px}
    .cds-summary-region .cds-ov-hero-right{flex-direction:row;flex-wrap:wrap}
    .cds-summary-region .cds-ov-tiles{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
    .cds-summary-region .cds-ov-feats{grid-template-columns:1fr}
    .cds-ov-card{border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:12px;background:var(--sapTile_Background,#fff);padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
    .cds-ov-card-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;margin-bottom:12px}
    .cds-ov-card-h ui5-icon{width:1rem;height:1rem;color:var(--sapInformationColor,#0a6ed1)}
    .cds-ov-demo{font-weight:500;font-size:10px;color:var(--sapContent_LabelColor,#9aa0a6);background:var(--sapList_HeaderBackground,#f0f2f5);border-radius:6px;padding:1px 7px;margin-left:auto}
    .cds-ov-hero{display:flex;gap:20px;align-items:center;background:linear-gradient(120deg,var(--sapTile_Background,#fff),color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 5%,var(--sapTile_Background,#fff)))}
    .cds-ov-hero-left{flex:1;min-width:0}
    .cds-ov-hero-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin-bottom:10px}
    .cds-ov-gauge{height:12px;border-radius:7px;background:var(--sapList_HeaderBackground,#e9edf2);overflow:hidden}
    .cds-ov-gauge-fill{height:100%;border-radius:7px;background:linear-gradient(90deg,var(--sapPositiveElementColor, #30c46f),var(--sapInformationElementColor, #0a6ed1));transition:width .6s ease}
    .cds-ov-hero-metrics{display:flex;gap:18px;margin-top:10px;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);flex-wrap:wrap}
    .cds-ov-hero-metrics b{font-size:15px;color:var(--sapTextColor,#1d2d3e);margin-right:3px}
    .cds-ov-hero-right{display:flex;flex-direction:column;gap:7px;flex:0 0 auto}
    .cds-ov-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;background:var(--sapList_HeaderBackground,#f0f3f7);color:var(--sapTextColor,#32363a);font-size:11px;max-width:100%;min-width:0;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
    .cds-ov-chip ui5-icon{width:.85rem;height:.85rem;color:var(--sapInformationColor,#0a6ed1);flex:0 0 auto;align-self:flex-start;margin-top:1px}
    .cds-ov-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
    .cds-ov-tile{display:flex;align-items:center;gap:10px;border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:10px;background:var(--sapTile_Background,#fff);padding:11px 12px}
    .cds-ov-tile-ic{width:34px;height:34px;flex:0 0 auto;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--sapList_HeaderBackground,#eef2f6)}
    .cds-ov-tile-ic ui5-icon{width:1.05rem;height:1.05rem;color:var(--sapContent_LabelColor,#5a6570)}
    .cds-ov-tile.t-blue .cds-ov-tile-ic{background:#e5f0fc}.cds-ov-tile.t-blue .cds-ov-tile-ic ui5-icon{color:var(--sapInformationElementColor, #0a6ed1)}
    .cds-ov-tile.t-green .cds-ov-tile-ic{background:#e3f5ea}.cds-ov-tile.t-green .cds-ov-tile-ic ui5-icon{color:var(--sapPositiveElementColor, #107e3e)}
    .cds-ov-tile.t-violet .cds-ov-tile-ic{background:#efe8fb}.cds-ov-tile.t-violet .cds-ov-tile-ic ui5-icon{color:var(--neo-violet, #7c3aed)}
    .cds-ov-tile.t-amber .cds-ov-tile-ic{background:#fdf0d9}.cds-ov-tile.t-amber .cds-ov-tile-ic ui5-icon{color:var(--sapCriticalElementColor, #c77700)}
    .cds-ov-tile.t-teal .cds-ov-tile-ic{background:#dcf5f2}.cds-ov-tile.t-teal .cds-ov-tile-ic ui5-icon{color:#0d9488}
    .cds-ov-tile.t-gray .cds-ov-tile-ic ui5-icon{color:var(--sapContent_LabelColor, #8a9099)}
    .cds-ov-tile-main{min-width:0}
    .cds-ov-tile-val{font-size:14px;font-weight:700;color:var(--sapTextColor,#1d2d3e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cds-ov-tile-lbl{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:1px}
    .cds-ov-feats{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
    .cds-ov-feat{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:10px;background:var(--sapList_HeaderBackground,#f6f8fb)}
    .cds-ov-feat ui5-icon{width:1.15rem;height:1.15rem;flex:0 0 auto;color:var(--sapInformationColor,#0a6ed1);margin-top:1px}
    .cds-ov-feat .ff-t{font-size:12px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .cds-ov-feat .ff-s{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:2px}
    .cds-ov-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
    /* ── 建表工作台 ── */
    .cds-bd-target{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #cfe2f7;border-radius:10px;background:linear-gradient(120deg,#eef6ff,var(--sapTile_Background,#fff));margin-bottom:14px}
    .cds-bd-target-ic{width:38px;height:38px;flex:0 0 auto;border-radius:9px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--sapInformationElementColor, #0a6ed1),var(--sapInformationElementColor, #4aa3ff))}
    .cds-bd-target-ic ui5-icon{width:1.2rem;height:1.2rem;color: #fff}
    .cds-bd-target-main{flex:1;min-width:0}
    .cds-bd-target-l{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);font-weight:600}
    .cds-bd-target-v{font-size:14px;font-weight:700;color:var(--sapTextColor,#1d2d3e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cds-bd-target-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;font-weight:500;color:var(--sapContent_LabelColor,#5a6570);margin-left:4px}
    .cds-bd-grid{display:grid;grid-template-columns:minmax(0,1fr) 232px;gap:14px}
    @media (max-width:720px){.cds-bd-grid{grid-template-columns:1fr}}
    .cds-bd-picker{min-width:0;border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
    .cds-bd-toolbar{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#eee);background:var(--sapList_HeaderBackground,#f6f8fb);flex-wrap:wrap}
    .cds-bd-kinds{display:flex;gap:3px}
    .cds-bd-kind{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;background:transparent;border-radius:7px;padding:5px 10px;font:inherit;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);cursor:pointer}
    .cds-bd-kind:hover{background:var(--sapList_Background, #ffffff)}
    .cds-bd-kind.active{background:var(--sapList_Background, #ffffff);color:var(--sapInformationElementColor, #0a6ed1);font-weight:700;border-color:#cfe2f7;box-shadow:0 1px 2px rgba(0,0,0,.05)}
    .cds-bd-kind-n{font-size:10px;font-weight:700;background:var(--sapList_HeaderBackground,#e7edf4);color:var(--sapContent_LabelColor,#6a6d70);border-radius:8px;padding:0 6px}
    .cds-bd-kind.active .cds-bd-kind-n{background:#e5f0fc;color:var(--sapInformationElementColor, #0a6ed1)}
    .cds-bd-search{flex:1;min-width:120px;height:30px;border:1px solid var(--sapField_BorderColor,#b9c0c9);border-radius:7px;padding:0 10px;font-size:12px;background:#fff;color:inherit;box-sizing:border-box}
    .cds-bd-selbar{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f0f0f0)}
    .cds-bd-selbar-acts{display:flex;gap:6px}
    .cds-bd-link{border:0;background:transparent;color:var(--sapInformationElementColor, #0a6ed1);font:inherit;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:5px}
    .cds-bd-link:hover{background:#eef4fb}
    .cds-bd-list{max-height:300px;overflow:auto;padding:6px}
    .cds-bd-row{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
    .cds-bd-row:hover{background:var(--sapList_Hover_Background,#f3f7fc)}
    .cds-bd-row.on{background:#eef6ff;border-color:#bcdcfb}
    .cds-bd-row input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
    .cds-bd-check{width:19px;height:19px;flex:0 0 auto;border:1.5px solid var(--sapField_BorderColor,#b3bcc6);border-radius:6px;display:flex;align-items:center;justify-content:center;background:#fff;transition:all .12s}
    .cds-bd-check ui5-icon{width:.7rem;height:.7rem;color: #fff;opacity:0}
    .cds-bd-row.on .cds-bd-check{background:var(--sapInformationElementColor, #0a6ed1);border-color:var(--sapInformationElementColor, #0a6ed1)}
    .cds-bd-row.on .cds-bd-check ui5-icon{opacity:1}
    .cds-bd-kbadge{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;font-size:10px;font-weight:700;padding:2px 7px;border-radius:7px}
    .cds-bd-kbadge ui5-icon{width:.72rem;height:.72rem}
    .cds-bd-kbadge.dct{background:#e5f0fc;color:var(--sapInformationElementColor, #0a6ed1)}
    .cds-bd-kbadge.doc{background:#e9f7ee;color:var(--sapPositiveElementColor, #107e3e)}
    .cds-bd-row-main{flex:1;min-width:0}
    .cds-bd-row-t{display:block;font-size:13px;font-weight:600;color:var(--sapTextColor,#1d2d3e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cds-bd-row-s{display:block;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
    .cds-bd-row-n{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;font-size:12px;font-weight:700;color:var(--sapContent_LabelColor,#5a6570)}
    .cds-bd-row-n ui5-icon{width:.85rem;height:.85rem;opacity:.7}
    .cds-bd-empty{padding:26px 12px;display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--sapContent_LabelColor,#8a9099);font-size:12px}
    .cds-bd-empty.err{color:var(--sapNegativeColor,#bb0000)}
    .cds-bd-empty ui5-icon{width:1.6rem;height:1.6rem;opacity:.6}
    .cds-bd-side{border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:10px;padding:12px;background:var(--sapList_HeaderBackground,#f9fbfd);display:flex;flex-direction:column;gap:8px}
    .cds-bd-side-h{font-size:12px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .cds-bd-opt-l{font-size:11px;font-weight:600;color:var(--sapContent_LabelColor,#6a6d70);margin-top:4px}
    .cds-bd-opts{display:flex;flex-direction:column;gap:5px}
    .cds-bd-opt{display:flex;align-items:center;gap:7px;border:1px solid var(--sapField_BorderColor,#cdd4dc);background:#fff;border-radius:7px;padding:7px 9px;font:inherit;font-size:12px;color:var(--sapTextColor,#32363a);cursor:pointer;text-align:left}
    .cds-bd-opt ui5-icon{width:.9rem;height:.9rem;color:var(--sapContent_LabelColor,#8a9099)}
    .cds-bd-opt:hover{border-color:#9dc3ec}
    .cds-bd-opt.active{border-color:var(--sapInformationElementColor, #0a6ed1);background:#eef6ff;color:var(--sapInformationElementColor, #0a6ed1);font-weight:600}
    .cds-bd-opt.active ui5-icon{color:var(--sapLinkColor, #0a6ed1)}
    .cds-bd-switch{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--sapTextColor,#32363a);cursor:pointer;margin-top:4px}
    .cds-bd-switch input{position:absolute;opacity:0;width:0;height:0}
    .cds-bd-switch-box{width:34px;height:19px;flex:0 0 auto;border-radius:11px;background:#c4ccd6;position:relative;transition:background .15s}
    .cds-bd-switch-box::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--sapGroup_ContentBorderColor, #ffffff);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
    .cds-bd-switch input:checked + .cds-bd-switch-box{background:var(--sapInformationElementColor, #0a6ed1)}
    .cds-bd-switch input:checked + .cds-bd-switch-box::after{transform:translateX(15px)}
    .cds-bd-schema{height:30px;border:1px solid var(--sapField_BorderColor,#cdd4dc);border-radius:7px;padding:0 9px;font-size:12px;background:#fff;color:inherit;box-sizing:border-box}
    .cds-bd-summary{margin-top:6px;padding-top:10px;border-top:1px dashed var(--sapGroup_TitleBorderColor,#d9d9d9);display:flex;flex-direction:column;gap:5px}
    .cds-bd-sum-row{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70)}
    .cds-bd-sum-row b{font-size:14px;color:var(--sapLinkColor, #0a6ed1)}
    .cds-bd-actbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:11px 12px;border-radius:10px;background:linear-gradient(120deg,#f0f6fd,#f7fafd);border:1px solid #dbe7f4}
    .cds-bd-actbar-info{flex:1;min-width:180px;font-size:12px;color:var(--sapContent_LabelColor,#5a6570);display:flex;align-items:center;gap:6px}
    .cds-bd-actbar-info ui5-icon{width:1rem;height:1rem;color:var(--sapLinkColor, #0a6ed1);flex:0 0 auto}
    .cds-bd-actbar-info b{color:var(--sapLinkColor, #0a6ed1)}
    .cds-bd-actbar-btns{display:flex;gap:8px}
    .cds-bd-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 16px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent}
    .cds-bd-btn ui5-icon{width:.95rem;height:.95rem}
    .cds-bd-btn.ghost{background:#fff;border-color:var(--sapButton_BorderColor,#b9c0c9);color:var(--sapButton_TextColor,#32363a)}
    .cds-bd-btn.ghost:hover{background:#f2f5f8}
    .cds-bd-btn.primary{background:var(--sapButton_Emphasized_Background,#0a6ed1);color:#fff;box-shadow:0 2px 6px rgba(10,110,209,.35)}
    .cds-bd-btn.primary:hover{background:var(--sapInformationElementColor, #085caf)}
    .cds-bd-btn[disabled]{opacity:.5;cursor:not-allowed;box-shadow:none}
    .cds-bd-plan{margin-top:14px;border:1px solid var(--sapPositiveElementColor, #c9e0d3);border-radius:10px;overflow:hidden;background:var(--sapGroup_ContentBorderColor, #ffffff)}
    .cds-bd-plan-h{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:13px;font-weight:700;color:var(--sapTextColor,#1d2d3e);background:linear-gradient(120deg,#e9f7ef,#f5fbf7);border-bottom:1px solid #d6ebe0}
    .cds-bd-plan-h span:first-child{display:inline-flex;align-items:center;gap:7px;min-width:0}
    .cds-bd-plan-h ui5-icon{width:1rem;height:1rem;color:var(--sapPositiveTextColor, #107e3e)}
    .cds-bd-plan-sum{margin-left:auto;font-size:11px;font-weight:500;color:var(--sapContent_LabelColor,#6a6d70)}
    .cds-bd-plan-demo{color:var(--sapCriticalTextColor, #c77700);font-weight:700}
    .cds-bd-plan-err{display:flex;align-items:center;gap:6px;padding:8px 12px;font-size:12px;color:var(--sapNegativeColor,#bb0000);background:#fdecec}
    .cds-bd-plan-err ui5-icon{width:.9rem;height:.9rem}
    .cds-bd-plan-grp{padding:10px 12px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f0f0f0)}
    .cds-bd-plan-grp-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    .cds-bd-plan-grp-t{font-size:12px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .cds-bd-plan-grp-n{margin-left:auto;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70)}
    .cds-bd-plan-tables{display:flex;flex-wrap:wrap;gap:6px}
    .cds-bd-tbl{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--sapGroup_TitleBorderColor,#e0e6ec);border-radius:7px;background:var(--sapList_HeaderBackground,#f7f9fc);font-size:11px;color:var(--sapContent_LabelColor,#5a6570)}
    .cds-bd-tbl ui5-icon{width:.8rem;height:.8rem;color:var(--sapLinkColor, #0a6ed1)}
    .cds-bd-tbl b{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--sapTextColor,#1d2d3e);font-weight:600}
    .cds-bd-tbl span{color:var(--sapContent_LabelColor,#8a9099)}
    .cds-bd-tbl em{font-style:normal;color:var(--sapLinkColor, #0a6ed1);font-weight:600}
    .cds-bd-plan-empty{font-size:11px;color:var(--sapContent_LabelColor,#9aa0a6)}
    .mc-result-detail{margin-top:8px;border:1px solid var(--sapGroup_TitleBorderColor,#e1e7ee);border-radius:8px;background:var(--sapList_Background,#fff);overflow:hidden}
    .mc-result-detail>summary{height:30px;display:flex;align-items:center;gap:6px;padding:0 10px;cursor:pointer;list-style:none;font-size:12px;font-weight:700;color:var(--sapLinkColor,#0a6ed1);background:var(--sapList_HeaderBackground,#f7f9fc)}
    .mc-result-detail>summary::-webkit-details-marker{display:none}
    .mc-result-detail>summary ui5-icon{width:.9rem;height:.9rem;color:currentColor}
    .mc-change-table{padding:9px 10px;border-top:1px solid var(--sapGroup_TitleBorderColor,#edf1f5)}
    .mc-change-table-h{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:8px}
    .mc-change-table-h b{font:600 12px/1.3 ui-monospace,Menlo,Consolas,monospace;color:var(--sapTextColor,#1d2d3e);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mc-change-table-h small{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mc-change-table-h i{margin-left:auto;font-style:normal;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap}
    .mc-change-sec{margin-top:7px}
    .mc-change-sec>b{display:block;margin-bottom:5px;font-size:11px;color:var(--sapContent_LabelColor,#5f6b76)}
    .mc-change-tags{display:flex;flex-wrap:wrap;gap:5px}
    .mc-change-tags span{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 7px;border:1px solid var(--sapGroup_TitleBorderColor,#dfe6ee);border-radius:6px;background:var(--sapField_Background,#fff);font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;color:var(--sapTextColor,#1d2d3e)}
    /* 保留的手工索引：中性底 + 提示色边，与将执行的变更（新增/删除）区分 */
    .mc-change-tags span.mc-tag-preserved{border-color:var(--sapInformationBorderColor,#d0e7fd);background:var(--sapInformationBackground,#f5faff)}
    .mc-change-tags em,.mc-mod-col em{font-style:normal;font-family:var(--sapFontFamily,Arial,sans-serif);font-size:10px;color:var(--sapContent_LabelColor,#6a6d70)}
    .mc-mod-col{display:grid;grid-template-columns:minmax(90px,.5fr) minmax(0,1fr);gap:6px 8px;align-items:start;margin-top:5px;font-size:11px}
    .mc-mod-col>span{font:600 11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:var(--sapTextColor,#1d2d3e);min-width:0;overflow:hidden;text-overflow:ellipsis}
    .mc-mod-col code{display:block;min-width:0;margin-bottom:3px;padding:2px 5px;border-radius:5px;background:var(--sapList_HeaderBackground,#f5f7fa);color:var(--sapContent_LabelColor,#4d5965);white-space:normal;word-break:break-word}
    .mc-change-empty,.mc-change-error{padding:7px 9px;border-radius:7px;font-size:11px}
    .mc-change-empty{color:var(--sapContent_LabelColor,#6a6d70);background:var(--sapList_HeaderBackground,#f7f9fc)}
    .mc-change-error{margin:8px 10px 0;color:var(--sapNegativeColor,#bb0000);background:#fdecec}
    .cds-bd-plan-foot{display:flex;align-items:center;gap:6px;padding:9px 12px;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);background:var(--sapList_HeaderBackground,#f7f9fc)}
    .cds-bd-plan-foot ui5-icon{width:.9rem;height:.9rem;color:var(--sapLinkColor, #0a6ed1);flex:0 0 auto}
    /* ── 场景工作台（模型中心）── */
    .cds-bd-kbadge.seed{background:#fff2df;color:var(--sapCriticalElementColor, #c77700)}
    .cds-bd-kbadge.menu{background:#efe9fb;color:var(--sapInformationElementColor, #6a4cd9)}
    .cds-bd-kbadge.rpt{background:#fde8f3;color:var(--sapNegativeElementColor, #c0356a)}
    /* 运维 tab 切换 */
    .mc-tabs{display:flex;align-items:center;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5)}
    .mc-tab{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:8px 14px;font:inherit;font-size:13px;font-weight:600;color:var(--sapContent_LabelColor,#6a6d70);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
    .mc-tab ui5-icon{width:.95rem;height:.95rem}
    .mc-tab:hover{color:var(--sapLinkColor, #0a6ed1)}
    .mc-tab.active{color:var(--sapInformationElementColor, #0a6ed1);border-bottom-color:var(--sapLinkColor, #0a6ed1)}
    /* 初始化状态卡 */
    .mc-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:10px 0}
    .mc-status-cell{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--sapGroup_TitleBorderColor,#e8e8e8);border-radius:10px;background:var(--sapTile_Background,#fff)}
    .mc-status-cell ui5-icon{width:1.35rem;height:1.35rem;flex:0 0 auto}
    .mc-st-tx{min-width:0}
    .mc-st-l{font-size:11px;color:var(--sapContent_LabelColor,#8a9099)}
    .mc-st-v{font-size:14px;font-weight:700;color:var(--sapTextColor,#32363a);word-break:break-all}
    .mc-st-ok ui5-icon{color:var(--sapPositiveTextColor, #107e3e)}.mc-st-ok{border-color:var(--sapPositiveElementColor, #c3e6cd);background:var(--sapPositiveElementColor, #f2fbf5)}
    .mc-st-warn ui5-icon{color:var(--sapCriticalTextColor, #e9730c)}.mc-st-warn{border-color:var(--sapCriticalElementColor, #f5d9b0);background:var(--sapCriticalElementColor, #fef7ee)}
    .mc-st-muted ui5-icon{color:var(--sapLinkColor, #0a6ed1)}
    /* 停止按钮 */
    .cds-bd-btn.danger{background:var(--sapNegativeElementColor, #bb0000);color: #fff;box-shadow:0 2px 6px rgba(187,0,0,.3)}
    .cds-bd-btn.danger:hover{background:var(--sapNegativeElementColor, #a30000)}
    /* 库门闸 */
    .mc-gate{display:flex;align-items:center;gap:14px;padding:18px 16px;border-radius:12px;margin-bottom:10px}
    .mc-gate-blue{background:linear-gradient(120deg,#e8f2fe,#f5faff);border:1px solid #bcdcfb}
    .mc-gate-amber{background:linear-gradient(120deg,#fdf3e2,#fffdf9);border:1px solid var(--sapCriticalElementColor, #f3d9a8)}
    .mc-gate-red{background:linear-gradient(120deg,#fdecec,#fff9f9);border:1px solid var(--sapNegativeElementColor, #f3bcbc)}
    .mc-gate-ic{width:2.2rem;height:2.2rem;flex:0 0 auto}
    .mc-gate-blue .mc-gate-ic{color:var(--sapLinkColor, #0a6ed1)}.mc-gate-amber .mc-gate-ic{color:var(--sapCriticalTextColor, #c77700)}.mc-gate-red .mc-gate-ic{color:var(--sapNegativeTextColor, #bb0000)}
    .mc-gate-main{flex:1;min-width:0}
    .mc-gate-title{font-size:15px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .mc-gate-desc{font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:3px}
    .mc-gate-note{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--sapContent_LabelColor,#9aa0a6);padding:0 4px}
    .mc-gate-note ui5-icon{width:.9rem;height:.9rem;color:var(--sapLinkColor, #0a6ed1);flex:0 0 auto}
    /* 初始化实时进度日志 */
    .mc-initlog{margin:10px 0;border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:10px;overflow:hidden;background:var(--sapTile_Background,#fff)}
    .mc-il-head{display:flex;align-items:center;gap:7px;padding:8px 12px;font-size:12px;font-weight:700;background:var(--sapList_HeaderBackground,#f6f8fb);border-bottom:1px solid var(--sapGroup_TitleBorderColor,#eee)}
    .mc-il-head span{display:inline-flex;align-items:center;gap:7px;min-width:0;flex:1}
    .mc-il-head ui5-icon{width:1rem;height:1rem;color:var(--sapLinkColor, #0a6ed1)}
    .mc-il-body{max-height:240px;overflow:auto;padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace}
    .mc-il-row{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:12px;color:var(--sapTextColor,#32363a)}
    .mc-il-row ui5-icon{width:.85rem;height:.85rem;flex:0 0 auto}
    .mc-il-msg{flex:1;min-width:0;word-break:break-all}
    .mc-il-prog{font-weight:700;color:var(--sapLinkColor, #0a6ed1)}
    .mc-il-connect ui5-icon,.mc-il-step ui5-icon{color:var(--sapContent_LabelColor,#6a6d70)}
    .mc-il-progress ui5-icon{color:var(--sapLinkColor, #0a6ed1)}
    .mc-il-done{color:var(--sapPositiveTextColor, #107e3e);font-weight:700}.mc-il-done ui5-icon{color:var(--sapPositiveTextColor, #107e3e)}
    .mc-il-error{color:var(--sapNegativeTextColor, #bb0000)}.mc-il-error ui5-icon{color:var(--sapNegativeTextColor, #bb0000)}
    .mc-il-foot{display:flex;align-items:center;gap:6px;padding:7px 12px;font-size:11px;border-top:1px solid var(--sapGroup_TitleBorderColor,#eee)}
    .mc-il-foot ui5-icon{width:.85rem;height:.85rem}
    .mc-il-foot.run{color:var(--sapLinkColor, #0a6ed1)}.mc-il-foot.ok{color:var(--sapPositiveTextColor, #107e3e)}.mc-il-foot.err{color:var(--sapNegativeTextColor, #bb0000);background:#fdecec}
    /* 执行计划审核 */
    .mc-review{margin:10px 0;border:1px solid #bcdcfb;border-radius:10px;overflow:hidden;background:var(--sapGroup_ContentBorderColor, #ffffff)}
    .mc-review-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:linear-gradient(120deg,#eef6ff,#f8fbff);border-bottom:1px solid #d8e9fb;font-size:12px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .mc-review-head span{display:inline-flex;align-items:center;gap:7px;flex:1;min-width:0}
    .mc-review-head ui5-icon{width:1rem;height:1rem;color:var(--sapLinkColor, #0a6ed1)}
    .mc-review-head b{font-size:11px;color:var(--sapLinkColor, #0a6ed1);background:#e5f0fc;border-radius:10px;padding:1px 8px}
    .mc-review-body{max-height:260px}
    .mc-review .mc-il-row{border-left:3px solid transparent;margin:1px 8px;padding-left:9px;border-radius:6px}
    .mc-review .mc-phase-plan{background:#f2f7ff;border-left-color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-review .mc-phase-execute{background:#f0fbf5;border-left-color:var(--sapPositiveElementColor, #107e3e)}
    .mc-review .mc-phase-plan::before,.mc-review .mc-phase-execute::before{content:'计划';flex:0 0 auto;min-width:28px;text-align:center;font-family:var(--sapFontFamily,Arial,sans-serif);font-size:10px;font-weight:700;border-radius:6px;padding:1px 4px}
    .mc-review .mc-phase-plan::before{color:var(--sapLinkColor, #0a6ed1);background:#dcecff}
    .mc-review .mc-phase-execute::before{content:'执行';color:var(--sapPositiveTextColor, #107e3e);background:#dff4e8}
    .mc-review-detail{border-top:1px solid var(--sapGroup_TitleBorderColor,#dce6f0);background:var(--sapList_Background,#fff)}
    .mc-review-detail-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#e7edf4);background:var(--sapList_HeaderBackground,#f7f9fc);font-size:12px;font-weight:800;color:var(--sapTextColor,#1d2d3e)}
    .mc-review-detail-h span{display:inline-flex;align-items:center;gap:7px}
    .mc-review-detail-h ui5-icon{width:.95rem;height:.95rem;color:var(--sapLinkColor,#0a6ed1)}
    .mc-review-detail-h b{margin-left:auto;font-size:11px;color:var(--sapContent_LabelColor,#6a6d70)}
    .mc-review-actions{display:flex;justify-content:flex-end;gap:8px;padding:9px 12px;border-top:1px solid var(--sapGroup_TitleBorderColor,#eee);background:var(--sapList_HeaderBackground,#f7f9fc)}
    /* 工具条 + 场景徽标 */
    .mc-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
    .mc-badges{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
    .mc-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--sapField_BorderColor,#d0d7de);background:#fff;border-radius:20px;padding:4px 11px;font:inherit;font-size:12px;color:var(--sapTextColor,#32363a);cursor:pointer}
    .mc-badge ui5-icon{width:.85rem;height:.85rem}
    .mc-badge b{font-weight:700}
    .mc-badge:hover{border-color:#9dc3ec}
    .mc-badge.active{box-shadow:0 0 0 2px rgba(10,110,209,.18)}
    .mc-badge.t-all.active{border-color:var(--sapInformationElementColor, #0a6ed1);color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-badge.t-blue{color:var(--sapInformationElementColor, #0a6ed1)}.mc-badge.t-blue ui5-icon{color:var(--sapLinkColor, #0a6ed1)}.mc-badge.t-blue.active{background:#eef6ff;border-color:var(--sapLinkColor, #0a6ed1)}
    .mc-badge.t-amber{color:var(--sapCriticalTextColor, #c77700)}.mc-badge.t-amber ui5-icon{color:var(--sapCriticalTextColor, #c77700)}.mc-badge.t-amber.active{background:#fdf3e2;border-color:var(--sapCriticalElementColor, #e0a34a)}
    .mc-badge.t-green{color:var(--sapPositiveTextColor, #107e3e)}.mc-badge.t-green ui5-icon{color:var(--sapPositiveTextColor, #107e3e)}.mc-badge.t-green.active{background:#e9f7ee;border-color:var(--sapPositiveElementColor, #5cbb7e)}
    .mc-badge.t-red{color:var(--sapNegativeTextColor, #bb0000)}.mc-badge.t-red ui5-icon{color:var(--sapNegativeTextColor, #bb0000)}.mc-badge.t-red.active{background:#fdecec;border-color:var(--sapNegativeElementColor, #e08a8a)}
    .mc-badge.t-gray{color:var(--sapContent_LabelColor, #7a828c)}.mc-badge.t-gray ui5-icon{color:var(--sapContent_LabelColor, #7a828c)}
    .mc-badge.sm{padding:2px 8px;font-size:11px;border-radius:7px}
    .mc-quick{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sapContent_LabelColor,#8a9099);margin-bottom:8px}
    .mc-quick-sp{flex:1}
    .mc-panel{border:1px solid var(--sapGroup_TitleBorderColor,#e5e5e5);border-radius:10px;overflow:hidden;background:var(--sapTile_Background,#fff);margin-top:10px}
    .mc-panel-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:var(--sapList_HeaderBackground,#f6f8fb);border-bottom:1px solid var(--sapGroup_TitleBorderColor,#eee);font-size:12px;font-weight:700;color:var(--sapTextColor,#1d2d3e)}
    .mc-panel-h span{display:inline-flex;align-items:center;gap:7px;min-width:0}
    .mc-panel-h ui5-icon{width:.95rem;height:.95rem;color:var(--sapLinkColor, #0a6ed1)}
    .mc-panel-h b{font-size:12px;color:var(--sapLinkColor, #0a6ed1);background:#e5f0fc;border-radius:10px;padding:1px 8px}
    .mc-panel-actions{margin-left:auto;flex:0 0 auto}
    .mc-collapse-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--sapButton_BorderColor,#c5ced8);border-radius:6px;background:#fff;color:var(--sapButton_TextColor,#0a6ed1);cursor:pointer;padding:0}
    .mc-collapse-btn ui5-icon{width:.75rem;height:.75rem;color:var(--sapLinkColor, #0a6ed1)}
    .mc-collapse-btn:hover{background:#eef6ff;border-color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-installed{display:flex;flex-direction:column}
    .mc-panel-installed{overflow:visible}
    .mc-installed-head,.mc-installed-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(280px,3.5fr) minmax(120px,.5fr) 50px;gap:10px;align-items:center}
    .mc-installed-head{padding:8px 12px;font-size:11px;font-weight:700;color:var(--sapContent_LabelColor,#6a6d70);background:#fbfcfe;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f0f0f0)}
    .mc-installed-row{padding:10px 12px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f2f2f2)}
    .mc-installed-row:last-child{border-bottom:0}
    .mc-installed-row:hover{background:#fafcff}
    .mc-installed-mod{min-width:0}
    .mc-installed-kinds{display:flex;flex-wrap:wrap;gap:7px}
    .mc-installed-kinds>.mc-kind-detail{flex:1 1 150px;max-width:260px;min-width:150px}
    .mc-kind-detail{min-width:0;border:1px solid var(--sapGroup_TitleBorderColor,#edf0f4);border-radius:8px;padding:7px;background:var(--sapList_HeaderBackground,#fafbfc)}
    .mc-kind-empty{display:flex;align-items:center;justify-content:center;color:var(--sapContent_LabelColor,#8993a3);font-size:11px;font-style:italic;background:transparent;border-style:dashed}
    .mc-kd-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px}
    .mc-kind-detail .cds-bd-kbadge{margin-bottom:0}
    .mc-kd-actions{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto}
    .mc-action-menu{position:relative;display:inline-block}
    .mc-action-summary{display:inline-flex;align-items:center;justify-content:center;width:44px;height:22px;border:1px solid currentColor;border-radius:6px;background:var(--sapGroup_ContentBorderColor, #ffffff);padding:0;font:inherit;font-size:10px;font-weight:700;cursor:pointer;list-style:none}
    .mc-action-summary::-webkit-details-marker{display:none}
    .mc-action-summary::after{content:'';width:0;height:0;margin-left:3px;border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid currentColor}
    .mc-action-summary.t-amber{color:var(--sapCriticalTextColor, #b9720d);background:#fff8ec}
    .mc-action-options{position:absolute;right:0;top:26px;z-index:30;min-width:88px;padding:4px;border:1px solid var(--sapGroup_TitleBorderColor,#d9d9d9);border-radius:7px;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.16)}
    .mc-action-options button{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;border:0;border-radius:5px;background:transparent;padding:5px 7px;font:inherit;font-size:11px;color:var(--sapTextColor,#32363a);cursor:pointer;text-align:left}
    .mc-action-options button:hover,.mc-action-options button.active{background:#fff4df;color:var(--sapCriticalElementColor, #8a5100)}
    .mc-action-options b{font-size:10px;color:var(--sapCriticalTextColor, #b9720d);background:#fff0cf;border-radius:6px;padding:0 4px}
    .mc-action-btn{display:inline-flex;align-items:center;gap:3px;height:22px;border:1px solid currentColor;border-radius:6px;background:var(--sapGroup_ContentBorderColor, #ffffff);padding:0 6px;font:inherit;font-size:10px;font-weight:700;cursor:pointer}
    .mc-action-btn ui5-icon{width:.72rem;height:.72rem}
    .mc-action-btn.t-amber{color:var(--sapCriticalTextColor, #b9720d);background:#fff8ec}
    .mc-action-btn.t-red{color:var(--sapNegativeTextColor, #bb0000);background:#fff5f5}
    .mc-action-btn:hover{filter:brightness(.97);box-shadow:inset 0 0 0 1px currentColor}
    .mc-mini-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:1px solid var(--sapButton_BorderColor,#c5ced8);border-radius:6px;background:#fff;color:#0a6ed1;cursor:pointer;padding:0}
    .mc-mini-btn ui5-icon{width:.78rem;height:.78rem}
    .mc-mini-btn:hover{background:#eef6ff;border-color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-kd-main{min-width:0}
    .mc-kd-ver{font-size:12px;font-weight:700;color:var(--sapTextColor,#32363a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mc-kd-sub{font-size:10px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    .mc-installed-time{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--sapContent_LabelColor,#5f6b76)}
    @media (max-width:980px){
      .mc-installed-head{display:none}
      .mc-installed-row{grid-template-columns:1fr}
      .mc-installed-kinds>.mc-kind-detail{flex:1 1 100%;max-width:none}
      .mc-installed-time{flex-direction:row;flex-wrap:wrap}
      .mc-available-head{display:none}
      .mc-available-row{grid-template-columns:1fr}
      .mc-available-spacer{display:none}
      .mc-available-kinds>.mc-cell{flex:1 1 100%;max-width:none}
    }
    /* 可创建/安装/升级模块面板（块状自适应，与已安装面板列宽对齐） */
    .mc-available{overflow:visible}
    .mc-available-head,.mc-available-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(280px,3.5fr) minmax(80px,.5fr) 50px;gap:10px;align-items:center}
    .mc-available-head{padding:8px 12px;font-size:11px;font-weight:700;color:var(--sapContent_LabelColor,#6a6d70);background:#fbfcfe;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f0f0f0)}
    .mc-available-row{padding:10px 12px;border-bottom:1px solid var(--sapGroup_TitleBorderColor,#f2f2f2)}
    .mc-available-row:last-child{border-bottom:0}
    /* 行不施加 hover 背景色（格内含 ui5-select 等交互控件，背景闪烁会干扰）。 */
    .mc-available-row:hover{background:transparent}
    .mc-available-mod{min-width:0}
    .mc-available-spacer{}
    .mc-mmod-t{font-size:13px;font-weight:600;color:var(--sapTextColor,#1d2d3e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mc-mmod-s{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
    .mc-available-kinds{display:flex;flex-wrap:wrap;gap:7px;min-width:0}
    .mc-available-kinds .mc-cell{flex:1 1 150px;max-width:260px;min-width:150px}
    .mc-mtbl{text-align:right;font-size:13px;font-weight:700;color:var(--sapContent_LabelColor,#5a6570)}
    /* 资源格（白底卡片：左边框色条 + 标题行 + 内容行） */
    .mc-cell{position:relative;display:flex;flex-direction:column;gap:5px;padding:8px 10px 8px 11px;border:1px solid var(--sapGroup_TitleBorderColor,#e4e7ea);border-left:3px solid transparent;border-radius:8px;min-width:0;background:var(--sapList_Background,#fff);user-select:none;transition:border-color .12s,box-shadow .12s}
    .mc-cell-head{display:flex;align-items:center;gap:5px}
    .mc-cell-head .cds-bd-kbadge{margin-bottom:0;font-size:10px;padding:2px 6px;border-radius:5px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
    .mc-cell-head .cds-bd-kbadge ui5-icon{width:.7rem;height:.7rem}
    .mc-cell-sc{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;white-space:nowrap;flex:0 0 auto;margin-left:auto}
    .mc-cell-sc ui5-icon{width:.7rem;height:.7rem}
    .mc-cell-body{min-width:0;display:flex;flex-direction:column;gap:3px;line-height:1.3}
    .mc-cell-ver{font-size:11px;font-weight:600;color:var(--sapTextColor,#32363a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mc-ver-select{margin-top:2px;width:100%;height:24px;border:1px solid var(--sapField_BorderColor,#8993a3);border-radius:6px;background:#fff;color:var(--sapTextColor,#32363a);font:inherit;font-size:11px;box-sizing:border-box}
    /* ui5-select 版本选择器：去掉原生边框/底色，宽度上限为容器一半（外层 host + 内层 ::part 同步约束）。 */
    ui5-select.mc-ver-select{height:28px;width:50%;max-width:50%;border:0;padding:0;background:transparent}
    ui5-select.mc-ver-select::part(root),
    ui5-select.mc-ver-select::part(select){width:100%;min-width:0}
    /* 勾选圆点：放在标题行末尾（场景标签右侧），不再绝对定位 */
    .mc-cell-ck{flex:0 0 auto;width:16px;height:16px;border:1.5px solid var(--sapContent_LabelColor,#8993a3);border-radius:5px;display:flex;align-items:center;justify-content:center;opacity:.4;transition:opacity .1s}
    .mc-cell-ck ui5-icon{width:.65rem;height:.65rem;opacity:0}
    /* 场景色：左边框色条 + 场景标签底色，不再填充整个 cell */
    .mc-cell.t-blue{border-left-color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-cell.t-blue .mc-cell-sc{background:#eef6ff;color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-cell.t-amber{border-left-color:var(--sapCriticalElementColor, #b9720d)}
    .mc-cell.t-amber .mc-cell-sc{background:#fdf3e2;color:var(--sapCriticalElementColor, #b9720d)}
    .mc-cell.t-green{border-left-color:var(--sapPositiveElementColor, #107e3e)}
    .mc-cell.t-green .mc-cell-sc{background:#eaf7ef;color:var(--sapPositiveElementColor, #107e3e)}
    .mc-cell.t-red{border-left-color:var(--sapNegativeElementColor, #bb0000)}
    .mc-cell.t-red .mc-cell-sc{background:#fdecec;color:var(--sapNegativeElementColor, #bb0000)}
    .mc-cell.t-gray{border-left-color:#8a9099}
    .mc-cell.t-gray .mc-cell-sc{background:#f2f4f7;color:var(--sapGroup_ContentBorderColor, #8a9099)}
    .mc-cell.pickable{cursor:pointer}
    .mc-cell.pickable:hover{border-color:#9dc3ec;box-shadow:0 2px 8px rgba(10,110,209,.12)}
    .mc-cell.pickable:hover .mc-cell-ck{opacity:.7}
    /* 选中态：整体边框变蓝 + 左色条加粗 + 勾选圆点实心 */
    .mc-cell.on{border-color:var(--sapInformationElementColor, #0a6ed1);border-width:1px 1px 1px 3px;box-shadow:0 2px 10px rgba(10,110,209,.18)}
    .mc-cell.on .mc-cell-ck{opacity:1;background:var(--sapInformationElementColor, #0a6ed1);border-color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-cell.on .mc-cell-ck ui5-icon{opacity:1;color: #fff}
    /* 执行抽屉 */
    .mc-drawer{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;padding:11px 14px;border-radius:10px;background:linear-gradient(120deg,var(--sapInformationElementColor, #0a6ed1),var(--sapInformationElementColor, #3b8ae6));color:var(--sapGroup_ContentBorderColor, #ffffff);box-shadow:0 4px 14px rgba(10,110,209,.3)}
    .mc-drawer-info{flex:1;min-width:180px;display:flex;align-items:center;gap:7px;font-size:13px}
    .mc-drawer-info ui5-icon{width:1rem;height:1rem;flex:0 0 auto}
    .mc-drawer-info b{font-weight:800}
    .mc-drawer-btns{display:flex;gap:8px}
    .mc-drawer .cds-bd-btn.ghost{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4);color:var(--sapGroup_ContentBorderColor, #ffffff)}
    .mc-drawer .cds-bd-btn.ghost:hover{background:rgba(255,255,255,.26)}
    .mc-drawer .cds-bd-btn.primary{background:var(--sapList_Background, #ffffff);color:var(--sapInformationElementColor, #0a6ed1)}
    .mc-drawer .cds-bd-btn.primary:hover{background:#eaf2fc}
    /* 运维总览 / 初始化面板：统一使用 UI5 主题变量，避免暗色主题出现白底浅字。 */
    .cds-neo{
      --cds-mc-surface:var(--sapTile_Background,var(--sapList_Background,#fff));
      --cds-mc-surface-soft:var(--sapList_HeaderBackground,var(--sapGroup_ContentBackground,#f7f9fc));
      --cds-mc-field:var(--sapField_Background,var(--sapTile_Background,#fff));
      --cds-mc-border:var(--sapGroup_TitleBorderColor,var(--sapField_BorderColor,#d9d9d9));
      --cds-mc-hover:var(--sapList_Hover_Background,color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 8%,var(--sapTile_Background,#fff)));
      --cds-mc-blue-bg:var(--sapInformationBackground,color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 14%,var(--sapTile_Background,#fff)));
      --cds-mc-green-bg:var(--sapSuccessBackground,color-mix(in srgb,var(--sapPositiveColor,#107e3e) 14%,var(--sapTile_Background,#fff)));
      --cds-mc-amber-bg:var(--sapWarningBackground,color-mix(in srgb,var(--sapCriticalColor,#e9730c) 14%,var(--sapTile_Background,#fff)));
      --cds-mc-red-bg:var(--sapErrorBackground,color-mix(in srgb,var(--sapNegativeColor,#bb0000) 12%,var(--sapTile_Background,#fff)));
      --cds-mc-gray-bg:color-mix(in srgb,var(--sapContent_LabelColor,#6a6d70) 12%,var(--sapTile_Background,#fff));
      --cds-mc-blue:var(--sapInformationColor,var(--sapHighlightColor,#0a6ed1));
      --cds-mc-green:var(--sapPositiveColor,#107e3e);
      --cds-mc-amber:var(--sapCriticalColor,#e9730c);
      --cds-mc-red:var(--sapNegativeColor,#bb0000);
      --cds-mc-purple-bg:color-mix(in srgb,#6a4cd9 14%,var(--sapTile_Background,#fff));
      --cds-mc-purple:#6a4cd9;
    }
    .cds-neo .cds-bd-target{
      border-color:color-mix(in srgb,var(--cds-mc-blue) 35%,var(--cds-mc-border));
      background:linear-gradient(120deg,var(--cds-mc-blue-bg),var(--cds-mc-surface));
    }
    .cds-neo .cds-bd-search{
      background:var(--cds-mc-field);
      color:var(--sapField_TextColor,var(--sapTextColor,#32363a));
      border-color:var(--sapField_BorderColor,var(--cds-mc-border));
    }
    .cds-neo .cds-bd-search::placeholder{color:var(--sapField_PlaceholderTextColor,var(--sapContent_LabelColor,#6a6d70))}
    .cds-neo .cds-bd-btn.ghost,
    .cds-neo .mc-collapse-btn,
    .cds-neo .mc-mini-btn{
      background:var(--sapButton_Background,var(--cds-mc-surface));
      color:var(--sapButton_TextColor,var(--cds-mc-blue));
      border-color:var(--sapButton_BorderColor,var(--cds-mc-border));
    }
    .cds-neo .cds-bd-btn.ghost:hover,
    .cds-neo .mc-collapse-btn:hover,
    .cds-neo .mc-mini-btn:hover,
    .cds-neo .cds-bd-link:hover{
      background:var(--sapButton_Hover_Background,var(--cds-mc-hover));
      border-color:var(--sapButton_Hover_BorderColor,var(--cds-mc-blue));
    }
    .cds-neo .cds-bd-plan,
    .cds-neo .mc-review,
    .cds-neo .mc-panel,
    .cds-neo .mc-initlog,
    .cds-neo .mc-status-cell{
      background:var(--cds-mc-surface);
      border-color:var(--cds-mc-border);
    }
    .cds-neo .cds-bd-plan-h,
    .cds-neo .mc-review-head,
    .cds-neo .mc-panel-h,
    .cds-neo .mc-il-head,
    .cds-neo .mc-review-actions,
    .cds-neo .mc-review-detail-h,
    .cds-neo .cds-bd-plan-foot,
    .cds-neo .mc-available-head,
    .cds-neo .mc-installed-head{
      background:var(--cds-mc-surface-soft);
      border-color:var(--cds-mc-border);
    }
    .cds-neo .cds-bd-plan-h{background:linear-gradient(120deg,var(--cds-mc-green-bg),var(--cds-mc-surface-soft))}
    .cds-neo .mc-review-head{background:linear-gradient(120deg,var(--cds-mc-blue-bg),var(--cds-mc-surface-soft))}
    .cds-neo .mc-review-head b,
    .cds-neo .mc-panel-h b{
      color:var(--cds-mc-blue);
      background:var(--cds-mc-blue-bg);
    }
    .cds-neo .cds-bd-plan-err,
    .cds-neo .mc-il-foot.err{background:var(--cds-mc-red-bg);color:var(--cds-mc-red)}
    .cds-neo .cds-bd-kbadge.dct,
    .cds-neo .mc-badge.t-blue.active{background:var(--cds-mc-blue-bg);color:var(--cds-mc-blue)}
    .cds-neo .mc-cell.t-blue{border-left-color:var(--cds-mc-blue)}
    .cds-neo .mc-cell.t-blue .mc-cell-sc{background:var(--cds-mc-blue-bg);color:var(--cds-mc-blue)}
    .cds-neo .cds-bd-kbadge.doc,
    .cds-neo .mc-badge.t-green.active{background:var(--cds-mc-green-bg);color:var(--cds-mc-green)}
    .cds-neo .mc-cell.t-green{border-left-color:var(--cds-mc-green)}
    .cds-neo .mc-cell.t-green .mc-cell-sc{background:var(--cds-mc-green-bg);color:var(--cds-mc-green)}
    .cds-neo .cds-bd-kbadge.seed,
    .cds-neo .mc-badge.t-amber.active{background:var(--cds-mc-amber-bg);color:var(--cds-mc-amber)}
    .cds-neo .mc-cell.t-amber{border-left-color:var(--cds-mc-amber)}
    .cds-neo .mc-cell.t-amber .mc-cell-sc{background:var(--cds-mc-amber-bg);color:var(--cds-mc-amber)}
    .cds-neo .cds-bd-kbadge.menu{background:var(--cds-mc-purple-bg);color:var(--cds-mc-purple)}
    .cds-neo .cds-bd-kbadge.rpt{background:var(--cds-mc-red-bg);color:var(--cds-mc-red)}
    .cds-neo .mc-badge.t-red.active{background:var(--cds-mc-red-bg);color:var(--cds-mc-red)}
    .cds-neo .mc-cell.t-red{border-left-color:var(--cds-mc-red)}
    .cds-neo .mc-cell.t-red .mc-cell-sc{background:var(--cds-mc-red-bg);color:var(--cds-mc-red)}
    .cds-neo .mc-cell{background:var(--cds-mc-surface);border-color:var(--cds-mc-border)}
    .cds-neo .mc-cell.t-gray{border-left-color:var(--sapContent_LabelColor,#7a828c)}
    .cds-neo .mc-cell.t-gray .mc-cell-sc{background:var(--cds-mc-gray-bg);color:var(--sapContent_LabelColor,#7a828c)}
    .cds-neo .mc-badge{
      background:var(--sapButton_Background,var(--cds-mc-surface));
      color:var(--sapTextColor,#32363a);
      border-color:var(--sapButton_BorderColor,var(--cds-mc-border));
    }
    .cds-neo .mc-badge:hover{background:var(--sapButton_Hover_Background,var(--cds-mc-hover));border-color:var(--sapButton_Hover_BorderColor,var(--cds-mc-blue))}
    .cds-neo .mc-badge.t-all.active{background:var(--cds-mc-blue-bg);border-color:var(--cds-mc-blue);color:var(--cds-mc-blue)}
    .cds-neo .mc-gate-blue{background:linear-gradient(120deg,var(--cds-mc-blue-bg),var(--cds-mc-surface));border-color:color-mix(in srgb,var(--cds-mc-blue) 35%,var(--cds-mc-border))}
    .cds-neo .mc-gate-amber{background:linear-gradient(120deg,var(--cds-mc-amber-bg),var(--cds-mc-surface));border-color:color-mix(in srgb,var(--cds-mc-amber) 35%,var(--cds-mc-border))}
    .cds-neo .mc-gate-red{background:linear-gradient(120deg,var(--cds-mc-red-bg),var(--cds-mc-surface));border-color:color-mix(in srgb,var(--cds-mc-red) 35%,var(--cds-mc-border))}
    .cds-neo .mc-gate-blue .mc-gate-ic{color:var(--cds-mc-blue)}
    .cds-neo .mc-gate-amber .mc-gate-ic{color:var(--cds-mc-amber)}
    .cds-neo .mc-gate-red .mc-gate-ic{color:var(--cds-mc-red)}
    .cds-neo .mc-st-ok{background:var(--cds-mc-green-bg);border-color:color-mix(in srgb,var(--cds-mc-green) 35%,var(--cds-mc-border))}
    .cds-neo .mc-st-warn{background:var(--cds-mc-amber-bg);border-color:color-mix(in srgb,var(--cds-mc-amber) 35%,var(--cds-mc-border))}
    .cds-neo .mc-st-ok ui5-icon{color:var(--cds-mc-green)}
    .cds-neo .mc-st-warn ui5-icon{color:var(--cds-mc-amber)}
    .cds-neo .mc-installed-row,
    .cds-neo .mc-available-row,
    .cds-neo .cds-bd-plan-grp,
    .cds-neo .mc-review-detail,
    .cds-neo .mc-result-detail,
    .cds-neo .mc-change-table,
    .cds-neo .mc-change-tags span{border-color:var(--cds-mc-border)}
    .cds-neo .mc-result-detail,
    .cds-neo .mc-review-detail,
    .cds-neo .mc-change-tags span{background:var(--cds-mc-surface)}
    .cds-neo .mc-result-detail>summary,
    .cds-neo .mc-mod-col code,
    .cds-neo .mc-change-empty{background:var(--cds-mc-surface-soft)}
    .cds-neo .mc-change-error{background:var(--cds-mc-red-bg);color:var(--cds-mc-red)}
    .cds-neo .mc-installed-row:hover,
    .cds-neo .mc-available-row:hover{background:var(--cds-mc-hover)}
    .cds-neo .mc-kind-detail{
      background:var(--cds-mc-surface-soft);
      border-color:var(--cds-mc-border);
    }
    .cds-neo .mc-action-summary,
    .cds-neo .mc-action-btn{
      background:var(--sapButton_Background,var(--cds-mc-surface));
    }
    .cds-neo .mc-action-summary.t-amber,
    .cds-neo .mc-action-btn.t-amber{color:var(--cds-mc-amber);background:var(--cds-mc-amber-bg)}
    .cds-neo .mc-action-btn.t-red{color:var(--cds-mc-red);background:var(--cds-mc-red-bg)}
    .cds-neo .mc-action-options{
      background:var(--sapPopover_Background,var(--cds-mc-surface));
      border-color:var(--cds-mc-border);
      box-shadow:var(--sapContent_Shadow2,0 4px 14px rgba(0,0,0,.22));
    }
    .cds-neo .mc-action-options button:hover,
    .cds-neo .mc-action-options button.active{
      background:var(--cds-mc-amber-bg);
      color:var(--cds-mc-amber);
    }
    .cds-neo .mc-action-options b{color:var(--cds-mc-amber);background:var(--cds-mc-amber-bg)}
    .cds-neo .mc-review .mc-phase-plan{background:var(--cds-mc-blue-bg);border-left-color:var(--cds-mc-blue)}
    .cds-neo .mc-review .mc-phase-execute{background:var(--cds-mc-green-bg);border-left-color:var(--cds-mc-green)}
    .cds-neo .mc-review .mc-phase-plan::before{background:var(--cds-mc-blue-bg);color:var(--cds-mc-blue)}
    .cds-neo .mc-review .mc-phase-execute::before{background:var(--cds-mc-green-bg);color:var(--cds-mc-green)}
    .cds-neo .mc-cell{border-color:color-mix(in srgb,currentColor 22%,transparent)}
    /* 可创建/安装/升级格：hover 仅保留边框/阴影，不加背景色（避免与格内 ui5-select 背景冲突）。 */
    .cds-neo .mc-cell.pickable:hover{filter:none;background:transparent}
  </style>`
}

// ─── 页面入口：一个 id 服务五个 view ───────────────────────────────────────
export default {
  defaultView: 'content-overview',
  views: {
    async explorer (ctx) {
      if (!state.dam.domains.length) await loadDam()
      await loadDatasources()
      return mount(ctx, explorerHtml(), (root) => bindView(root, 'explorer'))
    },
    // 数据源概览（第一个 content 视图）：顶部选中数据库标识 + 概览创意内容。
    async 'content-overview' (ctx) {
      if (!state.datasources.length) await loadDatasources()
      return mount(ctx, contentHtml('overview'), (root) => bindView(root, 'content-overview'))
    },
    // content 三视图：整块交给真实功能组件（只读自管列表/详情），此处只需 DAM 供过滤属性。
    async 'content-dct' (ctx) {
      if (!state.dam.domains.length) await loadDam()
      return mount(ctx, contentHtml('dct'), (root) => bindView(root, 'content-dct'))
    },
    async 'content-doc' (ctx) {
      if (!state.dam.domains.length) await loadDam()
      return mount(ctx, contentHtml('doc'), (root) => bindView(root, 'content-doc'))
    },
    async 'content-profile' (ctx) {
      if (!state.dam.domains.length) await loadDam()
      return mount(ctx, contentHtml('profile'), (root) => bindView(root, 'content-profile'))
    },
    // property 三视图：各嵌对应检查器（与同名 content tab 同 scope 联动）。
    async 'property-dct' (ctx) {
      return mount(ctx, propertyHtml('dct'), (root) => bindView(root, 'property-dct'))
    },
    async 'property-doc' (ctx) {
      return mount(ctx, propertyHtml('doc'), (root) => bindView(root, 'property-doc'))
    },
    async 'property-profile' (ctx) {
      return mount(ctx, propertyHtml('profile'), (root) => bindView(root, 'property-profile'))
    },
  },
}
