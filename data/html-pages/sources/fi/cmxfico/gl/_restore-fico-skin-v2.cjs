#!/usr/bin/env node
/**
 * 恢复 FICO 三区 Neo 皮肤 UI，保留当前 __designer_meta__ 业务逻辑（按张加载模型）。
 */
const fs = require('fs');
const path = require('path');
const base = __dirname;

function extractMeta (file) {
  const html = fs.readFileSync(path.join(base, file), 'utf8');
  const marker = 'id="__designer_meta__">';
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start, end));
}

function writePage (file, html, meta) {
  fs.writeFileSync(path.join(base, file), html.trim() + '\n<script type="application/json" id="__designer_meta__">' + JSON.stringify(meta) + '</script>\n');
}

const CHROME_HELPERS = `
function headersDs(ms){ try{ var root=ms.getRootDataSet('batch'); var br=root&&root.currentRow; return br&&br._children&&br._children['headers']||null; }catch(e){ return null; } }
function currentHeaderRow(ms){ try{ var hds=ms._resolveWrap&&ms._resolveWrap('batch.headers'); return hds&&hds.currentRow||null; }catch(e){ return null; } }
function mapDocStatus(st){ st=String(st||'draft').toLowerCase(); if(st==='posted'||st==='p'||st==='post') return 'posted'; if(st==='audited'||st==='approved'||st==='review'||st==='audit') return 'audited'; return 'draft'; }
function applySealStates(stage){ var map={draft:'sealDraft',audited:'sealAudited',posted:'sealPosted'}; var activeId=map[stage]||'sealDraft'; ['sealDraft','sealAudited','sealPosted'].forEach(function(sid){ var el=$('#'+sid); if(el) el.setAttribute('data-state', sid===activeId?'active':'hidden'); }); }
function disBtn(el,on){ if(!el)return; if(on){el.setAttribute('disabled','');el.classList.add('is-disabled');} else{el.removeAttribute('disabled');el.classList.remove('is-disabled');} }
function lineDs(ms,level){ try{ var p=level==='aux'?'batch.headers.account_lines.aux_lines':'batch.headers.account_lines'; return ms._resolveWrap&&ms._resolveWrap(p)||null; }catch(e){ return null; } }
`;

const REFRESH_CHROME_FN = CHROME_HELPERS + `
function refreshHeaderChrome(ms){
  var mh=modelHost();
  var p=mh&&mh.getVoucherPos&&mh.getVoucherPos();
  if(p&&p.total>0) host.updateHdrPosDisplay(p.idx+1, p.total);
  else host.updateHdrPosDisplay(0,0);
  var row=currentHeaderRow(ms);
  var dr=row?(+row.entered_dr||+row.local_dr||0):0;
  var cr=row?(+row.entered_cr||+row.local_cr||0):0;
  setText('kpiDebit',fmt(dr)); setText('kpiCredit',fmt(cr));
  var balEl=$('#kpiBalance');
  if(balEl){ var diff=Math.abs(dr-cr); if(diff<0.005){ balEl.textContent='✓ 平衡'; balEl.className='fico-kpi-val fico-ok'; } else { balEl.textContent='差额 '+fmt(diff); balEl.className='fico-kpi-val fico-warn'; } }
  var ring=$('#dcMixRing'); if(ring){ var tot=dr+cr; var pDr=tot>0?Math.round(dr/tot*100):50; ring.style.background='conic-gradient(#00b4d8 0% '+pDr+'%, #7c3aed '+pDr+'% 100%)'; }
  applySealStates(mapDocStatus(row&&row.document_status));
  if(host.syncVoucherActionButtons) host.syncVoucherActionButtons(ms);
}
`;

