/**
 * registry-editor —— 注册表编辑器（native_pages · JS 模块页）。
 *
 * 仿 Windows regedit：左侧键树（懒渲染）+ 右侧值表（双击编辑）+ 地址栏 + 搜索 + 导入/导出。
 * 数据模型即 JSON 树：键 = 嵌套对象，键下值存于 `__values__`（{ name: { type, data } }）。
 * 持久化：可编辑根键（HKEY_CURRENT_USER / HKEY_LOCAL_MACHINE / HKEY_USERS）存 localStorage，
 * 只读根键（HKEY_PORTAL_RUNTIME / HKEY_CURRENT_CONFIG）每次启动由真实 DAM / 种子重建。
 * 导入/导出为 .json 文件（深合并）。
 *
 * 契约：export default { defaultView, views:{ content(ctx) } }；返回 HTML 片段挂 shadowRoot。
 * cmx 类经 globalThis.__cmxDataComp 取用；UI5 标签已由 Portal boot。
 */
const cmx = () => (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}

const LS_KEY = 'cmx.registry.v1'
const DEFAULT_PATH = ['HKEY_CURRENT_USER', 'Software', 'CMX', 'Portal']

// 值类型元数据：徽章色 / 说明。类型系统对齐 Windows 注册表（子集）+ JSON。
const TYPE_META = {
  REG_SZ: { caption: '字符串', color: 'var(--neo-cyan,#00b4d8)' },
  REG_DWORD: { caption: '数字 (32 位)', color: 'var(--neo-violet,#7c3aed)' },
  REG_BOOL: { caption: '布尔', color: 'var(--neo-mint,#10b981)' },
  REG_JSON: { caption: 'JSON', color: 'var(--neo-warn,#f59e0b)' },
}
const VALUE_TYPES = Object.keys(TYPE_META)
const DEFAULT_VALUE_NAME = '(默认)'

// ─── 小工具 ──────────────────────────────────────────────────────────────
const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const isKeyNode = (k) => !k.startsWith('__')

function pathStr(segs) { return segs.join('\\') }

// 模块级状态（content(ctx) 入口重置易变部分）
const state = {
  db: null,            // 可编辑根（localStorage 持久化）
  roRoots: {},         // 只读根（启动时重建）
  path: DEFAULT_PATH.slice(0, 1),
  expanded: new Set(),
  selectedValue: null, // 当前选中值名
  search: '',          // 搜索关键字（空 = 值表视图）
  saveTimer: 0,
  savedAt: '',
  host: null,
}

// ─── 种子数据 ────────────────────────────────────────────────────────────
function mkVal(type, data) { return { type, data } }
function mkKey(values, children) {
  const node = children || {}
  node.__values__ = Object.assign({ [DEFAULT_VALUE_NAME]: mkVal('REG_SZ', '') }, values || {})
  return node
}

function defaultDb() {
  return {
    HKEY_CURRENT_USER: mkKey(null, {
      Software: mkKey(null, {
        CMX: mkKey(null, {
          Portal: mkKey({
            Theme: mkVal('REG_SZ', 'neo-dark'),
            Density: mkVal('REG_SZ', 'compact'),
            EnableAnimations: mkVal('REG_BOOL', true),
            MaxRecentItems: mkVal('REG_DWORD', 12),
            HomePage: mkVal('REG_SZ', '/portal/home'),
          }),
          Designer: mkKey({
            AutoSave: mkVal('REG_BOOL', true),
            GridSnap: mkVal('REG_DWORD', 8),
            DefaultSkin: mkVal('REG_SZ', 'neo'),
          }),
          DataComp: mkKey({
            Locale: mkVal('REG_SZ', 'zh-CN'),
            Features: mkVal('REG_JSON', { grid: true, form: true, dict: true }),
          }),
        }),
      }),
      Environment: mkKey({
        TEMP: mkVal('REG_SZ', '%USERPROFILE%\\AppData\\Local\\Temp'),
        TOOL: mkVal('REG_SZ', 'regedit-web'),
      }),
    }),
    HKEY_LOCAL_MACHINE: mkKey(null, {
      Software: mkKey(null, {
        CMX: mkKey(null, {
          Server: mkKey({
            Edition: mkVal('REG_SZ', '2024'),
            Toolchain: mkVal('REG_SZ', '1.97.1'),
            Workers: mkVal('REG_DWORD', 4),
            ClusterEnabled: mkVal('REG_BOOL', false),
          }),
          Cluster: mkKey({
            NodeId: mkVal('REG_SZ', 'node-local'),
            SyncChannel: mkVal('REG_SZ', 'redis-pubsub'),
            ReconcileSeconds: mkVal('REG_DWORD', 60),
          }),
        }),
      }),
      System: mkKey(null, {
        CurrentControlSet: mkKey(null, {
          Services: mkKey(null, {
            WebServer: mkKey({ Port: mkVal('REG_DWORD', 8080), Start: mkVal('REG_DWORD', 2) }),
            FlowEngine: mkKey({ Start: mkVal('REG_DWORD', 2), StepMode: mkVal('REG_BOOL', false) }),
          }),
        }),
      }),
    }),
    HKEY_USERS: mkKey(null, {
      '.DEFAULT': mkKey(null, {
        'Control Panel': mkKey(null, {
          Colors: mkKey({ Accent: mkVal('REG_SZ', '#00b4d8'), Background: mkVal('REG_SZ', '#0b0f17') }),
        }),
      }),
    }),
  }
}

// 只读根：当前配置（静态种子，体现"运行时快照"）
function buildConfigRoot() {
  return mkKey(null, {
    Runtime: mkKey({
      Channel: mkVal('REG_SZ', 'native_pages'),
      Renderer: mkVal('REG_SZ', 'shadow-dom/blob-import'),
      BootTime: mkVal('REG_SZ', new Date().toISOString()),
      ReadOnly: mkVal('REG_BOOL', true),
    }),
    Storage: mkKey({
      Provider: mkVal('REG_SZ', 'localStorage'),
      Key: mkVal('REG_SZ', LS_KEY),
      Format: mkVal('REG_SZ', 'json'),
    }),
  })
}

