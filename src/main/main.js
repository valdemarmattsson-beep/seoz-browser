'use strict'

const { app, BrowserWindow, ipcMain, nativeTheme, shell, Notification, nativeImage, net, session, dialog, safeStorage, screen, Menu, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const os = require('os')
const { exec, spawn } = require('child_process')
const Store = require('electron-store')
const { autoUpdater } = require('electron-updater')
const { startMCPServer, stopMCPServer, setWindowGetter, setTerminalExec, setHistorySearch } = require('./mcp-server')
const mail = require('./mail')
const mailCache = require('./mail-cache')
const mailScheduler = require('./mail-scheduler')
const mailClassifier = require('./mail-classifier')
// news är en optional module — om filen saknas i build:en (t.ex. en
// utvecklare har den lokalt men har inte committat in den till git
// så CI inte ser den), faller vi tillbaka på en no-op stub så main
// inte kraschar tyst. UI visar då bara en tom news-rail. Felmeddelandet
// loggas så vi vet att något fattas.
let news
try {
  news = require('./news')
} catch (err) {
  console.warn('[seoz] news module unavailable, using stub:', err?.message || err)
  const _noopEvents = { on: () => {}, off: () => {}, emit: () => {}, removeListener: () => {} }
  news = {
    setActiveProfile: () => {},
    startScheduler:   () => {},
    getItems:         () => [],
    refreshAll:       async () => ({ ok: false, error: 'news module not built' }),
    getSources:       () => [],
    setSources:       () => [],
    PRESETS:          [],
    fetchPreview:     async () => ({ ok: false, error: 'news module not built' }),
    getThemes:        () => [],
    setThemes:        () => [],
    events:           _noopEvents,
  }
}
const PM = require('./profile-manager')
const crypto = require('crypto')
const faviconCache = require('./favicon-cache')

// Cap stdout/stderr so we don't blow the JSON-RPC payload, but make it
// visible to Claude when output was actually truncated (silently dropped
// bytes lead to confusing "empty" tool results).
const STDOUT_CAP = 50_000
const STDERR_CAP = 10_000
function _cap(raw, limit) {
  const s = (raw || '').toString()
  if (s.length <= limit) return s
  const dropped = s.length - limit
  const kb = (dropped / 1024).toFixed(1)
  return s.slice(0, limit) + `\n\n[...truncated, ${dropped.toLocaleString()} bytes (${kb} KB) dropped — pipe to a file if full output is needed]`
}
// Convert child_process.exec error codes to a Claude-friendly reason string
function _explainExecError(error) {
  if (!error) return null
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'maxBuffer exceeded (output > 10 MB)'
  if (error.killed && error.signal === 'SIGTERM') return 'killed by timeout (2 min limit)'
  return null
}

// App icon (monkey emoji) — resolved once at startup
const APP_ICON = nativeImage.createFromPath(
  path.join(__dirname, '../../assets/icon.ico')
)

// Legacy store — kept for migration & window bounds (shared across profiles)
const store = new Store({
  defaults: {
    theme: 'light',
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

// Tidig diagnostik — fånga main-process-fel som annars skulle få
// appen att terminera tyst utan att fönster visas. Skriver till
// crash-reports/ + console.error så användaren kan rapportera.
process.on('uncaughtException', (err) => {
  try {
    const fp = path.join(app.getPath('userData'), 'startup.log')
    fs.appendFileSync(fp, new Date().toISOString() + ' UNCAUGHT: ' + (err?.stack || err?.message || err) + '\n')
  } catch (_) {}
  console.error('[seoz] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  try {
    const fp = path.join(app.getPath('userData'), 'startup.log')
    fs.appendFileSync(fp, new Date().toISOString() + ' UNHANDLED-REJECTION: ' + (reason?.stack || reason?.message || reason) + '\n')
  } catch (_) {}
  console.error('[seoz] unhandledRejection:', reason)
})

// ══════════════════════════════════════════════════════════════════════════════
//  PERMISSION POLICY — three-tier model
// ══════════════════════════════════════════════════════════════════════════════
//
//   ALLOW_GLOBAL         Granted on every origin without prompt. Low-risk
//                        capabilities Chrome also lets sites use freely.
//
//   PROMPTABLE           Sensitive capabilities (cam/mic/screen/clipboard-read).
//                        Three-step decision:
//                          1. If in TRUSTED_HOSTS → grant silently
//                          2. If user has stored a decision for this origin
//                             → use stored value
//                          3. Otherwise → ask the user via a Chrome-style
//                             banner; remember the answer if "Kom ihåg" is
//                             checked.
//
//   (everything else)    Denied. geolocation, midi, USB, hid, serial,
//                        bluetooth, webauthn, … Sites can still try, but
//                        the API throws.
//
// Older releases (≤ v1.10.29) granted PROMPTABLE everywhere without
// asking. v1.10.30 hard-denied outside TRUSTED_HOSTS, which broke
// cam/mic on third-party meeting tools the user actually wanted to
// use. v1.10.32 (this) ships the proper Chrome-style prompt.
const ALLOW_GLOBAL = new Set([
  'clipboard-write',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',          // element.requestFullscreen() — used by SEOZ portal
  'pointerLock',         // canvas/game pointer capture
])
const PROMPTABLE = new Set([
  'media',               // camera + mic combined (Chrome's getUserMedia)
  'microphone',
  'audioCapture',
  'display-capture',     // getDisplayMedia (screen share)
  'clipboard-read',      // privacy-sensitive: can read OTHER apps' clipboard
])
// Common voice/video conferencing that auto-grants without prompting,
// purely for UX. Keeps cam/mic working "out of the box" on tools users
// trust by virtue of having logged in. Subdomains match.
const TRUSTED_HOSTS = [
  'seoz.io', 'seoz.se',
  'meet.google.com', 'meet.jit.si',
  'zoom.us', 'zoom.com',
  'teams.microsoft.com', 'teams.live.com',
  'whereby.com', 'daily.co',
  'webex.com', 'gotomeeting.com',
  'discord.com', 'discordapp.com',
  'slack.com',
  'localhost',
]
function _hostIsTrusted(url) {
  try {
    const u = new URL(url || '')
    const h = (u.hostname || '').toLowerCase()
    if (!h) return false
    return TRUSTED_HOSTS.some(d => h === d || h.endsWith('.' + d))
  } catch (_) { return false }
}

// User-friendly label shown in the prompt banner per permission key.
const PERM_LABELS = {
  media:             'använda din kamera och mikrofon',
  microphone:        'använda din mikrofon',
  audioCapture:      'använda din mikrofon',
  'display-capture': 'spela in eller dela din skärm',
  'clipboard-read':  'läsa innehållet i ditt urklipp',
}

// Per-profile store of saved decisions:
//   { [origin]: { [permission]: 'granted' | 'denied' } }
const PERM_STORE_KEY = 'sitePermissions'
function _permStoreRead() { return PM.profileGet(PERM_STORE_KEY, {}) || {} }
function _permStoreWrite(s) { PM.profileSet(PERM_STORE_KEY, s) }
function _permStoredDecision(origin, permission) {
  if (!origin) return null
  const cur = _permStoreRead()
  return cur?.[origin]?.[permission] || null
}
function _permStoreSet(origin, permission, decision) {
  if (!origin) return
  const cur = _permStoreRead()
  cur[origin] = { ...(cur[origin] || {}), [permission]: decision }
  _permStoreWrite(cur)
}

// In-flight prompts. promptId → { callback, timeout }. The callback is
// the Electron permission callback; we call it exactly once. If the
// renderer never responds (e.g. user closes the prompt-bearing window
// before clicking) we auto-deny after PROMPT_TIMEOUT_MS.
const PROMPT_TIMEOUT_MS = 30_000
const _pendingPerms = new Map()

// Coalesce duplicate requests so two concurrent getUserMedia calls
// from the same origin/permission share one prompt.
//   key = `${origin}|${permission}`
const _pendingPermKeys = new Map()  // key → Set<callback>

function _originFromUrl(url) {
  try { return new URL(url).origin } catch (_) { return null }
}

function _checkPermissionSync(permission, requestingOriginRaw) {
  if (ALLOW_GLOBAL.has(permission)) return true
  if (!PROMPTABLE.has(permission)) return false
  // setPermissionCheckHandler can pass requestingOrigin separately
  // (newer Electron). Use it directly when available — otherwise fall
  // back to false (no async prompt available in the sync check path).
  const origin = (() => {
    try { return new URL(requestingOriginRaw || '').origin } catch (_) { return null }
  })()
  if (!origin) return false
  if (_hostIsTrusted(requestingOriginRaw)) return true
  return _permStoredDecision(origin, permission) === 'granted'
}

function _resolvePermPrompt(promptId, decision, remember) {
  const entry = _pendingPerms.get(promptId)
  if (!entry) return
  clearTimeout(entry.timeout)
  _pendingPerms.delete(promptId)
  // Resolve every coalesced caller for the same key with the same answer.
  const waiters = _pendingPermKeys.get(entry.coalesceKey) || new Set()
  for (const cb of waiters) {
    try { cb(decision) } catch (_) {}
  }
  _pendingPermKeys.delete(entry.coalesceKey)
  if (remember) {
    _permStoreSet(entry.origin, entry.permission, decision ? 'granted' : 'denied')
  }
}

function _handlePermissionRequest(webContents, permission, callback) {
  // 1. Always-on permissions
  if (ALLOW_GLOBAL.has(permission)) { callback(true); return }
  // 2. Outside the promptable set → deny outright
  if (!PROMPTABLE.has(permission)) { callback(false); return }

  // 3. Resolve the requesting origin
  const url = (() => {
    try { return webContents?.getURL?.() || '' } catch (_) { return '' }
  })()
  const origin = _originFromUrl(url)
  if (!origin) { callback(false); return }

  // 4. Hardcoded allow-list (Zoom, Meet, seoz.io, …) → grant silently
  if (_hostIsTrusted(url)) { callback(true); return }

  // 5. User-saved decision → honour it
  const stored = _permStoredDecision(origin, permission)
  if (stored === 'granted') { callback(true); return }
  if (stored === 'denied')  { callback(false); return }

  // 6. Prompt the user. Coalesce parallel requests for the same
  //    origin+permission so we only ever show one banner.
  const coalesceKey = `${origin}|${permission}`
  if (_pendingPermKeys.has(coalesceKey)) {
    _pendingPermKeys.get(coalesceKey).add(callback)
    return
  }
  const waiters = new Set([callback])
  _pendingPermKeys.set(coalesceKey, waiters)

  const promptId = crypto.randomBytes(8).toString('hex')
  const timeout = setTimeout(() => {
    // Auto-deny on timeout. Do NOT remember the choice — user just
    // didn't see the banner. They'll be asked again next time.
    _resolvePermPrompt(promptId, false, false)
  }, PROMPT_TIMEOUT_MS)
  _pendingPerms.set(promptId, { callback, timeout, origin, permission, coalesceKey })

  if (win && !win.isDestroyed()) {
    win.webContents.send('permission-prompt', {
      promptId,
      origin,
      permission,
      label: PERM_LABELS[permission] || permission,
    })
  } else {
    // No window to host the prompt — auto-deny.
    _resolvePermPrompt(promptId, false, false)
  }
}

// IPC: renderer responds to the prompt
ipcMain.on('permission-prompt-response', (_e, { promptId, decision, remember } = {}) => {
  if (!promptId) return
  _resolvePermPrompt(promptId, !!decision, !!remember)
})

// IPC: settings UI — list stored decisions and revoke individual ones
ipcMain.handle('permissions-list', () => {
  const store = _permStoreRead()
  const rows = []
  for (const [origin, perms] of Object.entries(store)) {
    for (const [permission, decision] of Object.entries(perms || {})) {
      rows.push({ origin, permission, decision })
    }
  }
  return rows
})
ipcMain.handle('permissions-revoke', (_e, { origin, permission } = {}) => {
  if (!origin) return { ok: false, error: 'origin krävs' }
  const cur = _permStoreRead()
  if (!cur[origin]) return { ok: true }
  if (permission) {
    delete cur[origin][permission]
    if (!Object.keys(cur[origin]).length) delete cur[origin]
  } else {
    delete cur[origin]
  }
  _permStoreWrite(cur)
  return { ok: true }
})
ipcMain.handle('permissions-clear', () => {
  _permStoreWrite({})
  return { ok: true }
})

// ══════════════════════════════════════════════════════════════════════════════
//  CRASH REPORTING — local-first, opt-in upload
// ══════════════════════════════════════════════════════════════════════════════
//
// Two layers:
//
//   1. ALWAYS-ON local logging.  Every uncaught exception, unhandled
//      rejection and renderer crash gets written to a JSON file in
//      <userData>/crash-reports/ as an audit trail. The file stays on
//      the user's machine — no network call, no privacy concern. The
//      user can view recent reports in Inställningar → Diagnostik.
//
//   2. OPT-IN upload.  If the user toggles "Skicka kraschrapporter"
//      on, every new report is also POSTed to seoz.io. The report
//      contains: app version, OS, error message, stack, anonymous
//      install ID. It does NOT contain: URLs, page titles, cookies,
//      passwords, mail content, or any user-identifying data beyond
//      the random install ID.
//
// We don't bundle Sentry — the dependency footprint isn't worth it
// for a small-team product. The endpoint at seoz.io receives the
// JSON body shape produced by _crashBuildReport() below, validates
// it server-side and stores in a 60-day-retention table.
//
// Native (Chromium-level) crashes are captured via Electron's built-in
// crashReporter into <userData>/Crashpad/ — those are .dmp files we
// don't auto-upload. They can be attached manually to a bug report.

const CRASH_DIR = path.join(app.getPath('userData'), 'crash-reports')
const CRASH_OPTIN_KEY = 'crashReportingEnabled'   // false by default
const CRASH_INSTALL_ID_KEY = 'crashInstallId'      // random per profile, anonymous
const CRASH_UPLOAD_URL = 'https://seoz.io/api/browser/crash-report'
const CRASH_MAX_LOGS = 50
const CRASH_DEDUPE_WINDOW_MS = 60_000  // identical msg within 60s = ignored

let _crashLastSig = ''
let _crashLastSigAt = 0

function _crashEnsureDir() {
  try { if (!fs.existsSync(CRASH_DIR)) fs.mkdirSync(CRASH_DIR, { recursive: true }) }
  catch (_) {}
}
function _crashGetInstallId() {
  let id = PM.profileGet(CRASH_INSTALL_ID_KEY, null)
  if (!id) {
    id = crypto.randomBytes(16).toString('hex')
    PM.profileSet(CRASH_INSTALL_ID_KEY, id)
  }
  return id
}
function _crashRotate() {
  try {
    const files = fs.readdirSync(CRASH_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()  // ISO-timestamp filenames sort naturally oldest-first
    if (files.length <= CRASH_MAX_LOGS) return
    files.slice(0, files.length - CRASH_MAX_LOGS).forEach(f => {
      try { fs.unlinkSync(path.join(CRASH_DIR, f)) } catch (_) {}
    })
  } catch (_) {}
}
function _crashBuildReport(kind, error, extra = {}) {
  const err = error instanceof Error ? error : new Error(String(error || ''))
  return {
    schema: 1,
    timestamp: new Date().toISOString(),
    kind,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    installId: _crashGetInstallId(),
    message: String(err.message || '').slice(0, 2000),
    stack: String(err.stack || '').slice(0, 8000),
    ...extra,
  }
}
function _crashUpload(report) {
  if (!PM.profileGet(CRASH_OPTIN_KEY, false)) return
  // Best-effort fire-and-forget. We never throw from inside the crash
  // reporter — that would crash the crash reporter, which is silly.
  try {
    net.fetch(CRASH_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {})
  } catch (_) {}
}
function recordCrash(kind, error, extra = {}) {
  try {
    // Dedupe identical bursts so a renderer in a tight error-loop
    // doesn't fill the disk with 100 copies of the same crash.
    const sig = String(kind) + '|' + (error?.message || error)
    const now = Date.now()
    if (sig === _crashLastSig && (now - _crashLastSigAt) < CRASH_DEDUPE_WINDOW_MS) return
    _crashLastSig = sig
    _crashLastSigAt = now

    _crashEnsureDir()
    const report = _crashBuildReport(kind, error, extra)
    const fname = report.timestamp.replace(/[:.]/g, '-') + '.json'
    fs.writeFileSync(path.join(CRASH_DIR, fname), JSON.stringify(report, null, 2))
    _crashRotate()
    _crashUpload(report)
  } catch (e) {
    try { console.error('[crash-reporter] failed to record:', e) } catch (_) {}
  }
}

// Capture main-process JS errors. Don't crash the app — for an
// uncaught exception we'd normally let Electron tear down, but with
// the renderer running things like mail and live tabs, killing the
// whole app on a stray promise rejection is harsh. Log it and move on.
process.on('uncaughtException', err => {
  recordCrash('main:uncaught', err)
})
process.on('unhandledRejection', reason => {
  recordCrash('main:unhandled-rejection',
    reason instanceof Error ? reason : new Error(String(reason)))
})

// Electron's native crash reporter for Chromium-level crashes.
// uploadToServer:false keeps dumps local at <userData>/Crashpad/.
// We start it as soon as the app is ready — it must run before any
// renderer tab spins up.
app.whenReady().then(() => {
  try {
    const { crashReporter } = require('electron')
    crashReporter.start({
      productName: 'SEOZ',
      companyName: 'SEOZ',
      submitURL: '',                 // local-only by default
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
    })
  } catch (_) { /* crash reporter is best-effort */ }
})

// Renderer process forwards its window.onerror / unhandledrejection here.
ipcMain.on('crash-report-renderer', (_e, payload = {}) => {
  recordCrash('renderer:' + (payload.kind || 'uncaught'),
    { message: payload.message || '', stack: payload.stack || '' },
    { rendererUrl: payload.url || '' })
})

// Settings IPC
ipcMain.handle('crash-reporting-status', () => {
  let logCount = 0
  try {
    if (fs.existsSync(CRASH_DIR)) {
      logCount = fs.readdirSync(CRASH_DIR).filter(f => f.endsWith('.json')).length
    }
  } catch (_) {}
  return {
    enabled: PM.profileGet(CRASH_OPTIN_KEY, false),
    installId: _crashGetInstallId(),
    logCount,
    logDir: CRASH_DIR,
  }
})
ipcMain.handle('crash-reporting-set-enabled', (_e, enabled) => {
  PM.profileSet(CRASH_OPTIN_KEY, !!enabled)
  return { ok: true, enabled: !!enabled }
})
ipcMain.handle('crash-reporting-list', () => {
  try {
    if (!fs.existsSync(CRASH_DIR)) return []
    const files = fs.readdirSync(CRASH_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 30)
    return files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CRASH_DIR, f), 'utf-8')) }
      catch (_) { return null }
    }).filter(Boolean)
  } catch (_) { return [] }
})
ipcMain.handle('crash-reporting-clear', () => {
  try {
    if (!fs.existsSync(CRASH_DIR)) return { ok: true }
    fs.readdirSync(CRASH_DIR).forEach(f => {
      try { fs.unlinkSync(path.join(CRASH_DIR, f)) } catch (_) {}
    })
  } catch (_) {}
  return { ok: true }
})
ipcMain.handle('crash-reporting-open-folder', () => {
  _crashEnsureDir()
  shell.openPath(CRASH_DIR)
  return { ok: true }
})