const CONTENT_CSS = `
    .fico-ws-root {
      --fico-cyan: #00b4d8; --fico-violet: #7c3aed; --fico-mint: #10b981; --fico-warn: #f59e0b;
      --fico-draft: #ea580c; --fico-audit: #7c3aed; --fico-post: #2563eb;
      --fico-border: color-mix(in srgb, var(--fico-cyan) 14%, var(--sapGroup_ContentBorderColor, #e0e0e0));
      --fico-edge-highlight: color-mix(in srgb, var(--sapTextColor, #32363a) 10%, transparent);
      --fico-nav-btn-size: var(--sapElement_Compact_Height, var(--sapButton_Compact_Height, 1.625rem));
      --fico-hdr-nav-btn-size: calc(var(--fico-nav-btn-size) - 0.2rem);
    }
    .fico-hdr-panel { display:flex; flex-direction:column; background:color-mix(in srgb, var(--sapList_Background,#fff) 94%, var(--fico-violet) 6%); border:1px solid var(--fico-border); border-radius:12px; overflow:hidden; box-shadow:0 4px 18px color-mix(in srgb, var(--fico-cyan) 8%, transparent); }
    .fico-hdr-hero { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:5px 10px 6px; border-bottom:1px solid var(--fico-border); background:linear-gradient(105deg, color-mix(in srgb, var(--fico-cyan) 6%, var(--sapList_Background,#fff)), color-mix(in srgb, var(--fico-violet) 4%, transparent) 55%, transparent); }
    .fico-seal-strip { display:flex; align-items:center; justify-content:center; flex-shrink:0; width:42px; min-height:42px; }
    .fico-seal { width:38px; height:38px; border-radius:50%; display:none; align-items:center; justify-content:center; position:relative; transform:rotate(-10deg); color:var(--fico-draft); background:color-mix(in srgb, currentColor 8%, var(--sapList_Background,#fff)); border:2px double currentColor; box-shadow:inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent), 0 2px 8px color-mix(in srgb, currentColor 22%, transparent); user-select:none; }
    .fico-seal[data-state="active"] { display:flex; transform:rotate(-8deg) scale(1.02); }
    .fico-seal[data-kind="audited"] { color:var(--fico-audit); }
    .fico-seal[data-kind="posted"] { color:var(--fico-post); }
    .fico-seal::before { content:''; position:absolute; inset:3px; border-radius:50%; border:1px solid color-mix(in srgb, currentColor 55%, transparent); pointer-events:none; }
    .fico-seal::after { content:''; position:absolute; inset:6px; border-radius:50%; border:1px dashed color-mix(in srgb, currentColor 30%, transparent); pointer-events:none; }
    .fico-seal-text { display:flex; flex-direction:column; align-items:center; font-size:0.54rem; font-weight:900; line-height:1.02; letter-spacing:0.1em; font-family:"STKaiti","KaiTi","Songti SC",serif; z-index:1; }
    .fico-hdr-main { flex:1 1 180px; min-width:0; display:flex; flex-direction:column; justify-content:center; align-self:center; gap:0; }
    .fico-hdr-title-row { display:flex; flex-direction:row; align-items:center; flex-wrap:wrap; gap:4px 8px; min-width:0; width:100%; min-height:0; box-sizing:border-box; }
    .fico-hdr-headband { flex:0 0 auto; min-width:0; display:flex; align-items:center; }
    .fico-hdr-title { margin:0; font-size:var(--fico-hdr-nav-btn-size); font-weight:700; line-height:1; letter-spacing:0.02em; color:var(--sapTitleColor,#223548); white-space:nowrap; }
    .fico-hdr-pos { display:inline-flex; flex-direction:column; align-items:stretch; gap:2px; margin-left:4px; padding:2px 6px 3px; min-width:64px; border-radius:6px; background:linear-gradient(135deg, color-mix(in srgb, var(--fico-cyan) 9%, transparent), color-mix(in srgb, var(--fico-violet) 7%, transparent)); border:1px solid color-mix(in srgb, var(--fico-cyan) 30%, var(--fico-border)); box-shadow:inset 0 1px 0 var(--fico-edge-highlight), 0 0 14px color-mix(in srgb, var(--fico-cyan) 10%, transparent); position:relative; overflow:hidden; flex-shrink:0; }
    .fico-hdr-pos::before { content:''; position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg, transparent, var(--fico-cyan), var(--fico-violet), transparent); opacity:0.75; pointer-events:none; }
    .fico-hdr-pos::after { content:''; position:absolute; inset:0; background:repeating-linear-gradient(0deg, transparent, transparent 2px, color-mix(in srgb, var(--fico-cyan) 4%, transparent) 2px, color-mix(in srgb, var(--fico-cyan) 4%, transparent) 3px); opacity:0.35; pointer-events:none; mix-blend-mode:overlay; }
    .fico-pos-tag { font-size:0.5rem; font-weight:800; letter-spacing:0.22em; color:color-mix(in srgb, var(--fico-cyan) 75%, var(--sapContent_LabelColor)); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; line-height:1; text-align:center; position:relative; z-index:1; }
    .fico-pos-core { display:flex; align-items:baseline; justify-content:center; gap:3px; line-height:1; position:relative; z-index:1; }
    .fico-pos-cur { font-size:0.88rem; font-weight:800; font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:linear-gradient(165deg, var(--fico-cyan), var(--fico-violet)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; filter:drop-shadow(0 0 5px color-mix(in srgb, var(--fico-cyan) 42%, transparent)); min-width:1.35em; text-align:right; }
    .fico-pos-sep { width:4px; height:4px; border-radius:1px; background:linear-gradient(135deg, var(--fico-cyan), var(--fico-violet)); transform:rotate(45deg); opacity:0.8; flex-shrink:0; align-self:center; margin:0 1px; box-shadow:0 0 4px color-mix(in srgb, var(--fico-cyan) 35%, transparent); }
    .fico-pos-tot { font-size:0.62rem; font-weight:600; font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--sapContent_LabelColor,#6a6d70); min-width:1.15em; text-align:left; opacity:0.92; }
    .fico-pos-track { height:2px; border-radius:2px; background:color-mix(in srgb, var(--fico-cyan) 12%, var(--sapGroup_ContentBorderColor,#e0e0e0)); overflow:hidden; position:relative; z-index:1; }
    .fico-pos-fill { height:100%; width:0%; border-radius:2px; background:linear-gradient(90deg, var(--fico-cyan), var(--fico-violet)); box-shadow:0 0 8px color-mix(in srgb, var(--fico-cyan) 50%, transparent); transition:width 0.28s cubic-bezier(0.4,0,0.2,1); }
    .fico-hdr-nav { display:flex; align-items:center; gap:2px; flex-shrink:0; flex:1 1 auto; min-width:0; flex-wrap:wrap; }
    .fico-line-nav { display:flex; align-items:center; justify-content:flex-end; gap:2px; flex-shrink:0; flex:0 0 auto; margin-left:auto; flex-wrap:nowrap; }
    .fico-hdr-nav ui5-button, .fico-line-nav ui5-button { width:var(--fico-hdr-nav-btn-size); height:var(--fico-hdr-nav-btn-size); min-width:var(--fico-hdr-nav-btn-size); min-height:var(--fico-hdr-nav-btn-size); padding:0; box-sizing:border-box; --sapButton_Height:var(--fico-hdr-nav-btn-size); --_ui5_button_base_min_width:var(--fico-hdr-nav-btn-size); --_ui5_button_base_min_height:var(--fico-hdr-nav-btn-size); }
    .fico-hdr-act-wrap { flex-shrink:0; margin-right:4px; }
    .fico-act-rail { display:flex; align-items:center; gap:0; padding:0 3px; border-radius:6px; background:color-mix(in srgb, var(--sapList_Background,#fff) 68%, transparent); border:1px solid color-mix(in srgb, var(--fico-cyan) 22%, var(--fico-border)); box-shadow:inset 0 0 8px color-mix(in srgb, var(--fico-cyan) 5%, transparent), inset 0 1px 0 var(--fico-edge-highlight); }
    .fico-util-chip { --util-hue:var(--fico-cyan); position:relative; display:flex; align-items:center; justify-content:center; width:var(--fico-hdr-nav-btn-size); height:var(--fico-hdr-nav-btn-size); margin:0 1px 0 0; padding:0; border:none; border-radius:4px; cursor:pointer; background:transparent; color:var(--util-hue); font-size:0.58rem; font-weight:900; font-family:ui-monospace,monospace; }
    .fico-util-chip::before { content:''; position:absolute; inset:2px; border-radius:5px; border:1px solid color-mix(in srgb, var(--util-hue) 28%, transparent); background:color-mix(in srgb, var(--sapList_Background) 85%, transparent); z-index:0; }
    .fico-util-chip span { position:relative; z-index:1; }
    .fico-util-chip:hover:not(:disabled):not(.is-disabled)::before { border-color:color-mix(in srgb, var(--util-hue) 55%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--util-hue) 25%, transparent); }
    .fico-util-chip.is-active::before { border-color:var(--util-hue); background:color-mix(in srgb, var(--util-hue) 12%, transparent); }
    .fico-util-chip:disabled, .fico-util-chip.is-disabled { opacity:0.32; cursor:not-allowed; filter:grayscale(0.85); }
    .fico-act-chip { --act-hue:var(--fico-cyan); position:relative; display:flex; align-items:center; justify-content:center; width:calc(var(--fico-hdr-nav-btn-size) + 1px); height:var(--fico-hdr-nav-btn-size); margin:0; padding:0 1px; border:none; border-radius:4px; cursor:pointer; background:transparent; color:var(--act-hue); font-family:ui-monospace,monospace; }
    .fico-act-chip::before { content:''; position:absolute; inset:1px; border-radius:4px; background:linear-gradient(145deg, color-mix(in srgb, var(--act-hue) 18%, transparent), transparent 55%), color-mix(in srgb, var(--sapList_Background,#fff) 82%, transparent); border:1px solid color-mix(in srgb, var(--act-hue) 38%, transparent); box-shadow:inset 0 1px 0 var(--fico-edge-highlight); z-index:0; }
    .fico-act-chip::after { content:''; position:absolute; top:50%; right:-1px; width:10px; height:2px; transform:translateY(-50%); background:linear-gradient(90deg, color-mix(in srgb, var(--act-hue) 55%, transparent), transparent); opacity:0.65; pointer-events:none; z-index:2; }
    .fico-act-chip:last-child::after { display:none; }
    .fico-act-chip[data-act="validate"] { --act-hue:var(--fico-violet); }
    .fico-act-chip[data-act="save"] { --act-hue:var(--fico-mint); }
    .fico-act-chip[data-act="post"] { --act-hue:var(--fico-post); }
    .fico-act-chip[data-act="reverse"] { --act-hue:#ef4444; }
    .fico-act-glyph { position:relative; z-index:1; font-size:0.68rem; font-weight:900; line-height:1; letter-spacing:0.05em; font-family:"STKaiti","KaiTi","Songti SC",serif; background:linear-gradient(160deg, var(--act-hue), color-mix(in srgb, var(--act-hue) 42%, var(--sapTextColor,#fff))); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; filter:drop-shadow(0 0 3px color-mix(in srgb, var(--act-hue) 35%, transparent)); }
    .fico-act-chip:hover:not(:disabled):not(.is-disabled)::before { box-shadow:inset 0 1px 0 var(--fico-edge-highlight), 0 0 8px color-mix(in srgb, var(--act-hue) 30%, transparent); border-color:color-mix(in srgb, var(--act-hue) 65%, transparent); }
    .fico-act-chip:disabled, .fico-act-chip.is-disabled { cursor:not-allowed; opacity:0.32; filter:grayscale(0.85); }
    .fico-kpi-row { display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap; align-self:center; }
    .fico-kpi { min-width:72px; padding:3px 8px; border-radius:7px; background:color-mix(in srgb, var(--sapList_Background,#fff) 78%, transparent); border:1px solid var(--fico-border); text-align:center; display:flex; flex-direction:column; justify-content:center; gap:1px; }
    .fico-kpi-lbl { font-size:0.56rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--sapContent_LabelColor,#6a6d70); white-space:nowrap; }
    .fico-kpi-val { font-size:0.82rem; font-weight:800; font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--sapTitleColor,#223548); line-height:1.2; }
    .fico-kpi-val.fico-ok { color:var(--fico-mint); }
    .fico-kpi-val.fico-warn { color:var(--fico-warn); }
    .fico-kpi-status { min-width:80px; }
    .fico-dc-ring-wrap { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; padding:2px 4px; min-width:36px; }
    #dcMixRing { width:22px; height:22px; border-radius:50%; padding:2px; background:conic-gradient(var(--fico-cyan) 0% 50%, var(--fico-violet) 50% 100%); box-sizing:border-box; }
    #dcMixRing::after { content:''; display:block; width:100%; height:100%; border-radius:50%; background:var(--sapList_Background,#fff); }
    .fico-dc-badge { font-size:0.52rem; font-weight:800; letter-spacing:0.07em; color:var(--fico-cyan); font-family:ui-monospace,monospace; }
    .fico-hdr-form { display:block; flex:0 0 auto; padding:1px 4px 3px; }
    .fico-grid-panel { display:flex; flex-direction:column; flex:1 1 0; min-height:0; background:var(--sapList_Background,#fff); border:1px solid var(--sapGroup_ContentBorderColor,#e0e0e0); border-radius:8px; overflow:hidden; }
    .fico-grid-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 10px; background:var(--sapTile_Background,#fff); border-bottom:1px solid var(--sapGroup_ContentBorderColor,#e0e0e0); font-size:0.85rem; font-weight:700; }
    .fico-grid-head-title { display:flex; align-items:center; gap:4px; min-width:0; }
    .fico-grid-head-title ui5-icon { width:0.875rem; height:0.875rem; color:var(--sapInformationColor,#0a6ed1); flex-shrink:0; }
    @media (max-width:720px) { .fico-seal{width:34px;height:34px;} .fico-kpi-row{width:100%;justify-content:space-between;} .fico-hdr-nav{flex-wrap:nowrap;overflow-x:auto;max-width:100%;} }
`;

