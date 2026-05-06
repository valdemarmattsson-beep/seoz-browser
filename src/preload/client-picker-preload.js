'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the client/project picker WebContentsView.
//
//  Same shape as chrome-menu-preload.js — the picker dropdown lives in
//  a sibling WebContentsView so it z-orders above the page instead of
//  fighting clip-from-top mechanics. Chrome renderer keeps the data
//  source of truth (synced.clients / .projects) and the action map.
//
//  Channels:
//    main → popup-renderer:
//      client-picker:items {clients, projects, activeClientId,
//                           activeProjectId, isDark}
//
//    popup-renderer → main:
//      client-picker:action {id, anchorX?, anchorY?}
//        Click on a row or button. id is one of:
//          client:<clientId>      pick that client
//          project:<projectId>    pick that project
//          project-menu:<id>      open per-project rename/delete menu
//          refresh                force a fresh sync from seoz.io
//          create-project         open the create-project prompt
//      client-picker:resize {width, height}
//      client-picker:close
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  clientPicker: {
    onItems: (cb) => {
      ipcRenderer.on('client-picker:items', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[client-picker] onItems cb error:', err) }
      })
    },
    action:  (id, extra)     => ipcRenderer.send('client-picker:action', { id, ...(extra || {}) }),
    resize:  (width, height) => ipcRenderer.send('client-picker:resize', { width, height }),
    close:   ()              => ipcRenderer.send('client-picker:close'),
  },
})
