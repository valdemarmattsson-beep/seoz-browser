'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the SEOZ Shield popup WebContentsView.
//
//  Same pattern as tooltip-preload.js — popup is a sibling
//  WebContentsView under the main BrowserWindow's contentView, so it
//  z-orders above the page (other WebContentsViews) without any of
//  the chrome-clip-active gymnastics the in-DOM popup needed.
//
//  Channels:
//    main → popup-renderer:
//      shield:state {count, enabled, cookieMode}
//
//    popup-renderer → main:
//      shield:cursor-on-card (bool)
//        Hover state — main uses it to keep popup open while cursor
//        moves between trigger button and popup.
//      shield:action {action, value?}
//        User interacted. action ∈ { 'toggle-enabled', 'set-cookie-mode' }.
//        Main forwards to the chrome renderer for execution.
//      shield:resize {height}
//        Renderer measured its card and asks main to resize the view.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  shield: {
    onState: (cb) => {
      ipcRenderer.on('shield:state', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[shield] onState cb error:', err) }
      })
    },
    cursorOnCard:  (on)            => ipcRenderer.send('shield:cursor-on-card', !!on),
    action:        (action, value) => ipcRenderer.send('shield:action', { action, value }),
    requestResize: (height)        => ipcRenderer.send('shield:resize', { height }),
  },
})
