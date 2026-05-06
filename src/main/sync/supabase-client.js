'use strict'
// ════════════════════════════════════════════════════════════════════
//  Minimal Supabase RPC client for sync
//
//  We don't need the full @supabase/supabase-js SDK — just four
//  calls: browser_sync_get / get_versions / put / delete_bucket.
//  Hand-rolling avoids a 200KB+ npm dep that pulls in fetch
//  polyfills and realtime websockets we'd never use.
//
//  All requests use Electron's `net.fetch` so they go through the
//  same network stack (proxies, certificate pinning, the same UA
//  rewriting) as the rest of the app.
//
//  Auth: the publishable ("anon") key is included in every request.
//  It's safe to embed in the client because the actual access token
//  is the user's sync_id (128 bits of entropy from the BIP-39
//  mnemonic) — the publishable key just identifies the project.
// ════════════════════════════════════════════════════════════════════

const { net }    = require('electron')
const { Buffer } = require('buffer')

const SUPABASE_URL = 'https://dywyqqtsozbzgjcwoyig.supabase.co'
const ANON_KEY     = 'sb_publishable_hX9mYspfXwb-VRroi-aigg_C28OcO-b'

const RPC_BASE = SUPABASE_URL + '/rest/v1/rpc/'

/**
 * Wire format for ciphertext is plain lowercase hex (no prefix).
 * The server's RPC functions decode/encode internally so PostgREST's
 * ambiguous bytea handling is bypassed entirely. See migration
 * `browser_sync_blobs_text_hex_params` for the rationale.
 */
function _bytesToHex(buf) {
  return buf.toString('hex')
}
function _hexToBytes(s) {
  if (typeof s !== 'string' || !/^[a-f0-9]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error('invalid hex string from server')
  }
  return Buffer.from(s, 'hex')
}

async function _rpc(fn, body) {
  const url = RPC_BASE + fn
  // Debug: dump the request to console (visible in `npm start` terminal
  // and Electron's main-process devtools). Strip ciphertext from the
  // log so we don't write potentially large blobs each call.
  try {
    const safe = { ...body }
    if (safe.p_ciphertext_hex) safe.p_ciphertext_hex = `<hex ${safe.p_ciphertext_hex.length} chars>`
    console.log('[sync.supabase] →', fn, JSON.stringify(safe))
  } catch (_) {}
  let res
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'apikey':        ANON_KEY,
        'Authorization': 'Bearer ' + ANON_KEY,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('[sync.supabase] FETCH-THREW', fn, err && err.message)
    throw new Error(`Supabase RPC ${fn} fetch failed: ${err.message || err}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[sync.supabase] HTTP-FAIL', fn, res.status, text.slice(0, 300))
    throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  console.log('[sync.supabase] ←', fn, JSON.stringify(data).slice(0, 200))
  return data
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch the encrypted blob for a category. Returns null when the
 * bucket doesn't have one (first device after setup, or category
 * never written).
 *
 * @param {string} syncId   32-char hex
 * @param {string} category 'bookmarks' | 'history' | etc
 * @returns {Promise<{ ciphertext: Buffer, version: number, updatedAt: string } | null>}
 */
async function getBlob(syncId, category) {
  const rows = await _rpc('browser_sync_get', { p_sync_id: syncId, p_category: category })
  if (!Array.isArray(rows) || rows.length === 0) return null
  const r = rows[0]
  return {
    ciphertext: _hexToBytes(r.ciphertext_hex),
    version:    Number(r.version),
    updatedAt:  r.updated_at,
  }
}

/**
 * Cheap polling — returns the version of every category in the bucket
 * without downloading any ciphertext. Empty array if the bucket is
 * fresh/empty.
 */
async function getVersions(syncId) {
  const rows = await _rpc('browser_sync_get_versions', { p_sync_id: syncId })
  if (!Array.isArray(rows)) return []
  return rows.map(r => ({
    category:  r.category,
    version:   Number(r.version),
    updatedAt: r.updated_at,
  }))
}

/**
 * Upload an encrypted blob with optimistic concurrency. Pass
 * expectedVersion=null to force-overwrite (used on first push and
 * on full restore).
 *
 * Returns:
 *   - new version number (>= 1) on success
 *   - -1 if the server's version moved past expectedVersion mid-flight;
 *     caller should pull, merge, and retry.
 */
async function putBlob(syncId, category, ciphertext, expectedVersion = null) {
  if (!Buffer.isBuffer(ciphertext)) {
    throw new Error('ciphertext must be a Buffer')
  }
  const result = await _rpc('browser_sync_put', {
    p_sync_id:          syncId,
    p_category:         category,
    p_ciphertext_hex:   _bytesToHex(ciphertext),
    p_expected_version: expectedVersion,
  })
  return Number(result)
}

/**
 * Wipe an entire bucket. Used when the user disables sync from a
 * device or rotates their mnemonic. Returns the row count deleted.
 */
async function deleteBucket(syncId) {
  const result = await _rpc('browser_sync_delete_bucket', { p_sync_id: syncId })
  return Number(result)
}

module.exports = {
  getBlob,
  getVersions,
  putBlob,
  deleteBucket,
}