const CONTENT_HTML = `<div class="fico-ws-root" style="display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;padding:8px;background:var(--sapBackgroundColor,#f7f7f7);">
  <style>${CONTENT_CSS}
  </style>
  <div class="fico-hdr-panel">
    <div class="fico-hdr-hero">
      <div class="fico-seal-strip" aria-label="凭证状态章">
        <div id="sealDraft" class="fico-seal" data-kind="draft" data-state="hidden" title="草稿"><span class="fico-seal-text"><span>草</span><span>稿</span></span></div>
        <div id="sealAudited" class="fico-seal" data-kind="audited" data-state="hidden" title="审核"><span class="fico-seal-text"><span>审</span><span>核</span></span></div>
        <div id="sealPosted" class="fico-seal" data-kind="posted" data-state="hidden" title="过账"><span class="fico-seal-text"><span>过</span><span>账</span></span></div>
      </div>
      <div class="fico-hdr-main">
        <div class="fico-hdr-title-row">
          <div class="fico-hdr-headband"><h2 class="fico-hdr-title">会计凭证</h2></div>
          <div class="fico-hdr-nav">
            <div class="fico-hdr-act-wrap">
              <div class="fico-act-rail" role="toolbar" aria-label="凭证操作">
                <button type="button" id="btnEdit" class="fico-util-chip" data-eventclick="toggleVoucherEdit();" title="编辑" aria-label="编辑"><span aria-hidden="true">编</span></button>
                <button type="button" id="btnValidate" class="fico-act-chip" data-act="validate" data-eventclick="doValidateVoucher();" title="校验" aria-label="校验"><span class="fico-act-glyph" aria-hidden="true">校</span></button>
                <button type="button" id="btnSave" class="fico-act-chip" data-act="save" data-eventclick="doSaveVoucher();" title="保存" aria-label="保存"><span class="fico-act-glyph" aria-hidden="true">存</span></button>
                <button type="button" id="btnPost" class="fico-act-chip" data-act="post" data-eventclick="doPostVoucher();" title="过账" aria-label="过账"><span class="fico-act-glyph" aria-hidden="true">账</span></button>
                <button type="button" id="btnReverse" class="fico-act-chip" data-act="reverse" data-eventclick="doReverseVoucher();" title="冲销" aria-label="冲销"><span class="fico-act-glyph" aria-hidden="true">冲</span></button>
              </div>
            </div>
            <ui5-button id="btnFirst" icon="close-command-field" design="Transparent" tooltip="首行" data-eventclick="navHeader('first');"></ui5-button>
            <ui5-button id="btnPrev" icon="navigation-left-arrow" design="Transparent" tooltip="上一张" data-eventclick="navHeader('prev');"></ui5-button>
            <ui5-button id="btnNext" icon="navigation-right-arrow" design="Transparent" tooltip="下一张" data-eventclick="navHeader('next');"></ui5-button>
            <ui5-button id="btnLast" icon="open-command-field" design="Transparent" tooltip="尾行" data-eventclick="navHeader('last');"></ui5-button>
            <ui5-button id="btnDetail" icon="detail-view" design="Transparent" tooltip="凭证头详情" data-eventclick="showHeaderDetail();"></ui5-button>
            <div id="hdrPos" class="fico-hdr-pos" aria-label="当前凭证序号">
              <span class="fico-pos-tag">SEQ</span>
              <div class="fico-pos-core">
                <span id="hdrPosCur" class="fico-pos-cur">01</span>
                <span class="fico-pos-sep" aria-hidden="true"></span>
                <span id="hdrPosTot" class="fico-pos-tot">00</span>
              </div>
              <div class="fico-pos-track" aria-hidden="true"><div id="hdrPosFill" class="fico-pos-fill"></div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="fico-kpi-row" aria-label="借贷平衡">
        <div class="fico-kpi"><div class="fico-kpi-lbl">借方 Debit</div><div class="fico-kpi-val" id="kpiDebit">0.00</div></div>
        <div class="fico-dc-ring-wrap"><div id="dcMixRing" title="借贷结构"></div><span class="fico-dc-badge">DC</span></div>
        <div class="fico-kpi"><div class="fico-kpi-lbl">贷方 Credit</div><div class="fico-kpi-val" id="kpiCredit">0.00</div></div>
        <div class="fico-kpi fico-kpi-status"><div class="fico-kpi-lbl">平衡状态</div><div class="fico-kpi-val fico-ok" id="kpiBalance">—</div></div>
      </div>
    </div>
    <cmx-ui5-form id="headerForm" class="fico-hdr-form" data-cmx-skin="neo" data-cmx-density="compact" data-cmx-layout="S1 M3 L3 XL3"></cmx-ui5-form>
  </div>
  <div style="flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;">
    <div class="fico-grid-panel">
      <div class="fico-grid-head">
        <span class="fico-grid-head-title"><ui5-icon name="table-view"></ui5-icon>科目行</span>
        <div class="fico-line-nav">
          <ui5-button icon="close-command-field" design="Transparent" tooltip="首行" data-eventclick="navLine('account','first');"></ui5-button>
          <ui5-button icon="navigation-left-arrow" design="Transparent" tooltip="上一行" data-eventclick="navLine('account','prev');"></ui5-button>
          <ui5-button icon="navigation-right-arrow" design="Transparent" tooltip="下一行" data-eventclick="navLine('account','next');"></ui5-button>
          <ui5-button icon="open-command-field" design="Transparent" tooltip="尾行" data-eventclick="navLine('account','last');"></ui5-button>
        </div>
      </div>
      <cmx-revo-grid id="accGrid" data-cmx-skin-tone="cyan" style="display:block;width:100%;flex:1;min-height:0;"></cmx-revo-grid>
    </div>
    <div class="fico-grid-panel">
      <div class="fico-grid-head">
        <span class="fico-grid-head-title"><ui5-icon name="tree"></ui5-icon>辅助行</span>
        <div class="fico-line-nav">
          <ui5-button icon="close-command-field" design="Transparent" tooltip="首行" data-eventclick="navLine('aux','first');"></ui5-button>
          <ui5-button icon="navigation-left-arrow" design="Transparent" tooltip="上一行" data-eventclick="navLine('aux','prev');"></ui5-button>
          <ui5-button icon="navigation-right-arrow" design="Transparent" tooltip="下一行" data-eventclick="navLine('aux','next');"></ui5-button>
          <ui5-button icon="open-command-field" design="Transparent" tooltip="尾行" data-eventclick="navLine('aux','last');"></ui5-button>
        </div>
      </div>
      <cmx-revo-grid id="auxGrid" data-cmx-skin-tone="azure" style="display:block;width:100%;flex:1;min-height:0;"></cmx-revo-grid>
    </div>
  </div>
  <span id="statusText" style="display:none;"></span>
</div>`;

