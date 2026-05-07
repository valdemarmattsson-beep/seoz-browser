'use strict'
// ════════════════════════════════════════════════════════════════════
//  Preload for the tab-tooltip WebContentsView.
//
//  v1.10.116: switched from a separate BrowserWindow to a sibling
//  WebContentsView under the main BrowserWindow's contentView. Mouse
//  events route to whichever view is at the cursor naturally, so the
//  setInteractive/ignoreMouseEvents juggling we needed before is
//  gone. Click handlers in the tooltip renderer just work.
//
//  Channels:
//    main → tooltip-renderer:
//      tooltip:update {title, url, domain, favicon, preview, tabId}
//
//    tooltip-renderer → main:
//      tooltip:cursor-on-card (bool)
//        Cursor entered/left the card. Main forwards to the main
//        window's renderer so it can cancel its hide timer while the
//        cursor is on the tooltip.
//      tooltip:action {action, tabId}
//        User clicked an action button (pin / split). Main forwards
//        to the main window's renderer for execution.
//      tooltip:resize {height}
//        Renderer measured its card and asks main to resize the view
//        to match — needed when the preview image loads and grows
//        the card. Bounded in main.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  tooltip: {
    onUpdate: (cb) => {
      ipcRenderer.on('tooltip:update', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[tooltip] onUpdate cb error:', err) }
      })
    },
    cursorOnCard:  (on) => ipcRenderer.send('tooltip:cursor-on-card', !!on),
    triggerAction: (action, tabId) => ipcRenderer.send('tooltip:action', { action, tabId }),
    requestResize: (height) => ipcRenderer.send('tooltip:resize', { height }),
  },
})