// 只读根：门户运行时（真实 DAM 数据，/api/registry/dam）
async function buildRuntimeRoot() {
  const res = await fetch('/api/registry/dam', { credentials: 'same-origin' })
  const body = await res.json()
  const pkg = (body && typeof body.code === 'number') ? body.data : body
  const domains = (pkg && pkg.domains) || []
  const apps = (pkg && pkg.applications) || []
  const modules = (pkg && pkg.modules) || []
  const domKids = {}
  for (const d of domains) {
    const appKids = {}
    for (const a of apps.filter((x) => (x.domain || x.domain_code) === (d.id || d.code))) {
      const modKids = {}
      for (const m of modules.filter((x) => (x.application || x.app) === (a.id || a.code) && (x.domain || x.domain_code) === (d.id || d.code))) {
        modKids[m.id || m.code] = mkKey({
          Code: mkVal('REG_SZ', m.code || ''),
          Name: mkVal('REG_SZ', m.name || ''),
          Title: mkVal('REG_SZ', m.title || ''),
          Status: mkVal('REG_DWORD', m.status == null ? 1 : m.status),
          Manifest: mkVal('REG_SZ', m.manifestPath || m.manifest_path || ''),
        })
      }
      appKids[a.id || a.code] = mkKey({
        Code: mkVal('REG_SZ', a.code || ''),
        Name: mkVal('REG_SZ', a.name || ''),
        Title: mkVal('REG_SZ', a.title || ''),
      }, Object.keys(modKids).length ? { Modules: mkKey(null, modKids) } : {})
    }
    domKids[d.id || d.code] = mkKey({
      Code: mkVal('REG_SZ', d.code || ''),
      Name: mkVal('REG_SZ', d.name || ''),
      Title: mkVal('REG_SZ', d.title || ''),
      SortOrder: mkVal('REG_DWORD', d.sortOrder || d.sort_order || 0),
    }, Object.keys(appKids).length ? { Applications: mkKey(null, appKids) } : {})
  }
  return mkKey({
    Domains: mkVal('REG_DWORD', domains.length),
    Applications: mkVal('REG_DWORD', apps.length),
    Modules: mkVal('REG_DWORD', modules.length),
    Source: mkVal('REG_SZ', '/api/registry/dam'),
  }, { Domains: mkKey(null, domKids) })
}

// ─── 数据层 ──────────────────────────────────────────────────────────────
function loadDb() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (isObj(parsed)) return parsed
    }
  } catch (e) { /* 损坏则回退种子 */ }
  const seed = defaultDb()
  try { localStorage.setItem(LS_KEY, JSON.stringify(seed)) } catch (e) { /* 配额满忽略 */ }
  return seed
}

function saveDb(immediate) {
  clearTimeout(state.saveTimer)
  const write = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.db))
      state.savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    } catch (e) {
      showCmxToast('注册表保存失败：' + e.message, { level: 'error' })
    }
    renderStatus()
  }
  if (immediate) { write(); return }
  state.saveTimer = setTimeout(write, 300)
}

// 取路径节点：返回 { node, readonly }；segs[0] 决定走可编辑库或只读根
function getNode(segs) {
  if (!segs.length) return null
  const rootName = segs[0]
  const readonly = Object.prototype.hasOwnProperty.call(state.roRoots, rootName)
  const pool = readonly ? state.roRoots : state.db
  let node = pool[rootName]
  if (!node) return null
  for (let i = 1; i < segs.length; i++) {
    node = node[segs[i]]
    if (!isObj(node)) return null
  }
  return { node, readonly }
}

function rootNames() {
  return [...Object.keys(state.roRoots), ...Object.keys(state.db)]
}

function subkeyNames(node) {
  return Object.keys(node).filter(isKeyNode).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function valueEntries(node) {
  const vs = node.__values__ || {}
  const names = Object.keys(vs).sort((a, b) => {
    if (a === DEFAULT_VALUE_NAME) return -1
    if (b === DEFAULT_VALUE_NAME) return 1
    return a.localeCompare(b, 'zh-CN')
  })
  return names.map((name) => ({ name, type: vs[name].type, data: vs[name].data }))
}

function createKey(segs, name) {
  const hit = getNode(segs)
  if (!hit) return '父项不存在'
  if (hit.readonly) return '只读根键不可修改'
  name = String(name || '').trim()
  if (!name) return '名称不能为空'
  if (name.includes('\\')) return '项名不能包含 \\'
  if (hit.node[name]) return `项 "${name}" 已存在`
  hit.node[name] = mkKey()
  saveDb()
  return null
}

function deleteKey(segs) {
  if (segs.length < 2) return '根键不可删除'
  const hit = getNode(segs)
  if (!hit) return '项不存在'
  if (hit.readonly) return '只读根键不可删除'
  const parent = getNode(segs.slice(0, -1))
  delete parent.node[segs[segs.length - 1]]
  saveDb()
  return null
}

function renameKey(segs, newName) {
  if (segs.length < 2) return '根键不可重命名'
  const hit = getNode(segs)
  if (!hit) return '项不存在'
  if (hit.readonly) return '只读根键不可重命名'
  newName = String(newName || '').trim()
  if (!newName || newName.includes('\\')) return '名称非法'
  const parent = getNode(segs.slice(0, -1)).node
  const oldName = segs[segs.length - 1]
  if (newName === oldName) return null
  if (parent[newName]) return `项 "${newName}" 已存在`
  // 保持键序：重建对象
  const rebuilt = {}
  for (const k of Object.keys(parent)) rebuilt[k === oldName ? newName : k] = parent[k]
  for (const k of Object.keys(parent)) delete parent[k]
  Object.assign(parent, rebuilt)
  saveDb()
  state.path = [...segs.slice(0, -1), newName]
  return null
}

function setValue(segs, name, type, data) {
  const hit = getNode(segs)
  if (!hit) return '项不存在'
  if (hit.readonly) return '只读根键不可修改'
  name = String(name ?? '').trim() || DEFAULT_VALUE_NAME
  if (!VALUE_TYPES.includes(type)) return '非法类型'
  if (!hit.node.__values__) hit.node.__values__ = {}
  hit.node.__values__[name] = { type, data }
  saveDb()
  return null
}

function deleteValue(segs, name) {
  const hit = getNode(segs)
  if (!hit) return '项不存在'
  if (hit.readonly) return '只读根键不可修改'
  if (hit.node.__values__) delete hit.node.__values__[name]
  saveDb()
  return null
}

function renameValue(segs, oldName, newName) {
  const hit = getNode(segs)
  if (!hit) return '项不存在'
  if (hit.readonly) return '只读根键不可修改'
  if (oldName === DEFAULT_VALUE_NAME) return '默认值不可重命名'
  newName = String(newName || '').trim()
  if (!newName || newName === DEFAULT_VALUE_NAME) return '名称非法'
  const vs = hit.node.__values__ || {}
  if (!vs[oldName]) return '值不存在'
  if (vs[newName]) return `值 "${newName}" 已存在`
  vs[newName] = vs[oldName]
  delete vs[oldName]
  saveDb()
  return null
}

// 搜索：匹配键路径 / 值名 / 值数据；返回最多 limit 条
function searchAll(keyword, limit) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []
  const out = []
  const walk = (node, segs, readonly) => {
    if (out.length >= limit) return
    const path = pathStr(segs)
    if (segs.length && path.toLowerCase().includes(kw)) {
      out.push({ kind: 'key', path, readonly })
    }
    const vs = node.__values__ || {}
    for (const name of Object.keys(vs)) {
      if (out.length >= limit) return
      const v = vs[name]
      const dataStr = typeof v.data === 'string' ? v.data : JSON.stringify(v.data)
      if (name.toLowerCase().includes(kw) || String(dataStr ?? '').toLowerCase().includes(kw)) {
        out.push({ kind: 'value', path, name, type: v.type, data: v.data, readonly })
      }
    }
    for (const k of Object.keys(node)) {
      if (isKeyNode(k) && isObj(node[k])) walk(node[k], [...segs, k], readonly)
    }
  }
  for (const r of rootNames()) {
    const pool = state.roRoots[r] ? state.roRoots : state.db
    walk(pool[r], [r], !!state.roRoots[r])
    if (out.length >= limit) break
  }
  return out
}