const EXPLORER_SKIN = `
    .cmx-list { gap:8px; padding:8px 10px; --fico-batch-accent:#00b4d8; --fico-batch-accent-2:#7c3aed; --fico-batch-mint:#10b981; --fico-batch-ic-size:26px; --fico-batch-icon-size:14px; --fico-batch-ic-radius:7px; }
    .cmx-list-item { gap:8px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--sapList_Background,#fff) 92%, transparent); border:1px solid color-mix(in srgb, var(--fico-batch-accent) 16%, var(--sapGroup_TitleBorderColor,#ddd)); transition:border-color 0.18s ease, box-shadow 0.18s ease, transform 0.15s ease, background 0.18s ease; }
    .cmx-list-item:not(.is-selected):hover { transform:translateY(-2px); border-color:var(--fico-batch-accent); box-shadow:0 8px 24px color-mix(in srgb, var(--fico-batch-accent) 14%, transparent); }
    .cmx-list-item.is-selected { background:linear-gradient(105deg, color-mix(in srgb, var(--fico-batch-accent-2) 14%, var(--sapList_Background,#fff)), color-mix(in srgb, var(--fico-batch-accent) 12%, var(--sapList_Background,#fff))); border:1px solid color-mix(in srgb, var(--fico-batch-accent-2) 30%, var(--fico-batch-accent) 20%); box-shadow:0 4px 16px color-mix(in srgb, var(--fico-batch-accent-2) 12%, transparent); }
    .cmx-list-item__ic { width:var(--fico-batch-ic-size); height:var(--fico-batch-ic-size); border-radius:var(--fico-batch-ic-radius); background:color-mix(in srgb, var(--fico-batch-accent) 12%, transparent); color:var(--fico-batch-accent); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .cmx-list-item__ic ui5-icon { width:var(--fico-batch-icon-size); height:var(--fico-batch-icon-size); color:inherit; }
    .cmx-list-item.is-selected .cmx-list-item__ic { background:conic-gradient(from 210deg, var(--fico-batch-accent-2), var(--fico-batch-accent), var(--fico-batch-mint), var(--fico-batch-accent-2)); color:#fff; }
    .cmx-list-item.is-selected .cmx-list-item__ic ui5-icon { color:#fff; }
    .cmx-list-item__title { font-size:var(--sapFontSize,0.875rem); font-weight:600; color:var(--sapTextColor,#223548); overflow-wrap:anywhere; line-height:1.35; }
    .cmx-list-item__desc { font-size:0.75rem; color:var(--sapContent_LabelColor,#6a6d70); margin-top:2px; line-height:1.4; overflow-wrap:anywhere; }
`;

