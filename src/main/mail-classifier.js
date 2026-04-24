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

const CATEGORIES = ['personlig', 'arbete', 'notifiering', 'nyhetsbrev', 'reklam', 'social', 'transaktion']

const store = new Store({
  name: 'mail-classifications',
  defaults: { byMessageId: {} },
})

function getCached(messageIds) {
  const all = store.get('byMessageId', {})
  const out = {}
  for (const id of messageIds) if (id && all[id]) out[id] = all[id]
  return out
}

function setCached(map) {
  const all = store.get('byMessageId', {})
  for (const [id, cat] of Object.entries(map)) all[id] = cat
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
    '- personlig (från en person, privat konversation)',
    '- arbete (från kollega/kund/leverantör, jobbrelaterat)',
    '- notifiering (automatiska system- eller aktivitetsnotiser)',
    '- nyhetsbrev (massutskick man prenumererar på)',
    '- reklam (kommersiella erbjudanden)',
    '- social (sociala medier, Slack/Discord/communities)',
    '- transaktion (kvitton, orderbekräftelser, bokningar)',
    '',
    'Svara enbart med JSON i formatet:',
    '{"classifications":[{"id":"<messageId>","c":"<kategori>"}, ...]}',
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
      if (row && row.id && CATEGORIES.includes(row.c)) out[row.id] = row.c
    }
  }
  if (Object.keys(out).length) setCached(out)
  return out
}

module.exports = { classify, getCached, setCached, CATEGORIES }