// 导出子树（深拷贝）
function exportSubtree(segs) {
  const hit = getNode(segs)
  if (!hit) return null
  return JSON.parse(JSON.stringify(hit.node))
}

// 导入：深合并 obj 到目标键；返回 { added, updated }
function importInto(segs, obj) {
  const hit = getNode(segs)
  if (!hit) return { error: '目标项不存在' }
  if (hit.readonly) return { error: '只读根键不可导入' }
  if (!isObj(obj)) return { error: '导入内容必须是 JSON 对象（注册表子树）' }
  let added = 0, updated = 0
  const merge = (target, src) => {
    if (isObj(src.__values__)) {
      if (!isObj(target.__values__)) target.__values__ = {}
      for (const name of Object.keys(src.__values__)) {
        const v = src.__values__[name]
        if (!isObj(v) || !VALUE_TYPES.includes(v.type)) continue
        if (target.__values__[name]) updated++; else added++
        target.__values__[name] = { type: v.type, data: v.data }
      }
    }
    for (const k of Object.keys(src)) {
      if (!isKeyNode(k) || !isObj(src[k])) continue
      if (!isObj(target[k])) { target[k] = mkKey(); added++ }
      merge(target[k], src[k])
    }
  }
  merge(hit.node, obj)
  saveDb()
  return { added, updated }
}

// ─── 消息提示 ────────────────────────────────────────────────────────────
const { showCmxToast } = globalThis.__cmxDataComp // 共享 toast（cmx-data-comp/lib/cmx-toast.js；治理清单 B-05）

function flashStatus(text) {
  const el = state.host && state.host.renderRoot.querySelector('#regFlash')
  if (!el) return
  el.textContent = text
  el.classList.add('on')
  setTimeout(() => el.classList.remove('on'), 2600)
}

// ─── 渲染：树 ────────────────────────────────────────────────────────────
function iconFor(segs, readonly) {
  if (segs.length === 1) return readonly ? 'locked' : 'database'
  return 'folder'
}

function renderTree() {
  const root = state.host.renderRoot
  const box = root.querySelector('#regTree')
  if (!box) return
  const curPath = pathStr(state.path)
  const rows = []
  const pushRow = (segs, name, depth, hasKids, readonly) => {
    const p = pathStr(segs)
    const expanded = state.expanded.has(p)
    const sel = p === curPath
    rows.push(`
      <div class="reg-tnode${sel ? ' sel' : ''}" data-path="${esc(p)}" data-depth="${depth}" style="padding-left:${8 + depth * 16}px" title="${esc(p)}">
        <ui5-icon class="reg-tarrow${expanded ? ' open' : ''}${hasKids ? '' : ' none'}" name="navigation-right-arrow"></ui5-icon>
        <ui5-icon class="reg-ticon${readonly ? ' ro' : ''}" name="${iconFor(segs, readonly)}"></ui5-icon>
        <span class="reg-tname">${esc(name)}</span>
      </div>`)
    return expanded
  }
  const walk = (node, segs, depth, readonly) => {
    const kids = subkeyNames(node)
    const expanded = pushRow(segs, segs[segs.length - 1], depth, kids.length > 0, readonly)
    if (!expanded) return
    for (const k of kids) walk(node[k], [...segs, k], depth + 1, readonly)
  }
  for (const r of rootNames()) {
    const pool = state.roRoots[r] ? state.roRoots : state.db
    walk(pool[r], [r], 0, !!state.roRoots[r])
  }
  box.innerHTML = rows.join('')
}

// ─── 渲染：地址栏 ────────────────────────────────────────────────────────
function renderAddr() {
  const root = state.host.renderRoot
  const box = root.querySelector('#regAddr')
  if (!box) return
  const crumbs = state.path.map((seg, i) => {
    const p = pathStr(state.path.slice(0, i + 1))
    return `${i ? '<span class="reg-sep">\\</span>' : ''}<span class="reg-crumb" data-path="${esc(p)}">${esc(seg)}</span>`
  }).join('')
  box.innerHTML = `<ui5-icon name="key" class="reg-addr-icon"></ui5-icon>${crumbs}
    <ui5-button class="reg-addr-edit" icon="edit" design="Transparent" title="编辑路径"></ui5-button>`
}

// ─── 渲染：值表 ──────────────────────────────────────────────────────────
function fmtData(v) {
  if (v.type === 'REG_JSON') return JSON.stringify(v.data)
  if (v.type === 'REG_BOOL') return v.data ? 'true' : 'false'
  if (v.type === 'REG_DWORD') return `0x${Number(v.data || 0).toString(16).padStart(8, '0')} (${v.data})`
  return String(v.data ?? '')
}

