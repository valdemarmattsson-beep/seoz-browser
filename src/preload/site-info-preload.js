'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the URL-bar Site Info popup.
//
//  Tiny popup shown next to the bookmark star. Lists the active site,
//  TLS state, and exposes "Clear cookies" / "Clear cache" actions
//  scoped to the current origin. Architecture mirrors the Shield
//  popup — sibling WebContentsView, IPC-driven state.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  siteInfo: {
    onUpdate: (cb) => ipcRenderer.on('site-info:update', (_e, payload) => {
      try { cb(payload || {}) } catch (err) { console.error('[site-info onUpdate]', err) }
    }),
    onCert: (cb) => ipcRenderer.on('site-info:cert', (_e, cert) => {
      try { cb(cert) } catch (err) { console.error('[site-info onCert]', err) }
    }),
    action:        (action) => ipcRenderer.send('site-info:action', action),
    requestResize: (height) => ipcRenderer.send('site-info:resize', { height }),
  },
})
