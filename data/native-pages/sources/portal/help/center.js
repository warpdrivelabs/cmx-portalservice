// 帮助中心 native_pages 页面（借鉴 portal/dam/registry-center.js 的「单模块 + 三视图 + 共享 state」结构）。
//
// 三区（与 DAM 注册中心一致，由菜单节点把同一页面的三个 view 分别挂到三区）：
//   - explorer (帮助目录区)：可搜索、可分级的 DAM(域/应用/模块) → 模块内功能主题树
//   - content  (详细内容区)：选中主题的详细内容（markdown 渲染）
//   - property (样例/示例区)：选中主题的样例/示例；无示例时给出空态
//
// 选择联动：explorer 选中主题 → loadDoc() → refreshAll() 重渲所有区（content+property），
// 与 registry-center 的 selectItem→refreshAll 同构。数据全部来自后端（cmx-container Rust）：
//   GET  /api/help/catalog?domain=&app=&module=   → 轻量目录项（建树+搜索）
//   POST /api/help/get  { domain, app, module, file }  → 完整文档（content + examples）
//   GET  /api/registry/dam                         → DAM 注册表（取 域/应用/模块 显示名）

const state = {
  catalog: [],
  registry: { domains: [], applications: [], modules: [] },
  query: '',
  selected: null, // { domain, app, module, file }
  history: [], // 浏览历史（每项为一个 selection ref），content 区标题栏「前进/后退」用
  histIndex: -1, // 当前在 history 中的位置
  doc: null,
  docLoading: false,
  expanded: null, // Set<string>；null 表示「尚未初始化，默认全展开」
  loading: null,
  message: '',
  hosts: new Set(),
}

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

/* ───────────────────────── DAM 显示名 ───────────────────────── */

function damLabel (kind, ids) {
  const r = state.registry || {}
  if (kind === 'domain') {
    const d = (r.domains || []).find((x) => x.id === ids.domain)
    return d ? (d.title || d.name || d.id) : ids.domain
  }
  if (kind === 'app') {
    const a = (r.applications || r.apps || []).find((x) => x.domain === ids.domain && (x.id === ids.app))
    return a ? (a.title || a.name || a.id) : ids.app
  }
  const m = (r.modules || []).find((x) => x.domain === ids.domain && (x.application || x.app) === ids.app && (x.id || x.module) === ids.module)
  return m ? (m.title || m.name || m.id || m.module) : ids.module
}

function damIcon (kind, ids) {
  const r = state.registry || {}
  if (kind === 'domain') {
    const d = (r.domains || []).find((x) => x.id === ids.domain)
    return (d && d.icon) || 'dimension'
  }
  if (kind === 'app') {
    const a = (r.applications || r.apps || []).find((x) => x.domain === ids.domain && x.id === ids.app)
    return (a && a.icon) || 'application'
  }
  const m = (r.modules || []).find((x) => x.domain === ids.domain && (x.application || x.app) === ids.app && (x.id || x.module) === ids.module)
  return (m && m.icon) || 'tree'
}

/* ───────────────────────── 搜索过滤 ───────────────────────── */

function matchesQuery (item, q) {
  if (!q) return true
  const hay = [
    item.title, item.summary, item.id, item.path,
    item.domain, item.app, item.module,
    ...(item.keywords || []),
  ].join(' ').toLowerCase()
  return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok))
}

function filteredCatalog () {
  const q = (state.query || '').trim().toLowerCase()
  if (!q) return state.catalog
  return state.catalog.filter((it) => matchesQuery(it, q))
}

/* ───────────────────────── 建树 ───────────────────────── */

// node: { type, key, label, icon, item?, order, children: Map }
function makeNode (type, key, label, icon) {
  return { type, key, label, icon, item: null, order: 0, children: new Map() }
}

function ensureChild (parent, type, key, label, icon) {
  if (!parent.children.has(key)) parent.children.set(key, makeNode(type, key, label, icon))
  return parent.children.get(key)
}

function buildTree () {
  const root = makeNode('root', '', '', '')
  for (const it of filteredCatalog()) {
    const dKey = it.domain
    const aKey = `${it.domain}/${it.app}`
    const mKey = `${it.domain}/${it.app}/${it.module}`
    const dNode = ensureChild(root, 'domain', dKey, damLabel('domain', it), damIcon('domain', it))
    const aNode = ensureChild(dNode, 'app', aKey, damLabel('app', it), damIcon('app', it))
    const mNode = ensureChild(aNode, 'module', mKey, damLabel('module', it), damIcon('module', it))
    // path 斜杠分级 → 中间文件夹节点
    let cur = mNode
    let prefix = mKey
    const segs = String(it.path || '').split('/').map((s) => s.trim()).filter(Boolean)
    for (const seg of segs) {
      prefix = `${prefix}/${seg}`
      cur = ensureChild(cur, 'folder', prefix, seg, 'folder')
    }
    // 叶子主题
    const leafKey = `${mKey}#${it.file}`
    const leaf = ensureChild(cur, 'topic', leafKey, it.title || it.id, it.icon || 'sys-help')
    leaf.item = it
    leaf.order = it.order || 0
  }
  return root
}

function sortedChildren (node) {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.type === 'topic' && b.type === 'topic') {
      if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0)
    }
    // 文件夹优先于主题，其余按 label
    const rank = (n) => (n.type === 'topic' ? 1 : 0)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return String(a.label).localeCompare(String(b.label))
  })
}

