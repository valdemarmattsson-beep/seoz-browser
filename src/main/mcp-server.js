'use strict'

/**
 * SEOZ MCP Server
 *
 * Exposes browser capabilities via the Model Context Protocol (MCP) over HTTP+SSE.
 * Claude Code / Cowork can connect to this server to control the browser.
 *
 * Default: http://localhost:19532
 */

const http = require('http')
const crypto = require('crypto')

const MCP_PORT = 19532
const PROTOCOL_VERSION = '2024-11-05'

let server = null
let win = null
const mcpSessions = new Map() // sessionId -> { createdAt }
let getWinFn = null
let terminalExecFn = null
let historySearchFn = null

function setWindowGetter(fn) {
  getWinFn = fn
}

function setTerminalExec(fn) {
  terminalExecFn = fn
}

function setHistorySearch(fn) {
  historySearchFn = fn
}

function getWindow() {
  if (getWinFn) return getWinFn()
  return win
}

// ── Tool definitions ──
// NOTE: Cowork (Claude Desktop) shows at most ~19 tools per MCP server.
// Tools tagged `visible: false` stay in the registry (tools/call still
// works if Claude knows the name), but are hidden from tools/list so the
// core set fits inside Cowork's budget. Treat `visible: false` as
// "power-user / niche" — the 19 visible tools cover 95% of real use.
const TOOLS = [
  {
    name: 'run_command',
    description: 'Execute a shell command on the user\'s local machine and return stdout/stderr. Runs in PowerShell on Windows, bash on Mac/Linux. Use for git, npm, build, deploy, file operations, etc. Commands are logged to session history for future reference.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (defaults to user home directory)' }
      },
      required: ['command']
    }
  },
  {
    name: 'search_session_history',
    description: 'Search the session history database for past terminal commands and their output. Useful for finding what was done in previous sessions, recalling error messages, checking deployment history, etc. Filter by exit code to investigate failures only ({ failedOnly: true }) or confirmed successes ({ successOnly: true }).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — matches against commands, stdout, stderr, and working directory. Leave empty to just list recent entries by filter.' },
        limit: { type: 'number', description: 'Max number of results to return (default 20)' },
        successOnly: { type: 'boolean', description: 'Only return commands that exited with code 0' },
        failedOnly:  { type: 'boolean', description: 'Only return commands that exited with non-zero code (e.g. to debug failures)' },
        exitCode:    { type: 'number',  description: 'Filter by exact exit code (e.g. 127 for "command not found")' }
      }
    }
  },
  {
    name: 'navigate',
    description: 'Navigate the active browser tab to a URL and wait for the page to finish loading before returning',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
        wait: { type: 'boolean', description: 'Wait for page load to complete (default true)' }
      },
      required: ['url']
    }
  },
  {
    name: 'get_page_content',
    description: 'Get the text content, title, URL and meta tags of the currently loaded page',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to limit extraction to a specific element' }
      }
    }
  },
  {
    name: 'get_page_html',
    visible: false,
    description: 'Get the raw HTML of the currently loaded page (or a specific element)',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector. Returns outerHTML of matched element.' }
      }
    }
  },
  {
    name: 'execute_javascript',
    description: 'Execute JavaScript code in the context of the currently loaded page and return the result',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Must return a serializable value.' }
      },
      required: ['code']
    }
  },
  {
    name: 'click',
    description: 'Click an element on the page identified by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' }
      },
      required: ['selector']
    }
  },
  {
    name: 'type_text',
    description: 'Type text into an input element identified by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element' },
        text: { type: 'string', description: 'Text to type into the element' },
        clear: { type: 'boolean', description: 'Clear existing content before typing (default true)' }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'get_session_state',
    description: 'Get a snapshot of the current MCP session state: URL, page title, cookies visible to the page, auth heuristics (login form / logout link presence), and recent navigation history. Use this at the start of a fresh conversation to understand where the session is, or after returning from a long gap, to avoid re-logging-in or re-navigating. Cheaper than screenshot + get_page_content for quick orientation.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_tabs',
    description: 'List all open browser tabs with their IDs, titles and URLs',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'switch_tab',
    description: 'Switch to a specific browser tab by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'The tab ID to switch to' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'new_tab',
    description: 'Open a new browser tab, optionally navigating to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (defaults to Google)' }
      }
    }
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'The tab ID to close' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page. Returns base64 PNG.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_seo_analysis',
    visible: false,
    description: 'Run a comprehensive SEO analysis on the current page (title, meta, headings, links, images, schema, performance)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_console_logs',
    visible: false,
    description: 'Get recent JavaScript console messages from the current page',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_network_requests',
    visible: false,
    description: 'Get network requests made by the current page (via Performance API)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'scroll',
    description: 'Scroll the page by a specified amount or to a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 500)' }
      },
      required: ['direction']
    }
  },
  {
    name: 'find_in_page',
    description: 'Search for text on the current page',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to search for' }
      },
      required: ['text']
    }
  },
  {
    name: 'get_interactive_elements',
    description: 'List all interactive elements on the page (links, buttons, inputs, selects, textareas) with their CSS selector, tag, text, type, href and visibility. Essential for understanding what actions are available on a page.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'links', 'buttons', 'inputs', 'forms'], description: 'Filter by element type (default: all)' }
      }
    }
  },
  {
    name: 'click_text',
    description: 'Click the first visible element whose text content matches the given string. Searches buttons, links, and other clickable elements. Much easier than finding a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to match (case-insensitive, partial match)' },
        tag: { type: 'string', description: 'Optional: limit search to specific tag (a, button, etc.)' }
      },
      required: ['text']
    }
  },
  {
    name: 'wait_for',
    description: 'Wait for a CSS selector to appear on the page, or wait a fixed number of seconds. Useful after navigation or clicking to ensure content has loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout: { type: 'number', description: 'Max wait time in ms (default 5000)' },
        delay: { type: 'number', description: 'Fixed delay in ms instead of waiting for selector' }
      }
    }
  },
  {
    name: 'select_option',
    visible: false,
    description: 'Select an option from a <select> dropdown by its visible text or value. Can also list available options.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the <select> element' },
        value: { type: 'string', description: 'Option value or visible text to select' },
        list: { type: 'boolean', description: 'If true, just list all available options without selecting' }
      },
      required: ['selector']
    }
  },
  {
    name: 'get_page_structure',
    description: 'Get a compact structural overview of the page: headings hierarchy, landmark regions, forms, and main content sections. Much faster than reading all text for understanding page layout.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'fill_form',
    description: 'Fill multiple form fields at once. Each field is specified as a selector-value pair. Handles text inputs, textareas, checkboxes, radio buttons, and selects.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Array of {selector, value} pairs. For checkboxes/radios, value is "true"/"false".',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of the form field' },
              value: { type: 'string', description: 'Value to set' }
            },
            required: ['selector', 'value']
          }
        },
        submit: { type: 'boolean', description: 'Submit the form after filling (default false)' }
      },
      required: ['fields']
    }
  },
  // ── Design Mode tools ──
  // Hidden from tools/list — Design Mode is a user-driven feature (activated
  // from the UI). Claude discovers these via design_get_selection payload
  // once the user pushes changes. Keeps the visible tool budget for
  // general-purpose work.
  {
    name: 'design_toggle',
    visible: false,
    description: 'Toggle Design Mode on/off. Design Mode is a Figma-like overlay that lets the user inspect, annotate, and move elements on the page. Use this to activate the overlay before using other design_ tools.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'design_get_selection',
    visible: false,
    description: 'Get the full Design Mode payload after the user clicked "Push till Claude". Returns all tracked changes (text edits, CSS changes, moved elements, hidden elements) with original and modified values, plus page URL and surrounding HTML context. Use this to understand what the user changed visually, then use run_command to find and edit the actual source files.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'design_get_changes',
    visible: false,
    description: 'Get the list of visual changes the user made in Design Mode. Each change has: selector, type (text/css/move/hide), description, original value, and modified value. Use this to map DOM changes back to source code files.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'design_apply_css',
    visible: false,
    description: 'Apply CSS changes to an element on the page. Takes a CSS selector and an object of CSS property-value pairs. Use this to implement design changes the user requested via Design Mode. Example: { "selector": ".hero-title", "css": { "fontSize": "48px", "color": "#1a1a1a" } }',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to modify' },
        css: { type: 'object', description: 'Object of CSS property-value pairs (camelCase keys). E.g. { "fontSize": "16px", "backgroundColor": "#fff" }' }
      },
      required: ['selector', 'css']
    }
  },
  {
    name: 'design_apply_html',
    visible: false,
    description: 'Replace an element\'s HTML on the page. Takes a CSS selector and the new outerHTML. Use for structural changes like rewriting a component\'s markup. The change is live-previewed in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to replace' },
        html: { type: 'string', description: 'New outerHTML to replace the element with' }
      },
      required: ['selector', 'html']
    }
  },
  {
    name: 'design_set_text',
    visible: false,
    description: 'Change the visible text content of an element on the page. Use this for simple text edits like updating headings, button labels, paragraphs, etc. Preserves child elements — only replaces text nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element whose text to change' },
        text: { type: 'string', description: 'New text content' }
      },
      required: ['selector', 'text']
    }
  },
]

