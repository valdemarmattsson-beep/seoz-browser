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
// One persistent IMAP client per email account. Reconnected lazily.
let _client = null
let _clientFor = null       // email address the current client was built for
let _clientLock = Promise.resolve()

async function _getClient(cfg) {
  // Serialize connection attempts so parallel list/get don't both dial up.
  const prev = _clientLock
  let release
  _clientLock = new Promise(r => { release = r })
  await prev

  try {
    if (_client && _client.usable && _clientFor === cfg.email) return _client
    if (_client) { try { await _client.logout() } catch (_) {} }
    _clientFor = cfg.email
    _client = new ImapFlow({
      host: cfg.imapHost,
      port: Number(cfg.imapPort) || 993,
      secure: cfg.imapSecure !== false,
      auth: { user: cfg.username || cfg.email, pass: cfg.password },
      logger: false,
    })
    await _client.connect()
    return _client
  } finally {
    release()
  }
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
  if (_client) { try { await _client.logout() } catch (_) {} }
  _client = null
  _clientFor = null
}

module.exports = { testConnection, listMessages, getMessage, setFlag, sendMessage, closeAll }
