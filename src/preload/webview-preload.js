'use strict'
// ════════════════════════════════════════════════════════════════════
//  Login-form preload — runs inside every tab page (WebContentsView)
//  AND inside native OAuth popup BrowserWindows. Detects login forms,
//  asks the host renderer for matching saved credentials, and offers
//  to save new ones on form submit.
//
//  Channels:
//    seoz-autofill-request {site, pageUrl}     → host
//    seoz-autofill-fill    {username, password} → tab (from host)
//    seoz-autofill-save    {site, username, password} → host
//
//  Transport differs by context:
//    - Tabs (WebContentsView): use ipcRenderer.send('tab:relay-from-
//      preload', channel, payload). main forwards to the host renderer
//      as a `tab:event` ipc-message so existing addEventListener
//      ('ipc-message') call sites still work.
//    - OAuth popups (BrowserWindow): use ipcRenderer.send with a
//      'popup-' prefix. main relays to the main-window renderer the
//      same way it always did.
// ════════════════════════════════════════════════════════════════════

const { ipcRenderer, webFrame } = require('electron')

// Tab-vs-popup detection — used by _send() below to pick the right
// relay channel. TabManager passes --seoz-tab=1 in additionalArguments
// when it spawns a WebContentsView. We also fall back to detecting the
// presence of `process.guestInstanceId` (legacy <webview> path) for
// safety during the migration window.
const _IN_TAB = (() => {
  try {
    if (Array.isArray(process?.argv) && process.argv.includes('--seoz-tab=1')) return true
  } catch (_) {}
  try {
    if (typeof process !== 'undefined' && process.guestInstanceId !== undefined) return true
  } catch (_) {}
  return false
})()

// ════════════════════════════════════════════════════════════════════
//  ⚠️  DO NOT ADD MORE STEALTH PATCHES BELOW.
//
//  Adding navigator.webdriver / plugins / languages / WebGL spoofs /
//  window.chrome shims / userAgentData hand-builds has been tried
//  multiple times and it ALWAYS makes Google sign-in WORSE, not better.
//  See memory/project_seoz_browser_google_auth.md for the full
//  forensic write-up — bot-detection is inconsistency-based and every
//  spoof we add is a new opportunity for our hand-built value to
//  desynchronise from what Chromium emits internally.
//
//  The ONLY stealth code that belongs here is the WebAuthn block —
//  and only because Chromium-in-Electron pops the Windows passkey
//  dialog more eagerly than real Chrome does, which is a UX problem,
//  not a detection problem.
//
//  If Google sign-in starts failing again, the diagnostic order is:
//    1) Clear cookies — see the auto-recovery banner in renderer.
//    2) Compare fingerprints with Strawberry via the DevTools snippet
//       in the memory doc.
//    3) Only after BOTH of those rule-out: consider adding code here.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  STEALTH — Strawberry-minimal approach (v1.10.132)
//
//  Lesson learned from inspecting Strawberry's app.asar: the LESS we
//  override, the better. Their entire stealth strategy is:
//
//    1) Strip "Electron/x.y.z" + app-name suffix from the User-Agent
//       header (set at session level). That's it. They DO NOT touch
//       Sec-CH-UA or any client-hints headers — Chromium emits those
//       natively from its own internals, and those internals reflect
//       the real Chromium version that's running.
//    2) ZERO JS-level patches. No navigator.webdriver, no plugins
//       spoofing, no UA-data shimming. They trust Chromium-under-the-
//       hood to emit authentic-Chrome signals because it IS Chromium.
//
//  Our previous approach of patching navigator.userAgentData,
//  navigator.plugins, WebGL, etc. introduced subtle inconsistencies
//  Google's bot-detector flags. Example: our hand-built Sec-CH-UA had
//  brand "Not.A/Brand" while Chromium's native emit may use "Not_A
//  Brand" — one mismatch is enough.
//
//  This block now only blocks WebAuthn (to stop the Windows passkey
//  popup that the user sees on Google sign-in pages). Everything else
//  is left native.
// ════════════════════════════════════════════════════════════════════
;(function applyStealth() {
  const STEALTH_PATCHES = String.raw`(function() {
    try {
      if (window.__seozMW) return;
      window.__seozMW = true;

      // WebAuthn / passkey block — only thing we still need to patch.
      // Without this, accounts.google.com pops the Windows "Välj en
      // nyckel" dialog before the user even tries to sign in. Real
      // Chrome doesn't pop it unless the user has actually registered
      // a passkey, but Chromium-in-Electron is more eager. Reporting
      // "no platform authenticator + no conditional UI" makes Google
      // skip the passkey assertion entirely and just show the password
      // form.
      try {
        if (typeof window.PublicKeyCredential !== 'undefined') {
          var _falseAsync = function () { return Promise.resolve(false); };
          try { delete PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable; } catch (_) {}
          try { Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { value: _falseAsync, writable: true, configurable: true }); } catch (_) {}
          try { delete PublicKeyCredential.isConditionalMediationAvailable; } catch (_) {}
          try { Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { value: _falseAsync, writable: true, configurable: true }); } catch (_) {}
        }
      } catch (_) {}
      try {
        if (navigator.credentials) {
          var _origGet    = navigator.credentials.get    && navigator.credentials.get.bind(navigator.credentials);
          var _origCreate = navigator.credentials.create && navigator.credentials.create.bind(navigator.credentials);
          var _denied = function () {
            return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
          };
          if (_origGet) {
            navigator.credentials.get = function (opts) {
              if (opts && (opts.publicKey || opts.mediation === 'conditional')) return _denied();
              return _origGet(opts);
            };
          }
          if (_origCreate) {
            navigator.credentials.create = function (opts) {
              if (opts && opts.publicKey) return _denied();
              return _origCreate(opts);
            };
          }
        }
      } catch (_) {}

      try { document.documentElement.setAttribute('data-seoz-mw', 'v1.10.132-minimal'); } catch (_) {}
    } catch (e) {
      // Silent — page must continue regardless of patch failures.
    }
  })();`

  try {
    webFrame.executeJavaScript(STEALTH_PATCHES, false).catch(() => {})
  } catch (_) {}
})()


