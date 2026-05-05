'use strict'

// ══════════════════════════════════════════════════════════════════════
//  News module — RSS 2.0 / Atom 1.0 reader for the home-screen rail.
//  All network + parsing happens here; the renderer only sees a
//  normalized array of items. State lives in electron-store keyed by
//  the active profile id (set via setActiveProfile from main.js).
// ══════════════════════════════════════════════════════════════════════

const { net } = require('electron')
const Store = require('electron-store')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const events = new EventEmitter()

// One store-per-profile is the same model mail uses; we get a fresh
// Store each time the profile changes so cache + sources don't bleed
// between profiles.
let _store = null
let _profileId = null
function _ensureStore() {
  if (!_store) _store = new Store({ name: _profileId ? `news-${_profileId}` : 'news' })
  return _store
}
function setActiveProfile(profileId) {
  if (profileId === _profileId) return
  _profileId = profileId || null
  _store = null
}

// Refresh cadence for the background timer. Aggressive feeds (DN, SVT)
// update more often than this; calmer ones less. 15 min keeps freshness
// reasonable without hammering anyone's CDN.
const REFRESH_MS = 15 * 60 * 1000
let _refreshTimer = null

// Curated default presets — user toggles these on/off in Settings, no
// auto-enable on first launch (avoids picking sides for the user).
const PRESETS = [
  // SEO / branche
  { id: 'sel',      name: 'Search Engine Land',     url: 'https://searchengineland.com/feed',                 category: 'seo' },
  { id: 'sej',      name: 'Search Engine Journal',  url: 'https://www.searchenginejournal.com/feed/',         category: 'seo' },
  { id: 'gsc-blog', name: 'Google Search Central',  url: 'https://developers.google.com/search/blog/feed.xml',category: 'seo' },
  { id: 'moz',      name: 'Moz Blog',               url: 'https://moz.com/posts/rss',                         category: 'seo' },
  { id: 'ahrefs',   name: 'Ahrefs Blog',            url: 'https://ahrefs.com/blog/feed/',                     category: 'seo' },
  // Sweden / editorial
  { id: 'dn',       name: 'Dagens Nyheter',         url: 'https://www.dn.se/rss/',                            category: 'sweden' },
  { id: 'svd',      name: 'Svenska Dagbladet',      url: 'https://www.svd.se/feed/articles.rss',              category: 'sweden' },
  { id: 'svt',      name: 'SVT Nyheter',            url: 'https://www.svt.se/nyheter/rss.xml',                category: 'sweden' },
  { id: 'breakit',  name: 'Breakit',                url: 'https://www.breakit.se/feed/artiklar/100',          category: 'sweden' },
  { id: 'di',       name: 'Di Digital',             url: 'https://digital.di.se/rss',                         category: 'sweden' },
]

// ─── Storage helpers ──────────────────────────────────────────────────
// Sources: array of { id, name, url, enabled, custom: bool }
function getSources() {
  return _ensureStore().get('sources', [])
}
function setSources(list) {
  if (!Array.isArray(list)) throw new Error('sources must be an array')
  const clean = list.filter(s => s && typeof s.url === 'string' && s.url.startsWith('http'))
                    .map(s => ({
                      id: String(s.id || _hash(s.url).slice(0, 8)),
                      name: String(s.name || s.url),
                      url: String(s.url),
                      enabled: s.enabled !== false,
                      custom: !!s.custom,
                    }))
  _ensureStore().set('sources', clean)
  return clean
}

// Cache: { [sourceId]: { items: [...], lastFetched: ISO, error?: string } }
function _getCache() {
  return _ensureStore().get('cache', {})
}
function _setCache(cache) {
  _ensureStore().set('cache', cache)
}

