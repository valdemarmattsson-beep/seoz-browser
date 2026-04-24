'use strict'

// ══════════════════════════════════════════════════════════════════════
//  Mail module — IMAP read + SMTP send via standard Node libraries.
//  All IMAP/SMTP lives in the main process; renderer only sees sanitized
//  JSON. HTML bodies are DOMPurified here so the renderer never touches
//  raw email markup.
// ══════════════════════════════════════════════════════════════════════

// --- Compatibility shim ----------------------------------------------
// imapflow → pino (logger) calls diagnostics_channel.tracingChannel(...)
// at module-load time. That API was added in Node 19.9. Electron 28 ships
// with Node 18.x, so the require() throws before we can even opt out via
// { logger: false }. Install a no-op tracingChannel before requiring
// imapflow so the call succeeds; behaviourally, tracing stays disabled.
const _diagChan = require('diagnostics_channel')
if (typeof _diagChan.tracingChannel !== 'function') {
  const noopEvt = { hasSubscribers: false, publish: () => {}, subscribe: () => {}, unsubscribe: () => {} }
  _diagChan.tracingChannel = () => ({
    start: noopEvt, end: noopEvt, asyncStart: noopEvt, asyncEnd: noopEvt, error: noopEvt,
    subscribe: () => {}, unsubscribe: () => {},
    bindStore: () => {}, unbindStore: () => {},
    traceSync:     (fn, _ctx, ...args) => fn(...args),
    tracePromise:  (fn, _ctx, ...args) => fn(...args),
    traceCallback: (fn, _pos, ctx, ...args) => fn.apply(ctx, args),
  })
}

const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const nodemailer = require('nodemailer')
const sanitizeHtml = require('sanitize-html')

// sanitize-html allowlist for email bodies. Keeps presentation tags &
// inline styles (emails rely on them) but strips anything active:
// script/iframe/object/embed/form, event handlers, javascript: URLs.
const SANITIZE_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'style', 'center', 'font', 'span', 'div',
    's', 'strike', 'u', 'mark', 'sub', 'sup',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'col', 'colgroup',
  ]),
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'dir', 'lang', 'bgcolor', 'color', 'width', 'height'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'srcset'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan', 'valign'],
    th: ['colspan', 'rowspan', 'valign', 'scope'],
    font: ['face', 'size', 'color'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
  // Force all links to open in a new context — the renderer traps navigation.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
}

// ─── Connection pool ─────────────────────────────────────────────────
// One persistent IMAP client per configured account. Keyed by cfg.id so
// parallel operations on different accounts don't block each other.
// Each slot carries its own lock (serializes connect/reconnect attempts
// within the same account) plus a fingerprint so we force-reconnect if
// host/port/username changed without the id changing.
const _pool = new Map()  // accountId -> { client, lock, cfgFingerprint }

function _fingerprint(cfg) {
  return `${cfg.imapHost}:${cfg.imapPort || 993}:${cfg.username || cfg.email}`
}

async function _getClient(cfg) {
  if (!cfg || !cfg.id) throw new Error('cfg.id required for pooled client')
  const slot = _pool.get(cfg.id) || { client: null, lock: Promise.resolve(), cfgFingerprint: null }
  const prev = slot.lock
  let release
  slot.lock = new Promise(r => { release = r })
  _pool.set(cfg.id, slot)
  await prev

  try {
    const fp = _fingerprint(cfg)
    if (slot.client && slot.client.usable && slot.cfgFingerprint === fp) return slot.client
    if (slot.client) { try { await slot.client.logout() } catch (_) {} }
    slot.client = new ImapFlow({
      host: cfg.imapHost,
      port: Number(cfg.imapPort) || 993,
      secure: cfg.imapSecure !== false,
      auth: { user: cfg.username || cfg.email, pass: cfg.password },
      logger: false,
    })
    await slot.client.connect()
    slot.cfgFingerprint = fp
    return slot.client
  } finally {
    release()
  }
}

async function closeAccount(accountId) {
  const slot = _pool.get(accountId)
  if (!slot) return
  if (slot.client) { try { await slot.client.logout() } catch (_) {} }
  _pool.delete(accountId)
}

