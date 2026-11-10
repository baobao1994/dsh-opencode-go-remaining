/**
 * dsh-opencode-go-remaining — host half.
 *
 * Queries the official OpenCode Go usage endpoint and serves it to the browser
 * half over one loopback-only JSON route. Also registers an `opencode_usage`
 * agent tool so the model can answer "how much quota is left" without the UI.
 *
 *   GET https://opencode.ai/zen/go/v1/usage      Authorization: Bearer <key>
 *   → { usage: { rolling: {percent, resetsAt}, weekly: {...}, monthly: {...} } }
 *
 * The API key is resolved per request, in this order:
 *   1. `apiKey` in this plugin's config (cordis.patch.yml row);
 *   2. `ctx.credentials.resolve('OPENCODE_GO_API_KEY')` — the same credential
 *      the `opencode-go` LLM provider uses, so the usual install needs no setup;
 *   3. the DSH credential store file (`$DSH_HOME/.credentials.yaml` → refs);
 *   4. `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` process environment;
 *   5. opencode's own auth file (`~/.local/share/opencode/auth.json`,
 *      entry "opencode-go").
 *
 * No dependency on any @deepseek-ai package: only node builtins and the global
 * fetch, so the bundle links from a plain directory without an install step.
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Stable cordis plugin name. */
export const name = 'opencode-go-remaining'

/** Services this plugin cannot work without. */
export const inject = ['tools', 'webServer']

/** Official usage endpoint. */
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** opencode CLI credential file (XDG style, same on every platform). */
const DEFAULT_AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')

/** Entry id inside that file holding the OpenCode Go subscription key. */
const DEFAULT_API_KEY_ID = 'opencode-go'

/** Credential-store key the `opencode-go` LLM provider resolves through. */
const CREDENTIAL_NAME = 'OPENCODE_GO_API_KEY'

/** Exact path the browser half fetches (spelled identically in client.js). */
const USAGE_API = '/api/opencode-go-remaining/usage'

/** Attribution header sent with every upstream request. */
const USER_AGENT = 'dsh-opencode-go-remaining/0.1.0'

/** Upstream response cache lifetime (ms) — the windows move slowly. */
const CACHE_MS = 15_000

/** The three billing windows, in display order. */
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/** One error with a machine-readable code. */
class UsageError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/* ------------------------------------------------------------------ config */

/** Read one number-ish config value with a floor. */
function numberOr(value, fallback, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
}

/** Snapshot the tunables of one request from the live row config. */
function snapshot(config) {
  const source = config ?? {}
  return {
    apiKey: typeof source.apiKey === 'string' && source.apiKey.length > 0 ? source.apiKey : undefined,
    apiKeyId: typeof source.apiKeyId === 'string' && source.apiKeyId.length > 0 ? source.apiKeyId : DEFAULT_API_KEY_ID,
    authFile: typeof source.authFile === 'string' && source.authFile.length > 0 ? source.authFile : DEFAULT_AUTH_FILE,
    baseURL: typeof source.baseURL === 'string' && source.baseURL.length > 0 ? source.baseURL : DEFAULT_BASE_URL,
    timeoutMs: numberOr(source.timeoutMs, 15_000, 1_000),
  }
}

/* ------------------------------------------------------- credential lookup */

