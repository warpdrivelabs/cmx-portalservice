const state = {
  registry: { domains: [], applications: [], modules: [] },
  selectedKind: 'module',
  selectedKey: '',
  selectedKeys: { domain: '', application: '', module: '' },
  draft: null,
  drafts: { domain: null, application: null, module: null },
  loading: null,
  filter: { domain: '', application: '' },
  resources: { moduleKey: '', loading: false, html: '<cmx-empty-state icon="detail-view" title="选择模块后查看资源清单" size="sm"></cmx-empty-state>' },
  split: { explorerY: 62, contentX: 48, appY: 62, moduleY: 62 },
  scrollTop: { domain: 0, application: 0, module: 0 },
  hosts: new Set(),
  loadingPromise: null,
}

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

// ─── DB 编码与 payload 转换 ──────────────────────────────────────────────
// 仅写操作（create/update/delete）需要转 DB 风格；读路径仍用 registry shape。
// 取数据库真实主键（雪花号），用于 update/delete 的 id 参数。
// registry 数据从 /api/registry/dam 返回，每条记录带 dbId 字段。
function dbDomainId (d) { return d.dbId || d.id }
function dbAppId (a) { return a.dbId || dbAppCode(a) }
function dbModuleId (m) { return m.dbId || dbModuleCode(m) }
// 业务 code（拼接规则，用于 create payload 的 code 字段）。
function dbDomainCode (d) { return d.id }
function dbAppCode (a) { return `${a.domain}_${a.id}` }
function dbModuleCode (m) { return `${m.domain}_${(m.application || m.app)}_${m.id || m.module}` }

// draft → DB create payload（字段名转 DB 风格）。
function toCreatePayload (kind, d) {
  if (kind === 'domain') return {
    code: d.id, name: d.name, title: d.title, icon: d.icon,
    description: d.description,
    status: d.status === 'active' ? 1 : 0,
    sort_order: d.sortOrder || 0,
  }
  if (kind === 'application') return {
    code: dbAppCode(d), domain_code: d.domain, name: d.name, title: d.title,
    icon: d.icon, description: d.description,
    status: d.status === 'active' ? 1 : 0,
    sort_order: d.sortOrder || 0,
  }
  // module
  return {
    code: dbModuleCode(d), domain_code: d.domain,
    application_code: dbAppCode({ domain: d.domain, id: (d.application || d.app) }),
    name: d.name, title: d.title, icon: d.icon, description: d.description,
    tags: JSON.stringify(d.aliases || []),
    resource_root: d.resourceRoot || `${d.domain}/${(d.application || d.app)}/${d.id}`,
    manifest_path: d.manifestPath || `modules/${d.domain}/${(d.application || d.app)}/${d.id}/module.json`,
    status: d.status === 'active' ? 1 : 0,
    sort_order: d.sortOrder || 0,
  }
}

// draft → DB update payload（同 create 但 code 不可改，不传 code）。
function toUpdatePayload (kind, d) {
  const p = toCreatePayload(kind, d)
  delete p.code
  return p
}

// kind → DB CRUD 端点前缀（domain/application 复数，module 单数）。
function dbEndpoint (kind) {
  return kind === 'domain' ? '/api/domains' : kind === 'application' ? '/api/applications' : '/api/module'
}

function keyOf (kind, item) {
  if (!item) return ''
  if (kind === 'domain') return item.id
  if (kind === 'application') return `${item.domain}/${item.id}`
  return `${item.domain}/${item.application || item.app}/${item.id || item.module}`
}

function titleOf (kind, item) {
  if (!item) return ''
  if (kind === 'domain') return `${item.name || item.id} (${item.id})`
  if (kind === 'application') return `${item.name || item.id} (${item.domain}/${item.id})`
  return `${item.title || item.name || item.id} (${item.domain}/${item.application || item.app}/${item.id || item.module})`
}

function lists () {
  const all = rawLists()
  const domain = state.filter.domain || ''
  const appKey = state.filter.application || ''
  const appId = appKey.includes('/') ? appKey.split('/')[1] : appKey
  return {
    domains: all.domains,
    applications: domain ? all.applications.filter((x) => x.domain === domain) : all.applications,
    modules: all.modules.filter((x) => {
      if (domain && x.domain !== domain) return false
      if (appId && (x.application || x.app) !== appId) return false
      return true
    }),
  }
}

function rawLists () {
  return {
    domains: state.registry.domains || [],
    applications: state.registry.applications || state.registry.apps || [],
    modules: state.registry.modules || [],
  }
}

function applicationKey (domain, app) {
  return domain && app ? `${domain}/${app}` : ''
}

function setFilterFromItem (kind, item) {
  if (!item) return
  if (kind === 'domain') {
    state.filter.domain = item.id || ''
    state.filter.application = ''
    return
  }
  if (kind === 'application') {
    state.filter.domain = item.domain || ''
    state.filter.application = applicationKey(item.domain, item.id)
    return
  }
  state.filter.domain = item.domain || ''
  state.filter.application = applicationKey(item.domain, item.application || item.app)
}

function syncSelectedKeysFromFilters () {
  state.selectedKeys.domain = state.filter.domain || ''
  state.selectedKeys.application = state.filter.application || ''
  if (state.selectedKind === 'module') state.selectedKeys.module = state.selectedKey || ''
  else state.selectedKeys.module = ''
}

function reconcileSelection () {
  const all = lists()
  syncSelectedKeysFromFilters()
  const selected = state.selectedKey ? findSelected() : null
  if (selected) {
    const visible = state.selectedKind === 'domain'
      ? all.domains.some((x) => keyOf('domain', x) === state.selectedKey)
      : state.selectedKind === 'application'
        ? all.applications.some((x) => keyOf('application', x) === state.selectedKey)
        : all.modules.some((x) => keyOf('module', x) === state.selectedKey)
    if (visible) {
      setFilterFromItem(state.selectedKind, selected)
      syncSelectedKeysFromFilters()
      state.draft = structuredClone(selected)
      return
    }
  }
  // 回退：优先选第一个 domain（左侧列表第一项成为初始焦点，符合直觉），
  // 再回退到 application、module。
  const firstDomain = all.domains[0]
  const firstApp = all.applications[0]
  const firstModule = all.modules[0]
  if (firstDomain) selectItem('domain', keyOf('domain', firstDomain), false)
  else if (firstApp) selectItem('application', keyOf('application', firstApp), false)
  else if (firstModule) selectItem('module', keyOf('module', firstModule), false)
  else {
    state.selectedKey = ''
    state.draft = null
  }
}

async function loadRegistry () {
  // 幂等：多个视图入口（manager/explorer/property）共享同一次加载，
  // 避免进入页面时 /api/registry/dam 被重复调用三次。
  // 写操作（save/delete）后会调 resetRegistryLoad() 清缓存强制刷新。
  if (state.loadingPromise) return state.loadingPromise
  state.loadingPromise = (async () => {
    state.registry = await apiJson('/api/registry/dam')
    reconcileSelection()
  })().finally(() => { state.loadingPromise = null })
  return state.loadingPromise
}

// 写操作后调用，清掉幂等缓存，使下次 loadRegistry 重新拉取。
function resetRegistryLoad () {
  state.loadingPromise = null
}

function refreshAll () {
  for (const host of Array.from(state.hosts)) {
    if (host && host.isConnected) renderInto(host)
    else state.hosts.delete(host)
  }
}

function findSelected () {
  const all = rawLists()
  if (state.selectedKind === 'domain') return all.domains.find((x) => keyOf('domain', x) === state.selectedKey)
  if (state.selectedKind === 'application') return all.applications.find((x) => keyOf('application', x) === state.selectedKey)
  return all.modules.find((x) => keyOf('module', x) === state.selectedKey)
}

function findItem (kind, key) {
  const all = rawLists()
  if (kind === 'domain') return all.domains.find((x) => keyOf('domain', x) === key)
  if (kind === 'application') return all.applications.find((x) => keyOf('application', x) === key)
  return all.modules.find((x) => keyOf('module', x) === key)
}

