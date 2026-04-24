'use strict'

// ══════════════════════════════════════════════════════════════════════
//  Mail cache — JSON-backed persistent cache for listMessages() results
//  and full getMessage() payloads. Per-account electron-store file so
//  accounts don't cross-contaminate and deleting an account can wipe its
//  cache in one shot.
//
//  Intentionally NOT SQLite (no native module rebuild, no prebuilt binary
//  pain on Windows). For a mailbox with < ~2000 messages the whole thing
//  deserializes in single-digit milliseconds, which is well within the
//  "instant list" budget. When we outgrow that, swap the storage driver
//  — the read API is narrow enough.
// ══════════════════════════════════════════════════════════════════════

const Store = require('electron-store')

// Keep one Store instance per account, cached here so we don't re-open
// the same JSON file on every read.
const _stores = new Map()

function _storeFor(accountId) {
  if (!accountId) return null
  if (_stores.has(accountId)) return _stores.get(accountId)
  const s = new Store({
    name: `mail-cache-${accountId}`,
    defaults: {
      folders: {},      // { [folderPath]: { messages: [...], cachedAt: ISO } }
      bodies:  {},      // { [folderPath]: { [uid]: { message, cachedAt } } }
    },
  })
  _stores.set(accountId, s)
  return s
}

// ── List cache ──────────────────────────────────────────────────────

function getList(accountId, folder) {
  const s = _storeFor(accountId); if (!s) return null
  const all = s.get('folders') || {}
  const entry = all[folder]
  if (!entry || !Array.isArray(entry.messages)) return null
  return entry  // { messages, cachedAt }
}

function setList(accountId, folder, messages) {
  const s = _storeFor(accountId); if (!s) return
  const all = s.get('folders') || {}
  all[folder] = { messages, cachedAt: new Date().toISOString() }
  s.set('folders', all)
}

// ── Body cache ──────────────────────────────────────────────────────

function getBody(accountId, folder, uid) {
  const s = _storeFor(accountId); if (!s) return null
  const all = s.get('bodies') || {}
  const f = all[folder]; if (!f) return null
  return f[uid] || null  // { message, cachedAt }
}

function setBody(accountId, folder, uid, message) {
  const s = _storeFor(accountId); if (!s) return
  const all = s.get('bodies') || {}
  const f = all[folder] || {}
  f[uid] = { message, cachedAt: new Date().toISOString() }
  // Cap body cache at 200 messages per folder so this doesn't grow
  // without bound. LRU by cachedAt — oldest evicted first.
  const entries = Object.entries(f)
  if (entries.length > 200) {
    entries.sort((a, b) => new Date(a[1].cachedAt) - new Date(b[1].cachedAt))
    const keep = entries.slice(-200)
    all[folder] = Object.fromEntries(keep)
  } else {
    all[folder] = f
  }
  s.set('bodies', all)
}

// ── Invalidation ─────────────────────────────────────────────────────

function clearAccount(accountId) {
  const s = _stores.get(accountId); if (!s) return
  try { s.clear() } catch (_) {}
  _stores.delete(accountId)
}

function clearFolder(accountId, folder) {
  const s = _storeFor(accountId); if (!s) return
  const folders = s.get('folders') || {}
  delete folders[folder]
  s.set('folders', folders)
  const bodies = s.get('bodies') || {}
  delete bodies[folder]
  s.set('bodies', bodies)
}

// Quick equality check between two message-list snapshots to decide
// whether we even need to emit a cache-updated event. Same length +
// same (uid, unread, flagged) per row = nothing user-visible changed.
function listsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (!x || !y) return false
    if (x.uid !== y.uid) return false
    if (!!x.unread !== !!y.unread) return false
    if (!!x.flagged !== !!y.flagged) return false
  }
  return true
}

module.exports = { getList, setList, getBody, setBody, clearAccount, clearFolder, listsEqual }