/** Parse `refs: { KEY: value }` out of the DSH credential store file. */
function readStoreRef(text, key) {
  const lines = text.split(/\r?\n/)
  let inside = false
  for (const line of lines) {
    if (!inside) {
      if (/^refs:\s*$/.test(line)) inside = true
      continue
    }
    if (line.length === 0) continue
    if (!/^\s/.test(line)) break
    const match = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (match !== null && match[1] === key) {
      let value = match[2]
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

/** Try the plugin config, then the credential seam, then files and env. */
async function resolveApiKey(ctx, opts) {
  if (opts.apiKey !== undefined) return { key: opts.apiKey, source: 'plugin config' }

  const store = ctx.get?.('credentials')
  if (store !== undefined && typeof store.resolve === 'function') {
    try {
      const hit = await store.resolve(CREDENTIAL_NAME)
      if (typeof hit?.value === 'string' && hit.value.length > 0) {
        return { key: hit.value, source: 'DSH 凭据库' }
      }
    } catch {
      // A store that refuses the reference is not fatal: fall through to files.
    }
  }

  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  try {
    const raw = await readFile(path.join(home, '.credentials.yaml'), 'utf8')
    const value = readStoreRef(raw, CREDENTIAL_NAME)
    if (value !== undefined) return { key: value, source: 'credentials.yaml' }
  } catch {
    // No store file: fall through.
  }

  for (const envName of [CREDENTIAL_NAME, 'OPENCODE_API_KEY']) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.length > 0) return { key: value, source: `env ${envName}` }
  }

  try {
    const raw = await readFile(opts.authFile, 'utf8')
    const parsed = JSON.parse(raw)
    const entry = parsed !== null && typeof parsed === 'object' ? parsed[opts.apiKeyId] : undefined
    if (typeof entry?.key === 'string' && entry.key.length > 0) {
      return { key: entry.key, source: `opencode auth file ("${opts.apiKeyId}")` }
    }
    if (Array.isArray(entry?.tokens) && typeof entry.tokens[0] === 'string' && entry.tokens[0].length > 0) {
      return { key: entry.tokens[0], source: `opencode auth file ("${opts.apiKeyId}")` }
    }
  } catch {
    // Missing or unreadable auth file just ends the chain.
  }

  return null
}

/* -------------------------------------------------------------- usage call */

/** Normalize one window; unknown shapes degrade to nulls instead of throwing. */
function normalizeWindow(raw) {
  const out = { status: 'unknown', percent: null, resetsAt: null }
  if (raw === null || typeof raw !== 'object') return out
  if (typeof raw.status === 'string' && raw.status.length > 0) out.status = raw.status
  else out.status = 'ok'
  if (typeof raw.percent === 'number' && Number.isFinite(raw.percent)) out.percent = raw.percent
  else if (typeof raw.usagePercent === 'number' && Number.isFinite(raw.usagePercent)) out.percent = raw.usagePercent
  if (typeof raw.resetsAt === 'string' && raw.resetsAt.length > 0) out.resetsAt = raw.resetsAt
  return out
}

/** Normalize a parsed usage body into the three windows. */
function normalizeUsage(body) {
  const usage = body?.usage !== null && typeof body?.usage === 'object' ? body.usage : (body ?? {})
  const out = {}
  for (const key of WINDOW_KEYS) out[key] = normalizeWindow(usage[key])
  if (typeof body?.subscribedAt === 'string' && body.subscribedAt.length > 0) out.subscribedAt = body.subscribedAt
  return out
}

/** Cached payload plus the moment it was fetched. */
let cache

/**
 * Fetch and normalize the usage payload.
 * @param ctx - host context (used to reach the credential service).
 * @param config - the live row config.
 * @param options - `refresh` bypasses the short cache.
 */
async function fetchUsage(ctx, config, options = {}) {
  const now = Date.now()
  if (options.refresh !== true && cache !== undefined && now - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true }
  }

  const opts = snapshot(config)
  const resolved = await resolveApiKey(ctx, opts)
  if (resolved === null) {
    throw new UsageError(
      '找不到 OpenCode Go 的 API key：请在插件配置里填 apiKey，或让 DSH 凭据库里的 ' +
        `${CREDENTIAL_NAME} 有值（opencode-go provider 用的就是它）`,
      'NO_KEY',
    )
  }

  let response
  try {
    response = await fetch(opts.baseURL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${resolved.key}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (error) {
    throw new UsageError(`请求 opencode 用量接口失败：${String(error?.message ?? error)}`, 'REQUEST_FAILED')
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(`API key 被拒绝（HTTP ${response.status}）`, 'UNAUTHORIZED')
  }
  if (!response.ok) {
    throw new UsageError(`用量接口返回 HTTP ${response.status}`, 'HTTP_ERROR')
  }

  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new UsageError(`用量接口返回了无法解析的内容：${String(error?.message ?? error)}`, 'BAD_RESPONSE')
  }

  const value = {
    ...normalizeUsage(body),
    source: resolved.source,
    fetchedAt: new Date(now).toISOString(),
  }
  cache = { at: now, value }
  return value
}

/* ------------------------------------------------------------------- route */

/** Loopback literal + browser same-origin fence (LAN-exposed servers stay safe). */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/* -------------------------------------------------------------------- tool */

/** Whole-percent remaining for one window, or null. */
function remainingOf(window) {
  if (window === null || window === undefined || typeof window.percent !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(100 - window.percent)))
}

