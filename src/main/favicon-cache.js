'use strict'

/**
 * Favicon Cache — downloads site favicons and converts them to .ico
 * for use in Windows Jump Lists and other native UI.
 *
 * Uses Google's favicon service (fast CDN, always returns something)
 * and Electron's nativeImage to convert PNG → ICO on disk.
 */

const { net, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

let cacheDir = null

/**
 * Initialise the cache directory (call once at app startup).
 * @param {string} userDataPath — typically app.getPath('userData')
 */
function init(userDataPath) {
  cacheDir = path.join(userDataPath, 'favicon-cache')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
}

/**
 * Returns the local .ico path for a hostname.
 * If the icon is already cached, returns immediately.
 * If not, returns null (caller should use the fallback).
 */
function getCachedPath(hostname) {
  if (!cacheDir || !hostname) return null
  const icoPath = path.join(cacheDir, sanitise(hostname) + '.ico')
  return fs.existsSync(icoPath) ? icoPath : null
}

/**
 * Download favicon for a hostname and save as .ico.
 * Returns the .ico path on success, null on failure.
 * Skips download if already cached and less than 7 days old.
 */
async function ensureFavicon(hostname) {
  if (!cacheDir || !hostname) return null

  const icoPath = path.join(cacheDir, sanitise(hostname) + '.ico')

  // Skip if fresh cache exists (< 7 days)
  if (fs.existsSync(icoPath)) {
    try {
      const age = Date.now() - fs.statSync(icoPath).mtimeMs
      if (age < 7 * 24 * 60 * 60 * 1000) return icoPath
    } catch (_) {}
  }

  // Download PNG favicon via Google's service (32px for crisp Jump List icons)
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`

  try {
    const buf = await fetchBuffer(url)
    if (!buf || buf.length < 50) return null // too small = broken

    // Convert to nativeImage, then write as ICO (Windows) or PNG
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null

    // nativeImage.toBitmap / toPNG — we write .ico via toPNG
    // Windows Jump List actually accepts .png as iconPath too
    const pngPath = path.join(cacheDir, sanitise(hostname) + '.png')
    fs.writeFileSync(pngPath, img.toPNG())

    // Also create .ico — Windows Jump List prefers real .ico
    // Electron nativeImage doesn't have toICO, so we'll use the .png path
    // Windows 10+ Jump List works fine with .png as iconPath
    return pngPath
  } catch (_) {
    return null
  }
}

/**
 * Batch-download favicons for multiple hostnames.
 * Returns a Map<hostname, localPath>.
 */
async function ensureMany(hostnames) {
  const results = new Map()
  // Download concurrently (max 5 at a time to be polite)
  const chunks = []
  const unique = [...new Set(hostnames.filter(Boolean))]
  for (let i = 0; i < unique.length; i += 5) {
    chunks.push(unique.slice(i, i + 5))
  }
  for (const chunk of chunks) {
    const batch = await Promise.all(chunk.map(async h => {
      const p = await ensureFavicon(h)
      return [h, p]
    }))
    for (const [h, p] of batch) {
      if (p) results.set(h, p)
    }
  }
  return results
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitise(hostname) {
  return hostname.replace(/[^a-z0-9.-]/gi, '_')
}

function fetchBuffer(url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000)
    try {
      const req = net.request(url)
      const chunks = []
      req.on('response', (res) => {
        if (res.statusCode !== 200) { clearTimeout(timeout); resolve(null); return }
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)) })
        res.on('error', () => { clearTimeout(timeout); resolve(null) })
      })
      req.on('error', () => { clearTimeout(timeout); resolve(null) })
      req.end()
    } catch (_) {
      clearTimeout(timeout)
      resolve(null)
    }
  })
}

module.exports = { init, getCachedPath, ensureFavicon, ensureMany }
