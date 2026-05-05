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

  // Auto-updater
  updaterCheck:     () => ipcRenderer.send('updater-check'),
  updaterDownload:  () => ipcRenderer.send('updater-download'),
  updaterInstall:   () => ipcRenderer.send('updater-install'),
  updaterGetVersion:() => ipcRenderer.invoke('updater-get-version'),

  // Events from main → renderer
  on:  (ch, fn) => {
    const ok = ['sync-data', 'theme-changed', 'blocker-count', 'updater-status', 'profile-changed', 'open-url', 'navigate-current', 'terminal-data', 'terminal-exit', 'terminal-history-new', 'mail:event', 'mail:list-updated', 'mail:unread-total', 'mail:scheduled-sent', 'webview-fullscreen', 'popup-autofill-request', 'popup-autofill-save', 'permission-prompt']
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, ...a) => fn(...a))
  },
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),

  // Platform info
  platform:   process.platform,
  isWindows:  process.platform === 'win32',
  isMac:      process.platform === 'darwin',
})
