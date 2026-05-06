'use strict'

// ──────────────────────────────────────────────────────────
//  TabHandle — drop-in replacement for <webview> in the renderer
//
//  Backed by a real top-level WebContentsView in the main
//  process (see ../main/tab-manager.js). The class exposes the
//  exact public surface our renderer code uses on <webview>
//  elements:
//
//    methods:  loadURL, reload, reloadIgnoringCache, stop,
//              goBack, goForward, getURL, getTitle, isLoading,
//              canGoBack, canGoForward, executeJavaScript,
//              capturePage, findInPage, stopFindInPage,
//              setZoomFactor, getZoomFactor, openDevTools,
//              closeDevTools, focus, print, setAudioMuted,
//              setUserAgent, send (mirror of <webview>.send),
//              addEventListener, removeEventListener, remove
//
//    props:    src         — read/write (write loads the URL)
//              tabId       — the main-process WebContents id
//              el          — the placeholder <div> we own in the DOM
//
//  Layout: each TabHandle owns a placeholder <div> that the
//  renderer appends/positions exactly like the old <webview>.
//  A ResizeObserver watches that div and forwards bounds to
//  main; a MutationObserver on its style attribute catches
//  display:none/'' transitions and toggles visibility.
// ──────────────────────────────────────────────────────────