/** Human duration such as "2d 19h" / "3h 12m" / "45s". */
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '?'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** Render the tool result as one text table. */
function renderUsage(_args, value) {
  if (value?.success === false) return [{ type: 'text', text: `OpenCode Go 余量查询失败：${value.error ?? 'unknown'}` }]
  const labels = { rolling: '5小时', weekly: '每周', monthly: '每月' }
  const lines = [
    `OpenCode Go 余量（key 来源：${value?.source ?? 'unknown'}）`,
    '',
    'window | 剩余 |  已用 | 重置倒计时',
    '-------|------|-------|------------------',
  ]
  for (const key of WINDOW_KEYS) {
    const window = value?.[key] ?? {}
    const left = remainingOf(window)
    const seconds = typeof window.resetsAt === 'string'
      ? (new Date(window.resetsAt).getTime() - Date.now()) / 1000
      : null
    lines.push(
      `${labels[key].padEnd(6)} | ${(left === null ? '?' : `${left}%`).padStart(4)} | ${(typeof window.percent === 'number' ? `${window.percent}%` : '?').padStart(5)} | ${formatDuration(seconds)}`,
    )
  }
  lines.push('', `fetchedAt: ${value?.fetchedAt ?? '?'}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The model-facing tool definition (plain object: no @deepseek-ai import). */
function usageTool(ctx, getConfig) {
  return {
    name: 'opencode_usage',
    description:
      'Query the OpenCode Go subscription quota: returns the rolling 5-hour, weekly and monthly windows with ' +
      'percent used, percent remaining and the reset countdown. Use it whenever the user asks 用了多少 / 还剩多少 / ' +
      '额度 / 配额 / 余量 / 套餐 of OpenCode Go. No parameters; one call returns all three windows.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderUsage,
    },
    async execute() {
      try {
        const value = await fetchUsage(ctx, getConfig(), { refresh: true })
        return { success: true, ...value }
      } catch (error) {
        return {
          success: false,
          error: error instanceof UsageError ? error.message : String(error?.message ?? error),
        }
      }
    },
  }
}

/* ------------------------------------------------------------------- apply */

/**
 * Mount the route and the agent tool.
 * @param ctx - host plugin context carrying `tools` and `webServer`.
 * @param config - the row config from cordis.patch.yml (no schema: all fields optional).
 */
export function apply(ctx, config) {
  const getConfig = () => config

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: USAGE_API,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { success: false, error: 'forbidden: loopback-only' })
            return
          }
          if (req.method !== 'GET') {
            writeJson(res, 405, { success: false, error: 'method not allowed' })
            return
          }
          let refresh = false
          try {
            refresh = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('refresh') === '1'
          } catch {
            refresh = false
          }
          try {
            const value = await fetchUsage(ctx, getConfig(), { refresh })
            writeJson(res, 200, { success: true, ...value })
          } catch (error) {
            writeJson(res, 200, {
              success: false,
              error: error instanceof UsageError ? error.message : String(error?.message ?? error),
            })
          }
        },
      }),
    'opencode-go-remaining: usage route',
  )

  ctx.effect(() => {
    const dispose = ctx.tools.register(usageTool(ctx, getConfig))
    return () => {
      dispose()
    }
  }, 'opencode-go-remaining: opencode_usage tool')
}