function isExpanded (key) {
  // 搜索态：全部展开以便看到命中。
  if ((state.query || '').trim()) return true
  if (!state.expanded) return true // 默认全展开
  return state.expanded.has(key)
}

function toggleExpand (key) {
  if (!state.expanded) {
    // 首次切换：把「默认全展开」物化为显式集合（收集所有非叶 key 后剔除当前）。
    state.expanded = collectExpandableKeys()
  }
  if (state.expanded.has(key)) state.expanded.delete(key)
  else state.expanded.add(key)
}

function collectExpandableKeys () {
  const keys = new Set()
  const walk = (node) => {
    for (const child of node.children.values()) {
      if (child.type !== 'topic') {
        keys.add(child.key)
        walk(child)
      }
    }
  }
  walk(buildTree())
  return keys
}

function selectedKey () {
  const s = state.selected
  if (!s) return ''
  return `${s.domain}/${s.app}/${s.module}#${s.file}`
}

/* ───────────────────────── 数据加载 ───────────────────────── */

async function loadRegistry () {
  try {
    state.registry = await apiJson('/api/registry/dam?active_only=true')
  } catch (e) {
    console.warn('[help-center] DAM registry 加载失败（显示名降级为编码）:', e && e.message || e)
    state.registry = { domains: [], applications: [], modules: [] }
    const cmx = () => (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}
    cmx().cmxWarn?.(`功能目录加载失败：${e && e.message || e}（应用名将显示为编码）`)
  }
}

async function loadCatalog () {
  const out = await apiJson('/api/help/catalog')
  state.catalog = (out && out.items) || []
}

async function loadDoc (sel) {
  if (!sel) { state.doc = null; publishHelpContext(); refreshAll(); return }
  // 仅在「尚无任何内容」时显示加载态；切换主题时保留旧内容直到新内容就绪，避免标题区闪烁。
  state.docLoading = true
  if (!state.doc) refreshAll()
  try {
    state.doc = await apiJson('/api/help/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sel),
    })
  } catch (err) {
    state.doc = null
    state.message = err.message || String(err)
  } finally {
    state.docLoading = false
  }
  publishHelpContext()
  refreshAll()
}

/* ───────────────────────── 把当前帮助内容发布为 AI 助手上下文 ───────────────────────── */

// 帮助中心打开/切换主题时，把「当前正在看的帮助文档」作为上下文广播给 portal-app，
// 供 shellbar AI 助手浮窗（portal-agent-console）问答时引用。事件 composed 冒泡穿透 shadow。
function publishHelpContext () {
  const doc = state.doc
  const detail = doc
    ? {
        active: true,
        title: doc.title || doc.id || '',
        domain: doc.domain || '',
        app: doc.app || '',
        module: doc.module || '',
        path: doc.path || '',
        summary: doc.summary || '',
        // 正文截断，避免上下文过长（后端还会再截到 4000 字）。
        content: String(doc.content || '').slice(0, 6000),
        ref: `${doc.domain}/${doc.app}/${doc.module}/${doc.file}`,
      }
    : { active: true, title: '', empty: true }
  emitHelpContext(detail)
}

function clearHelpContext () {
  emitHelpContext({ active: false })
}

function emitHelpContext (detail) {
  const target = firstHost() || (typeof document !== 'undefined' ? document : null)
  if (!target) return
  try {
    target.dispatchEvent(new CustomEvent('portal-help-context', { detail, bubbles: true, composed: true }))
  } catch {
    try { document.dispatchEvent(new CustomEvent('portal-help-context', { detail, bubbles: true, composed: true })) } catch {}
  }
}

function firstHost () {
  for (const h of state.hosts) { if (h && h.isConnected) return h }
  return null
}

function pickInitialSelection () {
  if (state.selected) return
  const first = state.catalog[0]
  if (first) state.selected = { domain: first.domain, app: first.app, module: first.module, file: first.file }
}

function sameRef (a, b) {
  return !!a && !!b && a.domain === b.domain && a.app === b.app && a.module === b.module && a.file === b.file
}

/* ───────────────────────── 浏览历史（前进/后退） ───────────────────────── */

// 跳转到某主题。pushHistory=true 时把它压入历史栈（截断当前位置之后的「前进」分支），
// 这样 content 标题区的「后退/前进」与浏览器历史语义一致。
function navigate (ref, { pushHistory = true } = {}) {
  if (!ref) return
  const sel = { domain: ref.domain, app: ref.app, module: ref.module, file: ref.file }
  if (sameRef(sel, state.selected) && state.doc) return // 已在该主题，无需重复加载
  if (pushHistory) {
    // 截断「前进」分支后追加，避免历史分叉。
    if (state.histIndex < state.history.length - 1) state.history = state.history.slice(0, state.histIndex + 1)
    // 避免与栈顶完全相同的连续项。
    if (!sameRef(state.history[state.histIndex], sel)) {
      state.history.push(sel)
      state.histIndex = state.history.length - 1
    }
  }
  state.selected = sel
  state.message = ''
  loadDoc(sel).catch(() => {})
  refreshAll()
}

function canGoBack () { return state.histIndex > 0 }
function canGoForward () { return state.histIndex >= 0 && state.histIndex < state.history.length - 1 }

function goBack () {
  if (!canGoBack()) return
  state.histIndex -= 1
  navigate(state.history[state.histIndex], { pushHistory: false })
}

function goForward () {
  if (!canGoForward()) return
  state.histIndex += 1
  navigate(state.history[state.histIndex], { pushHistory: false })
}

