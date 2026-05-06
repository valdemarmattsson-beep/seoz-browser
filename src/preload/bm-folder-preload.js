'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the bookmark-folder dropdown WebContentsView.
//
//  Same shape as chrome-menu-preload.js — folder contents render in a
//  sibling WebContentsView so the dropdown z-orders above the page.
//  Renderer keeps the bookmark store; popup is purely view + click /
//  right-click forwarder.
//
//  Channels:
//    main → popup-renderer:
//      bm-folder:items {folder, items, isDark}
//        items: [{ id, title, favicon|null, url }] or empty
//
//    popup-renderer → main:
//      bm-folder:action {id, anchorX?, anchorY?}
//        id is one of:
//          open:<bmId>   left-click → open the bookmark
//          ctx:<bmId>    right-click → open per-bookmark ctx menu
//      bm-folder:resize {width, height}
//      bm-folder:close
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  bmFolder: {
    onItems: (cb) => {
      ipcRenderer.on('bm-folder:items', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[bm-folder] onItems cb error:', err) }
      })
    },
    action:  (id, extra)     => ipcRenderer.send('bm-folder:action', { id, ...(extra || {}) }),
    resize:  (width, height) => ipcRenderer.send('bm-folder:resize', { width, height }),
    close:   ()              => ipcRenderer.send('bm-folder:close'),
  },
})
