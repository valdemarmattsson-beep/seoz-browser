'use strict'
// ════════════════════════════════════════════════════════════════════
//  Chromium-history importer.
//
//  Chrome / Edge / Brave / Opera / Vivaldi store browsing history in
//  a SQLite DB at `<profile>/History`. Schema (relevant parts):
//
//    CREATE TABLE urls (
//      id INTEGER PRIMARY KEY,
//      url LONGVARCHAR,
//      title LONGVARCHAR,
//      visit_count INTEGER DEFAULT 0 NOT NULL,
//      typed_count INTEGER DEFAULT 0 NOT NULL,
//      last_visit_time INTEGER NOT NULL,   -- Chromium time (µs since 1601-01-01)
//      hidden INTEGER DEFAULT 0 NOT NULL
//    )
//
//  We use sql.js (pure-JS WASM SQLite) to avoid the native-module
//  rebuild dance. One-time import perf is fine — sql.js reads the
//  whole DB into memory but Chrome's History is typically 5-50 MB.
//
//  IMPORTANT: Chrome locks the History file while running. We copy
//  the file to a temp location before opening so the source DB
//  isn't disturbed and we don't trip Chrome's WAL locks.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs')
const path = require('path')
const os   = require('os')

let _SQL = null   // memoised SQL.js engine (loaded on first call)

async function _ensureSqlJs() {
  if (_SQL) return _SQL
  // sql.js exposes an init function. WASM file lives in the
  // package's dist/ directory — locateFile resolves it for the
  // engine. We can't `require.resolve('sql.js/package.json')` because
  // sql.js v1.14 declares `exports` and forbids subpath access; use
  // the main entrypoint resolve and walk up to the package root.
  const initSqlJs = require('sql.js')
  const mainPath = require.resolve('sql.js')           // …/sql.js/dist/sql-wasm.js
  const distDir  = path.dirname(mainPath)              // …/sql.js/dist
  _SQL = await initSqlJs({
    locateFile: (file) => path.join(distDir, file),
  })
  return _SQL
}

function _chromeMicrosecondsToISO(us) {
  if (!us) return null
  const n = Number(us)
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = (n / 1000) - 11644473600000
  if (ms <= 0) return null
  try { return new Date(ms).toISOString() } catch (_) { return null }
}

/**
 * Copy the source DB to a temp file so sql.js can open it without
 * fighting Chrome's lock. Returns the temp path; caller is
 * responsible for cleanup but we also schedule it ourselves.
 */
function _copyToTemp(srcPath) {
  const tmp = path.join(os.tmpdir(), `seoz-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`)
  fs.copyFileSync(srcPath, tmp)
  return tmp
}

/**
 * Import history from a Chromium History DB.
 * @param {string} historyPath
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=90]   only include entries newer than this
 * @param {number} [opts.maxRows=5000]    cap to avoid blowing up SEOZ's storage
 * @returns {Promise<{ ok: boolean, history?: Array, stats?: object, error?: string }>}
 */
async function importFromFile(historyPath, opts = {}) {
  const { maxAgeDays = 90, maxRows = 5000 } = opts
  if (!fs.existsSync(historyPath)) {
    return { ok: false, error: 'History-filen finns inte' }
  }

  let tmpPath = null
  try {
    tmpPath = _copyToTemp(historyPath)
    const buf = fs.readFileSync(tmpPath)
    const SQL = await _ensureSqlJs()
    const db = new SQL.Database(buf)

    // Filter by age + non-hidden + has a title (skip raw URL-only
    // history rows that don't make sense in a UI list). Order by
    // last_visit_time DESC so the cap takes the freshest rows.
    //
    // Chromium time = µs since 1601-01-01. We compute the cutoff
    // server-side to avoid pulling rows we'll throw away.
    const cutoffMsUnix = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)
    const cutoffChrome = (cutoffMsUnix + 11644473600000) * 1000
    const stmt = db.prepare(`
      SELECT url, title, visit_count, last_visit_time
        FROM urls
       WHERE hidden = 0
         AND title IS NOT NULL AND title <> ''
         AND last_visit_time > $cutoff
       ORDER BY last_visit_time DESC
       LIMIT $limit
    `)
    stmt.bind({ $cutoff: cutoffChrome, $limit: maxRows })

    const out = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      out.push({
        url:    row.url,
        title:  row.title,
        time:   _chromeTimeToUnix(row.last_visit_time),
        visits: Number(row.visit_count) || 0,
      })
    }
    stmt.free()
    db.close()

    return {
      ok: true,
      history: out,
      stats: { kept: out.length, maxAgeDays, maxRows },
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath) } catch (_) {}
    }
  }
}

function _chromeTimeToUnix(us) {
  const n = Number(us)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  const ms = (n / 1000) - 11644473600000
  return ms > 0 ? Math.floor(ms) : Date.now()
}

/**
 * Convert imported rows to the SEOZ browsingHistory format used
 * by the renderer (see loadHistory in index.html). Same shape used
 * elsewhere: { title, url, favicon, time }.
 */
function toSeozFormat(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map(r => ({
    title:   String(r.title || r.url || ''),
    url:     String(r.url || ''),
    favicon: '',     // Chrome's favicons live in a separate DB; skip for now
    time:    Number(r.time) || Date.now(),
  })).filter(r => r.url)
}

module.exports = { importFromFile, toSeozFormat }