// Themes: array of { id, label } — user-defined keywords/phrases that
// boost matching headlines to the top of the rail. Match is a simple
// case-insensitive substring check against the title; multi-word phrases
// require all words to appear (in any order).
function getThemes() {
  return _ensureStore().get('themes', [])
}
function setThemes(list) {
  if (!Array.isArray(list)) throw new Error('themes must be an array')
  const seen = new Set()
  const clean = []
  for (const t of list) {
    if (!t || typeof t.label !== 'string') continue
    const label = t.label.trim()
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue   // dedupe by case-insensitive label
    seen.add(key)
    clean.push({
      id: String(t.id || _hash(label).slice(0, 8)),
      label,
    })
  }
  _ensureStore().set('themes', clean)
  return clean
}

// Internal: compile themes into match-needles. Each theme becomes an
// array of lowercased word tokens — title must contain ALL of them
// (substring) for the theme to match. Single-word themes thus behave
// as plain substring matches; multi-word phrases require each word.
function _compileThemes(themes) {
  return themes.map(t => ({
    id: t.id,
    label: t.label,
    tokens: String(t.label).toLowerCase().split(/\s+/).filter(Boolean),
  }))
}
function _matchedThemes(title, compiled) {
  const t = String(title || '').toLowerCase()
  if (!t) return []
  const out = []
  for (const c of compiled) {
    if (c.tokens.every(tok => t.includes(tok))) out.push(c.label)
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────
// Returns a globally-sorted, capped list ready for the rail. Pulls
// straight from cache so it's instant; refreshAll() updates the cache
// in the background. Items matching a watched theme are boosted to the
// top — sort key is (matchCount desc, date desc).
function getItems({ limit = 30 } = {}) {
  const cache = _getCache()
  const sources = getSources().filter(s => s.enabled)
  const compiled = _compileThemes(getThemes())
  const all = []
  for (const src of sources) {
    const slot = cache[src.id]
    if (!slot || !slot.items) continue
    for (const it of slot.items) {
      const matchedThemes = _matchedThemes(it.title, compiled)
      all.push({ ...it, sourceId: src.id, sourceName: src.name, matchedThemes })
    }
  }
  all.sort((a, b) => {
    const am = a.matchedThemes.length
    const bm = b.matchedThemes.length
    if (am !== bm) return bm - am
    return new Date(b.date || 0) - new Date(a.date || 0)
  })
  return all.slice(0, limit)
}

// Refresh every enabled source in parallel. Each fetch is wrapped so
// one bad feed doesn't break the others — failed sources keep their
// previous cache and surface the error in `error` for the UI.
async function refreshAll() {
  const sources = getSources().filter(s => s.enabled)
  if (!sources.length) return { ok: true, refreshed: 0 }
  const cache = _getCache()
  const results = await Promise.allSettled(sources.map(s => fetchFeed(s.url)))
  results.forEach((res, i) => {
    const src = sources[i]
    if (res.status === 'fulfilled') {
      cache[src.id] = {
        items: res.value.items.slice(0, 20),
        sourceName: res.value.title || src.name,
        lastFetched: new Date().toISOString(),
      }
    } else {
      const prev = cache[src.id] || {}
      cache[src.id] = {
        items: prev.items || [],
        sourceName: prev.sourceName || src.name,
        lastFetched: prev.lastFetched || null,
        error: String(res.reason && res.reason.message || res.reason || 'fetch failed'),
      }
    }
  })
  _setCache(cache)
  events.emit('items-updated')
  return { ok: true, refreshed: sources.length }
}

// One-shot probe used by the "Lägg till egen RSS" flow in Settings.
// Returns the parsed feed without persisting anything so the UI can
// show the user a preview before they commit.
async function fetchPreview(url) {
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return { ok: false, error: 'URL måste börja med http(s)://' }
  }
  try {
    const feed = await fetchFeed(url)
    return { ok: true, title: feed.title, items: feed.items.slice(0, 5) }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

// ─── Network + parse ──────────────────────────────────────────────────
async function fetchFeed(url) {
  const res = await net.fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'SEOZ-Browser/1.0 (+https://seoz.se)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const xml = await res.text()
  const parsed = parseFeed(xml)
  // Compute stable id per item from its link/guid; lets us dedupe and
  // detect "new since last fetch" without storing the whole link as key.
  parsed.items = parsed.items
    .map(it => ({ ...it, id: _hash(it.link || it.title || '') }))
    .filter(it => it.title && (it.link || it.id))
  return parsed
}

// Minimal RSS 2.0 + Atom 1.0 parser. Hand-rolled so we don't need a
// dep — covers ~95% of feeds in the wild. If a specific feed breaks,
// swap to fast-xml-parser without touching the public API.
function parseFeed(xml) {
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml)
                 || /<feed\b/i.test(xml) && !/<rss\b/i.test(xml)
  if (isAtom) return _parseAtom(xml)
  return _parseRss(xml)
}

function _parseRss(xml) {
  const channel = _slice(xml, /<channel\b[^>]*>/i, /<\/channel>/i) || xml
  const title = _decode(_textOf(channel.replace(/<item\b[\s\S]*/i, ''), 'title')) || ''
  const items = []
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let m
  while ((m = itemRe.exec(channel))) {
    const block = m[1]
    const link = _decode(_textOf(block, 'link') || _attrOf(block, 'link', 'href'))
    items.push({
      title: _decode(_textOf(block, 'title')),
      link,
      date: _isoDate(_textOf(block, 'pubDate') || _textOf(block, 'dc:date') || _textOf(block, 'published')),
    })
  }
  return { title, items }
}

function _parseAtom(xml) {
  // Atom <feed>'s own <title> sits before the first <entry>; isolate it
  // first so we don't accidentally pick up an entry's title.
  const feedHead = xml.replace(/<entry\b[\s\S]*/i, '')
  const title = _decode(_textOf(feedHead, 'title'))
  const items = []
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let m
  while ((m = entryRe.exec(xml))) {
    const block = m[1]
    // Prefer rel="alternate" link; fall back to first <link href=...>.
    let link = _attrOfWhere(block, 'link', /rel=["']alternate["']/i, 'href')
            || _attrOf(block, 'link', 'href')
            || _textOf(block, 'link')
    items.push({
      title: _decode(_textOf(block, 'title')),
      link: _decode(link),
      date: _isoDate(_textOf(block, 'published') || _textOf(block, 'updated')),
    })
  }
  return { title, items }
}

// ─── Tiny XML helpers (regex-based, intentionally permissive) ─────────
function _slice(s, openRe, closeRe) {
  const o = s.match(openRe); if (!o) return null
  const start = o.index + o[0].length
  const tail = s.slice(start)
  const c = tail.match(closeRe); if (!c) return null
  return tail.slice(0, c.index)
}
function _textOf(block, tag) {
  // Tag may include a colon (dc:date, atom:link) — escape for regex.
  const t = tag.replace(/([.*+?^${}()|[\]\\])/g, '\\$1')
  const re = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  let s = m[1]
  // Strip CDATA, decode entities, trim.
  s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim()
  return s
}
function _attrOf(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'i')
  const m = block.match(re)
  return m ? m[1] : ''
}
function _attrOfWhere(block, tag, mustMatch, attr) {
  const tagRe = new RegExp(`<${tag}\\b[^>]*?>`, 'gi')
  let m
  while ((m = tagRe.exec(block))) {
    if (mustMatch.test(m[0])) {
      const am = m[0].match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'))
      if (am) return am[1]
    }
  }
  return ''
}
function _decode(s) {
  if (!s) return ''
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim()
}
function _isoDate(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d) ? null : d.toISOString()
}
function _hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex')
}

// ─── Background refresh loop ──────────────────────────────────────────
function startScheduler() {
  stopScheduler()
  // Kick once on startup (defer slightly so app finish-launching first).
  setTimeout(() => { refreshAll().catch(() => {}) }, 5000)
  _refreshTimer = setInterval(() => { refreshAll().catch(() => {}) }, REFRESH_MS)
}
function stopScheduler() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null }
}

module.exports = {
  events,
  setActiveProfile,
  startScheduler,
  stopScheduler,
  getSources,
  setSources,
  getThemes,
  setThemes,
  getItems,
  refreshAll,
  fetchPreview,
  PRESETS,
}
