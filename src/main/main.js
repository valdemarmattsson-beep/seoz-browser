'use strict'

const { app, BrowserWindow, ipcMain, nativeTheme, shell, Notification, nativeImage, net, session } = require('electron')
const path = require('path')
const Store = require('electron-store')
const { autoUpdater } = require('electron-updater')
const { startMCPServer, stopMCPServer, setWindowGetter } = require('./mcp-server')
const PM = require('./profile-manager')

// App icon (monkey emoji) — resolved once at startup
const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../../assets/icon.ico')
)

// Legacy store — kept for migration & window bounds (shared across profiles)
const store = new Store({
  defaults: {
    theme: 'dark',
    bounds: { width: 1400, height: 860 },
    apiKey: null,
    autoSync: true,
    osNotifs: true,
  }
})

let win = null
let syncInterval = null

// ══════════════════════════════════════════════════════════════════════════════
//  CONTENT BLOCKER — blocks ads, trackers, heavy junk
// ══════════════════════════════════════════════════════════════════════════════
const BLOCK_DOMAINS = [
  // Ad networks
  'doubleclick.net','googlesyndication.com','googleadservices.com','google-analytics.com',
  'googletagmanager.com','adservice.google.com','pagead2.googlesyndication.com',
  'adnxs.com','adsrvr.org','adform.net','advertising.com','ads-twitter.com',
  'amazon-adsystem.com','ad.doubleclick.net','cm.g.doubleclick.net',
  'securepubads.g.doubleclick.net','pubads.g.doubleclick.net',
  'tpc.googlesyndication.com','adtech.de',

  // Swedish / Nordic ad networks
  'adsrvr.org','adnami.io','readpeak.com','strossle.com','dable.io',
  'content-ad.net','mgid.com','outbrain.com','taboola.com','zemanta.com',
  'plista.com','ligatus.com','smartadserver.com','improveheroes.com',

  // Trackers
  'facebook.net','connect.facebook.net','pixel.facebook.com',
  'analytics.tiktok.com','bat.bing.com','snap.licdn.com','linkedin.com/li/',
  'hotjar.com','hotjar.io','mouseflow.com','crazyegg.com','fullstory.com',
  'clarity.ms','clickcease.com','luckyorange.com','inspectlet.com',

  // Heavy media / video ad
  'imasdk.googleapis.com','s0.2mdn.net','pagead2.googlesyndication.com',
  'vid.springserve.com','jwpltx.com',

  // Consent / cookie walls (optional — makes pages load faster)
  'consentmanager.net','cookiebot.com','cookieinformation.com',
  'quantcast.com','quantserve.com','onetrust.com',

  // Misc trackers
  'scorecardresearch.com','imrworldwide.com','chartbeat.com','chartbeat.net',
  'newrelic.com','nr-data.net','segment.io','segment.com','mixpanel.com',
  'amplitude.com','heapanalytics.com','rudderstack.com',
  'sentry.io','bugsnag.com',
  'branch.io','adjust.com','appsflyer.com','kochava.com',
  'criteo.com','criteo.net','casalemedia.com','bluekai.com','exelator.com',
  'demdex.net','omtrdc.net','everesttech.net',
]

// Build a fast lookup Set of domains
const blockedSet = new Set(BLOCK_DOMAINS)
let blockerEnabled = true
let blockerStats = { blocked: 0, session: 0 }

function isDomainBlocked(hostname) {
  if (!hostname) return false
  // Check exact match
  if (blockedSet.has(hostname)) return true
  // Check if subdomain of a blocked domain (e.g. ads.example.com → example.com)
  const parts = hostname.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    if (blockedSet.has(parts.slice(i).join('.'))) return true
  }
  return false
}

function setupContentBlocker() {
  // Intercept requests in the webview's partition
  // Webviews use the default session unless a partition is set
  const ses = session.defaultSession

  // Never block these domains
  const whitelist = ['seoz.se', 'flow.seoz.se', 'api.seoz.se']
  const isWhitelisted = host => whitelist.some(w => host === w || host.endsWith('.' + w))

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!blockerEnabled) { callback({}); return }

    try {
      const url = new URL(details.url)
      if (isWhitelisted(url.hostname)) { callback({}); return }
      if (isDomainBlocked(url.hostname)) {
        blockerStats.blocked++
        blockerStats.session++
        // Notify renderer about updated count
        if (win) win.webContents.send('blocker-count', blockerStats.session)
        callback({ cancel: true })
        return
      }
    } catch (_) {}
    callback({})
  })
}

