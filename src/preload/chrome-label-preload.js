'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the generic chrome-label WebContentsView.
//
//  Used for hover labels on chrome elements (e.g. the right-sidebar
//  dock icons) that previously rendered as in-DOM `.dtt` tooltips and
//  got clipped by the page WebContentsView z-order. This view floats
//  above the page like the tab tooltip, so labels are always visible.
//
//  Dead simple by design — one channel in, one out.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  chromeLabel: {
    onUpdate:      (cb)             => ipcRenderer.on('chrome-label:update', (_e, text) => {
      try { cb(text) } catch (err) { console.error('[chrome-label] onUpdate cb error:', err) }
    }),
    requestResize: (width, height)  => ipcRenderer.send('chrome-label:resize', { width, height }),
  },
})
