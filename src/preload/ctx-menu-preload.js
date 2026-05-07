'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the generic context-menu sibling WebContentsView.
//
//  Replaces the in-DOM #ctxMenu (v1.10.137) so the menu z-orders above
//  the page WebContentsView without needing the chrome-clip-active
//  page-resize workaround. Same shape as bm-folder-preload.js.
//
//  Renderer (chrome) keeps the action callbacks indexed by id; popup
//  ships click events back as `{ id }` and renderer dispatches.
//
//  Channels:
//    main → popup-renderer:
//      ctx-menu:items {items, isDark}
//        items: [{ id, label, icon?, danger?, disabled? } | '---']
//
//    popup-renderer → main:
//      ctx-menu:action {id}     left-click on a menu item
//      ctx-menu:resize {width, height}   measured size after render
//      ctx-menu:close           Escape / outside-click / blur
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  ctxMenu: {
    onItems: (cb) => {
      ipcRenderer.on('ctx-menu:items', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[ctx-menu] onItems cb error:', err) }
      })
    },
    action: (id)              => ipcRenderer.send('ctx-menu:action', { id }),
    resize: (width, height)   => ipcRenderer.send('ctx-menu:resize', { width, height }),
    close:  ()                => ipcRenderer.send('ctx-menu:close'),
  },
})