const EXPLORER_HTML = `<div class="fico-ws-explorer" style="display:flex;flex-direction:column;height:100%;box-sizing:border-box;background:var(--sapList_Background);">
  <style>
    .fico-ws-explorer { --fico-exp-head-size:var(--sapFontSize,0.875rem); --fico-exp-sub-size:0.75rem; }
    .fico-exp-section-head { padding:6px 10px; border-bottom:1px solid var(--sapGroup_ContentBorderColor,#e0e0e0); flex:0 0 auto; display:flex; align-items:center; gap:6px; font-size:var(--fico-exp-head-size); font-weight:600; line-height:1.35; color:var(--sapTitleColor,#223548); }
    .fico-exp-section-head ui5-icon { width:0.875rem; height:0.875rem; flex-shrink:0; color:var(--sapInformationColor,#0a6ed1); }
    .fico-exp-section-meta { font-weight:400; color:var(--sapContent_LabelColor,#6a6d70); font-size:var(--fico-exp-sub-size); }
    .fico-exp-batch-pane { flex:1 1 50%; min-height:0; display:flex; flex-direction:column; border-bottom:2px solid var(--sapGroup_ContentBorderColor,#d0d0d0); background:color-mix(in srgb, var(--sapList_Background,#fff) 96%, #7c3aed 4%); }
    .fico-exp-detail-pane { flex:1 1 50%; min-height:0; display:flex; flex-direction:column; }
    .fico-exp-batch-list { flex:1; min-height:0; background:transparent; }
    .fico-exp-batch-form { display:block; flex:1; min-height:0; overflow:auto; padding:2px; font-size:var(--fico-exp-head-size); }
    .fico-exp-pager { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 10px; border-top:1px solid var(--sapGroup_ContentBorderColor,#e0e0e0); background:var(--sapTile_Background,#fff); }
    .fico-exp-pager-info { font-size:var(--fico-exp-sub-size); color:var(--sapContent_LabelColor,#6a6d70); }
  </style>
  <template id="fico-batch-list-skin">${EXPLORER_SKIN}
  </template>
  <div class="fico-exp-batch-pane">
    <div class="fico-exp-section-head"><ui5-icon name="list"></ui5-icon>凭证批 <span id="statusText" class="fico-exp-section-meta"></span></div>
    <cmx-ignite-list id="batchList" class="fico-exp-batch-list" data-cmx-layout="card" data-cmx-style-id="fico-batch-list-skin" data-cmx-density="compact" style="display:block;flex:1;min-height:0;overflow:auto;"></cmx-ignite-list>
    <div class="fico-exp-pager">
      <ui5-button id="btnPrevPage" icon="navigation-left-arrow" design="Transparent" tooltip="上一页" data-eventclick="gotoPage('prev');">上一页</ui5-button>
      <span id="pageInfo" class="fico-exp-pager-info">—</span>
      <ui5-button id="btnNextPage" icon="navigation-right-arrow" design="Transparent" tooltip="下一页" data-eventclick="gotoPage('next');">下一页</ui5-button>
    </div>
  </div>
  <div class="fico-exp-detail-pane">
    <div class="fico-exp-section-head"><ui5-icon name="form"></ui5-icon>凭证批详情 <span id="batchPos" class="fico-exp-section-meta"></span></div>
    <cmx-ui5-form id="batchForm" class="fico-exp-batch-form" data-cmx-skin="neo" data-cmx-density="compact" data-cmx-layout="S1 M1 L2 XL2"></cmx-ui5-form>
  </div>
</div>`;

