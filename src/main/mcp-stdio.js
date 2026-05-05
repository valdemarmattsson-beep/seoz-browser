#!/usr/bin/env node
'use strict'

/**
 * SEOZ MCP — stdio wrapper
 *
 * Claude Desktop launches this as a child process.
 * It reads JSON-RPC from stdin and proxies to the HTTP MCP server
 * running inside the Electron app on port 19532.
 *
 * If the Electron app isn't running, this proxy will attempt to launch
 * it automatically and wait for the port to become available.
 */

const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const MCP_PORT = 19532
const MCP_HOST = '127.0.0.1'

// How long to wait for the app to come up (ms)
const STARTUP_TIMEOUT_MS = 30000
// How often to probe the port during startup (ms)
const PROBE_INTERVAL_MS = 500
// Disable auto-launch by setting SEOZ_MCP_AUTOLAUNCH=0
const AUTO_LAUNCH = process.env.SEOZ_MCP_AUTOLAUNCH !== '0'

// Project root (…/seoz-browser) — mcp-stdio.js lives in src/main/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

let appSpawned = false
let readyPromise = null // mutex: only one startup attempt at a time

function logStderr(msg) {
  process.stderr.write(`[MCP-stdio] ${msg}\n`)
}

// --- TCP probe -------------------------------------------------------------

function probePort(timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let done = false
    const finish = ok => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(MCP_PORT, MCP_HOST)
  })
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort()) return true
    await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS))
  }
  return false
}

// --- Auto-launch -----------------------------------------------------------

function launchApp() {
  if (appSpawned) return
  appSpawned = true
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    logStderr(`launching SEOZ via "${npmCmd} start" in ${PROJECT_ROOT}`)
    const child = spawn(npmCmd, ['start'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: process.platform === 'win32',
    })
    child.on('error', err => logStderr(`spawn error: ${err.message}`))
    child.unref()
  } catch (err) {
    logStderr(`failed to spawn app: ${err.message}`)
  }
}

function ensureAppReady() {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    if (await probePort()) return true
    if (AUTO_LAUNCH) launchApp()
    const ok = await waitForPort(STARTUP_TIMEOUT_MS)
    if (!ok) {
      // Reset so a later call can retry
      readyPromise = null
    }
    return ok
  })()
  return readyPromise
}

// --- HTTP ------------------------------------------------------------------

function httpPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({
      hostname: MCP_HOST,
      port: MCP_PORT,
      path: apiPath,
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

// --- Stdin loop ------------------------------------------------------------

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    handleMessage(trimmed)
  }
})

process.stdin.on('end', () => process.exit(0))

async function handleMessage(raw) {
  let msg
  try { msg = JSON.parse(raw) }
  catch {
    writeError(null, -32700, 'Parse error')
    return
  }

  const { id, method } = msg

  // Handle initialize locally (don't proxy)
  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'SEOZ', version: '1.1.0' }
    })
    return
  }

  // Notifications don't need a response
  if (method === 'notifications/initialized') return

  // Ensure app is ready before proxying
  const ready = await ensureAppReady()
  if (!ready) {
    writeError(id, -32000,
      'SEOZ did not start within ' + (STARTUP_TIMEOUT_MS / 1000) + 's. ' +
      'Start it manually with "npm start" in ' + PROJECT_ROOT + '.')
    return
  }

  // One quick retry in case the HTTP server is mid-restart
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 400))
      const response = await httpPost('/message', raw)
      logStderr(`${method} -> ok (attempt ${attempt + 1})`)
      if (typeof response === 'object') write(response)
      return
    } catch (err) {
      lastErr = err
      if (err.code === 'ECONNREFUSED') {
        logStderr(`${method} -> ECONNREFUSED, re-checking port`)
        // Port went away mid-request — re-wait and retry
        readyPromise = null
        const back = await ensureAppReady()
        if (!back) break
        continue
      }
      break
    }
  }

  if (lastErr && lastErr.code === 'ECONNREFUSED') {
    writeError(id, -32000, 'SEOZ connection lost. Please restart the app.')
  } else if (lastErr) {
    writeError(id, -32603, `Proxy error: ${lastErr.message}`)
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

logStderr('SEOZ MCP proxy ready')
