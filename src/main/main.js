'use strict'

const { app, BrowserWindow, ipcMain, nativeTheme, shell, Notification, nativeImage, net, session, dialog } = require('electron')
const path = require('path')
const https = require('https')
const os = require('os')
const { exec, spawn } = require('child_process')
const Store = require('electron-store')
const { autoUpdater } = require('electron-updater')
const { startMCPServer, stopMCPServer, setWindowGetter, setTerminalExec, setHistorySearch } = require('./mcp-server')
const PM = require('./profile-manager')
const faviconCache = require('./favicon-cache')

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

// Session history database — stores terminal commands + outputs for cross-session search
const historyStore = new Store({
  name: 'session-history',
  defaults: { entries: [] }
})

let win = null
let syncInterval = null
let launchUrl = null // URL passed via command line or protocol activation
let terminalProc = null   // Persistent interactive terminal process

// ══════════════════════════════════════════════════════════════════════════════
//  DEFAULT BROWSER — register as handler for http/https
// ══════════════════════════════════════════════════════════════════════════════
if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
}

// Capture URL from command-line args (e.g. when Windows opens a link with this app)
function extractUrlFromArgs(argv) {
  // The URL is typically the last argument
  const urlArg = argv.find(arg => /^https?:\/\//i.test(arg))
  return urlArg || null
}

// First instance: capture URL from launch args
launchUrl = extractUrlFromArgs(process.argv)

// Single-instance lock — prevents multiple windows, forwards URL to existing instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    // Handle --new-window flag from Jump List
    if (argv.includes('--new-window')) {
      createWindow()
      return
    }
    const url = extractUrlFromArgs(argv)
    if (url && win) {
      win.webContents.send('open-url', url)
    }
    // Focus existing window
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

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

// Chrome User-Agent — used globally so all requests look like real Chrome
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function setupContentBlocker() {
  // Intercept requests in the webview's partition
  // Webviews use the default session unless a partition is set
  const ses = session.defaultSession

  // Override User-Agent at session level (removes "Electron/..." from UA)
  ses.setUserAgent(CHROME_UA)

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

  // Grant permissions for voice chat, clipboard, notifications etc.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write', 'notifications']
    callback(allowed.includes(permission))
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write', 'notifications']
    return allowed.includes(permission)
  })

  // Block Ctrl+Shift+R / F5 from reloading the entire Electron renderer
  // (handled in renderer to only reload the active webview tab)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    if (ctrl && input.shift && input.key.toLowerCase() === 'r') event.preventDefault()
    if (input.shift && input.key === 'F5') event.preventDefault()
  })

  // Intercept any window.open / target="_blank" that escapes webview
  // Navigate in same tab instead of opening a new OS window
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (url && /^https?:\/\//i.test(url)) {
      // Only open as new tab for explicit user actions (Ctrl+click etc)
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        win.webContents.send('open-url', url)
      } else {
        win.webContents.send('navigate-current', url)
      }
    }
    return { action: 'deny' }
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => {
    win.show()
    // If the app was launched with a URL, send it to the renderer
    if (launchUrl) {
      win.webContents.send('open-url', launchUrl)
      launchUrl = null
    }
  })

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

// ── Whisper STT (OpenAI Speech-to-Text) ──
// Uses Node https module because Electron net.fetch doesn't handle multipart Buffer bodies reliably
ipcMain.handle('whisper-stt', async (_, { audioBase64, apiKey, language }) => {
  if (!apiKey) return { error: 'No OpenAI API key configured' }
  if (!audioBase64) return { error: 'No audio data provided' }

  return new Promise((resolve) => {
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64')
      const boundary = '----WhisperBoundary' + Date.now()

      // Build multipart body
      const parts = []
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`))
      parts.push(audioBuffer)
      parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`))
      if (language) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`))
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`))
      const body = Buffer.concat(parts)

      const options = {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        }
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (res.statusCode !== 200) {
              resolve({ error: `Whisper ${res.statusCode}: ${json.error?.message || data}` })
            } else {
              resolve({ ok: true, text: json.text || '' })
            }
          } catch {
            resolve({ error: `Whisper parse error: ${data.slice(0, 200)}` })
          }
        })
      })

      req.on('error', (err) => {
        resolve({ error: 'Whisper network error: ' + err.message })
      })

      req.write(body)
      req.end()
    } catch (err) {
      resolve({ error: err.message || 'Whisper STT failed' })
    }
  })
})

