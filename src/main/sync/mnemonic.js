'use strict'
// ════════════════════════════════════════════════════════════════════
//  BIP-39 mnemonic + key derivation
//
//  Implements the relevant subset of the BIP-39 spec:
//    https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
//
//  We use 24 words = 256 bits of entropy + 8 bits of checksum =
//  264 bits split into 24 × 11-bit indices into the 2048-word
//  English word list. 256 bits is the maximum the spec allows and
//  is the same length Bitcoin / Ethereum wallets use for HD seeds.
//
//  The mnemonic IS the user's identity. The same 24 words always
//  produce the same encryption key + sync_id. There is no recovery
//  if the user loses the phrase — that's the security property.
//
//  The English word list (bip39-english.txt) is the canonical one
//  sha256 = 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
//  shipped unmodified from bitcoin/bips@master.
// ════════════════════════════════════════════════════════════════════

const crypto       = require('crypto')
const fs           = require('fs')
const path         = require('path')
const { Buffer }   = require('buffer')

let _wordlist = null
let _wordIndex = null   // word → index map for fast validation

function _loadWordlist() {
  if (_wordlist) return _wordlist
  const filePath = path.join(__dirname, 'bip39-english.txt')
  const raw = fs.readFileSync(filePath, 'utf8')
  const words = raw.split(/\r?\n/).map(w => w.trim()).filter(Boolean)
  if (words.length !== 2048) {
    throw new Error(`BIP-39 word list corrupt: expected 2048 words, got ${words.length}`)
  }
  _wordlist = Object.freeze(words)
  _wordIndex = new Map()
  words.forEach((w, i) => _wordIndex.set(w, i))
  return _wordlist
}

// Public — for the renderer's autocomplete on the restore screen.
function wordlist() {
  return _loadWordlist()
}

// ── Bit-level helpers ─────────────────────────────────────────────

// Convert a Buffer to a long binary string (e.g. 32 bytes → 256 bits).
function _bytesToBits(buf) {
  let bits = ''
  for (const byte of buf) {
    bits += byte.toString(2).padStart(8, '0')
  }
  return bits
}

// Convert a long binary string (multiple of 8) back to a Buffer.
function _bitsToBytes(bits) {
  if (bits.length % 8 !== 0) {
    throw new Error('bit string length must be multiple of 8')
  }
  const out = Buffer.alloc(bits.length / 8)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  }
  return out
}

// ── Generate / encode / decode ────────────────────────────────────

/**
 * Generate a fresh 24-word mnemonic from 256 bits of OS-level entropy.
 * @returns {string} 24 words separated by single spaces, lowercase
 */
function generate() {
  const entropy = crypto.randomBytes(32)   // 256 bits
  return entropyToMnemonic(entropy)
}

/**
 * Convert 256 bits of entropy → 24 words. Throws if entropy length
 * isn't 32 bytes (we only support the 24-word variant).
 */
function entropyToMnemonic(entropy) {
  if (!Buffer.isBuffer(entropy)) entropy = Buffer.from(entropy)
  if (entropy.length !== 32) {
    throw new Error(`entropy must be 32 bytes (got ${entropy.length})`)
  }
  const words = _loadWordlist()
  const entropyBits = _bytesToBits(entropy)
  // Checksum = first ENT/32 bits of SHA-256(entropy). For 256 bits, that's 8 bits.
  const hash = crypto.createHash('sha256').update(entropy).digest()
  const checksumBits = _bytesToBits(hash).slice(0, 8)
  const fullBits = entropyBits + checksumBits   // 264 bits
  const out = []
  for (let i = 0; i < fullBits.length; i += 11) {
    const idx = parseInt(fullBits.slice(i, i + 11), 2)
    out.push(words[idx])
  }
  return out.join(' ')
}

/**
 * Validate a 24-word mnemonic. Returns { ok, error } so callers can
 * surface a helpful message on the restore screen.
 *
 * Catches:
 *   - wrong word count
 *   - unknown words (typos, swapped languages)
 *   - bad checksum (one word changed but valid in the dictionary)
 */
function validate(mnemonic) {
  if (typeof mnemonic !== 'string') {
    return { ok: false, error: 'Sync-koden måste vara en sträng.' }
  }
  const words = mnemonic.trim().toLowerCase().split(/\s+/)
  if (words.length !== 24) {
    return { ok: false, error: `Sync-koden ska vara 24 ord, du har ${words.length}.` }
  }
  _loadWordlist()
  for (let i = 0; i < words.length; i++) {
    if (!_wordIndex.has(words[i])) {
      return { ok: false, error: `Ord ${i + 1} ("${words[i]}") finns inte i ord-listan.` }
    }
  }
  // Re-derive checksum and verify.
  const fullBits = words.map(w => _wordIndex.get(w).toString(2).padStart(11, '0')).join('')
  const entropyBits  = fullBits.slice(0, 256)
  const checksumBits = fullBits.slice(256)
  const entropy = _bitsToBytes(entropyBits)
  const expected = _bytesToBits(crypto.createHash('sha256').update(entropy).digest()).slice(0, 8)
  if (expected !== checksumBits) {
    return { ok: false, error: 'Sync-koden har fel kontrollsumma — något ord är troligen fel-skrivet.' }
  }
  return { ok: true }
}

/**
 * Mnemonic → 64-byte seed (per BIP-39 §"From mnemonic to seed").
 * We don't support the optional passphrase.
 */
function mnemonicToSeed(mnemonic) {
  const v = validate(mnemonic)
  if (!v.ok) throw new Error(v.error)
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
  // Per spec: salt = "mnemonic" + passphrase. Empty passphrase → "mnemonic".
  return crypto.pbkdf2Sync(
    Buffer.from(normalized, 'utf8'),
    Buffer.from('mnemonic', 'utf8'),
    2048,        // iterations per spec
    64,          // 512-bit output
    'sha512',
  )
}

/**
 * Seed → (sync_id, encryption_key) via HKDF-SHA256.
 *
 * Returns:
 *   syncId : 32-char lowercase hex (16 bytes / 128 bits) — bucket address
 *   encKey : 32-byte Buffer                                — AES-256-GCM key
 *
 * Domain separation: identical seed but different `info` strings yield
 * independent keys. Changing the salt would invalidate every existing
 * sync setup, so it's frozen at "seoz-sync-v1".
 */
function deriveKeys(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 64) {
    throw new Error('seed must be a 64-byte Buffer')
  }
  const SALT = Buffer.from('seoz-sync-v1', 'utf8')
  const syncIdBytes = Buffer.from(crypto.hkdfSync('sha256', seed, SALT, Buffer.from('sync-id', 'utf8'), 16))
  const encKey      = Buffer.from(crypto.hkdfSync('sha256', seed, SALT, Buffer.from('enc-key', 'utf8'), 32))
  return { syncId: syncIdBytes.toString('hex'), encKey }
}

/**
 * Convenience: full pipeline from mnemonic to keys.
 */
function mnemonicToKeys(mnemonic) {
  return deriveKeys(mnemonicToSeed(mnemonic))
}

module.exports = {
  wordlist,
  generate,
  validate,
  entropyToMnemonic,
  mnemonicToSeed,
  deriveKeys,
  mnemonicToKeys,
}
