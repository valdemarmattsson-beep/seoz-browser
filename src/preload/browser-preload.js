'use strict';
// Injected into the BrowserView (the actual web pages the user browses).
// Keep this minimal — it runs in untrusted page context.
// We only use it to communicate scroll position back if needed in future.

// Nothing exposed to page scripts — contextIsolation keeps this safe.