function setDraftForKind (kind, item) {
  const draft = structuredClone(item || newDraft(kind))
  state.drafts[kind] = draft
  if (state.selectedKind === kind) state.draft = draft
  return draft
}

function getDraftForKind (kind) {
  if (!state.drafts[kind]) setDraftForKind(kind, findItem(kind, state.selectedKeys[kind]))
  return state.drafts[kind] || newDraft(kind)
}

function selectItem (kind, key, redraw = true) {
  const item = findItem(kind, key)
  if (kind === 'domain') {
    state.selectedKeys.domain = key
    state.filter.domain = item?.id || key || ''
    setDraftForKind('domain', item)
    const firstApp = rawLists().applications.find((x) => x.domain === state.filter.domain)
    if (firstApp) {
      state.selectedKeys.application = keyOf('application', firstApp)
      state.filter.application = state.selectedKeys.application
      setDraftForKind('application', firstApp)
    } else {
      state.selectedKeys.application = ''
      state.filter.application = ''
      state.drafts.application = newDraft('application')
    }
    const firstModule = lists().modules[0]
    state.selectedKind = firstModule ? 'module' : firstApp ? 'application' : 'domain'
    state.selectedKey = firstModule ? keyOf('module', firstModule) : firstApp ? keyOf('application', firstApp) : key
    state.selectedKeys.module = firstModule ? state.selectedKey : ''
    setDraftForKind('module', firstModule)
  } else if (kind === 'application') {
    state.selectedKeys.application = key
    setFilterFromItem(kind, item)
    state.selectedKeys.domain = state.filter.domain || ''
    setDraftForKind('domain', findItem('domain', state.selectedKeys.domain))
    setDraftForKind('application', item)
    const firstModule = lists().modules[0]
    state.selectedKind = firstModule ? 'module' : 'application'
    state.selectedKey = firstModule ? keyOf('module', firstModule) : key
    state.selectedKeys.module = firstModule ? state.selectedKey : ''
    setDraftForKind('module', firstModule)
  } else {
    state.selectedKind = kind
    state.selectedKey = key
    setFilterFromItem(kind, item)
    state.selectedKeys.domain = state.filter.domain || ''
    state.selectedKeys.application = state.filter.application || ''
    state.selectedKeys.module = key
    setDraftForKind('domain', findItem('domain', state.selectedKeys.domain))
    setDraftForKind('application', findItem('application', state.selectedKeys.application))
    setDraftForKind('module', item)
  }
  const selected = findSelected()
  state.draft = state.drafts[state.selectedKind] || structuredClone(selected || item || newDraft(state.selectedKind))
  if (redraw) refreshAll()
}

function newDraft (kind) {
  const all = rawLists()
  const domain = state.filter.domain || all.domains[0]?.id || 'fi'
  const filteredApps = all.applications.filter((a) => !domain || a.domain === domain)
  const selectedApp = state.filter.application && state.filter.application.startsWith(`${domain}/`)
    ? state.filter.application.split('/')[1]
    : ''
  const app = selectedApp || filteredApps[0]?.id || 'cmxfico'
  if (kind === 'domain') return { id: '', name: '', title: '', icon: '', status: 'active', description: '', sortOrder: 0 }
  if (kind === 'application') return { domain, id: '', name: '', title: '', icon: '', status: 'active', description: '', sortOrder: 0 }
  return {
    domain,
    application: app,
    app,
    id: '',
    module: '',
    name: '',
    title: '',
    icon: '',
    status: 'active',
    description: '',
    resourceRoot: '',
    manifestPath: '',
    aliases: [],
    sortOrder: 0,
  }
}

function startNew (kind) {
  state.selectedKind = kind
  state.selectedKey = ''
  if (kind === 'domain') {
    state.filter.domain = ''
    state.filter.application = ''
    state.selectedKeys.domain = ''
    state.selectedKeys.application = ''
    state.selectedKeys.module = ''
  } else if (kind === 'application') {
    state.filter.application = ''
    state.selectedKeys.application = ''
    state.selectedKeys.module = ''
  } else {
    state.selectedKeys.module = ''
  }
  state.drafts[kind] = newDraft(kind)
  state.draft = state.drafts[kind]
  refreshAll()
}

function setDraft (field, value, kind = state.selectedKind) {
  const draft = getDraftForKind(kind)
  if (field === 'aliases') {
    draft.aliases = String(value || '').split(',').map((x) => x.trim()).filter(Boolean)
  } else if (field === 'sortOrder') {
    // 排序值转整数（空值/非法值回 0）
    const n = parseInt(value, 10)
    draft.sortOrder = Number.isFinite(n) ? n : 0
  } else {
    draft[field] = value
    if (field === 'application') draft.app = value
    if (field === 'id' && kind === 'module') draft.module = value
  }
  state.drafts[kind] = draft
  if (state.selectedKind === kind) state.draft = draft
}

async function reloadRegistry (message = '') {
  state.loading = '加载中...'
  refreshAll()
  try {
    resetRegistryLoad()
    await loadRegistry()
    if (message) showCmxToast(message, { level: 'success' })
  } finally {
    state.loading = null
  }
  refreshAll()
}

async function saveDraft (kind = state.selectedKind) {
  const draft = getDraftForKind(kind) || {}
  const originalKey = state.selectedKeys[kind] || ''
  const base = dbEndpoint(kind)
  let saved
  if (originalKey) {
    // 编辑：POST /{base}/update，body = { id: dbId, data: payload }
    // id 用数据库真实主键（雪花号），从 registry 数据的 dbId 字段取。
    const existing = findItem(kind, originalKey)
    const dbId = kind === 'domain'
      ? dbDomainId(existing || draft)
      : kind === 'application'
        ? dbAppId(existing || draft)
        : dbModuleId(existing || draft)
    await apiJson(`${base}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dbId, data: toUpdatePayload(kind, draft) }),
    })
    saved = draft
  } else {
    // 新增：POST /{base}/create，body = payload
    await apiJson(`${base}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toCreatePayload(kind, draft)),
    })
    saved = draft
  }
  state.selectedKey = keyOf(kind, saved)
  state.selectedKind = kind
  setFilterFromItem(kind, saved)
  syncSelectedKeysFromFilters()
  if (kind === 'domain') state.selectedKeys.domain = state.selectedKey
  if (kind === 'application') state.selectedKeys.application = state.selectedKey
  if (kind === 'module') state.selectedKeys.module = state.selectedKey
  resetRegistryLoad()
  await loadRegistry()
  showCmxToast('已保存', { level: 'success' })
  refreshAll()
}

async function deleteSelected () {
  if (!state.selectedKey) return
  await deleteItem(state.selectedKind, state.selectedKey)
}

async function deleteSelectedKind (kind) {
  const key = state.selectedKeys[kind] || ''
  if (!key) return
  await deleteItem(kind, key)
}

async function deleteItem (kind, key) {
  if (!key) return
  const item = findItem(kind, key)
  if (!item) return
  const C = (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}
  const ok = typeof C.cmxConfirm === 'function'
    ? await C.cmxConfirm({ message: `确认删除 ${titleOf(kind, item)}？`, intent: 'danger', confirmText: '删除' })
    : window.confirm(`确认删除 ${titleOf(kind, item)}？`)
  if (!ok) return
  const dbId = kind === 'domain'
    ? dbDomainId(item)
    : kind === 'application'
      ? dbAppId(item)
      : dbModuleId(item)
  const url = `${dbEndpoint(kind)}/delete`
  await apiJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [dbId] }),
  })
  if (state.selectedKind === kind && state.selectedKey === key) {
    state.selectedKey = ''
    state.draft = null
  }
  if (state.selectedKeys[kind] === key) state.selectedKeys[kind] = ''
  if (kind === 'domain' && state.filter.domain === item.id) {
    state.filter.domain = ''
    state.filter.application = ''
    state.selectedKeys.application = ''
    state.selectedKeys.module = ''
  } else if (kind === 'application' && state.filter.application === key) {
    state.filter.application = ''
    state.selectedKeys.module = ''
  }
  resetRegistryLoad()
  await loadRegistry()
  showCmxToast('已删除', { level: 'success' })
  refreshAll()
}

