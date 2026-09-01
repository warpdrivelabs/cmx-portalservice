// 通知中心 native_pages 页面：单 content 视图，按 props.center 展示 任务/消息/日志 通知列表。
// 支持：列表(未读高亮 + 已读/未读状态标签)、点击单条标记已读 + link 跳转(node:/menu: →
// portal-help-action，https → window.open)、type/level 筛选、仅看未读、cmx-pager 页码分页
// (offset 模式，每页 20/50/100)、全部已读(后端广播 counts，shellbar 铃铛联动刷新)；
// 未读角标取 /api/notifications/counts（不随分页失真）；centers 元信息消费后端接口。
// 由 shellbar 铃铛下拉选中某中心后打开（每个中心一个 tab，props.center 区分）。

const FALLBACK_CENTERS = [
  { id: 'task', label: '任务中心', icon: 'task' },
  { id: 'message', label: '消息中心', icon: 'email' },
  { id: 'log', label: '日志中心', icon: 'history' },
]

const LEVELS = ['info', 'success', 'warning', 'error']

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

function fmtTime (ms) {
  if (!ms) return ''
  try {
    const d = new Date(Number(ms))
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return '' }
}

function centerOf (ctx) {
  // props 由 native-host 经 JSON 属性注入，渲染时作为 ctx.props 传入。
  const p = ctx?.props?.center || ctx?.host?.__props?.center
  return p || 'task'
}

function styleCss () {
  return `
    .nc{--neo-cyan:#00b4d8;--neo-mint:#10b981;--neo-warn:#f59e0b;--neo-red:#e90b0b;
      display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;width:100%;box-sizing:border-box;
      font:13px/1.5 var(--sapFontFamily,Arial,sans-serif);color:var(--sapTextColor,#1d2d3e);background:var(--sapBackgroundColor,#f5f6f7);overflow:hidden}
    .nc-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;height:46px;box-sizing:border-box;padding:0 12px;
      border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 22%,var(--sapGroup_TitleBorderColor,#d9d9d9));
      background:color-mix(in srgb,var(--neo-cyan) 12%,var(--sapList_HeaderBackground,#eef2f6))}
    .nc-head ui5-icon{width:1.2rem;height:1.2rem;color:var(--neo-cyan)}
    .nc-title{font-weight:700;font-size:14px}
    .nc-count{font-size:11px;font-weight:700;color: #fff;background:var(--neo-red);border-radius:999px;padding:1px 7px;min-width:18px;text-align:center}
    .nc-count[data-zero="1"]{background:var(--sapNeutralBackground,#c8ccd0)}
    .nc-actions{margin-left:auto;display:flex;gap:6px}
    .nc-btn{border:1px solid color-mix(in srgb,var(--neo-cyan) 20%,transparent);border-radius:6px;background:var(--sapList_Background,#fff);
      color:var(--neo-cyan);font:inherit;font-size:12px;padding:4px 10px;cursor:pointer}
    .nc-btn:hover{background:color-mix(in srgb,var(--neo-cyan) 12%,var(--sapList_Background,#fff))}
    .nc-filter{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;box-sizing:border-box;
      border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_BorderColor,#e5e5e5))}
    .nc-filter select{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;max-width:180px;
      border:1px solid color-mix(in srgb,var(--neo-cyan) 20%,var(--sapField_BorderColor,#89919a));
      background:var(--sapField_Background,var(--sapList_Background,#fff));color:var(--sapField_TextColor,var(--sapTextColor,#1d2d3e))}
    .nc-filter label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);cursor:pointer}
    .nc-filter input[type="checkbox"]{accent-color:var(--neo-cyan)}
    .nc-list{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 16px;display:flex;flex-direction:column;gap:6px}
    .nc-item{display:flex;gap:10px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_BorderColor,#e5e5e5));
      border-radius:8px;background:var(--sapList_Background,#fff);cursor:pointer;transition:border-color .14s,box-shadow .14s,background .14s}
    .nc-item:hover{border-color:color-mix(in srgb,var(--neo-cyan) 35%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--neo-cyan) 8%,transparent)}
    .nc-item.unread{background:color-mix(in srgb,var(--neo-cyan) 6%,var(--sapList_Background,#fff));border-left:3px solid var(--neo-cyan)}
    .nc-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:6px;background:transparent}
    .nc-item.unread .nc-dot{background:var(--neo-red)}
    .nc-main{min-width:0;flex:1 1 auto}
    .nc-item-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .nc-item.unread .nc-item-title{font-weight:700}
    .nc-item-body{font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:2px;white-space:pre-wrap;word-break:break-word}
    .nc-item-meta{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .nc-level{font-size:10px;font-weight:700;border-radius:4px;padding:0 5px;border:1px solid currentColor}
    .nc-level[data-l="error"]{color:var(--neo-red)} .nc-level[data-l="warning"]{color:var(--neo-warn)}
    .nc-level[data-l="success"]{color:var(--neo-mint)} .nc-level[data-l="info"]{color:var(--neo-cyan)}
    .nc-tag{font-size:10px;border-radius:4px;padding:0 5px;border:1px solid color-mix(in srgb,var(--neo-cyan) 35%,transparent);color:var(--neo-cyan)}
    .nc-agg{font-size:10px;font-weight:700;color:var(--neo-red)}
    .nc-state{font-size:10px;font-weight:700;border-radius:4px;padding:0 6px;border:1px solid currentColor;flex:0 0 auto}
    .nc-state.unread{color:var(--neo-red)}
    .nc-state.read{color:var(--sapContent_LabelColor,#6a6d70);border-color:var(--sapList_BorderColor,#e5e5e5)}
    .nc-pager{flex:0 0 auto;display:flex;justify-content:center;align-items:center;box-sizing:border-box;
      padding:4px 10px 10px;border-top:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_BorderColor,#e5e5e5))}
    .nc-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--sapContent_LabelColor,#6a6d70)}
    .nc-empty ui5-icon{width:1.6rem;height:1.6rem;color:color-mix(in srgb,var(--neo-cyan) 55%,var(--sapContent_LabelColor,#6a6d70))}
  `
}

