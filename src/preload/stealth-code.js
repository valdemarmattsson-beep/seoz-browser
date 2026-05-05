'use strict'
// ════════════════════════════════════════════════════════════════════
//  STEALTH CODE — single source of truth
//
//  Exporterar en sträng som innehåller en IIFE som ska injiceras i
//  varje webview/popup-page innan page-scripts kör. Importeras både
//  från:
//    - webview-preload.js (kör webFrame.executeJavaScript)
//    - main.js (kör webContents.executeJavaScript på did-start-loading)
//
//  Två injektionsvägar = bältet-och-hängslen mot timingproblem.
//  webFrame-vägen i preloaden är vad som faktiskt kör i de flesta
//  fall. Main-process-vägen är bara backup om webview-preloaden
//  råkar köras efter Googles detection-script.
//
//  Patcherna ska ALLDRIG kasta — om något går snett ska page-loaden
//  fortsätta som vanligt. Tysta catch:ar runt varje block.
// ════════════════════════════════════════════════════════════════════

module.exports = String.raw`(function() {
  try {
    // Skydd mot dubbel-applicering om main + preload båda kör
    if (window.__seozStealthApplied) return
    window.__seozStealthApplied = true

    // ── 1. navigator.webdriver — ska vara undefined på riktig Chrome
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    })

    // ── 2. navigator.plugins — 5 fake PDF-plugins som riktig Chrome
    const fakePlugins = (() => {
      const make = (name, filename, description) => {
        const plugin = Object.create(Plugin.prototype || {})
        Object.defineProperties(plugin, {
          name:        { value: name },
          filename:    { value: filename },
          description: { value: description },
          length:      { value: 1 },
        })
        return plugin
      }
      const list = [
        make('PDF Viewer',                 'internal-pdf-viewer', 'Portable Document Format'),
        make('Chrome PDF Viewer',          'internal-pdf-viewer', 'Portable Document Format'),
        make('Chromium PDF Viewer',        'internal-pdf-viewer', 'Portable Document Format'),
        make('Microsoft Edge PDF Viewer',  'internal-pdf-viewer', 'Portable Document Format'),
        make('WebKit built-in PDF',        'internal-pdf-viewer', 'Portable Document Format'),
      ]
      const arr = Object.create(PluginArray.prototype || Array.prototype)
      list.forEach((p, i) => { arr[i] = p; arr[p.name] = p })
      Object.defineProperty(arr, 'length', { value: list.length })
      return arr
    })()
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: () => fakePlugins,
      configurable: true,
    })

    // ── 3. navigator.languages — sv-SE för svenska användare
    if (!navigator.languages || navigator.languages.length === 0 ||
        (navigator.languages.length === 1 && navigator.languages[0] === 'en-US')) {
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: () => ['sv-SE', 'sv', 'en-US', 'en'],
        configurable: true,
      })
    }

    // ── 4. window.chrome.runtime / .loadTimes / .csi / .app
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason:  { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch:       { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs:         { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      }
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        }
      }
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return { onloadT: Date.now(), pageT: 1, startE: Date.now(), tran: 15 }
      }
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        isInstalled:        false,
        getDetails:         function() { return null },
        getIsInstalled:     function() { return false },
        installState:       function() { return 'not_installed' },
        runningState:       function() { return 'cannot_run' },
      }
    }

    // ── 5. Permissions.prototype.query — notifications-fall
    try {
      if (window.navigator.permissions && window.navigator.permissions.query) {
        const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
        window.navigator.permissions.query = function(p) {
          if (p && p.name === 'notifications') {
            return Promise.resolve({
              state: typeof Notification !== 'undefined' ? Notification.permission : 'default',
              onchange: null,
              addEventListener: function() {},
              removeEventListener: function() {},
              dispatchEvent: function() { return true },
            })
          }
          return origQuery(p)
        }
      }
    } catch (_) {}

    // ── 6. WebGL renderer-spoof — Intel Iris istället för "Google SwiftShader"
    try {
      const patchWebGL = (proto) => {
        if (!proto) return
        const orig = proto.getParameter
        proto.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.'
          if (parameter === 37446) return 'Intel Iris OpenGL Engine'
          return orig.call(this, parameter)
        }
      }
      patchWebGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype)
      patchWebGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype)
    } catch (_) {}

    // ── 7. Notification.permission — 'default' istället för 'denied'
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        Object.defineProperty(Notification, 'permission', {
          get: () => 'default',
          configurable: true,
        })
      }
    } catch (_) {}

    // ── 8. navigator.deviceMemory
    try {
      if (!('deviceMemory' in navigator)) {
        Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true })
      }
    } catch (_) {}

    // ── 9. MediaSource codec-stöd — common Chrome-codecs
    try {
      if (typeof MediaSource !== 'undefined') {
        const realIsTypeSupported = MediaSource.isTypeSupported.bind(MediaSource)
        MediaSource.isTypeSupported = function(type) {
          if (typeof type === 'string') {
            if (/video\/mp4.*avc1/i.test(type))    return true
            if (/audio\/mp4.*mp4a/i.test(type))    return true
            if (/video\/webm.*vp[89]/i.test(type)) return true
            if (/audio\/webm.*opus/i.test(type))   return true
          }
          return realIsTypeSupported(type)
        }
      }
    } catch (_) {}

    // ── 10. window.outerWidth/Height — fixa headless-Chrome 0:or
    try {
      if (window.outerWidth === 0 || window.outerHeight === 0) {
        Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth,      configurable: true })
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 80, configurable: true })
      }
    } catch (_) {}

    // ── 11. Function.prototype.toString — patchade funktioner ska
    //    rapportera "[native code]" så bot-detection inte ser fakes
    try {
      const origToString = Function.prototype.toString
      const proxiedFns = new WeakSet()
      if (window.chrome) {
        if (window.chrome.loadTimes) proxiedFns.add(window.chrome.loadTimes)
        if (window.chrome.csi)       proxiedFns.add(window.chrome.csi)
      }
      if (window.navigator?.permissions?.query) proxiedFns.add(window.navigator.permissions.query)
      Function.prototype.toString = new Proxy(origToString, {
        apply(target, thisArg, args) {
          if (proxiedFns.has(thisArg)) {
            return 'function ' + (thisArg.name || '') + '() { [native code] }'
          }
          return Reflect.apply(target, thisArg, args)
        },
      })
    } catch (_) {}
  } catch (e) {
    // Aldrig kasta — page-load måste fortsätta även om patcher failar
  }
})();`