function renderResourcesInto (root) {
  const el = root.querySelector('[data-resources]')
  if (el) el.innerHTML = state.resources.html || '<cmx-empty-state icon="detail-view" title="选择模块后查看资源清单" size="sm"></cmx-empty-state>'
}

async function loadResources (root, force = false) {
  const item = state.selectedKeys.module ? findItem('module', state.selectedKeys.module) : null
  if (!item) {
    state.resources = { moduleKey: '', loading: false, html: '<cmx-empty-state icon="detail-view" title="选择模块后查看资源清单" size="sm"></cmx-empty-state>' }
    renderResourcesInto(root)
    return
  }
  const moduleKey = keyOf('module', item)
  if (!force && state.resources.moduleKey === moduleKey && state.resources.html) {
    renderResourcesInto(root)
    return
  }
  if (state.resources.loading && state.resources.moduleKey === moduleKey) {
    renderResourcesInto(root)
    return
  }
  state.resources = { moduleKey, loading: true, html: '<cmx-empty-state icon="synchronize" title="加载资源清单..." size="sm"></cmx-empty-state>' }
  renderResourcesInto(root)
  const types = [
    { key: 'menus', label: '菜单' },
    { key: 'htmlPages', label: 'HTML 页面' },
    { key: 'metaDefinitions', label: '元数据定义' },
    { key: 'flexibleCombinations', label: '弹性组合' },
    { key: 'serviceCatalog', label: '服务目录' },
  ]
  const rows = []
  for (const t of types) {
    try {
      const data = await apiJson(`/api/modules/${encodeURIComponent(item.domain)}/${encodeURIComponent(item.application || item.app)}/${encodeURIComponent(item.id || item.module)}/resources/${encodeURIComponent(t.key)}`)
      const resources = data.resources || []
      rows.push(...resources.map((r) => ({ type: t.label, ...r })))
    } catch (err) {
      rows.push({ type: t.label, path: err.message || String(err), exists: false, kind: 'error' })
    }
  }
  state.resources = { moduleKey, loading: false, html: `<div class="dam-res-table-wrap"><table class="dam-table dam-neo-table">
    <thead><tr><th>类型</th><th>路径</th><th>状态</th></tr></thead>
    <tbody>${rows.map((r) => {
      const ok = !!r.exists && r.kind !== 'error'
      const st = r.kind === 'error' ? 'err' : ok ? 'ok' : 'miss'
      const stText = r.kind === 'error' ? '异常' : ok ? '已挂载' : '缺失'
      return `<tr><td><span class="dam-res-type">${esc(r.type)}</span></td><td class="dam-res-path">${esc(r.path)}</td><td><span class="dam-res-status" data-st="${st}">${stText}${r.kind && r.kind !== 'error' ? ` · ${esc(r.kind)}` : ''}</span></td></tr>`
    }).join('')}</tbody>
  </table></div>` }
  renderResourcesInto(root)
}

function renderList (kind, title, items, options = {}) {
  const fallbackIcon = kind === 'domain' ? 'dimension' : kind === 'application' ? 'application' : 'tree'
  const hue = kind === 'domain' ? 'domain' : kind === 'application' ? 'app' : 'module'
  return `<section class="dam-list-panel dam-neo-panel" data-kind-panel="${kind}">
    <div class="dam-list-head dam-neo-head" data-hue="${hue}">
      <span class="dam-neo-head-main"><ui5-icon class="dam-neo-head-icon" name="${fallbackIcon}"></ui5-icon><span>${esc(title)}</span><span class="dam-neo-badge">${items.length}</span></span>
      <span class="dam-card-actions">${options.refresh ? '<button class="dam-icon-btn" type="button" title="刷新" aria-label="刷新" data-action="refresh"><ui5-icon name="refresh"></ui5-icon></button>' : ''}<button class="dam-icon-btn" type="button" title="新建" aria-label="新建" data-new="${kind}"><ui5-icon name="add"></ui5-icon></button></span>
    </div>
    <div class="dam-list-body" data-list-body="${kind}">
      ${items.map((item) => {
        const key = keyOf(kind, item)
        const icon = item.icon || fallbackIcon
        return `<div class="dam-list-item ${state.selectedKeys[kind] === key ? 'active' : ''}" role="button" tabindex="0" data-kind="${kind}" data-key="${esc(key)}">
          <span class="dam-list-icon"><ui5-icon name="${esc(icon)}"></ui5-icon></span>
          <span class="dam-list-text"><strong>${esc(item.name || item.title || item.id)}</strong><span>${esc(key)}</span></span>
          <button class="dam-list-delete" type="button" title="删除" aria-label="删除 ${esc(item.name || item.title || item.id)}" data-delete-kind="${kind}" data-delete-key="${esc(key)}"><ui5-icon name="delete"></ui5-icon></button>
        </div>`
      }).join('') || '<cmx-empty-state icon="inbox" title="暂无数据" size="sm"></cmx-empty-state>'}
    </div>
  </section>`
}

const DAM_KIND_META = {
  domain: { label: 'Domain', icon: 'dimension', hue: 'domain' },
  application: { label: 'Application', icon: 'application', hue: 'app' },
  module: { label: 'Module', icon: 'tree', hue: 'module' },
}

function draftKeyText (kind, d) {
  if (!d) return 'NEW'
  if (kind === 'domain') return d.id || 'NEW_DOMAIN'
  if (kind === 'application') return `${d.domain || 'domain'}/${d.id || 'NEW_APP'}`
  return `${d.domain || 'domain'}/${d.application || d.app || 'app'}/${d.id || d.module || 'NEW_MODULE'}`
}

function draftTitleText (kind, d) {
  if (!d) return '新建实体'
  return d.title || d.name || d.id || d.module || `新建 ${DAM_KIND_META[kind]?.label || kind}`
}

function draftScore (kind, d) {
  const fields = kind === 'module'
    ? ['domain', 'application', 'id', 'name', 'title', 'icon', 'status', 'resourceRoot', 'manifestPath']
    : kind === 'application'
      ? ['domain', 'id', 'name', 'title', 'icon', 'status']
      : ['id', 'name', 'title', 'icon', 'status']
  const filled = fields.filter((f) => {
    const v = f === 'application' ? (d.application || d.app) : (kind === 'module' && f === 'id' ? (d.id || d.module) : d[f])
    return v != null && String(v).trim() !== ''
  }).length
  return Math.round((filled / fields.length) * 100)
}

function fieldHtml (kind, cfg, d) {
  const field = cfg.field
  const value = field === 'application'
    ? (d.application || d.app || '')
    : (kind === 'module' && field === 'id')
      ? (d.id || d.module || '')
    : field === 'aliases'
      ? (Array.isArray(d.aliases) ? d.aliases.join(', ') : (d.aliases || ''))
      : (d[field] || '')
  const readonly = !!cfg.readonly
  const wide = cfg.wide ? ' wide' : ''
  const tone = cfg.tone ? ` data-tone="${esc(cfg.tone)}"` : ''
  const lock = readonly ? '<span class="dam-field-lock">LOCKED</span>' : ''
  const common = `data-field="${esc(field)}" data-field-kind="${esc(kind)}" ${readonly ? 'readonly' : ''} placeholder="${esc(cfg.placeholder || '')}"`
  // select 走 ui5-select（option 弹层跟随 UI5 主题换肤）；readonly 用 disabled，不带 placeholder（ui5-option 恒有值）。
  const control = cfg.type === 'select'
    ? `<ui5-select data-field="${esc(field)}" data-field-kind="${esc(kind)}" ${readonly ? 'disabled' : ''}>${(cfg.options || []).map((o) => `<ui5-option value="${esc(o.value)}"${String(value) === String(o.value) ? ' selected' : ''}>${esc(o.label)}</ui5-option>`).join('')}</ui5-select>`
    : cfg.type === 'textarea'
      ? `<textarea ${common}>${esc(value)}</textarea>`
      : cfg.type === 'number'
        ? `<input type="number" ${common} value="${esc(value)}">`
        : `<input ${common} value="${esc(value)}">`
  const chips = field === 'aliases' && value
    ? `<div class="dam-alias-row">${String(value).split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>`
    : ''
  return `<label class="dam-smart-field${wide}${readonly ? ' readonly' : ''}"${tone}>
    <span class="dam-field-top">
      <span class="dam-field-label"><ui5-icon name="${esc(cfg.icon || 'edit')}"></ui5-icon>${esc(cfg.label)}</span>
      ${lock}
    </span>
    ${control}
    ${chips}
  </label>`
}