function _send(channel, payload) {
  try {
    if (_IN_TAB) ipcRenderer.send('tab:relay-from-preload', channel, payload)
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

// ════════════════════════════════════════════════════════════════════
//  Cookie-banner auto-handler (SEOZ Shield)
//
//  When the user has set Shield → Cookies to "Acceptera alla" or
//  "Neka alla", this code finds the consent banner on every page and
//  clicks the matching button so they don't have to.
//
//  Strategy:
//    1. Match well-known CMP IDs/classes first (OneTrust, Cookiebot,
//       Didomi, Quantcast, TrustArc, Osano, Klaro, …). These cover
//       roughly 70% of real-world cookie banners and are zero-risk
//       (the IDs are stable and unique to consent UI).
//    2. Fall back to text matching against visible buttons inside
//       elements that look like a banner (id/class contains "cookie",
//       "consent", "gdpr", "privacy"). Multilingual: SE + EN.
//    3. Stop after one successful click per page so we don't fight
//       a re-rendering banner.
//
//  Mode is fetched once at startup and cached. We re-check on every
//  DOM mutation since banners often mount async.
// ════════════════════════════════════════════════════════════════════

let _cookieMode = 'off'
let _cookieClicked = false

// Known accept buttons keyed by stable selector. Order matters — most
// specific first. Each entry is { sel, kind } where kind is 'accept'
// or 'reject'.
const COOKIE_SELECTORS = [
  // OneTrust
  { sel: '#onetrust-accept-btn-handler', kind: 'accept' },
  { sel: '#onetrust-reject-all-handler', kind: 'reject' },
  { sel: 'button.ot-pc-refuse-all-handler', kind: 'reject' },
  // Cookiebot (Cybot)
  { sel: '#CybotCookiebotDialogBodyLevelButtonAccept', kind: 'accept' },
  { sel: '#CybotCookiebotDialogBodyButtonAccept', kind: 'accept' },
  { sel: '#CybotCookiebotDialogBodyLevelButtonAcceptAll', kind: 'accept' },
  { sel: '#CybotCookiebotDialogBodyButtonDecline', kind: 'reject' },
  // Didomi
  { sel: '#didomi-notice-agree-button', kind: 'accept' },
  { sel: '#didomi-notice-disagree-button', kind: 'reject' },
  { sel: 'button[aria-label*="Agree" i]', kind: 'accept' },
  // Quantcast
  { sel: '.qc-cmp2-summary-buttons button[mode="primary"]', kind: 'accept' },
  { sel: '.qc-cmp2-summary-buttons button[mode="secondary"]', kind: 'reject' },
  // TrustArc
  { sel: '#truste-consent-button', kind: 'accept' },
  { sel: '#truste-consent-required', kind: 'reject' },
  // Klaro
  { sel: '.klaro .cm-btn-success', kind: 'accept' },
  { sel: '.klaro .cm-btn-danger', kind: 'reject' },
  // Cookie Consent (insites)
  { sel: '.cc-btn.cc-allow', kind: 'accept' },
  { sel: '.cc-btn.cc-dismiss', kind: 'accept' },
  { sel: '.cc-btn.cc-deny', kind: 'reject' },
  // Osano
  { sel: '.osano-cm-accept-all', kind: 'accept' },
  { sel: '.osano-cm-deny-all', kind: 'reject' },
  // Usercentrics
  { sel: 'button[data-testid="uc-accept-all-button"]', kind: 'accept' },
  { sel: 'button[data-testid="uc-deny-all-button"]', kind: 'reject' },
  // Termly
  { sel: '#truste-consent-button', kind: 'accept' },
  // Borlabs
  { sel: 'a._brlbs-btn-accept-all, button._brlbs-btn-accept-all', kind: 'accept' },
  { sel: 'a._brlbs-btn-refuse, button._brlbs-btn-refuse', kind: 'reject' },
]

// Multilingual text patterns — used for banners without stable IDs.
// Tested against trimmed lowercase button text.
const ACCEPT_TEXTS = [
  'accept all', 'accept all cookies', 'accept cookies', 'allow all',
  'allow cookies', 'i accept', 'i agree', 'agree', 'got it', 'ok',
  'acceptera alla', 'acceptera', 'godkänn alla', 'godkänn', 'tillåt alla',
  'tillåt', 'jag godkänner', 'jag accepterar',
]
const REJECT_TEXTS = [
  'reject all', 'reject cookies', 'decline all', 'decline', 'deny',
  'refuse all', 'only necessary', 'necessary only',
  'neka alla', 'neka', 'avvisa alla', 'avvisa', 'endast nödvändiga',
  'endast nödvändigt', 'bara nödvändiga',
]

function _isVisible(el) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
  return true
}

function _looksLikeCookieBanner(el) {
  let cur = el
  for (let i = 0; i < 6 && cur; i++) {
    const sig = ((cur.id || '') + ' ' + (cur.className || '')).toLowerCase()
    if (/cookie|consent|gdpr|privacy|cmp|onetrust|didomi|cookiebot/.test(sig)) return true
    cur = cur.parentElement
  }
  return false
}

function _clickByText(kind) {
  const wanted = kind === 'accept' ? ACCEPT_TEXTS : REJECT_TEXTS
  // Scan buttons + role=button + anchor links — banners use all three.
  const nodes = document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"], a'
  )
  for (const el of nodes) {
    if (!_isVisible(el)) continue
    const txt = (el.textContent || el.value || '').trim().toLowerCase()
    if (!txt || txt.length > 60) continue
    if (!wanted.includes(txt)) continue
    if (!_looksLikeCookieBanner(el)) continue
    try { el.click(); return true } catch (_) { /* keep trying */ }
  }
  return false
}