function renderValues() {
  const root = state.host.renderRoot
  const box = root.querySelector('#regValues')
  if (!box) return
  // 搜索模式
  if (state.search.trim()) {
    renderSearchResults(box)
    return
  }
  const hit = getNode(state.path)
  if (!hit) {
    box.innerHTML = '<cmx-empty-state icon="message-information" title="项不存在（可能已被删除）" size="sm"></cmx-empty-state>'
    return
  }
  const rows = valueEntries(hit.node).map((v) => {
    const meta = TYPE_META[v.type] || TYPE_META.REG_SZ
    const sel = state.selectedValue === v.name
    return `
      <tr class="reg-vrow${sel ? ' sel' : ''}" data-name="${esc(v.name)}" title="双击修改">
        <td class="reg-vname">${esc(v.name)}</td>
        <td><span class="reg-badge" style="--bc:${meta.color}">${v.type}</span></td>
        <td class="reg-vdata">${esc(fmtData(v))}</td>
      </tr>`
  }).join('')
  box.innerHTML = `
    <table class="reg-vtable">
      <thead><tr><th style="width:30%">名称</th><th style="width:16%">类型</th><th>数据</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="reg-empty"><cmx-empty-state icon="message-information" title="（空）" size="sm"></cmx-empty-state></td></tr>'}</tbody>
    </table>`
}

function renderSearchResults(box) {
  const results = searchAll(state.search, 100)
  const rows = results.map((r) => {
    if (r.kind === 'key') {
      return `<tr class="reg-srow" data-path="${esc(r.path)}">
        <td><span class="reg-badge" style="--bc:var(--neo-cyan,#00b4d8)">项</span></td>
        <td class="reg-vdata">${esc(r.path)}</td><td></td><td>${r.readonly ? '<span class="reg-ro">只读</span>' : ''}</td></tr>`
    }
    return `<tr class="reg-srow" data-path="${esc(r.path)}" data-name="${esc(r.name)}">
      <td><span class="reg-badge" style="--bc:var(--neo-violet,#7c3aed)">值</span></td>
      <td class="reg-vdata">${esc(r.path)}</td>
      <td>${esc(r.name)} = ${esc(fmtData(r))}</td><td>${r.readonly ? '<span class="reg-ro">只读</span>' : ''}</td></tr>`
  }).join('')
  box.innerHTML = `
    <div class="reg-search-head">搜索 “${esc(state.search)}” · ${results.length}${results.length >= 100 ? '+' : ''} 条结果（双击跳转）</div>
    <table class="reg-vtable"><tbody>${rows || '<tr><td class="reg-empty"><cmx-empty-state icon="search" title="无匹配结果" size="sm"></cmx-empty-state></td></tr>'}</tbody></table>`
}

// ─── 渲染：状态栏 ────────────────────────────────────────────────────────
function renderStatus() {
  const root = state.host && state.host.renderRoot
  if (!root) return
  const el = root.querySelector('#regStatus')
  if (!el) return
  const hit = getNode(state.path)
  const keys = hit ? subkeyNames(hit.node).length : 0
  const vals = hit ? valueEntries(hit.node).length : 0
  el.innerHTML = `
    <span class="reg-status-path">${esc(pathStr(state.path))}</span>
    <span class="reg-status-item">${keys} 个子项 · ${vals} 个值</span>
    <span class="reg-status-item">${hit && hit.readonly ? '🔒 只读' : '💾 ' + (state.savedAt ? '已保存 ' + state.savedAt : '本地存储')}</span>
    <span id="regFlash" class="reg-flash"></span>`
}

function renderAll() {
  renderTree()
  renderAddr()
  renderValues()
  renderStatus()
}

// ─── 路径导航 ────────────────────────────────────────────────────────────
function navigateTo(segs, ensureExpanded) {
  if (!getNode(segs)) { showCmxToast('路径不存在：' + pathStr(segs), { level: 'warning' }); return false }
  state.path = segs
  state.selectedValue = null
  state.search = ''
  const si = state.host.renderRoot.querySelector('#regSearch')
  if (si) si.value = ''
  if (ensureExpanded !== false) {
    for (let i = 1; i <= segs.length; i++) state.expanded.add(pathStr(segs.slice(0, i)))
  }
  renderAll()
  return true
}

function parsePath(text) {
  return String(text || '').split('\\').map((s) => s.trim()).filter(Boolean)
}

// ─── 右键菜单 ────────────────────────────────────────────────────────────
function closeMenu() {
  const m = state.host && state.host.renderRoot.querySelector('#regMenu')
  if (m) m.remove()
}