function itemHtml (it) {
  const lvl = it.level || 'info'
  const meta = [
    `<span class="nc-state ${it.read ? 'read' : 'unread'}">${it.read ? '已读' : '未读'}</span>`,
    `<span class="nc-level" data-l="${esc(lvl)}">${esc(lvl)}</span>`,
    it.type ? `<span class="nc-tag">${esc(it.type)}</span>` : '',
    it.aggCount > 1 ? `<span class="nc-agg">×${esc(it.aggCount)}</span>` : '',
    `<span>${esc(fmtTime(it.createdAt))}</span>`,
  ].filter(Boolean).join('')
  return `<div class="nc-item ${it.read ? '' : 'unread'}" role="button" tabindex="0" data-id="${esc(it.id)}" data-link="${esc(it.link || '')}">
    <span class="nc-dot"></span>
    <div class="nc-main">
      <div class="nc-item-title">${esc(it.title)}</div>
      ${it.body ? `<div class="nc-item-body">${esc(it.body)}</div>` : ''}
      <div class="nc-item-meta">${meta}</div>
    </div>
  </div>`
}

function viewHtml (st) {
  const meta = st.centers.find((c) => c.id === st.center) || st.centers[0] || FALLBACK_CENTERS[0]
  const unread = st.counts ? st.counts[st.center] || 0 : 0
  const types = Array.from(new Set(st.items.map((x) => x.type).filter(Boolean))).sort()
  const body = st.items.length
    ? st.items.map(itemHtml).join('')
    : `<cmx-empty-state icon="${esc(meta.icon || 'bell')}" title="暂无通知" size="sm"></cmx-empty-state>`
  // 有数据才渲染分页条；total 未知(首帧/加载失败)时省略属性，cmx-pager 显示「第 N 页」。
  const pager = st.items.length
    ? `<div class="nc-pager"><cmx-pager page="${st.page}" page-size="${st.pageSize}" page-sizes="20,50,100"${st.total != null ? ` total="${st.total}"` : ''}></cmx-pager></div>`
    : ''
  return `<div class="nc" data-center="${esc(st.center)}">
    <div class="nc-head">
      <ui5-icon name="${esc(meta.icon || 'bell')}"></ui5-icon>
      <span class="nc-title">${esc(meta.label || '通知中心')}</span>
      <span class="nc-count" data-zero="${unread ? 0 : 1}">${unread > 99 ? '99+' : unread}</span>
      <span class="nc-actions">
        <button class="nc-btn" type="button" data-act="refresh">刷新</button>
        <button class="nc-btn" type="button" data-act="read-all">全部已读</button>
      </span>
    </div>
    <div class="nc-filter">
      <select data-filter="type" title="按业务类型筛选">
        <option value="">全部类型</option>
        ${types.map((t) => `<option value="${esc(t)}" ${st.filters.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <select data-filter="level" title="按等级筛选">
        <option value="">全部等级</option>
        ${LEVELS.map((l) => `<option value="${esc(l)}" ${st.filters.level === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <label><input type="checkbox" data-filter="unread" ${st.filters.unread ? 'checked' : ''}/>仅看未读</label>
    </div>
    <div class="nc-list">${body}</div>
    ${pager}
  </div>`
}

async function loadCenters () {
  try {
    const d = await apiJson('/api/notifications/centers')
    return (d && Array.isArray(d.centers) && d.centers.length) ? d.centers : FALLBACK_CENTERS
  } catch { return FALLBACK_CENTERS }
}

async function loadCounts () {
  try { return await apiJson('/api/notifications/counts') } catch { return null }
}

async function loadItems (st) {
  const q = new URLSearchParams()
  q.set('center', st.center)
  if (st.filters.type) q.set('type', st.filters.type)
  if (st.filters.level) q.set('level', st.filters.level)
  if (st.filters.unread) q.set('isRead', 'false')
  q.set('limit', String(st.pageSize))
  q.set('offset', String((st.page - 1) * st.pageSize))
  const d = await apiJson(`/api/notifications?${q.toString()}`)
  st.items = (d && d.items) || []
  // offset 页码模式后端每页都回 total；异常缺省时保持 null（分页条显示「第 N 页」）。
  st.total = d && typeof d.total === 'number' ? d.total : null
}

/** link 跳转：node:/menu: → portal-help-action 组合事件（与帮助中心同通道）；URL → window.open。 */
function openLink (el, link) {
  if (!link) return
  if (link.startsWith('node:')) {
    const id = link.slice(5).trim()
    if (id) el.dispatchEvent(new CustomEvent('portal-help-action', { detail: { kind: 'node', id }, bubbles: true, composed: true }))
  } else if (link.startsWith('menu:')) {
    const key = link.slice(5).trim()
    if (key) el.dispatchEvent(new CustomEvent('portal-help-action', { detail: { kind: 'menu', key }, bubbles: true, composed: true }))
  } else if (/^https?:\/\//.test(link)) {
    try { window.open(link, '_blank', 'noopener') } catch {}
  }
}

function bind (root, st, rerender) {
  root.querySelectorAll('[data-id]').forEach((el) => {
    const open = async () => {
      const id = el.getAttribute('data-id')
      const link = el.getAttribute('data-link') || ''
      const wasUnread = !st.items.find((x) => String(x.id) === String(id))?.read
      if (wasUnread) {
        try {
          await apiJson('/api/notifications/mark-read', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ center: st.center, id }),
          })
        } catch (e) { console.warn('[notify-center] 标记已读失败:', e && e.message || e) }
      }
      if (link) openLink(el, link)
      await rerender()
    }
    el.addEventListener('click', open)
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open() } })
  })
  root.querySelector('[data-act="refresh"]')?.addEventListener('click', () => rerender())
  // cmx-pager 页码/页大小变化 → 重新拉当前页（页大小变化时组件已重置到第 1 页）。
  root.querySelector('cmx-pager')?.addEventListener('page-change', (e) => {
    const { page, pageSize } = e.detail || {}
    if (page === st.page && pageSize === st.pageSize) return
    st.page = page || 1
    st.pageSize = pageSize || st.pageSize
    rerender()
  })
  root.querySelector('[data-act="read-all"]')?.addEventListener('click', async () => {
    try {
      await apiJson('/api/notifications/mark-read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, center: st.center }),
      })
    } catch (e) { console.warn('[notify-center] 全部已读失败:', e && e.message || e) }
    st.page = 1
    await rerender()
  })
  root.querySelectorAll('[data-filter]').forEach((el) => {
    const key = el.getAttribute('data-filter')
    const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input'
    el.addEventListener(evt, async () => {
      const v = el.type === 'checkbox' ? el.checked : el.value
      st.filters[key] = v
      st.page = 1 // 过滤变化回到第 1 页
      await rerender()
    })
  })
}

