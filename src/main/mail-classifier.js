'use strict'

// ══════════════════════════════════════════════════════════════════════
//  Mail classifier — Claude-powered inbox categorization
//
//  Input: list of message stubs { messageId, from, subject }.
//  Output: { [messageId]: category } where category is one of the fixed
//  strings below. Cached per messageId in electron-store so the same
//  message is never classified twice; classifier only runs on NEW uids
//  the first time the user sees them.
// ══════════════════════════════════════════════════════════════════════

const Store = require('electron-store')
const { net } = require('electron')

// v2 categories — finer grained than v1's "arbete" bucket so the inbox
// can surface lead-specific suggested actions (Research bolag, Skapa
// CRM-lead) vs. invoice / support / personal flows. v1 strings still
// honoured by getCached() so we don't re-classify everything on upgrade.
const CATEGORIES = [
  'salj_lead',     // sales lead / inbound interest
  'faktura',       // invoice / payment / overdue
  'support',       // support / customer question / pricing inquiry
  'personlig',     // private personal conversation
  'notifiering',   // system / activity notification
  'nyhetsbrev',    // newsletter (subscribed)
  'reklam',        // commercial / unsolicited
  'social',        // social platforms / communities
  'transaktion',   // receipts / order confirmations
]

// Legacy → v2 category map for cached entries written before the schema
// upgrade. "arbete" is intentionally split here: there's no safe way to
// tell lead from support without re-classifying, so we conservatively
// land it in 'support' (the lower-stakes path) until the message is
// re-seen and properly re-classified.
const LEGACY_CATEGORY_MAP = {
  arbete: 'support',
}

const store = new Store({
  name: 'mail-classifications',
  defaults: { byMessageId: {} },
})

// Returns { [messageId]: { c: <category>, conf: 0..100 } }. Older cache
// entries that were stored as plain strings get hoisted into the v2
// shape with conf=0 so the UI can still render them while signalling
// "no confidence info available".
function getCached(messageIds) {
  const all = store.get('byMessageId', {})
  const out = {}
  for (const id of messageIds) {
    if (!id || !all[id]) continue
    const v = all[id]
    if (typeof v === 'string') {
      out[id] = { c: LEGACY_CATEGORY_MAP[v] || v, conf: 0 }
    } else if (v && typeof v === 'object' && v.c) {
      out[id] = v
    }
  }
  return out
}

function setCached(map) {
  const all = store.get('byMessageId', {})
  for (const [id, val] of Object.entries(map)) all[id] = val
  // Prune if the cache ever grows past 20k entries (pathological); keep
  // the newest 10k by insertion order — good enough for v1.
  const keys = Object.keys(all)
  if (keys.length > 20000) {
    const trimmed = {}
    for (const k of keys.slice(-10000)) trimmed[k] = all[k]
    store.set('byMessageId', trimmed)
  } else {
    store.set('byMessageId', all)
  }
}

// Batch-classify via Claude. `messages` is an array of
// { messageId, from, subject }. Returns { [messageId]: category }.
// If no API key is configured, returns an empty object — caller treats
// that as "unclassified" and shows no chip, so the feature is a no-op
// for users who haven't wired up Anthropic.
async function classify(messages, apiKey) {
  if (!apiKey || !messages || !messages.length) return {}

  const listForPrompt = messages
    .filter(m => m && m.messageId)
    .slice(0, 30)   // cap one call at 30 to keep tokens reasonable
    .map((m, i) => `${i + 1}. ${m.messageId} · from: ${m.from || ''} · subject: ${(m.subject || '').slice(0, 120)}`)
    .join('\n')

  if (!listForPrompt) return {}

  const system = [
    'Du klassificerar e-post i en av följande kategorier (en per meddelande):',
    '- salj_lead (offertförfrågan, intresse av att köpa, inbound prospect)',
    '- faktura (faktura, betalningspåminnelse, kvitto med åtgärd)',
    '- support (kundfråga, pricing-inquiry, jobbrelaterat som inte är lead)',
    '- personlig (privat konversation från en person)',
    '- notifiering (automatiska system- eller aktivitetsnotiser)',
    '- nyhetsbrev (massutskick man prenumererar på)',
    '- reklam (kommersiella erbjudanden, kallt utskick)',
    '- social (sociala medier, Slack/Discord/communities)',
    '- transaktion (orderbekräftelser, bokningar, leveranser utan åtgärd)',
    '',
    'För varje meddelande, ange också ett confidence-värde 0-100 som',
    'representerar hur säker du är på klassificeringen.',
    '',
    'Svara enbart med JSON i formatet:',
    '{"classifications":[{"id":"<messageId>","c":"<kategori>","conf":<0-100>}, ...]}',
    'Ingen extra text, inga markdown-fences.',
  ].join('\n')

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: listForPrompt }],
  })

  let res
  try {
    res = await net.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    })
  } catch (err) {
    console.warn('[classifier] network error:', err?.message || err)
    return {}
  }
  if (!res.ok) {
    console.warn('[classifier] HTTP', res.status)
    return {}
  }
  let data
  try { data = await res.json() } catch (_) { return {} }
  const text = data?.content?.[0]?.text || ''
  // Defensive parse — the model *should* return clean JSON but we've
  // seen it wrap in ```json sometimes. Strip fences first.
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  let parsed
  try { parsed = JSON.parse(clean) } catch (_) { return {} }
  const out = {}
  if (parsed && Array.isArray(parsed.classifications)) {
    for (const row of parsed.classifications) {
      if (!row || !row.id || !CATEGORIES.includes(row.c)) continue
      const conf = Math.max(0, Math.min(100, Math.round(Number(row.conf) || 0)))
      out[row.id] = { c: row.c, conf }
    }
  }
  if (Object.keys(out).length) setCached(out)
  return out
}

module.exports = { classify, getCached, setCached, CATEGORIES }
