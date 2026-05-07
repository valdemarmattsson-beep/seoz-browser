'use strict'
// ════════════════════════════════════════════════════════════════════
//  Sync engine — high-level orchestrator
//
//  Owns the sync lifecycle for the active profile:
//
//    enable()    — generate fresh mnemonic, derive keys, persist
//                  encrypted mnemonic + sync_id, push every registered
//                  category
//    restore()   — accept user-supplied mnemonic, derive same keys,
//                  pull every category that exists in the bucket and
//                  hand the plaintext to the matching category adapter
//                  for local merge / overwrite
//    disable()   — wipe local mnemonic + sync_id; OPTIONALLY wipe the
//                  remote bucket too (when initiated by the user via
//                  "stop syncing on all devices")
//    pushAll()   — re-encrypt every dirty category and upload with
//                  optimistic concurrency
//    pullAll()   — fetch versions, download anything we don't have,
//                  decrypt, hand to category adapters
//    pushOne(cat)/ pullOne(cat) — single-category variants used by
//                  category code on local change
//
//  Categories are pluggable. A category adapter has the shape:
//    {
//      key:        'bookmarks',
//      collect():  Promise<unknown>     // current local state → JSON-serialisable
//      apply(obj): Promise<void>        // remote state → write to local store
//    }
//  The engine handles encryption/transport; adapters handle the
//  domain logic ("how do I list bookmarks?", "how do I overwrite
//  bookmarks safely?").
// ════════════════════════════════════════════════════════════════════

const { app, safeStorage } = require('electron')
const { Buffer }           = require('buffer')
const fs                   = require('fs')
const path                 = require('path')

const mnemonic     = require('./mnemonic')
const cryptoBlob   = require('./crypto')
const supabase     = require('./supabase-client')

// Diagnostic log — every push/pull attempt and any error lands here.
// Sits next to startup.log in userData so the user can grep it without
// dev tools. Auto-trimmed when it grows past 256 KB.
let _logPath = null
function _resolveLogPath() {
  if (_logPath) return _logPath
  try { _logPath = path.join(app.getPath('userData'), 'sync.log') } catch (_) {}
  return _logPath
}
function _log(line) {
  const p = _resolveLogPath()
  if (!p) return
  try {
    const ts = new Date().toISOString()
    fs.appendFileSync(p, `${ts} ${line}\n`)
    // Trim if it grows past 256 KB.
    try {
      const st = fs.statSync(p)
      if (st.size > 256 * 1024) {
        const head = fs.readFileSync(p, 'utf8').split('\n').slice(-1500).join('\n')
        fs.writeFileSync(p, head)
      }
    } catch (_) {}
  } catch (_) {}
}

// Category adapters are registered at construction so the engine
// stays decoupled from PM / bookmark internals. main.js wires them
// up after PM is ready.
class SyncEngine {
  /**
   * @param {object} opts
   * @param {object} opts.PM               profile-manager instance (read/write per-profile state)
   * @param {function} opts.onStatus       optional UI callback(stateObj)
   */
  constructor({ PM, onStatus }) {
    this.PM = PM
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {}
    /** @type {Map<string, {key:string, collect:Function, apply:Function}>} */
    this.categories = new Map()
    // In-memory only. Re-derived from the encrypted mnemonic on
    // every `_loadState()`. Never persisted in plaintext.
    this._encKey  = null
    this._syncId  = null
    this._enabled = false
    // Auto-sync state — enabled by default once the user has set up
    // sync. Default cadence is "60 seconds when window is focused".
    // Concurrent calls are coalesced via _autoBusy so a slow network
    // response can't pile up overlapping pulls.
    this._autoTimer    = null
    this._autoBusy     = false
    // 5 min default — earlier 60s polled too aggressively for our
    // workload. getVersions is cheap (~200 B) but the chatter
    // crowded the supabase log when nothing was actually changing.
    this._autoIntervalMs = 5 * 60 * 1000
    this._autoEnabled  = true   // user-configurable later via setAutoSync
  }

