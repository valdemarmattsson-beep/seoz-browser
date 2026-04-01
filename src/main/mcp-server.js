'use strict'

/**
 * SEOZ Browser MCP Server
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
// NOTE: Cowork has a ~19 tool limit per MCP server — keep the most important tools first!
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
    description: 'Search the session history database for past terminal commands and their output. Useful for finding what was done in previous sessions, recalling error messages, checking deployment history, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — matches against commands, stdout, stderr, and working directory' },
        limit: { type: 'number', description: 'Max number of results to return (default 20)' }
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
    description: 'Run a comprehensive SEO analysis on the current page (title, meta, headings, links, images, schema, performance)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_console_logs',
    description: 'Get recent JavaScript console messages from the current page',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_network_requests',
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
    const results = historySearchFn(args.query, args.limit || 20)
    if (!results.length) return 'No matching history entries found.'
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
        serverInfo: { name: 'SEOZ Browser', version: '1.0.0' }
      })

    case 'notifications/initialized':
      return null // no response needed

    case 'tools/list':
      return jsonrpcResult(id, { tools: TOOLS })

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
      // Extract sessionId from query string
      const msgUrl = new URL(req.url, 'http://localhost')
      const sessionId = msgUrl.searchParams.get('sessionId') || null
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
        name: 'SEOZ Browser MCP Server',
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

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[MCP] SEOZ Browser MCP Server running on http://127.0.0.1:${MCP_PORT}`)
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[MCP] Port ${MCP_PORT} in use, trying ${MCP_PORT + 1}`)
      server.listen(MCP_PORT + 1, '127.0.0.1')
    } else {
      console.error('[MCP] Server error:', err)
    }
  })
}

function stopMCPServer() {
  if (server) { server.close(); server = null }
}

module.exports = { startMCPServer, stopMCPServer, setWindowGetter, setTerminalExec, setHistorySearch }
