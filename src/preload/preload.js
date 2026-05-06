'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const path = require('path')

// Absolute file:// URL to the webview-preload script. Renderer sets
// this on each <webview preload="..."> attribute so guest pages get
// our autofill detector. Electron requires file:// for webview preloads.
const WEBVIEW_PRELOAD_URL = 'file:///' + path.join(__dirname, 'webview-preload.js').replace(/\\/g, '/')

contextBridge.exposeInMainWorld('seoz', {
  // Path to the webview preload — used by the renderer when it
  // creates new webview elements to wire autofill / detection scripts.
  webviewPreloadUrl: WEBVIEW_PRELOAD_URL,
  // Window controls
  minimize:    () => ipcRenderer.send('win-min'),
  maximize:    () => ipcRenderer.send('win-max'),
  close:       () => ipcRenderer.send('win-close'),
  fullscreen:  () => ipcRenderer.send('win-fullscreen'),
  isFullscreen:() => ipcRenderer.invoke('win-is-fullscreen'),

  // Manual window drag (workaround for Electron 28 frame:false bug)
  winDragStart: ()         => ipcRenderer.send('win-drag-start'),
  winDragMove:  (dx, dy)   => ipcRenderer.send('win-drag-move', dx, dy),
  winDragEnd:   ()         => ipcRenderer.send('win-drag-end'),

  // Native context menu for tab right-click. v1.10.118 switched away
  // from HTML showCtx to bypass the chrome-clip-active mechanism that
  // was suspected of freezing the app on right-click.
  showTabMenu: (tabId) => ipcRenderer.send('tab:show-menu', { tabId }),
  onTabMenuAction: (cb) => ipcRenderer.on('tab:menu-action', (_e, payload) => {
    try { cb(payload || {}) } catch (err) { console.error('[onTabMenuAction]', err) }
  }),

  // Tab-preview tooltip — backed by a separate transparent
  // BrowserWindow in main. This is the only way to render a tooltip
  // OVER a WebContentsView (the page); HTML z-index can't reach
  // across that native-view boundary. anchorX/Y are viewport coords
  // in the parent window; main converts to screen coords.
  tooltip: {
    // v1.10.116: tab tooltip is a sibling WebContentsView under the
    // main BrowserWindow's contentView (not a separate alwaysOnTop
    // BrowserWindow as in v1.10.107-1.10.115). Same API surface —
    // show/hide/onCursorOnCard/onAction are all the renderer needs.
    show: (anchorX, anchorY, content) => ipcRenderer.send('tooltip:show', { anchorX, anchorY, content }),
    hide: () => ipcRenderer.send('tooltip:hide'),
    // The tooltip's renderer signals these back to us via main:
    //   onCursorOnCard(true|false) — cursor entered / left the tooltip.
    //     Renderer should cancel its hide timer on true, schedule on false.
    //   onAction({action, tabId}) — user clicked Fäst / Splitvy.
    onCursorOnCard: (cb) => ipcRenderer.on('tooltip:cursor-on-card', (_e, on) => {
      try { cb(!!on) } catch (err) { console.error('[onCursorOnCard]', err) }
    }),
    onAction: (cb) => ipcRenderer.on('tooltip:action', (_e, payload) => {
      try { cb(payload || {}) } catch (err) { console.error('[onAction]', err) }
    }),
    // NB: onForceHide used to live here (v1.10.114) for blur/minimize
    // cleanup. Removed in v1.10.116 — the WebContentsView is a child
    // of the main window so it's automatically hidden when the parent
    // is occluded. No explicit cleanup needed.
  },

  // Auto-recovery from Google "Inloggningen misslyckades" — clears
  // cookies + storage for google.com hosts so the next sign-in gets
  // a clean session. Triggered by the renderer's banner when the
  // active tab lands on /v3/signin/rejected.
  clearGoogleAuthData: () => ipcRenderer.invoke('seoz-clear-google-auth-data'),

  // SEOZ Shield popup — sibling WebContentsView that floats above the
  // page (so the page stays visible under the popup, no chrome-clip
  // gymnastics). Master state lives in the chrome renderer; the popup
  // is purely a view + click event source.
  shieldPopup: {
    show:        (anchorX, anchorY, state) => ipcRenderer.send('shield-popup:show', { anchorX, anchorY, state }),
    hide:        ()      => ipcRenderer.send('shield-popup:hide'),
    updateState: (state) => ipcRenderer.send('shield-popup:update-state', { state }),
    onCursorOnCard: (cb) => ipcRenderer.on('shield-popup:cursor-on-card', (_e, on) => {
      try { cb(!!on) } catch (err) { console.error('[shieldPopup onCursorOnCard]', err) }
    }),
    onAction: (cb) => ipcRenderer.on('shield-popup:action', (_e, payload) => {
      try { cb(payload || {}) } catch (err) { console.error('[shieldPopup onAction]', err) }
    }),
  },

  // Password manager (per-profile, encrypted via OS-level safeStorage)
  passwordsList:   ()              => ipcRenderer.invoke('passwords-list'),
  passwordsAdd:    (entry)         => ipcRenderer.invoke('passwords-add', entry),
  passwordsUpdate: (id, updates)   => ipcRenderer.invoke('passwords-update', { id, updates }),
  passwordsDelete: (id)            => ipcRenderer.invoke('passwords-delete', id),
  // Master-PIN guard for the password manager modal
  passwordsPinStatus: ()    => ipcRenderer.invoke('passwords-pin-status'),
  passwordsPinSet:    (pin) => ipcRenderer.invoke('passwords-pin-set', pin),
  passwordsPinVerify: (pin) => ipcRenderer.invoke('passwords-pin-verify', pin),
  passwordsPinClear:  ()    => ipcRenderer.invoke('passwords-pin-clear'),

  // Push autofill data into a specific OAuth popup BrowserWindow
  // (looked up by webContents id in main).
  sendToPopup: (popupId, payload) => ipcRenderer.send('popup-autofill-fill', { popupId, payload }),

  // DevTools
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // Theme
  getTheme:    () => ipcRenderer.invoke('get-theme'),
  setTheme:    t  => ipcRenderer.send('set-theme', t),

  // API key
  getApiKey:   () => ipcRenderer.invoke('get-api-key'),
  setApiKey:   k  => ipcRenderer.invoke('set-api-key', k),
  delApiKey:   () => ipcRenderer.invoke('del-api-key'),

  // Profiles (Chrome-like user profiles)
  profileList:      () => ipcRenderer.invoke('profile-list'),
  profileGetActive: () => ipcRenderer.invoke('profile-get-active'),
  profileCreate:    ({ name, email }) => ipcRenderer.invoke('profile-create', { name, email }),
  profileUpdate:    (id, updates) => ipcRenderer.invoke('profile-update', { id, updates }),
  profileDelete:    (id) => ipcRenderer.invoke('profile-delete', id),
  profileSwitch:    (id) => ipcRenderer.invoke('profile-switch', id),

  // Generic store
  storeGet:    (k, d) => ipcRenderer.invoke('store-get', k, d),
  storeSet:    (k, v) => ipcRenderer.invoke('store-set', k, v),

  // SEOZ API
  triggerSync: (apiKey) => ipcRenderer.invoke('trigger-sync', apiKey),
  fetchApi:    (opts)   => ipcRenderer.invoke('fetch-browser-api', opts),

  // Agent Ready — grade any URL on agent/LLM-readiness
  agentReadyScan: (url) => ipcRenderer.invoke('fetch-agent-ready', url),

  // Claude AI
  claudeChat:  (opts) => ipcRenderer.invoke('claude-chat', opts),

  // OpenAI Chat
  openaiChat:  (opts) => ipcRenderer.invoke('openai-chat', opts),

  // Whisper STT (Speech-to-Text)
  whisperSTT:  (opts) => ipcRenderer.invoke('whisper-stt', opts),

  // ElevenLabs TTS
  elevenlabsTTS:    (opts) => ipcRenderer.invoke('elevenlabs-tts', opts),
  elevenlabsVoices: (opts) => ipcRenderer.invoke('elevenlabs-voices', opts),

  // Mail (IMAP/SMTP)
  mail: {
    // Tests + deprecated single-account compat
    test:       (cfg)      => ipcRenderer.invoke('mail:test', cfg),
    saveConfig: (cfg)      => ipcRenderer.invoke('mail:save-config', cfg),
    hasConfig:  ()         => ipcRenderer.invoke('mail:has-config'),
    getConfig:  ()         => ipcRenderer.invoke('mail:get-config'),
    forget:     ()         => ipcRenderer.invoke('mail:forget'),
    // Multi-account management
    accountsList:     ()          => ipcRenderer.invoke('mail:accounts-list'),
    accountAdd:       (cfg)       => ipcRenderer.invoke('mail:account-add', cfg),
    accountUpdate:    (id, u)     => ipcRenderer.invoke('mail:account-update', { id, updates: u }),
    accountDelete:    (id)        => ipcRenderer.invoke('mail:account-delete', id),
    accountSetActive: (id)        => ipcRenderer.invoke('mail:account-set-active', id),
    accountGetActive: ()          => ipcRenderer.invoke('mail:account-get-active'),
    // Mail operations — opts may include { accountId } to override active account
    foldersList: (opts)    => ipcRenderer.invoke('mail:folders-list', opts || {}),
    list:       (opts)     => ipcRenderer.invoke('mail:list', opts || {}),
    search:     (opts)     => ipcRenderer.invoke('mail:search', opts || {}),
    get:        (opts)     => ipcRenderer.invoke('mail:get', opts || {}),
    flag:       (opts)     => ipcRenderer.invoke('mail:flag', opts || {}),
    move:       (opts)     => ipcRenderer.invoke('mail:move', opts || {}),
    snooze:     (opts)     => ipcRenderer.invoke('mail:snooze', opts || {}),
    scheduledList: (opts)  => ipcRenderer.invoke('mail:scheduled-list', opts || {}),
    scheduledCancel: (id)  => ipcRenderer.invoke('mail:scheduled-cancel', id),
    unreadTotal: ()        => ipcRenderer.invoke('mail:unread-total'),
    templatesList:  ()     => ipcRenderer.invoke('mail:templates-list'),
    templateSave:   (t)    => ipcRenderer.invoke('mail:template-save', t),
    templateDelete: (id)   => ipcRenderer.invoke('mail:template-delete', id),
    classify:       (opts) => ipcRenderer.invoke('mail:classify', opts || {}),
    researchDomain: (opts) => ipcRenderer.invoke('mail:research-domain', opts || {}),
    send:       (opts)     => ipcRenderer.invoke('mail:send', opts || {}),
    saveDraft:  (opts)     => ipcRenderer.invoke('mail:save-draft', opts || {}),
    deleteDraft:(opts)     => ipcRenderer.invoke('mail:delete-draft', opts || {}),
    pickAttachments: ()        => ipcRenderer.invoke('mail:pick-attachments'),
    downloadAttachment: (opts) => ipcRenderer.invoke('mail:download-attachment', opts || {}),
  },

  // News (RSS/Atom) — main process owns fetching + parsing; renderer
  // reads pre-normalized items from cache and listens for refresh events.
  news: {
    get:          (opts) => ipcRenderer.invoke('news:get', opts || {}),
    refresh:      ()     => ipcRenderer.invoke('news:refresh'),
    getSources:   ()     => ipcRenderer.invoke('news:get-sources'),
    setSources:   (list) => ipcRenderer.invoke('news:set-sources', list),
    getPresets:   ()     => ipcRenderer.invoke('news:get-presets'),
    fetchPreview: (url)  => ipcRenderer.invoke('news:fetch-preview', url),
    getThemes:    ()     => ipcRenderer.invoke('news:get-themes'),
    setThemes:    (list) => ipcRenderer.invoke('news:set-themes', list),
  },

  // OS notifications
  notify:      (title, body) => ipcRenderer.send('send-notification', { title, body }),
  setBadgeCount: (n, png)    => ipcRenderer.invoke('app:set-badge-count', { count: n, png }),

  // Open links in system browser
  openExternal: url => ipcRenderer.send('open-external', url),

  // Default browser
  isDefaultBrowser:  () => ipcRenderer.invoke('is-default-browser'),
  setDefaultBrowser: () => ipcRenderer.invoke('set-default-browser'),

  // Jump List (Windows taskbar right-click menu)
  updateJumpList: () => ipcRenderer.send('update-jump-list'),

  // Content blocker
  blockerGetEnabled: () => ipcRenderer.invoke('blocker-get-enabled'),
  blockerSetEnabled: v => ipcRenderer.invoke('blocker-set-enabled', v),
  blockerGetStats:   () => ipcRenderer.invoke('blocker-get-stats'),
  blockerResetStats: () => ipcRenderer.send('blocker-reset-stats'),

  // Cookie-banner auto-handler — saves the user from clicking "Accept"/"Reject"
  // on every site. Mode is 'off' | 'accept' | 'reject', stored per profile.
  cookieGetMode: ()     => ipcRenderer.invoke('cookies-get-mode'),
  cookieSetMode: (mode) => ipcRenderer.invoke('cookies-set-mode', mode),

  // Per-origin media/clipboard permission prompts.
  // Renderer receives 'permission-prompt' events from main, shows the
  // banner, and responds with the user's choice. Settings panel can
  // also list/revoke stored decisions.
  permissionRespond: (promptId, decision, remember) =>
    ipcRenderer.send('permission-prompt-response', { promptId, decision, remember }),
  permissionsList:   ()                       => ipcRenderer.invoke('permissions-list'),
  permissionsRevoke: (origin, permission)     => ipcRenderer.invoke('permissions-revoke', { origin, permission }),
  permissionsClear:  ()                       => ipcRenderer.invoke('permissions-clear'),

  // Crash reporting. Local logging is always-on; the toggle here only
  // controls whether reports are also POSTed to seoz.io.
  crashStatus:        ()       => ipcRenderer.invoke('crash-reporting-status'),
  crashSetEnabled:    (v)      => ipcRenderer.invoke('crash-reporting-set-enabled', !!v),
  crashList:          ()       => ipcRenderer.invoke('crash-reporting-list'),
  crashClear:         ()       => ipcRenderer.invoke('crash-reporting-clear'),
  crashOpenFolder:    ()       => ipcRenderer.invoke('crash-reporting-open-folder'),
  crashReportRenderer:(payload)=> ipcRenderer.send('crash-report-renderer', payload || {}),

  // Screenshot save dialog
  saveScreenshot: (buffer) => ipcRenderer.invoke('save-screenshot', buffer),

  // Terminal — command execution + interactive shell + history
  terminalExec:          (opts) => ipcRenderer.invoke('terminal-exec', opts),
  terminalSpawn:         ()     => ipcRenderer.invoke('terminal-spawn'),
  terminalWrite:         (data) => ipcRenderer.send('terminal-write', data),
  terminalKill:          ()     => ipcRenderer.send('terminal-kill'),
  terminalHistorySearch: (opts) => ipcRenderer.invoke('terminal-history-search', opts),
  terminalHistoryRecent: (opts) => ipcRenderer.invoke('terminal-history-recent', opts),
  terminalHistoryClear:  ()     => ipcRenderer.invoke('terminal-history-clear'),

  // Tab tear-off (drag a tab out of the window to create a new window)
  tabTearOff: (url, x, y) => ipcRenderer.send('tab-tear-off', { url, x, y }),

  // ── Tab API (WebContentsView-backed) ───────────────────
  //
  // Each tab in the renderer is a thin handle whose actual page
  // lives in a top-level WebContentsView in main. The renderer
  // creates one with `tab.create()`, drives it through the methods
  // below, and listens for events via `tab.onEvent`.
  //
  // The TabHandle class in the renderer wraps these calls to mimic
  // Electron's <webview> element API surface (loadURL/reload/etc),
  // so we don't have to rewrite the hundreds of `wv.foo()` call
  // sites scattered across the renderer.
  tab: {
    create:               (opts)         => ipcRenderer.invoke('tab:create', opts || {}),
    destroy:              (id)           => ipcRenderer.send('tab:destroy', id),
    setBounds:            (id, b, vis)   => ipcRenderer.send('tab:set-bounds', { tabId: id, bounds: b, visible: vis }),
    setVisible:           (id, vis)      => ipcRenderer.send('tab:set-visible', { tabId: id, visible: !!vis }),

    loadURL:              (id, url, opts)=> ipcRenderer.invoke('tab:loadURL', { tabId: id, url, opts: opts || {} }),
    reload:               (id)           => ipcRenderer.send('tab:reload', id),
    reloadIgnoringCache:  (id)           => ipcRenderer.send('tab:reload-ignoring-cache', id),
    stop:                 (id)           => ipcRenderer.send('tab:stop', id),
    goBack:               (id)           => ipcRenderer.send('tab:go-back', id),
    goForward:            (id)           => ipcRenderer.send('tab:go-forward', id),

    getURL:               (id)           => ipcRenderer.invoke('tab:get-url', id),
    getTitle:             (id)           => ipcRenderer.invoke('tab:get-title', id),
    canGoBack:            (id)           => ipcRenderer.invoke('tab:can-go-back', id),
    canGoForward:         (id)           => ipcRenderer.invoke('tab:can-go-forward', id),
    isLoading:            (id)           => ipcRenderer.invoke('tab:is-loading', id),

    executeJavaScript:    (id, code, ug) => ipcRenderer.invoke('tab:execute-js', { tabId: id, code, userGesture: !!ug }),
    capturePage:          (id, rect)     => ipcRenderer.invoke('tab:capture-page', { tabId: id, rect: rect || null }),

    findInPage:           (id, txt, o)   => ipcRenderer.invoke('tab:find-in-page', { tabId: id, text: txt, opts: o || {} }),
    stopFindInPage:       (id, action)   => ipcRenderer.send('tab:stop-find-in-page', { tabId: id, action: action || 'clearSelection' }),

    setZoomFactor:        (id, factor)   => ipcRenderer.send('tab:set-zoom-factor', { tabId: id, factor }),
    getZoomFactor:        (id)           => ipcRenderer.invoke('tab:get-zoom-factor', id),

    openDevTools:         (id)           => ipcRenderer.send('tab:open-devtools', id),
    closeDevTools:        (id)           => ipcRenderer.send('tab:close-devtools', id),

    focus:                (id)           => ipcRenderer.send('tab:focus', id),
    print:                (id)           => ipcRenderer.send('tab:print', id),
    setAudioMuted:        (id, muted)    => ipcRenderer.send('tab:set-audio-muted', { tabId: id, muted: !!muted }),
    setUserAgent:         (id, ua)       => ipcRenderer.send('tab:set-user-agent', { tabId: id, userAgent: ua }),

    // Mirror of <webview>.send(channel, ...args) — pushes an IPC
    // message into the tab's preload (webview-preload.js).
    sendToPreload:        (id, ch, args) => ipcRenderer.send('tab:send-to-preload', { tabId: id, channel: ch, args }),

    // Subscribe to tab events. Returns an unsubscribe function.
    onEvent: (fn) => {
      const handler = (_e, payload) => { try { fn(payload) } catch (_) {} }
      ipcRenderer.on('tab:event', handler)
      return () => ipcRenderer.removeListener('tab:event', handler)
    },
    onNewWindow: (fn) => {
      const handler = (_e, payload) => { try { fn(payload) } catch (_) {} }
      ipcRenderer.on('tab:new-window', handler)
      return () => ipcRenderer.removeListener('tab:new-window', handler)
    },
  },

  // Auto-updater
  updaterCheck:     () => ipcRenderer.send('updater-check'),
  updaterDownload:  () => ipcRenderer.send('updater-download'),
  updaterInstall:   () => ipcRenderer.send('updater-install'),
  updaterGetVersion:() => ipcRenderer.invoke('updater-get-version'),

  // Events from main → renderer
  on:  (ch, fn) => {
    const ok = ['sync-data', 'theme-changed', 'blocker-count', 'updater-status', 'profile-changed', 'open-url', 'navigate-current', 'terminal-data', 'terminal-exit', 'terminal-history-new', 'mail:event', 'mail:list-updated', 'mail:unread-total', 'mail:scheduled-sent', 'webview-fullscreen', 'popup-autofill-request', 'popup-autofill-save', 'permission-prompt', 'news:items-updated', 'chrome-shortcut', 'tab-context-action']
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, ...a) => fn(...a))
  },
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),

  // Platform info
  platform:   process.platform,
  isWindows:  process.platform === 'win32',
  isMac:      process.platform === 'darwin',
})