// explorer 树点击：跳转并记入历史。
function selectTopic (item) {
  if (!item) return
  navigate(item, { pushHistory: true })
}

async function ensureLoaded () {
  state.loading = '加载中...'
  await Promise.all([loadRegistry(), loadCatalog()])
  pickInitialSelection()
  // 初始主题作为历史栈的第一项，使「后退」从第二次跳转起可用。
  if (state.selected && state.history.length === 0) {
    state.history = [state.selected]
    state.histIndex = 0
  }
  state.loading = null
  if (state.selected && !state.doc) await loadDoc(state.selected)
}

function refreshAll () {
  for (const host of Array.from(state.hosts)) {
    if (host && host.isConnected) renderInto(host)
    else state.hosts.delete(host)
  }
}

/* ───────────────────────── markdown 渲染（最小实现） ───────────────────────── */

function mdToHtml (md) {
  if (!md) return ''
  // 先保护代码块，避免后续行级规则误伤。
  const blocks = []
  let s = String(md).replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length
    blocks.push(`<pre class="help-md-code" data-lang="${esc(lang || '')}"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)
    return ` BLOCK${i} `
  })
  s = esc(s)
  const lines = s.split('\n')
  const out = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  for (let raw of lines) {
    const line = raw.replace(/ BLOCK(\d+) /g, (_m, i) => blocks[Number(i)] || '')
    if (/^ ?<pre /.test(line) || line.includes('class="help-md-code"')) { closeList(); out.push(line); continue }
    if (/^###\s+/.test(raw)) { closeList(); out.push(`<h4>${inline(raw.replace(/^###\s+/, ''))}</h4>`); continue }
    if (/^##\s+/.test(raw)) { closeList(); out.push(`<h3>${inline(raw.replace(/^##\s+/, ''))}</h3>`); continue }
    if (/^#\s+/.test(raw)) { closeList(); out.push(`<h2>${inline(raw.replace(/^#\s+/, ''))}</h2>`); continue }
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    if (!raw.trim()) { closeList(); continue }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('\n')

  function inline (t) {
    return t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="help-md-inline">$1</code>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
        // help: 协议 → 站内跳转到另一帮助主题（前进/后退入栈）。
        if (/^help:/i.test(href)) {
          const ref = resolveHelpLink(href.replace(/^help:/i, ''), state.doc)
          if (ref) {
            const data = `${ref.domain}/${ref.app}/${ref.module}/${ref.file}`
            return `<a href="#" class="help-md-link" data-help-link="${esc(data)}">${text}</a>`
          }
          // 解析不到目标：降级为不可点的提示文本，避免死链。
          return `<span class="help-md-deadlink" title="未找到帮助主题">${text}</span>`
        }
        // node:/menu:/wsnode: 协议 → 不是跳帮助，而是「执行功能」（打开工作区节点/菜单）。
        const exec = parseExecHref(href, state.doc)
        if (exec) {
          return `<a href="#" class="help-md-exec" data-help-exec="${esc(JSON.stringify(exec))}" title="${esc(exec.title || '执行功能')}"><ui5-icon class="help-exec-icon" name="${esc(exec.icon || 'play')}"></ui5-icon>${text}</a>`
        }
        if (/^(node|menu|wsnode):/i.test(href)) {
          // 协议正确但目标无法解析（如内联动作缺失）：降级提示，避免静默失效。
          return `<span class="help-md-deadlink" title="未找到可执行目标">${text}</span>`
        }
        return `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`
      })
  }
}

// 解析「执行功能」链接 → 一个动作描述对象，供点击时 dispatch 给 portal-app。
//   node:<id>            打开已保存的工作区节点（后端 /api/workspace-nodes/{id}）
//   menu:<menuKey>       执行某菜单/活动（findActivityIdByMenuPage + applyActivity）
//   wsnode:#<key>        打开当前帮助文档 actions[key] 内联定义的工作区节点
//   wsnode:<json>        （高级）直接内联一个节点对象的 JSON（较少用）
function parseExecHref (href, curDoc) {
  const s = String(href || '')
  let m
  if ((m = s.match(/^node:(.+)$/i))) {
    const id = m[1].trim()
    return id ? { kind: 'node', id, icon: 'create', title: `打开节点 ${id}` } : null
  }
  if ((m = s.match(/^menu:(.+)$/i))) {
    const key = m[1].trim()
    return key ? { kind: 'menu', key, icon: 'menu', title: `执行菜单 ${key}` } : null
  }
  if ((m = s.match(/^wsnode:(.+)$/i))) {
    const rest = m[1].trim()
    if (rest.startsWith('#')) {
      const key = rest.slice(1).trim()
      const actions = curDoc && curDoc.actions && typeof curDoc.actions === 'object' ? curDoc.actions : null
      const node = actions ? actions[key] : null
      if (!node || typeof node !== 'object') return null
      return { kind: 'inlineNode', node, icon: node.icon || 'workflow-tasks', title: node.caption || node.name || key }
    }
    // 直接内联 JSON（容错解析）
    try {
      const node = JSON.parse(rest)
      if (node && typeof node === 'object') return { kind: 'inlineNode', node, icon: node.icon || 'workflow-tasks', title: node.caption || node.name || '内联节点' }
    } catch {}
    return null
  }
  return null
}

// 解析 help: 链接目标 → 命中的 catalog 项（含 file）。
// 支持：`domain/app/module/id`（完整限定）、`module/id`、`id`（后两者相对当前文档的 domain/app[/module]）。
function resolveHelpLink (raw, curDoc) {
  const token = String(raw || '').trim().replace(/^\/+|\/+$/g, '')
  if (!token) return null
  const parts = token.split('/').filter(Boolean)
  let domain, app, module, id
  if (parts.length >= 4) {
    [domain, app, module, id] = parts
  } else if (parts.length === 2 && curDoc) {
    domain = curDoc.domain; app = curDoc.app; module = parts[0]; id = parts[1]
  } else if (parts.length === 1 && curDoc) {
    domain = curDoc.domain; app = curDoc.app; module = curDoc.module; id = parts[0]
  } else {
    return null
  }
  // id 可带或不带 .json 后缀。
  const wantId = id.replace(/\.json$/i, '')
  return state.catalog.find((x) =>
    x.domain === domain && x.app === app && x.module === module && x.id === wantId,
  ) || null
}

/* ───────────────────────── 视图 HTML ───────────────────────── */

function renderTreeNodes (node, depth) {
  return sortedChildren(node).map((child) => {
    const pad = 8 + depth * 14
    if (child.type === 'topic') {
      const it = child.item
      const active = selectedKey() === child.key
      return `<div class="help-node help-topic ${active ? 'active' : ''}" role="button" tabindex="0"
          data-topic="${esc(`${it.domain}/${it.app}/${it.module}/${it.file}`)}" style="padding-left:${pad}px" title="${esc(it.summary || it.title)}">
        <ui5-icon class="help-node-icon" name="${esc(child.icon)}"></ui5-icon>
        <span class="help-node-text"><strong>${esc(child.label)}</strong>${it.summary ? `<span>${esc(it.summary)}</span>` : ''}</span>
        ${it.hasExamples ? '<ui5-icon class="help-node-ex" name="example" title="含示例"></ui5-icon>' : ''}
      </div>`
    }
    const open = isExpanded(child.key)
    const kindCls = `help-${child.type}`
    return `<div class="help-branch">
      <div class="help-node help-group ${kindCls}" role="button" tabindex="0" data-expand="${esc(child.key)}" style="padding-left:${pad}px">
        <ui5-icon class="help-caret" name="${open ? 'navigation-down-arrow' : 'navigation-right-arrow'}"></ui5-icon>
        <ui5-icon class="help-node-icon" name="${esc(child.icon)}"></ui5-icon>
        <span class="help-node-text"><strong>${esc(child.label)}</strong></span>
      </div>
      <div class="help-children" style="${open ? '' : 'display:none'}">${open ? renderTreeNodes(child, depth + 1) : ''}</div>
    </div>`
  }).join('') || '<cmx-empty-state icon="search" title="未找到匹配的帮助主题" size="sm"></cmx-empty-state>'
}

function treeHtml () {
  const tree = buildTree()
  return renderTreeNodes(tree, 0)
}

function explorerHtml () {
  const q = esc(state.query || '')
  return `<div class="help-wrap help-neo" data-help-region="explorer">
    <div class="help-search">
      <ui5-icon class="help-search-icon" name="search"></ui5-icon>
      <input class="help-search-input" type="search" placeholder="搜索帮助（标题/关键字/模块）" value="${q}" data-help-search aria-label="搜索帮助">
      ${q ? '<button class="help-search-clear" type="button" title="清除" data-help-search-clear><ui5-icon name="decline"></ui5-icon></button>' : ''}
    </div>
    <div class="help-tree" data-help-tree>${treeHtml()}</div>
  </div>`
}

function navToolbarHtml () {
  // content 标题区的「后退/前进」工具条，与浏览器前进后退语义一致。
  const back = canGoBack()
  const fwd = canGoForward()
  return `<div class="help-nav">
    <button class="help-nav-btn" type="button" data-help-back ${back ? '' : 'disabled'} title="后退" aria-label="后退"><ui5-icon name="nav-back"></ui5-icon></button>
    <button class="help-nav-btn" type="button" data-help-forward ${fwd ? '' : 'disabled'} title="前进" aria-label="前进"><ui5-icon name="navigation-right-arrow"></ui5-icon></button>
  </div>`
}

function contentHtml () {
  const doc = state.doc
  if (state.docLoading && !doc) {
    return `<div class="help-wrap help-neo" data-help-region="content">
      <div class="help-neo-banner"><div class="help-neo-banner-main">${navToolbarHtml()}<ui5-icon class="help-neo-banner-icon" name="synchronize"></ui5-icon><div><div class="help-neo-banner-title">加载内容...</div></div></div></div>
      <cmx-empty-state icon="synchronize" title="加载内容..." size="sm"></cmx-empty-state>
    </div>`
  }
  if (!doc) {
    return `<div class="help-wrap help-neo" data-help-region="content">
      <div class="help-neo-banner"><div class="help-neo-banner-main">${navToolbarHtml()}<ui5-icon class="help-neo-banner-icon" name="sys-help"></ui5-icon><div><div class="help-neo-banner-title">帮助</div></div></div></div>
      <cmx-empty-state icon="sys-help" title="从左侧帮助目录选择一项查看详细内容"${state.message ? ` description="${esc(state.message)}"` : ''} size="sm"></cmx-empty-state>
    </div>`
  }
  const crumb = `${esc(damLabel('domain', doc))} / ${esc(damLabel('app', doc))} / ${esc(damLabel('module', doc))}${doc.path ? ` / ${esc(doc.path)}` : ''}`
  return `<div class="help-wrap help-neo" data-help-region="content">
    <div class="help-neo-banner">
      <div class="help-neo-banner-main">
        ${navToolbarHtml()}
        <ui5-icon class="help-neo-banner-icon" name="sys-help"></ui5-icon>
        <div class="help-neo-banner-line">
          <span class="help-neo-banner-title">${esc(doc.title || doc.id)}</span>
          <span class="help-neo-banner-crumb">${crumb}</span>
        </div>
      </div>
      <span class="help-neo-chip">${doc.examples && doc.examples.length ? `${doc.examples.length} 示例` : '文档'}</span>
    </div>
    <div class="help-doc">
      ${doc.summary ? `<div class="help-summary">${esc(doc.summary)}</div>` : ''}
      <div class="help-md">${mdToHtml(doc.content) || '<p class="help-muted">（暂无详细内容）</p>'}</div>
    </div>
  </div>`
}

function propertyHtml () {
  const doc = state.doc
  const examples = (doc && Array.isArray(doc.examples)) ? doc.examples : []
  const head = `<div class="help-neo-banner help-neo-banner-compact">
      <div class="help-neo-banner-main">
        <ui5-icon class="help-neo-banner-icon" name="example"></ui5-icon>
        <div class="help-neo-banner-line">
          <span class="help-neo-banner-title">示例</span>
          <span class="help-neo-banner-crumb">${doc ? esc(doc.title || doc.id) : '未选择主题'}</span>
        </div>
      </div>
      <span class="help-neo-chip">${examples.length ? 'LIVE' : 'IDLE'}</span>
    </div>`
  if (!doc) {
    return `<div class="help-wrap help-property-wrap help-neo" data-help-region="property">${head}<cmx-empty-state icon="example" title="选择主题后查看样例" size="sm"></cmx-empty-state></div>`
  }
  if (!examples.length) {
    return `<div class="help-wrap help-property-wrap help-neo" data-help-region="property">${head}<cmx-empty-state icon="example" title="此功能暂无示例" size="sm"></cmx-empty-state></div>`
  }
  const body = examples.map((ex, i) => {
    const e = ex && typeof ex === 'object' ? ex : { code: String(ex) }
    const title = e.title || `示例 ${i + 1}`
    const lang = e.lang || ''
    const code = e.code != null ? String(e.code) : (typeof e === 'string' ? e : JSON.stringify(e, null, 2))
    return `<section class="help-example">
      <div class="help-example-head">
        <span class="help-example-title">${esc(title)}</span>
        ${lang ? `<span class="help-example-lang">${esc(lang)}</span>` : ''}
        <button class="help-copy" type="button" data-copy-idx="${i}" title="复制"><ui5-icon name="copy"></ui5-icon></button>
      </div>
      ${e.note ? `<div class="help-example-note">${esc(e.note)}</div>` : ''}
      <pre class="help-md-code"><code data-code-idx="${i}">${esc(code)}</code></pre>
    </section>`
  }).join('')
  return `<div class="help-wrap help-property-wrap help-neo" data-help-region="property">${head}<div class="help-examples">${body}</div></div>`
}

/* ───────────────────────── 绑定 ───────────────────────── */

function rebindTree (root) {
  root.querySelectorAll('[data-expand]').forEach((el) => {
    el.addEventListener('click', () => {
      toggleExpand(el.getAttribute('data-expand'))
      renderTreeInto(root)
    })
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      toggleExpand(el.getAttribute('data-expand'))
      renderTreeInto(root)
    })
  })
  root.querySelectorAll('[data-topic]').forEach((el) => {
    const open = () => {
      const [domain, app, module, file] = el.getAttribute('data-topic').split('/')
      const item = state.catalog.find((x) => x.domain === domain && x.app === app && x.module === module && x.file === file)
      selectTopic(item || { domain, app, module, file })
    }
    el.addEventListener('click', open)
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      open()
    })
  })
}

