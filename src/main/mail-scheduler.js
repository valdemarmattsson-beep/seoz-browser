'use strict'

// ══════════════════════════════════════════════════════════════════════
//  Mail scheduler — persistent queue for "Send later" + "Snooze".
//
//  Both features boil down to: store an action locally, fire it when a
//  wall-clock time arrives. Queue lives in electron-store so scheduled
//  items survive app restarts. We poll every 30 s for due items —
//  granularity is fine for mail, and cheaper than one setTimeout per
//  pending item (which would also not survive restarts).
//
//  Actions:
//   • send  — queued outgoing mail
//             { id, kind:'send', accountId, sendAt, mailOpts }
//   • snooze — an incoming message to restore to INBOX at wakeAt
//             { id, kind:'snooze', accountId, uid, wakeAt, originalFolder }
// ══════════════════════════════════════════════════════════════════════

const Store = require('electron-store')
const crypto = require('crypto')

const store = new Store({
  name: 'mail-scheduler',
  defaults: { queue: [] },
})

let _tickHandle = null
let _handlers = {}    // { send: async(entry), snooze: async(entry) }

function _genId() { return crypto.randomBytes(6).toString('hex') }

function list() { return store.get('queue', []) }
function _save(q) { store.set('queue', q) }

function add(entry) {
  const q = list()
  const full = { id: _genId(), addedAt: new Date().toISOString(), ...entry }
  q.push(full)
  _save(q)
  return full
}

function remove(id) {
  _save(list().filter(e => e.id !== id))
}

function listByAccount(accountId) {
  return list().filter(e => e.accountId === accountId)
}

async function _tick() {
  const now = Date.now()
  const q = list()
  const due = q.filter(e => {
    const at = e.sendAt || e.wakeAt
    return at && new Date(at).getTime() <= now
  })
  if (!due.length) return
  const remaining = q.filter(e => !due.includes(e))
  _save(remaining)
  for (const entry of due) {
    try {
      const fn = _handlers[entry.kind]
      if (fn) await fn(entry)
    } catch (err) {
      console.warn('[scheduler] handler failed for', entry.id, err?.message || err)
      // On failure we DON'T re-queue — the handler is expected to log,
      // and silently retrying forever would hide real problems.
    }
  }
}

function setHandler(kind, fn) { _handlers[kind] = fn }

function start() {
  if (_tickHandle) return
  _tickHandle = setInterval(() => { _tick().catch(() => {}) }, 30 * 1000)
  // Run once at startup so any items that came due while the app was
  // closed fire immediately instead of waiting 30 s.
  setTimeout(() => _tick().catch(() => {}), 1000)
}

function stop() {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null }
}

module.exports = { list, listByAccount, add, remove, setHandler, start, stop }