function fnPrefix (meta, refName) {
  const ref = meta.pageFns.find(f => f.name === refName);
  if (!ref) return '';
  const cut = ref.body.indexOf('function fireModelReady');
  return cut >= 0 ? ref.body.slice(0, cut) : ref.body.split('function headersDs')[0] || ref.body;
}

// ── Content meta: 保留按张加载逻辑，增量 UI chrome ──
const contentMeta = extractMeta('fico-ws-content.html');
const prefix = fnPrefix(contentMeta, 'navHeader');

function upsertFn (name, params, tail) {
  const existing = contentMeta.pageFns.find(f => f.name === name);
  const body = prefix + CHROME_HELPERS + tail;
  if (existing) { existing.body = body; existing.params = params; }
  else contentMeta.pageFns.push({ name, params, body, readsVars: [], writesVars: [] });
}

upsertFn('refreshHeaderChrome', 'ms', `
function refreshHeaderChrome(ms){
  var mh=modelHost();
  var p=mh&&mh.getVoucherPos&&mh.getVoucherPos();
  if(p&&p.total>0) host.updateHdrPosDisplay(p.idx+1, p.total);
  else host.updateHdrPosDisplay(0,0);
  var row=currentHeaderRow(ms);
  var dr=row?(+row.entered_dr||+row.local_dr||0):0;
  var cr=row?(+row.entered_cr||+row.local_cr||0):0;
  setText('kpiDebit',fmt(dr)); setText('kpiCredit',fmt(cr));
  var balEl=$('#kpiBalance');
  if(balEl){ var diff=Math.abs(dr-cr); if(diff<0.005){ balEl.textContent='✓ 平衡'; balEl.className='fico-kpi-val fico-ok'; } else { balEl.textContent='差额 '+fmt(diff); balEl.className='fico-kpi-val fico-warn'; } }
  var ring=$('#dcMixRing'); if(ring){ var tot=dr+cr; var pDr=tot>0?Math.round(dr/tot*100):50; ring.style.background='conic-gradient(#00b4d8 0% '+pDr+'%, #7c3aed '+pDr+'% 100%)'; }
  applySealStates(mapDocStatus(row&&row.document_status));
  if(host.syncVoucherActionButtons) host.syncVoucherActionButtons(ms);
}
refreshHeaderChrome(ms);
`);

