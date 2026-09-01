/**
 * showcase —— 展示组件库演示（native_pages · JS 模块 · 静态展示页）。
 *
 * 演示新开发的展示类组件（neo 主题）+ cmxConfirm 确认对话框：
 *   - cmx-panel        可折叠面板
 *   - cmx-toolbar      命令栏（slot 透传）
 *   - cmx-status-tag   状态徽章
 *   - cmx-empty-state  空状态占位
 *   - cmx-desc-list    键值描述清单（+ cmx-desc-item）
 *   - cmx-filter-bar   搜索/筛选条
 *   - cmxConfirm       确认对话框（返回 Promise<boolean>）
 *
 * 纯前端模拟数据，无后端依赖。CMX 类经 globalThis.__cmxDataComp 取用（禁止裸 import）。
 * 契约：export default { defaultView, views:{ <view>(ctx) } }；ctx.props 来自菜单。
 */

const cmx = () => (typeof globalThis !== 'undefined' && globalThis.__cmxDataComp) || {}

/** 等待 host.renderRoot 内的元素渲染就绪后再绑定事件（render 返回后 DOM 才注入 shadowRoot）。 */
function whenRendered (host, selector, cb, tries) {
  const t = tries == null ? 60 : tries
  const root = host && (host.renderRoot || host.shadowRoot)
  if (root && root.querySelector(selector)) { cb(root); return }
  if (t <= 0) return
  requestAnimationFrame(() => whenRendered(host, selector, cb, t - 1))
}

/** 页面级样式（根骨架 + 分区标题；组件自身样式由各组件 shadow DOM 隔离）。 */
function styleCss () {
  return `
    .sc{display:flex;flex-direction:column;height:100%;width:100%;box-sizing:border-box;
      padding:14px 16px;gap:14px;overflow:auto;
      font:13px/1.5 var(--sapFontFamily,Arial,'PingFang SC','Microsoft YaHei',sans-serif);
      color:var(--sapTextColor,#1d2d3e);background:var(--sapBackgroundColor,#f5f6f7)}
    .sc-sec{display:flex;flex-direction:column;gap:8px}
    .sc-sec-h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;
      color:var(--sapContent_LabelColor,#6a6d70);letter-spacing:.02em;
      text-transform:uppercase}
    .sc-sec-h::before{content:'';width:3px;height:14px;border-radius:2px;
      background:var(--neo-cyan,#00b4d8)}
    .sc-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .sc-note{font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);padding:2px 0}
    .sc-taggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr);gap:8px)}
  `
}

/** status-tag 演示区：5 色 × 3 variant 矩阵 */
function statusTagSection () {
  const tones = [
    { tone: 'success', text: '已启用' },
    { tone: 'warning', text: '待审核' },
    { tone: 'danger', text: '已作废' },
    { tone: 'info', text: '进行中' },
    { tone: 'neutral', text: '草稿' },
  ]
  const variants = ['solid', 'subtle', 'outline']
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-status-tag（5 色 × 3 变体）</div>
      ${variants.map((v) => `
        <div class="sc-row">
          ${tones.map((t) => `<cmx-status-tag tone="${t.tone}" variant="${v}" dot>${t.text}</cmx-status-tag>`).join('')}
          <span class="sc-note">variant=${v}</span>
        </div>
      `).join('')}
    </section>`
}

/** desc-list 演示区：单列 + 双列 */
function descListSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-desc-list（键值清单）</div>
      <cmx-desc-list border tone="cyan">
        <cmx-desc-item label="单据编号">SO-2026-0729-001</cmx-desc-item>
        <cmx-desc-item label="业务日期">2026-07-29</cmx-desc-item>
        <cmx-desc-item label="客户名称">示例客户科技有限公司</cmx-desc-item>
        <cmx-desc-item label="业务员">张三</cmx-desc-item>
        <cmx-desc-item label="金额">¥12,345.67</cmx-desc-item>
        <cmx-desc-item label="状态">已审核</cmx-desc-item>
      </cmx-desc-list>
      <cmx-desc-list columns="2" border tone="violet" style="margin-top:8px;">
        <cmx-desc-item label="仓库">主仓库</cmx-desc-item>
        <cmx-desc-item label="币种">CNY 人民币</cmx-desc-item>
        <cmx-desc-item label="汇率">1.0000</cmx-desc-item>
        <cmx-desc-item label="交货方式">送货上门</cmx-desc-item>
      </cmx-desc-list>
    </section>`
}

