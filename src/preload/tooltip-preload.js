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
//      tooltip:update {title, url, domain, favicon, preview, tabId}
//
//    tooltip-renderer → main:
//      tooltip:set-interactive (bool)
//        Toggle setIgnoreMouseEvents on this window. true = the
//        window captures mouse clicks (over an action button); false =
//        clicks pass through to the parent window underneath.
//      tooltip:cursor-on-card (bool)
//        Cursor entered/left the card area. Main forwards this to the
//        main window so it can cancel/reschedule its hide timer.
//      tooltip:action {action, tabId}
//        User clicked an action button (pin / split). Main forwards
//        to the main window's renderer for execution.
// ════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  tooltip: {
    onUpdate: (cb) => {
      ipcRenderer.on('tooltip:update', (_e, payload) => {
        try { cb(payload || {}) } catch (err) { console.error('[tooltip] onUpdate cb error:', err) }
      })
    },
    setInteractive: (on) => ipcRenderer.send('tooltip:set-interactive', !!on),
    cursorOnCard:   (on) => ipcRenderer.send('tooltip:cursor-on-card', !!on),
    triggerAction:  (action, tabId) => ipcRenderer.send('tooltip:action', { action, tabId }),
    // Renderer measured its card and asks main to resize the
    // BrowserWindow accordingly. Without this the action buttons get
    // clipped when the preview image is present (content tall, window
    // small). Bound is set in main to avoid silly values.
    requestResize:  (height) => ipcRenderer.send('tooltip:resize', { height }),
  },
})
