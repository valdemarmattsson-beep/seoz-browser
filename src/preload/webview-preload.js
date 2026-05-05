'use strict'
// ════════════════════════════════════════════════════════════════════
//  Webview preload — runs inside every guest page in our <webview>
//  tags. Detects login forms, asks the host renderer for matching
//  saved credentials, and offers to save new ones on form submit.
//
//  Communicates with the host via ipcRenderer.sendToHost() / on().
//  Channels:
//    seoz-autofill-request {site, pageUrl}     → host
//    seoz-autofill-fill    {username, password} → guest (from host)
//    seoz-autofill-save    {site, username, password} → host
// ════════════════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron')

let _scanTimer = null
let _detectedFields = null   // { user, pass, form } or null
let _saveSentForCurrent = false

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

  // Capture submit (form-level OR Enter on password field) so we can
  // offer to save the credentials on the host side.
  const sendSave = () => {
    if (_saveSentForCurrent) return
    const username = d.user ? String(d.user.value || '').trim() : ''
    const password = String(d.pass.value || '')
    if (!password) return
    _saveSentForCurrent = true
    ipcRenderer.sendToHost('seoz-autofill-save', {
      site: location.hostname,
      pageUrl: location.href,
      username,
      password,
    })
  }
  if (d.form) {
    d.form.addEventListener('submit', sendSave, { capture: true })
  } else {
    // Form-less login (common in SPAs) — listen for Enter on the
    // password input, plus a "submit-likely" button click nearby.
    d.pass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendSave()
    }, { capture: true })
  }
}

function _scanAndRequest() {
  const d = _detectLoginForm()
  if (!d) return
  _detectedFields = d
  _wireFields(d)
  const sig = _formSig(d.user, d.pass)
  if (sig === _lastSig) return    // already asked for this form
  _lastSig = sig
  _saveSentForCurrent = false
  ipcRenderer.sendToHost('seoz-autofill-request', {
    site: location.hostname,
    pageUrl: location.href,
  })
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
