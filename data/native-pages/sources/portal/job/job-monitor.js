/**
 * 任务中心 —— native_pages 异步任务管理与监控工作台（三区式 explorer/content/property）。
 * 覆盖异步任务中心 M1+M2+M3 全部能力：
 *   M1 生命周期/协作式控制/实时 SSE 进度；M2 持久化历史/汇总流；M3 分布式抢占/节点归属/优先级/失败告警。
 *
 * 三视图（一套内存 state，多 host 共享——多标签页/多区实时同步）：
 *   - explorer：① 集群/统计概览（按状态计数、活跃节点、我可控项）② 新建作业（多种类动态表单+优先级）
 *               ③ 过滤器（种类 + 状态 + 关键字）。
 *   - content ：作业列表（实时进度条 + 状态徽标 + 节点/优先级 + 快捷控制）+ 选中作业监控详情
 *               （大进度条 + 阶段 + ETA + 明细流 + 实时日志 + 全控制条 暂停/恢复/停止/重启/删除）。
 *   - property：选中作业完整属性（id/种类/状态/来源/归属节点/优先级/时间线/入参/结果/错误）。
 *
 * 通信（方案 §6）：
 *   - 控制流 走 fetch：POST /api/jobs（提交）、/api/jobs/{id}/{pause|resume|cancel|restart}、DELETE /api/jobs/{id}。
 *   - 进度流 走 SSE：/api/jobs/{id}/events（单作业，snapshot 首帧 + 增量；跨节点作业后端降级为 DB 轮询合成流）；
 *                    /api/jobs/events（汇总流，job 摘要事件 → 列表实时刷新）。
 *   - 鉴权：native page 同源（cookie），/api/jobs 已入 [auth].whitelist；EventSource 自动带 cookie。
 * 后端：cmx-job-api(JobModule) + JobManager（PgJobStore 持久化 + 分布式抢占循环，M3）。
 */

const state = {
  kinds: [],            // 已注册作业种类（后端返回）
  kindsMeta: {},        // 种类 → 元数据 {kindClass,singleton,pausable}（后端 kindsMeta，识别 service）
  throughput: new Map(),// jobId → 吞吐采样 {samples:[{t,done}], rate} —— 从 done 差分算速率/火花线
  jobs: [],             // 作业列表（GET /api/jobs，合并内存热态+持久化历史）
  filterKind: '',       // 过滤：种类
  filterStatus: '',     // 过滤：状态
  filterText: '',       // 过滤：关键字（标题/id/节点）
  selectedId: '',       // 活跃视图：当前监控的作业 id（含 SSE 实时流）
  detail: null,         // 活跃视图：选中作业详情快照
  items: new Map(),     // 活跃视图：明细行 key → item（SSE item upsert）
  logs: [],             // 活跃视图：实时日志（SSE log，环形截断）
  // 历史视图独立选中槽（只读，无 SSE）——与活跃视图分离，避免两 workspace tab 共享选中态互相覆盖闪动。
  histSel: { selectedId: '', detail: null, items: new Map() },
  listLoading: false,
  message: '',
  msgKind: 'info',      // info | ok | warn
  history: [],          // 历史作业列表（GET /api/jobs/history，当前页）
  historyTotal: 0,      // 历史作业总数（当前过滤下）
  historyPage: 1,       // 历史当前页码（1-based）
  historyPageSize: 20,  // 历史每页条数
  historyTotalPages: 0, // 历史总页数
  historyLoading: false,
  hosts: new Set(),     // 挂载的 host 集合（多区/多标签页刷新）
  es: null,             // 当前单作业 EventSource
  esJobId: '',          // es 订阅的作业 id（避免重复订阅）
  summaryEs: null,      // 汇总 SSE（服务端推送：后端有变化即推，取代轮询）
  summaryReady: false,  // 汇总流是否已首次连上（用于区分首连 vs 断线重连补拉）
  liveTimer: null,      // 存活看门狗（仅剔除已关闭 host + 停摆，不拉数据）
  // 新建作业表单模型
  form: {
    kind: 'job.demo',
    priority: 0,
    demoSteps: 12,
    demoStepMs: 500,
    demoFailAt: '',
    demoFailWhole: false,
    rptOrg: '',
    rptPeriod: '',
    rptVersion: '',
    rptCodes: '',
    conBatchMs: 800,
    conBatchSize: 5,
    conEmptyEvery: 0,
    conBusinessKey: '',
    rawParams: '{}',
  },
}

const MAX_LOGS = 400
const MAX_ITEMS = 50   // 最近处理明细最多保留 50 条（常驻消费者防内存泄漏 + 只看最近）

const STATUS_META = {
  pending:    { label: '排队中', cls: 'st-pend' },
  running:    { label: '运行中', cls: 'st-run' },
  paused:     { label: '已暂停', cls: 'st-pause' },
  cancelling: { label: '停止中', cls: 'st-cancel' },
  cancelled:  { label: '已停止', cls: 'st-cancel' },
  completed:  { label: '已完成', cls: 'st-done' },
  failed:     { label: '已失败', cls: 'st-fail' },
}
const STATUS_ORDER = ['running', 'paused', 'pending', 'cancelling', 'failed', 'completed', 'cancelled']

const ITEM_META = {
  queued:  { icon: '…', cls: 'it-queued' },
  running: { icon: '⟳', cls: 'it-running' },
  ok:      { icon: '✔', cls: 'it-ok' },
  failed:  { icon: '✖', cls: 'it-failed' },
  skipped: { icon: '↷', cls: 'it-skipped' },
}

// 已知业务种类的中文名（未知种类回退原 id）。
const KIND_LABEL = {
  'job.demo': '演示作业',
  'job.consumer': '消息消费者',
  'rpt.compute': '报表计算',
  'rpt.verify': '报表校验',
}
const kindLabel = (k) => KIND_LABEL[k] ? `${KIND_LABEL[k]} (${k})` : k

// 作业种类 → 标题着色 class（对应 CSS 里各 .kc-* 用主题变量着色，适配 light/dark）。
// 未知种类回落 kc-default（主文本色）。同前缀（rpt.*）也可归一，但这里按具体 kind 区分更清晰。
const KIND_COLOR = {
  'job.demo': 'kc-demo',
  'job.consumer': 'kc-consumer',
  'rpt.compute': 'kc-compute',
  'rpt.verify': 'kc-verify',
}
const kindColorClass = (k) => KIND_COLOR[k] || 'kc-default'

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