// ── Execute MCP tool via IPC to renderer (or directly for terminal) ──
async function executeTool(name, args, sessionId) {
  // Terminal tools run directly in main process — no renderer round-trip
  if (name === 'run_command') {
    if (!terminalExecFn) throw new Error('Terminal not initialised')
    const entry = await terminalExecFn(args.command, args.cwd, 'mcp')
    const parts = [`$ ${entry.command}`, '']
    if (entry.stdout) parts.push(entry.stdout.trimEnd())
    if (entry.stderr) parts.push('[stderr] ' + entry.stderr.trimEnd())
    parts.push(`\n[exit ${entry.exitCode}] ${entry.duration}ms`)
    return parts.join('\n')
  }

  if (name === 'search_session_history') {
    if (!historySearchFn) throw new Error('History not initialised')
    const opts = {
      successOnly: args.successOnly === true,
      failedOnly:  args.failedOnly === true,
      exitCode:    typeof args.exitCode === 'number' ? args.exitCode : undefined,
    }
    const results = historySearchFn(args.query, args.limit || 20, opts)
    if (!results.length) {
      const filterDesc = opts.successOnly ? ' (successOnly)' : opts.failedOnly ? ' (failedOnly)' : opts.exitCode !== undefined ? ` (exitCode=${opts.exitCode})` : ''
      return `No matching history entries found${filterDesc}.`
    }
    return results.map(e =>
      `[${e.timestamp}] (${e.source}) ${e.cwd}\n$ ${e.command}\n→ exit ${e.exitCode} (${e.duration}ms)${e.stdout ? '\n' + e.stdout.slice(0, 500) : ''}${e.stderr ? '\n[stderr] ' + e.stderr.slice(0, 200) : ''}`
    ).join('\n\n---\n\n')
  }

  const w = getWindow()
  if (!w) throw new Error('Browser window not available')

  // Browser tools execute JS in the webview via renderer
  const result = await w.webContents.executeJavaScript(
    `window.__mcpExecute(${JSON.stringify(name)}, ${JSON.stringify(args)}, ${JSON.stringify(sessionId)})`
  )
  return result
}