// ─── Public API ──────────────────────────────────────────────────────

async function testConnection(cfg) {
  if (!cfg || !cfg.email || !cfg.password) {
    return { ok: false, error: 'E-post och app-lösenord krävs' }
  }
  // IMAP leg — use a throwaway client so an existing pooled one isn't nuked.
  const probe = new ImapFlow({
    host: cfg.imapHost,
    port: Number(cfg.imapPort) || 993,
    secure: cfg.imapSecure !== false,
    auth: { user: cfg.username || cfg.email, pass: cfg.password },
    logger: false,
  })
  try {
    await probe.connect()
    const mailbox = await probe.mailboxOpen('INBOX')
    const total = mailbox.exists
    await probe.logout()
    // SMTP leg
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: Number(cfg.smtpPort) || 465,
      secure: cfg.smtpSecure !== false,
      auth: { user: cfg.username || cfg.email, pass: cfg.password },
    })
    await transporter.verify()
    return { ok: true, inboxTotal: total }
  } catch (err) {
    try { if (probe.usable) await probe.logout() } catch (_) {}
    // imapflow/nodemailer errors can hide the actual server response in
    // err.code / err.responseText / err.response. Surface all of them so
    // a "Command failed" doesn't look opaque in the UI.
    const parts = []
    if (err?.code)         parts.push(err.code)
    if (err?.message)      parts.push(err.message)
    if (err?.responseText) parts.push(String(err.responseText).trim())
    else if (err?.response) parts.push(String(err.response).trim())
    if (err?.authenticationFailed) parts.push('Autentisering nekad — kontrollera app-lösenord + att IMAP är aktiverat i Zoho Mail-inställningarna.')
    return { ok: false, error: parts.join(' · ') || String(err) }
  }
}

function _bodyStructureHasAttachment(bs) {
  if (!bs) return false
  if (bs.disposition === 'attachment') return true
  if (bs.childNodes) {
    for (const n of bs.childNodes) if (_bodyStructureHasAttachment(n)) return true
  }
  return false
}

// Normalize the special-use flag into a short kind we can style/sort on.
// Values: inbox, sent, drafts, trash, junk, archive, all, custom
function _specialUseKind(f) {
  const su = typeof f.specialUse === 'string' ? f.specialUse.toLowerCase() : null
  if (su) {
    if (su.includes('inbox'))   return 'inbox'
    if (su.includes('sent'))    return 'sent'
    if (su.includes('drafts'))  return 'drafts'
    if (su.includes('trash'))   return 'trash'
    if (su.includes('junk') || su.includes('spam')) return 'junk'
    if (su.includes('archive')) return 'archive'
    if (su.includes('all'))     return 'all'
  }
  // Fallback: guess from the folder name — many servers (incl. Zoho) don't
  // always advertise specialUse on all well-known folders, especially with
  // non-English clients.
  const n = (f.name || f.path || '').toLowerCase()
  if (n === 'inbox') return 'inbox'
  if (n === 'sent' || n === 'skickat' || n === 'sent items' || n === 'sent mail') return 'sent'
  if (n === 'drafts' || n === 'utkast' || n === 'draft') return 'drafts'
  if (n === 'trash' || n === 'deleted' || n === 'deleted items' || n === 'papperskorg' || n === 'bin') return 'trash'
  if (n === 'spam' || n === 'junk' || n === 'skräppost') return 'junk'
  if (n === 'archive' || n === 'arkiv') return 'archive'
  return 'custom'
}

// Order special folders in a Gmail/Zoho-style hierarchy.
const _FOLDER_KIND_ORDER = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5, all: 6, custom: 10 }

