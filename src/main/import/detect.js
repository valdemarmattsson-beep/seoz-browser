'use strict'
// ════════════════════════════════════════════════════════════════════
//  Detect installed Chromium-based browsers on this machine.
//
//  All Chromium derivatives use the same User Data layout:
//    <user-data-root>/<Profile>/Bookmarks
//    <user-data-root>/<Profile>/History
//    <user-data-root>/Local State
//
//  We probe the well-known user-data roots for each browser and, for
//  each one that exists, enumerate its profiles (the JSON file at
//  `Local State` lists them under `profile.info_cache`). Browsers
//  that aren't installed are silently skipped.
//
//  Returns a flat list:
//    [{ browserId, browserName, profileId, profileName, paths: { bookmarks, history, localState } }]
//
//  Currently Windows-only — Mac/Linux paths are stubbed out so the
//  function returns an empty list rather than throwing.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// Browser → list of candidate user-data roots, relative to home / app
// data. We check each in order and use whichever exists. Different
// install methods (Stable / Beta / Canary, Microsoft Store edge, Brave
// Nightly etc.) live at different paths.
const BROWSERS = [
  { id: 'chrome',  name: 'Google Chrome',
    winRoots:  ['AppData/Local/Google/Chrome/User Data'],
    macRoots:  ['Library/Application Support/Google/Chrome'],
  },
  { id: 'edge',    name: 'Microsoft Edge',
    winRoots:  ['AppData/Local/Microsoft/Edge/User Data'],
    macRoots:  ['Library/Application Support/Microsoft Edge'],
  },
  { id: 'brave',   name: 'Brave',
    winRoots:  ['AppData/Local/BraveSoftware/Brave-Browser/User Data'],
    macRoots:  ['Library/Application Support/BraveSoftware/Brave-Browser'],
  },
  { id: 'opera',   name: 'Opera',
    winRoots:  ['AppData/Roaming/Opera Software/Opera Stable'],
    macRoots:  ['Library/Application Support/com.operasoftware.Opera'],
  },
  { id: 'vivaldi', name: 'Vivaldi',
    winRoots:  ['AppData/Local/Vivaldi/User Data'],
    macRoots:  ['Library/Application Support/Vivaldi'],
  },
  { id: 'arc',     name: 'Arc',
    winRoots:  ['AppData/Local/Packages/TheBrowserCompany.Arc_*/LocalCache/Local/Arc/User Data'],
    macRoots:  ['Library/Application Support/Arc/User Data'],
  },
]

function _candidateRoots(browser) {
  const home = os.homedir()
  const list = process.platform === 'win32' ? browser.winRoots
             : process.platform === 'darwin' ? browser.macRoots
             : []
  return list.map(rel => path.join(home, rel))
}

function _readLocalStateProfiles(rootDir) {
  // Local State is JSON. profile.info_cache maps profile-dir-name → metadata.
  const localStatePath = path.join(rootDir, 'Local State')
  try {
    const raw = fs.readFileSync(localStatePath, 'utf8')
    const json = JSON.parse(raw)
    const cache = json?.profile?.info_cache || {}
    return Object.entries(cache).map(([dir, meta]) => ({
      dirName: dir,
      displayName: meta?.name || meta?.shortcut_name || dir,
      userName:    meta?.user_name || '',
      avatarIcon:  meta?.avatar_icon || null,
      _localStatePath: localStatePath,
    }))
  } catch (_) {
    // No Local State (browser was opened once but profile init failed),
    // or directory doesn't exist. Fall back to scanning sub-directories
    // that look like profile dirs (named "Default", "Profile 1", ...).
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      const profiles = entries
        .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
        .map(d => ({ dirName: d.name, displayName: d.name, userName: '', avatarIcon: null, _localStatePath: localStatePath }))
      return profiles
    } catch (_) { return [] }
  }
}

function _resolveProfileFiles(rootDir, profileDirName) {
  const pdir = path.join(rootDir, profileDirName)
  // The actual data files we care about. Existence is checked at read
  // time; we report the paths regardless so the UI can show "0 bokmärken"
  // for an empty profile rather than "profile not found".
  return {
    bookmarks:  path.join(pdir, 'Bookmarks'),
    history:    path.join(pdir, 'History'),
    profileDir: pdir,
  }
}

/**
 * Probe the filesystem for installed Chromium browsers and their
 * profiles. Returns an array of source descriptors that callers can
 * pass to `bookmarks.import()` / `history.import()`.
 *
 * @returns {Promise<Array<{
 *   browserId: string,
 *   browserName: string,
 *   profileDir: string,
 *   profileDisplayName: string,
 *   userName: string,
 *   bookmarksPath: string,
 *   historyPath: string,
 *   localStatePath: string,
 *   hasBookmarks: boolean,
 *   hasHistory: boolean,
 * }>>}
 */
async function detectBrowsers() {
  const out = []
  for (const browser of BROWSERS) {
    const roots = _candidateRoots(browser)
    for (const root of roots) {
      // Wildcard segments (Arc's Packages dir) need glob expansion.
      const expanded = root.includes('*') ? _expandWildcard(root) : (fs.existsSync(root) ? [root] : [])
      for (const r of expanded) {
        const profiles = _readLocalStateProfiles(r)
        for (const p of profiles) {
          const files = _resolveProfileFiles(r, p.dirName)
          out.push({
            browserId:          browser.id,
            browserName:        browser.name,
            profileDir:         p.dirName,
            profileDisplayName: p.displayName,
            userName:           p.userName,
            bookmarksPath:      files.bookmarks,
            historyPath:        files.history,
            localStatePath:     p._localStatePath,
            hasBookmarks:       _existsAndNonEmpty(files.bookmarks),
            hasHistory:         _existsAndNonEmpty(files.history),
          })
        }
      }
    }
  }
  return out
}

function _existsAndNonEmpty(p) {
  try {
    const st = fs.statSync(p)
    return st.isFile() && st.size > 0
  } catch (_) { return false }
}

// Expand a single * wildcard in a path segment. Used for Arc's
// `Packages\TheBrowserCompany.Arc_*\...` install dir whose suffix
// is a UWP-installation hash that varies per machine.
function _expandWildcard(p) {
  const i = p.indexOf('*')
  if (i === -1) return [p]
  // Split at the last directory separator before the wildcard.
  const slash = Math.max(p.lastIndexOf('/', i), p.lastIndexOf(path.sep, i))
  const parentDir = p.slice(0, slash)
  const after = p.slice(slash + 1)
  const starSeg = after.split(/[\/\\]/)[0]      // e.g. "TheBrowserCompany.Arc_*"
  const tail = after.slice(starSeg.length + 1)  // remainder after the wildcard segment
  const re = new RegExp('^' + starSeg.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
  let entries = []
  try { entries = fs.readdirSync(parentDir) } catch (_) { return [] }
  return entries
    .filter(name => re.test(name))
    .map(name => path.join(parentDir, name, tail))
    .filter(p2 => { try { return fs.statSync(p2).isDirectory() } catch (_) { return false } })
}

module.exports = { detectBrowsers }