const fmtTime = (ms) => {
  if (!ms) return '—'
  try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) } catch { return String(ms) }
}
const fmtDur = (a, b) => {
  if (!a) return '—'
  const end = b || Date.now()
  const s = Math.max(0, Math.round((end - a) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); const r = s % 60
  return `${m}m${r}s`
}

function setMsg (text, kind = 'info') { state.message = text; state.msgKind = kind }

// ───────────────────────── 后端调用 ─────────────────────────

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

async function loadJobs () {
  state.listLoading = true
  try {
    // 拉全量（不带 kind/status 过滤）——集群概览统计需基于全量，过滤只在前端 visibleJobs 做。
    // 否则服务端过滤会缩小 state.jobs，导致统计卡片其余状态全变 0。
    const data = await apiJson('/api/jobs?limit=300')
    state.jobs = Array.isArray(data.items) ? data.items : []
    if (Array.isArray(data.kinds) && data.kinds.length) state.kinds = data.kinds
    captureKindsMeta(data)
    // 采样吞吐（service 作业按 done 差分算速率），供仪表/火花线。
    for (const j of state.jobs) sampleThroughput(j)
  } catch (e) {
    setMsg(`列表加载失败：${e.message}`, 'warn')
  } finally {
    state.listLoading = false
    refreshAll()
  }
}

// 后端 kindsMeta → state.kindsMeta 映射（kind → {kindClass,singleton,pausable}）。
function captureKindsMeta (data) {
  if (Array.isArray(data.kindsMeta)) {
    for (const m of data.kindsMeta) if (m && m.kind) state.kindsMeta[m.kind] = m
  }
}

// 是否常驻服务（消费者）作业——决定用吞吐仪表还是进度条。
function isService (j) {
  if (!j) return false
  if (j.kindClass) return j.kindClass === 'service'          // 单作业 JSON 直接带
  return state.kindsMeta[j.kind]?.kindClass === 'service'    // 回落 kindsMeta 查
}

// 采样一次吞吐：记录 (时刻, 累计done)，保留最近 30 个点，算最新速率(msg/s)。
function sampleThroughput (j) {
  if (!isService(j)) return
  const id = String(j.id)
  const done = Number(j.progress?.done || 0)
  const t = Date.now()
  let s = state.throughput.get(id)
  if (!s) { s = { samples: [], rate: 0 }; state.throughput.set(id, s) }
  const last = s.samples[s.samples.length - 1]
  // 去重：done 未变且间隔太近则跳过（避免 0 速率噪声）。
  if (last && last.done === done && t - last.t < 400) return
  s.samples.push({ t, done })
  if (s.samples.length > 30) s.samples.shift()
  // 速率 = 最近窗口 Δdone / Δt。
  const first = s.samples[0]
  const dt = (t - first.t) / 1000
  s.rate = dt > 0.3 ? Math.max(0, Math.round((done - first.done) / dt)) : 0
}

function buildParams () {
  const f = state.form
  const kind = f.kind
  if (kind === 'job.demo') {
    const p = { steps: Number(f.demoSteps) || 10, stepMs: Number(f.demoStepMs) || 500 }
    if (String(f.demoFailAt).trim() !== '') p.failAt = Number(f.demoFailAt)
    if (f.demoFailWhole) p.failWhole = true
    return p
  }
  if (kind === 'rpt.compute' || kind === 'rpt.verify') {
    if (!f.rptOrg.trim() || !f.rptPeriod.trim()) throw new Error('需填组织机构与会计期间')
    const p = { orgCode: f.rptOrg.trim(), periodCode: f.rptPeriod.trim() }
    if (f.rptVersion.trim()) p.version = f.rptVersion.trim()
    const codes = f.rptCodes.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    if (codes.length) p.reportCodes = codes
    return p
  }
  if (kind === 'job.consumer') {
    const p = {
      batchMs: Number(f.conBatchMs) || 800,
      batchSize: Number(f.conBatchSize) || 5,
    }
    if (Number(f.conEmptyEvery) > 0) p.emptyEvery = Number(f.conEmptyEvery)
    if (f.conBusinessKey.trim()) p.businessKey = f.conBusinessKey.trim()
    return p
  }
  // 未知种类：走原始 JSON 入参。
  try { return JSON.parse(f.rawParams || '{}') } catch { throw new Error('原始入参不是合法 JSON') }
}

async function submitJob () {
  let params
  try { params = buildParams() } catch (e) { setMsg(`提交失败：${e.message}`, 'warn'); refreshAll(); return }
  const body = { kind: state.form.kind, params }
  const prio = Number(state.form.priority)
  if (Number.isFinite(prio) && prio !== 0) body.priority = prio
  try {
    const data = await apiJson('/api/jobs', { method: 'POST', body: JSON.stringify(body) })
    setMsg(`作业已提交：#${data.id}`, 'ok')
    await loadJobs()
    openMonitor(String(data.id))
  } catch (e) {
    setMsg(`提交失败：${e.message}`, 'warn')
    refreshAll()
  }
}

const ACTION_LABEL = { pause: '暂停', resume: '恢复', cancel: '停止', restart: '重启' }

async function control (id, action) {
  try {
    const data = await apiJson(`/api/jobs/${id}/${action}`, { method: 'POST' })
    if (action === 'restart' && data && data.id) {
      setMsg(`已重启为新作业 #${data.id}`, 'ok')
      await loadJobs()
      openMonitor(String(data.id))
      return
    }
    setMsg(`已${ACTION_LABEL[action] || action}作业 #${id}`, 'ok')
    await refreshDetail(id)
    await loadJobs()
  } catch (e) {
    setMsg(`操作失败：${e.message}`, 'warn')
    refreshAll()
  }
}

// 归档作业（原「删除」，语义调整为 RU/HI 分离：转移到历史表而非真删）。
async function archiveJob (id) {
  try {
    await apiJson(`/api/jobs/${id}`, { method: 'DELETE' })
    setMsg(`已归档作业 #${id}（转入历史）`, 'ok')
    if (String(id) === state.selectedId) { closeEs(); state.selectedId = ''; state.detail = null; state.items = new Map(); state.logs = [] }
    await loadJobs()
    if (historyMounted()) await loadHistory()
  } catch (e) {
    setMsg(`归档失败：${e.message}`, 'warn')
    refreshAll()
  }
}

// 加载历史作业列表（cmx_job_hi，分页）。历史全是终态，故非终态过滤（running/pending/paused/cancelling）
// 对历史无意义——若活跃 tab 遗留了非终态状态过滤，这里忽略它，避免「N 条却列表空」。
async function loadHistory () {
  state.historyLoading = true
  try {
    const TERMINAL = ['completed', 'failed', 'cancelled']
    const qs = [`page=${state.historyPage}`, `page_size=${state.historyPageSize}`]
    if (state.filterKind) qs.push(`kind=${encodeURIComponent(state.filterKind)}`)
    if (state.filterStatus && TERMINAL.includes(state.filterStatus)) {
      qs.push(`status=${encodeURIComponent(state.filterStatus)}`)
    }
    const data = await apiJson(`/api/jobs/history?${qs.join('&')}`)
    state.history = Array.isArray(data.items) ? data.items : []
    captureKindsMeta(data)
    state.historyTotal = data.total || 0
    state.historyTotalPages = data.totalPages || 0
    if (typeof data.page === 'number') state.historyPage = data.page
    if (typeof data.pageSize === 'number') state.historyPageSize = data.pageSize
    // 页码越界（如删完当前页后）自动回退到最后一页。
    if (state.historyTotalPages > 0 && state.historyPage > state.historyTotalPages) {
      state.historyPage = state.historyTotalPages
      state.historyLoading = false
      return loadHistory()
    }
  } catch (e) {
    setMsg(`历史加载失败：${e.message}`, 'warn')
  } finally {
    state.historyLoading = false
    refreshAll()
  }
}

// 跳到历史某页（夹取到合法范围）。
function gotoHistoryPage (p) {
  const max = Math.max(1, state.historyTotalPages)
  const np = Math.min(max, Math.max(1, p))
  if (np === state.historyPage) return
  state.historyPage = np
  loadHistory()
}

// 过滤/统计卡片变更后刷新：活跃列表纯前端过滤(loadJobs 保持全量新鲜)；历史视图已挂载则回第1页重拉。
function reloadCurrent () {
  loadJobs()
  if (historyMounted()) { state.historyPage = 1; loadHistory() }
}

// 是否有历史内容视图当前已挂载（决定过滤/归档后要不要重拉历史）。
function historyMounted () {
  for (const host of state.hosts) if ((host.__jcView) === 'history') return true
  return false
}

// 打开历史作业详情（只读，走 /api/jobs/history/{id}，不订阅 SSE；写历史独立选中槽）。
async function openHistoryDetail (id) {
  if (!id) return
  state.histSel.selectedId = String(id)
  try {
    state.histSel.detail = await apiJson(`/api/jobs/history/${id}`)
    state.histSel.items = new Map((state.histSel.detail?.progress?.items || []).map((it) => [it.key, it]))
  } catch (e) {
    setMsg(`历史详情加载失败：${e.message}`, 'warn')
  }
  refreshMonitor('history') // 只刷历史内容 + 属性区
}

async function refreshDetail (id) {
  try {
    state.detail = await apiJson(`/api/jobs/${id}`)
    if (state.detail?.progress?.items) {
      state.items = new Map(state.detail.progress.items.map((it) => [it.key, it]))
    }
  } catch (e) {
    setMsg(`详情加载失败：${e.message}`, 'warn')
  }
  refreshMonitor('active') // 详情到手只刷活跃内容 + 属性区
}

// ───────────────────────── SSE 订阅（方案 §6.2）─────────────────────────

function closeEs () {
  if (state.es) { try { state.es.close() } catch (_) {} }
  state.es = null
  state.esJobId = ''
}

// 汇总 SSE：订阅 /api/jobs/events，后端有任何作业变化即主动推 job 摘要事件 → 实时更新列表。
// 这是「服务端推送」的核心——取代定时轮询：提交/状态跃迁/进度/终态/归档 后端都会推。
function subscribeSummary () {
  if (state.summaryEs) return
  const es = new EventSource('/api/jobs/events')
  state.summaryEs = es
  // 断线重连（EventSource 原生自动重连）后，全量拉一次对齐，补回断连期间漏推的变化。
  es.addEventListener('open', () => {
    if (state.summaryReady) loadJobs()  // 首次 open 不重复拉（mount 已 loadJobs）；重连才补拉
    state.summaryReady = true
  })
  es.addEventListener('job', (e) => {
    const j = safeParse(e.data)
    if (!j || !j.id) return
    const id = String(j.id)
    // 移除事件（归档/删除）：从活跃列表删行，若正选中则清详情。
    if (j.removed) {
      const i = state.jobs.findIndex((x) => String(x.id) === id)
      if (i >= 0) state.jobs.splice(i, 1)
      state.throughput.delete(id)
      if (state.selectedId === id) { closeEs(); state.selectedId = ''; state.detail = null; state.items = new Map(); state.logs = [] }
      refreshMonitor('active')
      return
    }
    const idx = state.jobs.findIndex((x) => String(x.id) === id)
    const merged = idx >= 0
      ? { ...state.jobs[idx], ...j, progress: { ...(state.jobs[idx].progress || {}), ...summaryProgress(j) } }
      : { ...j, progress: summaryProgress(j) }
    if (idx >= 0) state.jobs[idx] = merged
    else state.jobs.unshift(merged)
    sampleThroughput(merged) // service 作业：按 done 差分采样，驱动列表吞吐行/火花线
    if (String(j.id) === state.selectedId && state.detail) {
      state.detail.status = j.status
      if (state.detail.progress) Object.assign(state.detail.progress, summaryProgress(j))
    }
    refreshMonitor('active')
  })
}

function summaryProgress (j) {
  return { done: j.done, total: j.total, ok: j.ok, failed: j.failed, percent: j.percent, message: j.message }
}

function openMonitor (id) {
  if (!id) return
  state.selectedId = String(id)
  state.items = new Map()
  state.logs = []
  refreshDetail(id)
  // 只对活跃（非终态）作业订阅实时 SSE。终态作业无实时流——一连上就 done 关流，
  // 若还订阅会触发「连上→done→重渲→再订」的死循环。终态作业详情靠 refreshDetail 一次拉取即可。
  const j = state.jobs.find((x) => String(x.id) === String(id))
  const terminal = j && ['completed', 'failed', 'cancelled'].includes(j.status)
  if (terminal) closeEs()
  else subscribe(id)
  refreshMonitor('active')
}

function subscribe (id) {
  if (state.esJobId === String(id) && state.es) return
  closeEs()
  const es = new EventSource(`/api/jobs/${id}/events`)
  state.es = es
  state.esJobId = String(id)

  es.addEventListener('snapshot', (e) => {
    const d = safeParse(e.data)
    if (!d) return
    if (state.detail) state.detail.status = d.status
    if (d.progress) {
      applyProgress(d.progress)
      if (Array.isArray(d.progress.items)) state.items = new Map(d.progress.items.map((it) => [it.key, it]))
    }
    refreshMonitor('active')
  })
  es.addEventListener('state', (e) => {
    const d = safeParse(e.data)
    if (d && state.detail) { state.detail.status = d.status }
    refreshMonitor('active')
    // 终态：关闭本作业流（无更多实时事件）。列表变化由汇总流推送，无需在此 loadJobs（否则触发循环）。
    if (d && ['completed', 'failed', 'cancelled'].includes(d.status)) { closeEs() }
  })
  es.addEventListener('progress', (e) => {
    const d = safeParse(e.data)
    if (d) applyProgress(d)
    if (state.detail) sampleThroughput(state.detail) // 详情 service 作业：采样驱动仪表
    refreshMonitor('active')
  })
  es.addEventListener('item', (e) => {
    const it = safeParse(e.data)
    if (it && it.key) {
      // 最新的移到末尾（Map 保持插入序）：先删再插，确保 key 复用时也更新顺序。
      state.items.delete(it.key)
      state.items.set(it.key, it)
      // 最近处理只留最近 MAX_ITEMS 条（常驻消费者明细无限增长 → 截断防泄漏）。
      while (state.items.size > MAX_ITEMS) {
        state.items.delete(state.items.keys().next().value) // 删最旧（Map 头部）
      }
    }
    refreshMonitor('active')
  })
  es.addEventListener('log', (e) => {
    const d = safeParse(e.data)
    if (d) { state.logs.push(d); if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS) }
    refreshMonitor('active')
  })
  es.addEventListener('result', (e) => {
    const d = safeParse(e.data)
    if (state.detail) state.detail.result = d
    refreshMonitor('active')
  })
  es.addEventListener('error', (e) => {
    const d = safeParse(e.data)
    if (d && state.detail) state.detail.error = d
    refreshMonitor('active')
  })
  es.addEventListener('done', () => { closeEs() }) // 流终结：仅关流。列表更新靠汇总流推送。
}