function renderTreeInto (root) {
  const treeEl = root.querySelector('[data-help-tree]')
  if (!treeEl) return
  treeEl.innerHTML = treeHtml()
  rebindTree(root)
}

function bindPage (root, mode) {
  if (mode === 'explorer') {
    const input = root.querySelector('[data-help-search]')
    if (input) {
      input.addEventListener('input', () => {
        state.query = input.value
        renderTreeInto(root)
        // 同步清除按钮的出现/消失（仅当从无到有/从有到无时重建搜索条）。
        const hasClear = !!root.querySelector('[data-help-search-clear]')
        if (!!state.query.trim() !== hasClear) {
          // 轻量：不重建输入框，单独 toggle 清除按钮
          const bar = root.querySelector('.help-search')
          if (bar) {
            const old = bar.querySelector('[data-help-search-clear]')
            if (state.query.trim() && !old) {
              const btn = document.createElement('button')
              btn.className = 'help-search-clear'
              btn.type = 'button'
              btn.title = '清除'
              btn.setAttribute('data-help-search-clear', '')
              btn.innerHTML = '<ui5-icon name="decline"></ui5-icon>'
              btn.addEventListener('click', () => { state.query = ''; input.value = ''; renderTreeInto(root); btn.remove() })
              bar.appendChild(btn)
            } else if (!state.query.trim() && old) {
              old.remove()
            }
          }
        }
      })
    }
    root.querySelector('[data-help-search-clear]')?.addEventListener('click', () => {
      state.query = ''
      if (input) input.value = ''
      renderTreeInto(root)
    })
    rebindTree(root)
    return
  }
  if (mode === 'property') {
    root.querySelectorAll('[data-copy-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-copy-idx'))
        const codeEl = root.querySelector(`[data-code-idx="${i}"]`)
        const text = codeEl ? codeEl.textContent : ''
        try { navigator.clipboard?.writeText(text) } catch {}
        btn.classList.add('copied')
        setTimeout(() => btn.classList.remove('copied'), 1200)
      })
    })
    return
  }
  // content：前进/后退工具条 + 正文内站内帮助链接 + 「执行功能」链接。
  root.querySelector('[data-help-back]')?.addEventListener('click', () => goBack())
  root.querySelector('[data-help-forward]')?.addEventListener('click', () => goForward())
  root.querySelectorAll('[data-help-link]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault()
      const [domain, app, module, file] = a.getAttribute('data-help-link').split('/')
      const item = state.catalog.find((x) => x.domain === domain && x.app === app && x.module === module && x.file === file)
      navigate(item || { domain, app, module, file }, { pushHistory: true })
    })
  })
  // 「执行功能」链接：dispatch composed 事件穿透 shadow DOM 给 portal-app 执行（打开工作区节点/菜单）。
  root.querySelectorAll('[data-help-exec]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault()
      let detail = null
      try { detail = JSON.parse(a.getAttribute('data-help-exec')) } catch {}
      if (!detail) return
      dispatchHelpAction(a, detail)
    })
  })
}