function openMenu(x, y, items) {
  closeMenu()
  const root = state.host.renderRoot
  const menu = document.createElement('div')
  menu.id = 'regMenu'
  menu.className = 'reg-menu'
  menu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="reg-menu-sep"></div>'
    : `<div class="reg-menu-item${it.disabled ? ' off' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('')
  root.appendChild(menu)
  // 定位（防溢出）
  const vw = window.innerWidth, vh = window.innerHeight
  const rect = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, vw - rect.width - 8) + 'px'
  menu.style.top = Math.min(y, vh - rect.height - 8) + 'px'
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.reg-menu-item')
    if (!item || item.classList.contains('off')) return
    const act = items[Number(item.dataset.i)]
    closeMenu()
    if (act && act.run) act.run()
  })
  setTimeout(() => {
    document.addEventListener('click', closeMenu, { once: true })
    document.addEventListener('contextmenu', closeMenu, { once: true })
  }, 0)
}

function treeMenu(segs, x, y) {
  const hit = getNode(segs)
  if (!hit) return
  const ro = hit.readonly
  const isRoot = segs.length === 1
  openMenu(x, y, [
    { label: '新建项', disabled: ro, run: () => openKeyDlg('新建项', '', (name) => afterEdit(createKey(segs, name), true)) },
    { label: '重命名', disabled: ro || isRoot, run: () => openKeyDlg('重命名项', segs[segs.length - 1], (name) => afterEdit(renameKey(segs, name), true)) },
    { label: '删除', disabled: ro || isRoot, run: () => openConfirm(`删除项 “${segs[segs.length - 1]}” 及其全部子项？`, () => {
      const err = deleteKey(segs)
      if (err) return showCmxToast(err, { level: 'warning' })
      navigateTo(segs.slice(0, -1))
    }) },
    { sep: true },
    { label: '新建字符串值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_SZ') },
    { label: '新建数字值 (DWORD)', disabled: ro, run: () => openValueDlg(segs, null, 'REG_DWORD') },
    { label: '新建布尔值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_BOOL') },
    { label: '新建 JSON 值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_JSON') },
    { sep: true },
    { label: '导出此项 (.json)', run: () => doExport(segs) },
    { label: '导入到此项 (.json)', disabled: ro, run: () => doImport(segs) },
    { sep: true },
    { label: '复制路径', run: () => { copyText(pathStr(segs)); showCmxToast('已复制路径', { level: 'info' }) } },
    { label: '刷新', run: () => renderAll() },
  ])
}

function valueMenu(segs, name, x, y) {
  const hit = getNode(segs)
  if (!hit) return
  const ro = hit.readonly
  const vs = hit.node.__values__ || {}
  if (name == null) {
    openMenu(x, y, [
      { label: '新建字符串值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_SZ') },
      { label: '新建数字值 (DWORD)', disabled: ro, run: () => openValueDlg(segs, null, 'REG_DWORD') },
      { label: '新建布尔值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_BOOL') },
      { label: '新建 JSON 值', disabled: ro, run: () => openValueDlg(segs, null, 'REG_JSON') },
    ])
    return
  }
  const v = vs[name]
  openMenu(x, y, [
    { label: '修改', disabled: ro, run: () => openValueDlg(segs, name, null) },
    { label: '重命名', disabled: ro || name === DEFAULT_VALUE_NAME, run: () => openKeyDlg('重命名值', name, (nn) => afterEdit(renameValue(segs, name, nn))) },
    { label: '删除', disabled: ro, run: () => openConfirm(`删除值 “${name}”？`, () => afterEdit(deleteValue(segs, name))) },
    { sep: true },
    { label: '复制数据', run: () => { copyText(typeof v.data === 'string' ? v.data : JSON.stringify(v.data)); showCmxToast('已复制数据', { level: 'info' }) } },
  ])
}

function afterEdit(err, structural) {
  if (err) return showCmxToast(err, { level: 'warning' })
  if (structural) { renderTree(); renderAddr() }
  renderValues()
  renderStatus()
}

// ─── 对话框（ui5-dialog）─────────────────────────────────────────────────
function getDlg() { return state.host.renderRoot.querySelector('#regDlg') }

function closeDlg() { const d = getDlg(); if (d) d.open = false }

function fillDlg(title, bodyHtml, onOk) {
  const d = getDlg()
  if (!d) return
  d.querySelector('#regDlgTitle').textContent = title
  d.querySelector('#regDlgBody').innerHTML = bodyHtml
  const okBtn = d.querySelector('#regDlgOk')
  const cancelBtn = d.querySelector('#regDlgCancel')
  okBtn.onclick = () => { if (onOk() !== false) closeDlg() }
  cancelBtn.onclick = () => closeDlg()
  d.open = true
}

// 新建项 / 重命名
function openKeyDlg(title, initial, onOk) {
  fillDlg(title, `
    <ui5-input id="dlgName" style="width:100%" value="${esc(initial)}" placeholder="名称"></ui5-input>
  `, () => {
    const name = getDlg().querySelector('#dlgName').value
    onOk(name)
    return true
  })
  const input = getDlg().querySelector('#dlgName')
  input.focus()
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') getDlg().querySelector('#regDlgOk').click() })
}

// 新建 / 编辑值；name=null 表示新建（type 给初始类型）
function openValueDlg(segs, name, initType) {
  const hit = getNode(segs)
  if (!hit) return
  const editing = name != null
  const cur = editing ? (hit.node.__values__ || {})[name] : null
  const type0 = editing ? cur.type : (initType || 'REG_SZ')
  const typeOpts = VALUE_TYPES.map((t) =>
    `<ui5-option value="${t}"${t === type0 ? ' selected' : ''}>${t} · ${TYPE_META[t].caption}</ui5-option>`).join('')
  fillDlg(editing ? `修改值 · ${name}` : '新建值', `
    <div class="reg-form-row"><label>名称</label>
      <ui5-input id="dlgVName" style="width:100%" value="${esc(editing ? name : '')}" ${editing || name === DEFAULT_VALUE_NAME ? 'disabled' : ''} placeholder="留空 = (默认)"></ui5-input>
    </div>
    <div class="reg-form-row"><label>类型</label>
      <ui5-select id="dlgVType" style="width:100%" ${editing ? 'disabled' : ''}>${typeOpts}</ui5-select>
    </div>
    <div class="reg-form-row"><label>数据</label><div id="dlgVEditor"></div>
      <div id="dlgVErr" class="reg-err"></div>
    </div>
  `, () => {
    const d = getDlg()
    const vname = editing ? name : (d.querySelector('#dlgVName').value.trim() || DEFAULT_VALUE_NAME)
    const vtype = editing ? cur.type : (d.querySelector('#dlgVType').selectedOption || {}).value || 'REG_SZ'
    const got = readEditor(vtype)
    if (got.error) { d.querySelector('#dlgVErr').textContent = got.error; return false }
    const err = setValue(segs, vname, vtype, got.data)
    if (err) { d.querySelector('#dlgVErr').textContent = err; return false }
    afterEdit(null)
    return true
  })
  // 编辑器按类型渲染
  const renderEditor = (t) => {
    const ed = getDlg().querySelector('#dlgVEditor')
    const data = editing ? cur.data : (t === 'REG_JSON' ? {} : t === 'REG_DWORD' ? 0 : t === 'REG_BOOL' ? false : '')
    if (t === 'REG_BOOL') {
      ed.innerHTML = `<ui5-select id="dlgVData" style="width:100%">
        <ui5-option value="true"${data ? ' selected' : ''}>true</ui5-option>
        <ui5-option value="false"${!data ? ' selected' : ''}>false</ui5-option></ui5-select>`
    } else if (t === 'REG_DWORD') {
      ed.innerHTML = `<ui5-input id="dlgVData" type="Number" style="width:100%" value="${esc(data)}"></ui5-input>`
    } else if (t === 'REG_JSON') {
      ed.innerHTML = `<ui5-textarea id="dlgVData" style="width:100%" rows="7" placeholder='{"key":"value"}'>${esc(JSON.stringify(data, null, 2))}</ui5-textarea>`
    } else {
      ed.innerHTML = `<ui5-input id="dlgVData" style="width:100%" value="${esc(data)}"></ui5-input>`
    }
  }
  renderEditor(type0)
  if (!editing) {
    getDlg().querySelector('#dlgVType').addEventListener('change', (e) => {
      renderEditor((e.target.selectedOption || {}).value || 'REG_SZ')
    })
  }
}

function readEditor(type) {
  const el = getDlg().querySelector('#dlgVData')
  if (!el) return { error: '编辑器未就绪' }
  if (type === 'REG_BOOL') return { data: (el.selectedOption || {}).value === 'true' }
  if (type === 'REG_DWORD') {
    const n = Number(el.value)
    if (!Number.isFinite(n)) return { error: '数字格式非法' }
    return { data: Math.trunc(n) }
  }
  if (type === 'REG_JSON') {
    try { return { data: JSON.parse(el.value || 'null') } }
    catch (e) { return { error: 'JSON 解析失败：' + e.message } }
  }
  return { data: el.value }
}

function openConfirm(text, onYes) {
  fillDlg('确认', `<div style="padding:4px 0 2px;">${esc(text)}</div>`, () => { onYes(); return true })
}

// ─── 导入 / 导出 ─────────────────────────────────────────────────────────
function doExport(segs) {
  const sub = exportSubtree(segs)
  if (!sub) return showCmxToast('项不存在', { level: 'warning' })
  const blob = new Blob([JSON.stringify(sub, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `registry-${segs[segs.length - 1]}-${Date.now()}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  showCmxToast('已导出：' + a.download, { level: 'info' })
}