function createWindow() {
  const { width, height } = store.get('bounds')

  win = new BrowserWindow({
    width, height,
    minWidth: 800, minHeight: 500,
    backgroundColor: '#131920',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
    show: false,
    icon: APP_ICON,
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => win.show())

  win.on('resize', () => {
    if (!win.isMaximized()) store.set('bounds', win.getBounds())
  })
  win.on('closed', () => { win = null; stopSync() })

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

// ── Window controls ──
ipcMain.on('win-min',   () => win?.minimize())
ipcMain.on('win-max',   () => win?.isMaximized() ? win.unmaximize() : win?.maximize())
ipcMain.on('win-close', () => win?.close())
ipcMain.on('win-fullscreen', () => win?.setFullScreen(!win.isFullScreen()))
ipcMain.handle('win-is-fullscreen', () => win?.isFullScreen() ?? false)

// ── DevTools ──
ipcMain.on('toggle-devtools', () => win?.webContents.toggleDevTools())

// ── Content blocker ──
ipcMain.handle('blocker-get-enabled', () => blockerEnabled)
ipcMain.handle('blocker-set-enabled', (_, v) => { blockerEnabled = !!v; return blockerEnabled })
ipcMain.handle('blocker-get-stats', () => blockerStats)
ipcMain.on('blocker-reset-stats', () => { blockerStats.session = 0 })

// ── Theme (profile-scoped) ──
ipcMain.handle('get-theme', () => PM.profileGet('theme', 'dark'))
ipcMain.on('set-theme', (e, t) => PM.profileSet('theme', t))

// ── Store (profile-scoped get/set) ──
ipcMain.handle('store-get', (_, k, d) => PM.profileGet(k, d))
ipcMain.handle('store-set', (_, k, v) => { PM.profileSet(k, v); return true })

// ── API key (profile-scoped) ──
ipcMain.handle('get-api-key', () => PM.profileGet('apiKey'))
ipcMain.handle('set-api-key', (e, k) => { PM.profileSet('apiKey', k); return true })
ipcMain.handle('del-api-key', () => { PM.profileDelete('apiKey'); return true })

// ══════════════════════════════════════════════════════════════════════════════
//  PROFILE MANAGEMENT — Chrome-like user profiles
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('profile-list', () => PM.listProfiles())
ipcMain.handle('profile-get-active', () => ({
  profile: PM.getActiveProfile(),
  id: PM.getActiveProfileId(),
}))
ipcMain.handle('profile-create', (_, { name, email }) => PM.createProfile({ name, email }))
ipcMain.handle('profile-update', (_, { id, updates }) => PM.updateProfile(id, updates))
ipcMain.handle('profile-delete', (_, id) => PM.deleteProfile(id))
ipcMain.handle('profile-switch', (_, id) => {
  const profile = PM.switchProfile(id)
  if (!profile) return { ok: false }
  // Restart sync with the new profile's API key
  stopSync()
  startSync()
  return { ok: true, profile }
})

// ── Claude AI (Anthropic API) ──
ipcMain.handle('claude-chat', async (_, { messages, systemPrompt, apiKey }) => {
  if (!apiKey) return { error: 'No Anthropic API key configured' }
  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful SEO assistant integrated in the SEOZ Browser. Respond in Swedish unless the user writes in another language. Be concise and actionable.',
      messages
    })
    const res = await net.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => 'Unknown error')
      return { error: `API error ${res.status}: ${txt}` }
    }
    const data = await res.json()
    return { ok: true, content: data.content?.[0]?.text || '', usage: data.usage }
  } catch (err) {
    return { error: err.message || 'Claude API call failed' }
  }
})

// ── OpenAI Chat (configurable model) ──
ipcMain.handle('openai-chat', async (_, { messages, systemPrompt, apiKey, model }) => {
  if (!apiKey) return { error: 'No OpenAI API key configured' }
  try {
    const body = JSON.stringify({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt || 'You are a helpful SEO assistant. Respond in Swedish unless the user writes in another language.' }, ...messages],
      max_tokens: 4096,
    })
    const res = await net.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => 'Unknown error')
      return { error: `API error ${res.status}: ${txt}` }
    }
    const data = await res.json()
    return { ok: true, content: data.choices?.[0]?.message?.content || '', usage: data.usage }
  } catch (err) {
    return { error: err.message || 'OpenAI API call failed' }
  }
})

// ── ElevenLabs TTS ──
ipcMain.handle('elevenlabs-tts', async (_, { text, apiKey, voiceId, modelId }) => {
  if (!apiKey) return { error: 'No ElevenLabs API key configured' }
  if (!text) return { error: 'No text provided' }
  try {
    const voice = voiceId || 'EXAVITQu4vr4xnSDxMaL' // Default: "Sarah"
    const res = await net.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId || 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => 'Unknown error')
      return { error: `ElevenLabs error ${res.status}: ${txt}` }
    }
    const buf = await res.arrayBuffer()
    return { ok: true, audio: Buffer.from(buf).toString('base64') }
  } catch (err) {
    return { error: err.message || 'ElevenLabs API call failed' }
  }
})

