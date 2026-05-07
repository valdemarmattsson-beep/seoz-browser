'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the SEOZ Inspector BrowserWindow.
//
//  The inspector lives in its own native window (DevTools-style) so
//  it floats above the page instead of fighting WebContentsView
//  z-order. The chrome BrowserWindow keeps doing the actual page-data
//  extraction (it owns the active tab's WebContentsView); the
//  inspector window is purely a renderer for that data.
//
//  Channels:
//    main → inspector-window:
//      inspector:data {url, scheme, isOverlay, page}
//        Full page-analysis blob from chrome's analyzePage. `page`
//        is null for SEOZ overlay tabs (seoz://home etc.).
//      inspector:active-tab {url, title, scheme}
//        Cheap notification that the active tab changed; window asks
//        for fresh data via requestData() when ready.
//      inspector:console-message {type, message, source, line, time}
//        New console event from the active tab — pushed live as the
//        page logs.
//      inspector:console-clear
//        Active tab navigated → wipe stored console messages.
//      inspector:element-picked {tag, id, class, text, html}
//        User clicked an element while picker was active. Window
//        flips picker UI off + opens Element-info display.
//
//    inspector-window → main (send):
//      inspector:request-data
//        Ask main to refresh page-analysis from chrome (used by
//        the ↻ refresh button and on tab-switch).
//      inspector:close
//        User hit close inside the inspector — main hides the window.
//      inspector:toggle-picker {active}
//        Enable/disable element picker overlay in active tab.
//
//    inspector-window → main (invoke / Promise):
//      inspector:get-source        → string (full HTML outerHTML)
//      inspector:get-network       → array of resource-timing entries
//      inspector:get-elements      → DOM tree (depth-limited)
//      inspector:get-console       → array of buffered console msgs
//      inspector:download-image {src} → triggers download in active tab
//
//  All methods are namespaced under window.seoz.inspector to match
//  the existing chrome renderer's API surface.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

// Allowlist of push-events main can fire at the inspector window. Any
// channel not listed here is rejected so a compromised main side can't
// drive arbitrary DOM mutations through the contextBridge bridges.
const PUSH_CHANNELS = new Set([
  'inspector:data',
  'inspector:active-tab',
  'inspector:console-message',
  'inspector:console-clear',
  'inspector:element-picked',
])

function _on(channel, cb) {
  if (!PUSH_CHANNELS.has(channel)) {
    console.warn('[inspector-preload] rejected listen on', channel)
    return () => {}
  }
  const wrapped = (_e, payload) => {
    try { cb(payload) } catch (err) {
      console.error('[inspector-preload] listener error on', channel, err)
    }
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('seoz', {
  inspector: {
    // Push subscriptions — return an unsubscribe fn so the window can
    // tear them down if it ever wants to (currently it lives for the
    // lifetime of the BrowserWindow so unsub is mostly cosmetic).
    onData:           (cb) => _on('inspector:data', cb),
    onActiveTab:      (cb) => _on('inspector:active-tab', cb),
    onConsoleMessage: (cb) => _on('inspector:console-message', cb),
    onConsoleClear:   (cb) => _on('inspector:console-clear', cb),
    onElementPicked:  (cb) => _on('inspector:element-picked', cb),

    // Fire-and-forget actions
    requestData:   ()        => ipcRenderer.send('inspector:request-data'),
    close:         ()        => ipcRenderer.send('inspector:close'),
    togglePicker:  (active)  => ipcRenderer.send('inspector:toggle-picker', { active: !!active }),
    downloadImage: (src)     => ipcRenderer.send('inspector:download-image', { src: String(src || '') }),

    // Promise-returning data fetchers — chrome runs the corresponding
    // wv.executeJavaScript and returns the result.
    getSource:   ()          => ipcRenderer.invoke('inspector:get-source'),
    getNetwork:  ()          => ipcRenderer.invoke('inspector:get-network'),
    getElements: ()          => ipcRenderer.invoke('inspector:get-elements'),
    getConsole:  ()          => ipcRenderer.invoke('inspector:get-console'),
    // Tracking-tag detector — returns
    //   { items, counts, dataLayer, scriptCount, cookieCount }
    // describing analytics / marketing pixels / consent banners / etc.
    // detected on the active page.
    getTracking: ()          => ipcRenderer.invoke('inspector:get-tracking'),

    // Create a task in the chrome workspace's active client. payload is
    //   { title, description?, url?, severity?, skill_type?, effort_h? }
    // — clientId is forced to the active client by the chrome-side
    // bridge handler so the inspector window can't smuggle a
    // different one in. Returns { ok, task?, error? }.
    createTask:  (payload)   => ipcRenderer.invoke('inspector:create-task', payload || {}),
  },
})