upsertFn('navLine', 'level,dir', `
var ms=host.__ms||getMS(); if(!ms)return; var ds=lineDs(ms,level); if(!ds)return;
if(dir==='first')ds.moveFirst(); else if(dir==='last')ds.moveLast(); else if(dir==='prev'){if(!ds.isFirst)ds.movePrev();} else if(dir==='next'){if(!ds.isLast)ds.moveNext();}
host.__userLevel=level==='aux'?'aux':'account'; var row=ds.currentRow; var c=ctx(); if(c&&row)c.set('currentLine',{level:host.__userLevel,id:row.id});
`);

upsertFn('toggleVoucherEdit', '', `
host.__voucherEditing = !host.__voucherEditing;
var btn=$('#btnEdit'); if(btn) btn.classList.toggle('is-active', !!host.__voucherEditing);
var hf=$('#headerForm'); if(hf&&typeof hf.setEditable==='function') hf.setEditable(!!host.__voucherEditing);
setText('statusText', host.__voucherEditing ? '已进入编辑模式' : '已退出编辑模式');
if(host.syncVoucherActionButtons) host.syncVoucherActionButtons(host.__ms||getMS());
`);

upsertFn('doValidateVoucher', '', `
var ms=host.__ms||getMS(); if(!ms){ setText('statusText','模型未就绪'); return; }
var row=currentHeaderRow(ms); var dr=row?(+row.entered_dr||+row.local_dr||0):0; var cr=row?(+row.entered_cr||+row.local_cr||0):0; var diff=Math.abs(dr-cr);
if(diff<0.005){ setText('statusText','校验通过：借贷平衡 ✓'); } else { setText('statusText','校验未通过：借贷差额 '+fmt(diff)); }
refreshHeaderChrome(ms);
`);

upsertFn('doSaveVoucher', '', `
var ms=host.__ms||getMS(); if(!ms||typeof ms.exportKeyValue!=='function'){ setText('statusText','保存失败'); return; }
try{ var text=JSON.stringify(ms.exportKeyValue(),null,2); var blob=new Blob([text],{type:'application/json;charset=utf-8'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='fico-voucher-export.json'; document.body.appendChild(a); a.click(); setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); },0); setText('statusText','已保存并导出 JSON'); }catch(e){ setText('statusText','保存失败'); }
`);

upsertFn('doPostVoucher', '', `
if(typeof host.postVoucher==='function') host.postVoucher('操作栏');
var row=currentHeaderRow(host.__ms||getMS()); if(row&&typeof row.set==='function') row.set('document_status','posted'); else if(row) row.document_status='posted';
refreshHeaderChrome(host.__ms||getMS());
`);

