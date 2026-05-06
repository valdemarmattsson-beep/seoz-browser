'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the chrome kebab-menu WebContentsView.
//
//  Same pattern as blocker-popup-preload.js — the menu lives in a
//  sibling WebContentsView so it z-orders above the page (other
//  WebContentsViews) instead of fighting them via z-index. The chrome
//  renderer keeps ownership of the action map; the popup is purely a
//  view + click event source.
//
//  Channels:
//    main → popup-renderer:
//      chrome-menu:items {items, zoomLevel, isDark}
//
//    popup-renderer → main:
//      chrome-menu:action {id}
//        Click on an item or zoom button. Main forwards to the chrome
//        renderer which dispatches it through its action map.
//      chrome-menu:resize {width, height}
//        Renderer measured the card and asks main to fit the view.
//      chrome-menu:close
//        Renderer asks to be hidden (e.g. blur or Esc).
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  chromeMenu: {
    onItems: (cb) => {
      ipcRenderer.on('chrome-menu:items', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[chrome-menu] onItems cb error:', err) }
      })
    },
    action:  (id, extra)         => ipcRenderer.send('chrome-menu:action', { id, ...(extra || {}) }),
    resize:  (width, height)     => ipcRenderer.send('chrome-menu:resize', { width, height }),
    close:   ()                  => ipcRenderer.send('chrome-menu:close'),
  },
})
