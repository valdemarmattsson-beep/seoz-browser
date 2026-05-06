'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the tab-tooltip BrowserWindow.
//
//  This is a tiny floating, transparent, frame-less window that
//  renders the tab preview card OVER the main window. It exists only
//  so the tooltip can paint above the WebContentsView (the main page),
//  which a normal HTML element cannot do — WebContentsView is a native
//  OS-level layer that ignores DOM z-index.
//
//  Channels:
//    main → tooltip-renderer:
//      tooltip:update {title, url, domain, favicon, preview}
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  tooltip: {
    onUpdate: (cb) => {
      ipcRenderer.on('tooltip:update', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[tooltip] onUpdate cb error:', err) }
      })
    },
  },
})