function _handleCookieBanner() {
  if (_cookieClicked) return
  if (_cookieMode !== 'accept' && _cookieMode !== 'reject') return

  // 1. Try known CMP selectors first (high precision, near-zero risk).
  for (const { sel, kind } of COOKIE_SELECTORS) {
    if (kind !== _cookieMode) continue
    let el = null
    try { el = document.querySelector(sel) } catch (_) { continue }
    if (!el || !_isVisible(el)) continue
    try {
      el.click()
      _cookieClicked = true
      return
    } catch (_) { /* fall through */ }
  }

  // 2. Fall back to text matching inside cookie-banner-like containers.
  if (_clickByText(_cookieMode)) {
    _cookieClicked = true
  }
}

async function _initCookieMode() {
  try {
    // Both webview and popup contexts can call invoke('cookies-get-mode')
    // directly — main exposes the same handler regardless.
    const mode = await ipcRenderer.invoke('cookies-get-mode')
    if (typeof mode === 'string') _cookieMode = mode
  } catch (_) {
    // No IPC available (rare) — leave mode 'off' and skip.
  }
}

function _bootstrap() {
  _initCookieMode().then(() => {
    _handleCookieBanner()
  })
  _scanAndRequest()
  // Re-scan on DOM mutations — covers SPA login modals AND lazy-mounted
  // cookie banners. Debounced so we don't run the scan on every keystroke.
  const observer = new MutationObserver(() => {
    clearTimeout(_scanTimer)
    _scanTimer = setTimeout(() => {
      _scanAndRequest()
      _handleCookieBanner()
    }, 250)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bootstrap, { once: true })
} else {
  _bootstrap()
}