function formGroups (kind, d) {
  if (kind === 'domain') {
    return [
      { title: '基础信息', icon: 'key', fields: [
        { label: 'Domain ID', field: 'id', icon: 'key' },
        { label: '名称', field: 'name', icon: 'text' },
        { label: '标题', field: 'title', icon: 'header' },
        { label: '图标', field: 'icon', icon: 'palette' },
        { label: '状态', field: 'status', icon: 'sys-enter-2', tone: 'ok', type: 'select', options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '禁用' }] },
        { label: '排序', field: 'sortOrder', icon: 'sort', type: 'number' },
      ] },
      { title: '说明', icon: 'hint', fields: [
        { label: '说明', field: 'description', icon: 'notes', type: 'textarea', wide: true },
      ] },
    ]
  }
  if (kind === 'application') {
    return [
      { title: '基础信息', icon: 'application', fields: [
        { label: 'Domain', field: 'domain', icon: 'dimension', readonly: true },
        { label: 'Application ID', field: 'id', icon: 'key' },
        { label: '名称', field: 'name', icon: 'text' },
        { label: '标题', field: 'title', icon: 'header' },
        { label: '图标', field: 'icon', icon: 'palette' },
        { label: '状态', field: 'status', icon: 'sys-enter-2', tone: 'ok', type: 'select', options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '禁用' }] },
        { label: '排序', field: 'sortOrder', icon: 'sort', type: 'number' },
      ] },
      { title: '说明', icon: 'hint', fields: [
        { label: '说明', field: 'description', icon: 'notes', type: 'textarea', wide: true },
      ] },
    ]
  }
  return [
    { title: '基础信息', icon: 'tree', fields: [
      { label: 'Domain', field: 'domain', icon: 'dimension', readonly: true },
      { label: 'Application', field: 'application', icon: 'application', readonly: true },
      { label: 'Module ID', field: 'id', icon: 'key' },
      { label: '名称', field: 'name', icon: 'text' },
      { label: '标题', field: 'title', icon: 'header' },
      { label: '图标', field: 'icon', icon: 'palette' },
      { label: '状态', field: 'status', icon: 'sys-enter-2', tone: 'ok', type: 'select', options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '禁用' }] },
      { label: '排序', field: 'sortOrder', icon: 'sort', type: 'number' },
    ] },
    { title: '运行挂载', icon: 'chain-link', fields: [
      { label: '资源根', field: 'resourceRoot', icon: 'folder', wide: true },
      { label: 'Manifest', field: 'manifestPath', icon: 'document-text', wide: true },
      { label: '别名', field: 'aliases', icon: 'tags', wide: true },
    ] },
    { title: '说明', icon: 'hint', fields: [
      { label: '说明', field: 'description', icon: 'notes', type: 'textarea', wide: true },
    ] },
  ]
}

function formHtml (kind) {
  const d = getDraftForKind(kind)
  return `<div class="dam-smart-form">
    ${formGroups(kind, d).map((g) => `<section class="dam-field-cluster">
      <div class="dam-field-cluster-head"><ui5-icon name="${esc(g.icon)}"></ui5-icon><span>${esc(g.title)}</span></div>
      <div class="dam-field-grid">${g.fields.map((f) => fieldHtml(kind, f, d)).join('')}</div>
    </section>`).join('')}
  </div>`
}

function editorHtml (kind, title) {
  const meta = DAM_KIND_META[kind] || DAM_KIND_META.module
  const d = getDraftForKind(kind)
  const score = draftScore(kind, d)
  const icon = d.icon || meta.icon
  const status = d.status || 'draft'
  const heading = title || `${meta.label} 属性`
  return `<section class="dam-card dam-editor-card dam-neo-panel" data-kind-panel="${kind}">
    <div class="dam-card-head dam-neo-head" data-hue="${meta.hue}"><span class="dam-neo-head-main"><ui5-icon class="dam-neo-head-icon" name="${esc(meta.icon)}"></ui5-icon><span>${esc(heading)}</span></span><span class="dam-card-actions"><button class="dam-icon-btn primary" type="button" title="保存" aria-label="保存" data-save-kind="${kind}"><ui5-icon name="save"></ui5-icon></button><button class="dam-icon-btn danger" type="button" title="删除" aria-label="删除" data-delete-selected-kind="${kind}"><ui5-icon name="delete"></ui5-icon></button></span></div>
    <div class="dam-editor-context" data-hue="${meta.hue}">
      <div class="dam-editor-orbit"><ui5-icon name="${esc(icon)}"></ui5-icon></div>
      <div class="dam-editor-id">
        <div class="dam-editor-title">${esc(draftTitleText(kind, d))}</div>
        <div class="dam-editor-key">${esc(draftKeyText(kind, d))}</div>
      </div>
      <div class="dam-editor-meta">
        <div class="dam-editor-score" style="--dam-score:${score}%">
          <span>${score}</span><small>%</small>
        </div>
        <span class="dam-status-pill">${esc(status)}</span>
      </div>
    </div>
    <div class="dam-form">${formHtml(kind)}</div>
  </section>`
}

function damStatsHtml () {
  const all = rawLists()
  return `<div class="dam-neo-kpi-row">
    <div class="dam-neo-kpi" data-hue="domain"><span class="dam-neo-kpi-val">${all.domains.length}</span><span class="dam-neo-kpi-lbl">Domain</span></div>
    <div class="dam-neo-kpi" data-hue="app"><span class="dam-neo-kpi-val">${all.applications.length}</span><span class="dam-neo-kpi-lbl">Application</span></div>
    <div class="dam-neo-kpi" data-hue="module"><span class="dam-neo-kpi-val">${all.modules.length}</span><span class="dam-neo-kpi-lbl">Module</span></div>
  </div>`
}

function pageHtml () {
  const all = lists()
  return `<div class="dam-wrap dam-neo" data-dam-region="content">
    <div class="dam-neo-banner">
      <div class="dam-neo-banner-main">
        <ui5-icon class="dam-neo-banner-icon" name="database"></ui5-icon>
        <div><div class="dam-neo-banner-title">注册编排 · Application · Module 分层治理与属性维护</div></div>
      </div>
      ${damStatsHtml()}
    </div>
    <div class="dam-content-grid" style="--dam-content-left:${state.split.contentX}%">
      <div class="dam-stack" style="--dam-stack-top:${state.split.appY}%">
        ${renderList('application', 'Application', all.applications)}
        <div class="dam-splitter-y" data-split="appY" role="separator" tabindex="0" aria-label="调整区域大小"></div>
        ${editorHtml('application')}
      </div>
      <div class="dam-splitter-x" data-split="contentX" role="separator" tabindex="0" aria-label="调整区域大小"></div>
      <div class="dam-stack" style="--dam-stack-top:${state.split.moduleY}%">
        ${renderList('module', 'Module', all.modules)}
        <div class="dam-splitter-y" data-split="moduleY" role="separator" tabindex="0" aria-label="调整区域大小"></div>
        ${editorHtml('module')}
      </div>
    </div>
  </div>`
}

function explorerHtml () {
  const all = lists()
  return `<div class="dam-wrap dam-explorer-wrap dam-neo" data-dam-region="explorer">
    <div class="dam-explorer-lists" style="--dam-explorer-top:${state.split.explorerY}%">
      ${renderList('domain', 'Domain', all.domains, { refresh: true })}
      <div class="dam-splitter-y" data-split="explorerY" role="separator" tabindex="0" aria-label="调整区域大小"></div>
      ${editorHtml('domain')}
    </div>
  </div>`
}