async function listFolders(cfg) {
  const client = await _getClient(cfg)
  const raw = await client.list()
  // raw: Array of { path, name, delimiter, flags (Set), specialUse, listed, subscribed, parentPath, ... }
  const folders = raw
    .filter(f => {
      // Drop non-selectable containers (holders without messages)
      const flags = f.flags instanceof Set ? f.flags : new Set(Array.isArray(f.flags) ? f.flags : [])
      return !flags.has('\\Noselect')
    })
    .map(f => {
      const kind = _specialUseKind(f)
      const depth = f.delimiter && f.path.includes(f.delimiter)
        ? f.path.split(f.delimiter).length - 1
        : 0
      return {
        path: f.path,
        name: f.name || f.path,
        delimiter: f.delimiter || '/',
        specialUse: f.specialUse || null,
        kind,
        depth,
        parentPath: f.parentPath || null,
      }
    })

  folders.sort((a, b) => {
    const ko = (_FOLDER_KIND_ORDER[a.kind] ?? 10) - (_FOLDER_KIND_ORDER[b.kind] ?? 10)
    if (ko !== 0) return ko
    return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
  })

  return folders
}

async function listMessages(cfg, folder = 'INBOX', limit = 50) {
  const client = await _getClient(cfg)
  await client.mailboxOpen(folder)
  const total = client.mailbox.exists
  if (total === 0) return []
  const start = Math.max(1, total - limit + 1)
  const range = `${start}:${total}`
  const out = []
  for await (const msg of client.fetch(range, {
    envelope: true,
    flags: true,
    internalDate: true,
    bodyStructure: true,
  })) {
    const env = msg.envelope || {}
    const flags = msg.flags instanceof Set ? Array.from(msg.flags) : (Array.isArray(msg.flags) ? msg.flags : [])
    out.push({
      uid: msg.uid,
      messageId: env.messageId || null,
      from: (env.from || []).map(a => ({ name: a.name, address: a.address })),
      to:   (env.to   || []).map(a => ({ name: a.name, address: a.address })),
      subject: env.subject || '',
      date: (env.date || msg.internalDate || new Date()).toISOString(),
      unread: !flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      hasAttachments: _bodyStructureHasAttachment(msg.bodyStructure),
    })
  }
  return out.reverse()  // newest first
}

async function getMessage(cfg, uid, folder = 'INBOX') {
  const client = await _getClient(cfg)
  await client.mailboxOpen(folder)
  const msg = await client.fetchOne(uid, { source: true, envelope: true, flags: true }, { uid: true })
  if (!msg) return null
  const parsed = await simpleParser(msg.source)
  return {
    uid: msg.uid,
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []),
    from: (parsed.from?.value || []).map(a => ({ name: a.name, address: a.address })),
    to:   (parsed.to?.value   || []).map(a => ({ name: a.name, address: a.address })),
    cc:   (parsed.cc?.value   || []).map(a => ({ name: a.name, address: a.address })),
    subject: parsed.subject || '',
    date: (parsed.date || new Date()).toISOString(),
    text: parsed.text || '',
    html: parsed.html ? sanitizeHtml(parsed.html, SANITIZE_OPTS) : null,
    attachments: (parsed.attachments || []).map(a => ({
      filename: a.filename || 'bilaga',
      contentType: a.contentType,
      size: a.size,
    })),
  }
}

async function setFlag(cfg, uid, flag, value, folder = 'INBOX') {
  const client = await _getClient(cfg)
  await client.mailboxOpen(folder)
  if (value) await client.messageFlagsAdd({ uid }, [flag], { uid: true })
  else       await client.messageFlagsRemove({ uid }, [flag], { uid: true })
  return { ok: true }
}

async function sendMessage(cfg, opts) {
  if (!cfg) throw new Error('No mail config')
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number(cfg.smtpPort) || 465,
    secure: cfg.smtpSecure !== false,
    auth: { user: cfg.username || cfg.email, pass: cfg.password },
  })
  const fromAddr = (opts.from && opts.from.includes('@')) ? opts.from
    : `"${cfg.displayName || cfg.email}" <${cfg.email}>`
  const info = await transporter.sendMail({
    from: fromAddr,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  })
  return { ok: true, messageId: info.messageId }
}

async function closeAll() {
  const slots = Array.from(_pool.values())
  _pool.clear()
  await Promise.all(slots.map(async s => {
    if (s.client) { try { await s.client.logout() } catch (_) {} }
  }))
}

module.exports = { testConnection, listFolders, listMessages, getMessage, setFlag, sendMessage, closeAccount, closeAll }
