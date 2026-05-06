'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the URL suggest WebContentsView.
//
//  Single shared dropdown that floats above the page (same pattern as
//  tab tooltip / Shield popup / chrome label). Chrome computes matches
//  and pushes them in via 'urlSuggest:set-items'; the popup just
//  renders + emits hover/pick events back.
//
//  The chrome's URL input keeps keyboard focus the whole time — popup
//  never steals it, so ArrowUp / ArrowDown / Enter still arrive at
//  the input. Selection highlight is push-driven from chrome.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  urlSuggest: {
    onSetItems: (cb) => ipcRenderer.on('urlSuggest:set-items', (_e, payload) => {
      try { cb(payload || {}) } catch (err) { console.error('[urlSuggest] onSetItems cb error:', err) }
    }),
    onSetSel: (cb) => ipcRenderer.on('urlSuggest:set-sel', (_e, idx) => {
      try { cb(idx) } catch (err) { console.error('[urlSuggest] onSetSel cb error:', err) }
    }),
    pick:          (url)    => ipcRenderer.send('urlSuggest:pick', url),
    hover:         (idx)    => ipcRenderer.send('urlSuggest:hover', idx),
    requestResize: (height) => ipcRenderer.send('urlSuggest:resize', { height }),
  },
})