  registerCategory(adapter) {
    if (!adapter || !adapter.key || typeof adapter.collect !== 'function' || typeof adapter.apply !== 'function') {
      throw new Error('SyncEngine.registerCategory: adapter must have { key, collect(), apply() }')
    }
    this.categories.set(adapter.key, adapter)
  }

  // ── State persistence ───────────────────────────────────────────

  /**
   * Sync state lives under the active profile. Schema:
   *   sync.enabled           boolean
   *   sync.syncIdHex         32 hex chars (also derivable from mnemonic — kept for fast UI)
   *   sync.mnemonicEnc       safeStorage ciphertext of the mnemonic phrase
   *   sync.versions          { [category]: lastSeenVersion }
   *   sync.lastSyncAt        ISO timestamp
   */
  _read() {
    const s = this.PM.profileGet('sync', null)
    return s && typeof s === 'object' ? s : { enabled: false, versions: {}, lastSyncAt: null }
  }
  _write(s) {
    this.PM.profileSet('sync', s)
  }

  /**
   * Pull encrypted mnemonic from store, decrypt, derive keys, hold
   * them in memory. Idempotent — safe to call multiple times.
   *
   * Throws if sync is disabled or the stored mnemonic is corrupt.
   */
  _loadKeys() {
    if (this._encKey && this._syncId) return
    const s = this._read()
    if (!s.enabled || !s.mnemonicEnc) throw new Error('sync is not enabled for this profile')
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level safeStorage is not available; sync requires it')
    }
    const phrase = safeStorage.decryptString(Buffer.from(s.mnemonicEnc, 'base64'))
    const keys = mnemonic.mnemonicToKeys(phrase)
    this._encKey = keys.encKey
    this._syncId = keys.syncId
    this._enabled = true
  }

  isEnabled() {
    return this._read().enabled === true
  }

  /**
   * Get the user-visible sync info — never returns the mnemonic or
   * the encryption key, only the public-safe identifiers.
   */
  getStatus() {
    const s = this._read()
    return {
      enabled:    !!s.enabled,
      syncIdHex:  s.syncIdHex || null,
      lastSyncAt: s.lastSyncAt || null,
      versions:   { ...(s.versions || {}) },
      categories: Array.from(this.categories.keys()),
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Generate a fresh mnemonic, persist (encrypted) on this device,
   * push all current category data.
   *
   * Returns the plaintext mnemonic ONCE so the renderer can show it
   * for backup. After this call returns it must never be retrievable
   * again — only re-derivable by the user re-entering it.
   *
   * @returns {Promise<{ mnemonic: string, syncId: string }>}
   */
  async enable() {
    if (this._read().enabled) {
      throw new Error('sync is already enabled — disable first to rotate the mnemonic')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level safeStorage is unavailable; cannot store the sync key safely')
    }
    const phrase = mnemonic.generate()
    const keys = mnemonic.mnemonicToKeys(phrase)
    this._encKey = keys.encKey
    this._syncId = keys.syncId
    this._enabled = true
    const enc = safeStorage.encryptString(phrase).toString('base64')
    this._write({
      enabled:     true,
      syncIdHex:   keys.syncId,
      mnemonicEnc: enc,
      versions:    {},
      lastSyncAt:  new Date().toISOString(),
    })
    this.onStatus(this.getStatus())
    // Push everything we have so the bucket is populated immediately.
    // pushAll() swallows per-category errors (so partial success is
    // possible). We bubble them up here so the renderer can surface
    // them — the mnemonic is still safe to show either way, since the
    // user MUST save it before any sync can ever work.
    const pushResult = await this.pushAll()
    // Kick auto-sync the moment setup is complete so other devices
    // converge without the user ever clicking "Synka nu".
    this.startAutoSync()
    return {
      mnemonic: phrase,
      syncId:   keys.syncId,
      pushed:   pushResult.pushed,
      errors:   pushResult.errors,
    }
  }

  /**
   * Accept a user-supplied mnemonic, derive the same keys, pull every
   * category from the bucket. Each category adapter's apply() decides
   * how to merge with whatever's already locally (typically: replace
   * for first-restore, merge for subsequent runs).
   *
   * Throws on invalid mnemonic (bad checksum, wrong word count, etc.)
   * before touching local state — caller can show the error.
   */
  async restore(phrase) {
    const v = mnemonic.validate(phrase)
    if (!v.ok) throw new Error(v.error)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level safeStorage is unavailable; cannot store the sync key safely')
    }
    const keys = mnemonic.mnemonicToKeys(phrase)
    // Tentatively set in-memory keys so pull calls work.
    this._encKey  = keys.encKey
    this._syncId  = keys.syncId
    this._enabled = true
    const enc = safeStorage.encryptString(phrase.trim()).toString('base64')
    // Persist BEFORE pulling — if the user closes the app mid-pull
    // we'll resume next launch.
    this._write({
      enabled:     true,
      syncIdHex:   keys.syncId,
      mnemonicEnc: enc,
      versions:    {},
      lastSyncAt:  null,
    })
    this.onStatus(this.getStatus())
    const result = await this.pullAll()
    this.startAutoSync()
    return { syncId: keys.syncId, pulled: result.pulled, errors: result.errors }
  }

  /**
   * Stop syncing on this device. Local data is untouched (it's
   * cleartext on disk anyway). If wipeBucket=true, also nuke the
   * remote bucket so other devices see "sync disabled".
   */
  async disable({ wipeBucket = false } = {}) {
    this.stopAutoSync()
    let removed = 0
    if (wipeBucket) {
      try {
        this._loadKeys()
        removed = await supabase.deleteBucket(this._syncId)
      } catch (_) {}
    }
    this._encKey = null
    this._syncId = null
    this._enabled = false
    this._write({ enabled: false, versions: {}, lastSyncAt: null })
    this.onStatus(this.getStatus())
    return { ok: true, remoteRowsRemoved: removed }
  }

  // ── Push / pull ────────────────────────────────────────────────

  /**
   * Push one category. expectedVersion comes from local state so the
   * server can detect a concurrent write from another device. On
   * conflict we pull-then-retry once; if it still conflicts the user
   * has two devices writing simultaneously and we surface that.
   */
  async pushOne(category) {
    this._loadKeys()
    const adapter = this.categories.get(category)
    if (!adapter) throw new Error(`no sync adapter registered for "${category}"`)
    _log(`pushOne ${category} sync_id=${this._syncId.slice(0,8)}…`)
    try {
      const data = await adapter.collect()
      const blob = cryptoBlob.encryptJSON(this._encKey, category, data)
      _log(`pushOne ${category} encrypted=${blob.length}B`)
      const s = this._read()
      const expected = s.versions?.[category] || null
      let newVersion = await supabase.putBlob(this._syncId, category, blob, expected)
      _log(`pushOne ${category} put returned version=${newVersion}`)
      if (newVersion === -1) {
        await this.pullOne(category)
        const dataAfter = await adapter.collect()
        const blobAfter = cryptoBlob.encryptJSON(this._encKey, category, dataAfter)
        newVersion = await supabase.putBlob(this._syncId, category, blobAfter, null)
        _log(`pushOne ${category} retry-put returned version=${newVersion}`)
      }
      this._setVersion(category, newVersion)
      return { category, version: newVersion }
    } catch (err) {
      _log(`pushOne ${category} FAILED: ${err.message || err}`)
      throw err
    }
  }

  async pushAll() {
    const results = []
    const errors  = []
    for (const cat of this.categories.keys()) {
      try { results.push(await this.pushOne(cat)) }
      catch (err) { errors.push({ category: cat, error: err.message || String(err) }) }
    }
    this._touch()
    return { pushed: results, errors }
  }

  async pullOne(category) {
    this._loadKeys()
    const adapter = this.categories.get(category)
    if (!adapter) throw new Error(`no sync adapter registered for "${category}"`)
    _log(`pullOne ${category} sync_id=${this._syncId.slice(0,8)}…`)
    try {
      const blob = await supabase.getBlob(this._syncId, category)
      if (!blob) {
        _log(`pullOne ${category} bucket empty`)
        return { category, version: 0, applied: false }
      }
      _log(`pullOne ${category} got=${blob.ciphertext.length}B v${blob.version}`)
      const data = cryptoBlob.decryptJSON(this._encKey, category, blob.ciphertext)
      await adapter.apply(data)
      this._setVersion(category, blob.version)
      return { category, version: blob.version, applied: true }
    } catch (err) {
      _log(`pullOne ${category} FAILED: ${err.message || err}`)
      throw err
    }
  }

  async pullAll() {
    this._loadKeys()
    const versions = await supabase.getVersions(this._syncId)
    const remoteHas = new Set(versions.map(v => v.category))
    const results = []
    const errors  = []
    for (const cat of this.categories.keys()) {
      if (!remoteHas.has(cat)) continue
      try { results.push(await this.pullOne(cat)) }
      catch (err) { errors.push({ category: cat, error: err.message || String(err) }) }
    }
    this._touch()
    return { pulled: results, errors }
  }

  // ── Internal ───────────────────────────────────────────────────

  _setVersion(category, version) {
    const s = this._read()
    s.versions = s.versions || {}
    s.versions[category] = Number(version) || 0
    this._write(s)
  }

  _touch() {
    const s = this._read()
    s.lastSyncAt = new Date().toISOString()
    this._write(s)
    this.onStatus(this.getStatus())
  }

  // ── Auto-sync ────────────────────────────────────────────────
  //
  // Public API:
  //   startAutoSync(intervalMs?)  — begin periodic getVersions polls
  //   stopAutoSync()              — stop the timer (no-op if not running)
  //   pullChanged()               — one-shot: pull only categories where
  //                                  the server has a newer version than
  //                                  our local lastSeen
  //   pushAllNow()                — alias for pushAll, used by main.js
  //                                  on window blur / app quit to flush
  //
  // Why pullChanged instead of pullAll on every tick: the wire cost of
  // pulling all six categories every 60s is ~1-3 KB even when nothing
  // changed (each blob roundtrips through encryption + decryption). The
  // getVersions call is ~200 bytes and lets us pull only the deltas.

  startAutoSync(intervalMs) {
    this.stopAutoSync()
    if (typeof intervalMs === 'number' && intervalMs >= 5000) {
      this._autoIntervalMs = intervalMs
    }
    if (!this._autoEnabled) return
    if (!this.isEnabled()) return  // can't auto-sync without a key
    _log(`autoSync start interval=${this._autoIntervalMs}ms`)
    // Fire one tick immediately so we converge fast on app start /
    // focus regain. Subsequent ticks fire on the interval.
    this.pullChanged().catch(() => {})
    this._autoTimer = setInterval(() => {
      this.pullChanged().catch(() => {})
    }, this._autoIntervalMs)
  }

  stopAutoSync() {
    if (this._autoTimer) {
      clearInterval(this._autoTimer)
      this._autoTimer = null
      _log('autoSync stop')
    }
  }

  setAutoSyncEnabled(on) {
    this._autoEnabled = !!on
    if (on) this.startAutoSync()
    else    this.stopAutoSync()
  }

  /**
   * Cheap delta-pull: ask the server which versions exist for our
   * bucket, compare against our local lastSeen versions, and pull
   * only the categories that moved forward. No-op if our copy is
   * already current.
   */
  async pullChanged() {
    if (!this.isEnabled()) return { pulled: [], errors: [] }
    if (this._autoBusy) return { pulled: [], errors: [], skipped: true }
    this._autoBusy = true
    const results = []
    const errors  = []
    try {
      this._loadKeys()
      const remote = await supabase.getVersions(this._syncId)
      const local = this._read().versions || {}
      for (const r of remote) {
        const cat = r.category
        if (!this.categories.has(cat)) continue
        const localV = Number(local[cat] || 0)
        const remoteV = Number(r.version || 0)
        if (remoteV > localV) {
          try { results.push(await this.pullOne(cat)) }
          catch (err) { errors.push({ category: cat, error: err.message || String(err) }) }
        }
      }
      if (results.length) this._touch()
    } catch (err) {
      _log(`pullChanged outer-err: ${err.message || err}`)
    } finally {
      this._autoBusy = false
    }
    return { pulled: results, errors }
  }
}

module.exports = { SyncEngine }