function propertyHtml () {
  const mod = state.selectedKeys.module ? findItem('module', state.selectedKeys.module) : null
  const modTitle = mod ? (mod.title || mod.name || mod.id || mod.module) : '未选择模块'
  const modKey = mod ? keyOf('module', mod) : '—'
  return `<div class="dam-wrap dam-property-wrap dam-neo" data-dam-region="property">
    <div class="dam-neo-banner dam-neo-banner-compact">
      <div class="dam-neo-banner-main">
        <ui5-icon class="dam-neo-banner-icon" name="ai"></ui5-icon>
        <div><div class="dam-neo-banner-title">${esc(modTitle)} · ${esc(modKey)} · 资源态势</div></div>
      </div>
      <span class="dam-neo-chip">${mod ? 'LIVE' : 'IDLE'}</span>
    </div>
    ${mod ? `<section class="dam-property-resources dam-neo-panel">
      <div class="dam-neo-head" data-hue="module"><span class="dam-neo-head-main"><ui5-icon class="dam-neo-head-icon" name="activity-items"></ui5-icon><span>资源态势</span></span><span class="dam-neo-badge">mount</span></div>
      <div class="dam-resources" data-resources><cmx-empty-state icon="detail-view" title="选择模块后查看资源清单" size="sm"></cmx-empty-state></div>
    </section>` : `<div class="dam-resources" data-resources><cmx-empty-state icon="detail-view" title="选择模块后查看资源清单" size="sm"></cmx-empty-state></div>`}
  </div>`
}

function bindPage (root, mode = 'manager') {
  bindSplitters(root)
  root.querySelectorAll('[data-list-body]').forEach((el) => {
    const kind = el.getAttribute('data-list-body')
    if (kind && Object.prototype.hasOwnProperty.call(state.scrollTop, kind)) {
      el.scrollTop = state.scrollTop[kind] || 0
      el.addEventListener('scroll', () => { state.scrollTop[kind] = el.scrollTop }, { passive: true })
    }
  })
  root.querySelectorAll('[data-kind][data-key]').forEach((btn) => {
    btn.addEventListener('click', () => selectItem(btn.getAttribute('data-kind'), btn.getAttribute('data-key')))
    btn.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      selectItem(btn.getAttribute('data-kind'), btn.getAttribute('data-key'))
    })
  })
  root.querySelectorAll('[data-delete-kind][data-delete-key]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      deleteItem(btn.getAttribute('data-delete-kind'), btn.getAttribute('data-delete-key'))
        .catch((err) => { showCmxToast(err.message || String(err), { level: 'error' }) })
    })
  })
  root.querySelectorAll('[data-new]').forEach((btn) => {
    btn.addEventListener('click', () => startNew(btn.getAttribute('data-new')))
  })
  root.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => setDraft(el.getAttribute('data-field'), el.value, el.getAttribute('data-field-kind') || state.selectedKind))
  })
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => reloadRegistry('已刷新').catch((err) => { state.loading = null; showCmxToast(err.message || String(err), { level: 'error' }) }))
  root.querySelectorAll('[data-save-kind]').forEach((btn) => {
    btn.addEventListener('click', () => saveDraft(btn.getAttribute('data-save-kind') || state.selectedKind).catch((err) => { showCmxToast(err.message || String(err), { level: 'error' }) }))
  })
  root.querySelectorAll('[data-delete-selected-kind]').forEach((btn) => {
    btn.addEventListener('click', () => deleteSelectedKind(btn.getAttribute('data-delete-selected-kind') || state.selectedKind).catch((err) => { showCmxToast(err.message || String(err), { level: 'error' }) }))
  })
  if (mode === 'property') {
    renderResourcesInto(root)
    const moduleKey = state.selectedKeys.module || ''
    if (moduleKey && state.resources.moduleKey !== moduleKey && !state.resources.loading) {
      loadResources(root).catch((err) => {
        state.resources = { moduleKey, loading: false, html: `<cmx-empty-state icon="message-error" title="${esc(err.message || String(err))}" size="sm"></cmx-empty-state>` }
        renderResourcesInto(root)
      })
    }
  }
}

function bindSplitters (root) {
  root.querySelectorAll('[data-split]').forEach((bar) => {
    bar.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      const key = bar.getAttribute('data-split')
      const isX = key === 'contentX'
      const container = isX ? root.querySelector('.dam-content-grid') : bar.parentElement
      if (!key || !container) return
      const rect = container.getBoundingClientRect()
      bar.setPointerCapture?.(ev.pointerId)
      bar.classList.add('is-dragging')
      const move = (e) => {
        const raw = isX
          ? ((e.clientX - rect.left) / rect.width) * 100
          : ((e.clientY - rect.top) / rect.height) * 100
        const v = Math.max(25, Math.min(75, raw))
        state.split[key] = v
        if (key === 'contentX') container.style.setProperty('--dam-content-left', `${v}%`)
        else container.style.setProperty('--dam-stack-top', `${v}%`)
        if (key === 'explorerY') container.style.setProperty('--dam-explorer-top', `${v}%`)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        bar.classList.remove('is-dragging')
        bar.releasePointerCapture?.(ev.pointerId)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up, { once: true })
    })
  })
}

function renderInto (host) {
  const root = host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root')
  if (!root) return
  root.querySelectorAll('[data-list-body]').forEach((el) => {
    const kind = el.getAttribute('data-list-body')
    if (kind && Object.prototype.hasOwnProperty.call(state.scrollTop, kind)) state.scrollTop[kind] = el.scrollTop
  })
  const view = host.getAttribute?.('view')
  const mode = view === 'explorer' ? 'explorer' : view === 'property' ? 'property' : 'manager'
  root.innerHTML = `${styleHtml()}${mode === 'explorer' ? explorerHtml() : mode === 'property' ? propertyHtml() : pageHtml()}`
  bindPage(root, mode)
}

