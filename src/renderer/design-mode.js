/**
 * SEOZ Design Mode — Visual editor overlay with change tracking
 *
 * Flow:
 *   1. User activates Design Mode (Ctrl+Shift+D or dock icon)
 *   2. User selects elements, edits text/CSS/moves things → live DOM preview
 *   3. Every edit is tracked: { selector, type, original, modified }
 *   4. User clicks "Push till Claude" → Claude gets the change list + page route
 *   5. Claude finds the source files and writes the changes permanently
 */

;(function () {
  'use strict'

  // ══════════════════════════════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════════════════════════════
  let active = false
  let mode = 'inspect'         // 'inspect' | 'annotate' | 'move'
  let annotateTool = 'rect'    // 'rect' | 'text' | 'arrow'
  let selectedElement = null
  let elementAncestry = []
  let annotations = []
  let drawStart = null
  let moveState = null
  let isEditing = false

  // ── CHANGE TRACKER ──
  // Every visual edit is recorded here so Claude can map it to source code
  const changes = [] // [{ id, selector, type, description, original, modified, timestamp }]
  let changeIdCounter = 0

  function recordChange(selector, type, description, original, modified) {
    changes.push({
      id: ++changeIdCounter,
      selector,
      type,       // 'text' | 'css' | 'html' | 'move' | 'hide'
      description,
      original,
      modified,
      timestamp: Date.now(),
    })
    updateChangeBadge()
    console.log(`[DesignMode] Change #${changeIdCounter}: ${type} — ${description}`)
  }

  function undoLastChange() {
    const last = changes.pop()
    if (!last) return
    // Revert the DOM change
    const wv = getWebview()
    if (!wv) return
    if (last.type === 'text') {
      wv.executeJavaScript(`(function(){
        const el = document.querySelector(${JSON.stringify(last.selector)});
        if(el){
          if(el.children.length===0) el.textContent=${JSON.stringify(last.original)};
          else { const tn=Array.from(el.childNodes).find(n=>n.nodeType===3&&n.textContent.trim()); if(tn)tn.textContent=${JSON.stringify(last.original)}; }
        }
      })()`).catch(()=>{})
    } else if (last.type === 'css') {
      wv.executeJavaScript(`(function(){
        const el = document.querySelector(${JSON.stringify(last.selector)});
        if(el){ const orig=${JSON.stringify(last.original)}; for(const[k,v]of Object.entries(orig)) el.style[k]=v; }
      })()`).catch(()=>{})
    } else if (last.type === 'move') {
      wv.executeJavaScript(`(function(){
        const el = document.querySelector(${JSON.stringify(last.selector)});
        if(el) el.style.transform = ${JSON.stringify(last.original)};
      })()`).catch(()=>{})
    } else if (last.type === 'hide') {
      wv.executeJavaScript(`(function(){
        const el = document.querySelector(${JSON.stringify(last.selector)});
        if(el) el.style.display = ${JSON.stringify(last.original)};
      })()`).catch(()=>{})
    } else if (last.type === 'html') {
      wv.executeJavaScript(`(function(){
        const el = document.querySelector(${JSON.stringify(last.selector)});
        if(el) el.outerHTML = ${JSON.stringify(last.original)};
      })()`).catch(()=>{})
    }
    updateChangeBadge()
  }

  const COLORS = { select: '#4680ff', hover: 'rgba(70,128,255,0.35)', annotation: '#e58a00', move: '#2ca87f' }

  function getWebview() {
    return window.__designGetWebview ? window.__designGetWebview() : document.getElementById('wv')
  }

  // ══════════════════════════════════════════════════════════════════════
  //  OVERLAY DOM
  // ══════════════════════════════════════════════════════════════════════
  const overlay = document.createElement('div')
  overlay.id = 'designOverlay'
  overlay.innerHTML = `
    <style>
      #designOverlay { position:absolute;inset:0;z-index:200;pointer-events:none;display:none }
      #designOverlay.active { display:block }
      #designOverlay.interact { pointer-events:auto;cursor:crosshair }
      #designOverlay.mode-move { cursor:move }

      /* Toolbar */
      #designToolbar {
        position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:210;pointer-events:auto;
        display:flex;align-items:center;gap:2px;
        background:#1b232d;border:1px solid #303f50;border-radius:10px;padding:4px 6px;
        box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:'Inter',sans-serif;font-size:11px;color:#bfbfbf;
        user-select:none;-webkit-app-region:no-drag;
      }
      [data-theme="light"] #designToolbar { background:#fff;border-color:#e7eaee;color:#131920 }
      .dt-btn {
        width:32px;height:32px;border:none;border-radius:7px;background:transparent;color:inherit;
        cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s;position:relative;
      }
      .dt-btn:hover { background:rgba(255,255,255,.08) }
      .dt-btn.active { background:rgba(70,128,255,.15);color:#4680ff }
      .dt-btn svg { width:16px;height:16px }
      .dt-sep { width:1px;height:20px;background:#303f50;margin:0 4px;flex-shrink:0 }
      .dt-label { font-size:10px;font-weight:600;padding:0 6px;white-space:nowrap;color:#748892 }
      .dt-swatch { width:16px;height:16px;border-radius:50%;border:2px solid transparent;cursor:pointer }
      .dt-swatch.active { border-color:#fff }

      /* Changes badge */
      .dt-badge {
        min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;
        font-size:9px;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 4px;
      }
      .dt-badge.show { display:flex }

      /* Highlight */
      #designHighlight { position:absolute;pointer-events:none;z-index:203;border:2px solid #4680ff;background:rgba(70,128,255,.08);border-radius:2px;transition:all 60ms;display:none }
      #designHighlight.show { display:block }
      #designHighlightLabel { position:absolute;pointer-events:none;z-index:204;background:#4680ff;color:#fff;font-size:9px;font-weight:700;font-family:'Inter',sans-serif;padding:1px 5px;border-radius:2px;white-space:nowrap;display:none }
      #designHighlightLabel.show { display:block }

      /* Canvas */
      #designCanvas { position:absolute;inset:0;z-index:205;pointer-events:none }
      #designOverlay.mode-annotate #designCanvas { pointer-events:auto }
      #designDrawPreview { position:absolute;pointer-events:none;z-index:204;border:2px solid #e58a00;background:rgba(229,138,0,.08);display:none }
      #designDrawPreview.show { display:block }

      /* Handles */
      .design-handle { position:absolute;width:8px;height:8px;background:#fff;border:2px solid #4680ff;border-radius:2px;z-index:206;pointer-events:auto;display:none }
      #designOverlay.mode-move .design-handle { display:block }

      /* Info panel */
      #designInfo {
        position:absolute;bottom:10px;left:10px;z-index:210;pointer-events:auto;
        max-width:420px;max-height:360px;
        background:#1b232d;border:1px solid #303f50;border-radius:10px;padding:10px 12px;
        box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:'Inter',sans-serif;font-size:11px;color:#bfbfbf;
        overflow-y:auto;display:none;-webkit-app-region:no-drag;
      }
      [data-theme="light"] #designInfo { background:#fff;border-color:#e7eaee;color:#131920 }
      #designInfo.show { display:block }
      .di-tag { color:#e58a00;font-weight:700 } .di-id { color:#4680ff } .di-class { color:#2ca87f }
      .di-dim { color:#748892;margin-top:4px;font-size:10px }
      .di-text-preview { margin-top:4px;color:#748892;font-size:10px;max-height:36px;overflow:hidden;font-style:italic }
      .di-section { margin-top:8px;border-top:1px solid #303f50;padding-top:6px }
      .di-section-title { font-size:9px;font-weight:700;text-transform:uppercase;color:#748892;letter-spacing:.5px;margin-bottom:4px }
      .di-css-row { display:flex;gap:4px;padding:1px 0 } .di-css-prop { color:#a78bfa;min-width:90px } .di-css-val { color:#bfbfbf;flex:1 }
      .di-actions { margin-top:8px;display:flex;gap:4px;flex-wrap:wrap }
      .di-act-btn { padding:4px 10px;border-radius:5px;border:1px solid #303f50;background:transparent;color:#4680ff;font-size:10px;font-weight:600;cursor:pointer;transition:background .12s;font-family:'Inter',sans-serif }
      .di-act-btn:hover { background:rgba(70,128,255,.1) }
      .di-act-btn.primary { background:rgba(70,128,255,.15);border-color:#4680ff }
      .di-act-btn.warn { color:#dc2626;border-color:rgba(220,38,38,.3) }
      .di-act-btn.warn:hover { background:rgba(220,38,38,.1) }

      /* Text editor */
      #designTextEditor { position:absolute;z-index:215;display:none;pointer-events:auto }
      #designTextEditor.show { display:block }
      #designTextInput { border:2px solid #4680ff;background:rgba(27,35,45,.95);color:#fff;font-family:'Inter',sans-serif;padding:6px 8px;border-radius:6px;outline:none;resize:both;min-width:120px;min-height:28px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4) }
      .dt-editor-bar { display:flex;gap:4px;margin-top:4px }
      .dt-editor-bar button { padding:3px 10px;border-radius:4px;border:1px solid #303f50;background:#1b232d;color:#bfbfbf;font-size:10px;cursor:pointer;font-family:'Inter',sans-serif }
      .dt-editor-bar button.save { background:#4680ff;color:#fff;border-color:#4680ff }

      /* CSS editor */
      #designCSSEditor { position:absolute;z-index:215;display:none;pointer-events:auto;width:320px;background:#1b232d;border:1px solid #303f50;border-radius:10px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-family:'Inter',sans-serif }
      #designCSSEditor.show { display:block }
      #designCSSEditor h4 { font-size:11px;font-weight:700;color:#fff;margin:0 0 8px }
      .dce-row { display:flex;gap:6px;margin-bottom:4px;align-items:center }
      .dce-label { font-size:10px;color:#748892;width:80px;flex-shrink:0 }
      .dce-input { flex:1;height:26px;border:1px solid #303f50;background:#131920;color:#fff;border-radius:4px;padding:0 6px;font-size:11px;font-family:'Inter',monospace;outline:none }
      .dce-input:focus { border-color:#4680ff }

      /* Changes panel */
      #designChanges {
        position:absolute;top:54px;right:10px;z-index:210;pointer-events:auto;
        width:320px;max-height:400px;
        background:#1b232d;border:1px solid #303f50;border-radius:10px;padding:10px;
        box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:'Inter',sans-serif;font-size:11px;color:#bfbfbf;
        overflow-y:auto;display:none;-webkit-app-region:no-drag;
      }
      [data-theme="light"] #designChanges { background:#fff;border-color:#e7eaee }
      #designChanges.show { display:block }
      .dc-item { padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.03);margin-bottom:4px;border-left:3px solid #4680ff }
      .dc-item.type-text { border-left-color:#e58a00 }
      .dc-item.type-css { border-left-color:#a78bfa }
      .dc-item.type-move { border-left-color:#2ca87f }
      .dc-item.type-hide { border-left-color:#dc2626 }
      .dc-type { font-size:9px;font-weight:700;text-transform:uppercase;color:#748892 }
      .dc-desc { font-size:10px;color:#bfbfbf;margin-top:2px }
      .dc-diff { font-size:9px;margin-top:2px;font-family:monospace }
      .dc-old { color:#dc2626 } .dc-new { color:#2ca87f }

      /* Breadcrumb */
      #designBreadcrumb {
        position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:210;pointer-events:auto;
        display:none;align-items:center;gap:0;
        background:#1b232d;border:1px solid #303f50;border-radius:6px;padding:3px 6px;
        box-shadow:0 4px 12px rgba(0,0,0,.4);font-family:'Inter',monospace;font-size:10px;color:#748892;
        -webkit-app-region:no-drag;max-width:60%;overflow-x:auto;
      }
      #designBreadcrumb.show { display:flex }
      .db-item { padding:2px 5px;cursor:pointer;border-radius:3px;white-space:nowrap;transition:background .1s,color .1s }
      .db-item:hover { background:rgba(70,128,255,.15);color:#4680ff }
      .db-item.active { color:#4680ff;font-weight:700 }
      .db-sep { color:#303f50;padding:0 1px }

      /* Push button */
      #designPushBtn {
        position:absolute;bottom:10px;right:10px;z-index:210;pointer-events:auto;
        display:none;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;
        background:linear-gradient(135deg,#4680ff,#6366f1);border:none;color:#fff;
        font-size:12px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;
        box-shadow:0 4px 16px rgba(70,128,255,.3);transition:transform .12s;-webkit-app-region:no-drag;
      }
      #designPushBtn:hover { transform:translateY(-1px) }
      #designPushBtn.show { display:flex }
      #designPushBtn svg { width:14px;height:14px }
    </style>

    <!-- Toolbar -->
    <div id="designToolbar">
      <span class="dt-label">DESIGN</span>
      <div class="dt-sep"></div>
      <button class="dt-btn active" id="dtInspect" title="Inspect (V)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg></button>
      <button class="dt-btn" id="dtMove" title="Move (M)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg></button>
      <div class="dt-sep"></div>
      <button class="dt-btn" id="dtRect" title="Rectangle (R)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></button>
      <button class="dt-btn" id="dtArrow" title="Arrow (A)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
      <button class="dt-btn" id="dtText" title="Text (T)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg></button>
      <div class="dt-sep"></div>
      <div class="dt-swatch active" style="background:#e58a00" data-color="#e58a00"></div>
      <div class="dt-swatch" style="background:#dc2626" data-color="#dc2626"></div>
      <div class="dt-swatch" style="background:#2ca87f" data-color="#2ca87f"></div>
      <div class="dt-swatch" style="background:#4680ff" data-color="#4680ff"></div>
      <div class="dt-sep"></div>
      <button class="dt-btn" id="dtUndo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg></button>
      <button class="dt-btn" id="dtChanges" title="Visa ändringar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="dt-badge" id="dtChangesBadge">0</span></button>
      <div class="dt-sep"></div>
      <button class="dt-btn" id="dtClose" title="Close (Esc)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>

    <div id="designHighlight"></div>
    <div id="designHighlightLabel"></div>
    <div class="design-handle" id="dhTL" style="cursor:nwse-resize"></div>
    <div class="design-handle" id="dhTR" style="cursor:nesw-resize"></div>
    <div class="design-handle" id="dhBL" style="cursor:nesw-resize"></div>
    <div class="design-handle" id="dhBR" style="cursor:nwse-resize"></div>
    <canvas id="designCanvas"></canvas>
    <div id="designDrawPreview"></div>

    <!-- Text editor -->
    <div id="designTextEditor">
      <textarea id="designTextInput" rows="3" cols="30"></textarea>
      <div class="dt-editor-bar">
        <button class="save" onclick="window.__designSaveText()">Spara</button>
        <button onclick="window.__designCancelText()">Avbryt</button>
      </div>
    </div>

    <!-- CSS editor -->
    <div id="designCSSEditor">
      <h4>Redigera stil</h4>
      <div id="dceFields"></div>
      <div style="display:flex;gap:4px;margin-top:8px">
        <button class="di-act-btn primary" onclick="window.__designApplyCSS()">Applicera</button>
        <button class="di-act-btn" onclick="window.__designCloseCSSEditor()">Stäng</button>
      </div>
    </div>

    <!-- Changes panel -->
    <div id="designChanges">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <h4 style="font-size:11px;font-weight:700;color:#fff;margin:0;flex:1">Ändringar</h4>
        <button class="di-act-btn warn" onclick="window.__designClearChanges()" style="font-size:9px;padding:2px 8px">Rensa alla</button>
      </div>
      <div id="designChangesList"></div>
    </div>

    <div id="designInfo"></div>
    <div id="designBreadcrumb"></div>

    <!-- Push to Claude -->
    <button id="designPushBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
      Push till Claude
    </button>
  `

  // ── Refs ──
  let $highlight, $highlightLabel, $info, $canvas, $ctx, $drawPreview, $pushBtn
  let $textEditor, $textInput, $cssEditor, $cssFields
  let $changesPanel, $changesList, $changesBadge, $breadcrumb
  let $handles = {}
  let annoColor = '#e58a00'

  // ══════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════
  function init() {
    const wvContainer = document.getElementById('wvStack')
    if (!wvContainer) { console.warn('[DesignMode] wvStack not found'); return }
    wvContainer.appendChild(overlay)

    $highlight = document.getElementById('designHighlight')
    $highlightLabel = document.getElementById('designHighlightLabel')
    $info = document.getElementById('designInfo')
    $canvas = document.getElementById('designCanvas')
    $ctx = $canvas.getContext('2d')
    $drawPreview = document.getElementById('designDrawPreview')
    $pushBtn = document.getElementById('designPushBtn')
    $textEditor = document.getElementById('designTextEditor')
    $textInput = document.getElementById('designTextInput')
    $cssEditor = document.getElementById('designCSSEditor')
    $cssFields = document.getElementById('dceFields')
    $changesPanel = document.getElementById('designChanges')
    $changesList = document.getElementById('designChangesList')
    $changesBadge = document.getElementById('dtChangesBadge')
    $breadcrumb = document.getElementById('designBreadcrumb')
    $handles = { tl: document.getElementById('dhTL'), tr: document.getElementById('dhTR'), bl: document.getElementById('dhBL'), br: document.getElementById('dhBR') }

    document.getElementById('dtInspect').onclick = () => setMode('inspect')
    document.getElementById('dtMove').onclick = () => setMode('move')
    document.getElementById('dtRect').onclick = () => { annotateTool = 'rect'; setMode('annotate') }
    document.getElementById('dtArrow').onclick = () => { annotateTool = 'arrow'; setMode('annotate') }
    document.getElementById('dtText').onclick = () => { annotateTool = 'text'; setMode('annotate') }
    document.getElementById('dtUndo').onclick = () => { if (changes.length) undoLastChange(); else undoAnnotation() }
    document.getElementById('dtChanges').onclick = toggleChangesPanel
    document.getElementById('dtClose').onclick = deactivate
    document.getElementById('designPushBtn').onclick = pushToClaude

    overlay.querySelectorAll('.dt-swatch').forEach(sw => {
      sw.onclick = () => { overlay.querySelectorAll('.dt-swatch').forEach(s => s.classList.remove('active')); sw.classList.add('active'); annoColor = sw.dataset.color }
    })

    overlay.addEventListener('mousedown', onMouseDown)
    overlay.addEventListener('mousemove', onMouseMove)
    overlay.addEventListener('mouseup', onMouseUp)
    overlay.addEventListener('dblclick', onDblClick)
    document.addEventListener('keydown', onKeyDown)

    new ResizeObserver(() => resizeCanvas()).observe(wvContainer)
    console.log('[DesignMode] Initialized with change tracking')
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ACTIVATE / DEACTIVATE
  // ══════════════════════════════════════════════════════════════════════
  function activate() {
    if (active) return
    active = true
    overlay.classList.add('active', 'interact')
    setMode('inspect')
    resizeCanvas(); renderAnnotations(); updateChangeBadge()
    console.log('[DesignMode] Activated')
  }

  function deactivate() {
    if (!active) return
    active = false
    overlay.classList.remove('active', 'interact', 'mode-inspect', 'mode-move', 'mode-annotate')
    $highlight.classList.remove('show'); $highlightLabel.classList.remove('show')
    $info.classList.remove('show'); $pushBtn.classList.remove('show')
    $breadcrumb.classList.remove('show'); $textEditor.classList.remove('show')
    $cssEditor.classList.remove('show'); $changesPanel.classList.remove('show')
    hideHandles(); selectedElement = null; elementAncestry = []; isEditing = false
    // Don't clear changes — they persist until user pushes or clears
    console.log('[DesignMode] Deactivated')
  }

  function toggle() { active ? deactivate() : activate() }

  function setMode(m) {
    mode = m
    overlay.classList.remove('mode-inspect', 'mode-move', 'mode-annotate')
    overlay.classList.add('mode-' + m)
    document.getElementById('dtInspect').classList.toggle('active', m === 'inspect')
    document.getElementById('dtMove').classList.toggle('active', m === 'move')
    document.getElementById('dtRect').classList.toggle('active', m === 'annotate' && annotateTool === 'rect')
    document.getElementById('dtArrow').classList.toggle('active', m === 'annotate' && annotateTool === 'arrow')
    document.getElementById('dtText').classList.toggle('active', m === 'annotate' && annotateTool === 'text')
    if (m === 'move' && selectedElement) showHandles(selectedElement.rect); else hideHandles()
  }

  function resizeCanvas() {
    const r = overlay.getBoundingClientRect()
    $canvas.width = r.width * devicePixelRatio; $canvas.height = r.height * devicePixelRatio
    $canvas.style.width = r.width + 'px'; $canvas.style.height = r.height + 'px'
    $ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    renderAnnotations()
  }

  function overlayCoords(e) { const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }

  // ══════════════════════════════════════════════════════════════════════
  //  INSPECT — deep element at point
  // ══════════════════════════════════════════════════════════════════════
  async function inspectAt(x, y) {
    const wv = getWebview()
    if (!wv) return null
    try {
      return await wv.executeJavaScript(`(function(){
        let el = document.elementFromPoint(${x},${y});
        if(!el) return null;
        function fullSelector(node){
          const p=[];let c=node;
          while(c&&c!==document.body&&c!==document.documentElement){
            let s=c.tagName.toLowerCase();
            if(c.id){s='#'+CSS.escape(c.id);p.unshift(s);break}
            if(c.className&&typeof c.className==='string'){const cls=c.className.trim().split(/\\s+/).filter(Boolean);if(cls.length)s+='.'+cls.map(x=>CSS.escape(x)).join('.')}
            const par=c.parentElement;if(par){const sibs=Array.from(par.children);if(sibs.length>1)s+=':nth-child('+(sibs.indexOf(c)+1)+')'}
            p.unshift(s);c=c.parentElement
          }
          return p.join(' > ')
        }
        function info(n){
          const r=n.getBoundingClientRect(),cs=getComputedStyle(n);
          return{
            fullSelector:fullSelector(n),tagName:n.tagName.toLowerCase(),
            id:n.id||'',classes:(typeof n.className==='string'?n.className:'').trim(),
            text:(n.innerText||n.textContent||'').trim().substring(0,200),
            directText:Array.from(n.childNodes).filter(x=>x.nodeType===3).map(x=>x.textContent.trim()).join(' ').substring(0,200),
            html:n.outerHTML.substring(0,800),childCount:n.children.length,
            rect:{x:r.x,y:r.y,w:r.width,h:r.height},
            computedStyles:{color:cs.color,backgroundColor:cs.backgroundColor,fontSize:cs.fontSize,fontWeight:cs.fontWeight,fontFamily:cs.fontFamily,lineHeight:cs.lineHeight,letterSpacing:cs.letterSpacing,textAlign:cs.textAlign,padding:cs.padding,margin:cs.margin,borderRadius:cs.borderRadius,border:cs.border,display:cs.display,position:cs.position,width:cs.width,height:cs.height,gap:cs.gap,flexDirection:cs.flexDirection,opacity:cs.opacity}
          }
        }
        const ancestry=[];let cur=el;
        while(cur&&cur!==document.body&&cur!==document.documentElement){ancestry.push(info(cur));cur=cur.parentElement}
        return{selected:ancestry[0],ancestry:ancestry}
      })()`)
    } catch(e){ console.warn('[DesignMode] inspectAt error:',e); return null }
  }

  async function selectBySelector(fullSel) {
    const wv = getWebview()
    if (!wv) return
    try {
      const info = await wv.executeJavaScript(`(function(){
        const el=document.querySelector(${JSON.stringify(fullSel)});if(!el)return null;
        const r=el.getBoundingClientRect(),cs=getComputedStyle(el);
        function fullSelector(n){const p=[];let c=n;while(c&&c!==document.body&&c!==document.documentElement){let s=c.tagName.toLowerCase();if(c.id){s='#'+CSS.escape(c.id);p.unshift(s);break}if(c.className&&typeof c.className==='string'){const cls=c.className.trim().split(/\\s+/).filter(Boolean);if(cls.length)s+='.'+cls.map(x=>CSS.escape(x)).join('.')}const par=c.parentElement;if(par){const sibs=Array.from(par.children);if(sibs.length>1)s+=':nth-child('+(sibs.indexOf(c)+1)+')'}p.unshift(s);c=c.parentElement}return p.join(' > ')}
        return{fullSelector:fullSelector(el),tagName:el.tagName.toLowerCase(),id:el.id||'',classes:(typeof el.className==='string'?el.className:'').trim(),text:(el.innerText||el.textContent||'').trim().substring(0,200),directText:Array.from(el.childNodes).filter(x=>x.nodeType===3).map(x=>x.textContent.trim()).join(' ').substring(0,200),html:el.outerHTML.substring(0,800),childCount:el.children.length,rect:{x:r.x,y:r.y,w:r.width,h:r.height},computedStyles:{color:cs.color,backgroundColor:cs.backgroundColor,fontSize:cs.fontSize,fontWeight:cs.fontWeight,fontFamily:cs.fontFamily,lineHeight:cs.lineHeight,letterSpacing:cs.letterSpacing,textAlign:cs.textAlign,padding:cs.padding,margin:cs.margin,borderRadius:cs.borderRadius,border:cs.border,display:cs.display,position:cs.position,width:cs.width,height:cs.height,gap:cs.gap,flexDirection:cs.flexDirection,opacity:cs.opacity}}
      })()`)
      if (info) {
        selectedElement = info; selectedElement.selector = info.fullSelector
        showHighlight(info.rect, COLORS.select); showHighlightLabel(info)
        showInfo(info); $pushBtn.classList.add('show')
        // Auto-store selection payload so Claude can read it immediately
        storeSelectionPayload()
      }
    } catch(e){ console.warn('[DesignMode] selectBySelector error:',e) }
  }

  // ── Highlight ──
  function showHighlight(rect, color) {
    $highlight.style.left=rect.x+'px'; $highlight.style.top=rect.y+'px'
    $highlight.style.width=rect.w+'px'; $highlight.style.height=rect.h+'px'
    $highlight.style.borderColor=color||COLORS.select; $highlight.classList.add('show')
  }
  function showHighlightLabel(el) {
    let l=el.tagName; if(el.id)l+='#'+el.id; else if(el.classes)l+='.'+el.classes.split(/\s+/)[0]
    l+='  '+Math.round(el.rect.w)+'×'+Math.round(el.rect.h)
    $highlightLabel.textContent=l; $highlightLabel.style.left=el.rect.x+'px'
    $highlightLabel.style.top=Math.max(0,el.rect.y-18)+'px'; $highlightLabel.classList.add('show')
  }
  function hideHighlight(){ $highlight.classList.remove('show'); $highlightLabel.classList.remove('show') }
  function showHandles(r){
    const s=8;
    $handles.tl.style.left=(r.x-s/2)+'px';$handles.tl.style.top=(r.y-s/2)+'px'
    $handles.tr.style.left=(r.x+r.w-s/2)+'px';$handles.tr.style.top=(r.y-s/2)+'px'
    $handles.bl.style.left=(r.x-s/2)+'px';$handles.bl.style.top=(r.y+r.h-s/2)+'px'
    $handles.br.style.left=(r.x+r.w-s/2)+'px';$handles.br.style.top=(r.y+r.h-s/2)+'px'
  }
  function hideHandles(){ Object.values($handles).forEach(h => h.style.display='none') }

  // ══════════════════════════════════════════════════════════════════════
  //  INFO PANEL
  // ══════════════════════════════════════════════════════════════════════
  function showInfo(el) {
    if (!el) { $info.classList.remove('show'); return }
    const s = el.computedStyles
    let h = `<div><span class="di-tag">&lt;${el.tagName}&gt;</span>`
    if (el.id) h += ` <span class="di-id">#${el.id}</span>`
    if (el.classes) { const c=el.classes.split(/\s+/).slice(0,3).join('.'); h += ` <span class="di-class">.${c}</span>` }
    h += `</div><div class="di-dim">${Math.round(el.rect.w)} × ${Math.round(el.rect.h)}px · ${el.childCount} barn</div>`
    const txt = el.directText || el.text
    if (txt) h += `<div class="di-text-preview">"${txt.substring(0,100)}"</div>`
    h += `<div class="di-section"><div class="di-section-title">Stil</div><div class="di-styles">`
    for (const k of ['color','backgroundColor','fontSize','fontWeight','padding','margin','borderRadius','display','gap']) {
      const v=s[k]; if(v&&v!=='none'&&v!=='normal'&&v!=='auto'&&v!=='0px'&&v!=='rgba(0, 0, 0, 0)')
        h += `<div class="di-css-row"><span class="di-css-prop">${k.replace(/([A-Z])/g,'-$1').toLowerCase()}:</span><span class="di-css-val">${v}</span></div>`
    }
    h += `</div></div><div class="di-actions">`
    h += `<button class="di-act-btn primary" onclick="window.__designEditText()">Ändra text</button>`
    h += `<button class="di-act-btn primary" onclick="window.__designEditCSS()">Ändra stil</button>`
    h += `<button class="di-act-btn" onclick="window.__designCopySelector()">Selector</button>`
    h += `<button class="di-act-btn" onclick="window.__designCopyHTML()">HTML</button>`
    h += `<button class="di-act-btn warn" onclick="window.__designHideElement()">Göm</button>`
    h += `</div>`
    $info.innerHTML = h; $info.classList.add('show')
  }

  function showBreadcrumb(ancestry) {
    if (!ancestry || ancestry.length < 2) { $breadcrumb.classList.remove('show'); return }
    const items = ancestry.slice(0, 5).reverse()
    let h = ''
    items.forEach((el, i) => {
      if (i > 0) h += '<span class="db-sep">›</span>'
      let l = el.tagName; if (el.id) l += '#'+el.id; else if (el.classes) l += '.'+el.classes.split(/\s+/)[0]
      h += `<span class="db-item${i===items.length-1?' active':''}" data-sel="${el.fullSelector}">${l}</span>`
    })
    $breadcrumb.innerHTML = h; $breadcrumb.classList.add('show')
    $breadcrumb.querySelectorAll('.db-item').forEach(item => {
      item.onclick = () => { if (item.dataset.sel) selectBySelector(item.dataset.sel) }
    })
  }

  // ══════════════════════════════════════════════════════════════════════
  //  CHANGES PANEL + BADGE
  // ══════════════════════════════════════════════════════════════════════
  function updateChangeBadge() {
    const n = changes.length
    $changesBadge.textContent = n
    $changesBadge.classList.toggle('show', n > 0)
    $pushBtn.classList.toggle('show', n > 0)
    renderChangesPanel()
  }

  function toggleChangesPanel() {
    $changesPanel.classList.toggle('show')
    renderChangesPanel()
  }

  function renderChangesPanel() {
    if (!$changesList) return
    if (changes.length === 0) {
      $changesList.innerHTML = '<div style="color:#748892;text-align:center;padding:16px">Inga ändringar än. Markera element och redigera text/stil.</div>'
      return
    }
    let h = ''
    for (const c of changes) {
      h += `<div class="dc-item type-${c.type}">`
      h += `<div class="dc-type">${c.type}</div>`
      h += `<div class="dc-desc">${c.description}</div>`
      if (c.type === 'text') {
        h += `<div class="dc-diff"><span class="dc-old">- "${String(c.original).substring(0,60)}"</span></div>`
        h += `<div class="dc-diff"><span class="dc-new">+ "${String(c.modified).substring(0,60)}"</span></div>`
      } else if (c.type === 'css') {
        const mods = c.modified
        for (const [k,v] of Object.entries(mods)) {
          const orig = c.original[k] || '(inget)'
          h += `<div class="dc-diff"><span class="dc-old">  ${k}: ${orig}</span> → <span class="dc-new">${v}</span></div>`
        }
      } else if (c.type === 'move') {
        h += `<div class="dc-diff"><span class="dc-new">transform: ${c.modified}</span></div>`
      }
      h += `</div>`
    }
    $changesList.innerHTML = h
  }

  window.__designClearChanges = () => {
    // Undo all changes (in reverse order)
    while (changes.length) undoLastChange()
    updateChangeBadge()
  }

  // ══════════════════════════════════════════════════════════════════════
  //  TEXT EDITOR (with change tracking)
  // ══════════════════════════════════════════════════════════════════════
  window.__designEditText = () => {
    if (!selectedElement) return
    isEditing = true
    const r = selectedElement.rect
    $textInput.value = selectedElement.directText || selectedElement.text || ''
    $textEditor.style.left = r.x + 'px'; $textEditor.style.top = r.y + 'px'
    $textInput.style.width = Math.max(200, r.w) + 'px'
    $textInput.style.fontSize = selectedElement.computedStyles.fontSize || '14px'
    $textEditor.classList.add('show'); $textInput.focus(); $textInput.select()
  }

  window.__designSaveText = async () => {
    if (!selectedElement) return
    const newText = $textInput.value
    const originalText = selectedElement.directText || selectedElement.text || ''
    if (newText === originalText) { $textEditor.classList.remove('show'); isEditing = false; return }

    const sel = selectedElement.fullSelector || selectedElement.selector
    const wv = getWebview()
    if (wv) {
      await wv.executeJavaScript(`(function(){
        const el=document.querySelector(${JSON.stringify(sel)});if(!el)return;
        if(el.children.length===0) el.textContent=${JSON.stringify(newText)};
        else{ const tn=Array.from(el.childNodes).find(n=>n.nodeType===3&&n.textContent.trim()); if(tn)tn.textContent=${JSON.stringify(newText)}; else el.textContent=${JSON.stringify(newText)}; }
      })()`)
    }
    // Track the change
    recordChange(sel, 'text', `"${originalText.substring(0,40)}" → "${newText.substring(0,40)}"`, originalText, newText)

    $textEditor.classList.remove('show'); isEditing = false
    if (sel) selectBySelector(sel)
  }

  window.__designCancelText = () => { $textEditor.classList.remove('show'); isEditing = false }

  // ══════════════════════════════════════════════════════════════════════
  //  CSS EDITOR (with change tracking)
  // ══════════════════════════════════════════════════════════════════════
  window.__designEditCSS = () => {
    if (!selectedElement) return
    const s = selectedElement.computedStyles
    const fields = [
      { prop:'color', label:'Färg' }, { prop:'backgroundColor', label:'Bakgrund' },
      { prop:'fontSize', label:'Storlek' }, { prop:'fontWeight', label:'Vikt' },
      { prop:'padding', label:'Padding' }, { prop:'margin', label:'Margin' },
      { prop:'borderRadius', label:'Radie' }, { prop:'border', label:'Border' },
      { prop:'gap', label:'Gap' }, { prop:'opacity', label:'Opacitet' },
    ]
    let h = ''
    for (const f of fields) h += `<div class="dce-row"><span class="dce-label">${f.label}</span><input class="dce-input" data-prop="${f.prop}" value="${s[f.prop]||''}"></div>`
    $cssFields.innerHTML = h
    $cssEditor.style.left = '10px'; $cssEditor.style.bottom = '300px'
    $cssEditor.classList.add('show')
  }

  window.__designApplyCSS = async () => {
    if (!selectedElement) return
    const wv = getWebview()
    if (!wv) return
    const sel = selectedElement.fullSelector || selectedElement.selector
    const inputs = $cssFields.querySelectorAll('.dce-input')
    const newVals = {}, origVals = {}
    inputs.forEach(inp => {
      const prop = inp.dataset.prop, val = inp.value.trim()
      const origVal = selectedElement.computedStyles[prop] || ''
      if (val !== origVal) { newVals[prop] = val; origVals[prop] = origVal }
    })
    if (Object.keys(newVals).length === 0) return

    await wv.executeJavaScript(`(function(){
      const el=document.querySelector(${JSON.stringify(sel)});if(!el)return;
      const c=${JSON.stringify(newVals)};for(const[k,v]of Object.entries(c))el.style[k]=v;
    })()`)

    const desc = Object.entries(newVals).map(([k,v]) => `${k}: ${v}`).join(', ')
    recordChange(sel, 'css', desc, origVals, newVals)
    if (sel) selectBySelector(sel)
  }

  window.__designCloseCSSEditor = () => { $cssEditor.classList.remove('show') }

  // ── Copy / Hide ──
  window.__designCopySelector = () => { if (selectedElement) navigator.clipboard.writeText(selectedElement.fullSelector||selectedElement.selector||'') }
  window.__designCopyHTML = () => { if (selectedElement) navigator.clipboard.writeText(selectedElement.html||'') }

  window.__designHideElement = async () => {
    if (!selectedElement) return
    const wv = getWebview(), sel = selectedElement.fullSelector || selectedElement.selector
    if (!wv) return
    const origDisplay = await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(sel)});return el?getComputedStyle(el).display:'block' })()`)
    await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(sel)});if(el)el.style.display='none' })()`)
    recordChange(sel, 'hide', `Gömt element <${selectedElement.tagName}>`, origDisplay, 'none')
    hideHighlight(); $info.classList.remove('show'); selectedElement = null
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MOUSE EVENTS
  // ══════════════════════════════════════════════════════════════════════
  let hoverThrottle = null

  async function onMouseMove(e) {
    if (!active || isEditing) return
    const {x,y} = overlayCoords(e)
    if (mode === 'inspect' || mode === 'move') {
      if (hoverThrottle) return; hoverThrottle = setTimeout(()=>{hoverThrottle=null}, 60)
      if (moveState) {
        const dx=x-moveState.startX, dy=y-moveState.startY
        showHighlight({x:moveState.origRect.x+dx,y:moveState.origRect.y+dy,w:moveState.origRect.w,h:moveState.origRect.h}, COLORS.move)
        return
      }
      const r = await inspectAt(x, y)
      if (r && r.selected && r.selected.rect) { showHighlight(r.selected.rect, COLORS.hover); showHighlightLabel(r.selected) }
    }
    if (mode === 'annotate' && drawStart) {
      if (annotateTool === 'rect') {
        $drawPreview.style.left=Math.min(x,drawStart.x)+'px'; $drawPreview.style.top=Math.min(y,drawStart.y)+'px'
        $drawPreview.style.width=Math.abs(x-drawStart.x)+'px'; $drawPreview.style.height=Math.abs(y-drawStart.y)+'px'
        $drawPreview.style.borderColor=annoColor; $drawPreview.style.background=annoColor+'14'; $drawPreview.classList.add('show')
      } else if (annotateTool === 'arrow') { renderAnnotations(); drawArrow($ctx, drawStart.x, drawStart.y, x, y, annoColor) }
    }
  }

  async function onMouseDown(e) {
    if (!active || isEditing) return
    if (e.target.closest('#designToolbar,#designInfo,#designPushBtn,#designTextEditor,#designCSSEditor,#designBreadcrumb,#designChanges')) return
    const {x,y} = overlayCoords(e)
    if (mode === 'inspect') {
      const r = await inspectAt(x, y)
      if (r && r.selected) {
        selectedElement = r.selected; selectedElement.selector = r.selected.fullSelector
        elementAncestry = r.ancestry || []
        showHighlight(r.selected.rect, COLORS.select); showHighlightLabel(r.selected)
        showInfo(r.selected); showBreadcrumb(r.ancestry)
        $pushBtn.classList.add('show')
      }
    }
    if (mode === 'move' && selectedElement) {
      moveState = { selector: selectedElement.fullSelector||selectedElement.selector, startX:x, startY:y, origRect:{...selectedElement.rect} }
    }
    if (mode === 'annotate') {
      if (annotateTool === 'text') { const t=prompt('Ange text:'); if(t){annotations.push({type:'text',x,y,text:t,color:annoColor});renderAnnotations()} }
      else drawStart = {x,y}
    }
  }

  async function onMouseUp(e) {
    if (!active || isEditing) return
    const {x,y} = overlayCoords(e)
    if (mode === 'move' && moveState) {
      const dx=x-moveState.startX, dy=y-moveState.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        await applyMove(moveState.selector, dx, dy)
        if (selectedElement?.fullSelector) selectBySelector(selectedElement.fullSelector)
      }
      moveState = null
    }
    if (mode === 'annotate' && drawStart) {
      const w=x-drawStart.x, h=y-drawStart.y
      if (Math.abs(w) > 5 || Math.abs(h) > 5) {
        if (annotateTool === 'rect') annotations.push({type:'rect',x:Math.min(x,drawStart.x),y:Math.min(y,drawStart.y),w:Math.abs(w),h:Math.abs(h),color:annoColor})
        else if (annotateTool === 'arrow') annotations.push({type:'arrow',x:drawStart.x,y:drawStart.y,x2:x,y2:y,color:annoColor})
        renderAnnotations()
      }
      drawStart = null; $drawPreview.classList.remove('show')
    }
  }

  async function onDblClick(e) {
    if (!active || isEditing) return
    if (e.target.closest('#designToolbar,#designInfo,#designPushBtn,#designTextEditor,#designCSSEditor,#designBreadcrumb,#designChanges')) return
    if (selectedElement) window.__designEditText()
  }

  // ── Move (transform-based, works with flex/grid) ──
  async function applyMove(selector, dx, dy) {
    const wv = getWebview()
    if (!wv) return
    const origTransform = await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});return el?el.style.transform||'':''})()`).catch(()=>'')
    await wv.executeJavaScript(`(function(){
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;
      const cur=el.style.transform||'';const m=cur.match(/translate\\(([^,]+),\\s*([^)]+)\\)/);
      const cx=m?parseFloat(m[1]):0,cy=m?parseFloat(m[2]):0;
      const nx=cx+${dx},ny=cy+${dy};
      const other=cur.replace(/translate\\([^)]*\\)/,'').trim();
      el.style.transform=('translate('+nx+'px,'+ny+'px) '+other).trim()
    })()`)
    const newTransform = `translate(${dx}px, ${dy}px)`
    recordChange(selector, 'move', `Flyttad ${Math.round(dx)}px, ${Math.round(dy)}px`, origTransform, newTransform)
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ANNOTATIONS
  // ══════════════════════════════════════════════════════════════════════
  function renderAnnotations() {
    if (!$ctx) return
    $ctx.clearRect(0, 0, $canvas.width/devicePixelRatio, $canvas.height/devicePixelRatio)
    for (const a of annotations) {
      if (a.type === 'rect') {
        $ctx.strokeStyle=a.color;$ctx.lineWidth=2;$ctx.setLineDash([6,3]);$ctx.strokeRect(a.x,a.y,a.w,a.h)
        $ctx.fillStyle=a.color+'14';$ctx.fillRect(a.x,a.y,a.w,a.h);$ctx.setLineDash([])
        $ctx.font='10px Inter,sans-serif';$ctx.fillStyle=a.color
        $ctx.fillText(`${Math.round(a.w)}×${Math.round(a.h)}`,a.x+4,a.y-4)
      } else if (a.type === 'arrow') { drawArrow($ctx,a.x,a.y,a.x2,a.y2,a.color) }
      else if (a.type === 'text') {
        $ctx.font='bold 14px Inter,sans-serif';const m=$ctx.measureText(a.text)
        $ctx.fillStyle='#1b232d';$ctx.fillRect(a.x-2,a.y-14,m.width+8,20)
        $ctx.fillStyle=a.color;$ctx.fillText(a.text,a.x+2,a.y)
      }
    }
  }
  function drawArrow(ctx,x1,y1,x2,y2,color) {
    const hl=12,a=Math.atan2(y2-y1,x2-x1);ctx.strokeStyle=color;ctx.lineWidth=2
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke()
    ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(x2,y2)
    ctx.lineTo(x2-hl*Math.cos(a-Math.PI/6),y2-hl*Math.sin(a-Math.PI/6))
    ctx.lineTo(x2-hl*Math.cos(a+Math.PI/6),y2-hl*Math.sin(a+Math.PI/6));ctx.closePath();ctx.fill()
  }
  function undoAnnotation(){ annotations.pop(); renderAnnotations() }

  // ══════════════════════════════════════════════════════════════════════
  //  KEYBOARD
  // ══════════════════════════════════════════════════════════════════════
  function onKeyDown(e) {
    if (isEditing) {
      if (e.key==='Escape'){window.__designCancelText();e.preventDefault()}
      else if (e.key==='Enter'&&(e.ctrlKey||e.metaKey)){window.__designSaveText();e.preventDefault()}
      return
    }
    if (!active) { if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='d'){e.preventDefault();activate()};return }
    const k=e.key.toLowerCase()
    if(k==='escape'){e.preventDefault();deactivate()}
    else if(k==='v'){e.preventDefault();setMode('inspect')}
    else if(k==='m'){e.preventDefault();setMode('move')}
    else if(k==='r'&&!e.ctrlKey){e.preventDefault();annotateTool='rect';setMode('annotate')}
    else if(k==='a'&&!e.ctrlKey){e.preventDefault();annotateTool='arrow';setMode('annotate')}
    else if(k==='t'&&!e.ctrlKey){e.preventDefault();annotateTool='text';setMode('annotate')}
    else if(k==='z'&&(e.ctrlKey||e.metaKey)){e.preventDefault();if(changes.length)undoLastChange();else undoAnnotation()}
    else if(k==='delete'||k==='backspace'){if(selectedElement&&mode!=='annotate'){e.preventDefault();window.__designHideElement()}}
    else if(k==='arrowup'&&selectedElement&&elementAncestry.length>1){
      e.preventDefault();const i=elementAncestry.findIndex(a=>a.fullSelector===selectedElement.fullSelector)
      if(i>=0&&i<elementAncestry.length-1)selectBySelector(elementAncestry[i+1].fullSelector)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  AUTO-STORE — stores selection payload so Claude can read it anytime
  // ══════════════════════════════════════════════════════════════════════
  async function storeSelectionPayload() {
    const wv = getWebview()
    let pageUrl = '', pageTitle = ''
    if (wv) {
      try { pageUrl = wv.getURL(); pageTitle = await wv.executeJavaScript('document.title') } catch(e){}
    }
    const payload = {
      pageUrl, pageTitle,
      selectedElement: selectedElement ? {
        fullSelector: selectedElement.fullSelector, tagName: selectedElement.tagName,
        id: selectedElement.id, classes: selectedElement.classes,
        text: selectedElement.text, directText: selectedElement.directText,
        html: selectedElement.html, childCount: selectedElement.childCount,
        rect: selectedElement.rect, computedStyles: selectedElement.computedStyles,
      } : null,
      changes: changes.map(c => ({ selector:c.selector, type:c.type, description:c.description, original:c.original, modified:c.modified })),
      annotations: annotations.map(a => ({...a})),
    }
    // Get surrounding HTML context
    if (selectedElement && wv) {
      try {
        payload.surroundingHTML = await wv.executeJavaScript(`(function(){
          const el=document.querySelector(${JSON.stringify(selectedElement.fullSelector||selectedElement.selector)});if(!el)return '';
          const p=el.parentElement;return p?p.outerHTML.substring(0,3000):el.outerHTML.substring(0,2000)
        })()`)
      } catch(e){}
    }
    window.__designModePayload = payload
  }

  //  PUSH TO CLAUDE — structured diff for source code mapping
  // ══════════════════════════════════════════════════════════════════════
  async function pushToClaude() {
    // Store/refresh the payload (works even with just a selection, no changes needed)
    await storeSelectionPayload()

    // Also enrich changes with surrounding HTML
    const wv = getWebview()
    if (wv && window.__designModePayload) {
      for (const c of (window.__designModePayload.changes || [])) {
        try {
          c.surroundingHTML = await wv.executeJavaScript(`(function(){
            const el=document.querySelector(${JSON.stringify(c.selector)});if(!el)return '';
            const p=el.parentElement;return p?p.outerHTML.substring(0,3000):el.outerHTML.substring(0,2000)
          })()`)
        } catch(e){}
      }
    }

    const n = changes.length
    console.log('[DesignMode] Push payload:', n, 'changes, element:', selectedElement?.tagName || 'none')

    // Visual feedback
    $pushBtn.style.background = 'linear-gradient(135deg, #2ca87f, #4680ff)'
    $pushBtn.textContent = n > 0 ? '✓ ' + n + ' ändringar redo' : '✓ Markering skickad'
    setTimeout(() => {
      $pushBtn.style.background = ''
      $pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> Push till Claude`
    }, 3000)
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MCP API
  // ══════════════════════════════════════════════════════════════════════
  window.__designMode = {
    activate, deactivate, toggle,
    isActive: () => active,
    getSelection: () => window.__designModePayload || null,
    getChanges: () => changes.map(c => ({ selector:c.selector, type:c.type, description:c.description, original:c.original, modified:c.modified })),
    getAnnotations: () => annotations.map(a => ({...a})),
    setMode,

    // Preview-only: applies CSS to DOM (tracked)
    applyCSS: async (selector, cssProps) => {
      const wv = getWebview()
      if (!wv) return 'No webview'
      // Save originals
      const origVals = {}
      try {
        const orig = await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});if(!el)return {};const cs=getComputedStyle(el);const r={};${Object.keys(cssProps).map(k=>`r[${JSON.stringify(k)}]=cs[${JSON.stringify(k)}]`).join(';')};return r })()`)
        Object.assign(origVals, orig)
      } catch(e){}
      try {
        await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;const c=${JSON.stringify(cssProps)};for(const[k,v]of Object.entries(c))el.style[k]=v })()`)
        recordChange(selector, 'css', Object.entries(cssProps).map(([k,v])=>`${k}:${v}`).join(', '), origVals, cssProps)
        return 'OK — tracked as change #' + changeIdCounter
      } catch(err){ return 'Error: '+err.message }
    },

    applyHTML: async (selector, newHTML) => {
      const wv = getWebview()
      if (!wv) return 'No webview'
      let origHTML = ''
      try { origHTML = await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});return el?el.outerHTML:'' })()`) } catch(e){}
      try {
        await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;el.outerHTML=${JSON.stringify(newHTML)} })()`)
        recordChange(selector, 'html', 'HTML replaced', origHTML, newHTML)
        return 'OK — tracked as change #' + changeIdCounter
      } catch(err){ return 'Error: '+err.message }
    },

    setText: async (selector, text) => {
      const wv = getWebview()
      if (!wv) return 'No webview'
      let origText = ''
      try { origText = await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});if(!el)return '';return el.children.length===0?el.textContent:(Array.from(el.childNodes).find(n=>n.nodeType===3&&n.textContent.trim())||{textContent:''}).textContent })()`) } catch(e){}
      try {
        await wv.executeJavaScript(`(function(){ const el=document.querySelector(${JSON.stringify(selector)});if(!el)return;if(el.children.length===0)el.textContent=${JSON.stringify(text)};else{const tn=Array.from(el.childNodes).find(n=>n.nodeType===3&&n.textContent.trim());if(tn)tn.textContent=${JSON.stringify(text)};else el.textContent=${JSON.stringify(text)}} })()`)
        recordChange(selector, 'text', `"${origText.substring(0,40)}" → "${text.substring(0,40)}"`, origText, text)
        return 'OK — tracked as change #' + changeIdCounter
      } catch(err){ return 'Error: '+err.message }
    },

    getScreenshot: async () => {
      const wv = getWebview(); if (!wv) return null
      try { const img = await wv.capturePage(); return img.toDataURL() } catch(e){ return null }
    },
  }

  window.__designGetWebview = () => window.wv || document.getElementById('wv')

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else setTimeout(init, 100)

})()