// 把「执行功能」动作冒泡给 portal-app（mirror nav-selection/shellbar-* 的 composed 事件做法）。
function dispatchHelpAction (el, detail) {
  try {
    el.dispatchEvent(new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true }))
  } catch (e) {
    // 兜底：直接在 document 上派发，仍能被 portal-app 的全局监听捕获。
    try { document.dispatchEvent(new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true })) } catch {}
  }
}

function renderInto (host) {
  const root = host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root')
  if (!root) return
  // 保留搜索框焦点：仅 explorer 且正在输入时不整体重渲（输入路径已走 renderTreeInto）。
  const view = host.getAttribute?.('view')
  const mode = view === 'explorer' ? 'explorer' : view === 'property' ? 'property' : 'content'
  const active = root.ownerDocument?.activeElement
  if (mode === 'explorer' && active && active.matches?.('[data-help-search]')) {
    const body0 = root.querySelector('[data-help-body]') || root
    renderTreeInto(body0)
    return
  }
  // <style> 只注入一次（常驻），重渲时只换 body 容器，避免每次重灌样式导致的闪烁。
  let styleEl = root.querySelector('style[data-help-style]')
  let body = root.querySelector('[data-help-body]')
  if (!styleEl || !body) {
    root.innerHTML = `<style data-help-style>${styleCss()}</style><div data-help-body style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0"></div>`
    body = root.querySelector('[data-help-body]')
  }
  body.innerHTML = mode === 'explorer' ? explorerHtml() : mode === 'property' ? propertyHtml() : contentHtml()
  bindPage(body, mode)
}