;(function () {
  if (typeof window === 'undefined') return
  if (window.TabHandle) return

  const seoz = window.seoz
  if (!seoz || !seoz.tab) {
    console.warn('[TabHandle] window.seoz.tab missing — preload not loaded yet?')
  }

  // We get one global event firehose from main and demux by tabId.
  // Each TabHandle registers itself in this map; multiple instances
  // wouldn't try to install the listener again.
  const _registry = new Map() // tabId -> TabHandle
  let _eventListenerInstalled = false

  function _installGlobalEventListener() {
    if (_eventListenerInstalled || !seoz?.tab?.onEvent) return
    _eventListenerInstalled = true
    seoz.tab.onEvent(({ tabId, event, payload }) => {
      const h = _registry.get(tabId)
      if (!h) return
      if (event === 'destroyed') {
        try { h._fire('destroyed', payload) } catch (_) {}
        _registry.delete(tabId)
        return
      }
      try { h._fire(event, payload) } catch (_) {}
    })
  }

  // Compute the bounds (in window-relative pixels) for a DOM element.
  function _boundsOf(el) {
    if (!el || !el.getBoundingClientRect) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  // Coalesce setBounds calls per frame — style/resize bursts are
  // common when chrome UI re-renders.
  class _BoundsScheduler {
    constructor() { this._pending = new Map() /* tabId -> { handle, bounds, visible } */; this._raf = 0 }
    schedule(handle) {
      this._pending.set(handle.tabId, handle)
      if (this._raf) return
      this._raf = requestAnimationFrame(() => {
        this._raf = 0
        const items = Array.from(this._pending.values())
        this._pending.clear()
        for (const h of items) h._flushBounds()
      })
    }
  }
  const _scheduler = new _BoundsScheduler()

  class TabHandle {
    /**
     * @param {object} [opts]
     * @param {string} [opts.url='about:blank']  initial URL
     * @param {string} [opts.userAgent]          set after creation if provided
     * @param {string} [opts.partition]          custom session partition
     * @param {boolean}[opts.backgroundThrottling=true]
     */
    constructor(opts = {}) {
      this._listeners = new Map() // event -> Set<fn>
      this._destroyed = false
      this._visible = false
      this._lastBounds = null
      this._url = opts.url || 'about:blank'
      this._title = ''

      // Placeholder DOM element. The renderer sizes / displays this;
      // we mirror its layout rect into the WebContentsView in main.
      const el = document.createElement('div')
      el.className = 'tab-handle'
      el.dataset.tabHandle = '1'
      // Default to display:none so we don't paint a 0-size view at
      // creation time — caller sets style.cssText to position + show.
      el.style.cssText = 'position:absolute;inset:0;display:none;background:transparent;pointer-events:auto'
      this.el = el

      // Watch for resize / style mutations.
      try {
        this._resizeObs = new ResizeObserver(() => _scheduler.schedule(this))
        this._resizeObs.observe(el)
      } catch (_) { this._resizeObs = null }
      try {
        this._mutObs = new MutationObserver(() => _scheduler.schedule(this))
        this._mutObs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] })
      } catch (_) { this._mutObs = null }

      // Window resize repositions all tabs.
      this._onWinResize = () => _scheduler.schedule(this)
      window.addEventListener('resize', this._onWinResize, { passive: true })

      // Async-create the underlying WebContentsView. All API methods
      // queue while _readyPromise is unresolved, then drain.
      this._queue = []
      this.tabId = -1
      this._readyPromise = (async () => {
        if (!seoz?.tab?.create) return
        try {
          const id = await seoz.tab.create({
            url: this._url,
            partition: opts.partition,
            backgroundThrottling: opts.backgroundThrottling !== false,
          })
          this.tabId = id
          _registry.set(id, this)
          _installGlobalEventListener()
          if (opts.userAgent) {
            try { seoz.tab.setUserAgent(id, opts.userAgent) } catch (_) {}
          }
          // Push initial bounds so the view appears in the right place.
          _scheduler.schedule(this)
          // Drain queued calls (anything called before tabId arrived).
          const q = this._queue; this._queue = null
          for (const job of q) { try { job() } catch (_) {} }
        } catch (err) {
          console.error('[TabHandle] create failed:', err)
        }
      })()
    }

    // ── Internal helpers ───────────────────────────────

    _ready(fn) {
      if (this._destroyed) return
      if (this.tabId >= 0) { fn(); return }
      if (this._queue) this._queue.push(fn)
    }

    _flushBounds() {
      if (this._destroyed || this.tabId < 0) return
      const b = _boundsOf(this.el)
      if (!b) return
      // Determine visibility from computed style (handles display:none + ancestors).
      let vis = false
      try {
        const cs = window.getComputedStyle(this.el)
        vis = cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0
      } catch (_) { vis = b.width > 0 && b.height > 0 }
      // Skip if nothing changed.
      const last = this._lastBounds
      if (last && vis === this._visible &&
          last.x === b.x && last.y === b.y &&
          last.width === b.width && last.height === b.height) return
      this._lastBounds = b
      this._visible = vis
      try { seoz.tab.setBounds(this.tabId, b, vis) } catch (_) {}
    }

    _fire(eventName, payload) {
      // Mirror <webview> event shape. Listeners for did-navigate etc.
      // expect properties on the event object directly (e.g. e.url),
      // so we splat the payload onto a plain object.
      const evt = Object.assign({ type: eventName, defaultPrevented: false }, payload || {})
      const set = this._listeners.get(eventName)
      if (set) for (const fn of Array.from(set)) {
        try { fn(evt) } catch (err) { console.error('[TabHandle] listener error for', eventName, err) }
      }

      // Track URL / title locally so getURL()/.src/getTitle() can
      // return synchronously without an IPC round-trip.
      if (eventName === 'did-navigate' || eventName === 'did-navigate-in-page') {
        if (payload?.url) this._url = payload.url
      } else if (eventName === 'page-title-updated') {
        if (payload?.title) this._title = payload.title
      }
    }

    // ── Public API — <webview>-shaped ──────────────────

    addEventListener(name, fn) {
      let set = this._listeners.get(name)
      if (!set) { set = new Set(); this._listeners.set(name, set) }
      set.add(fn)
    }
    removeEventListener(name, fn) {
      const set = this._listeners.get(name)
      if (set) set.delete(fn)
    }

    // <webview>-style sync getters. We track URL/title from events.
    // canGoBack/canGoForward have to be sync to match old call sites,
    // so we maintain a cached value updated on did-navigate; callers
    // that want a fresh value can `await tab.canGoBackAsync()`.
    getURL() { return this._url }
    get src() { return this._url }
    set src(url) { this.loadURL(url) }
    getTitle() { return this._title }

    canGoBack() { return !!this._canGoBack }
    canGoForward() { return !!this._canGoForward }
    canGoBackAsync() {
      return new Promise((res) => this._ready(async () => {
        try { res(await seoz.tab.canGoBack(this.tabId)) } catch { res(false) }
      }))
    }
    canGoForwardAsync() {
      return new Promise((res) => this._ready(async () => {
        try { res(await seoz.tab.canGoForward(this.tabId)) } catch { res(false) }
      }))
    }

    isLoading() { return !!this._isLoading }

    loadURL(url, opts) {
      this._url = url
      return new Promise((res, rej) => this._ready(async () => {
        try { res(await seoz.tab.loadURL(this.tabId, url, opts || {})) } catch (e) { rej(e) }
      }))
    }
    reload()              { this._ready(() => seoz.tab.reload(this.tabId)) }
    reloadIgnoringCache() { this._ready(() => seoz.tab.reloadIgnoringCache(this.tabId)) }
    stop()                { this._ready(() => seoz.tab.stop(this.tabId)) }
    goBack()              { this._ready(() => seoz.tab.goBack(this.tabId)) }
    goForward()           { this._ready(() => seoz.tab.goForward(this.tabId)) }

    executeJavaScript(code, userGesture) {
      return new Promise((res, rej) => this._ready(async () => {
        try { res(await seoz.tab.executeJavaScript(this.tabId, code, !!userGesture)) } catch (e) { rej(e) }
      }))
    }

    /**
     * Returns a NativeImage-like shim. Real <webview>.capturePage()
     * returns a NativeImage; consumers in our codebase only call
     * .toDataURL() / .toPNG() on it. We return a plain object whose
     * methods produce the same outputs, sourced from the dataURL we
     * already get from main.
     */
    async capturePage(rect) {
      const dataURL = await new Promise((res) => this._ready(async () => {
        try { res(await seoz.tab.capturePage(this.tabId, rect || null)) } catch { res(null) }
      }))
      if (!dataURL) return null
      const _base64 = (dataURL.split(',')[1]) || ''
      // Pre-decode into a Uint8Array so callers that do `.length`,
      // iteration, etc. behave like Electron's native Buffer-from-PNG.
      let _bytes
      try {
        const bin = atob(_base64)
        _bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) _bytes[i] = bin.charCodeAt(i)
      } catch { _bytes = new Uint8Array(0) }
      // toPNG must mimic Electron's NativeImage.toPNG() return: a Buffer.
      // Real callers pass it to fs.write etc. (Buffer subclasses Uint8Array
      // so iteration + length work) AND to .toString('base64') for IPC
      // serialisation. We approximate Buffer by attaching a custom
      // toString to a Uint8Array clone so .toString('base64') yields the
      // proper base64 string instead of ','-joined byte values.
      function _bufferLike() {
        const out = new Uint8Array(_bytes)
        Object.defineProperty(out, 'toString', {
          value: function (encoding) {
            if (encoding === 'base64') return _base64
            if (encoding === 'binary' || encoding === 'latin1') {
              return atob(_base64)
            }
            // Fallback to default Uint8Array.prototype.toString().
            return Uint8Array.prototype.toString.call(this)
          },
          writable: true, configurable: true,
        })
        return out
      }
      return {
        toDataURL: () => dataURL,
        toPNG: _bufferLike,
        toJPEG: _bufferLike, // best-effort — most callers use toPNG, JPEG is rare
        getSize: () => ({ width: 0, height: 0 }), // unused in our codebase
        isEmpty: () => !dataURL,
      }
    }

    findInPage(text, opts) {
      return new Promise((res) => this._ready(async () => {
        try { res(await seoz.tab.findInPage(this.tabId, text, opts || {})) } catch { res(0) }
      }))
    }
    stopFindInPage(action) { this._ready(() => seoz.tab.stopFindInPage(this.tabId, action || 'clearSelection')) }

    setZoomFactor(f) { this._ready(() => seoz.tab.setZoomFactor(this.tabId, Number(f) || 1)) }
    getZoomFactor() {
      return new Promise((res) => this._ready(async () => {
        try { res(await seoz.tab.getZoomFactor(this.tabId)) } catch { res(1) }
      }))
    }

    openDevTools()  { this._ready(() => seoz.tab.openDevTools(this.tabId)) }
    closeDevTools() { this._ready(() => seoz.tab.closeDevTools(this.tabId)) }

    focus()              { this._ready(() => seoz.tab.focus(this.tabId)) }
    print()              { this._ready(() => seoz.tab.print(this.tabId)) }
    setAudioMuted(muted) { this._ready(() => seoz.tab.setAudioMuted(this.tabId, muted)) }
    setUserAgent(ua)     { this._ready(() => seoz.tab.setUserAgent(this.tabId, ua)) }

    /**
     * Mirror of <webview>.send(channel, ...args). Forwards into the
     * WebContentsView preload as an IPC message.
     */
    send(channel, ...args) {
      this._ready(() => seoz.tab.sendToPreload(this.tabId, channel, args))
    }

    /**
     * Detach from DOM + destroy main-side WebContentsView. After this
     * the handle is unusable; subsequent method calls are no-ops.
     */
    remove() {
      if (this._destroyed) return
      this._destroyed = true
      try { this._resizeObs?.disconnect() } catch (_) {}
      try { this._mutObs?.disconnect() } catch (_) {}
      try { window.removeEventListener('resize', this._onWinResize) } catch (_) {}
      try { this.el.remove() } catch (_) {}
      if (this.tabId >= 0) {
        _registry.delete(this.tabId)
        try { seoz.tab.destroy(this.tabId) } catch (_) {}
      }
    }

    /**
     * Compatibility shim: <webview> elements are real DOM nodes that
     * support setAttribute('style', ...). Our placeholder div does
     * too, but some call sites set `wv.style.cssText` and expect the
     * view to follow. The MutationObserver above takes care of that.
     * This method is here so old `el.setAttribute('useragent', ...)`
     * still routes to the main process.
     */
    setAttribute(name, value) {
      if (name === 'useragent') { this.setUserAgent(value); return }
      if (name === 'allowpopups') return // no-op — popups handled via setWindowOpenHandler
      if (name === 'preload') return     // no-op — preload is set in main when tab is created
      if (name === 'src') { this.loadURL(value); return }
      // Fallthrough: forward unknown attrs to the placeholder div in
      // case the caller expects DOM-style attribute storage.
      try { this.el.setAttribute(name, value) } catch (_) {}
    }
    getAttribute(name) {
      if (name === 'src') return this._url
      try { return this.el.getAttribute(name) } catch (_) { return null }
    }

    /**
     * Sync the canGoBack/canGoForward/isLoading flags on tab events.
     * Called from inside _fire above-but kept separate so we can
     * extend without recursion.
     */
  }

  // Track navigation state by hooking into _fire indirectly: install
  // a listener on every TabHandle's per-event firehose by overriding
  // _fire on the prototype. Cleaner than scattering set/clear all
  // over the place.
  const _origFire = TabHandle.prototype._fire
  TabHandle.prototype._fire = function (eventName, payload) {
    if (eventName === 'did-start-loading') this._isLoading = true
    else if (eventName === 'did-stop-loading' || eventName === 'did-fail-load') this._isLoading = false
    if (eventName === 'did-navigate' || eventName === 'did-navigate-in-page') {
      // Refresh nav-history flags — async, but we want sync getters
      // to return up-to-date values for the next paint.
      if (this.tabId >= 0 && seoz?.tab) {
        seoz.tab.canGoBack(this.tabId).then(v => { this._canGoBack = !!v }).catch(() => {})
        seoz.tab.canGoForward(this.tabId).then(v => { this._canGoForward = !!v }).catch(() => {})
      }
    }
    _origFire.call(this, eventName, payload)
  }

  window.TabHandle = TabHandle
})()