upsertFn('doReverseVoucher', '', `
var ms=host.__ms||getMS(); var row=currentHeaderRow(ms);
if(row&&typeof row.set==='function') row.set('document_status','draft'); else if(row) row.document_status='draft';
host.__voucherEditing=false; var eb=$('#btnEdit'); if(eb) eb.classList.remove('is-active');
setText('statusText','【冲销】已冲销回草稿(示意)'); refreshHeaderChrome(ms);
`);

upsertFn('syncVoucherActionButtons', 'ms', `
['btnEdit','btnValidate','btnSave','btnPost','btnReverse'].forEach(function(id){ disBtn($('#'+id), false); });
var eb=$('#btnEdit'); if(eb) eb.classList.toggle('is-active', !!host.__voucherEditing);
`);

const initIface = contentMeta.pageInterfaces.find(i => i.name === 'initPage');
if (initIface) {
  initIface.body = initIface.body.replace(/function refreshHdrPos\(m\)\{[\s\S]*?\}\n\n/, '');
  if (!initIface.body.includes('host.updateHdrPosDisplay')) {
    const insertAt = initIface.body.indexOf("setText('statusText','等待模型...');");
    const hudFn = `
host.updateHdrPosDisplay = host.updateHdrPosDisplay || function(cur, tot){
  var curEl=$('#hdrPosCur'), totEl=$('#hdrPosTot'), fillEl=$('#hdrPosFill'), wrap=$('#hdrPos');
  if(curEl) curEl.textContent = tot>0 ? String(cur).padStart(2,'0') : '—';
  if(totEl) totEl.textContent = tot>0 ? String(tot).padStart(2,'0') : '—';
  if(fillEl) fillEl.style.width = (tot>0 ? Math.round(cur/tot*100) : 0) + '%';
  if(wrap){
    wrap.setAttribute('data-pos', tot>0 ? (cur+'/'+tot) : '');
    wrap.setAttribute('aria-label', tot>0 ? ('当前凭证 '+cur+' / '+tot) : '当前凭证序号');
  }
};

` + REFRESH_CHROME_FN.replace('refreshHeaderChrome(ms);', '');
    if (insertAt >= 0) {
      initIface.body = initIface.body.slice(0, insertAt) + hudFn + initIface.body.slice(insertAt);
    }
  }
  initIface.body = initIface.body.replace(/function refreshHdrPos\(m\)\{[\s\S]*?\}/g, '');
  initIface.body = initIface.body.replace(/refreshHdrPos\(m\)/g, 'refreshHeaderChrome(ms)');
  initIface.body = initIface.body.replace(/refreshHdrPos\(mm\)/g, 'refreshHeaderChrome(mm.voucherMS||host.__ms||getMS())');
  if (!initIface.body.includes("onModelEvent('voucher'")) {
    initIface.body = initIface.body.replace(
      /onModelEvent\('voucher', function\(mm\)\{ refreshHeaderChrome/,
      "onModelEvent('voucher', function(mm){ refreshHeaderChrome"
    );
  }
  initIface.body = initIface.body.replace(
    /onModelEvent\('voucher', function\(mm\)\{[^}]+\}\);/,
    "onModelEvent('voucher', function(mm){ refreshHeaderChrome(mm.voucherMS||host.__ms||getMS()); });"
  );
  initIface.body = initIface.body.replace(
    /setTimeout\(function\(\)\{ refreshHeaderChrome\(ms\); \},80\);/,
    "setTimeout(function(){ refreshHeaderChrome(ms); },80);"
  );
}

const apiIface = contentMeta.pageInterfaces.find(i => i.name === 'getPageApi');
if (apiIface) {
  apiIface.body = `return {
  postVoucher: host.postVoucher,
  navHeader: host.navHeader,
  navLine: host.navLine,
  showHeaderDetail: host.showHeaderDetail,
  refreshHeaderChrome: host.refreshHeaderChrome,
  toggleVoucherEdit: host.toggleVoucherEdit,
  doValidateVoucher: host.doValidateVoucher,
  doSaveVoucher: host.doSaveVoucher,
  doPostVoucher: host.doPostVoucher,
  doReverseVoucher: host.doReverseVoucher,
  syncVoucherActionButtons: host.syncVoucherActionButtons
};`;
}

writePage('fico-ws-content.html', CONTENT_HTML, contentMeta);

// ── Explorer: 换皮肤 HTML，meta 保留并加 __icon ──
const explorerMeta = extractMeta('fico-ws-explorer.html');
const expInit = explorerMeta.pageInterfaces.find(i => i.name === 'initPage');
if (expInit && !expInit.body.includes("__icon:'batch-payments'")) {
  expInit.body = expInit.body.replace(
    /return \{ id:bi\.batch_no, batch_name:bi\.batch_name, __sub:\(bi\.company_code_id\|\|''\)\+' · '\+\(bi\.count\|\|0\)\+' 张', __idx:bi\.idx \};/,
    "return { id:bi.batch_no, batch_name:bi.batch_name, __sub:(bi.company_code_id||'')+' · '+(bi.count||0)+' 张', __idx:bi.idx, __icon:'batch-payments' };"
  );
}
writePage('fico-ws-explorer.html', EXPLORER_HTML, explorerMeta);

console.log('restored fico skins v2 (preserved per-voucher meta)');
