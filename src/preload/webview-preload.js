'use strict'
// ════════════════════════════════════════════════════════════════════
//  Login-form preload — runs inside every guest page (both <webview>
//  tags AND native OAuth popup BrowserWindows). Detects login forms,
//  asks the host renderer for matching saved credentials, and offers
//  to save new ones on form submit.
//
//  Channels:
//    seoz-autofill-request {site, pageUrl}     → host
//    seoz-autofill-fill    {username, password} → guest (from host)
//    seoz-autofill-save    {site, username, password} → host
//
//  In <webview> guests we use ipcRenderer.sendToHost() — the message
//  goes to the parent renderer (host page). In native popup
//  BrowserWindows there's no host page, so we send to main with a
//  'popup-' prefix and main relays to the main-window renderer.
// ════════════════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron')

// In webview guests `process.guestInstanceId` is set. In a native
// popup BrowserWindow it's undefined. We pick the right transport
// once at startup so the rest of the script doesn't have to care.
const _IN_WEBVIEW = (() => {
  try { return typeof process !== 'undefined' && process.guestInstanceId !== undefined }
  catch (_) { return false }
})()
function _send(channel, payload) {
  try {
    if (_IN_WEBVIEW) ipcRenderer.sendToHost(channel, payload)
    else ipcRenderer.send('popup-' + channel, payload)
  } catch (err) {
    // Best-effort logging — visible in the page's devtools console
    // so we can diagnose what failed when a site like Facebook
    // mounts the form in unexpected ways.
    try { console.warn('[seoz-autofill] _send failed:', channel, err?.message || err) } catch (_) {}
  }
}

let _scanTimer = null
let _detectedFields = null   // { user, pass, form } or null
let _lastSendKey = ''         // dedupe key for save sends

// Lightweight signature so we don't fire requests for the same form
// repeatedly when a SPA re-renders identical inputs.
function _formSig(user, pass) {
  return [user?.id || '', user?.name || '', pass?.id || '', pass?.name || ''].join('|')
}
let _lastSig = null

function _findUsernameField(passwordField, form) {
  const candidates = []
  const inputs = (form ? form.querySelectorAll('input') : document.querySelectorAll('input'))
  for (const inp of inputs) {
    if (inp === passwordField) break
    const t = (inp.type || '').toLowerCase()
    if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'checkbox' || t === 'radio') continue
    if (t === 'email' || t === 'tel') { candidates.push({ inp, score: 100 }); continue }
    if (t === 'text' || t === '') {
      // Score by name/id/autocomplete/placeholder hints
      const hints = (inp.name + ' ' + inp.id + ' ' + (inp.autocomplete || '') + ' ' + (inp.placeholder || '')).toLowerCase()
      let s = 10
      if (/email|e-?post/.test(hints)) s += 80
      if (/user|login|account|namn|name/.test(hints)) s += 40
      if (/phone|mobile|mobil/.test(hints)) s += 20
      candidates.push({ inp, score: s })
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].inp
}

function _detectLoginForm() {
  // Look for visible password fields. Skip inputs we've already wired,
  // or invisible fields used for confirm-password / hidden auth flows.
  const all = document.querySelectorAll('input[type="password"]')
  for (const pw of all) {
    if (pw.dataset.seozAutofill === 'wired') continue
    if (!pw.offsetParent && getComputedStyle(pw).display === 'none') continue
    const form = pw.closest('form') || null
    const user = _findUsernameField(pw, form)
    return { user, pass: pw, form }
  }
  return null
}

function _wireFields(d) {
  if (!d) return
  d.pass.dataset.seozAutofill = 'wired'
  if (d.user) d.user.dataset.seozAutofill = 'wired'

  // Capture submit OR Enter OR submit-button click — Facebook and
  // other SPAs often preventDefault() the form submit and run a
  // fetch() instead, so we listen to several signals and dedupe on
  // the host side. Capture phase ensures we run BEFORE the page's
  // own handler so even preventDefault'd events still feed us creds.
  const sendSave = () => {
    try {
      const username = d.user ? String(d.user.value || '').trim() : ''
      const password = String(d.pass.value || '')
      if (!password) return
      // Dedupe identical sends within 1 second — covers cases where
      // both form-submit and a button-click event fire for the same
      // login attempt.
      const key = username + '|' + password
      if (_lastSendKey === key) return
      _lastSendKey = key
      setTimeout(() => { if (_lastSendKey === key) _lastSendKey = '' }, 1000)
      _send('seoz-autofill-save', {
        site: location.hostname,
        pageUrl: location.href,
        username,
        password,
      })
    } catch (err) {
      try { console.warn('[seoz-autofill] sendSave failed:', err?.message || err) } catch (_) {}
    }
  }

  // 1. Form submit — works whenever the page has a real <form>.
  if (d.form) {
    d.form.addEventListener('submit', sendSave, { capture: true })
  }
  // 2. Enter key on password field — covers most form-less SPAs.
  d.pass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendSave()
  }, { capture: true })
  // 3. Click on a submit-like button — Facebook's login button does
  //    NOT trigger form-submit (they use fetch + history.pushState).
  //    Scope the listener to the form when present, otherwise to the
  //    password field's nearest section so we don't catch unrelated
  //    buttons elsewhere on the page.
  const scope = d.form || d.pass.closest('section, div[role="dialog"], .login, [class*="login"]') || document
  scope.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [role="button"], input[type="submit"]')
    if (!btn) return
    const t = (btn.type || '').toLowerCase()
    const text = (btn.textContent || btn.value || '').toLowerCase()
    if (t === 'submit' || /^(log\s*in|sign\s*in|logga\s*in|continue|fortsätt|next|nästa)$/.test(text.trim())) {
      // Defer slightly so the field values are settled.
      setTimeout(sendSave, 50)
    }
  }, { capture: true })
}

function _scanAndRequest() {
  try {
    const d = _detectLoginForm()
    if (!d) return
    _detectedFields = d
    _wireFields(d)
    const sig = _formSig(d.user, d.pass)
    if (sig === _lastSig) return    // already asked for this form
    _lastSig = sig
    _send('seoz-autofill-request', {
      site: location.hostname,
      pageUrl: location.href,
    })
  } catch (err) {
    try { console.warn('[seoz-autofill] scan failed:', err?.message || err) } catch (_) {}
  }
}

// Host pushes credentials to fill. We only fill if our currently-wired
// fields are still in the DOM and untouched by the user.
ipcRenderer.on('seoz-autofill-fill', (_e, payload) => {
  const d = _detectedFields
  if (!d) return
  const { username, password } = payload || {}
  if (d.user && username && !d.user.value) {
    d.user.value = username
    d.user.dispatchEvent(new Event('input', { bubbles: true }))
    d.user.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (d.pass && password && !d.pass.value) {
    d.pass.value = password
    d.pass.dispatchEvent(new Event('input', { bubbles: true }))
    d.pass.dispatchEvent(new Event('change', { bubbles: true }))
  }
})

function _bootstrap() {
  _scanAndRequest()
  // Re-scan on DOM mutations — covers SPA login modals and lazy mounts.
  // Debounced so we don't run the scan on every keystroke.
  const observer = new MutationObserver(() => {
    clearTimeout(_scanTimer)
    _scanTimer = setTimeout(_scanAndRequest, 250)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bootstrap, { once: true })
} else {
  _bootstrap()
}