// ══════════════════════════════════════════════════════════════════════════════
//  DEFAULT BROWSER — register as handler for http/https
// ══════════════════════════════════════════════════════════════════════════════
if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANTI-DETECTION — make Electron look like a real Chrome install so sites
//  like Cloudflare / hCaptcha / Google don't instantly flag us as a bot.
// ══════════════════════════════════════════════════════════════════════════════
// Remove the "AutomationControlled" flag that Chromium sets by default when
// running under CDP / embedded — bot detectors check for this first.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
// Avoid leaking that we're headless-ish (some heuristics check this).
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process,Translate')
// Use a realistic number of cores / RAM when asked via Navigator APIs
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess')
// Bump V8 heap from the default 1.4 GB to 4 GB. SEOZ portal (and any
// other heavy SPA) loads enough JS bundles + Supabase realtime + audio
// buffers that the default sometimes OOMs the renderer mid-load,
// surfacing as 'render-process-gone reason: okänt'.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')

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
// NOTE: keep in sync with CHROME_MAJOR below for Sec-CH-UA client hints.
const CHROME_MAJOR = '140'
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// Sec-CH-UA client hints — modern bot detectors (Cloudflare, Akamai, hCaptcha)
// compare these against the UA string. They MUST match or the request is flagged.
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Not=A?Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`
const SEC_CH_UA_PLATFORM = '"Windows"'
const SEC_CH_UA_MOBILE = '?0'

function setupContentBlocker() {
  // Intercept requests in the webview's partition
  // Webviews use the default session unless a partition is set
  const ses = session.defaultSession

  // Override User-Agent at session level (removes "Electron/..." from UA)
  ses.setUserAgent(CHROME_UA)

  // Normalize request headers so they match a real Chrome install
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders
    // Strip any Electron fingerprint
    delete h['Electron']
    // Force a consistent modern Chrome UA (some sites re-send old UA header)
    h['User-Agent'] = CHROME_UA
    // Add/override client hints — only for navigations & top-level resources
    h['sec-ch-ua'] = SEC_CH_UA
    h['sec-ch-ua-mobile'] = SEC_CH_UA_MOBILE
    h['sec-ch-ua-platform'] = SEC_CH_UA_PLATFORM
    callback({ requestHeaders: h })
  })

  // Never block these domains
  const whitelist = ['seoz.io', 'flow.seoz.io', 'api.seoz.io']
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

// Diagnostic startup log — skriver varje kritisk steg till
// <userData>/startup.log så vi kan se exakt var appen dör om det
// händer. När användare rapporterar "öppnas inte" kan vi be dem
// skicka denna fil.
function _startupLog(msg) {
  try {
    const fp = path.join(app.getPath('userData'), 'startup.log')
    fs.appendFileSync(fp, new Date().toISOString() + ' ' + msg + '\n')
  } catch (_) {}
}

// Validera sparade fönster-bounds mot synliga skärmar. Om sparade
// bounds är off-screen (t.ex. från en tidigare extern monitor som
// inte längre är ansluten) kan fönstret öppnas där men aldrig synas.
// Returnerar säker bounds — rensar x/y om de är osynliga.
function _safeBounds() {
  const saved = store.get('bounds') || { width: 1400, height: 860 }
  const width  = Math.max(800, Math.min(saved.width  || 1400, 4000))
  const height = Math.max(500, Math.min(saved.height || 860,  3000))
  // Om vi har x/y, kolla att fönstret är synligt på någon skärm.
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    try {
      const displays = screen.getAllDisplays()
      const visible = displays.some(d => {
        const wa = d.workArea
        // Räcker att 100×100 av fönstret är inom en skärm
        return saved.x + 100 < wa.x + wa.width &&
               saved.x + width - 100 > wa.x &&
               saved.y + 100 < wa.y + wa.height &&
               saved.y + height - 100 > wa.y
      })
      if (visible) return { width, height, x: saved.x, y: saved.y }
    } catch (_) {}
  }
  // Fallback: bara storlek, ingen position → Electron centrerar
  return { width, height }
}

function createWindow() {
  _startupLog('createWindow: start')
  const bounds = _safeBounds()
  _startupLog('createWindow: bounds=' + JSON.stringify(bounds))

  win = new BrowserWindow({
    ...bounds,
    minWidth: 800, minHeight: 500,
    backgroundColor: '#131920',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,        // page JS can't reach preload internals
      nodeIntegration: false,        // page JS can't require() Node modules
      webviewTag: true,              // we use <webview> for tabs
      // sandbox: false because preload.js does require('electron') for
      // ipcRenderer + contextBridge. Enabling sandbox would force a preload
      // rewrite to the limited renderer-process Electron API. Tracked as
      // hardening task — preload still runs in an isolated world and
      // contextIsolation is on, so page → preload escape is the only
      // realistic remaining threat surface.
      sandbox: false,
    },
    show: false,
    icon: APP_ICON,
  })
  _startupLog('createWindow: BrowserWindow created')

  // Fallback: om ready-to-show inte fires inom 5 sekunder, visa
  // fönstret ändå. Tidigare har vi haft fall där renderern crashar
  // efter partial paint men innan ready-to-show — då stannade
  // processen igång utan synligt fönster. Bättre att visa ett
  // (möjligen brutet) fönster än ett osynligt.
  const fallbackShowTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      _startupLog('createWindow: FALLBACK forcing show after 5s timeout')
      try { win.show() } catch (e) { _startupLog('show failed: ' + e.message) }
    }
  }, 5000)

  // Logga renderer-crashes så vi vet om sidan dör innan första paint.
  win.webContents.on('render-process-gone', (_e, details) => {
    _startupLog('render-process-gone reason=' + details.reason + ' exitCode=' + details.exitCode)
  })
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    _startupLog('did-fail-load code=' + errorCode + ' desc=' + errorDescription + ' url=' + validatedURL)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    _startupLog('preload-error path=' + preloadPath + ' err=' + (error?.message || error))
  })

  // Permission system is set up at module scope (further down). Wire
  // the session handlers to it here.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    _handlePermissionRequest(webContents, permission, callback)
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return _checkPermissionSync(permission, requestingOrigin || '')
  })

  // Meeting transcription — grant getDisplayMedia() with system-loopback
  // audio. Our own chrome renderer calls this for the transcription feature;
  // guests (<webview>) have a separate permission flow above. A video source
  // is required by Chromium's API even when we only care about the audio
  // track, so we stage a screen source that the renderer then discards.
  if (typeof win.webContents.session.setDisplayMediaRequestHandler === 'function') {
    win.webContents.session.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const { desktopCapturer } = require('electron')
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        const primary = sources[0]
        if (!primary) { callback({}); return }
        callback({ video: primary, audio: 'loopback' })
      } catch (_) {
        callback({})
      }
    })
  }

  // Block Electron's default Ctrl+R / Ctrl+Shift+R / F5 / Shift+F5 handling
  // on the window. The renderer listens for these and calls wvReload() on
  // the active tab's <webview> only. Without this, Electron reloads the
  // entire BrowserWindow renderer, which recreates all tabs from scratch.
  // preventDefault() here only blocks Electron's built-in accelerator — the
  // keydown still flows to the renderer so its JS handler fires.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    const keyLower = (input.key || '').toLowerCase()
    if (ctrl && keyLower === 'r') event.preventDefault()
    if (input.key === 'F5') event.preventDefault()
  })

  // Intercept any window.open / target="_blank" that escapes webview
  // Navigate in same tab instead of opening a new OS window
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (url && /^https?:\/\//i.test(url)) {
      // Chrome-style: any escape (target=_blank, window.open, ctrl/middle click)
      // opens as a new tab in this browser instead of a separate OS window.
      win.webContents.send('open-url', url)
    }
    return { action: 'deny' }
  })

  const indexPath = path.join(__dirname, '../renderer/index.html')
  _startupLog('createWindow: loadFile ' + indexPath)
  win.loadFile(indexPath).catch(err => {
    _startupLog('loadFile FAILED: ' + (err?.message || err))
  })

  win.once('ready-to-show', () => {
    _startupLog('ready-to-show fired, showing window')
    clearTimeout(fallbackShowTimer)
    try { win.show() } catch (e) { _startupLog('show in ready-to-show failed: ' + e.message) }
    // If the app was launched with a URL, send it to the renderer
    if (launchUrl) {
      win.webContents.send('open-url', launchUrl)
      launchUrl = null
    }
  })

  win.on('resize', () => {
    if (!win.isMaximized()) store.set('bounds', win.getBounds())
  })
  win.on('move', () => {
    // Spara position också så vi kan validera vid nästa start
    if (!win.isMaximized()) store.set('bounds', win.getBounds())
  })
  win.on('closed', () => { win = null; stopSync(); clearTimeout(fallbackShowTimer) })
}

// ── Window controls ──
// Tear-off: open a dragged tab as a new window at the drop location
ipcMain.on('tab-tear-off', (_evt, payload) => {
  try {
    const { url, x, y } = payload || {}
    if (!url || !/^https?:\/\//i.test(url)) return
    const bounds = store.get('bounds') || { width: 1400, height: 860 }
    const newWin = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: typeof x === 'number' ? Math.max(0, x - 200) : undefined,
      y: typeof y === 'number' ? Math.max(0, y - 20) : undefined,
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
      icon: APP_ICON,
      show: false,
    })
    newWin.loadFile(path.join(__dirname, '../renderer/index.html'))
    newWin.once('ready-to-show', () => {
      newWin.show()
      newWin.webContents.send('open-url', url)
    })
  } catch (err) {
    console.error('[tab-tear-off] failed:', err)
  }
})

// Window controls — resolve target window from sender so popup wrappers
// (which share this preload) control THEIR own BrowserWindow, not the
// main one. Falls back to the main `win` if the sender's window can't
// be resolved (shouldn't happen but keeps the chrome controls safe).
function _winFromEvent(e) {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w && !w.isDestroyed() ? w : win
}
ipcMain.on('win-min',   (e) => _winFromEvent(e)?.minimize())
ipcMain.on('win-max',   (e) => { const w = _winFromEvent(e); if (!w) return; w.isMaximized() ? w.unmaximize() : w.maximize() })
ipcMain.on('win-close', (e) => _winFromEvent(e)?.close())
ipcMain.on('win-fullscreen', (e) => { const w = _winFromEvent(e); if (!w) return; w.setFullScreen(!w.isFullScreen()) })
ipcMain.handle('win-is-fullscreen', (e) => _winFromEvent(e)?.isFullScreen() ?? false)

// ── Manual window drag (workaround for Electron 28 + frame:false + <webview>
//    drag-region bug on Windows where -webkit-app-region:drag stops working
//    after the first drag). Renderer captures pointer + sends deltas; we
//    apply them via setPosition. Anchor = window position at drag start.
//    If the window is fullscreen / maximised, exit that state first so
//    the drag can proceed (Chrome-style: drag from a maximised window
//    automatically restores it). ──
let _dragAnchor = null
ipcMain.on('win-drag-start', () => {
  if (!win) return
  if (win.isFullScreen()) {
    win._wvFullscreenOwned = false  // user-initiated exit, don't trigger leave-fs sync
    win.setFullScreen(false)
  }
  if (win.isMaximized()) win.unmaximize()
  const [x, y] = win.getPosition()
  _dragAnchor = { x, y }
})
ipcMain.on('win-drag-move', (_e, dx, dy) => {
  if (!win || !_dragAnchor) return
  win.setPosition(_dragAnchor.x + Math.round(dx), _dragAnchor.y + Math.round(dy))
})
ipcMain.on('win-drag-end', () => { _dragAnchor = null })

// ── Password manager ──
// Per-profile, encrypted via Electron's safeStorage (Keychain on macOS,
// DPAPI on Windows, libsecret on Linux). The renderer never sees ciphertext;
// it gets plaintext on read and sends plaintext on write.
const PASSWORDS_KEY = 'savedPasswords'

function _pwListEncrypted() { return PM.profileGet(PASSWORDS_KEY, []) }
function _pwSaveEncrypted(arr) { PM.profileSet(PASSWORDS_KEY, arr) }

function _pwHydrate(entry) {
  if (!entry) return null
  return {
    id: entry.id,
    site: entry.site,
    username: entry.username,
    password: _decryptPassword(entry.passwordEnc) || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

ipcMain.handle('passwords-list', () => {
  return _pwListEncrypted().map(_pwHydrate).filter(Boolean)
})

ipcMain.handle('passwords-add', (_e, entry) => {
  // Username is intentionally optional — sites like Facebook's
  // step-2 password page don't expose the email field on the page
  // where the password is submitted, so we'd otherwise reject every
  // legitimate save coming from autofill. The user can still add
  // a username later via the manager modal's edit flow.
  if (!entry || !entry.site || !entry.password) {
    throw new Error('Webbplats och lösenord krävs')
  }
  const list = _pwListEncrypted()
  const now = Date.now()
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    site: String(entry.site).trim(),
    username: String(entry.username || '').trim(),
    passwordEnc: _encryptPassword(String(entry.password)),
    createdAt: now,
    updatedAt: now,
  }
  list.push(item)
  _pwSaveEncrypted(list)
  return _pwHydrate(item)
})

ipcMain.handle('passwords-update', (_e, { id, updates } = {}) => {
  if (!id || !updates) throw new Error('id och updates krävs')
  const list = _pwListEncrypted()
  const idx = list.findIndex(p => p.id === id)
  if (idx === -1) return null
  const cur = list[idx]
  const next = {
    ...cur,
    site: updates.site != null ? String(updates.site).trim() : cur.site,
    username: updates.username != null ? String(updates.username).trim() : cur.username,
    passwordEnc: updates.password != null ? _encryptPassword(String(updates.password)) : cur.passwordEnc,
    updatedAt: Date.now(),
  }
  list[idx] = next
  _pwSaveEncrypted(list)
  return _pwHydrate(next)
})

ipcMain.handle('passwords-delete', (_e, id) => {
  if (!id) return false
  const next = _pwListEncrypted().filter(p => p.id !== id)
  _pwSaveEncrypted(next)
  return true
})

// ── Master-PIN guard for the password manager ──
// Stored as { salt, hash, v } encrypted via safeStorage so even raw
// profile-JSON access doesn't reveal the hash.
//
// Hash versions:
//   v=1  PBKDF2-SHA256, 100k iterations  (legacy, pre v1.10.30)
//   v=2  PBKDF2-SHA256, 600k iterations  (OWASP 2024 minimum)
//
// On successful verify against a v=1 record we transparently re-hash
// with v=2 so existing users get the upgrade the next time they
// unlock the password manager. No re-prompt, no migration screen.
const PIN_HASH_V_LATEST = 2
const PIN_ITERATIONS = { 1: 100_000, 2: 600_000 }

function _pinHash(pin, salt, v = PIN_HASH_V_LATEST) {
  const iters = PIN_ITERATIONS[v] || PIN_ITERATIONS[PIN_HASH_V_LATEST]
  return crypto.pbkdf2Sync(String(pin), salt, iters, 32, 'sha256').toString('hex')
}

// Constant-time comparison so a timing-side-channel can't be used to
// learn how many leading hash bytes the attacker got right.
function _ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    // Still run a comparison so we don't leak length-mismatch through timing.
    try { crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)) } catch (_) {}
    return false
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch (_) {
    return false
  }
}

// In-memory rate limiter for PIN verify. Resets on app restart, so an
// attacker would have to relaunch the app between rounds — by which
// point our exponential lockout has already throttled them well below
// any practical brute-force speed.
//
//   1-4 fails:   no delay
//   5-9 fails:   30 s lockout per attempt (escalates to 5 min after 10+)
//   10+ fails:   5 min lockout per attempt
//
// PIN verify takes ~250ms with v=2 PBKDF2 (600k iters), so even without
// the lockout, brute-forcing a 6-digit PIN would take ~70 hours of
// continuous CPU. With the lockout it's effectively impossible.
const _pinLimiter = { fails: 0, lockedUntil: 0 }
function _pinLockoutMs(failCount) {
  if (failCount < 5) return 0
  if (failCount < 10) return 30_000
  return 300_000
}

ipcMain.handle('passwords-pin-status', () => {
  const enc = PM.profileGet('passwordsPinHashEnc', null)
  const now = Date.now()
  const lockedFor = Math.max(0, _pinLimiter.lockedUntil - now)
  return { hasPin: !!enc, lockedForMs: lockedFor, fails: _pinLimiter.fails }
})

ipcMain.handle('passwords-pin-set', (_e, pin) => {
  const v = String(pin || '')
  if (v.length < 4) return { ok: false, error: 'PIN måste vara minst 4 tecken' }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = _pinHash(v, salt, PIN_HASH_V_LATEST)
  const enc = _encryptPassword(JSON.stringify({ salt, hash, v: PIN_HASH_V_LATEST }))
  if (!enc) return { ok: false, error: 'OS-kryptering otillgänglig' }
  PM.profileSet('passwordsPinHashEnc', enc)
  // Setting/resetting the PIN clears any lockout state.
  _pinLimiter.fails = 0
  _pinLimiter.lockedUntil = 0
  return { ok: true }
})

ipcMain.handle('passwords-pin-verify', (_e, pin) => {
  const now = Date.now()
  if (now < _pinLimiter.lockedUntil) {
    return {
      ok: false,
      reason: 'locked',
      lockedForMs: _pinLimiter.lockedUntil - now,
      fails: _pinLimiter.fails,
    }
  }

  const enc = PM.profileGet('passwordsPinHashEnc', null)
  if (!enc) return { ok: false, reason: 'no-pin' }
  const decrypted = _decryptPassword(enc)
  if (!decrypted) return { ok: false, reason: 'decrypt-failed' }
  let parsed
  try { parsed = JSON.parse(decrypted) } catch (_) { return { ok: false, reason: 'corrupt' } }
  if (!parsed.salt || !parsed.hash) return { ok: false, reason: 'corrupt' }

  // Use the version stored with the record so legacy v=1 PINs still verify.
  const recordV = parsed.v || 1
  const computed = _pinHash(String(pin || ''), parsed.salt, recordV)
  const ok = _ctEqual(computed, parsed.hash)

  if (ok) {
    // Successful unlock — reset the rate limiter.
    _pinLimiter.fails = 0
    _pinLimiter.lockedUntil = 0

    // Transparent migration: if the stored record is on an older
    // hash version, re-hash with the latest and store. User sees
    // nothing different.
    if (recordV < PIN_HASH_V_LATEST) {
      try {
        const newSalt = crypto.randomBytes(16).toString('hex')
        const newHash = _pinHash(String(pin || ''), newSalt, PIN_HASH_V_LATEST)
        const newEnc = _encryptPassword(JSON.stringify({ salt: newSalt, hash: newHash, v: PIN_HASH_V_LATEST }))
        if (newEnc) PM.profileSet('passwordsPinHashEnc', newEnc)
      } catch (_) { /* keep verifying — re-hash failure isn't fatal */ }
    }
    return { ok: true }
  }

  // Failed attempt — bump counter and apply (potentially) a new lockout.
  _pinLimiter.fails += 1
  const lockMs = _pinLockoutMs(_pinLimiter.fails)
  if (lockMs > 0) _pinLimiter.lockedUntil = Date.now() + lockMs
  return {
    ok: false,
    reason: 'wrong',
    fails: _pinLimiter.fails,
    lockedForMs: lockMs,
  }
})

ipcMain.handle('passwords-pin-clear', () => {
  PM.profileDelete('passwordsPinHashEnc')
  _pinLimiter.fails = 0
  _pinLimiter.lockedUntil = 0
  return { ok: true }
})

// ── Autofill IPC relay for OAuth popup BrowserWindows ──
// Webview guests use ipcRenderer.sendToHost() — that lands in their
// owning <webview> tag's 'ipc-message' event, handled by the main
// renderer directly. Native popups can't do that; their preload
// sends to main with a 'popup-' prefix and we relay to the main
// renderer so all autofill UI stays in one place. The popup's
// webContents id is included so the renderer can answer back via
// 'popup-autofill-fill' below.
ipcMain.on('popup-seoz-autofill-request', (e, payload) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('popup-autofill-request', { ...(payload || {}), popupId: e.sender.id })
  }
})
ipcMain.on('popup-seoz-autofill-save', (e, payload) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('popup-autofill-save', { ...(payload || {}), popupId: e.sender.id })
  }
})
// Renderer asks us to push fill data into a specific popup.
ipcMain.on('popup-autofill-fill', (_e, { popupId, payload } = {}) => {
  if (!popupId) return
  const wc = webContents.fromId(popupId)
  if (wc && !wc.isDestroyed()) wc.send('seoz-autofill-fill', payload || {})
})

// ── DevTools ──
ipcMain.on('toggle-devtools', () => win?.webContents.toggleDevTools())

// ── Content blocker ──
ipcMain.handle('blocker-get-enabled', () => blockerEnabled)
ipcMain.handle('blocker-set-enabled', (_, v) => { blockerEnabled = !!v; return blockerEnabled })
ipcMain.handle('blocker-get-stats', () => blockerStats)

// Cookie-banner auto-handler preference (off / accept / reject) —
// per profile so multiple users / clients each control their own
// consent posture. Default 'off' so we don't change behaviour for
// existing users; they opt in via the SEOZ Shield popup.
const COOKIE_MODES = ['off', 'accept', 'reject']
ipcMain.handle('cookies-get-mode', () => PM.profileGet('cookieMode', 'off'))
ipcMain.handle('cookies-set-mode', (_e, mode) => {
  if (!COOKIE_MODES.includes(mode)) return { ok: false, error: 'Ogiltig mode' }
  PM.profileSet('cookieMode', mode)
  return { ok: true, mode }
})
ipcMain.on('blocker-reset-stats', () => { blockerStats.session = 0 })

// ── Theme (profile-scoped) ──
ipcMain.handle('get-theme', () => PM.profileGet('theme', 'light'))
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
  // News store is keyed per profile — repoint it so sources/cache come
  // from the right file after the switch.
  try { news.setActiveProfile(id) } catch (_) {}
  return { ok: true, profile }
})

// ── Claude AI (Anthropic API) ──
ipcMain.handle('claude-chat', async (_, { messages, systemPrompt, apiKey }) => {
  if (!apiKey) return { error: 'No Anthropic API key configured' }
  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful SEO assistant integrated in SEOZ. Respond in Swedish unless the user writes in another language. Be concise and actionable.',
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
//  SEOZ API SYNC — connects to real backend at seoz.io
// ══════════════════════════════════════════════════════════════════════════════
const API_BASE = 'https://seoz.io/api/browser'

async function apiFetch(endpoint, apiKey, options = {}) {
  const { method = 'GET', params = {}, body } = options
  const url = new URL(API_BASE + endpoint)
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  // Cache-buster so any intermediate proxy / Vercel edge cache /
  // Electron net stack doesn't hand us a stale list. The platform
  // hard-deletes clients (no soft-delete flag) so a stale response
  // would otherwise keep showing rows that no longer exist in DB.
  url.searchParams.set('_t', String(Date.now()))
  const fetchOpts = {
    method,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
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

// ── Agent Ready scan ──
// Calls the SEOZ platform's /api/verktyg/agent-ready endpoint to grade
// any URL on agent/LLM-readiness (robots.txt, MCP card, OAuth discovery,
// content negotiation, Web Bot Auth, commerce protocols, ...). Done in
// main so the request bypasses the renderer's CSP and so we can swap
// host/path centrally if the platform endpoint moves.
ipcMain.handle('fetch-agent-ready', async (_evt, url) => {
  const target = String(url || '').trim()
  if (!target) return { ok: false, error: 'URL krävs' }
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'URL måste börja med http(s)://' }
  // Try seoz.io first, fall back to seoz.se (the platform is deployed at both).
  const hosts = ['https://seoz.io', 'https://seoz.se']
  let lastErr = 'Nätverksfel'
  for (const host of hosts) {
    try {
      const res = await net.fetch(host + '/api/verktyg/agent-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      })
      if (res.ok) {
        const data = await res.json()
        return { ok: true, scorecard: data }
      }
      const text = await res.text().catch(() => '')
      lastErr = text || `HTTP ${res.status} från ${host}`
      // 404 → try next host. Other errors are real (don't loop forever).
      if (res.status !== 404) return { ok: false, error: lastErr, status: res.status }
    } catch (err) {
      lastErr = err?.message || 'Nätverksfel'
    }
  }
  return { ok: false, error: lastErr }
})

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATER — checks GitHub Releases for new versions
// ══════════════════════════════════════════════════════════════════════════════
//
// On macOS, electron-updater requires the new version to be code-signed
// (Squirrel.Mac validates the signature before applying the update).
// Our Mac builds are unsigned today, so the auto-install path will
// always fail. Rather than surface a broken download flow we surface
// a "manual download" status on macOS so the renderer can route the
// user to the GitHub Releases page instead.
//
// Windows builds are also unsigned but Squirrel.Windows happily applies
// unsigned updates — only Mac requires us to gate.
const MAC_UPDATE_INSTALL_BLOCKED = process.platform === 'darwin'
const MANUAL_DOWNLOAD_URL = 'https://github.com/valdemarmattsson-beep/seoz-browser/releases/latest'

autoUpdater.autoDownload = !MAC_UPDATE_INSTALL_BLOCKED
autoUpdater.autoInstallOnAppQuit = !MAC_UPDATE_INSTALL_BLOCKED

autoUpdater.on('checking-for-update', () => {
  win?.webContents.send('updater-status', { status: 'checking' })
})
autoUpdater.on('update-available', info => {
  // On macOS, route to manual download instead of the auto-install flow.
  if (MAC_UPDATE_INSTALL_BLOCKED) {
    win?.webContents.send('updater-status', {
      status: 'manual-download',
      version: info.version,
      url: MANUAL_DOWNLOAD_URL,
    })
    return
  }
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
  // Manual-download fallback for unsigned macOS builds — open the
  // GitHub Releases page in the system browser instead of trying to
  // run the autoUpdater (which would fail signature validation).
  if (MAC_UPDATE_INSTALL_BLOCKED) {
    shell.openExternal(MANUAL_DOWNLOAD_URL)
    return
  }
  autoUpdater.downloadUpdate().catch(() => {})
})
ipcMain.on('updater-install', () => {
  if (MAC_UPDATE_INSTALL_BLOCKED) {
    shell.openExternal(MANUAL_DOWNLOAD_URL)
    return
  }
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
      const reason = _explainExecError(error)
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        command,
        cwd: workDir,
        stdout: _cap(stdout, STDOUT_CAP),
        stderr: _cap(stderr, STDERR_CAP) + (reason ? `\n[process: ${reason}]` : ''),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
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

// `opts` is optional for back-compat. Accepts:
//   { exitCode: 0 | 1 | 'non-zero' }  → filter by exit code
//   { successOnly: true }             → shorthand for exitCode:0
//   { failedOnly: true }              → shorthand for exitCode:'non-zero'
function _searchHistory(query, limit, opts) {
  const entries = historyStore.get('entries', [])
  const o = opts || {}
  const hasExitFilter =
    o.exitCode !== undefined || o.successOnly === true || o.failedOnly === true
  function matchesExit(e) {
    if (!hasExitFilter) return true
    if (o.successOnly === true) return e.exitCode === 0
    if (o.failedOnly === true)  return e.exitCode !== 0
    if (o.exitCode === 'non-zero') return e.exitCode !== 0
    return e.exitCode === o.exitCode
  }
  const q = query ? query.toLowerCase() : ''
  return entries
    .filter(e => {
      if (!matchesExit(e)) return false
      if (!q) return true
      return (
        e.command.toLowerCase().includes(q) ||
        e.stdout.toLowerCase().includes(q) ||
        e.stderr.toLowerCase().includes(q) ||
        (e.cwd && e.cwd.toLowerCase().includes(q))
      )
    })
    .slice(-limit)
}

ipcMain.handle('terminal-history-search', (_, { query, limit, exitCode, successOnly, failedOnly }) => {
  return _searchHistory(query, limit || 50, { exitCode, successOnly, failedOnly })
})
ipcMain.handle('terminal-history-recent', (_, { limit }) => {
  const entries = historyStore.get('entries', [])
  return entries.slice(-(limit || 20))
})
ipcMain.handle('terminal-history-clear', () => {
  historyStore.set('entries', [])
  return { ok: true }
})

// ══════════════════════════════════════════════════════════════════════
//  MAIL — IMAP/SMTP via src/main/mail.js. Accounts live per-profile in
//  PM.profileGet('mailAccounts'), keyed by an 8-byte hex id. The currently
//  selected account per profile is in 'mailActiveAccountId'. Passwords are
//  stored encrypted via Electron's safeStorage (OS-level: Keychain on macOS,
//  DPAPI on Windows, libsecret on Linux).
// ══════════════════════════════════════════════════════════════════════
// crypto already imported at top of file
const LEGACY_MAIL_STORE_KEY = 'mailConfig'

function _encryptPassword(pw) {
  if (!pw) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-kryptering ej tillgänglig — kan inte lagra lösenord säkert')
  }
  return safeStorage.encryptString(pw).toString('base64')
}

function _decryptPassword(enc) {
  if (!enc || !safeStorage.isEncryptionAvailable()) return null
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch (_) { return null }
}

function _mailListAccounts() { return PM.profileGet('mailAccounts', []) }
function _mailSaveAccounts(arr) { PM.profileSet('mailAccounts', arr) }
function _mailGetActiveAccountId() { return PM.profileGet('mailActiveAccountId', null) }
function _mailSetActiveAccountId(id) { PM.profileSet('mailActiveAccountId', id) }

// Metadata view — safe to send to renderer (password stripped).
function _mailSafeAccount(a) {
  if (!a) return null
  const { passwordEnc, ...safe } = a
  return safe
}

// Full cfg with decrypted password. Main-process only.
function _mailHydrateAccount(id) {
  const a = _mailListAccounts().find(x => x.id === id)
  if (!a) return null
  return { ...a, password: _decryptPassword(a.passwordEnc) }
}

// Resolve account: explicit id → active → first. Returns hydrated cfg or null.
function _mailResolveAccount(explicitId) {
  const id = explicitId || _mailGetActiveAccountId()
  if (id) {
    const h = _mailHydrateAccount(id)
    if (h) return h
  }
  const first = _mailListAccounts()[0]
  return first ? _mailHydrateAccount(first.id) : null
}

// Fields we accept on the account object. Kept in one place so add/update
// can't drift (earlier, add quietly dropped fromAddresses + signature).
const _MAIL_ACCOUNT_FIELDS = [
  'email', 'displayName',
  'imapHost', 'imapPort', 'imapSecure',
  'smtpHost', 'smtpPort', 'smtpSecure',
  'username',
  'fromAddresses',        // array of alias addresses
  'signature',             // plain-text signature
  'avatarDataUrl',         // data-URL PNG (sender avatar, UI-only)
  'autoReply',             // { enabled, subject, body }
  'pinnedFolders',         // array of folder paths the user pinned to the top of the switcher
]

function _mailAddAccount(cfg) {
  if (!cfg || !cfg.email) throw new Error('email required')
  const accounts = _mailListAccounts()
  const account = {
    id: crypto.randomBytes(8).toString('hex'),
    imapPort: 993,
    imapSecure: true,
    smtpPort: 465,
    smtpSecure: true,
    username: null,
    fromAddresses: [],
    signature: '',
    avatarDataUrl: null,
    autoReply: { enabled: false, subject: '', body: '' },
    passwordEnc: _encryptPassword(cfg.password),
    createdAt: new Date().toISOString(),
  }
  for (const key of _MAIL_ACCOUNT_FIELDS) {
    if (cfg[key] !== undefined) account[key] = cfg[key]
  }
  // Normalize a couple of ports in case the renderer sent them as strings.
  account.imapPort = Number(account.imapPort) || 993
  account.smtpPort = Number(account.smtpPort) || 465
  accounts.push(account)
  _mailSaveAccounts(accounts)
  if (!_mailGetActiveAccountId()) _mailSetActiveAccountId(account.id)
  return account.id
}

function _mailUpdateAccount(id, updates) {
  const accounts = _mailListAccounts()
  const idx = accounts.findIndex(a => a.id === id)
  if (idx === -1) throw new Error('account not found')
  for (const key of _MAIL_ACCOUNT_FIELDS) {
    if (updates[key] !== undefined) accounts[idx][key] = updates[key]
  }
  if (updates.password) accounts[idx].passwordEnc = _encryptPassword(updates.password)
  _mailSaveAccounts(accounts)
}

async function _mailDeleteAccount(id) {
  const remaining = _mailListAccounts().filter(a => a.id !== id)
  _mailSaveAccounts(remaining)
  try { await mail.closeAccount(id) } catch (_) {}
  try { mailCache.clearAccount(id) } catch (_) {}
  let nextActiveId = _mailGetActiveAccountId()
  if (nextActiveId === id) {
    nextActiveId = remaining[0]?.id || null
    _mailSetActiveAccountId(nextActiveId)
  }
  return nextActiveId
}

// One-shot lift of legacy root-store 'mailConfig' → active profile's
// first account. Runs at startup; no-op if nothing to migrate or profile
// already has accounts.
function _mailMigrateLegacy() {
  const old = store.get(LEGACY_MAIL_STORE_KEY, null)
  if (!old || !old.email) return
  if (_mailListAccounts().length === 0) {
    const account = {
      id: crypto.randomBytes(8).toString('hex'),
      email: old.email,
      displayName: old.displayName || '',
      imapHost: old.imapHost,
      imapPort: Number(old.imapPort) || 993,
      imapSecure: old.imapSecure !== false,
      smtpHost: old.smtpHost,
      smtpPort: Number(old.smtpPort) || 465,
      smtpSecure: old.smtpSecure !== false,
      username: old.username || null,
      passwordEnc: old.passwordEnc || null,
      createdAt: new Date().toISOString(),
    }
    _mailSaveAccounts([account])
    _mailSetActiveAccountId(account.id)
    console.log('[mail] migrated legacy single-account config → profile')
  }
  store.delete(LEGACY_MAIL_STORE_KEY)
}

// PM.migrateLegacyData already ran when profile-manager was required, so
// an active profile is guaranteed by now.
_mailMigrateLegacy()

// ── IPC: Account management ──────────────────────────────────────────

ipcMain.handle('mail:accounts-list', async () => {
  return _mailListAccounts().map(_mailSafeAccount)
})

ipcMain.handle('mail:account-add', async (_evt, cfg) => {
  try { return { ok: true, id: _mailAddAccount(cfg) } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('mail:account-update', async (_evt, { id, updates } = {}) => {
  try { _mailUpdateAccount(id, updates || {}); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('mail:account-delete', async (_evt, id) => {
  try {
    const nextActiveId = await _mailDeleteAccount(id)
    return { ok: true, nextActiveId }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('mail:account-set-active', async (_evt, id) => {
  if (!_mailListAccounts().some(a => a.id === id)) return { ok: false, error: 'account not found' }
  _mailSetActiveAccountId(id)
  return { ok: true }
})

ipcMain.handle('mail:account-get-active', async () => {
  const id = _mailGetActiveAccountId()
  if (!id) return null
  return _mailSafeAccount(_mailListAccounts().find(x => x.id === id)) || null
})

// ── IPC: Tests + backward-compat wrappers ────────────────────────────

ipcMain.handle('mail:test', async (_evt, cfg) => mail.testConnection(cfg))

// Deprecated: keep so existing renderer setup flow keeps working.
// If cfg.id exists → update; else → add.
ipcMain.handle('mail:save-config', async (_evt, cfg) => {
  try {
    if (cfg && cfg.id && _mailListAccounts().some(a => a.id === cfg.id)) {
      _mailUpdateAccount(cfg.id, cfg)
      return { ok: true, id: cfg.id }
    }
    return { ok: true, id: _mailAddAccount(cfg) }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('mail:has-config', async () => _mailListAccounts().length > 0)

ipcMain.handle('mail:get-config', async () => {
  const id = _mailGetActiveAccountId()
  const a = _mailListAccounts().find(x => x.id === id) || _mailListAccounts()[0] || null
  return _mailSafeAccount(a)
})

// Deprecated: in the new model, "forget" deletes the active account.
ipcMain.handle('mail:forget', async () => {
  const id = _mailGetActiveAccountId() || _mailListAccounts()[0]?.id
  if (!id) return { ok: true }
  try { await _mailDeleteAccount(id); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── IPC: Mail operations (accountId optional — fallback till aktiv) ──

ipcMain.handle('mail:folders-list', async (_evt, { accountId } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  try {
    const folders = await mail.listFolders(cfg)
    return { ok: true, folders }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:list', async (_evt, { accountId, folder, limit, force } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  const fld = folder || 'INBOX'
  const lim = Number(limit) || 50

  // Cache-first: return the cached snapshot immediately so the user sees
  // the list without waiting for the network, then fetch in the
  // background and emit a 'list-updated' event when the freshly-fetched
  // set differs. `force: true` bypasses the cache path for the common
  // "user hit Refresh" case where they specifically want the server's
  // current truth regardless of what we cached.
  let cached = null
  if (!force) cached = mailCache.getList(cfg.id, fld)

  // Kick off the network fetch. We always run it (even on cache hit) so
  // the cache stays fresh — on cache miss we await it; on cache hit we
  // return cache and the event handler below catches up the UI later.
  const fetchP = (async () => {
    try {
      const messages = await mail.listMessages(cfg, fld, lim)
      const prev = cached ? cached.messages : null
      mailCache.setList(cfg.id, fld, messages)
      // Only emit an update event when the visible contents actually
      // changed — otherwise the renderer would flicker on every fetch.
      if (!mailCache.listsEqual(prev, messages)) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('mail:list-updated', { accountId: cfg.id, folder: fld, messages })
        }
      }
      return { ok: true, messages, source: 'network' }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })()

  if (cached) {
    // Don't leak unhandled rejection from the background fetch.
    fetchP.catch(() => {})
    return { ok: true, messages: cached.messages, source: 'cache', cachedAt: cached.cachedAt }
  }
  return await fetchP
})

ipcMain.handle('mail:search', async (_evt, { accountId, folder, query, limit } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  try {
    return await mail.searchMessages(cfg, folder || 'INBOX', query, Number(limit) || 100)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:get', async (_evt, { accountId, uid, folder, force } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  const fld = folder || 'INBOX'

  // Body cache is immutable for a given (uid, UIDVALIDITY) tuple per the
  // IMAP spec, so we can serve it without a background refetch. Only
  // `force: true` (e.g. user hit Refresh on the reader) rebuilds it.
  if (!force && uid != null) {
    const hit = mailCache.getBody(cfg.id, fld, uid)
    if (hit && hit.message) return { ok: true, message: hit.message, source: 'cache' }
  }
  try {
    const message = await mail.getMessage(cfg, uid, fld)
    if (message && uid != null) mailCache.setBody(cfg.id, fld, uid, message)
    return { ok: true, message, source: 'network' }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:move', async (_evt, { accountId, uid, fromFolder, to } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  if (uid == null || !to) return { ok: false, error: 'uid + to required' }
  try {
    return await mail.moveMessage(cfg, uid, fromFolder || 'INBOX', to)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:flag', async (_evt, { accountId, uid, flag, value, folder } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  try {
    return await mail.setFlag(cfg, uid, flag || '\\Seen', !!value, folder || 'INBOX')
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:send', async (_evt, opts = {}) => {
  const cfg = _mailResolveAccount(opts.accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  // Send-later: if a sendAt is provided and is in the future, queue
  // instead of sending now. Same mailOpts shape as immediate send so the
  // scheduler handler can just call mail.sendMessage when the timer hits.
  if (opts.sendAt) {
    const at = new Date(opts.sendAt)
    if (!isNaN(at) && at.getTime() > Date.now() + 1000) {
      const { sendAt, accountId, ...mailOpts } = opts
      const entry = mailScheduler.add({
        kind: 'send',
        accountId: cfg.id,
        sendAt: at.toISOString(),
        mailOpts,
      })
      return { ok: true, scheduled: true, id: entry.id, sendAt: entry.sendAt }
    }
  }
  try {
    return await mail.sendMessage(cfg, opts)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:snooze', async (_evt, { accountId, uid, fromFolder, wakeAt } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  if (!uid || !wakeAt) return { ok: false, error: 'uid + wakeAt required' }
  try {
    // Move the message to a dedicated snoozed folder on the server so it
    // disappears from the inbox (mirroring to the IMAP account means it
    // looks the same from any other mail client).
    const snoozeFolderName = 'Snoozed'
    // We need ImapFlow to ensure the folder exists. Use the mail client
    // pool via a small helper — if it doesn't exist we'll create it.
    await mail.ensureFolder(cfg, snoozeFolderName)
    const mv = await mail.moveMessage(cfg, uid, fromFolder || 'INBOX', snoozeFolderName)
    // Queue the restore via the scheduler so the server sees it land back
    // in INBOX at the requested time.
    const entry = mailScheduler.add({
      kind: 'snooze',
      accountId: cfg.id,
      uid,                       // note: this is the OLD uid; after move it's changed server-side
      snoozedFolder: mv.folder,
      originalFolder: fromFolder || 'INBOX',
      wakeAt: new Date(wakeAt).toISOString(),
    })
    return { ok: true, id: entry.id }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:scheduled-list', async (_evt, { accountId } = {}) => {
  const items = accountId ? mailScheduler.listByAccount(accountId) : mailScheduler.list()
  return { ok: true, items }
})

ipcMain.handle('mail:scheduled-cancel', async (_evt, id) => {
  mailScheduler.remove(id)
  return { ok: true }
})

ipcMain.handle('mail:save-draft', async (_evt, opts = {}) => {
  const cfg = _mailResolveAccount(opts.accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  try {
    return await mail.saveDraft(cfg, opts)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

ipcMain.handle('mail:delete-draft', async (_evt, { accountId, uid } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  if (uid == null) return { ok: false, error: 'uid required' }
  try {
    return await mail.deleteDraft(cfg, uid)
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

// Download a single attachment from a message. Opens a Save dialog and
// writes the file to the user-chosen path. Returns { ok, path } or
// { ok:true, cancelled:true } if the user cancelled the dialog.
ipcMain.handle('mail:download-attachment', async (_evt, { accountId, uid, index, folder, suggestedName } = {}) => {
  const cfg = _mailResolveAccount(accountId)
  if (!cfg || !cfg.password) return { ok: false, error: 'No active mail account' }
  if (uid == null || index == null) return { ok: false, error: 'uid + index required' }
  try {
    const att = await mail.getAttachment(cfg, uid, Number(index), folder || 'INBOX')
    const res = await dialog.showSaveDialog(win, {
      title: 'Spara bilaga',
      defaultPath: suggestedName || att.filename || 'bilaga',
    })
    if (res.canceled || !res.filePath) return { ok: true, cancelled: true }
    const fs = require('fs')
    await fs.promises.writeFile(res.filePath, att.content)
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

// File picker for compose-attach. Returns metadata only (no file contents) —
// nodemailer reads the file from path at send-time so we avoid copying large
// files through IPC. The MIME type is guessed from extension for the UI.
ipcMain.handle('mail:pick-attachments', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Välj bilagor',
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: true, attachments: [] }
  const fs = require('fs')
  const path = require('path')
  // Lightweight extension → MIME map. Anything not in the map falls back to
  // application/octet-stream, which nodemailer accepts fine.
  const MIME = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime',
  }
  const attachments = res.filePaths.map(p => {
    let size = 0
    try { size = fs.statSync(p).size } catch (_) {}
    const ext = path.extname(p).toLowerCase().replace(/^\./, '')
    return {
      path: p,
      filename: path.basename(p),
      size,
      contentType: MIME[ext] || 'application/octet-stream',
    }
  })
  return { ok: true, attachments }
})

// Forward mailbox events from IMAP IDLE to the renderer. Events fire on
// the currently-open mailbox for each account; the renderer filters by
// accountId + folder so it only acts on events for what the user is
// actively looking at.
mail.events.on('mailbox', (payload) => {
  if (win && !win.isDestroyed() && win.webContents) {
    try { win.webContents.send('mail:event', payload) } catch (_) {}
  }
  // Auto-responder: when an EXISTS event signals new mail on any account
  // that has autoReply.enabled, fire a best-effort reply to the sender.
  if (payload && payload.type === 'exists' && payload.count > (payload.prevCount || 0)) {
    _mailHandleAutoReply(payload).catch(err => {
      console.warn('[auto-reply]', err?.message || err)
    })
  }
})

// In-memory dedup so we don't spam the same sender or loop against another
// auto-responder. Reset at app start (acceptable for v1 — serious dedup
// would persist this across restarts).
const _autoReplySentTo = new Map()   // accountId → Map<senderEmail, timestamp>
const AUTO_REPLY_TTL_MS = 24 * 60 * 60 * 1000  // don't reply to the same sender more than once per day

function _autoReplyRecentlySentTo(accountId, sender) {
  const bucket = _autoReplySentTo.get(accountId)
  if (!bucket) return false
  const ts = bucket.get(sender)
  return ts && (Date.now() - ts) < AUTO_REPLY_TTL_MS
}
function _autoReplyRemember(accountId, sender) {
  let bucket = _autoReplySentTo.get(accountId)
  if (!bucket) { bucket = new Map(); _autoReplySentTo.set(accountId, bucket) }
  bucket.set(sender, Date.now())
}

// Heuristics to avoid replying to bulk/auto mail — these headers are the
// standard signals used across RFC 3834 + common vendors.
function _autoReplyShouldSkip(msg, selfAddresses) {
  const from = (msg.from && msg.from[0]) || {}
  const fromAddr = (from.address || '').toLowerCase()
  if (!fromAddr) return true
  if (selfAddresses.has(fromAddr)) return true  // don't reply to ourselves
  // Skip common bounce / automation senders
  if (/^(mailer-daemon|postmaster|no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|bounce|notifications?)@/i.test(fromAddr)) return true
  // Skip if the subject looks like an auto-reply already (loop guard)
  const subj = (msg.subject || '').toLowerCase()
  if (/^(auto(matic)?[- ]?reply|out of office|frånvaro(meddelande)?|på semester)/i.test(subj)) return true
  return false
}

async function _mailHandleAutoReply(payload) {
  const account = _mailListAccounts().find(a => a.id === payload.accountId)
  if (!account || !account.autoReply || !account.autoReply.enabled) return
  // Only INBOX — replies in Sent/Drafts would be nonsense
  const folder = payload.folder
  if (folder && folder.toLowerCase() !== 'inbox' && folder !== 'INBOX') return

  const cfg = _mailHydrateAccount(account.id)
  if (!cfg || !cfg.password) return

  // Fetch the newest messages so we can pick out what just arrived. Limit
  // to the delta between prevCount and count; if prevCount is missing,
  // fetch just the latest to avoid a storm on first connect.
  const fetchCount = Math.max(1, Math.min(10, (payload.count || 1) - (payload.prevCount || payload.count - 1)))
  let latest
  try {
    latest = await mail.listMessages(cfg, folder || 'INBOX', fetchCount)
  } catch (_) { return }
  if (!Array.isArray(latest) || !latest.length) return

  const selfAddresses = new Set(
    [account.email, ...(account.fromAddresses || [])]
      .filter(Boolean)
      .map(s => s.toLowerCase())
  )

  for (const msg of latest) {
    if (_autoReplyShouldSkip(msg, selfAddresses)) continue
    const sender = (msg.from?.[0]?.address || '').toLowerCase()
    if (!sender) continue
    if (_autoReplyRecentlySentTo(account.id, sender)) continue

    // Build the reply. Use the configured subject or fall back to "Re: …".
    const subject = account.autoReply.subject
      ? account.autoReply.subject
      : `Re: ${msg.subject || ''}`.trim()
    const body = account.autoReply.body || ''
    if (!body) continue  // empty body → don't send blank replies

    try {
      await mail.sendMessage(cfg, {
        to: msg.from[0].address,
        subject,
        text: body,
        inReplyTo: msg.messageId || undefined,
        references: msg.messageId || undefined,
        // Tag as an auto-reply so downstream servers can skip it (RFC 3834)
        headers: {
          'Auto-Submitted': 'auto-replied',
          'X-Auto-Response-Suppress': 'All',
          'Precedence': 'auto_reply',
        },
      })
      _autoReplyRemember(account.id, sender)
      console.log('[auto-reply] sent →', sender, 'from account', account.email)
    } catch (err) {
      console.warn('[auto-reply] send failed:', err?.message || err)
    }
  }
}

// Mail-unread badge. Renderer computes the count from loaded messages and
// pushes it here along with a pre-rasterized PNG (rendered via Canvas in
// the renderer — nativeImage.createFromBuffer on Windows only accepts
// PNG/JPEG/GIF/BMP/ICO, so SVG was silently ignored). We then mirror to
// OS-level indicators: app.setBadgeCount (macOS + Linux Unity), and
// win.setOverlayIcon for Windows taskbar overlays.
let _currentBadgeCount = 0
ipcMain.handle('app:set-badge-count', (_evt, payload = {}) => {
  const n = Math.max(0, Number(payload.count) || 0)
  if (n === _currentBadgeCount) return { ok: true }
  _currentBadgeCount = n
  try { app.setBadgeCount(n) } catch (_) {}
  if (win && !win.isDestroyed()) {
    if (n > 0 && payload.png) {
      try {
        const buf = Buffer.isBuffer(payload.png) ? payload.png : Buffer.from(payload.png)
        const img = nativeImage.createFromBuffer(buf)
        if (img && !img.isEmpty()) {
          win.setOverlayIcon(img, `${n} oläst${n === 1 ? '' : 'a'} mejl`)
        }
      } catch (_) {}
    } else {
      try { win.setOverlayIcon(null, '') } catch (_) {}
    }
  }
  return { ok: true }
})

// Scheduler handlers — fire when a queued item's time is up. `send`
// ships the stored mailOpts through the same mail.sendMessage path used
// for immediate sends; `snooze` moves a snoozed message back to its
// original folder (usually INBOX) via the newest-uid search since the
// original uid changed during the move-out earlier.
mailScheduler.setHandler('send', async (entry) => {
  const account = _mailListAccounts().find(a => a.id === entry.accountId)
  if (!account) throw new Error('account no longer exists')
  const cfg = _mailHydrateAccount(entry.accountId)
  if (!cfg || !cfg.password) throw new Error('no password')
  await mail.sendMessage(cfg, entry.mailOpts)
  if (win && !win.isDestroyed()) {
    win.webContents.send('mail:scheduled-sent', { id: entry.id, to: entry.mailOpts.to })
  }
})
mailScheduler.setHandler('snooze', async (entry) => {
  const cfg = _mailHydrateAccount(entry.accountId)
  if (!cfg || !cfg.password) throw new Error('no password')
  // We stored the pre-move uid — we have to find the message again in
  // its snoozed folder. Easiest: list the snoozed folder and match by
  // uid saved in scheduler entry (which is the NEW uid after move
  // actually — imapflow updates the tracked uid on the return).
  // For robustness, we match by wakeAt ≈ uid; just move the most-recent
  // message in the Snoozed folder if uid match fails.
  try {
    await mail.moveMessage(cfg, entry.uid, entry.snoozedFolder, entry.originalFolder || 'INBOX')
  } catch (err) {
    console.warn('[snooze] move failed:', err?.message || err)
    throw err
  }
})
mailScheduler.start()

// ── News (RSS/Atom) ─────────────────────────────────────────────────
// Per-profile store: point at the active profile up-front so first reads
// land in the right file, then start the 15-min background refresh.
try { news.setActiveProfile(PM.getActiveProfileId()) } catch (_) {}
news.startScheduler()

// Bridge "items-updated" → renderer so the home rail re-renders without
// the user needing to click anything.
news.events.on('items-updated', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('news:items-updated')
  }
})

ipcMain.handle('news:get',          (_e, opts)    => ({ ok: true, items: news.getItems(opts || {}) }))
ipcMain.handle('news:refresh',      async ()      => news.refreshAll())
ipcMain.handle('news:get-sources',  ()            => ({ ok: true, sources: news.getSources() }))
ipcMain.handle('news:set-sources',  (_e, list)    => ({ ok: true, sources: news.setSources(list) }))
ipcMain.handle('news:get-presets',  ()            => ({ ok: true, presets: news.PRESETS }))
ipcMain.handle('news:fetch-preview',(_e, url)     => news.fetchPreview(url))
ipcMain.handle('news:get-themes',   ()            => ({ ok: true, themes: news.getThemes() }))
// setThemes mutates ranking but doesn't refetch — emit items-updated so
// the rail re-renders with the new boost order without waiting for the
// next 15-min refresh tick.
ipcMain.handle('news:set-themes',   (_e, list)    => {
  const themes = news.setThemes(list)
  news.events.emit('items-updated')
  return { ok: true, themes }
})

// Unified-unread aggregator — polls every configured account's INBOX via
// IMAP STATUS (cheap, doesn't disturb IDLE) and pushes the total to the
// renderer so the badge reflects ALL accounts, not just the one the user
// happens to be viewing. Runs at app start + every 2 min + after any
// IDLE exists/expunge/flags event (since those can change the count).
let _unifiedPollHandle = null
let _unifiedLastTotal = -1
async function _computeUnifiedUnread() {
  const accounts = _mailListAccounts()
  let total = 0
  const perAccount = {}
  for (const a of accounts) {
    const cfg = _mailHydrateAccount(a.id)
    if (!cfg || !cfg.password) continue
    try {
      const n = await mail.getUnreadCount(cfg, 'INBOX')
      perAccount[a.id] = n
      total += n
    } catch (_) { /* skip account on error */ }
  }
  return { total, perAccount }
}
async function _pushUnifiedUnread() {
  try {
    const { total, perAccount } = await _computeUnifiedUnread()
    if (total === _unifiedLastTotal) return
    _unifiedLastTotal = total
    if (win && !win.isDestroyed()) {
      win.webContents.send('mail:unread-total', { total, perAccount })
    }
  } catch (err) {
    console.warn('[unified-unread]', err?.message || err)
  }
}
function _startUnifiedPoll() {
  if (_unifiedPollHandle) return
  // Kick off once now, then every 2 min. IDLE events trigger extra
  // refreshes in between (see mail.events.on below).
  setTimeout(() => _pushUnifiedUnread().catch(() => {}), 2000)
  _unifiedPollHandle = setInterval(() => _pushUnifiedUnread().catch(() => {}), 2 * 60 * 1000)
}
_startUnifiedPoll()

// Any IDLE event on any account → re-aggregate. Debounced so a burst
// (e.g. 10 messages coming in at once) only triggers one refresh.
let _unifiedDebounce = null
mail.events.on('mailbox', () => {
  clearTimeout(_unifiedDebounce)
  _unifiedDebounce = setTimeout(() => _pushUnifiedUnread().catch(() => {}), 1500)
})

ipcMain.handle('mail:unread-total', async () => {
  const res = await _computeUnifiedUnread()
  return { ok: true, ...res }
})

// ── Templates (quick replies) — per profile, shared across accounts ─
// Lives in the profile store so switching browser profiles also swaps
// the template library. Structure: [{ id, name, subject?, body }]
ipcMain.handle('mail:templates-list', async () => {
  return PM.profileGet('mailTemplates', [])
})

ipcMain.handle('mail:template-save', async (_evt, { id, name, subject, body } = {}) => {
  if (!name || !body) return { ok: false, error: 'name + body required' }
  const all = PM.profileGet('mailTemplates', [])
  if (id) {
    const idx = all.findIndex(t => t.id === id)
    if (idx === -1) return { ok: false, error: 'template not found' }
    all[idx] = { id, name, subject: subject || '', body }
  } else {
    all.push({
      id: crypto.randomBytes(6).toString('hex'),
      name, subject: subject || '', body,
    })
  }
  PM.profileSet('mailTemplates', all)
  return { ok: true }
})

ipcMain.handle('mail:template-delete', async (_evt, id) => {
  const all = PM.profileGet('mailTemplates', []).filter(t => t.id !== id)
  PM.profileSet('mailTemplates', all)
  return { ok: true }
})

// ── AI Smart Inbox — classify messages via Claude ───────────────────
// Renderer sends { items: [{ messageId, from, subject }] }. Response
// splits into `cached` (already classified) + `classified` (freshly
// done via Claude). The renderer can merge them into its local map.
ipcMain.handle('mail:classify', async (_evt, { items } = {}) => {
  if (!Array.isArray(items) || !items.length) return { ok: true, cached: {}, classified: {} }
  const ids = items.map(i => i && i.messageId).filter(Boolean)
  const cached = mailClassifier.getCached(ids)
  const todo = items.filter(i => i && i.messageId && !cached[i.messageId])
  if (!todo.length) return { ok: true, cached, classified: {} }
  // Reuse the active profile's stored Anthropic key (same key the Claude
  // panel uses). Renderer stashes it in the profile store under
  // 'anthropicKey'.
  const apiKey = PM.profileGet('anthropicKey', null)
  if (!apiKey) return { ok: true, cached, classified: {}, reason: 'no-api-key' }
  try {
    const classified = await mailClassifier.classify(todo, apiKey)
    return { ok: true, cached, classified }
  } catch (err) {
    return { ok: false, error: err.message || String(err), cached, classified: {} }
  }
})

// ── Mail context research — Phase 2 ────────────────────────────────
// Given a sender domain, fetch the company's homepage, extract meta
// signals, and (if Anthropic key set) ask Claude for a 1-line
// company summary + size/industry estimate. Cached per domain in
// electron-store so repeat opens are instant.
const _researchStore = new Store({
  name: 'mail-domain-research',
  defaults: { byDomain: {} },
  // Bump if we change the schema and want to invalidate everything.
})
const RESEARCH_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days

function _researchGetCached(domain) {
  const all = _researchStore.get('byDomain', {})
  const e = all[domain]
  if (!e) return null
  if (e.fetchedAt && (Date.now() - e.fetchedAt) > RESEARCH_TTL_MS) return null
  return e
}
function _researchSetCached(domain, data) {
  const all = _researchStore.get('byDomain', {})
  all[domain] = { ...data, fetchedAt: Date.now() }
  // Cap at 5000 entries (pathological); keep newest 2500.
  const keys = Object.keys(all)
  if (keys.length > 5000) {
    const trimmed = {}
    keys.sort((a, b) => (all[b].fetchedAt || 0) - (all[a].fetchedAt || 0))
    for (const k of keys.slice(0, 2500)) trimmed[k] = all[k]
    _researchStore.set('byDomain', trimmed)
  } else {
    _researchStore.set('byDomain', all)
  }
}

function _researchExtractMeta(html) {
  const out = {}
  const pick = (re) => { const m = String(html || '').match(re); return m ? m[1].trim() : '' }
  out.title         = pick(/<title[^>]*>([^<]+)<\/title>/i).slice(0, 200)
  out.description   = pick(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i).slice(0, 400)
  out.ogSiteName    = pick(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i).slice(0, 100)
  out.ogTitle       = pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i).slice(0, 200)
  out.ogDescription = pick(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i).slice(0, 400)
  return out
}

ipcMain.handle('mail:research-domain', async (_evt, { domain, force } = {}) => {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '')
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return { ok: false, error: 'Ogiltig domän' }

  // Skip the obvious noreply / mass-mail domains — they aren't companies
  // worth researching, and we don't want to burn tokens on Zoho noreply
  // every time the user opens a notification.
  const SKIP = ['gmail.com','hotmail.com','outlook.com','yahoo.com','icloud.com','live.com','protonmail.com','aol.com','mailgun.org','sendgrid.net','amazonses.com']
  if (SKIP.includes(d)) return { ok: true, skipped: true, domain: d }

  if (!force) {
    const cached = _researchGetCached(d)
    if (cached) return { ok: true, cached: true, ...cached }
  }

  // 1. Fetch homepage HTML.
  let meta = {}
  try {
    const res = await net.fetch(`https://${d}/`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOZ-Browser/1.0; +https://seoz.io)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const html = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 500_000))
      meta = _researchExtractMeta(html)
    }
  } catch (_) {}

  // 2. Optionally refine via Claude — pulls a structured summary out
  //    of the noisy meta fields.
  let summary = null
  const apiKey = PM.profileGet('anthropicKey', null)
  if (apiKey && (meta.title || meta.description || meta.ogDescription)) {
    const system = [
      'Du sammanfattar ett företag baserat på dess hemside-metadata.',
      'Svara endast med JSON i exakt det här formatet:',
      '{"name":"<bolagsnamn>","industry":"<bransch på svenska, max 4 ord>","size":"<storlek-uppskattning t.ex. ~10-50 anställda eller okänt>","summary":"<en mening på svenska som beskriver vad bolaget gör>"}',
      'Inget annat — ingen markdown, inget prefix.',
    ].join('\n')
    const user = [
      `Domän: ${d}`,
      meta.title         ? `Titel: ${meta.title}`           : '',
      meta.ogSiteName    ? `Sitnamn: ${meta.ogSiteName}`    : '',
      meta.description   ? `Beskrivning: ${meta.description}` : '',
      meta.ogDescription ? `OG-beskr: ${meta.ogDescription}` : '',
    ].filter(Boolean).join('\n')
    try {
      const res = await net.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const txt = (data?.content?.[0]?.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
        try {
          const parsed = JSON.parse(txt)
          if (parsed && typeof parsed === 'object') {
            summary = {
              name:     String(parsed.name     || '').slice(0, 80),
              industry: String(parsed.industry || '').slice(0, 60),
              size:     String(parsed.size     || '').slice(0, 60),
              summary:  String(parsed.summary  || '').slice(0, 240),
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  const data = { domain: d, meta, summary }
  _researchSetCached(d, data)
  return { ok: true, cached: false, ...data }
})

// Make sure we disconnect IMAP cleanly on quit so the server doesn't
// sit waiting for the idle timeout.
app.on('before-quit', async () => {
  mailScheduler.stop()
  try { await mail.closeAll() } catch (_) {}
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
      const reason = _explainExecError(error)
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        command,
        cwd: workDir,
        stdout: _cap(stdout, STDOUT_CAP),
        stderr: _cap(stderr, STDERR_CAP) + (reason ? `\n[process: ${reason}]` : ''),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
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
  // Windows' AppendCategory is fussy about control chars, pipe-style
  // shell metacharacters in titles, very long args, and missing icon
  // files. When any of these slip through, ChromIum logs a noisy
  // "Failed to append task" ERROR to stderr (non-fatal but spammy).
  // We sanitise aggressively up-front so the row actually lands.
  const fsSync = require('fs')
  function _sanitiseTitle(t) {
    return String(t || '')
      // strip control chars + pipes / angle brackets / quotes (shell-link unsafe)
      .replace(/[\x00-\x1f\x7f|<>"]/g, ' ')
      // collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  }
  function makeItem(title, url, host) {
    const safeTitle = _sanitiseTitle(title) || _sanitiseTitle(host) || 'Sida'
    // Windows shell link arguments cap out somewhere around 260–512 chars;
    // skip URLs that would push the row past it (they'd just fail anyway).
    if (!url || url.length > 480) return null
    const item = {
      type: 'task',
      title: safeTitle.length > 50 ? safeTitle.slice(0, 47) + '...' : safeTitle,
      program: exePath,
      args: url,
      description: url.length > 250 ? url.slice(0, 247) + '...' : url,
    }
    const iconPath = iconMap.get(host)
    // Only attach icon if the cached file is actually still on disk —
    // a stale path triggers AppendCategory failure on the whole item.
    if (iconPath) {
      try { if (fsSync.existsSync(iconPath)) { item.iconPath = iconPath; item.iconIndex = 0 } }
      catch (_) {}
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
        description: 'Öppna ett nytt SEOZ-fönster',
        iconPath: exePath,
        iconIndex: 0,
      },
    ]
  })

  // "Mest besökta"
  const topItems = topSites.map(s => makeItem(s.title, s.url, s.host)).filter(Boolean)
  if (topItems.length) categories.push({ type: 'custom', name: 'Mest besökta', items: topItems })

  // "Senast besökta"
  const recentItems = recentSites.map(s => makeItem(s.title, s.url, s.host)).filter(Boolean)
  if (recentItems.length) categories.push({ type: 'custom', name: 'Senast besökta', items: recentItems })

  // setJumpList is "all-or-nothing" for the whole call — a single bad
  // item rejects the entire batch and spams stderr. If the full call
  // throws, fall back to the always-present Aktiviteter category alone
  // so at least "Nytt fönster" survives.
  try {
    app.setJumpList(categories)
  } catch (_) {
    try { app.setJumpList(categories.slice(0, 1)) } catch (_) {}
  }
}

// IPC: renderer tells main to refresh Jump List after navigation
// Debounced — don't spam downloads on rapid navigations
ipcMain.on('update-jump-list', () => {
  if (jumpListTimer) clearTimeout(jumpListTimer)
  jumpListTimer = setTimeout(() => updateJumpList(), 2000)
})

// ── <webview> guest setup (popups + keyboard shortcuts) ──
// Without this, Electron creates default popup windows with the yellow
// Electron icon, native Windows menu (File/Edit/View/...) and standard
// chrome — visually disconnected from SEOZ. We hand-roll the popup
// options so they pick up our icon and a SEOZ-coloured title bar overlay.
// We ALSO intercept Ctrl+R / Ctrl+Shift+R / F5 here because keyboard
// events that originate inside a guest webview never bubble up to the
// host renderer's document — the host's keydown handler can't see them.
// Stealth-koden lazy-loadas från delad fil så main + webview-preload
// använder samma sträng. Cachas vid första use så vi inte läser disken
// vid varje page-load.
let _stealthCodeCache = null
function _getStealthCode() {
  if (_stealthCodeCache) return _stealthCodeCache
  try {
    _stealthCodeCache = require('../preload/stealth-code.js')
  } catch (_) { _stealthCodeCache = '' }
  return _stealthCodeCache
}

app.on('web-contents-created', (_e, contents) => {
  const contentsType = contents.getType()

  // ── Stealth injection (alla webContents utom vår egen chrome-renderer) ──
  // Anropas från main för att vinna timing-racet mot t.ex. Googles
  // detection-script. webview-preloaden kör samma kod via webFrame.
  // executeJavaScript men det är async — main-process-vägen kör tidigare
  // i navigation-livcykeln. Belt-and-suspenders.
  //
  // Filtrerar bort vår egen UI-renderer (file:// + about:) — vill inte
  // spoof:a för vårt eget chrome.
  if (contentsType === 'webview' || contentsType === 'window') {
    contents.on('did-start-loading', () => {
      try {
        const url = contents.getURL()
        if (!url || url.startsWith('file://') || url.startsWith('about:') || url.startsWith('chrome-extension:')) return
        const code = _getStealthCode()
        if (!code) return
        contents.executeJavaScript(code, false).catch(() => {})
      } catch (_) {}
    })
  }

  if (contentsType !== 'webview') return

  // Ctrl+R / F5 → reload the guest. Ctrl+Shift+R → reload bypassing cache.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    const key = (input.key || '').toLowerCase()
    if (input.key === 'F5' || (ctrl && key === 'r')) {
      event.preventDefault()
      if (ctrl && input.shift && key === 'r') contents.reloadIgnoringCache()
      else contents.reload()
    }
    // ESC → exit HTML5 fullscreen if guest is in it. Belt-and-braces: the
    // guest normally handles this itself, but some pages swallow ESC.
    if (input.key === 'Escape' && contents.isFullScreen?.()) {
      event.preventDefault()
      contents.executeJavaScript('document.exitFullscreen && document.exitFullscreen()').catch(() => {})
    }
  })

  // HTML5 fullscreen requested by guest content (e.g. SEOZ platform's
  // expand-chart button). The webview tag's events don't always propagate
  // up to the host renderer, so we wire it on the guest's webContents
  // here in main and forward to the renderer over IPC.
  contents.on('enter-html-full-screen', () => {
    if (!win) return
    if (!win.isFullScreen()) {
      win._wvFullscreenOwned = true
      win.setFullScreen(true)
    }
    win.webContents.send('webview-fullscreen', true)
  })
  contents.on('leave-html-full-screen', () => {
    if (!win) return
    if (win._wvFullscreenOwned) {
      win._wvFullscreenOwned = false
      win.setFullScreen(false)
    }
    win.webContents.send('webview-fullscreen', false)
  })

  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!url || !/^https?:\/\//i.test(url)) return { action: 'deny' }

    // 'new-window' = window.open(url, name, features) — true popup (OAuth etc.)
    if (disposition === 'new-window') {
      // OAuth-style popups need a real window.opener relationship: the
      // parent page typically calls popup.location = url after open and
      // listens for popup.close() / postMessage back. Wrapping the
      // popup in our own BrowserWindow (popup.html with a <webview>)
      // breaks that — the parent's reference points at the wrapper, not
      // the inner guest, so subsequent location-pushes never reach the
      // page. For those URLs we therefore use action:'allow' with
      // styling overrides; for everything else we still wrap so the
      // user gets the SEOZ chrome.
      if (_isOAuthLikeUrl(url)) {
        const isDark = PM.profileGet('theme', 'light') === 'dark'
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            icon: APP_ICON,
            backgroundColor: isDark ? '#131920' : '#f8f9fa',
            autoHideMenuBar: true,
            title: 'SEOZ',
            ...(process.platform === 'win32' ? {
              titleBarStyle: 'hidden',
              titleBarOverlay: {
                color: isDark ? '#131920' : '#ffffff',
                symbolColor: isDark ? '#ffffff' : '#1f2937',
                height: 32,
              },
            } : {}),
            webPreferences: {
              contextIsolation: true,    // OAuth page JS isolated from preload
              nodeIntegration: false,    // OAuth page can't reach Node
              // sandbox: false because webview-preload.js does require('electron')
              // for ipcRenderer. OAuth popups get the same hardening as regular
              // tabs — preload is in an isolated world, page can't touch it.
              sandbox: false,
              // Run the same login-form detector as in regular tabs so
              // OAuth popups (Sign in with Google etc.) get autofill
              // and save-prompt support too. The preload is shared —
              // it detects context and switches transport.
              preload: path.join(__dirname, '..', 'preload', 'webview-preload.js'),
            },
          },
        }
      }
      // Non-OAuth: wrap with our SEOZ chrome.
      setImmediate(() => createSeozPopup(url, features))
      return { action: 'deny' }
    }

    // target="_blank", middle-click, ctrl-click — open as a new tab in our
    // existing browser window instead of a separate OS window.
    if (win) win.webContents.send('open-url', url)
    return { action: 'deny' }
  })
})

