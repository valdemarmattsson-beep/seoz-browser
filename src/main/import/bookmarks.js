'use strict'
// ════════════════════════════════════════════════════════════════════
//  Chromium-bookmark importer.
//
//  Format reference (stable across Chrome / Edge / Brave / Opera /
//  Vivaldi / Arc):
//    {
//      checksum: "...",
//      roots: {
//        bookmark_bar: { name, type:'folder', children: [...] },
//        other:        { name, type:'folder', children: [...] },
//        synced:       { name, type:'folder', children: [...] },
//      },
//      version: 1,
//    }
//
//  Each child is either:
//    { type: 'url',    name, url, date_added, date_last_used? }
//    { type: 'folder', name, children, date_added }
//
//  We flatten into SEOZ's two-key schema:
//    bookmarks    = [{ id, title, url, favicon, folder?, addedAt }, ...]
//    bmFolders    = ['Folder A', 'Folder B', ...]   (flat list of names)
//
//  SEOZ doesn't (yet) support nested folders — Chrome subfolders get
//  flattened with " / " join in the folder name so the user can see
//  the original hierarchy (e.g. "Work / Marketing / Q3").
// ════════════════════════════════════════════════════════════════════

const fs = require('fs')

/**
 * Read + parse a Chromium Bookmarks JSON file. Returns null on
 * unreadable / malformed files.
 */
function _readBookmarksFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (_) { return null }
}

/**
 * Flatten one Chromium roots[X] subtree into our flat-list schema.
 * `pathSegments` carries the folder-name stack so subfolders inherit
 * their parent's name with " / " separator. Items with no folder
 * (top-level under bookmark_bar / other) end up with folder=undefined.
 */
function _flattenSubtree(node, pathSegments, out) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'folder') {
    const childPath = pathSegments.concat(String(node.name || '').trim()).filter(Boolean)
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) _flattenSubtree(child, childPath, out)
    return
  }
  if (node.type === 'url' && typeof node.url === 'string') {
    const folderPath = pathSegments.filter(Boolean).join(' / ')
    out.push({
      title:   String(node.name || node.url),
      url:     node.url,
      folder:  folderPath || null,
      // Chrome stores microseconds-since-1601-01-01 as a 17-digit
      // integer string. Convert to JS Date / Unix-ms.
      addedAt: _chromeMicrosecondsToISO(node.date_added),
    })
  }
}

// Chrome time is microseconds since 1601-01-01 UTC. Unix epoch is
// 1970-01-01, which is 11644473600 seconds (or 11644473600000000 µs)
// after the Chrome epoch.
function _chromeMicrosecondsToISO(s) {
  if (!s) return null
  const us = Number(s)
  if (!Number.isFinite(us) || us <= 0) return null
  const ms = (us / 1000) - 11644473600000
  if (ms <= 0) return null
  try { return new Date(ms).toISOString() } catch (_) { return null }
}

/**
 * Import bookmarks from a Chromium Bookmarks file path.
 * Returns:
 *   { ok: true,  bookmarks: [...], folders: [...], stats: { read, kept } }
 *   { ok: false, error: string }
 */
async function importFromFile(bookmarksPath) {
  if (!fs.existsSync(bookmarksPath)) {
    return { ok: false, error: 'Bookmarks-filen finns inte' }
  }
  const data = _readBookmarksFile(bookmarksPath)
  if (!data || !data.roots) {
    return { ok: false, error: 'Bookmarks-filen kunde inte tolkas (ogiltig JSON eller okänt format)' }
  }
  const out = []
  // We import bookmark_bar + other (the two visible roots in Chrome's
  // UI). `synced` is Google Sync's storage and overlaps heavily with
  // bookmark_bar — skipping it avoids duplicates.
  for (const key of ['bookmark_bar', 'other']) {
    const root = data.roots[key]
    if (root) _flattenSubtree(root, [], out)
  }

  // Dedupe by URL — Chrome occasionally has the same item in both
  // bookmark_bar and other (rare but happens). Keep the first
  // occurrence (bookmark_bar wins, since we iterate it first).
  const seen = new Set()
  const deduped = []
  for (const b of out) {
    if (seen.has(b.url)) continue
    seen.add(b.url)
    deduped.push(b)
  }

  // Build the flat folder list — unique folder paths, filtering
  // out the empty-string root.
  const folderSet = new Set()
  for (const b of deduped) {
    if (b.folder) folderSet.add(b.folder)
  }

  return {
    ok: true,
    bookmarks: deduped,
    folders:   Array.from(folderSet),
    stats:     { read: out.length, kept: deduped.length },
  }
}

module.exports = { importFromFile }
