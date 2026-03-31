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

  // ElevenLabs TTS
  elevenlabsTTS:    (opts) => ipcRenderer.invoke('elevenlabs-tts', opts),
  elevenlabsVoices: (opts) => ipcRenderer.invoke('elevenlabs-voices', opts),

  // OS notifications
  notify:      (title, body) => ipcRenderer.send('send-notification', { title, body }),

  // Open links in system browser
  openExternal: url => ipcRenderer.send('open-external', url),

  // Content blocker
  blockerGetEnabled: () => ipcRenderer.invoke('blocker-get-enabled'),
  blockerSetEnabled: v => ipcRenderer.invoke('blocker-set-enabled', v),
  blockerGetStats:   () => ipcRenderer.invoke('blocker-get-stats'),
  blockerResetStats: () => ipcRenderer.send('blocker-reset-stats'),

  // Auto-updater
  updaterCheck:     () => ipcRenderer.send('updater-check'),
  updaterDownload:  () => ipcRenderer.send('updater-download'),
  updaterInstall:   () => ipcRenderer.send('updater-install'),
  updaterGetVersion:() => ipcRenderer.invoke('updater-get-version'),

  // Events from main → renderer
  on:  (ch, fn) => {
    const ok = ['sync-data', 'theme-changed', 'blocker-count', 'updater-status', 'profile-changed']
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, ...a) => fn(...a))
  },
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),

  // Platform info
  platform:   process.platform,
  isWindows:  process.platform === 'win32',
  isMac:      process.platform === 'darwin',
})