// Heuristic: does the URL look like an OAuth / SSO / federated-login
// flow? These need a real window.opener and can't be wrapped without
// breaking the post-auth navigation. We're intentionally generous —
// false positives just mean a slightly less SEOZ-styled popup, which
// is far better than a blank one.
function _isOAuthLikeUrl(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()
    // Well-known IdPs
    if (/(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com|gitlab\.com|bitbucket\.org|auth0\.com|okta\.com|onelogin\.com|saml\.|sso\.|idp\.|auth\.)/.test(host)) return true
    // Path / query patterns
    if (/(^|\/)(oauth2?|openid|sso|saml|auth|authorize|login|signin|sign-in|signup|sign-up|callback|connect|federation)(\/|$)/.test(path)) return true
    if (/[?&](client_id|response_type|redirect_uri|state|scope|nonce|sso|saml)=/.test(u.search)) return true
    return false
  } catch (_) {
    return false
  }
}

// Tracked popup windows so we can clean up properly.
const _seozPopups = new Set()

function createSeozPopup(url, features) {
  // Parse common features (width/height) from the features string. Falls
  // back to a sensible OAuth-popup size when not specified.
  const parsed = _parseWindowFeatures(features)
  const w = parsed.width || 720
  const h = parsed.height || 720

  const isDark = PM.profileGet('theme', 'light') === 'dark'
  const popup = new BrowserWindow({
    width: w, height: h, minWidth: 400, minHeight: 320,
    backgroundColor: isDark ? '#131920' : '#f8f9fa',
    titleBarStyle: 'hidden',
    frame: false,
    autoHideMenuBar: true,
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,        // page JS can't reach preload internals
      nodeIntegration: false,        // page JS can't require() Node modules
      webviewTag: true,              // we use <webview> for tabs
      // sandbox: false because preload.js does require('electron') for
      // ipcRenderer + contextBridge. Enabling sandbox would force a preload
      // rewrite to the limited renderer-process Electron API. Tracked as
      // hardening task — preload still runs in an isolated world and
      // contextIsolation is on, so page → preload escape is the only
      // realistic remaining threat surface.
      sandbox: false,
    },
  })

  _seozPopups.add(popup)
  popup.on('closed', () => _seozPopups.delete(popup))

  // Pass the target URL to popup.html via a hash fragment (loadFile +
  // search query is awkward; hash works without URL encoding edge cases).
  popup.loadFile(path.join(__dirname, '../renderer/popup.html'), {
    hash: 'url=' + encodeURIComponent(url),
  })
  popup.once('ready-to-show', () => popup.show())
}

function _parseWindowFeatures(features) {
  if (!features) return {}
  const out = {}
  String(features).split(',').forEach(pair => {
    const [k, v] = pair.split('=').map(s => s && s.trim())
    if (k && v) {
      const n = Number(v)
      if (!Number.isNaN(n)) out[k.toLowerCase()] = n
    }
  })
  return out
}

// Belt-and-braces: any window we missed (popup created via a path we didn't
// intercept) still gets the SEOZ icon and no native menu.
app.on('browser-window-created', (_e, bw) => {
  try {
    bw.setMenu(null)
    if (APP_ICON) bw.setIcon(APP_ICON)
  } catch (_) {}
})

// ── Lifecycle ──
app.whenReady().then(() => {
  // Force web content to always see light mode — prevents OS dark mode from affecting websites
  nativeTheme.themeSource = 'light'

  // Remove default Electron menu (File/Edit/View/Window/Help) from all windows.
  // The main window is frameless so it never showed; popup windows (e.g. Google
  // OAuth) inherited it before this was set.
  Menu.setApplicationMenu(null)

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