async function mount (ctx) {
  const host = ctx.host
  const st = {
    center: centerOf(ctx),
    centers: FALLBACK_CENTERS,
    filters: { type: '', level: '', unread: false },
    items: [],
    page: 1,
    pageSize: 20,
    total: null,
    counts: null,
  }
  const render = async () => {
    const root = host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root')
    if (!root || !root.isConnected) return
    try { await loadItems(st) } catch (e) {
      console.warn('[notify-center] 加载通知失败:', e && e.message || e)
      st.items = []
      st.total = null
    }
    st.counts = await loadCounts()
    root.innerHTML = `<style>${styleCss()}</style>${viewHtml(st)}`
    const wrap = root.querySelector('.nc')
    if (wrap) bind(wrap, st, render)
  }
  // 首帧：等 renderRoot 就绪再渲染；centers 元信息异步补齐后刷新一次。
  const wait = (n = 0) => {
    const root = host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root')
    if (root && root.isConnected) {
      loadCenters().then((cs) => { st.centers = cs; return render() }).catch(() => {})
      return
    }
    if (n < 20) requestAnimationFrame(() => wait(n + 1))
  }
  requestAnimationFrame(() => wait())
  return `<style>${styleCss()}</style><div class="nc"><cmx-empty-state icon="synchronize" title="加载中…" size="sm"></cmx-empty-state></div>`
}

export default {
  defaultView: 'content',
  views: {
    async content (ctx) { return mount(ctx) },
  },
}
