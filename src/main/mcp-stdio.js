#!/usr/bin/env node
'use strict'

/**
 * SEOZ Browser MCP — stdio wrapper
 *
 * Claude Desktop launches this as a child process.
 * It reads JSON-RPC from stdin and proxies to the HTTP MCP server
 * running inside the Electron app on port 19532.
 */

const http = require('http')

const MCP_PORT = 19532
const MCP_HOST = '127.0.0.1'

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({
      hostname: MCP_HOST,
      port: MCP_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let chunks = ''
      res.on('data', c => chunks += c)
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)) }
        catch { resolve(chunks) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Read line-delimited JSON from stdin
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  // Process complete lines (JSON-RPC messages are newline-delimited)
  const lines = buffer.split('\n')
  buffer = lines.pop() // keep incomplete line in buffer

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    handleMessage(trimmed)
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})

async function handleMessage(raw) {
  let msg
  try { msg = JSON.parse(raw) }
  catch {
    writeError(null, -32700, 'Parse error')
    return
  }

  const { id, method, params } = msg

  // Handle initialize locally (don't proxy)
  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'SEOZ Browser', version: '1.1.0' }
    })
    return
  }

  // Notifications don't need a response
  if (method === 'notifications/initialized') {
    return
  }

  // Proxy everything else to the HTTP server (with retry for tools/list)
  const maxRetries = method === 'tools/list' ? 8 : 1
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500))
      const response = await httpPost('/message', raw)
      process.stderr.write(`[MCP-stdio] ${method} -> ok (attempt ${attempt + 1})\n`)
      if (typeof response === 'object') {
        write(response)
      }
      return
    } catch (err) {
      if (err.code === 'ECONNREFUSED' && attempt < maxRetries - 1) {
        process.stderr.write(`[MCP-stdio] ${method} -> ECONNREFUSED, retrying (${attempt + 1}/${maxRetries})...\n`)
        continue
      }
      if (err.code === 'ECONNREFUSED') {
        writeError(id, -32000, 'SEOZ Browser is not running. Start it with "npm start" first.')
      } else {
        writeError(id, -32603, `Proxy error: ${err.message}`)
      }
      return
    }
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function writeResult(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function writeError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

// Signal that we're ready
process.stderr.write('[MCP-stdio] SEOZ Browser MCP proxy ready\n')