function applyProgress (p) {
  if (!state.detail) state.detail = {}
  const prev = state.detail.progress || {}
  if (typeof p.rev === 'number' && typeof prev.rev === 'number' && p.rev < prev.rev) return
  state.detail.progress = { ...prev, ...p }
}

function safeParse (s) { try { return JSON.parse(s) } catch { return null } }

// ───────────────────────── 派生数据 ─────────────────────────

function percentOf (p) {
  if (!p) return 0
  if (typeof p.percent === 'number') return p.percent
  if (p.total > 0) return Math.round((Math.min(p.done, p.total) / p.total) * 100)
  return 0
}

// ───── 吞吐仪表派生（常驻消费者作业方案 §7）─────

// 取某 service 作业的吞吐视图：速率、累计、成功/失败、运行时长、火花线数据。
function throughputOf (j) {
  const p = j.progress || {}
  const s = state.throughput.get(String(j.id))
  const rate = s ? s.rate : 0
  const runMs = j.startedAt ? (Number(j.finishedAt || Date.now()) - Number(j.startedAt)) : 0
  return {
    rate,
    processed: Number(p.done || 0),
    ok: Number(p.ok || 0),
    failed: Number(p.failed || 0),
    runMs,
    idle: p.phase === '空闲等待',
    samples: s ? s.samples : [],
  }
}

// 运行时长人读（2h13m / 45s）。
function fmtRun (ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), h = Math.floor(m / 60)
  if (h > 0) return `${h}h${m % 60}m`
  return `${m}m${s % 60}s`
}