function doImport(segs) {
  const input = state.host.renderRoot.querySelector('#regFile')
  if (!input) return
  input.onchange = async () => {
    const f = input.files && input.files[0]
    input.value = ''
    if (!f) return
    try {
      const obj = JSON.parse(await f.text())
      const r = importInto(segs, obj)
      if (r.error) return showCmxToast(r.error, { level: 'warning' })
      showCmxToast(`导入完成：新增 ${r.added} · 更新 ${r.updated}`, { level: 'info' })
      renderAll()
    } catch (e) {
      showCmxToast('导入失败：' + e.message, { level: 'error' })
    }
  }
  input.click()
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(String(text)).catch(() => {})
  }
}

// ─── 事件绑定（委托）─────────────────────────────────────────────────────
function bindEvents() {
  const root = state.host.renderRoot

  // 树：点击选中 / 箭头展开
  root.querySelector('#regTree').addEventListener('click', (e) => {
    const row = e.target.closest('.reg-tnode')
    if (!row) return
    const p = row.dataset.path
    if (e.target.closest('.reg-tarrow') && !e.target.closest('.reg-tarrow.none')) {
      if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p)
      renderTree()
      return
    }
    navigateTo(p.split('\\'), false)
  })
  // 树：双击展开
  root.querySelector('#regTree').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.reg-tnode')
    if (!row) return
    const p = row.dataset.path
    if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p)
    renderTree()
  })
  // 树：右键
  root.querySelector('#regTree').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.reg-tnode')
    if (!row) return
    e.preventDefault()
    const segs = row.dataset.path.split('\\')
    treeMenu(segs, e.clientX, e.clientY)
  })

  // 值区：单击选中 / 双击编辑 / 右键
  const valuesBox = root.querySelector('#regValues')
  valuesBox.addEventListener('click', (e) => {
    const srow = e.target.closest('.reg-srow')
    if (srow) return // 搜索结果行：双击才跳
    const row = e.target.closest('.reg-vrow')
    if (!row) return
    state.selectedValue = row.dataset.name
    renderValues()
  })
  valuesBox.addEventListener('dblclick', (e) => {
    const srow = e.target.closest('.reg-srow')
    if (srow) {
      navigateTo(srow.dataset.path.split('\\'))
      if (srow.dataset.name) { state.selectedValue = srow.dataset.name; renderValues() }
      return
    }
    const row = e.target.closest('.reg-vrow')
    if (!row) return
    const hit = getNode(state.path)
    if (hit && hit.readonly) return showCmxToast('只读根键不可修改', { level: 'warning' })
    openValueDlg(state.path, row.dataset.name, null)
  })
  valuesBox.addEventListener('contextmenu', (e) => {
    if (state.search.trim()) return
    e.preventDefault()
    const row = e.target.closest('.reg-vrow')
    valueMenu(state.path, row ? row.dataset.name : null, e.clientX, e.clientY)
  })
  // Delete 键删除选中值
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' || !state.selectedValue || state.search.trim()) return
    if (e.target.closest('ui5-input,ui5-textarea,input,textarea')) return
    const hit = getNode(state.path)
    if (!hit || hit.readonly) return
    const name = state.selectedValue
    openConfirm(`删除值 “${name}”？`, () => { state.selectedValue = null; afterEdit(deleteValue(state.path, name)) })
  })

  // 地址栏：面包屑跳转 / 编辑模式
  root.querySelector('#regAddr').addEventListener('click', (e) => {
    if (e.target.closest('.reg-addr-edit')) {
      const box = root.querySelector('#regAddr')
      box.innerHTML = `<ui5-icon name="key" class="reg-addr-icon"></ui5-icon>
        <ui5-input id="regAddrInput" style="flex:1" value="${esc(pathStr(state.path))}"></ui5-input>`
      const input = box.querySelector('#regAddrInput')
      input.focus()
      const commit = () => {
        const segs = parsePath(input.value)
        if (!segs.length || !navigateTo(segs)) renderAddr()
      }
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') renderAddr() })
      input.addEventListener('focusout', () => setTimeout(renderAddr, 150))
      return
    }
    const crumb = e.target.closest('.reg-crumb')
    if (crumb) navigateTo(crumb.dataset.path.split('\\'))
  })

  // 搜索：输入防抖
  let searchTimer = 0
  root.querySelector('#regSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.search = e.target.value || ''
      renderValues()
    }, 250)
  })
  root.querySelector('#regSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.search = ''; renderValues() }
  })

  // 工具栏
  root.querySelector('#tbNewKey').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect()
    treeMenu(state.path, r.left, r.bottom + 4)
  })
  root.querySelector('#tbExport').addEventListener('click', () => doExport(state.path))
  root.querySelector('#tbImport').addEventListener('click', () => doImport(state.path))
  root.querySelector('#tbRefresh').addEventListener('click', async () => {
    await rebuildReadonly()
    renderAll()
    showCmxToast('已刷新（只读根已重建）', { level: 'info' })
  })
  root.querySelector('#tbReset').addEventListener('click', () => {
    openConfirm('恢复出厂注册表？本地全部修改将丢失。', () => {
      state.db = defaultDb()
      saveDb(true)
      navigateTo(DEFAULT_PATH.slice(0, 1))
      showCmxToast('已恢复出厂注册表', { level: 'info' })
    })
  })
}