function styleHtml () {
  return `<style>
    .dam-neo{
      --neo-cyan:#00b4d8;--neo-violet: #7c3aed;--neo-mint:#10b981;--neo-warn:#f59e0b;
      --dam-hue-domain:var(--neo-violet);--dam-hue-app:var(--neo-cyan);--dam-hue-module:var(--neo-mint);
      --dam-body-bg:var(--sapList_Background,#fff);
      --dam-head-bg:color-mix(in srgb,var(--neo-cyan) 14%,var(--sapList_HeaderBackground,#eef2f6));
      --dam-head-bg-domain:color-mix(in srgb,var(--dam-hue-domain) 16%,var(--sapList_HeaderBackground,#eef2f6));
      --dam-head-bg-app:color-mix(in srgb,var(--dam-hue-app) 16%,var(--sapList_HeaderBackground,#eef2f6));
      --dam-head-bg-module:color-mix(in srgb,var(--dam-hue-module) 16%,var(--sapList_HeaderBackground,#eef2f6));
      --dam-panel-border:color-mix(in srgb,var(--neo-cyan) 22%,var(--sapGroup_TitleBorderColor,#d9d9d9));
      --cmx-splitter-grip:color-mix(in srgb,var(--sapInformationColor,#0a6ed1) 38%,var(--sapContent_LabelColor,#6a6d70));
      --cmx-splitter-grip-width:30px;
      --dam-region-head-h:32px;
    }
    .dam-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;height:100%;font:13px/1.45 var(--sapFontFamily,Arial,sans-serif);color:var(--sapTextColor,#1d2d3e);background:var(--sapBackgroundColor,#f5f6f7);position:relative;overflow:hidden;box-sizing:border-box}
    .dam-neo::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:0;background:
      radial-gradient(ellipse 90% 55% at 0% 0%,color-mix(in srgb,var(--neo-violet) 9%,transparent),transparent 58%),
      radial-gradient(ellipse 80% 50% at 100% 100%,color-mix(in srgb,var(--neo-cyan) 8%,transparent),transparent 52%),
      linear-gradient(color-mix(in srgb,var(--neo-cyan) 4%,transparent) 1px,transparent 1px),
      linear-gradient(90deg,color-mix(in srgb,var(--neo-cyan) 4%,transparent) 1px,transparent 1px);
      background-size:auto,auto,28px 28px,28px 28px;opacity:.55}
    .dam-neo>*{position:relative;z-index:1}
    .dam-neo-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 var(--dam-region-head-h,40px);min-height:var(--dam-region-head-h,40px);height:var(--dam-region-head-h,40px);padding:0 10px;box-sizing:border-box;border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 22%,var(--sapGroup_TitleBorderColor,#d9d9d9));background:linear-gradient(105deg,var(--dam-head-bg-domain),color-mix(in srgb,var(--dam-hue-app) 12%,var(--sapList_HeaderBackground,#eef2f6)) 55%,var(--dam-body-bg));box-shadow:inset 0 -1px 0 color-mix(in srgb,#fff 28%,transparent)}
    .dam-neo-banner-compact{padding:0 10px}
    .dam-neo-banner-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}
    .dam-neo-banner-icon{width:1.15rem;height:1.15rem;flex-shrink:0;color:var(--neo-cyan);filter:drop-shadow(0 0 8px color-mix(in srgb,var(--neo-cyan) 35%,transparent))}
    .dam-neo-banner-title{font-size:13px;font-weight:700;letter-spacing:.02em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .dam-neo-banner-sub{display:none}
    .dam-neo-kpi-row{display:flex;gap:4px;flex-shrink:0;align-items:center}
    .dam-neo-kpi{min-width:52px;padding:2px 6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--neo-cyan) 18%,var(--sapGroup_TitleBorderColor,#d9d9d9));background:color-mix(in srgb,var(--sapList_Background,#fff) 88%,var(--neo-cyan) 12%);text-align:center}
    .dam-neo-kpi[data-hue="domain"]{border-color:color-mix(in srgb,var(--dam-hue-domain) 28%,transparent);background:color-mix(in srgb,var(--dam-hue-domain) 8%,var(--sapList_Background,#fff))}
    .dam-neo-kpi[data-hue="app"]{border-color:color-mix(in srgb,var(--dam-hue-app) 28%,transparent);background:color-mix(in srgb,var(--dam-hue-app) 8%,var(--sapList_Background,#fff))}
    .dam-neo-kpi[data-hue="module"]{border-color:color-mix(in srgb,var(--dam-hue-module) 28%,transparent);background:color-mix(in srgb,var(--dam-hue-module) 8%,var(--sapList_Background,#fff))}
    .dam-neo-kpi-val{display:block;font-size:13px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums}
    .dam-neo-kpi[data-hue="domain"] .dam-neo-kpi-val{color:var(--dam-hue-domain)}
    .dam-neo-kpi[data-hue="app"] .dam-neo-kpi-val{color:var(--dam-hue-app)}
    .dam-neo-kpi[data-hue="module"] .dam-neo-kpi-val{color:var(--dam-hue-module)}
    .dam-neo-kpi-lbl{display:block;font-size:9px;color:var(--sapContent_LabelColor,#6a6d70);letter-spacing:.04em;text-transform:uppercase;margin-top:1px;line-height:1}
    .dam-neo-chip{font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--neo-mint) 35%,transparent);color:var(--neo-mint);background:color-mix(in srgb,var(--neo-mint) 10%,transparent);box-shadow:0 0 12px color-mix(in srgb,var(--neo-mint) 18%,transparent);flex-shrink:0;line-height:1.2}
    .dam-content-grid{display:grid;grid-template-columns:minmax(220px,var(--dam-content-left,48%)) 3px minmax(260px,1fr);gap:0;flex:1 1 auto;min-height:0;padding:0;box-sizing:border-box}
    .dam-stack{display:grid;grid-template-rows:minmax(120px,var(--dam-stack-top,62%)) 3px minmax(132px,1fr);gap:0;min-height:0}
    .dam-explorer-wrap{overflow:hidden}.dam-explorer-lists{display:grid;grid-template-rows:minmax(120px,var(--dam-explorer-top,62%)) 3px minmax(132px,1fr);gap:0;min-height:0;padding:0;box-sizing:border-box;flex:1 1 auto}
    .dam-splitter-y,.dam-splitter-x{position:relative;touch-action:none;user-select:none;background:transparent;min-height:3px;min-width:3px;margin:0}
    .dam-splitter-y{cursor:row-resize}.dam-splitter-x{cursor:col-resize}
    .dam-splitter-y::after,.dam-splitter-x::after{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:2px;background:var(--cmx-splitter-grip);opacity:.72;transition:opacity .15s ease}
    .dam-splitter-y::after{width:var(--cmx-splitter-grip-width,30px);height:3px}
    .dam-splitter-x::after{width:3px;height:var(--cmx-splitter-grip-width,30px)}
    .dam-splitter-y:hover::after,.dam-splitter-x:hover::after,.dam-splitter-y.is-dragging::after,.dam-splitter-x.is-dragging::after{opacity:1}
    .dam-splitter-y:focus-visible,.dam-splitter-x:focus-visible{outline:2px solid var(--sapContent_FocusColor,#0070f2);outline-offset:-2px}
    .dam-neo-panel{margin:0;border:none;border-radius:0;box-shadow:none;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:var(--dam-body-bg)}
    .dam-neo-head{min-height:var(--dam-region-head-h,40px);height:var(--dam-region-head-h,40px);padding:0 10px;box-sizing:border-box;font-weight:700;border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 20%,var(--sapGroup_TitleBorderColor,#d9d9d9));display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 var(--dam-region-head-h,40px);background:var(--dam-head-bg);box-shadow:inset 0 -1px 0 color-mix(in srgb,#fff 35%,transparent)}
    .dam-neo-head[data-hue="domain"]{background:linear-gradient(90deg,color-mix(in srgb,var(--dam-hue-domain) 22%,var(--sapList_HeaderBackground,#eef2f6)),var(--dam-head-bg-domain) 42%,color-mix(in srgb,var(--dam-hue-domain) 10%,var(--sapList_HeaderBackground,#eef2f6)));border-bottom-color:color-mix(in srgb,var(--dam-hue-domain) 28%,var(--sapGroup_TitleBorderColor,#d9d9d9));box-shadow:inset 3px 0 0 var(--dam-hue-domain),inset 0 -1px 0 color-mix(in srgb,#fff 30%,transparent)}
    .dam-neo-head[data-hue="app"]{background:linear-gradient(90deg,color-mix(in srgb,var(--dam-hue-app) 22%,var(--sapList_HeaderBackground,#eef2f6)),var(--dam-head-bg-app) 42%,color-mix(in srgb,var(--dam-hue-app) 10%,var(--sapList_HeaderBackground,#eef2f6)));border-bottom-color:color-mix(in srgb,var(--dam-hue-app) 28%,var(--sapGroup_TitleBorderColor,#d9d9d9));box-shadow:inset 3px 0 0 var(--dam-hue-app),inset 0 -1px 0 color-mix(in srgb,#fff 30%,transparent)}
    .dam-neo-head[data-hue="module"]{background:linear-gradient(90deg,color-mix(in srgb,var(--dam-hue-module) 22%,var(--sapList_HeaderBackground,#eef2f6)),var(--dam-head-bg-module) 42%,color-mix(in srgb,var(--dam-hue-module) 10%,var(--sapList_HeaderBackground,#eef2f6)));border-bottom-color:color-mix(in srgb,var(--dam-hue-module) 28%,var(--sapGroup_TitleBorderColor,#d9d9d9));box-shadow:inset 3px 0 0 var(--dam-hue-module),inset 0 -1px 0 color-mix(in srgb,#fff 30%,transparent)}
    .dam-neo-head-main{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
    .dam-neo-head-main>span:not(.dam-neo-badge):not(.dam-neo-head-icon){white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:1.2}
    .dam-neo-head-icon{width:.95rem;height:.95rem;color:var(--neo-cyan)}
    .dam-neo-head[data-hue="domain"] .dam-neo-head-icon{color:var(--dam-hue-domain)}
    .dam-neo-head[data-hue="app"] .dam-neo-head-icon{color:var(--dam-hue-app)}
    .dam-neo-head[data-hue="module"] .dam-neo-head-icon{color:var(--dam-hue-module)}
    .dam-neo-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--neo-cyan) 14%,var(--dam-body-bg));color:var(--neo-cyan);border:1px solid color-mix(in srgb,var(--neo-cyan) 28%,transparent)}
    .dam-list-body,.dam-form,.dam-resources{background:var(--dam-body-bg)}
    .dam-list-body{overflow:auto;min-height:0;padding:8px;display:flex;flex-direction:column;gap:6px;flex:1 1 auto}
    .dam-list-item{border:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapList_BorderColor,#e5e5e5));background:color-mix(in srgb,var(--sapList_Background,#fff) 96%,var(--neo-cyan) 4%);text-align:left;padding:7px 8px;border-radius:6px;cursor:pointer;color:inherit;display:grid;grid-template-columns:30px minmax(0,1fr) 28px;gap:8px;align-items:center;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease,background .16s ease}
    .dam-list-item:hover{border-color:color-mix(in srgb,var(--neo-cyan) 35%,transparent);background:color-mix(in srgb,var(--neo-cyan) 6%,var(--sapList_Background,#fff));box-shadow:0 0 0 1px color-mix(in srgb,var(--neo-cyan) 8%,transparent)}
    .dam-list-icon{width:28px;height:28px;border-radius:6px;background:linear-gradient(145deg,color-mix(in srgb,var(--neo-cyan) 12%,var(--sapButton_Lite_Background,#f7f7f7)),color-mix(in srgb,var(--neo-violet) 8%,var(--sapButton_Lite_Background,#f7f7f7)));display:inline-flex;align-items:center;justify-content:center;color:var(--neo-cyan);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--neo-cyan) 18%,transparent)}
    .dam-list-icon ui5-icon{width:16px;height:16px}
    .dam-list-text{min-width:0;display:flex;flex-direction:column;gap:2px}.dam-list-text strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .dam-list-text span{font-size:11px;color:var(--sapContent_LabelColor,#6a6d70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .dam-list-item.active{border-color:color-mix(in srgb,var(--neo-cyan) 55%,transparent);background:linear-gradient(90deg,color-mix(in srgb,var(--neo-cyan) 12%,var(--sapList_Background,#fff)),color-mix(in srgb,var(--neo-violet) 6%,var(--sapList_Background,#fff)));box-shadow:inset 3px 0 0 var(--neo-cyan),0 0 16px color-mix(in srgb,var(--neo-cyan) 12%,transparent)}
    .dam-list-item[data-kind="domain"].active{box-shadow:inset 3px 0 0 var(--dam-hue-domain),0 0 16px color-mix(in srgb,var(--dam-hue-domain) 12%,transparent)}
    .dam-list-item[data-kind="application"].active{box-shadow:inset 3px 0 0 var(--dam-hue-app),0 0 16px color-mix(in srgb,var(--dam-hue-app) 12%,transparent)}
    .dam-list-item[data-kind="module"].active{box-shadow:inset 3px 0 0 var(--dam-hue-module),0 0 16px color-mix(in srgb,var(--dam-hue-module) 12%,transparent)}
    .dam-list-delete{width:26px;height:26px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--sapNegativeTextColor,#b00);display:inline-flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;cursor:pointer;padding:0;transition:opacity .15s ease,background .15s ease,border-color .15s ease}
    .dam-list-delete ui5-icon{width:14px;height:14px}.dam-list-item:hover .dam-list-delete,.dam-list-item:focus-within .dam-list-delete,.dam-list-delete:focus{opacity:1;pointer-events:auto}
    .dam-list-delete:hover{border-color:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 35%,transparent);background:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 10%,transparent)}
    .dam-card-actions{display:flex;gap:4px;align-items:center}
    .dam-icon-btn{width:24px;height:24px;border:1px solid color-mix(in srgb,var(--neo-cyan) 12%,transparent);border-radius:5px;background:color-mix(in srgb,var(--sapList_Background,#fff) 90%,var(--neo-cyan) 10%);color:var(--neo-cyan);display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}
    .dam-icon-btn ui5-icon{width:14px;height:14px}
    .dam-icon-btn:hover{background:color-mix(in srgb,var(--neo-cyan) 14%,var(--sapList_Background,#fff));border-color:color-mix(in srgb,var(--neo-cyan) 35%,transparent);box-shadow:0 0 10px color-mix(in srgb,var(--neo-cyan) 18%,transparent)}
    .dam-icon-btn.primary{color: #fff;background:linear-gradient(135deg,var(--neo-cyan),color-mix(in srgb,var(--neo-violet) 40%,var(--neo-cyan)));border-color:transparent}
    .dam-icon-btn.danger{color:var(--sapNegativeTextColor,#b00);background:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 8%,var(--sapList_Background,#fff));border-color:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 22%,transparent)}
    .dam-editor-card{min-height:0}
    .dam-editor-context{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:7px;align-items:center;min-height:36px;padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapGroup_TitleBorderColor,#d9d9d9));background:
      linear-gradient(120deg,color-mix(in srgb,var(--neo-cyan) 10%,var(--dam-body-bg)),color-mix(in srgb,var(--neo-violet) 5%,var(--dam-body-bg))),
      linear-gradient(90deg,color-mix(in srgb,var(--neo-cyan) 7%,transparent) 1px,transparent 1px);
      background-size:auto,22px 22px;overflow:hidden}
    .dam-editor-context[data-hue="domain"]{background:linear-gradient(120deg,color-mix(in srgb,var(--dam-hue-domain) 10%,var(--dam-body-bg)),var(--dam-body-bg))}
    .dam-editor-context[data-hue="app"]{background:linear-gradient(120deg,color-mix(in srgb,var(--dam-hue-app) 10%,var(--dam-body-bg)),var(--dam-body-bg))}
    .dam-editor-context[data-hue="module"]{background:linear-gradient(120deg,color-mix(in srgb,var(--dam-hue-module) 10%,var(--dam-body-bg)),var(--dam-body-bg))}
    .dam-editor-orbit{width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,var(--neo-cyan),color-mix(in srgb,var(--neo-violet) 42%,var(--neo-cyan)));box-shadow:0 0 10px color-mix(in srgb,var(--neo-cyan) 14%,transparent),inset 0 0 0 1px rgba(255,255,255,.22)}
    .dam-editor-orbit ui5-icon{width:.85rem;height:.85rem}
    .dam-editor-id{min-width:0}
    .dam-editor-title{font-size:12px;font-weight:750;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--sapTextColor,#1d2d3e)}
    .dam-editor-key{margin-top:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;color:var(--sapContent_LabelColor,#6a6d70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dam-editor-meta{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:76px;max-width:118px;white-space:nowrap}
    .dam-editor-score{position:relative;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:conic-gradient(var(--neo-mint) var(--dam-score,0%),color-mix(in srgb,var(--sapContent_LabelColor,#6a6d70) 18%,transparent) 0);color:var(--sapTextColor,#1d2d3e)}
    .dam-editor-score::after{content:'';position:absolute;inset:3px;border-radius:50%;background:var(--dam-body-bg)}
    .dam-editor-score span,.dam-editor-score small{position:relative;z-index:1;font-weight:800}
    .dam-editor-score span{font-size:8px}.dam-editor-score small{display:none}
    .dam-status-pill{display:inline-flex;align-items:center;justify-content:center;min-width:40px;max-width:82px;height:17px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px;font-weight:800;letter-spacing:0;text-transform:uppercase;padding:0 6px;border-radius:999px;color:var(--neo-mint);background:color-mix(in srgb,var(--neo-mint) 12%,transparent);border:1px solid color-mix(in srgb,var(--neo-mint) 28%,transparent)}
    .dam-form{display:block;padding:0;overflow:auto;min-height:0;flex:1 1 auto;background:linear-gradient(180deg,color-mix(in srgb,var(--dam-body-bg) 96%,var(--neo-cyan) 4%),var(--dam-body-bg))}
    .dam-smart-form{display:flex;flex-direction:column;gap:7px;padding:8px}
    .dam-field-cluster{border:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapGroup_TitleBorderColor,#d9d9d9));border-radius:8px;background:color-mix(in srgb,var(--sapTile_Background,var(--dam-body-bg)) 96%,var(--neo-cyan) 4%);overflow:hidden;box-shadow:none}
    .dam-field-cluster-head{height:24px;display:flex;align-items:center;gap:6px;padding:0 8px;font-size:10px;font-weight:750;letter-spacing:.04em;color:var(--sapContent_LabelColor,#6a6d70);background:color-mix(in srgb,var(--neo-cyan) 7%,var(--sapList_HeaderBackground,#eef2f6));border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 10%,var(--sapGroup_TitleBorderColor,#d9d9d9))}
    .dam-field-cluster-head ui5-icon{width:.75rem;height:.75rem;color:var(--neo-cyan)}
    .dam-field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:6px;padding:7px}
    .dam-smart-field{min-width:0;display:flex;flex-direction:column;gap:3px;padding:6px 7px;border:1px solid color-mix(in srgb,var(--neo-cyan) 8%,transparent);border-radius:7px;background:color-mix(in srgb,var(--sapField_Background,#fff) 94%,var(--neo-cyan) 6%);transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
    .dam-smart-field.wide{grid-column:1/-1}
    .dam-smart-field:focus-within{border-color:color-mix(in srgb,var(--neo-cyan) 48%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--neo-cyan) 14%,transparent),0 0 18px color-mix(in srgb,var(--neo-cyan) 10%,transparent)}
    .dam-field-top{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
    .dam-field-label{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--sapContent_LabelColor,#6a6d70);font-size:10px;font-weight:700;letter-spacing:.02em}
    .dam-field-label ui5-icon{width:.72rem;height:.72rem;color:var(--neo-cyan);flex:0 0 auto}
    .dam-smart-field[data-tone="ok"] .dam-field-label ui5-icon{color:var(--neo-mint)}
    .dam-field-lock{flex:0 0 auto;font-size:8px;font-weight:800;letter-spacing:.08em;color:var(--sapContent_LabelColor,#6a6d70);background:color-mix(in srgb,var(--sapContent_LabelColor,#6a6d70) 10%,transparent);border-radius:999px;padding:1px 5px}
    .dam-smart-field input,.dam-smart-field textarea,.dam-smart-field select{width:100%;box-sizing:border-box;border:0;border-radius:0;padding:0;background:transparent;color:var(--sapField_TextColor,var(--sapTextColor,#1d2d3e));font:inherit;font-size:12px;font-weight:600;line-height:1.28;outline:none}
    .dam-smart-field input[readonly]{color:var(--sapContent_LabelColor,#6a6d70);cursor:not-allowed}
    .dam-smart-field textarea{min-height:48px;resize:vertical;font-weight:500}
    .dam-smart-field select{appearance:none;-webkit-appearance:none;-moz-appearance:none;padding:0 14px 0 0;background-image:linear-gradient(45deg,transparent 50%,var(--sapContent_LabelColor,#6a6d70) 50%),linear-gradient(135deg,var(--sapContent_LabelColor,#6a6d70) 50%,transparent 50%);background-position:calc(100% - 8px) 50%,calc(100% - 4px) 50%;background-size:4px 4px;background-repeat:no-repeat;cursor:pointer}
    .dam-smart-field ui5-select{width:100%}
    .dam-smart-field input::placeholder,.dam-smart-field textarea::placeholder{color:var(--sapField_PlaceholderTextColor,var(--sapContent_LabelColor,#6a6d70))}
    .dam-alias-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
    .dam-alias-row span{font-size:10px;font-weight:700;color:var(--neo-violet);background:color-mix(in srgb,var(--neo-violet) 10%,transparent);border:1px solid color-mix(in srgb,var(--neo-violet) 25%,transparent);border-radius:999px;padding:1px 7px}
    .dam-property-wrap{overflow:hidden;position:relative;display:flex;flex-direction:column}
    .dam-property-resources{min-height:0;flex:1 1 auto}
    .dam-resources{overflow:auto;min-height:0;flex:1 1 auto;padding:0;margin:0}
    .dam-res-table-wrap{border:none;border-radius:0;overflow:hidden;background:var(--dam-body-bg);box-shadow:none;margin:0}
    .dam-table{width:100%;border-collapse:collapse;font-size:12px;background:var(--dam-body-bg)}
    .dam-neo-table thead th{background:var(--dam-head-bg);font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--sapContent_LabelColor,#6a6d70);border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 18%,var(--sapGroup_TitleBorderColor,#d9d9d9))}
    .dam-table th,.dam-table td{border-bottom:1px solid color-mix(in srgb,var(--neo-cyan) 8%,var(--sapList_BorderColor,#eee));padding:8px 10px;text-align:left;vertical-align:top}
    .dam-table tbody tr:hover td{background:color-mix(in srgb,var(--neo-cyan) 5%,var(--sapList_Background,#fff))}
    .dam-res-type{font-weight:600;color:var(--neo-violet)}
    .dam-res-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;color:var(--sapTextColor,#32363a)}
    .dam-res-status{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.03em;border:1px solid transparent}
    .dam-res-status[data-st="ok"]{color:var(--neo-mint);background:color-mix(in srgb,var(--neo-mint) 12%,transparent);border-color:color-mix(in srgb,var(--neo-mint) 28%,transparent)}
    .dam-res-status[data-st="miss"]{color:var(--neo-warn);background:color-mix(in srgb,var(--neo-warn) 12%,transparent);border-color:color-mix(in srgb,var(--neo-warn) 28%,transparent)}
    .dam-res-status[data-st="err"]{color:var(--sapNegativeTextColor,#b00);background:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 10%,transparent);border-color:color-mix(in srgb,var(--sapNegativeElementColor,#b00) 28%,transparent)}
    .dam-empty{padding:18px 12px;color:var(--sapContent_LabelColor,#6a6d70);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;min-height:80px}
    .dam-empty ui5-icon{width:1.4rem;height:1.4rem;color:color-mix(in srgb,var(--neo-cyan) 55%,var(--sapContent_LabelColor,#6a6d70));opacity:.85}
  </style>`
}

