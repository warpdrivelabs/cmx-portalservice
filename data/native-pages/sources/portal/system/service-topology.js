/**
 * 系统集成状态 —— 服务依赖 / 集成拓扑（native_pages, portal.system.service-topology）。
 *
 * 面向门户管理员，回答「门户各功能挂的是哪个后端」：某能力是**进程内内嵌**还是**反代到独立
 * 微服务**，目标 URL 是什么，以及（对 proxy 目标）**活体探测**——现在真的通吗、延迟多少、
 * 对端服务名/在线时长。
 *
 * 数据源：平台 web-server 的通用监控端点 `GET /_mon/deps`（同源、由 cmx-web-monitor 提供，与
 * 平台 /_mon 技术页、各独立服务 /_mon 同一份真相）。本页只做门户内的可视化承载，不重复造后端。
 *
 * 契约：export default { defaultView, views:{ content(ctx) } }；返回 HTML 片段挂 shadowRoot。
 */

const state = {
  hosts: new Set(),   // 挂载的 host（多区/多标签共享一套 state）
  deps: null,         // 最近一次 /_mon/deps 数据
  err: '',            // 加载错误
  loading: false,
  timer: null,        // 轮询定时器（全局单例）
}

// ───────────────────────── 后端调用 ─────────────────────────

const { apiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js；信封解包+结构化错误）

async function load () {
  if (state.loading) return
  state.loading = true
  try {
    state.deps = await apiJson('/_mon/deps')
    state.err = ''
  } catch (e) {
    state.err = e.message || String(e)
  } finally {
    state.loading = false
    renderAll()
  }
}

// ───────────────────────── 视图 ─────────────────────────

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）
const hdur = (s) => { s = +s || 0; if (s < 60) return s + '秒'; if (s < 3600) return (s / 60).toFixed(1) + '分'; if (s < 86400) return (s / 3600).toFixed(1) + '时'; return (s / 86400).toFixed(1) + '天' }
const agoTxt = (checkedMs, nowMs) => { if (!checkedMs) return '未探测'; const s = Math.max(0, Math.round((nowMs - checkedMs) / 1000)); return s < 2 ? '刚刚' : s + '秒前' }

function depCard (s, nowMs) {
  const proxy = s.mode === 'proxy'
  const pb = s.probe || null
  const down = proxy && pb && !pb.reachable
  const mode = proxy ? 'PROXY' : 'EMBEDDED'
  let flow, foot
  if (proxy) {
    const remote = (pb && pb.remoteService) || '独立微服务'
    flow = `<div class="st-flow"><span class="st-node self">门户平台</span>
        <span class="st-edge ${down ? 'down' : ''}"></span><span class="st-node rem">${esc(remote)}</span></div>
      <div class="st-target">${esc(s.target || '')}/_mon</div>`
    if (pb) {
      foot = `<div class="st-probe">
        <span class="st-chip ${pb.reachable ? 'up' : 'down'}"><i></i>${pb.reachable ? '活体可达' : '不可达'}</span>
        ${pb.reachable && pb.latencyMs != null ? `<span class="st-meta">延迟 ${pb.latencyMs}ms</span>` : ''}
        ${pb.reachable && pb.remoteUptimeSecs != null ? `<span class="st-meta">对端在线 ${hdur(pb.remoteUptimeSecs)}</span>` : ''}
        ${!pb.reachable && pb.error ? `<span class="st-meta">${esc(pb.error)}</span>` : ''}
        <span class="st-meta">· ${agoTxt(pb.checkedAtMs, nowMs)}</span></div>`
    } else { foot = '<div class="st-probe"><span class="st-meta">等待首次探测…</span></div>' }
  } else {
    flow = `<div class="st-flow"><span class="st-node self">门户平台</span>
      <span class="st-edge"></span><span class="st-node">进程内引擎</span></div>`
    foot = '<div class="st-note">同进程内嵌，随平台共生共死（无需探测）</div>'
  }
  return `<div class="st-card ${proxy ? 'proxy' : ''} ${down ? 'down' : ''}">
    <div class="st-top"><span class="st-label">${esc(s.label)}</span><span class="st-key">${esc(s.key)}</span>
      <span class="st-badge ${proxy ? 'proxy' : 'embedded'}">${mode}</span></div>
    ${flow}${foot}</div>`
}

function bodyHtml () {
  const d = state.deps
  const svcs = (d && d.services) || []
  const nowMs = (d && d.nowMs) || 0
  const proxyCount = svcs.filter(s => s.mode === 'proxy').length
  const upCount = svcs.filter(s => s.mode === 'proxy' && s.probe && s.probe.reachable).length
  let inner
  if (state.err) {
    inner = `<div class="st-empty">加载失败：${esc(state.err)}<br><span style="font-size:11px">（/_mon/deps 需平台启用通用监控；确认已升级到含 cmx-web-monitor 的 web-server）</span></div>`
  } else if (!svcs.length) {
    inner = `<div class="st-empty">${state.loading ? '加载中…' : '暂无依赖信息'}</div>`
  } else {
    inner = `<div class="st-summary">
        <span>共 <b>${svcs.length}</b> 项能力</span>
        <span>内嵌 <b>${svcs.length - proxyCount}</b></span>
        <span>独立微服务 <b>${proxyCount}</b></span>
        ${proxyCount ? `<span class="${upCount === proxyCount ? 'ok' : 'warn'}">活体可达 <b>${upCount}/${proxyCount}</b></span>` : ''}
      </div>
      <div class="st-grid">${svcs.map(s => depCard(s, nowMs)).join('')}</div>`
  }
  return `<style>${styleCss()}</style>
    <div class="st-root">
      <div class="st-head">
        <div><div class="st-h1">服务依赖 / 集成拓扑</div>
          <div class="st-sub">门户各功能后端来源 · 进程内内嵌 vs 反代独立微服务 · proxy 目标活体探测</div></div>
        <button class="st-refresh" data-act="refresh">刷新</button>
      </div>
      ${inner}
    </div>`
}

function styleCss () {
  return `
  .st-root{padding:16px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    color:var(--sapTextColor,#32363a);font-size:13px}
  .st-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
  .st-h1{font-size:16px;font-weight:700}
  .st-sub{font-size:11.5px;color:var(--sapContent_LabelColor,#6a6d70);margin-top:3px}
  .st-refresh{margin-left:auto;padding:6px 14px;border-radius:8px;border:1px solid var(--sapButton_BorderColor,#0a6ed1);
    background:transparent;color:var(--sapButton_TextColor,#0a6ed1);cursor:pointer;font-size:12.5px}
  .st-refresh:hover{background:var(--sapButton_Hover_Background,#ebf5fe)}
  .st-summary{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--sapContent_LabelColor,#6a6d70);
    margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--sapList_BorderColor,#e5e5e5)}
  .st-summary b{color:var(--sapTextColor,#32363a);font-variant-numeric:tabular-nums}
  .st-summary .ok b{color:var(--sapPositiveTextColor, #0a7d33)}.st-summary .warn b{color:var(--sapNegativeTextColor, #bb0000)}
  .st-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:13px}
  .st-card{border:1px solid var(--sapList_BorderColor,#e5e5e5);border-radius:12px;padding:14px 16px;
    background:var(--sapTile_Background,#fff);position:relative;overflow:hidden}
  .st-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--sapPositiveElementColor, #0a9d5e)}
  .st-card.proxy::before{background:var(--sapInformationElementColor, #6a3fe0)}.st-card.down::before{background:var(--sapNegativeElementColor, #bb0000)}
  .st-top{display:flex;align-items:center;gap:9px;margin-bottom:10px}
  .st-label{font-size:14px;font-weight:650}
  .st-key{font-size:10.5px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--sapContent_LabelColor, #8a8d90)}
  .st-badge{font-size:10px;font-weight:700;letter-spacing:1px;padding:2px 9px;border-radius:7px;margin-left:auto}
  .st-badge.embedded{background:#e3f5ec;color:var(--sapPositiveElementColor, #0a7d33)}.st-badge.proxy{background:#efe9fc;color:var(--sapInformationElementColor, #6a3fe0)}
  .st-flow{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--sapContent_LabelColor, #6a6d70);margin:8px 0}
  .st-node{padding:3px 10px;border-radius:8px;background:var(--sapField_Background,#f5f6f7);
    border:1px solid var(--sapList_BorderColor,#e5e5e5);white-space:nowrap;font-weight:600;color:#32363a}
  .st-node.self{color:var(--sapLinkColor, #0a6ed1)}.st-node.rem{color:var(--sapLinkColor, #6a3fe0)}
  .st-edge{flex:1;height:2px;min-width:26px;background:linear-gradient(90deg,var(--sapInformationElementColor, #0a6ed1),var(--sapInformationElementColor, #6a3fe0));position:relative;opacity:.75}
  .st-edge::after{content:"▸";position:absolute;right:-3px;top:-9px;color:var(--sapLinkColor, #6a3fe0);font-size:12px}
  .st-edge.down{background:var(--sapNegativeElementColor, #bb0000)}.st-edge.down::after{color:var(--sapNegativeElementColor, #bb0000)}
  .st-target{font-size:10.5px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--sapContent_LabelColor, #8a8d90);word-break:break-all;margin-bottom:9px}
  .st-probe{display:flex;flex-wrap:wrap;gap:7px;align-items:center;font-size:11px}
  .st-chip{padding:2px 10px;border-radius:20px;display:flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
  .st-chip.up{background:#e3f5ec;color:var(--sapPositiveElementColor, #0a7d33);border:1px solid var(--sapPositiveElementColor, #b6e3c8)}
  .st-chip.down{background:#fceaea;color:var(--sapNegativeElementColor, #bb0000);border:1px solid var(--sapNegativeElementColor, #f3c2c2)}
  .st-chip i{width:7px;height:7px;border-radius:50%;background:currentColor}
  .st-meta{font-size:10.5px;color:var(--sapContent_LabelColor, #8a8d90);font-variant-numeric:tabular-nums}
  .st-note{font-size:11px;color:var(--sapContent_LabelColor, #8a8d90);font-style:italic}
  .st-empty{text-align:center;color:var(--sapContent_LabelColor, #8a8d90);padding:40px 20px;font-size:13px}
  `
}

// ───────────────────────── 挂载 ─────────────────────────

function hostRoot (host) {
  return host?.renderRoot || host?.shadowRoot?.querySelector('.native-page-root') || host?.shadowRoot || null
}

function renderInto (host) {
  const root = hostRoot(host)
  if (!root) return
  root.innerHTML = bodyHtml()
  root.querySelector('[data-act="refresh"]')?.addEventListener('click', load)
}

function renderAll () {
  for (const host of Array.from(state.hosts)) {
    if (!host || (host.isConnected === false)) { state.hosts.delete(host); continue }
    renderInto(host)
  }
}

function ensureTimer () {
  if (state.timer) return
  state.timer = setInterval(() => { if (state.hosts.size) load() }, 5000)
}

export default {
  defaultView: 'content',
  views: {
    content (ctx) {
      const host = ctx?.host
      if (host) state.hosts.add(host)
      ensureTimer()
      // 首帧返回骨架，随后异步拉数据重渲。
      queueMicrotask(load)
      return bodyHtml()
    },
  },
}
