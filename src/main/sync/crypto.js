'use strict'
// ════════════════════════════════════════════════════════════════════
//  AES-256-GCM blob encryption for sync payloads
//
//  Layout of an encrypted blob (raw bytes):
//
//    +--------+------------------+----------+----------------+
//    | 1 byte | 12 bytes         | N bytes  | 16 bytes       |
//    +--------+------------------+----------+----------------+
//    | ver=1  | random IV/nonce  | cipher   | GCM auth tag   |
//    +--------+------------------+----------+----------------+
//
//  Total overhead: 29 bytes per blob. The version byte lets us swap
//  algorithms in the future without breaking deployed devices —
//  decrypt() refuses unknown versions so we can detect format drift.
//
//  Authenticated additional data (AAD) = ASCII("seoz-sync-v1|" + category)
//  so a blob encrypted for one category can't be silently swapped into
//  another category server-side.
// ════════════════════════════════════════════════════════════════════

const crypto     = require('crypto')
const { Buffer } = require('buffer')

const VERSION    = 0x01
const IV_LEN     = 12
const TAG_LEN    = 16
const AAD_PREFIX = 'seoz-sync-v1|'

function _aad(category) {
  return Buffer.from(AAD_PREFIX + String(category || ''), 'utf8')
}

/**
 * Encrypt arbitrary plaintext (Buffer or string).
 *
 * @param {Buffer} encKey   32-byte key from mnemonic.deriveKeys
 * @param {string} category 'bookmarks' | 'history' | etc — bound into AAD
 * @param {string|Buffer} plaintext
 * @returns {Buffer} encrypted blob (1 + 12 + N + 16 bytes)
 */
function encryptBlob(encKey, category, plaintext) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32) {
    throw new Error('encKey must be a 32-byte Buffer')
  }
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv)
  cipher.setAAD(_aad(category))
  const ct  = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag])
}

/**
 * Decrypt a blob produced by encryptBlob. Throws on:
 *   - unknown version byte
 *   - tag mismatch (wrong key, tampering, or wrong category)
 *
 * @param {Buffer} encKey
 * @param {string} category — must match the value used at encryption
 * @param {Buffer} blob
 * @returns {Buffer} plaintext
 */
function decryptBlob(encKey, category, blob) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32) {
    throw new Error('encKey must be a 32-byte Buffer')
  }
  if (!Buffer.isBuffer(blob) || blob.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('blob is too short to be a valid encrypted payload')
  }
  const version = blob[0]
  if (version !== VERSION) {
    throw new Error(`unsupported sync blob version: 0x${version.toString(16)}`)
  }
  const iv  = blob.subarray(1, 1 + IV_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const ct  = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv)
  decipher.setAAD(_aad(category))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/**
 * Convenience: JSON object → encrypted blob.
 */
function encryptJSON(encKey, category, obj) {
  return encryptBlob(encKey, category, JSON.stringify(obj))
}

/**
 * Convenience: encrypted blob → parsed JSON.
 */
function decryptJSON(encKey, category, blob) {
  const pt = decryptBlob(encKey, category, blob)
  return JSON.parse(pt.toString('utf8'))
}

module.exports = {
  VERSION,
  encryptBlob,
  decryptBlob,
  encryptJSON,
  decryptJSON,
}