// ── ElevenLabs TTS ──
ipcMain.handle('elevenlabs-tts', async (_, { text, apiKey, voiceId, modelId }) => {
  if (!apiKey) return { error: 'No ElevenLabs API key configured' }
  if (!text) return { error: 'No text provided' }
  try {
    const voice = voiceId || '1Iztu4UHnTb9SUjJcpS1' // Default: Swedish voice
    const res = await net.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId || 'eleven_turbo_v2_5',
        language_code: 'sv',
        voice_settings: { stability: 0.5, similarity_boost: 0.85 },
        optimize_streaming_latency: 4
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

// ── Default browser check ──
ipcMain.handle('is-default-browser', () => {
  if (process.platform !== 'win32') return false
  return app.isDefaultProtocolClient('https')
})
ipcMain.handle('set-default-browser', async () => {
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('http')
    app.setAsDefaultProtocolClient('https')
    // Open Windows default apps settings so user can confirm
    shell.openExternal('ms-settings:defaultapps')
    return true
  }
  return false
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
  const { method = 'GET', params = {}, body } = options
  const url = new URL(API_BASE + endpoint)
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  const fetchOpts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  }
  if (body && method !== 'GET') {
    fetchOpts.body = JSON.stringify(body)
  }
  const res = await net.fetch(url.toString(), fetchOpts)
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

ipcMain.handle('fetch-browser-api', async (_, { endpoint, apiKey, params, method, body }) => {
  return apiFetch(endpoint, apiKey, { params, method, body })
})

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATER — checks GitHub Releases for new versions
// ══════════════════════════════════════════════════════════════════════════════
autoUpdater.autoDownload = true
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

// ── Screenshot save dialog ──
ipcMain.handle('save-screenshot', async (_, buffer) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `skärmbild-${ts}.png`,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false }
  const fs = require('fs')
  fs.writeFileSync(result.filePath, Buffer.from(buffer))
  return { ok: true, path: result.filePath }
})

// ══════════════════════════════════════════════════════════════════════════════
//  TERMINAL — command execution + persistent shell + session history
// ══════════════════════════════════════════════════════════════════════════════

// Execute a single command and return clean output (used by MCP + UI)
ipcMain.handle('terminal-exec', async (_, { command, cwd, source }) => {
  const workDir = cwd || os.homedir()
  // Use cmd.exe on Windows — PowerShell ignores cwd and doesn't support &&
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'

  return new Promise((resolve) => {
    const startTime = Date.now()
    exec(command, {
      cwd: workDir,
      shell,
      maxBuffer: 1024 * 1024 * 10, // 10 MB
      timeout: 120000, // 2 min
      env: { ...process.env, TERM: 'dumb' },
    }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        command,
        cwd: workDir,
        stdout: (stdout || '').toString().slice(0, 50000),  // cap at 50 KB
        stderr: (stderr || '').toString().slice(0, 10000),
        exitCode: error ? (error.code ?? 1) : 0,
        duration,
        source: source || 'terminal',
      }
      _saveHistoryEntry(entry)
      // Notify renderer about new history entry
      win?.webContents.send('terminal-history-new', entry)
      resolve({
        ok: !error,
        stdout: entry.stdout,
        stderr: entry.stderr,
        exitCode: entry.exitCode,
        duration,
      })
    })
  })
})

// Spawn persistent interactive terminal (cmd / bash)
ipcMain.handle('terminal-spawn', () => {
  if (terminalProc) return { ok: true, msg: 'Already running' }
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
  const args = process.platform === 'win32' ? ['/Q'] : ['--norc']
  terminalProc = spawn(shell, args, {
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  terminalProc.stdout.on('data', d => win?.webContents.send('terminal-data', d.toString()))
  terminalProc.stderr.on('data', d => win?.webContents.send('terminal-data', d.toString()))
  terminalProc.on('exit', (code) => {
    terminalProc = null
    win?.webContents.send('terminal-exit', code)
  })
  return { ok: true }
})
ipcMain.on('terminal-write', (_, data) => {
  if (terminalProc && terminalProc.stdin.writable) terminalProc.stdin.write(data)
})
ipcMain.on('terminal-kill', () => {
  if (terminalProc) { terminalProc.kill(); terminalProc = null }
})

// ── Session history database ──
function _saveHistoryEntry(entry) {
  const entries = historyStore.get('entries', [])
  entries.push(entry)
  // Keep max 5000 entries — trim oldest
  if (entries.length > 5000) entries.splice(0, entries.length - 5000)
  historyStore.set('entries', entries)
}

function _searchHistory(query, limit) {
  const entries = historyStore.get('entries', [])
  if (!query) return entries.slice(-limit)
  const q = query.toLowerCase()
  return entries
    .filter(e =>
      e.command.toLowerCase().includes(q) ||
      e.stdout.toLowerCase().includes(q) ||
      e.stderr.toLowerCase().includes(q) ||
      (e.cwd && e.cwd.toLowerCase().includes(q))
    )
    .slice(-limit)
}

ipcMain.handle('terminal-history-search', (_, { query, limit }) => {
  return _searchHistory(query, limit || 50)
})
ipcMain.handle('terminal-history-recent', (_, { limit }) => {
  const entries = historyStore.get('entries', [])
  return entries.slice(-(limit || 20))
})
ipcMain.handle('terminal-history-clear', () => {
  historyStore.set('entries', [])
  return { ok: true }
})
// Expose for MCP server (direct access, no IPC round-trip)
function terminalExecDirect(command, cwd, source) {
  const workDir = cwd || os.homedir()
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
  return new Promise((resolve) => {
    const startTime = Date.now()
    exec(command, {
      cwd: workDir,
      shell,
      maxBuffer: 1024 * 1024 * 10,
      timeout: 120000,
      env: { ...process.env, TERM: 'dumb' },
    }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        command,
        cwd: workDir,
        stdout: (stdout || '').toString().slice(0, 50000),
        stderr: (stderr || '').toString().slice(0, 10000),
        exitCode: error ? (error.code ?? 1) : 0,
        duration,
        source: source || 'mcp',
      }
      _saveHistoryEntry(entry)
      win?.webContents.send('terminal-history-new', entry)
      resolve(entry)
    })
  })
}

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