// ─── 只读根构建 ──────────────────────────────────────────────────────────
async function rebuildReadonly() {
  state.roRoots = {}
  try {
    state.roRoots.HKEY_PORTAL_RUNTIME = await buildRuntimeRoot()
  } catch (e) {
    state.roRoots.HKEY_PORTAL_RUNTIME = mkKey({
      [DEFAULT_VALUE_NAME]: mkVal('REG_SZ', 'DAM 数据不可用：' + e.message),
    })
  }
  state.roRoots.HKEY_CURRENT_CONFIG = buildConfigRoot()
}

// ─── whenRendered ────────────────────────────────────────────────────────
function whenRendered(host, selector, cb, tries) {
  const t = tries == null ? 60 : tries
  const root = host && host.renderRoot
  if (root && root.querySelector(selector)) { cb(root); return }
  if (t <= 0) return
  requestAnimationFrame(() => whenRendered(host, selector, cb, t - 1))
}

// ─── 样式 ────────────────────────────────────────────────────────────────
const STYLE = `
<style>
.reg-root{
  --reg-bg:#0b0f17; --reg-bg2:#0e1421; --reg-panel:#101a2b; --reg-hover:#16233a;
  --reg-line:rgba(0,180,216,.16); --reg-line-strong:rgba(0,180,216,.42);
  --reg-cyan:var(--neo-cyan,#00b4d8); --reg-violet:var(--neo-violet,#7c3aed);
  --reg-mint:var(--neo-mint,#10b981); --reg-warn:var(--neo-warn,#f59e0b);
  --reg-text:#d5e3f5; --reg-dim:#7d8fb0;
  display:flex;flex-direction:column;height:100%;box-sizing:border-box;
  background:
    radial-gradient(900px 300px at 85% -60px, rgba(124,58,237,.14), transparent 60%),
    radial-gradient(700px 260px at -5% 110%, rgba(0,180,216,.12), transparent 55%),
    var(--reg-bg);
  color:var(--reg-text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  font-size:13px;overflow:hidden;
}
.reg-root *{box-sizing:border-box}
.reg-mono{font-family:"SF Mono",Menlo,Consolas,monospace}

/* 顶栏 */
.reg-top{display:flex;align-items:center;gap:10px;padding:8px 12px;
  background:linear-gradient(180deg,rgba(0,180,216,.09),transparent);
  border-bottom:1px solid var(--reg-line)}
.reg-logo{display:flex;align-items:center;gap:8px;font-weight:800;letter-spacing:.04em;
  color:var(--reg-cyan);text-shadow:0 0 14px rgba(0,180,216,.45);white-space:nowrap}
.reg-logo ui5-icon{font-size:18px}
.reg-addr{flex:1;display:flex;align-items:center;gap:4px;min-width:0;padding:3px 10px;
  background:var(--reg-bg2);border:1px solid var(--reg-line);border-radius:6px;
  font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.reg-addr-icon{color:var(--reg-cyan);margin-right:4px}
.reg-crumb{cursor:pointer;padding:1px 3px;border-radius:3px;white-space:nowrap}
.reg-crumb:hover{background:var(--reg-hover);color:var(--reg-cyan)}
.reg-sep{color:var(--reg-dim)}
.reg-addr-edit{margin-left:auto}
.reg-search{width:230px}
.reg-toolbar{display:flex;align-items:center;gap:2px;padding:4px 8px;
  border-bottom:1px solid var(--reg-line);background:var(--reg-bg2)}
.reg-toolbar ui5-button{--sapButton_TextColor:var(--reg-dim)}
.reg-toolbar ui5-button:hover{--sapButton_TextColor:var(--reg-cyan)}

/* 主区 */
.reg-main{flex:1;display:flex;min-height:0}
.reg-tree-box{width:300px;min-width:180px;overflow:auto;padding:6px 4px;
  border-right:1px solid var(--reg-line);background:rgba(14,20,33,.6)}
.reg-values-box{flex:1;overflow:auto;min-width:0}
.reg-splitter{width:4px;cursor:col-resize;flex:0 0 auto}
.reg-splitter:hover,.reg-splitter.on{background:var(--reg-line-strong)}

/* 树 */
.reg-tnode{display:flex;align-items:center;gap:4px;height:24px;padding-right:6px;
  cursor:pointer;border-radius:4px;white-space:nowrap;user-select:none}
.reg-tnode:hover{background:var(--reg-hover)}
.reg-tnode.sel{background:rgba(0,180,216,.16);box-shadow:inset 2px 0 0 var(--reg-cyan)}
.reg-tnode.sel .reg-tname{color:var(--reg-cyan)}
.reg-tarrow{font-size:10px;color:var(--reg-dim);transition:transform .12s;width:14px;flex:0 0 auto}
.reg-tarrow.open{transform:rotate(90deg)}
.reg-tarrow.none{visibility:hidden}
.reg-ticon{font-size:13px;color:var(--reg-cyan);flex:0 0 auto}
.reg-ticon.ro{color:var(--reg-dim)}
.reg-tname{overflow:hidden;text-overflow:ellipsis}

/* 值表 */
.reg-vtable{width:100%;border-collapse:collapse;font-size:12.5px}
.reg-vtable th{position:sticky;top:0;text-align:left;padding:7px 10px;color:var(--reg-dim);
  font-weight:600;font-size:11px;letter-spacing:.06em;
  background:var(--reg-bg2);border-bottom:1px solid var(--reg-line);z-index:1}
.reg-vtable td{padding:5px 10px;border-bottom:1px solid rgba(0,180,216,.07)}
.reg-vrow{cursor:pointer}
.reg-vrow:hover{background:var(--reg-hover)}
.reg-vrow.sel{background:rgba(0,180,216,.14)}
.reg-vname{color:var(--reg-text);font-weight:600}
.reg-vdata{font-family:"SF Mono",Menlo,Consolas,monospace;color:var(--reg-dim);
  word-break:break-all}
.reg-vrow.sel .reg-vdata{color:var(--reg-text)}
.reg-badge{display:inline-block;padding:0 7px;border-radius:8px;font-size:10.5px;font-weight:700;
  font-family:"SF Mono",Menlo,Consolas,monospace;
  color:var(--bc);border:1px solid var(--bc);background:color-mix(in srgb,var(--bc) 12%,transparent)}
.reg-ro{color:var(--reg-dim);font-size:11px}
.reg-empty{padding:22px;text-align:center;color:var(--reg-dim)}
.reg-search-head{position:sticky;top:0;padding:8px 12px;color:var(--reg-cyan);
  background:var(--reg-bg2);border-bottom:1px solid var(--reg-line);z-index:1}
.reg-srow{cursor:pointer}
.reg-srow:hover{background:var(--reg-hover)}

/* 状态栏 */
.reg-status{display:flex;align-items:center;gap:16px;padding:5px 12px;
  border-top:1px solid var(--reg-line);background:var(--reg-bg2);
  font-size:11.5px;color:var(--reg-dim);font-family:"SF Mono",Menlo,Consolas,monospace}
.reg-status-path{color:var(--reg-cyan);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reg-status-item{white-space:nowrap}
.reg-flash{margin-left:auto;color:var(--reg-mint);opacity:0;transition:opacity .3s}
.reg-flash.on{opacity:1}

/* 右键菜单 */
.reg-menu{position:fixed;z-index:9999;min-width:190px;padding:4px;
  background:var(--reg-panel);border:1px solid var(--reg-line-strong);border-radius:8px;
  box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 18px rgba(0,180,216,.12)}
.reg-menu-item{padding:6px 12px;border-radius:5px;cursor:pointer;white-space:nowrap}
.reg-menu-item:hover{background:rgba(0,180,216,.14);color:var(--reg-cyan)}
.reg-menu-item.off{opacity:.38;pointer-events:none}
.reg-menu-sep{height:1px;margin:4px 8px;background:var(--reg-line)}

/* 对话框表单 */
.reg-form-row{margin-bottom:12px}
.reg-form-row label{display:block;margin-bottom:4px;color:var(--reg-dim);font-size:12px}
.reg-err{margin-top:6px;color:var(--sapNegativeColor,#bb0000);font-size:12px;min-height:16px}

/* 滚动条 */
.reg-tree-box::-webkit-scrollbar,.reg-values-box::-webkit-scrollbar{width:8px;height:8px}
.reg-tree-box::-webkit-scrollbar-thumb,.reg-values-box::-webkit-scrollbar-thumb{
  background:rgba(0,180,216,.22);border-radius:4px}
.reg-tree-box::-webkit-scrollbar-thumb:hover,.reg-values-box::-webkit-scrollbar-thumb:hover{
  background:rgba(0,180,216,.4)}
.reg-tree-box::-webkit-scrollbar-track,.reg-values-box::-webkit-scrollbar-track{background:transparent}
</style>`

