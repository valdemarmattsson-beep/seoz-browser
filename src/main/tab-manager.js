'use strict'

// ──────────────────────────────────────────────────────────
//  TabManager — owns one WebContentsView per tab
//
//  Why this exists:
//  v1.10.53 used <webview> tags inside the renderer. Google
//  Auth detected the OOPIF "guest contents" architecture and
//  blocked sign-in. WebContentsView is a real top-level
//  Chromium WebContents — indistinguishable from a Chrome
//  tab from the page's JS context.
//
//  The renderer talks to this via `tab:*` IPC. A TabHandle
//  class in the renderer wraps each tab and proxies the old
//  <webview> API (loadURL/reload/addEventListener/etc) so we
//  don't have to rewrite hundreds of call sites.
// ──────────────────────────────────────────────────────────

const path = require('path')
const fs = require('fs')
const { WebContentsView, ipcMain, session: electronSession, app } = require('electron')

// Diagnostic log file — appended to from _diag() inside TabManager.
// Lives in userData so the user can open it without admin rights.
//   %APPDATA%\seoz-browser\tab-shim.log on Windows
//   ~/Library/Application Support/seoz-browser/tab-shim.log on macOS
let _shimLogPath = null
function _writeShimLog(line) {
  try {
    if (!_shimLogPath) {
      _shimLogPath = path.join(app.getPath('userData'), 'tab-shim.log')
    }
    fs.appendFileSync(_shimLogPath, '[' + new Date().toISOString() + '] ' + line + '\n')
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
//  Chrome shim — runs on every main-frame navigation in every
//  tab. Built once per process from process.versions.chrome so
//  the patches stay in lockstep with the real Chromium version.
//
//  v1.10.57 tried injecting from the preload via webFrame.
//  executeJavaScript, but preload runs only once per WebContents
//  (at initial about:blank load) and the patches were therefore
//  never applied to the real navigated page. v1.10.58 moves the
//  inject back to main on did-start-navigation.
// ────────────────────────────────────────────────────────────
// Pull the real Chromium version from process.versions.chrome so the
// patched navigator.userAgentData stays in lockstep with whatever
// Chromium Electron actually shipped. Hardcoding values worked while
// Electron 41 was current but would silently desynchronise on the
// next Electron upgrade — bot-detection cares more about consistency
// (UA string ↔ Sec-CH-UA ↔ navigator.userAgentData) than the absolute
// numbers, so a stale hardcode is exactly the kind of thing that
// breaks Google Auth without leaving an obvious clue.
const CHROMIUM_VERSION = process.versions.chrome || '146.0.0.0'
const CHROMIUM_MAJOR   = String((CHROMIUM_VERSION.split('.')[0]) || '146')

// Patches that MUST run in the page's main world (where the page's
// own JS reads navigator.* / window.PublicKeyCredential). v1.10.64's
// diagnostic confirmed that webContents.executeJavaScript runs in an
// isolated world: DOM writes (the red bar) are visible to the user
// but property mutations are scoped to the isolated world's globals
// and Google's bot-detection reads the unpatched main world.
//
// Chrome-extension stealth pattern: from the isolated world, create
// a <script> element with our code as textContent and append it to
// the DOM. Script tags ALWAYS execute in the page's main world per
// HTML spec, regardless of which world created them. The element is
// removed immediately after attachment so it leaves no DOM trace.
const _MAIN_WORLD_PATCHES = `
(function () {
  try {
    if (window.__seozMW) return;
    window.__seozMW = true;

    // ── 1) navigator.userAgentData ─────────────────────────────
    try {
      var __SEOZ_BRANDS = [
        { brand: 'Chromium',         version: '${CHROMIUM_MAJOR}' },
        { brand: 'Google Chrome',    version: '${CHROMIUM_MAJOR}' },
        { brand: 'Not.A/Brand',      version: '24'                }
      ];
      var __SEOZ_FULL_VERSION = '${CHROMIUM_VERSION}';
      var __SEOZ_PLATFORM = 'Windows';
      var __SEOZ_uaData = {
        brands:   __SEOZ_BRANDS.slice(0),
        mobile:   false,
        platform: __SEOZ_PLATFORM,
        toJSON: function () {
          return { brands: __SEOZ_BRANDS.slice(0), mobile: false, platform: __SEOZ_PLATFORM };
        },
        getHighEntropyValues: function (hints) {
          var out = { brands: __SEOZ_BRANDS.slice(0), mobile: false, platform: __SEOZ_PLATFORM };
          var want = Array.isArray(hints) ? hints : [];
          if (want.indexOf('platformVersion') >= 0) out.platformVersion = '15.0.0';
          if (want.indexOf('architecture')    >= 0) out.architecture    = 'x86';
          if (want.indexOf('bitness')         >= 0) out.bitness         = '64';
          if (want.indexOf('model')           >= 0) out.model           = '';
          if (want.indexOf('uaFullVersion')   >= 0) out.uaFullVersion   = __SEOZ_FULL_VERSION;
          if (want.indexOf('wow64')           >= 0) out.wow64           = false;
          if (want.indexOf('fullVersionList') >= 0) out.fullVersionList = [
            { brand: 'Chromium',      version: __SEOZ_FULL_VERSION },
            { brand: 'Google Chrome', version: __SEOZ_FULL_VERSION },
            { brand: 'Not.A/Brand',   version: '24.0.0.0' }
          ];
          return Promise.resolve(out);
        }
      };
      // Aggressive override: try delete-then-define on prototype, then own-property assign.
      try { delete Navigator.prototype.userAgentData; } catch (_) {}
      try {
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          get: function () { return __SEOZ_uaData; },
          configurable: true
        });
      } catch (_) {}
      try {
        Object.defineProperty(navigator, 'userAgentData', {
          value: __SEOZ_uaData, writable: false, configurable: true, enumerable: true
        });
      } catch (_) {}
    } catch (_) {}

    // ── 2) WebAuthn / passkey block ────────────────────────────
    // Keep PublicKeyCredential defined (real Chrome on Win10/11 always
    // has it — removing the global is itself a tell). Shim its static
    // methods so feature-detection reports "no platform authenticator"
    // and "no conditional UI", which is what discourages Google
    // Sign-in / etc. from attempting a passkey assertion at all.
    try {
      if (typeof window.PublicKeyCredential !== 'undefined') {
        var _falseAsync = function () { return Promise.resolve(false); };
        try { delete PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable; } catch (_) {}
        try { Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { value: _falseAsync, writable: true, configurable: true }); } catch (_) {}
        try { delete PublicKeyCredential.isConditionalMediationAvailable; } catch (_) {}
        try { Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { value: _falseAsync, writable: true, configurable: true }); } catch (_) {}
      }
    } catch (_) {}
    try {
      if (navigator.credentials) {
        var _origGet    = navigator.credentials.get    && navigator.credentials.get.bind(navigator.credentials);
        var _origCreate = navigator.credentials.create && navigator.credentials.create.bind(navigator.credentials);
        var _denied = function () {
          return Promise.reject(new DOMException(
            'The operation either timed out or was not allowed.',
            'NotAllowedError'
          ));
        };
        if (_origGet) {
          navigator.credentials.get = function (opts) {
            // v1.10.132: block ANY publicKey OR conditional-mediation
            // request — both can pop the Windows Hello / passkey OS
            // dialog before the page's own JS sees a result. Previous
            // versions only blocked publicKey and the conditional
            // (autofill-driven) flow leaked through.
            if (opts && (opts.publicKey || opts.mediation === 'conditional')) {
              return _denied();
            }
            return _origGet(opts);
          };
        }
        if (_origCreate) {
          navigator.credentials.create = function (opts) {
            if (opts && opts.publicKey) return _denied();
            return _origCreate(opts);
          };
        }
      }
    } catch (_) {}

    // ── 3) chrome.runtime / chrome.app ────────────────────────
    try {
      if (!window.chrome) window.chrome = {};
      var noop = function () {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs:   { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          connect: function () { return { onMessage: { addListener: noop, removeListener: noop }, onDisconnect: { addListener: noop, removeListener: noop }, postMessage: noop, disconnect: noop }; },
          sendMessage: noop
        };
      }
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function () { return null; },
          getIsInstalled: function () { return false; },
          installState: function (cb) { try { cb && cb('disabled'); } catch (_) {} },
          runningState: function () { return 'cannot_run'; }
        };
      }
      if (!window.chrome.csi) {
        window.chrome.csi = function () {
          return { startE: Date.now(), onloadT: Date.now(), pageT: Math.round(performance.now()), tran: 15 };
        };
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = function () {
          var t = performance.timing;
          return {
            requestTime: t.requestStart / 1000,
            startLoadTime: t.requestStart / 1000,
            commitLoadTime: t.responseStart / 1000,
            finishDocumentLoadTime: t.domContentLoadedEventEnd / 1000,
            finishLoadTime: t.loadEventEnd / 1000,
            firstPaintTime: t.responseEnd / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2'
          };
        };
      }
    } catch (_) {}

    // ── 4) navigator.webdriver ────────────────────────────────
    // Real Chrome reports undefined unless launched with --enable-automation.
    // Bot-detectors (Google, Cloudflare, hCaptcha) read this FIRST.
    // Restored from v1.10.53's stealth-code.js — was dropped by accident
    // in v1.10.96's WebContentsView refactor.
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: function () { return undefined; },
        configurable: true
      });
    } catch (_) {}

    // ── 5) navigator.plugins ─────────────────────────────────
    // Real Chrome on Windows ships 5 PDF-related plugins. Empty plugins
    // is a strong embedded-browser tell.
    try {
      var _make = function (name, filename, description) {
        var p = Object.create(Plugin.prototype || {});
        Object.defineProperties(p, {
          name:        { value: name },
          filename:    { value: filename },
          description: { value: description },
          length:      { value: 1 }
        });
        return p;
      };
      var _list = [
        _make('PDF Viewer',                'internal-pdf-viewer', 'Portable Document Format'),
        _make('Chrome PDF Viewer',         'internal-pdf-viewer', 'Portable Document Format'),
        _make('Chromium PDF Viewer',       'internal-pdf-viewer', 'Portable Document Format'),
        _make('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        _make('WebKit built-in PDF',       'internal-pdf-viewer', 'Portable Document Format')
      ];
      var _arr = Object.create(PluginArray.prototype || Array.prototype);
      _list.forEach(function (p, i) { _arr[i] = p; _arr[p.name] = p; });
      Object.defineProperty(_arr, 'length', { value: _list.length });
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: function () { return _arr; },
        configurable: true
      });
    } catch (_) {}

    // ── 6) navigator.languages ───────────────────────────────
    // Default Electron sometimes reports just ['en-US']. Real Chrome
    // reflects OS locale + fallbacks.
    try {
      if (!navigator.languages || navigator.languages.length === 0 ||
          (navigator.languages.length === 1 && navigator.languages[0] === 'en-US')) {
        Object.defineProperty(Navigator.prototype, 'languages', {
          get: function () { return ['sv-SE', 'sv', 'en-US', 'en']; },
          configurable: true
        });
      }
    } catch (_) {}

    // ── 7) Permissions.query notification fallback ───────────
    try {
      if (window.navigator.permissions && window.navigator.permissions.query) {
        var _origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
        window.navigator.permissions.query = function (p) {
          if (p && p.name === 'notifications') {
            return Promise.resolve({
              state: typeof Notification !== 'undefined' ? Notification.permission : 'default',
              onchange: null,
              addEventListener: function () {},
              removeEventListener: function () {},
              dispatchEvent: function () { return true; }
            });
          }
          return _origQuery(p);
        };
      }
    } catch (_) {}

    // ── 8) WebGL UNMASKED_VENDOR / UNMASKED_RENDERER ─────────
    // Default Electron reports "Google SwiftShader" (software rasterizer)
    // which is a 100% headless tell. Spoof to a common Intel GPU.
    try {
      var _patchGL = function (proto) {
        if (!proto) return;
        var _orig = proto.getParameter;
        proto.getParameter = function (parameter) {
          if (parameter === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';   // UNMASKED_RENDERER_WEBGL
          return _orig.call(this, parameter);
        };
      };
      _patchGL(window.WebGLRenderingContext  && window.WebGLRenderingContext.prototype);
      _patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    } catch (_) {}

    // ── 9) Notification.permission ───────────────────────────
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        Object.defineProperty(Notification, 'permission', {
          get: function () { return 'default'; },
          configurable: true
        });
      }
    } catch (_) {}

    // ── 10) navigator.deviceMemory ───────────────────────────
    try {
      if (!('deviceMemory' in navigator)) {
        Object.defineProperty(Navigator.prototype, 'deviceMemory', {
          get: function () { return 8; },
          configurable: true
        });
      }
    } catch (_) {}

    // ── 11) MediaSource codec support ───────────────────────
    try {
      if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
        var _realIsTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
        MediaSource.isTypeSupported = function (type) {
          if (typeof type === 'string') {
            if (/video\\/mp4.*avc1/i.test(type))    return true;
            if (/audio\\/mp4.*mp4a/i.test(type))    return true;
            if (/video\\/webm.*vp[89]/i.test(type)) return true;
            if (/audio\\/webm.*opus/i.test(type))   return true;
          }
          return _realIsTypeSupported(type);
        };
      }
    } catch (_) {}

    // ── 12) window.outerWidth / outerHeight ──────────────────
    // Headless Chrome reports 0; real Chrome reports the OS window size.
    try {
      if (window.outerWidth === 0 || window.outerHeight === 0) {
        Object.defineProperty(window, 'outerWidth',  { get: function () { return window.innerWidth; },          configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: function () { return window.innerHeight + 80; },    configurable: true });
      }
    } catch (_) {}

    // ── 13) Function.prototype.toString — patched fns must
    //       still report '[native code]' so introspection-based
    //       bot-detection doesn't see our wrapped functions.
    try {
      var _origToString = Function.prototype.toString;
      var _proxiedFns = new WeakSet();
      if (window.chrome) {
        if (window.chrome.loadTimes) _proxiedFns.add(window.chrome.loadTimes);
        if (window.chrome.csi)       _proxiedFns.add(window.chrome.csi);
      }
      if (window.navigator && window.navigator.permissions && window.navigator.permissions.query) _proxiedFns.add(window.navigator.permissions.query);
      if (navigator.credentials && navigator.credentials.get)    _proxiedFns.add(navigator.credentials.get);
      if (navigator.credentials && navigator.credentials.create) _proxiedFns.add(navigator.credentials.create);
      Function.prototype.toString = new Proxy(_origToString, {
        apply: function (target, thisArg, args) {
          if (_proxiedFns.has(thisArg)) {
            return 'function ' + (thisArg.name || '') + '() { [native code] }';
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    } catch (_) {}

    // Visible marker so the user's diagnostic in the page can confirm
    // that the main-world patches actually ran.
    try { document.documentElement.setAttribute('data-seoz-mw', 'v1.10.65'); } catch (_) {}
  } catch (_) {}
})();
`

// v1.10.132: main-process CDP/executeJavaScript injection is now a
// no-op. Strawberry-parity stealth lives entirely in webview-preload.js
// (webFrame.executeJavaScript from preload reaches main world reliably
// with contextIsolation:true). The previous main-process layer was
// (a) running in isolated world, so its patches were invisible to the
// page anyway, and (b) when it DID reach main world via the <script>-
// tag indirection, it overrode native Sec-CH-UA / userAgentData values
// with hand-built strings that introduced inconsistencies Google's
// bot-detector flags. Cleaner to rely on the preload alone.
// v1.10.132: applyChromeShim is now a no-op. The CDP debugger attach
// (wc.debugger.attach + Page.addScriptToEvaluateOnNewDocument) was a
// detection vector — Google's bot-detector flags webContents that
// have an active CDP session because real Chrome doesn't have CDP
// attached unless DevTools is open.
//
// Confirmed via fingerprint comparison vs Strawberry browser
// (which works on Google sign-in): our navigator/window-side state
// is byte-equivalent except for normal Chromium-version-specific
// GREASE differences. The only remaining tell that explains why
// Google rejects us but accepts Strawberry is the CDP attach.
//
// Stealth (WebAuthn block, etc.) lives entirely in webview-preload.js
// via webFrame.executeJavaScript, which is what Strawberry does too.
//
// Function kept as a no-op so callers (TabManager.createTab and
// main.js's did-create-window hook) don't need to be touched. Returns
// a resolved Promise so any awaiters proceed immediately.
function applyChromeShim(/* wc, diag */) {
  return Promise.resolve()
}

// Events we forward main → renderer. Each fires on the `tab:event`
// channel as { tabId, event, args }. The renderer's TabHandle
// re-dispatches them to addEventListener() listeners using the
// shape Electron's <webview> element used.
const FORWARDED_EVENTS = [
  'did-start-loading',
  'did-stop-loading',
  'did-finish-load',
  'did-fail-load',
  'did-navigate',
  'did-navigate-in-page',
  'dom-ready',
  'page-title-updated',
  'page-favicon-updated',
  'enter-html-full-screen',
  'leave-html-full-screen',
  'render-process-gone',
  'console-message',
  'media-started-playing',
  'media-paused',
  'context-menu',
  'will-navigate',
  'update-target-url',
  'found-in-page',          // find-bar match counter
  'zoom-changed',           // Ctrl+scroll → zoom
]

// Default UA: take Electron's UA and strip the "Electron/x.y.z" segment
// so pages see plain Chrome. Strawberry confirmed adding "Edg/" causes
// problems with Google Auth, so we DON'T add it.
function _cleanUserAgent(rawUA) {
  if (!rawUA) return rawUA
  return rawUA.replace(/\sElectron\/\S+/, '').replace(/\sseoz-browser\/\S+/i, '')
}

class TabManager {
  constructor({ hostWindow, preloadPath, defaultUserAgent, onContentsCreated }) {
    this.hostWindow = hostWindow
    this.preloadPath = preloadPath
    this.defaultUserAgent = _cleanUserAgent(defaultUserAgent)
    // Optional hook invoked once per tab right after the WebContentsView
    // is created. main.js passes _setupTabContents (keyboard shortcuts,
    // native context menu, fullscreen forwarding, OAuth window-open
    // routing) — Electron 41's app.on('web-contents-created') doesn't
    // fire for WebContentsView so we run those wires from here instead.
    this.onContentsCreated = typeof onContentsCreated === 'function' ? onContentsCreated : null
    /** @type {Map<number, { view: WebContentsView, listeners: Function[], destroyed: boolean }>} */
    this._tabs = new Map()
    this._registered = false
    this._registerIpc()
  }

  // ── Public ────────────────────────────────────────────

  /**
   * Create a new tab. Returns a stable numeric tabId that the
   * renderer uses for every subsequent IPC call.
   *
   * @param {object} opts
   * @param {string} [opts.url='about:blank']
   * @param {boolean} [opts.backgroundThrottling=true]
   * @param {string} [opts.partition]   custom Session partition, optional
   * @returns {number} tabId
   */
  async createTab(opts = {}) {
    const sess = opts.partition
      ? electronSession.fromPartition(opts.partition)
      : (this.hostWindow?.webContents?.session || electronSession.defaultSession)

    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        session: sess,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,   // for ext iframes (e.g. password mgr)
        contextIsolation: true,
        sandbox: true,                      // Strawberry parity
        webSecurity: true,
        safeDialogs: true,
        backgroundThrottling: opts.backgroundThrottling !== false,
        autoplayPolicy: 'document-user-activation-required',
        scrollBounce: true,
        // Markers the preload can sniff via process.argv to learn it's
        // running inside a tab (vs. an OAuth popup BrowserWindow). Lets
        // webview-preload pick the right IPC transport without a host
        // <webview> element.
        additionalArguments: ['--seoz-tab=1'],
      },
    })

    const wc = view.webContents
    const tabId = wc.id

    if (this.defaultUserAgent) {
      try { wc.setUserAgent(this.defaultUserAgent) } catch (_) {}
    }

    // Wire main-process listeners (keyboard shortcuts, native context
    // menu, fullscreen forwarding, OAuth window-open routing). In
    // Electron 41 app.on('web-contents-created') does NOT fire for
    // WebContentsView's webContents, so this is the only reliable
    // place to attach them.
    if (this.onContentsCreated) {
      try { this.onContentsCreated(wc) } catch (err) {
        try { console.warn('[TabManager] onContentsCreated threw:', err?.message || err) } catch (_) {}
      }
    }

    // Start invisible — renderer will position + show.
    view.setVisible(false)

    const entry = { view, listeners: [], destroyed: false }
    this._tabs.set(tabId, entry)

    // ── DIAGNOSTIC LOGGING (v1.10.61) ─────────────────────────
    // Writes to tab-shim.log inside userData (visible to the user
    // without admin / dev tooling). console.log goes to main-process
    // stdout which is invisible in production builds.
    const _diag = (msg) => {
      _writeShimLog('tab=' + tabId + ' ' + msg)
    }
    _diag('createTab url=' + (opts.url || '') + ' partition=' + (opts.partition || 'defaultSession'))

    // Inject the Chrome shim via the Chrome DevTools Protocol (CDP).
    // We tried two simpler approaches first:
    //   v1.10.57: webFrame.executeJavaScript from preload — preload
    //             only ran once on about:blank, never re-ran on the
    //             real navigation, so patches were never applied.
    //   v1.10.58: wc.executeJavaScript on did-start-navigation/dom-ready
    //             — diagnostic confirmed patches still didn't stick
    //             (probably because executeJavaScript runs async and
    //             loses the timing race against page scripts, AND
    //             Chromium's native navigator.userAgentData getter on
    //             Navigator.prototype may be non-configurable).
    //
    // CDP's `Page.addScriptToEvaluateOnNewDocument` is the gold standard
    // for stealth scripts. It runs in the page's main world BEFORE any
    // page <script> tag, on every navigation, persistently. It's what
    // puppeteer-extra-stealth uses.
    // Three-layer injection strategy. CDP alone proved unreliable in
    // Electron 41 (v1.10.59-62 — script registers but never fires).
    // Now we ALSO listen for navigation events and re-inject via
    // executeJavaScript, AND attempt CDP as a best-effort.

    // Apply the Chrome shim to this tab. v1.10.131 extracted into a
    // standalone function (applyChromeShim) so OAuth popup
    // BrowserWindows can get the same treatment — Google sign-in opens
    // a window.open() popup which previously ran with UA spoof but
    // WITHOUT the navigator.userAgentData / window.chrome / WebAuthn
    // shim, leaking its embedded-browser identity to Google's bot
    // detector and triggering "Webbläsaren kanske inte är säker".
    // Wait for CDP Page.addScriptToEvaluateOnNewDocument to be
    // registered with Chromium before doing anything that could
    // trigger a navigation. v1.10.132: previously fire-and-forget,
    // which left a race window where the user's first URL-bar nav
    // (or createTab's initial opts.url) could fire before the
    // pre-script was active — Google's bot-detector reads navigator.*
    // on the very first inline script so timing matters.
    const _shimReady = applyChromeShim(wc, _diag)

    // Forward known events to the renderer.
    this._wireEventForwarding(tabId, wc, entry)

    // window.open / target=_blank: handled by the app-level
    // web-contents-created hook in main.js (OAuth popup routing,
    // SEOZ-styled popup wrapper, etc.). Don't install our own
    // setWindowOpenHandler here or we'd shadow that logic.

    // Now that all wiring is in place, wait for the shim. Cap at
    // 2s in case CDP misbehaves so we don't deadlock tab creation.
    try {
      await Promise.race([
        _shimReady,
        new Promise((res) => setTimeout(() => { _diag('shim wait timed out @2s'); res() }, 2000)),
      ])
    } catch (_) {}

    // Initial load.
    if (opts.url) {
      try { wc.loadURL(opts.url) } catch (_) {}
    }

    return tabId
  }

  destroyTab(tabId) {
    const entry = this._tabs.get(tabId)
    if (!entry || entry.destroyed) return
    entry.destroyed = true
    try {
      // Detach CDP debugger if still attached so we don't leak the session.
      if (entry.view.webContents.debugger.isAttached()) {
        entry.view.webContents.debugger.detach()
      }
    } catch (_) {}
    try {
      this.hostWindow?.contentView?.removeChildView(entry.view)
    } catch (_) {}
    try {
      // Run all detachers we registered.
      entry.listeners.forEach((off) => { try { off() } catch (_) {} })
      entry.listeners.length = 0
    } catch (_) {}
    try {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close({ waitForBeforeUnload: false })
      }
    } catch (_) {}
    this._tabs.delete(tabId)
  }

  destroyAll() {
    for (const id of Array.from(this._tabs.keys())) this.destroyTab(id)
  }

  /**
   * Position + show/hide a tab inside the host window.
   *
   * @param {number} tabId
   * @param {{ x: number, y: number, width: number, height: number }} bounds
   * @param {boolean} visible
   */
  setBounds(tabId, bounds, visible) {
    const entry = this._tabs.get(tabId)
    if (!entry || entry.destroyed) return
    const { view } = entry

    // Attach as a child view of the host window's contentView the
    // first time we get bounds. Re-attaching is harmless if already
    // attached — we use `addChildView` always to keep z-order.
    try {
      const host = this.hostWindow?.contentView
      if (host) {
        // remove first if already present so we can re-add on top
        try { host.removeChildView(view) } catch (_) {}
        host.addChildView(view)
      }
    } catch (_) {}

    if (bounds) {
      const safe = {
        x: Math.max(0, Math.round(bounds.x || 0)),
        y: Math.max(0, Math.round(bounds.y || 0)),
        width: Math.max(0, Math.round(bounds.width || 0)),
        height: Math.max(0, Math.round(bounds.height || 0)),
      }
      try { view.setBounds(safe) } catch (_) {}
    }

    try { view.setVisible(!!visible) } catch (_) {}
  }

  setVisible(tabId, visible) {
    const entry = this._tabs.get(tabId)
    if (!entry || entry.destroyed) return
    try { entry.view.setVisible(!!visible) } catch (_) {}
  }

  // Convenience accessors used by main.js for things like permission
  // routing or the screenshot tool that need a webContents reference.
  getWebContents(tabId) {
    const entry = this._tabs.get(tabId)
    if (!entry || entry.destroyed || entry.view.webContents.isDestroyed()) return null
    return entry.view.webContents
  }

  hasTab(tabId) {
    const entry = this._tabs.get(tabId)
    return !!(entry && !entry.destroyed && !entry.view.webContents.isDestroyed())
  }

  // ── IPC plumbing ──────────────────────────────────────

  _registerIpc() {
    if (this._registered) return
    this._registered = true

    ipcMain.handle('tab:create', (_e, opts) => this.createTab(opts || {}))
    ipcMain.on('tab:destroy', (_e, tabId) => this.destroyTab(tabId))
    ipcMain.on('tab:set-bounds', (_e, { tabId, bounds, visible }) => this.setBounds(tabId, bounds, !!visible))
    ipcMain.on('tab:set-visible', (_e, { tabId, visible }) => this.setVisible(tabId, !!visible))

    // Navigation
    ipcMain.handle('tab:loadURL', (_e, { tabId, url, opts }) => this._withWC(tabId, (wc) => wc.loadURL(url, opts || {})))
    ipcMain.on('tab:reload', (_e, tabId) => this._withWC(tabId, (wc) => wc.reload()))
    ipcMain.on('tab:reload-ignoring-cache', (_e, tabId) => this._withWC(tabId, (wc) => wc.reloadIgnoringCache()))
    ipcMain.on('tab:stop', (_e, tabId) => this._withWC(tabId, (wc) => wc.stop()))
    ipcMain.on('tab:go-back', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.navigationHistory.goBack() } catch (_) { try { wc.goBack() } catch (_) {} } }))
    ipcMain.on('tab:go-forward', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.navigationHistory.goForward() } catch (_) { try { wc.goForward() } catch (_) {} } }))

    // State queries
    ipcMain.handle('tab:get-url', (_e, tabId) => this._withWC(tabId, (wc) => wc.getURL()) || '')
    ipcMain.handle('tab:get-title', (_e, tabId) => this._withWC(tabId, (wc) => wc.getTitle()) || '')
    ipcMain.handle('tab:can-go-back', (_e, tabId) => {
      return this._withWC(tabId, (wc) => {
        try { return wc.navigationHistory.canGoBack() } catch (_) {}
        try { return wc.canGoBack() } catch (_) {}
        return false
      }) || false
    })
    ipcMain.handle('tab:can-go-forward', (_e, tabId) => {
      return this._withWC(tabId, (wc) => {
        try { return wc.navigationHistory.canGoForward() } catch (_) {}
        try { return wc.canGoForward() } catch (_) {}
        return false
      }) || false
    })
    ipcMain.handle('tab:is-loading', (_e, tabId) => this._withWC(tabId, (wc) => !!wc.isLoading()) || false)

    // JavaScript / capture
    ipcMain.handle('tab:execute-js', async (_e, { tabId, code, userGesture }) => {
      const entry = this._tabs.get(tabId)
      if (!entry || entry.destroyed) return null
      try { return await entry.view.webContents.executeJavaScript(code, !!userGesture) } catch (err) {
        // Match <webview>.executeJavaScript shape — undefined on error.
        return null
      }
    })
    ipcMain.handle('tab:capture-page', async (_e, { tabId, rect }) => {
      const entry = this._tabs.get(tabId)
      if (!entry || entry.destroyed) return null
      try {
        const img = rect ? await entry.view.webContents.capturePage(rect) : await entry.view.webContents.capturePage()
        // Ship as a PNG dataURL — good enough for our screenshot/preview consumers
        // and keeps the Electron-native NativeImage out of the renderer.
        return img ? img.toDataURL() : null
      } catch (_) { return null }
    })

    // Find in page
    ipcMain.handle('tab:find-in-page', (_e, { tabId, text, opts }) => this._withWC(tabId, (wc) => wc.findInPage(text, opts || {})) || 0)
    ipcMain.on('tab:stop-find-in-page', (_e, { tabId, action }) => this._withWC(tabId, (wc) => wc.stopFindInPage(action || 'clearSelection')))

    // Zoom
    ipcMain.on('tab:set-zoom-factor', (_e, { tabId, factor }) => this._withWC(tabId, (wc) => wc.setZoomFactor(Number(factor) || 1)))
    ipcMain.handle('tab:get-zoom-factor', (_e, tabId) => this._withWC(tabId, (wc) => wc.getZoomFactor()) || 1)

    // DevTools
    ipcMain.on('tab:open-devtools', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.openDevTools({ mode: 'detach' }) } catch (_) {} }))
    ipcMain.on('tab:close-devtools', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.closeDevTools() } catch (_) {} }))

    // Misc
    ipcMain.on('tab:focus', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.focus() } catch (_) {} }))
    ipcMain.on('tab:print', (_e, tabId) => this._withWC(tabId, (wc) => { try { wc.print({}, () => {}) } catch (_) {} }))
    ipcMain.on('tab:set-audio-muted', (_e, { tabId, muted }) => this._withWC(tabId, (wc) => wc.setAudioMuted(!!muted)))
    ipcMain.on('tab:set-user-agent', (_e, { tabId, userAgent }) => this._withWC(tabId, (wc) => { try { wc.setUserAgent(userAgent) } catch (_) {} }))

    // Forward an IPC message into the tab's preload (mirror of
    // <webview>.send). We use a side-channel event so the receiving
    // preload can re-emit it to page JS via contextBridge / events.
    ipcMain.on('tab:send-to-preload', (_e, { tabId, channel, args }) => {
      const wc = this.getWebContents(tabId)
      if (!wc) return
      try { wc.send(channel, ...(Array.isArray(args) ? args : [args])) } catch (_) {}
    })

    // Reverse: webview-preload (running inside a tab's WebContentsView)
    // calls ipcRenderer.send('tab:relay-from-preload', channel, payload).
    // We forward to the host renderer as `tab:event` with event='ipc-message'
    // so existing addEventListener('ipc-message') call sites still work.
    //
    // This replaces the old <webview>.sendToHost() path. The sender's
    // webContents id IS the tabId since TabManager keys by it.
    ipcMain.on('tab:relay-from-preload', (e, channel, payload) => {
      try {
        const tabId = e.sender.id
        if (!this._tabs.has(tabId)) return
        this._send('tab:event', { tabId, event: 'ipc-message', payload: { channel, args: [payload] } })
      } catch (_) {}
    })
  }

  _withWC(tabId, fn) {
    const entry = this._tabs.get(tabId)
    if (!entry || entry.destroyed) return undefined
    if (entry.view.webContents.isDestroyed()) return undefined
    try { return fn(entry.view.webContents) } catch (_) { return undefined }
  }

  _send(channel, payload) {
    try {
      if (this.hostWindow && !this.hostWindow.isDestroyed()) {
        this.hostWindow.webContents.send(channel, payload)
      }
    } catch (_) {}
  }

  _wireEventForwarding(tabId, wc, entry) {
    const off = []
    for (const evt of FORWARDED_EVENTS) {
      const handler = (...args) => {
        // Strip the Electron `event` argument and serialize what we can.
        // For most events arg[0] is the Electron event, the rest is data.
        const [, ...rest] = args
        let payload
        switch (evt) {
          case 'did-navigate':
            payload = { url: rest[0], httpResponseCode: rest[1], httpStatusText: rest[2] }
            break
          case 'did-navigate-in-page':
            payload = { url: rest[0], isMainFrame: rest[1] }
            break
          case 'did-fail-load':
            payload = {
              errorCode: rest[0],
              errorDescription: rest[1],
              validatedURL: rest[2],
              isMainFrame: rest[3],
            }
            break
          case 'did-finish-load':
            payload = {}
            break
          case 'page-title-updated':
            payload = { title: rest[0], explicitSet: rest[1] }
            break
          case 'page-favicon-updated':
            payload = { favicons: rest[0] || [] }
            break
          case 'render-process-gone':
            payload = rest[0] || { reason: 'unknown', exitCode: 0 }
            break
          case 'console-message':
            payload = {
              level: rest[0],
              message: rest[1],
              line: rest[2],
              sourceId: rest[3],
            }
            break
          case 'context-menu':
            // Keep params minimal — full ContextMenuParams isn't structured-cloneable.
            payload = (() => {
              const p = rest[0] || {}
              return {
                x: p.x, y: p.y,
                linkURL: p.linkURL, srcURL: p.srcURL, pageURL: p.pageURL, frameURL: p.frameURL,
                selectionText: p.selectionText, mediaType: p.mediaType,
                hasImageContents: p.hasImageContents, isEditable: p.isEditable,
                editFlags: p.editFlags || {},
              }
            })()
            break
          case 'will-navigate':
            payload = { url: rest[0] }
            break
          case 'update-target-url':
            payload = { url: rest[0] }
            break
          case 'found-in-page':
            // <webview> shape was { result: { activeMatchOrdinal, matches, ... } }
            payload = { result: rest[0] || {} }
            break
          case 'zoom-changed':
            payload = { zoomDirection: rest[0] }
            break
          case 'did-start-loading':
          case 'did-stop-loading':
          case 'dom-ready':
          case 'enter-html-full-screen':
          case 'leave-html-full-screen':
          case 'media-started-playing':
          case 'media-paused':
            payload = {}
            break
          default:
            payload = {}
        }
        this._send('tab:event', { tabId, event: evt, payload })
      }
      try {
        wc.on(evt, handler)
        off.push(() => { try { wc.removeListener(evt, handler) } catch (_) {} })
      } catch (_) {}
    }

    // Forward IPC messages from the tab's preload (channel = 'ipc-message'
    // in <webview> land). Our webview-preload uses ipcRenderer.sendToHost();
    // here we just listen on `ipc-message-host` for the new TabHandle world.
    // We also keep the legacy `ipc-message` shape so old preload code still
    // works during migration.
    try {
      const ipcHandler = (_evt, channel, ...args) => {
        this._send('tab:event', { tabId, event: 'ipc-message', payload: { channel, args } })
      }
      wc.on('ipc-message', ipcHandler)
      off.push(() => { try { wc.removeListener('ipc-message', ipcHandler) } catch (_) {} })
    } catch (_) {}

    // Cleanup on destroy.
    try {
      wc.once('destroyed', () => {
        entry.destroyed = true
        this._send('tab:event', { tabId, event: 'destroyed', payload: {} })
        this._tabs.delete(tabId)
      })
    } catch (_) {}

    entry.listeners = off
  }
}

module.exports = { TabManager, applyChromeShim }