// ── JSON-RPC response helpers ──
function jsonrpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

// ── Handle JSON-RPC requests ──
async function handleRequest(body, sessionId) {
  let req
  try { req = JSON.parse(body) } catch { return jsonrpcError(null, -32700, 'Parse error') }

  const { id, method, params } = req

  switch (method) {
    case 'initialize':
      return jsonrpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'SEOZ', version: '1.0.0' }
      })

    case 'notifications/initialized':
      return null // no response needed

    case 'tools/list':
      // Expose only tools marked as visible (undefined === visible by default).
      // Strip our internal `visible` key before responding — MCP spec doesn't
      // expect it and Cowork may reject unknown fields on strict parsers.
      return jsonrpcResult(id, {
        tools: TOOLS
          .filter(t => t.visible !== false)
          .map(({ visible, ...rest }) => rest)
      })

    case 'tools/call': {
      const { name, arguments: args } = params || {}
      try {
        const result = await executeTool(name, args || {}, sessionId)
        const text = result == null ? String(result) : (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        return jsonrpcResult(id, {
          content: [{ type: 'text', text }]
        })
      } catch (err) {
        return jsonrpcResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        })
      }
    }

    case 'ping':
      return jsonrpcResult(id, {})

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`)
  }
}

// ── Start HTTP server ──
function startMCPServer() {
  if (server) return

  server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', server: 'seoz-browser-mcp', port: MCP_PORT }))
      return
    }

    // SSE endpoint for MCP streamable transport
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      // Send the message endpoint
      const sessionId = crypto.randomUUID()
      res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`)

      // Keep alive
      const keepAlive = setInterval(() => { res.write(':keepalive\n\n') }, 15000)
      mcpSessions.set(sessionId, { createdAt: Date.now() })
      req.on('close', () => {
        clearInterval(keepAlive)
        mcpSessions.delete(sessionId)
        // Tell renderer to destroy the MCP webview for this session
        const w = getWindow()
        if (w) w.webContents.executeJavaScript(`window.__mcpCleanupSession(${JSON.stringify(sessionId)})`).catch(() => {})
      })
      return
    }

    // JSON-RPC message endpoint
    if (req.method === 'POST' && (req.url === '/message' || req.url?.startsWith('/message?'))) {
      // Extract sessionId from query string — generate one if missing so MCP ops never touch user's active tab
      const msgUrl = new URL(req.url, 'http://localhost')
      let sessionId = msgUrl.searchParams.get('sessionId') || null
      if (!sessionId) {
        sessionId = '_anon_' + crypto.randomUUID()
        mcpSessions.set(sessionId, { createdAt: Date.now(), anonymous: true })
      }
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', async () => {
        try {
          const response = await handleRequest(body, sessionId)
          if (response === null) {
            res.writeHead(202); res.end(); return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(response)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(jsonrpcError(null, -32603, err.message))
        }
      })
      return
    }

    // MCP info page
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        name: 'SEOZ MCP Server',
        version: '1.0.0',
        protocol: PROTOCOL_VERSION,
        tools: TOOLS.map(t => t.name),
        endpoints: {
          sse: '/sse',
          message: '/message',
          health: '/health'
        }
      }))
      return
    }

    res.writeHead(404); res.end('Not Found')
  })

  // Surface HTTP-level errors instead of silently dying
  server.on('clientError', (err, socket) => {
    console.warn('[MCP] clientError:', err.message)
    try { socket.destroy() } catch {}
  })

  server.on('close', () => {
    console.log('[MCP] server closed')
  })

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[MCP] SEOZ MCP Server running on http://127.0.0.1:${MCP_PORT}`)
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // DO NOT silently shift to another port — the stdio proxy hardcodes 19532.
      // Most likely cause: a stale instance of SEOZ is still running.
      console.error(
        `[MCP] Port ${MCP_PORT} already in use. ` +
        `Another SEOZ instance is likely running. ` +
        `Close it (check Task Manager for electron.exe) and relaunch.`
      )
      server = null
    } else {
      console.error('[MCP] Server error:', err)
      server = null
    }
  })
}

// Async-safe shutdown: actually waits for close before resolving so a
// subsequent startMCPServer() doesn't race the old listener.
function stopMCPServer() {
  return new Promise(resolve => {
    if (!server) return resolve()
    const s = server
    server = null
    s.close(err => {
      if (err) console.warn('[MCP] error during close:', err.message)
      resolve()
    })
    // Close keep-alive connections so .close() actually completes promptly
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections()
  })
}

// Global safety nets — a single bad tool call shouldn't kill the port
process.on('unhandledRejection', (reason) => {
  console.error('[MCP] unhandledRejection:', reason && reason.stack || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[MCP] uncaughtException:', err && err.stack || err)
})

module.exports = { startMCPServer, stopMCPServer, setWindowGetter, setTerminalExec, setHistorySearch }
