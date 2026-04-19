'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seoz', {
  // Window controls
  minimize:    () => ipcRenderer.send('win-min'),
  maximize:    () => ipcRenderer.send('win-max'),
  close:       () => ipcRenderer.send('win-close'),
  fullscreen:  () => ipcRenderer.send('win-fullscreen'),
  isFullscreen:() => ipcRenderer.invoke('win-is-fullscreen'),

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
    list:       (opts)     => ipcRenderer.invoke('mail:list', opts || {}),
    get:        (opts)     => ipcRenderer.invoke('mail:get', opts || {}),
    flag:       (opts)     => ipcRenderer.invoke('mail:flag', opts || {}),
    send:       (opts)     => ipcRenderer.invoke('mail:send', opts || {}),
  },

  // OS notifications
  notify:      (title, body) => ipcRenderer.send('send-notification', { title, body }),

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
    const ok = ['sync-data', 'theme-changed', 'blocker-count', 'updater-status', 'profile-changed', 'open-url', 'navigate-current', 'terminal-data', 'terminal-exit', 'terminal-history-new']
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, ...a) => fn(...a))
  },
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),

  // Platform info
  platform:   process.platform,
  isWindows:  process.platform === 'win32',
  isMac:      process.platform === 'darwin',
})