/** toolbar + filter-bar 演示区 */
function toolbarSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-toolbar（命令栏 · slot 透传）</div>
      <cmx-toolbar divider data-tb="main">
        <ui5-button icon="add" design="Default">新增</ui5-button>
        <ui5-button icon="delete" design="Default" data-act="delete">删除</ui5-button>
        <ui5-button icon="refresh" design="Transparent">刷新</ui5-button>
        <ui5-button icon="detail-view" design="Transparent" data-act="dock-right">侧边详情(右)</ui5-button>
        <ui5-button icon="detail-view" design="Transparent" data-act="dock-left">侧边详情(左)</ui5-button>
        <ui5-button icon="save" design="Emphasized" slot="actions" data-act="save">保存</ui5-button>
        <ui5-button icon="export" design="Transparent" slot="actions">导出</ui5-button>
      </cmx-toolbar>
    </section>`
}

function filterBarSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-filter-bar（搜索/筛选条）</div>
      <cmx-filter-bar data-fb="main" search-placeholder="单据编号/客户名称">
        <ui5-select data-cond="status">
          <ui5-option selected>全部状态</ui5-option>
          <ui5-option>已审核</ui5-option>
          <ui5-option>待审核</ui5-option>
          <ui5-option>已作废</ui5-option>
        </ui5-select>
        <ui5-date-picker data-cond="from" placeholder="开始日期"></ui5-date-picker>
        <ui5-date-picker data-cond="to" placeholder="结束日期"></ui5-date-picker>
      </cmx-filter-bar>
      <div class="sc-note" data-fb-log>事件日志：尚未触发搜索/清空</div>
    </section>`
}

/** kpi-card 演示区：card 变体（多色调）+ inline 变体（财务 acct-kpi 风格） */
function kpiSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-kpi-card · variant=card（圆角块卡片）</div>
      <div class="sc-row" style="gap:10px;">
        <cmx-kpi-card label="资产" value="1,234,567.89" unit="元" tone="info"></cmx-kpi-card>
        <cmx-kpi-card label="负债" value="456,789.00" unit="元" tone="warning"></cmx-kpi-card>
        <cmx-kpi-card label="净利润" value="89,432.10" unit="元" tone="success" trend="up" delta="+12.3%"></cmx-kpi-card>
        <cmx-kpi-card label="流失客户" value="23" tone="danger" trend="down" delta="-8.1%"></cmx-kpi-card>
      </div>
      <div class="sc-sec-h" style="margin-top:10px;">cmx-kpi-card · variant=inline（行内 label:value，acct-kpi 风格，可点击）</div>
      <div class="sc-row" style="gap:14px;">
        <cmx-kpi-card variant="inline" label="现金流入" value="56,789.00" tone="cash-in" clickable data-kpi="in"></cmx-kpi-card>
        <span style="color:var(--sapContent_LabelColor,#6a6d70);">→</span>
        <cmx-kpi-card variant="inline" label="现金流出" value="34,210.50" tone="cash-out" clickable data-kpi="out"></cmx-kpi-card>
        <cmx-kpi-card variant="inline" label="营业收入" value="123,456.00" tone="revenue" clickable></cmx-kpi-card>
        <cmx-kpi-card variant="inline" label="营业成本" value="78,901.00" tone="expense" clickable></cmx-kpi-card>
      </div>
      <div class="sc-note" data-kpi-log>事件日志：点击上方 inline 卡片触发 cmx-kpi-click</div>
    </section>`
}

/** panel 演示区：可折叠 + 不同 tone */
function panelSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-panel（可折叠面板 · 4 色调）</div>
      <cmx-panel title="基本信息（tone=cyan · 默认展开）" collapsible icon="detail-view" tone="cyan">
        <span class="sc-note">面板内容区：可放表单、表格、描述清单等任意内容。</span>
      </cmx-panel>
      <cmx-panel title="附件信息（tone=violet · 默认展开）" collapsible icon="attachment" tone="violet">
        <cmx-empty-state icon="attachment" title="暂无附件" description="点击「上传」按钮添加附件" size="sm"></cmx-empty-state>
      </cmx-panel>
      <cmx-panel title="审批记录（tone=mint · 默认折叠）" collapsible collapsed icon="history" tone="mint">
        <cmx-desc-list border>
          <cmx-desc-item label="审批人">李经理</cmx-desc-item>
          <cmx-desc-item label="审批意见">同意</cmx-desc-item>
          <cmx-desc-item label="审批时间">2026-07-28 16:30</cmx-desc-item>
        </cmx-desc-list>
      </cmx-panel>
      <cmx-panel title="备注（tone=azure · 默认折叠）" collapsible collapsed icon="notes" tone="azure">
        <span class="sc-note">这是一段备注内容。</span>
      </cmx-panel>
    </section>`
}

/** empty-state 演示区：3 尺寸 */
function emptyStateSection () {
  return `
    <section class="sc-sec">
      <div class="sc-sec-h">cmx-empty-state（空状态 · 3 尺寸）</div>
      <div class="sc-row">
        <cmx-empty-state icon="database" title="暂无数据" description="点击新增创建第一条记录" size="sm"
          style="flex:1 1 200px;border:1px solid var(--sapGroup_ContentBorderColor,#d9d9d9);border-radius:6px;"></cmx-empty-state>
        <cmx-empty-state icon="cart" title="购物车为空" description="去添加商品吧" size="md"
          style="flex:1 1 200px;border:1px solid var(--sapGroup_ContentBorderColor,#d9d9d9);border-radius:6px;"></cmx-empty-state>
      </div>
    </section>`
}