// 全局轻提示 Toast（挂到 document.body，自动居中、自动消失）。
// 脱离三视图独立渲染，避免每个视图各弹一条。
// tone: 'ok'(成功/绿) | 'err'(失败/红)；duration 默认 3000ms，可覆盖。
const { showCmxToast } = globalThis.__cmxDataComp // 共享 toast（cmx-data-comp/lib/cmx-toast.js；治理清单 B-05）

function mount (ctx, html, after) {
  const bindWhenReady = (tries = 0) => {
    if (ctx.host) state.hosts.add(ctx.host)
    const root = ctx.host?.renderRoot || ctx.host?.shadowRoot?.querySelector('.native-page-root')
    if (root && root.isConnected && typeof after === 'function') {
      after(root)
      return
    }
    if (tries < 20) requestAnimationFrame(() => bindWhenReady(tries + 1))
  }
  requestAnimationFrame(() => bindWhenReady())
  return `${styleHtml()}${html}`
}

export default {
  defaultView: 'manager',
  views: {
    async manager (ctx) {
      await loadRegistry()
      return mount(ctx, pageHtml(), (root) => bindPage(root, 'manager'))
    },
    async explorer (ctx) {
      await loadRegistry()
      return mount(ctx, explorerHtml(), (root) => bindPage(root, 'explorer'))
    },
    async property (ctx) {
      await loadRegistry()
      return mount(ctx, propertyHtml(), (root) => bindPage(root, 'property'))
    },
  },
}
