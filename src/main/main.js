'use strict'

const { app, BrowserWindow, ipcMain, nativeTheme, shell, Notification, nativeImage, net, session } = require('electron')
const path = require('path')
const Store = require('electron-store')
const { autoUpdater } = require('electron-updater')

// App icon (monkey emoji) — resolved once at startup
const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../../assets/icon.ico')
)

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

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!blockerEnabled) { callback({}); return }

    try {
      const url = new URL(details.url)
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

// ── Theme ──
ipcMain.handle('get-theme', () => store.get('theme', 'dark'))
ipcMain.on('set-theme', (e, t) => store.set('theme', t))

// ── Store (generic get/set) ──
ipcMain.handle('store-get', (_, k, d) => store.get(k, d))
ipcMain.handle('store-set', (_, k, v) => { store.set(k, v); return true })

// ── API key ──
ipcMain.handle('get-api-key', () => store.get('apiKey'))
ipcMain.handle('set-api-key', (e, k) => { store.set('apiKey', k); return true })
ipcMain.handle('del-api-key', () => { store.delete('apiKey'); return true })

// ── Open external links ──
ipcMain.on('open-external', (e, url) => shell.openExternal(url))

// ── OS notifications ──
ipcMain.on('send-notification', (_, { title, body }) => {
  if (store.get('osNotifs', true) && Notification.isSupported())
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

// ── Auto-sync every 30 s ──
function startSync() {
  stopSync()
  if (!store.get('autoSync', true)) return
  syncInterval = setInterval(async () => {
    const key = store.get('apiKey', '')
    if (!key) return
    const r = await doAPISync(key)
    if (r.ok) win?.webContents.send('sync-data', r)
  }, 30000)
}
function stopSync() { if (syncInterval) { clearInterval(syncInterval); syncInterval = null } }

// ── Lifecycle ──
app.whenReady().then(() => {
  setupContentBlocker()
  createWindow()
  startSync()
  // Check for updates 3s after launch (silent)
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 3000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => stopSync())