function viewHtml () {
  return `<div class="sc">
    <ui5-bar design="Header">
      <ui5-label slot="startContent" style="font-weight:800;font-size:15px;">展示组件库演示</ui5-label>
      <ui5-label slot="endContent" style="font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);">7 组件 + cmxConfirm + dock 抽屉 · neo 主题</ui5-label>
    </ui5-bar>

    ${toolbarSection()}
    ${kpiSection()}
    ${filterBarSection()}
    ${statusTagSection()}
    ${panelSection()}
    ${descListSection()}
    ${emptyStateSection()}

    <div class="sc-note" style="padding-top:8px;border-top:1px solid var(--sapGroup_ContentBorderColor,#d9d9d9);">
      提示：命令栏「删除/保存」弹 cmxConfirm；「侧边详情」弹 dock 抽屉对话框；inline KPI 卡可点击；筛选条「搜索/清空」、面板标题栏（折叠/展开）均可交互。
    </div>
  </div>`
}

/** 渲染就绪后绑定交互事件。 */
function bind (root) {
  const C = cmx()
  const $ = (sel) => root.querySelector(sel)

  // cmxConfirm 演示：点「删除」「保存」弹出确认框
  const onConfirm = async (intent, msg) => {
    if (!C.cmxConfirm) return
    const ok = await C.cmxConfirm({ message: msg, intent })
    if (ok && C.cmxInfo) C.cmxInfo({ level: 'info', message: intent === 'danger' ? '已确认删除（演示）' : '已确认保存（演示）' })
  }
  $('[data-act="delete"]')?.addEventListener('click', () => onConfirm('danger', '删除后不可恢复，确定删除该记录？'))
  $('[data-act="save"]')?.addEventListener('click', () => onConfirm('normal', '确定保存当前修改？'))

  // filter-bar 事件日志
  const fb = $('[data-fb="main"]')
  const log = $('[data-fb-log]')
  if (fb && log) {
    const stamp = () => new Date().toLocaleTimeString()
    fb.addEventListener('cmx-filter-search', (e) => {
      log.textContent = `事件日志：[${stamp()}] 搜索 "${e.detail.text || ''}"`
    })
    fb.addEventListener('cmx-filter-reset', () => {
      log.textContent = `事件日志：[${stamp()}] 已清空筛选条件`
    })
  }

  // dock 抽屉演示：点「侧边详情」用 cmx-floating-dialog 的 dock 模式弹出
  const openDock = (side) => {
    const Cmx = C.CmxFloatingDialog
    if (!Cmx) return
    const dlg = document.createElement('cmx-floating-dialog')
    dlg.configure({
      title: side === 'right' ? '详情（右侧抽屉）' : '详情（左侧抽屉）',
      icon: 'detail-view',
      showConfirm: false,
      cancelText: '关闭',
      dock: side,
      dialogWidth: '440px',
    })
    // 抽屉内容：一张描述清单（padding 由 .dlg-content 默认提供，dock+setContent 路径契约生效）
    const body = document.createElement('div')
    body.innerHTML = `
      <cmx-desc-list border tone="cyan">
        <cmx-desc-item label="单据编号">SO-2026-0729-001</cmx-desc-item>
        <cmx-desc-item label="客户">示例客户科技有限公司</cmx-desc-item>
        <cmx-desc-item label="金额">¥12,345.67</cmx-desc-item>
        <cmx-desc-item label="状态">已审核</cmx-desc-item>
        <cmx-desc-item label="制单人">张三</cmx-desc-item>
        <cmx-desc-item label="制单日期">2026-07-29</cmx-desc-item>
      </cmx-desc-list>
      <p style="margin:12px 0 0;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);">这是 cmx-floating-dialog 的 dock 抽屉模式：贴${side === 'right' ? '右' : '左'}滑入、撑满高度、点遮罩或 Esc 关闭。</p>`
    dlg.setContent(body)
    document.body.appendChild(dlg)
    dlg.openModal()
  }
  $('[data-act="dock-right"]')?.addEventListener('click', () => openDock('right'))
  $('[data-act="dock-left"]')?.addEventListener('click', () => openDock('left'))

  // inline KPI 卡点击日志
  const kpiLog = $('[data-kpi-log]')
  if (kpiLog) {
    const stamp = () => new Date().toLocaleTimeString()
    root.querySelectorAll('cmx-kpi-card[clickable]').forEach((card) => {
      card.addEventListener('cmx-kpi-click', (e) => {
        kpiLog.textContent = `事件日志：[${stamp()}] 点击 ${e.detail.label} = ${e.detail.value}`
      })
    })
  }
}

export default {
  defaultView: 'content',
  views: {
    async content (ctx) {
      const host = ctx && ctx.host
      if (host) whenRendered(host, '.sc', (root) => bind(root))
      return `<style>${styleCss()}</style>${viewHtml()}`
    },
  },
}