function mount (ctx, view, after) {
  const html = view === 'explorer' ? explorerHtml() : view === 'property' ? propertyHtml() : contentHtml()
  const bindWhenReady = (tries = 0) => {
    if (ctx.host) state.hosts.add(ctx.host)
    const root = ctx.host?.renderRoot || ctx.host?.shadowRoot?.querySelector('.native-page-root')
    if (root && root.isConnected && typeof after === 'function') {
      const body = root.querySelector('[data-help-body]') || root
      after(body)
      // content 视图：挂载后把当前帮助发布为 AI 上下文；卸载时清除。
      if (view === 'content' && ctx.host) {
        publishHelpContext()
        const prev = ctx.host.onDispose
        ctx.host.onDispose = () => {
          try { clearHelpContext() } catch {}
          if (typeof prev === 'function') { try { prev() } catch {} }
        }
      }
      return
    }
    if (tries < 20) requestAnimationFrame(() => bindWhenReady(tries + 1))
  }
  requestAnimationFrame(() => bindWhenReady())
  // <style> 常驻 + body 容器：与 renderInto 的结构一致，避免首渲与重渲结构不同导致的二次重排。
  return `<style data-help-style>${styleCss()}</style><div data-help-body style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0">${html}</div>`
}

function styleHtml () {
  return `<style data-help-style>${styleCss()}</style>`
}