// ─── 入口 ────────────────────────────────────────────────────────────────
export default {
  defaultView: 'content',
  views: {
    async content(ctx) {
      // 重置易变状态（同页多实例防污染）
      state.db = loadDb()
      state.path = DEFAULT_PATH.slice(0, 1)
      state.expanded = new Set([pathStr(DEFAULT_PATH.slice(0, 1)), pathStr(DEFAULT_PATH.slice(0, 2)), pathStr(DEFAULT_PATH.slice(0, 3))])
      state.selectedValue = null
      state.search = ''
      state.savedAt = ''
      state.host = ctx && ctx.host
      await rebuildReadonly()

      if (state.host) {
        whenRendered(state.host, '.reg-root', () => {
          bindEvents()
          renderAll()
          navigateTo(DEFAULT_PATH, true)
          // 拖动分栏
          const root = state.host.renderRoot
          const sp = root.querySelector('#regSplitter')
          const treeBox = root.querySelector('#regTree')
          sp.addEventListener('pointerdown', (e) => {
            sp.classList.add('on')
            sp.setPointerCapture(e.pointerId)
            const startX = e.clientX
            const startW = treeBox.getBoundingClientRect().width
            const move = (ev) => {
              const w = Math.max(160, Math.min(560, startW + ev.clientX - startX))
              treeBox.style.width = w + 'px'
            }
            const up = () => {
              sp.classList.remove('on')
              sp.removeEventListener('pointermove', move)
              sp.removeEventListener('pointerup', up)
            }
            sp.addEventListener('pointermove', move)
            sp.addEventListener('pointerup', up)
          })
        })
      }

      return `${STYLE}
<div class="reg-root">
  <div class="reg-top">
    <div class="reg-logo"><ui5-icon name="database"></ui5-icon><span>REGISTRY</span></div>
    <div id="regAddr" class="reg-addr"></div>
    <ui5-input id="regSearch" class="reg-search" placeholder="搜索项 / 值 / 数据…" show-clear-icon>
      <ui5-icon slot="icon" name="search"></ui5-icon>
    </ui5-input>
  </div>
  <div class="reg-toolbar">
    <ui5-button id="tbNewKey" icon="add" design="Transparent" title="在当前项下新建">新建</ui5-button>
    <ui5-button id="tbImport" icon="upload" design="Transparent" title="导入 .json 到当前项">导入</ui5-button>
    <ui5-button id="tbExport" icon="download" design="Transparent" title="导出当前项为 .json">导出</ui5-button>
    <ui5-button id="tbRefresh" icon="refresh" design="Transparent" title="刷新（重建只读根）">刷新</ui5-button>
    <ui5-button id="tbReset" icon="reset" design="Transparent" title="恢复出厂注册表">重置</ui5-button>
  </div>
  <div class="reg-main">
    <div id="regTree" class="reg-tree-box"></div>
    <div id="regSplitter" class="reg-splitter"></div>
    <div id="regValues" class="reg-values-box"></div>
  </div>
  <div id="regStatus" class="reg-status"></div>
  <input id="regFile" type="file" accept=".json,application/json" style="display:none">
  <ui5-dialog id="regDlg">
    <ui5-bar slot="header" design="Header">
      <ui5-title id="regDlgTitle" slot="startContent" level="H5"></ui5-title>
    </ui5-bar>
    <div id="regDlgBody" style="min-width:380px;max-width:560px;padding:10px 16px;"></div>
    <ui5-bar slot="footer" design="Footer">
      <ui5-button id="regDlgOk" slot="endContent" design="Emphasized">确定</ui5-button>
      <ui5-button id="regDlgCancel" slot="endContent">取消</ui5-button>
    </ui5-bar>
  </ui5-dialog>
</div>`
    },
  },
}