// ── ElevenLabs: List voices ──
ipcMain.handle('elevenlabs-voices', async (_, { apiKey }) => {
  if (!apiKey) return { error: 'No ElevenLabs API key configured' }
  try {
    const res = await net.fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey }
    })
    if (!res.ok) return { error: `Error ${res.status}` }
    const data = await res.json()
    return { ok: true, voices: (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category })) }
  } catch (err) {
    return { error: err.message }
  }
})

// ── Open external links ──
ipcMain.on('open-external', (e, url) => shell.openExternal(url))

// ── OS notifications (profile-scoped) ──
ipcMain.on('send-notification', (_, { title, body }) => {
  if (PM.profileGet('osNotifs', true) && Notification.isSupported())
    new Notification({ title, body }).show()
})

// ══════════════════════════════════════════════════════════════════════════════
//  SEOZ API SYNC — connects to real backend at seoz.se
// ══════════════════════════════════════════════════════════════════════════════
const API_BASE = 'https://seoz.se/api/browser'

async function apiFetch(endpoint, apiKey, options = {}) {
  const { method = 'GET', params = {} } = options
  const url = new URL(API_BASE + endpoint)
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  const res = await net.fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    return { ok: false, error: text, status: res.status }
  }
  return res.json()
}

async function doAPISync(apiKey) {
  if (!apiKey) return { ok: false, error: 'No API key' }
  try {
    const auth = await apiFetch('/auth', apiKey, { method: 'POST' })
    if (!auth.ok) return { ok: false, error: auth.error || 'Invalid API key' }

    const clientsRes = await apiFetch('/clients', apiKey)
    const clients = clientsRes.ok !== false ? (clientsRes.clients || []) : []

    return {
      ok: true,
      user: auth.user,
      workspace: auth.workspace,
      clients,
      timestamp: new Date().toISOString(),
    }
  } catch (err) {
    return { ok: false, error: err.message || 'Sync failed' }
  }
}

ipcMain.handle('trigger-sync', async (_, apiKey) => doAPISync(apiKey))

ipcMain.handle('fetch-browser-api', async (_, { endpoint, apiKey, params }) => {
  return apiFetch(endpoint, apiKey, { params })
})

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATER — checks GitHub Releases for new versions
// ══════════════════════════════════════════════════════════════════════════════
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('checking-for-update', () => {
  win?.webContents.send('updater-status', { status: 'checking' })
})
autoUpdater.on('update-available', info => {
  win?.webContents.send('updater-status', { status: 'available', version: info.version, releaseNotes: info.releaseNotes })
})
autoUpdater.on('update-not-available', () => {
  win?.webContents.send('updater-status', { status: 'up-to-date' })
})
autoUpdater.on('download-progress', progress => {
  win?.webContents.send('updater-status', { status: 'downloading', percent: Math.round(progress.percent) })
})
autoUpdater.on('update-downloaded', info => {
  win?.webContents.send('updater-status', { status: 'ready', version: info.version })
})
autoUpdater.on('error', err => {
  win?.webContents.send('updater-status', { status: 'error', error: err?.message || 'Unknown error' })
})

ipcMain.on('updater-check', () => {
  autoUpdater.checkForUpdates().catch(() => {})
})
ipcMain.on('updater-download', () => {
  autoUpdater.downloadUpdate().catch(() => {})
})
ipcMain.on('updater-install', () => {
  autoUpdater.quitAndInstall(false, true)
})
ipcMain.handle('updater-get-version', () => app.getVersion())

// ── Auto-sync every 30 s (profile-scoped) ──
function startSync() {
  stopSync()
  if (!PM.profileGet('autoSync', true)) return
  syncInterval = setInterval(async () => {
    const key = PM.profileGet('apiKey', '')
    if (!key) return
    const r = await doAPISync(key)
    if (r.ok) win?.webContents.send('sync-data', r)
  }, 30000)
}
function stopSync() { if (syncInterval) { clearInterval(syncInterval); syncInterval = null } }

// ── Lifecycle ──
app.whenReady().then(() => {
  // Migrate legacy single-user data to first profile (runs once)
  PM.migrateLegacyData(store)

  setupContentBlocker()
  createWindow()
  startSync()
  // MCP server — lets Claude control the browser
  setWindowGetter(() => win)
  startMCPServer()
  // Check for updates 3s after launch (silent)
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 3000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { stopSync(); stopMCPServer() })