// 速率火花线（inline SVG，随主题变量着色）。samples=[{t,done}] → 每段速率归一化高度。
function sparkline (samples, color) {
  if (!samples || samples.length < 2) return '<span class="spark-empty">—</span>'
  const rates = []
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000
    rates.push(dt > 0 ? Math.max(0, (samples[i].done - samples[i - 1].done) / dt) : 0)
  }
  const max = Math.max(1, ...rates)
  const W = 108, H = 26, n = rates.length
  const step = n > 1 ? W / (n - 1) : W
  const pts = rates.map((r, i) => `${(i * step).toFixed(1)},${(H - (r / max) * (H - 3) - 1).toFixed(1)}`).join(' ')
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`
}

// 过滤 + 排序后的作业列表（活跃优先，其次创建时间倒序）。
function visibleJobs () {
  const kw = state.filterText.trim().toLowerCase()
  return state.jobs
    .filter((j) => !state.filterKind || j.kind === state.filterKind)
    .filter((j) => !state.filterStatus || j.status === state.filterStatus)
    .filter((j) => !kw || `${j.title} ${j.id} ${j.kind} ${nodeOf(j)}`.toLowerCase().includes(kw))
    .slice()
    .sort((a, b) => {
      const oa = STATUS_ORDER.indexOf(a.status); const ob = STATUS_ORDER.indexOf(b.status)
      if (oa !== ob) return oa - ob
      return Number(b.createdAt || 0) - Number(a.createdAt || 0)
    })
}

// 归属节点（M3）：origin.trigger 不含节点，节点在后端 node_id 列——列表 job 摘要暂无，详情有。
// 摘要事件无 node_id，故列表节点从 detail 或 origin 兜底显示。
function nodeOf (j) { return j.nodeId || (j.origin && j.origin.node) || '' }

// 统计概览（按状态计数）。
function stats () {
  const c = { total: state.jobs.length }
  for (const s of STATUS_ORDER) c[s] = 0
  for (const j of state.jobs) if (c[j.status] != null) c[j.status]++
  c.active = (c.running || 0) + (c.paused || 0) + (c.cancelling || 0)
  return c
}

// ───────────────────────── 样式 ─────────────────────────

function styleCss () {
  return `
  /* 主题适配：全部颜色走 UI5 --sap* 主题变量（随 light/dark 自动翻转），深色值作 fallback。
     母版=portal/datasource/cluster-datasource.js。局部再收敛到 --jc-* 便于全表统一引用。 */
  .jc{
    --jc-bg: var(--sapBackgroundColor,#0f1419);
    --jc-card: var(--sapTile_Background,#1a2028);
    --jc-sunken: var(--sapField_Background,#0d1117);
    --jc-border: var(--sapGroup_TitleBorderColor,#2d3742);
    --jc-border-field: var(--sapField_BorderColor,#2d3742);
    --jc-txt: var(--sapTextColor,#e6edf3);
    --jc-dim: var(--sapContent_LabelColor,#8b98a5);
    --jc-accent: var(--sapButton_Emphasized_Background,#3b82c4);
    --jc-accent-bg: var(--sapButton_Emphasized_Background,#2f6fb3);
    --jc-btn: var(--sapButton_Background,#232b35);
    --jc-btn-txt: var(--sapButton_TextColor,#e6edf3);
    --jc-btn-border: var(--sapButton_BorderColor,#2d3742);
    --jc-btn-hover: var(--sapButton_Hover_Background,#2d3742);
    --jc-link: var(--sapLinkColor,#a9c7e8);
    --jc-info: var(--sapInformationColor,#4a90d9);
    --jc-ok: var(--sapPositiveColor,#42a86b);
    --jc-warn: var(--sapCriticalColor,#f0b429);
    --jc-err: var(--sapNegativeColor,#e0857a);
    --jc-cancel: #b072d0;
    font:13px/1.6 var(--sapFontFamily,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
    color:var(--jc-txt);
    padding:3px;box-sizing:border-box;height:100%;
  }
  /* explorer/property：单列长内容——整个区域自身滚动（不外溢到整页）。 */
  .jc{overflow-y:auto;overflow-x:hidden}
  /* content 视图：网格撑满高度不滚，改由左右两列内部各自滚动（活跃/历史列表 + 详情）。 */
  .jc.content-grid{overflow:hidden}
  .jc.content-grid>div{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden}
  .jc.content-grid>div:last-child{overflow-y:auto}
  .jc h4{margin:0 0 10px;font-size:12px;color:var(--jc-dim);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
  .jc .card{background:var(--jc-card);border:1px solid var(--jc-border);border-radius:10px;padding:16px 18px;margin:0 0 16px;
    box-shadow:0 1px 3px rgba(0,0,0,.12);transition:border-color .2s}
  .jc label{display:block;font-size:12px;color:var(--jc-dim);margin:8px 0 3px}
  .jc label.inline{display:flex;align-items:center;gap:6px;margin:8px 0 3px}
  .jc label.inline input{width:auto}
  .jc input,.jc select,.jc textarea{width:100%;box-sizing:border-box;background:var(--jc-sunken);border:1px solid var(--jc-border-field);
    border-radius:6px;color:var(--jc-txt);padding:6px 8px;font:12px/1.5 inherit;transition:border-color .15s,box-shadow .15s}
  .jc input:focus,.jc select:focus,.jc textarea:focus{outline:none;border-color:var(--jc-accent);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--jc-accent) 22%,transparent)}
  .jc textarea{resize:vertical;min-height:44px}
  .jc button{cursor:pointer;border:1px solid var(--jc-btn-border);background:var(--jc-btn);color:var(--jc-btn-txt);border-radius:6px;
    padding:6px 12px;font-size:12px;font-weight:600;margin:0 6px 0 0;transition:background .15s,border-color .15s,transform .06s,box-shadow .15s}
  .jc button:hover{background:var(--jc-btn-hover);border-color:color-mix(in srgb,var(--jc-accent) 45%,var(--jc-btn-border))}
  .jc button:active{transform:translateY(1px)}
  .jc button.primary{background:var(--jc-accent-bg);border-color:var(--jc-accent);color:var(--sapButton_Emphasized_TextColor,#fff)}
  .jc button.primary:hover{background:var(--jc-accent);box-shadow:0 2px 10px color-mix(in srgb,var(--jc-accent) 45%,transparent)}
  .jc button.danger{background:transparent;border-color:var(--jc-err);color:var(--jc-err)}
  .jc button.danger:hover{background:color-mix(in srgb,var(--jc-err) 15%,transparent)}
  .jc button:disabled{opacity:.35;cursor:not-allowed}
  .jc button:disabled:hover{transform:none;box-shadow:none}
  .jc button.mini{padding:3px 8px;font-size:11px;margin:0 4px 0 0}
  .jc .row{display:flex;gap:8px}
  .jc .row>div{flex:1}
  .jc .list{display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 4px 2px 2px}
  .jc .jobrow{position:relative;flex:none;background:var(--jc-card);border:1px solid var(--jc-border);border-radius:9px;padding:12px 14px 12px 16px;cursor:pointer;
    transition:border-color .15s,box-shadow .15s,transform .06s;overflow:hidden}
  .jc .jobrow::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent;transition:background .15s}
  .jc .jobrow:hover{border-color:color-mix(in srgb,var(--jc-accent) 40%,var(--jc-border));box-shadow:0 2px 12px rgba(0,0,0,.14)}
  .jc .jobrow.sel{border-color:var(--jc-accent);box-shadow:0 0 0 1px var(--jc-accent) inset,0 2px 14px color-mix(in srgb,var(--jc-accent) 30%,transparent)}
  .jc .jobrow.sel::before{background:var(--jc-accent)}
  .jc .jobrow .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:2px}
  .jc .jobrow .title{font-weight:600;font-size:13px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;flex:1;min-width:0;
    padding:3px 9px;border-radius:6px;border:1px solid transparent}
  /* 按作业种类给整个标题区上色：淡色底(accent 混入透明,light/dark 皆自适配) + accent 文字 + 同色描边。
     色板用 UI5 Fiori 分类色 --sapAccentColor*（主题自动调对比度），深色 hex 作 fallback。混色比例
     参照本页状态徽标(.st-*)——15% 底在浅底/深底都读得清，文字用满色保证对比。 */
  .jc .jobrow .title.kc-default{color:var(--jc-txt);background:color-mix(in srgb,var(--jc-dim) 12%,transparent);border-color:color-mix(in srgb,var(--jc-dim) 22%,transparent)}
  .jc .jobrow .title.kc-demo{color:var(--sapAccentColor5,#b072d0);background:color-mix(in srgb,var(--sapAccentColor5,#b072d0) 15%,transparent);border-color:color-mix(in srgb,var(--sapAccentColor5,#b072d0) 30%,transparent)}
  .jc .jobrow .title.kc-consumer{color:var(--sapAccentColor8,#4a90d9);background:color-mix(in srgb,var(--sapAccentColor8,#4a90d9) 15%,transparent);border-color:color-mix(in srgb,var(--sapAccentColor8,#4a90d9) 30%,transparent)}
  .jc .jobrow .title.kc-compute{color:var(--sapAccentColor6,#2f9e8f);background:color-mix(in srgb,var(--sapAccentColor6,#2f9e8f) 15%,transparent);border-color:color-mix(in srgb,var(--sapAccentColor6,#2f9e8f) 30%,transparent)}
  .jc .jobrow .title.kc-verify{color:var(--sapAccentColor3,#c77e23);background:color-mix(in srgb,var(--sapAccentColor3,#c77e23) 15%,transparent);border-color:color-mix(in srgb,var(--sapAccentColor3,#c77e23) 30%,transparent)}
  .jc .kind{font-family:"SF Mono",Menlo,monospace;font-size:11px;color:var(--jc-link);opacity:.85;margin-top:3px}
  .jc .bar{height:7px;background:var(--jc-sunken);border-radius:20px;overflow:hidden;margin:10px 0 3px;box-shadow:inset 0 1px 2px rgba(0,0,0,.2)}
  .jc .bar>i{display:block;height:100%;border-radius:20px;background:var(--jc-info);transition:width .35s cubic-bezier(.4,0,.2,1)}
  .jc .bar.run>i{background:linear-gradient(90deg,var(--jc-info),color-mix(in srgb,var(--jc-info) 55%,var(--jc-ok)),var(--jc-info));
    background-size:200% 100%;animation:jcflow 1.6s linear infinite}
  @keyframes jcflow{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .jc .bar.fail>i{background:var(--jc-err)}
  .jc .bar.done>i{background:var(--jc-ok)}
  .jc .bar.pause>i{background:var(--jc-warn)}
  .jc .st{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;font-family:"SF Mono",Menlo,monospace;white-space:nowrap}
  .jc .st::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  .st-run{background:color-mix(in srgb,var(--jc-info) 16%,transparent);color:var(--jc-info)}
  .st-run::before{animation:jcpulse 1.3s ease-in-out infinite}
  @keyframes jcpulse{0%,100%{opacity:1;box-shadow:0 0 0 0 currentColor}50%{opacity:.5;box-shadow:0 0 0 3px transparent}}
  .st-pause{background:color-mix(in srgb,var(--jc-warn) 16%,transparent);color:var(--jc-warn)}
  .st-done{background:color-mix(in srgb,var(--jc-ok) 16%,transparent);color:var(--jc-ok)}
  .st-fail{background:color-mix(in srgb,var(--jc-err) 16%,transparent);color:var(--jc-err)}
  .st-pend{background:color-mix(in srgb,var(--jc-dim) 16%,transparent);color:var(--jc-dim)}
  .st-cancel{background:color-mix(in srgb,var(--jc-cancel) 18%,transparent);color:var(--jc-cancel)}
  .jc .jobrow .top .st{flex:none}
  .jc .meta{font-size:11px;color:var(--jc-dim);margin-top:6px;line-height:1.5}
  /* ── service 常驻消费者：列表吞吐行 ── */
  .jc .jobrow.svc{border-left:2px solid color-mix(in srgb,var(--jc-info) 55%,var(--jc-border))}
  .jc .svc-line{display:flex;align-items:baseline;gap:7px;margin:9px 0 2px;font-size:12px;flex-wrap:wrap}
  .jc .svc-rate{font-family:"SF Mono",Menlo,monospace;font-weight:800;font-size:16px;color:var(--jc-dim);letter-spacing:.3px}
  .jc .svc-rate.live{color:var(--jc-info)}
  .jc .svc-rate em{font-style:normal;font-size:10.5px;font-weight:600;color:var(--jc-dim);margin-left:2px}
  .jc .svc-sep{color:var(--jc-border)}
  .jc .svc-acc{color:var(--jc-txt);font-family:"SF Mono",Menlo,monospace}
  .jc .svc-fail{color:var(--jc-err);font-family:"SF Mono",Menlo,monospace}
  .jc .svc-run{margin-left:auto;color:var(--jc-dim);font-family:"SF Mono",Menlo,monospace;font-size:11px}
  /* ── service 详情吞吐仪表 ── */
  .jc .gauge{background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:10px;padding:14px 16px;margin:2px 0 6px}
  .jc .gauge-main{display:flex;align-items:center;justify-content:space-between;gap:14px}
  .jc .gauge-rate{display:flex;align-items:baseline;gap:6px}
  .jc .gauge-rate .gv{font-family:"SF Mono",Menlo,monospace;font-weight:800;font-size:34px;line-height:1;color:var(--jc-dim);letter-spacing:.5px}
  .jc .gauge-rate.live .gv{color:var(--jc-info)}
  .jc .gauge-rate .gu{font-size:12px;color:var(--jc-dim);font-weight:600}
  .jc .gauge-spark{flex:none}
  .jc .gauge-spark .spark{display:block;opacity:.9}
  .jc .gauge-spark .spark-empty{color:var(--jc-dim);font-family:"SF Mono",Menlo,monospace}
  .jc .gauge-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}
  .jc .gc{text-align:center;padding:8px 4px;background:var(--jc-card);border:1px solid var(--jc-border);border-radius:8px}
  .jc .gc-n{font-family:"SF Mono",Menlo,monospace;font-weight:700;font-size:17px;color:var(--jc-txt);line-height:1.1}
  .jc .gc-n.ok{color:var(--jc-ok)}.jc .gc-n.fail{color:var(--jc-err)}
  .jc .gc-l{font-size:10.5px;color:var(--jc-dim);margin-top:4px}
  .jc .svc-hint{font-size:11.5px;color:var(--jc-info);background:color-mix(in srgb,var(--jc-info) 10%,transparent);border:1px solid color-mix(in srgb,var(--jc-info) 30%,var(--jc-border));border-radius:6px;padding:7px 10px;margin:8px 0}
  .jc .tags{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:8px}
  .jc .tag{font-size:10.5px;font-family:"SF Mono",Menlo,monospace;background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:20px;padding:2px 9px;color:var(--jc-dim)}
  .jc .tags .arch-slot{margin-left:auto}
  .jc .tag.node{color:var(--jc-info)}.jc .tag.prio{color:var(--jc-warn)}
  .jc .ctrlbar{display:flex;gap:8px;margin:12px 0 2px;flex-wrap:wrap}
  .jc .monitor .big{font-size:16px;font-weight:600;margin:0 0 6px;line-height:1.4}
  .jc .phase{font-size:12px;color:var(--jc-dim);margin:4px 0 8px}
  .jc .items{max-height:300px;overflow:auto;border:1px solid var(--jc-border);border-radius:8px;background:var(--jc-sunken)}
  .jc .items .it{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--jc-border);font-size:12px}
  .jc .items .it:last-child{border-bottom:none}
  .jc .it .ic{width:16px;text-align:center;font-weight:700}
  .it-ok .ic{color:var(--jc-ok)}.it-failed .ic{color:var(--jc-err)}.it-running .ic{color:var(--jc-info)}
  .it-queued .ic{color:var(--jc-dim)}.it-skipped .ic{color:var(--jc-cancel)}
  .jc .it .k{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .jc .it .d{color:var(--jc-dim);font-family:"SF Mono",Menlo,monospace;font-size:11px}
  .jc .logs{max-height:200px;overflow:auto;background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:8px;
    padding:8px 10px;font-family:"SF Mono",Menlo,monospace;font-size:11.5px;line-height:1.5}
  .jc .logs .lg{white-space:pre-wrap}
  .jc .logs .INFO{color:var(--jc-txt)}.jc .logs .WARN{color:var(--jc-warn)}.jc .logs .ERROR{color:var(--jc-err)}
  .jc .empty{color:var(--jc-dim);padding:20px;text-align:center}
  .jc .msg{font-size:12px;margin:6px 0;min-height:16px}
  .jc .msg.info{color:var(--jc-info)}.jc .msg.ok{color:var(--jc-ok)}.jc .msg.warn{color:var(--jc-err)}
  .jc pre.j{background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:6px;padding:8px 10px;overflow:auto;
    font-family:"SF Mono",Menlo,monospace;font-size:11px;color:var(--jc-link);max-height:240px}
  .jc .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:6px}
  .jc .stat{position:relative;background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:8px;padding:12px 8px;text-align:center;cursor:pointer;
    transition:border-color .15s,transform .08s,box-shadow .15s;overflow:hidden}
  .jc .stat::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:transparent;transition:background .15s}
  .jc .stat:hover{border-color:color-mix(in srgb,var(--jc-accent) 50%,var(--jc-border));transform:translateY(-1px);box-shadow:0 3px 12px rgba(0,0,0,.16)}
  .jc .stat.on{border-color:var(--jc-accent);box-shadow:0 0 0 1px var(--jc-accent) inset}
  .jc .stat.on::after{background:var(--jc-accent)}
  .jc .stat .n{font-size:20px;font-weight:800;letter-spacing:.5px;font-family:"SF Mono",Menlo,monospace;line-height:1.2}
  .jc .stat .l{font-size:11px;color:var(--jc-dim);margin-top:4px}
  .jc .stat .n.st-run{background:none;color:var(--jc-info)}.jc .stat .n.st-pause{background:none;color:var(--jc-warn)}
  .jc .stat .n.st-done{background:none;color:var(--jc-ok)}.jc .stat .n.st-fail{background:none;color:var(--jc-err)}
  .jc .stat .n.st-pend{background:none;color:var(--jc-dim)}.jc .stat .n.st-cancel{background:none;color:var(--jc-cancel)}
  .jc .kv{display:grid;grid-template-columns:80px 1fr;gap:5px 10px;font-size:12px}
  .jc .kv .k{color:var(--jc-dim)}
  .jc .kv .v{color:var(--jc-txt);word-break:break-all}
  .jc .tabs{display:flex;gap:4px;margin-bottom:10px}
  .jc .tab{flex:1;padding:7px 10px;font-size:12px;font-weight:600;background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:7px;color:var(--jc-dim);cursor:pointer;margin:0;transition:all .15s}
  .jc .tab:hover{color:var(--jc-txt);border-color:color-mix(in srgb,var(--jc-accent) 40%,var(--jc-border))}
  .jc .tab.on{background:var(--jc-accent-bg);border-color:var(--jc-accent);color:var(--sapButton_Emphasized_TextColor,#fff);box-shadow:0 2px 10px color-mix(in srgb,var(--jc-accent) 35%,transparent)}
  .jc .arch-note{font-size:11px;color:var(--jc-dim);margin:6px 0;padding:6px 8px;background:var(--jc-sunken);border:1px solid var(--jc-border);border-radius:6px}
  .jc .listhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
  .jc .listhead h4{margin:0}
  .jc .pager{display:flex;align-items:center;gap:3px;flex-wrap:nowrap}
  .jc .pager .pg{padding:2px 7px;margin:0;font-size:12px;min-width:26px;line-height:1.4}
  .jc .pager .pg-info{font-size:11px;color:var(--jc-dim);padding:0 4px;white-space:nowrap}
  .jc .pager select{width:auto;padding:2px 4px;font-size:11px}
  `
}

// ───────────────────────── 片段渲染 ─────────────────────────

function statusBadge (status) {
  const m = STATUS_META[status] || { label: status, cls: 'st-pend' }
  return `<span class="st ${m.cls}">${esc(m.label)}</span>`
}

function barClass (status) {
  if (status === 'failed') return 'fail'
  if (status === 'completed') return 'done'
  if (status === 'paused' || status === 'cancelling') return 'pause'
  if (status === 'running') return 'run'
  return ''
}

function ctrlButtons (j, mini, withDelete = true) {
  const cls = mini ? ' class="mini"' : ''
  const canPause = j.status === 'running'
  const canResume = j.status === 'paused'
  const canCancel = ['pending', 'running', 'paused'].includes(j.status)
  const canRestart = ['failed', 'cancelled'].includes(j.status)
  const canDelete = ['completed', 'failed', 'cancelled'].includes(j.status)
  let h = ''
  if (canPause) h += `<button${cls} data-act="pause" data-id="${esc(j.id)}">暂停</button>`
  if (canResume) h += `<button${cls} data-act="resume" data-id="${esc(j.id)}">恢复</button>`
  if (canCancel) h += `<button${cls} data-act="cancel" data-id="${esc(j.id)}">停止</button>`
  if (canRestart) h += `<button${cls} data-act="restart" data-id="${esc(j.id)}">重启</button>`
  if (withDelete && canDelete) h += `<button${cls} class="${mini ? 'mini danger' : 'danger'}" data-del="${esc(j.id)}">归档</button>`
  return h
}

function jobRowHtml (j) {
  const p = j.progress || {}
  const pct = percentOf(p)
  const sel = String(j.id) === state.selectedId ? ' sel' : ''
  const node = nodeOf(j)
  const prio = Number(j.priority || 0)
  const canDelete = ['completed', 'failed', 'cancelled'].includes(j.status)
  // 归档按钮不单独占行：放进 tags 行靠右（margin-left:auto）。其余控制按钮留在 ctrlbar。
  const archBtn = canDelete ? `<button class="mini danger arch" data-del="${esc(j.id)}">归档</button>` : ''
  const ctrl = ctrlButtons(j, true, /*withDelete*/ false)
  // service（常驻消费者）：用吞吐行代替百分比进度条（方案 §7）。
  const svc = isService(j)
  let body
  if (svc) {
    const t = throughputOf(j)
    const live = j.status === 'running' && !t.idle
    body = `<div class="svc-line">
      <span class="svc-rate ${live ? 'live' : ''}">${t.idle ? '空闲' : t.rate} <em>${t.idle ? '' : 'msg/s'}</em></span>
      <span class="svc-sep">·</span>
      <span class="svc-acc">累计 ${t.processed.toLocaleString()}</span>
      ${t.failed ? `<span class="svc-fail">✖${t.failed}</span>` : ''}
      ${j.startedAt ? `<span class="svc-run">${fmtRun(t.runMs)}</span>` : ''}
    </div>`
  } else {
    body = `<div class="bar ${barClass(j.status)}"><i style="width:${pct}%"></i></div>
    <div class="meta">${pct}% · ${p.done || 0}/${p.total || 0} ${p.ok ? `✔${p.ok}` : ''} ${p.failed ? `✖${p.failed}` : ''} ${esc(p.message || '')}</div>`
  }
  return `<div class="jobrow${sel}${svc ? ' svc' : ''}" data-job="${esc(j.id)}">
    <div class="top">
      <span class="title ${kindColorClass(j.kind)}">${esc(j.title)}</span>
      ${statusBadge(j.status)}
    </div>
    <div class="kind">${svc ? '◆ ' : ''}${esc(j.kind)} · #${esc(j.id)}</div>
    ${body}
    <div class="tags">
      ${node ? `<span class="tag node">▣ ${esc(node)}</span>` : ''}
      ${prio !== 0 ? `<span class="tag prio">优先级 ${prio}</span>` : ''}
      <span class="tag">${esc(fmtTime(j.createdAt))}</span>
      ${archBtn ? `<span class="arch-slot" data-stop>${archBtn}</span>` : ''}
    </div>
    ${ctrl ? `<div class="ctrlbar" data-stop>${ctrl}</div>` : ''}
  </div>`
}

function monitorHtml (mode) {
  const isHist = mode === 'history'
  // 按 mode 取各自选中槽（活跃=state.selectedId/detail/items/logs；历史=state.histSel）。
  const d = isHist ? state.histSel.detail : state.detail
  const selId = isHist ? state.histSel.selectedId : state.selectedId
  if (!d || !selId) return `<cmx-empty-state icon="detail-view" title="${isHist ? '点击左侧历史作业查看详情' : '点击左侧作业查看实时监控'}" size="sm"></cmx-empty-state>`
  // 活跃视图：选中作业被当前过滤排除时，不显示旧详情。
  if (!isHist && !visibleJobs().some((j) => String(j.id) === selId)) {
    return `<cmx-empty-state icon="filter" title="当前过滤下无选中作业" size="sm"></cmx-empty-state>`
  }
  const p = d.progress || {}
  const pct = percentOf(p)
  const canPause = d.status === 'running'
  const canResume = d.status === 'paused'
  const canCancel = ['pending', 'running', 'paused'].includes(d.status)
  const canRestart = ['failed', 'cancelled'].includes(d.status)
  const canDelete = ['completed', 'failed', 'cancelled'].includes(d.status)
  // 明细流：service 常驻消费者按「最新在前」展示最近 MAX_ITEMS 条（截最近，不显示最早）。
  // 批处理仍按处理顺序（旧→新）展示。
  const svcDetail = isService(d)
  const rawItems = Array.from((isHist ? state.histSel.items : state.items).values())
  const items = svcDetail ? rawItems.slice(-MAX_ITEMS).reverse() : rawItems
  const itemsHtml = items.length
    ? items.map((it) => {
        const m = ITEM_META[it.state] || ITEM_META.queued
        return `<div class="it ${m.cls}"><span class="ic">${m.icon}</span><span class="k">${esc(it.label || it.key)}</span><span class="d">${esc(it.detail || '')}</span></div>`
      }).join('')
    : `<cmx-empty-state icon="list" title="暂无明细" size="sm"></cmx-empty-state>`
  const logsHtml = (!isHist && state.logs.length)
    ? state.logs.map((l) => `<div class="lg ${esc(l.level)}">[${esc(l.level)}] ${esc(l.text)}</div>`).join('')
    : `<cmx-empty-state icon="message-information" title="暂无日志" size="sm"></cmx-empty-state>`
  const eta = p.etaMs ? ` · 预计剩余 ${Math.ceil(p.etaMs / 1000)}s` : ''
  const ctrl = isHist
    ? `<div class="arch-note">📁 该作业已归档（历史只读）。归档于 ${esc(fmtTime(d.archivedAt))}</div>`
    : `<div class="ctrlbar" data-stop>
      <button class="primary" data-act="pause" data-id="${esc(d.id)}" ${canPause ? '' : 'disabled'}>⏸ 暂停</button>
      <button data-act="resume" data-id="${esc(d.id)}" ${canResume ? '' : 'disabled'}>▶ 恢复</button>
      <button data-act="cancel" data-id="${esc(d.id)}" ${canCancel ? '' : 'disabled'}>⏹ 停止</button>
      <button data-act="restart" data-id="${esc(d.id)}" ${canRestart ? '' : 'disabled'}>↻ 重启</button>
      <button class="danger" data-del="${esc(d.id)}" ${canDelete ? '' : 'disabled'}>🗄 归档</button>
    </div>`
  return `<div class="monitor">
    <div class="big">${esc(d.title || '')} ${statusBadge(d.status)}</div>
    <div class="phase">${p.phaseTotal ? `阶段 ${p.phaseIndex}/${p.phaseTotal} · ${esc(p.phase || '')}` : esc(p.phase || '')} — ${esc(p.message || '')}</div>
    ${isService(d) ? gaugeHtml(d) : `<div class="bar ${barClass(d.status)}"><i style="width:${pct}%"></i></div>
    <div class="meta">${pct}% · ${p.done || 0}/${p.total || 0}${p.ok ? ` · 成功 ${p.ok}` : ''}${p.failed ? ` · 失败 ${p.failed}` : ''}${eta}</div>`}
    ${ctrl}
    <h4>${isService(d) ? '最近处理' : '明细流'} (${items.length})</h4>
    <div class="items">${itemsHtml}</div>
    <h4 style="margin-top:12px">${isHist ? '日志' : '实时日志'} (${isHist ? 0 : state.logs.length})</h4>
    <div class="logs">${logsHtml}</div>
  </div>`
}

// 吞吐仪表面板（service 作业详情，替代百分比进度条）。方案 §7。
function gaugeHtml (d) {
  const t = throughputOf(d)
  const live = d.status === 'running' && !t.idle
  const accent = 'var(--jc-info)'
  return `<div class="gauge">
    <div class="gauge-main">
      <div class="gauge-rate ${live ? 'live' : ''}">
        <span class="gv">${t.idle ? '—' : t.rate}</span><span class="gu">${t.idle ? '空闲等待' : 'msg/s'}</span>
      </div>
      <div class="gauge-spark">${sparkline(t.samples, live ? '#8fc0ef' : 'var(--sapInformationElementColor, #8b98a5)')}</div>
    </div>
    <div class="gauge-grid">
      <div class="gc"><div class="gc-n">${t.processed.toLocaleString()}</div><div class="gc-l">累计处理</div></div>
      <div class="gc"><div class="gc-n ok">${t.ok.toLocaleString()}</div><div class="gc-l">成功</div></div>
      <div class="gc"><div class="gc-n ${t.failed ? 'fail' : ''}">${t.failed}</div><div class="gc-l">失败/死信</div></div>
      <div class="gc"><div class="gc-n">${d.startedAt ? fmtRun(t.runMs) : '—'}</div><div class="gc-l">运行时长</div></div>
    </div>
  </div>`
}

function explorerHtml () {
  const f = state.form
  const c = stats()
  const known = ['job.demo', 'job.consumer', 'rpt.compute', 'rpt.verify']
  const kindOpts = known.concat(state.kinds.filter((k) => !known.includes(k)))
  const isDemo = f.kind === 'job.demo'
  const isConsumer = f.kind === 'job.consumer'
  const isRpt = f.kind === 'rpt.compute' || f.kind === 'rpt.verify'
  const isRaw = !isDemo && !isConsumer && !isRpt
  const statBox = (key, label) => `<div class="stat ${state.filterStatus === key ? 'on' : ''}" data-statf="${key}"><div class="n ${STATUS_META[key] ? STATUS_META[key].cls.replace('st-', 'st-') : ''}">${c[key] || 0}</div><div class="l">${label}</div></div>`
  return `<div class="jc">
    <div class="card">
      <h4>集群概览</h4>
      <div class="stats">
        <div class="stat ${!state.filterStatus ? 'on' : ''}" data-statf=""><div class="n">${c.total}</div><div class="l">全部</div></div>
        ${statBox('running', '运行中')}
        ${statBox('pending', '排队中')}
        ${statBox('paused', '已暂停')}
        ${statBox('completed', '已完成')}
        ${statBox('failed', '已失败')}
        ${statBox('cancelled', '已停止')}
        ${c.cancelling ? statBox('cancelling', '停止中') : ''}
      </div>
      <div class="meta">活跃作业 ${c.active} · 已注册种类 ${state.kinds.length}</div>
    </div>
    <div class="card">
      <h4>新建作业</h4>
      <label>作业种类</label>
      <select data-f="kind">${kindOpts.map((k) => `<option value="${esc(k)}" ${f.kind === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}</select>
      ${isDemo ? `
        <div class="row">
          <div><label>步数</label><input data-f="demoSteps" type="number" value="${esc(f.demoSteps)}"></div>
          <div><label>每步毫秒</label><input data-f="demoStepMs" type="number" value="${esc(f.demoStepMs)}"></div>
        </div>
        <label>失败于第几步（留空不失败）</label><input data-f="demoFailAt" type="number" value="${esc(f.demoFailAt)}">
        <label class="inline"><input data-f="demoFailWhole" type="checkbox" ${f.demoFailWhole ? 'checked' : ''}> 整体失败（触发失败告警）</label>
      ` : ''}
      ${isConsumer ? `
        <div class="svc-hint">◆ 常驻消费者：启动后持续消费直至手动关闭（单例，进度显示为吞吐仪表）</div>
        <div class="row">
          <div><label>每批间隔 ms</label><input data-f="conBatchMs" type="number" value="${esc(f.conBatchMs)}"></div>
          <div><label>每批条数</label><input data-f="conBatchSize" type="number" value="${esc(f.conBatchSize)}"></div>
        </div>
        <label>业务键 businessKey（区分同种类多个消费者，留空=default）</label><input data-f="conBusinessKey" value="${esc(f.conBusinessKey)}" placeholder="如 orders / payments">
        <label>每隔几轮模拟一次空闲（0=不模拟）</label><input data-f="conEmptyEvery" type="number" value="${esc(f.conEmptyEvery)}">
      ` : ''}
      ${isRpt ? `
        <div class="row">
          <div><label>组织机构 orgCode *</label><input data-f="rptOrg" value="${esc(f.rptOrg)}" placeholder="如 HQ"></div>
          <div><label>会计期间 periodCode *</label><input data-f="rptPeriod" value="${esc(f.rptPeriod)}" placeholder="如 2026-07"></div>
        </div>
        <label>版本（留空=当前默认）</label><input data-f="rptVersion" value="${esc(f.rptVersion)}">
        <label>报表 code（逗号分隔，留空=全部启用报表）</label><textarea data-f="rptCodes" placeholder="BS,IS,CF">${esc(f.rptCodes)}</textarea>
      ` : ''}
      ${isRaw ? `<label>原始入参 JSON</label><textarea data-f="rawParams">${esc(f.rawParams)}</textarea>` : ''}
      <label>优先级（越大越先被抢占执行，默认 0）</label><input data-f="priority" type="number" value="${esc(f.priority)}">
      <div style="margin-top:10px"><button class="primary" data-submit>提交作业</button></div>
      <div class="msg ${state.msgKind}">${esc(state.message)}</div>
    </div>
    <div class="card">
      <h4>过滤器</h4>
      <label>种类</label>
      <select data-filter-kind><option value="">全部种类</option>${state.kinds.map((k) => `<option value="${esc(k)}" ${state.filterKind === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}</select>
      <label>状态</label>
      <select data-filter-status><option value="">全部状态</option>${STATUS_ORDER.map((s) => `<option value="${esc(s)}" ${state.filterStatus === s ? 'selected' : ''}>${esc(STATUS_META[s].label)}</option>`).join('')}</select>
      <label>关键字（标题/id/节点）</label>
      <input data-filter-text value="${esc(state.filterText)}" placeholder="搜索…">
      <div style="margin-top:8px"><button data-refresh>刷新列表</button></div>
    </div>
  </div>`
}

function historyRowHtml (j) {
  const p = j.progress || {}
  const pct = percentOf(p)
  const sel = String(j.id) === state.histSel.selectedId ? ' sel' : ''
  return `<div class="jobrow${sel}" data-hist="${esc(j.id)}">
    <div class="top">
      <span class="title ${kindColorClass(j.kind)}">${esc(j.title)}</span>
      ${statusBadge(j.status)}
    </div>
    <div class="kind">${esc(j.kind)} · #${esc(j.id)}</div>
    <div class="bar ${barClass(j.status)}"><i style="width:${pct}%"></i></div>
    <div class="meta">${pct}% · ${p.done || 0}/${p.total || 0} ${p.ok ? `✔${p.ok}` : ''} ${p.failed ? `✖${p.failed}` : ''}</div>
    <div class="tags"><span class="tag">创建 ${esc(fmtTime(j.createdAt))}</span></div>
  </div>`
}

// 历史分页控件（首页/上一页/页码/下一页/末页 + 每页条数）。靠右放在标题行。
function historyPagerHtml () {
  const page = state.historyPage
  const pages = Math.max(1, state.historyTotalPages)
  const sizeOpts = [10, 20, 50, 100]
    .map((n) => `<option value="${n}" ${state.historyPageSize === n ? 'selected' : ''}>${n}/页</option>`).join('')
  return `<div class="pager">
    <button class="pg" data-page="1" ${page <= 1 ? 'disabled' : ''}>«</button>
    <button class="pg" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>
    <span class="pg-info">${page} / ${pages}</span>
    <button class="pg" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>›</button>
    <button class="pg" data-page="${pages}" ${page >= pages ? 'disabled' : ''}>»</button>
    <select data-page-size>${sizeOpts}</select>
  </div>`
}

function contentHtml (mode) {
  const isHist = mode === 'history'
  // 不再写全局 state.tab（两 host 同时渲染会互相覆盖 → 选中态振荡闪动）。mode 显式下传。
  let listHtml
  let head
  let headExtra = ''
  if (isHist) {
    autoSelectFirst('history') // 历史列表非空且未选 → 默认选第一个
    const rows = state.history.length
      ? state.history.map(historyRowHtml).join('')
      : `<cmx-empty-state icon="history" title="${state.historyLoading ? '加载中…' : '暂无历史作业（归档后转入此处）'}" size="sm"></cmx-empty-state>`
    head = `历史作业 · 已归档 (${state.historyTotal || 0} 条)`
    listHtml = rows
    headExtra = historyPagerHtml() // 靠右对齐放在标题行
  } else {
    autoSelectFirst('active') // 活跃列表非空且未选 → 默认选第一个
    const vis = visibleJobs()
    const rows = vis.length
      ? vis.map(jobRowHtml).join('')
      : `<cmx-empty-state icon="search" title="${state.listLoading ? '加载中…' : '无匹配作业'}" size="sm"></cmx-empty-state>`
    head = `活跃作业 · 实时 (${vis.length}/${state.jobs.length})`
    listHtml = rows
  }
  return `<div class="jc content-grid" style="display:grid;grid-template-columns:minmax(300px,1fr) minmax(340px,1.25fr);gap:20px;align-items:stretch">
    <div>
      <div class="listhead"><h4>${head}</h4>${headExtra}</div>
      <div class="list">${listHtml}</div>
    </div>
    <div>
      <h4>${isHist ? '历史详情（只读）' : '监控详情'}</h4>
      ${monitorHtml(mode)}
    </div>
  </div>`
}

// 列表非空且当前未选中（或选中项已不在列表）时，默认选中第一个作业并打开其详情。
// 活跃/历史各用独立选中槽，互不干扰（否则两 host 交替渲染会来回改选中造成闪动）。
function autoSelectFirst (mode) {
  if (mode === 'history') {
    if (!state.history.length) return
    const cur = state.histSel.selectedId
    const inList = cur && state.history.some((j) => String(j.id) === cur)
    if (!inList) {
      queueAutoSelect('history', () => openHistoryDetail(String(state.history[0].id)))
    }
  } else {
    const vis = visibleJobs()
    if (!vis.length) return
    const cur = state.selectedId
    const inList = cur && vis.some((j) => String(j.id) === cur)
    if (!inList) {
      queueAutoSelect('active', () => openMonitor(String(vis[0].id)))
    }
  }
}

// 把自动选中推迟到当前渲染栈之外，避免"渲染中改状态又触发渲染"的重入。按 mode 各自去重。
const _autoSelPending = { active: false, history: false }
function queueAutoSelect (mode, fn) {
  if (_autoSelPending[mode]) return
  _autoSelPending[mode] = true
  setTimeout(() => { _autoSelPending[mode] = false; fn() }, 0)
}

function propertyHtml () {
  // 属性区无 mode：优先展示活跃选中，回落历史选中。
  const d = state.detail || state.histSel.detail
  if (!d) return `<div class="jc"><cmx-empty-state icon="detail-view" title="未选中作业" size="sm"></cmx-empty-state></div>`
  const p = d.progress || {}
  const origin = d.origin || {}
  const originText = origin.kind === 'frontend'
    ? `前端${origin.user ? ' · ' + origin.user : ''}`
    : `后端${origin.trigger ? ' · ' + origin.trigger : ''}`
  return `<div class="jc">
    <div class="card"><h4>作业属性</h4>
      <div class="kv">
        <span class="k">id</span><span class="v">#${esc(d.id)}</span>
        <span class="k">种类</span><span class="v">${esc(kindLabel(d.kind))}</span>
        <span class="k">状态</span><span class="v">${statusBadge(d.status)}</span>
        <span class="k">来源</span><span class="v">${esc(originText)}</span>
        <span class="k">归属节点</span><span class="v">${esc(nodeOf(d) || '（本地/未分配）')}</span>
        <span class="k">优先级</span><span class="v">${esc(d.priority || 0)}</span>
        <span class="k">进度</span><span class="v">${percentOf(p)}% · ${p.done || 0}/${p.total || 0}（成功 ${p.ok || 0} / 失败 ${p.failed || 0}）</span>
      </div>
    </div>
    <div class="card"><h4>时间线</h4>
      <div class="kv">
        <span class="k">创建</span><span class="v">${esc(fmtTime(d.createdAt))}</span>
        <span class="k">开始</span><span class="v">${esc(fmtTime(d.startedAt))}</span>
        <span class="k">结束</span><span class="v">${esc(fmtTime(d.finishedAt))}</span>
        <span class="k">耗时</span><span class="v">${esc(fmtDur(d.startedAt, d.finishedAt))}</span>
        ${d.archivedAt ? `<span class="k">归档</span><span class="v">${esc(fmtTime(d.archivedAt))}</span>` : ''}
      </div>
    </div>
    <div class="card"><h4>入参</h4><pre class="j">${esc(JSON.stringify(d.params ?? {}, null, 2))}</pre></div>
    ${d.result ? `<div class="card"><h4>结果</h4><pre class="j">${esc(JSON.stringify(d.result, null, 2))}</pre></div>` : ''}
    ${d.error ? `<div class="card"><h4>错误</h4><pre class="j">${esc(JSON.stringify(d.error, null, 2))}</pre></div>` : ''}
  </div>`
}

function viewHtml (view) {
  if (view === 'explorer') return explorerHtml()
  if (view === 'property') return propertyHtml()
  // active / history / content(兼容旧) 均走 contentHtml，按 view 定 mode。
  const mode = view === 'history' ? 'history' : 'active'
  return contentHtml(mode)
}

// ───────────────────────── 事件绑定 & 挂载 ─────────────────────────

function bind (root, view) {
  if (view === 'explorer') {
    root.querySelectorAll('[data-f]').forEach((el) => {
      const key = el.getAttribute('data-f')
      const isCheck = el.type === 'checkbox'
      const evt = (el.tagName === 'SELECT' || isCheck) ? 'change' : 'input'
      el.addEventListener(evt, () => {
        state.form[key] = isCheck ? el.checked : el.value
        if (key === 'kind') refreshView('explorer')
      })
    })
    root.querySelector('[data-submit]')?.addEventListener('click', submitJob)
    root.querySelector('[data-filter-kind]')?.addEventListener('change', (e) => { state.filterKind = e.target.value; reloadCurrent() })
    root.querySelector('[data-filter-status]')?.addEventListener('change', (e) => { state.filterStatus = e.target.value; reloadCurrent() })
    root.querySelector('[data-filter-text]')?.addEventListener('input', (e) => { state.filterText = e.target.value; refreshMonitor('active') })
    root.querySelector('[data-refresh]')?.addEventListener('click', reloadCurrent)
    root.querySelectorAll('[data-statf]').forEach((el) => el.addEventListener('click', () => {
      state.filterStatus = el.getAttribute('data-statf'); reloadCurrent()
    }))
  } else if (view === 'active' || view === 'history' || view === 'content') {
    // 活跃作业行点击 → 实时监控
    root.querySelectorAll('.jobrow[data-job]').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-stop]')) return
      openMonitor(el.getAttribute('data-job'))
    }))
    // 历史作业行点击 → 只读详情
    root.querySelectorAll('.jobrow[data-hist]').forEach((el) => el.addEventListener('click', () => {
      openHistoryDetail(el.getAttribute('data-hist'))
    }))
    // 分页控件
    root.querySelectorAll('[data-page]').forEach((el) => el.addEventListener('click', () => {
      gotoHistoryPage(Number(el.getAttribute('data-page')))
    }))
    root.querySelector('[data-page-size]')?.addEventListener('change', (e) => {
      state.historyPageSize = Number(e.target.value) || 20
      state.historyPage = 1
      loadHistory()
    })
    bindActions(root)
  } else if (view === 'property') {
    bindActions(root)
  }
}

function bindActions (root) {
  root.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    control(btn.getAttribute('data-id'), btn.getAttribute('data-act'))
  }))
  root.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    archiveJob(btn.getAttribute('data-del'))
  }))
}

function hostRoot (host) {
  return host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root') || host?.shadowRoot || null
}

function renderInto (host, view) {
  const root = hostRoot(host)
  if (!root || !root.isConnected) return
  // 保留列表滚动位置：整块 innerHTML 重渲会把 .list 滚回顶部（bug：点 item 列表跳顶）。
  const prevList = root.querySelector('.list')
  const savedTop = prevList ? prevList.scrollTop : 0
  // 保留表单输入焦点：explorer 定时/事件重渲会打断正在输入的表单（bug：所有区域刷新致失焦）。
  const active = root.activeElement || (root.getRootNode && root.getRootNode().activeElement)
  let focusKey = null; let selStart = null; let selEnd = null
  if (active && active.hasAttribute && active.hasAttribute('data-f')) {
    focusKey = active.getAttribute('data-f')
    try { selStart = active.selectionStart; selEnd = active.selectionEnd } catch (_) {}
  }
  root.innerHTML = `<style>${styleCss()}</style>${viewHtml(view)}`
  bind(root, view)
  const newList = root.querySelector('.list')
  if (newList && savedTop) newList.scrollTop = savedTop
  // 恢复焦点（同 data-f 的输入框）。
  if (focusKey) {
    const el = root.querySelector(`[data-f="${focusKey}"]`)
    if (el) {
      el.focus()
      if (selStart != null) { try { el.setSelectionRange(selStart, selEnd) } catch (_) {} }
    }
  }
}

function refreshAll () {
  for (const host of Array.from(state.hosts)) {
    if (!host || !host.isConnected) { state.hosts.delete(host); continue }
    renderInto(host, host.__jcView || 'content')
  }
  // 页面已全部关闭：借任意刷新时机彻底停摆（比 30s 轮询看门狗更快释放 SSE/定时器）。
  if (state.hosts.size === 0 && (state.liveTimer || state.summaryEs || state.es)) teardown()
}

function refreshView (which) {
  for (const host of Array.from(state.hosts)) {
    if ((host.__jcView || 'content') === which) renderInto(host, which)
  }
}

// 只重渲监控相关视图（active/history/content/property），避免打断 explorer 表单输入焦点。
// 重渲监控相关视图。onlyMode 指定时只刷该内容模式 host（+property），避免选活跃时连带刷历史内容。
// 不传则刷全部内容/属性区。永不刷 explorer（保表单焦点）。
function refreshMonitor (onlyMode) {
  for (const host of Array.from(state.hosts)) {
    if (!host || !host.isConnected) { state.hosts.delete(host); continue }
    const v = host.__jcView || 'active'
    if (v === 'property') { renderInto(host, v); continue }
    const isContent = v === 'active' || v === 'history' || v === 'content'
    if (!isContent) continue
    if (onlyMode) {
      const hostMode = v === 'history' ? 'history' : 'active'
      if (hostMode !== onlyMode) continue
    }
    renderInto(host, v)
  }
  // 页面已全部关闭：借 SSE 事件驱动的刷新时机尽快停摆（关页后下一个事件即释放）。
  if (state.hosts.size === 0 && (state.liveTimer || state.summaryEs || state.es)) teardown()
}

function mount (ctx, view) {
  const host = ctx.host
  state.hosts.add(host)
  if (host) host.__jcView = view
  requestAnimationFrame(() => renderInto(host, view))
  if (!state.liveTimer) {
    loadJobs()          // 首帧全量快照（一次性，非轮询）
    subscribeSummary()  // 之后全靠汇总 SSE 推送更新，不再定时拉取
    // 存活看门狗：只剔除已关闭 host + 停摆，绝不拉数据（数据靠推送）。空闲时 SSE 不发事件，
    // 故仍需一个低频 tick 兜底检测「页面已关」以释放 SSE/定时器；60s 足够，且不打后端。
    state.liveTimer = setInterval(() => {
      pruneHosts()
      if (state.hosts.size === 0) teardown()
    }, 60000)
  }
  // 历史视图挂载时拉取历史数据（首次进入即有内容 + 默认选中第一个）。
  if (view === 'history') loadHistory()
  return `<style>${styleCss()}</style>${viewHtml(view)}`
}

// 剔除已从 DOM 卸载的 host（切走/关闭工作台后其 shadow root isConnected=false）。
function pruneHosts () {
  for (const h of Array.from(state.hosts)) {
    if (!h || !h.isConnected) state.hosts.delete(h)
  }
}

// 页面全部关闭时的彻底停摆：停看门狗定时器 + 关闭汇总流与单作业流，清空运行态。
function teardown () {
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null }
  state.summaryReady = false
  if (state.summaryEs) { try { state.summaryEs.close() } catch (_) {} state.summaryEs = null }
  closeEs()
  state.selectedId = ''
  state.detail = null
  state.items = new Map()
  state.logs = []
}

export default {
  defaultView: 'active',
  views: {
    async explorer (ctx) { return mount(ctx, 'explorer') },
    async active (ctx) { return mount(ctx, 'active') },
    async history (ctx) { return mount(ctx, 'history') },
    async content (ctx) { return mount(ctx, 'active') }, // 兼容旧 view 名，等同活跃
    async property (ctx) { return mount(ctx, 'property') },
  },
}