// ══════════════════════════════════════════════════════════════════════════════
//  WINDOWS JUMP LIST — right-click menu on taskbar (Chrome-style)
// ══════════════════════════════════════════════════════════════════════════════
let jumpListTimer = null

async function updateJumpList() {
  if (process.platform !== 'win32') return

  const exePath = process.execPath

  // Parse history once
  let history = []
  try {
    const raw = PM.profileGet('browsingHistory', '[]')
    history = typeof raw === 'string' ? JSON.parse(raw) : (raw || [])
  } catch (_) {}

  // ── Most-visited (top 5 by domain frequency) ──
  const counts = {}
  for (const h of history) {
    try {
      const host = new URL(h.url).hostname
      if (!counts[host]) counts[host] = { title: h.title || host, url: h.url, host, count: 0 }
      counts[host].count++
    } catch (_) {}
  }
  const topSites = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 5)

  // ── Recently visited (last 5 unique URLs) ──
  const recentSites = []
  const seen = new Set()
  for (const h of history) {
    if (seen.has(h.url)) continue
    seen.add(h.url)
    let host = ''
    try { host = new URL(h.url).hostname } catch (_) {}
    recentSites.push({ title: h.title || h.url, url: h.url, host })
    if (recentSites.length >= 5) break
  }

  // ── Download favicons for all unique hostnames ──
  const allHosts = [...new Set([...topSites.map(s => s.host), ...recentSites.map(s => s.host)].filter(Boolean))]
  const iconMap = await faviconCache.ensureMany(allHosts)

  // ── Helper: build a Jump List item with favicon ──
  function makeItem(title, url, host) {
    const item = {
      type: 'task',
      title: title.length > 50 ? title.slice(0, 47) + '...' : title,
      program: exePath,
      args: url,
      description: url,
    }
    const iconPath = iconMap.get(host)
    if (iconPath) {
      item.iconPath = iconPath
      item.iconIndex = 0
    }
    return item
  }

  const categories = []

  // "Aktiviteter" — always present
  categories.push({
    type: 'tasks',
    items: [
      {
        type: 'task',
        title: 'Nytt fönster',
        program: exePath,
        args: '--new-window',
        description: 'Öppna ett nytt SEOZ Browser-fönster',
        iconPath: exePath,
        iconIndex: 0,
      },
    ]
  })

  // "Mest besökta"
  if (topSites.length) {
    categories.push({
      type: 'custom',
      name: 'Mest besökta',
      items: topSites.map(s => makeItem(s.title, s.url, s.host)),
    })
  }

  // "Senast besökta"
  if (recentSites.length) {
    categories.push({
      type: 'custom',
      name: 'Senast besökta',
      items: recentSites.map(s => makeItem(s.title, s.url, s.host)),
    })
  }

  try {
    app.setJumpList(categories)
  } catch (e) {
    // Jump List errors are non-fatal
  }
}

// IPC: renderer tells main to refresh Jump List after navigation
// Debounced — don't spam downloads on rapid navigations
ipcMain.on('update-jump-list', () => {
  if (jumpListTimer) clearTimeout(jumpListTimer)
  jumpListTimer = setTimeout(() => updateJumpList(), 2000)
})

// ── Lifecycle ──
app.whenReady().then(() => {
  // Force web content to always see light mode — prevents OS dark mode from affecting websites
  nativeTheme.themeSource = 'light'

  // Migrate legacy single-user data to first profile (runs once)
  PM.migrateLegacyData(store)

  // Initialise favicon cache for Jump List icons
  faviconCache.init(app.getPath('userData'))

  setupContentBlocker()
  createWindow()
  startSync()
  updateJumpList()
  // MCP server — lets Claude control the browser + terminal
  setWindowGetter(() => win)
  setTerminalExec(terminalExecDirect)
  setHistorySearch(_searchHistory)
  startMCPServer()
  // Check for updates 3s after launch (silent)
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 3000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { stopSync(); stopMCPServer() })