function styleCss () {
  return `
    .help-neo{
      --neo-cyan:#00b4d8;--neo-violet: #7c3aed;--neo-mint:#10b981;--neo-warn:#f59e0b;
      --help-body-bg:var(--sapList_Background,#fff);
      --help-head-bg:color-mix(in srgb,var(--neo-cyan) 14%,var(--sapList_HeaderBackground,#eef2f6));
      --help-border:color-mix(in srgb,var(--neo-cyan) 22%,var(--sapGroup_TitleBorderColor,#d9d9d9));
      --help-head-h:46px;
    }
    .help-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;height:100%;font:13px/1.5 var(--sapFontFamily,Arial,sans-serif);color:var(--sapTextColor,#1d2d3e);background:var(--sapBackgroundColor,#f5f6f7);position:relative;overflow:hidden;box-sizing:border-box}
    .help-neo::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:0;background:
      radial-gradient(ellipse 90% 55% at 0% 0%,color-mix(in srgb,var(--neo-violet) 9%,transparent),transparent 58%),
      radial-gradient(ellipse 80% 50% at 100% 100%,color-mix(in srgb,var(--neo-cyan) 8%,transparent),transparent 52%),
      linear-gradient(color-mix(in srgb,var(--neo-cyan) 4%,transparent) 1px,transparent 1px),
      linear-gradient(90deg,color-mix(in srgb,var(--neo-cyan) 4%,transparent) 1px,transparent 1px);
      background-size:auto,auto,28px 28px,28px 28px;opacity:.5}
    .help-neo>*{position:relative;z-index:1}
    /* 搜索 */
    .help-search{flex:0 0 auto;box-sizing:border-box;height:var(--help-head-h);display:flex;align-items:center;gap:6px;padding:0 8px;border-bottom:1px solid var(--help-border);background:var(--help-head-bg)}
    .help-search-icon{width:1rem;height:1rem;color:var(--neo-cyan);flex:0 0 auto}
    .help-search-input{flex:1 1 auto;min-width:0;border:1px solid color-mix(in srgb,var(--neo-cyan) 16%,var(--sapField_BorderColor,#89919a));border-radius:6px;padding:6px 8px;background:var(--sapField_Background,#fff);color:inherit;font:inherit}
    .help-search-input:focus{outline:none;border-color:color-mix(in srgb,var(--neo-cyan) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--neo-cyan) 16%,transparent)}
    .help-search-clear{flex:0 0 auto;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--sapContent_LabelColor,#6a6d70);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    .help-search-clear:hover{background:color-mix(in srgb,var(--neo-cyan) 12%,transparent);color:var(--neo-cyan)}
    .help-search-clear ui5-icon{width:14px;height:14px}
    /* 树 */
    .help-tree{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 6px 12px}
    .help-children{display:block}
    .help-node{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;user-select:none;transition:background .14s ease,box-shadow .14s ease}
    .help-node:hover{background:color-mix(in srgb,var(--neo-cyan) 7%,var(--sapList_Background,#fff))}
    .help-caret{width:14px;height:14px;flex:0 0 auto;color:var(--sapContent_LabelColor,#6a6d70)}
    .help-node-icon{width:16px;height:16px;flex:0 0 auto;color:var(--neo-cyan)}
    .help-group.help-domain .help-node-icon{color:var(--neo-violet)}
    .help-group.help-app .help-node-icon{color:var(--neo-cyan)}
    .help-group.help-module .help-node-icon{color:var(--neo-mint)}
    .help-node-text{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1 1 auto}
    .help-node-text strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .help-group .help-node-text strong{font-weight:700}
    .help-node-text span{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .help-topic{margin:1px 0}
    .help-topic .help-node-icon{color:var(--sapContent_LabelColor,#6a6d70)}
    .help-node-ex{width:13px;height:13px;flex:0 0 auto;color:var(--neo-warn)}
    .help-topic.active{background:linear-gradient(90deg,color-mix(in srgb,var(--neo-cyan) 14%,var(--sapList_Background,#fff)),color-mix(in srgb,var(--neo-violet) 7%,var(--sapList_Background,#fff)));box-shadow:inset 3px 0 0 var(--neo-cyan)}
    .help-topic.active .help-node-icon{color:var(--neo-cyan)}
    .help-topic.active .help-node-text strong{color:var(--neo-cyan)}
    /* banner */
    .help-neo-banner{box-sizing:border-box;height:var(--help-head-h);display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 auto;padding:0 12px;border-bottom:1px solid var(--help-border);background:linear-gradient(105deg,color-mix(in srgb,var(--neo-violet) 14%,var(--sapList_HeaderBackground,#eef2f6)),color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_HeaderBackground,#eef2f6)) 60%,var(--help-body-bg))}
    .help-neo-banner-compact{padding:0 10px}
    .help-neo-banner-main{display:flex;align-items:center;gap:10px;min-width:0}
    /* content 标题区 前进/后退 */
    .help-nav{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;margin-right:4px}
    .help-nav-btn{width:28px;height:28px;border:1px solid color-mix(in srgb,var(--neo-cyan) 16%,transparent);border-radius:7px;background:color-mix(in srgb,var(--sapList_Background,#fff) 88%,var(--neo-cyan) 12%);color:var(--neo-cyan);display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,opacity .15s ease}
    .help-nav-btn ui5-icon{width:15px;height:15px}
    .help-nav-btn:hover:not([disabled]){background:color-mix(in srgb,var(--neo-cyan) 16%,var(--sapList_Background,#fff));border-color:color-mix(in srgb,var(--neo-cyan) 40%,transparent);box-shadow:0 0 10px color-mix(in srgb,var(--neo-cyan) 18%,transparent)}
    .help-nav-btn[disabled]{opacity:.32;cursor:default;pointer-events:none}
    .help-neo-banner-icon{width:1.35rem;height:1.35rem;color:var(--neo-cyan);filter:drop-shadow(0 0 8px color-mix(in srgb,var(--neo-cyan) 35%,transparent))}
    .help-neo-banner-title{font-size:14px;font-weight:700;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 0 auto;max-width:min(48vw,360px)}
    /* 标题与面包屑同一行：标题在前，面包屑作为浅色后缀，整体单行省略 */
    .help-neo-banner-line{display:flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden}
    .help-neo-banner-crumb{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .help-neo-chip{flex:0 0 auto;font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--neo-mint) 35%,transparent);color:var(--neo-mint);background:color-mix(in srgb,var(--neo-mint) 10%,transparent)}
    /* content doc */
    .help-doc{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px}
    .help-summary{font-size:13px;color:var(--sapTextColor,#32363a);background:color-mix(in srgb,var(--neo-cyan) 7%,var(--sapList_Background,#fff));border-left:3px solid var(--neo-cyan);border-radius:0 6px 6px 0;padding:8px 12px;margin:0 0 14px}
    .help-md{font-size:13px;line-height:1.65;color:var(--sapTextColor,#32363a)}
    .help-md h2{font-size:17px;font-weight:700;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--help-border)}
    .help-md h3{font-size:15px;font-weight:700;margin:16px 0 6px}
    .help-md h4{font-size:13px;font-weight:700;margin:14px 0 5px;color:var(--neo-violet)}
    .help-md p{margin:8px 0}
    .help-md ul{margin:8px 0;padding-left:22px}
    .help-md li{margin:3px 0}
    .help-md a{color:var(--neo-cyan);text-decoration:none}
    .help-md a:hover{text-decoration:underline}
    /* 站内帮助链接：跳到另一帮助主题（前进/后退可回退） */
    .help-md-link{color:var(--neo-violet);font-weight:600;text-decoration:none;border-bottom:1px dashed color-mix(in srgb,var(--neo-violet) 45%,transparent);padding-bottom:1px;cursor:pointer}
    .help-md-link::after{content:'›';margin-left:2px;font-weight:700;color:color-mix(in srgb,var(--neo-violet) 70%,transparent)}
    .help-md-link:hover{color:color-mix(in srgb,var(--neo-violet) 80%,var(--neo-cyan));border-bottom-color:currentColor;border-bottom-style:solid}
    .help-md-deadlink{color:var(--sapContent_LabelColor,#6a6d70);text-decoration:line-through;cursor:not-allowed}
    /* 「执行功能」链接：打开工作区节点/菜单，区别于站内跳转(紫色) → 用薄荷绿胶囊 + 运行图标 */
    .help-md-exec{display:inline-flex;align-items:center;gap:4px;color:var(--neo-mint);font-weight:600;text-decoration:none;cursor:pointer;padding:1px 8px 1px 6px;border:1px solid color-mix(in srgb,var(--neo-mint) 40%,transparent);border-radius:999px;background:color-mix(in srgb,var(--neo-mint) 10%,transparent);line-height:1.5;vertical-align:baseline;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
    .help-md-exec:hover{background:color-mix(in srgb,var(--neo-mint) 18%,transparent);border-color:color-mix(in srgb,var(--neo-mint) 60%,transparent);box-shadow:0 0 10px color-mix(in srgb,var(--neo-mint) 22%,transparent)}
    .help-exec-icon{width:13px;height:13px;color:var(--neo-mint)}
    .help-md-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_Background,#f3f5f7));border:1px solid color-mix(in srgb,var(--neo-cyan) 18%,transparent);border-radius:4px;padding:1px 5px}
    .help-muted{color:var(--sapContent_LabelColor,#6a6d70)}
    /* code blocks (shared by content + examples) */
    .help-md-code{margin:10px 0;background:color-mix(in srgb,var(--neo-cyan) 8%,var(--sapList_Background,#f6f8fa));color:var(--sapTextColor,#1d2d3e);border:1px solid color-mix(in srgb,var(--neo-cyan) 22%,var(--sapField_BorderColor,#bcc3ca));border-radius:8px;padding:12px 14px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55}
    .help-md-code code{color:var(--sapTextColor,#1d2d3e);background:none;white-space:pre}
    /* property examples */
    .help-property-wrap{overflow:hidden}
    .help-examples{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 20px;display:flex;flex-direction:column;gap:12px}
    .help-example{border:1px solid var(--help-border);border-radius:8px;overflow:hidden;background:var(--help-body-bg)}
    .help-example-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--help-head-bg);border-bottom:1px solid var(--help-border)}
    .help-example-title{font-weight:700;font-size:12px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .help-example-lang{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--neo-violet);background:color-mix(in srgb,var(--neo-violet) 10%,transparent);border:1px solid color-mix(in srgb,var(--neo-violet) 25%,transparent);border-radius:4px;padding:1px 6px}
    .help-copy{width:26px;height:26px;border:1px solid color-mix(in srgb,var(--neo-cyan) 14%,transparent);border-radius:6px;background:var(--sapList_Background,#fff);color:var(--neo-cyan);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
    .help-copy:hover{background:color-mix(in srgb,var(--neo-cyan) 12%,var(--sapList_Background,#fff))}
    .help-copy.copied{color:var(--neo-mint);border-color:color-mix(in srgb,var(--neo-mint) 35%,transparent)}
    .help-copy ui5-icon{width:14px;height:14px}
    .help-example-note{font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);padding:7px 10px 0}
    .help-example .help-md-code{margin:8px 10px 10px}
    /* empty */
    .help-empty{padding:24px 16px;color:var(--sapContent_LabelColor,#6a6d70);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;min-height:90px}
    .help-empty-lg{flex:1 1 auto}
    .help-empty ui5-icon{width:1.6rem;height:1.6rem;color:color-mix(in srgb,var(--neo-cyan) 55%,var(--sapContent_LabelColor,#6a6d70));opacity:.85}
    .help-empty small{font-size:11px;color:var(--sapNegativeTextColor,#b00)}
  `
}

export default {
  defaultView: 'content',
  views: {
    async explorer (ctx) {
      await ensureLoaded()
      return mount(ctx, 'explorer', (root) => bindPage(root, 'explorer'))
    },
    async content (ctx) {
      await ensureLoaded()
      return mount(ctx, 'content', (root) => bindPage(root, 'content'))
    },
    async property (ctx) {
      await ensureLoaded()
      return mount(ctx, 'property', (root) => bindPage(root, 'property'))
    },
  },
}
