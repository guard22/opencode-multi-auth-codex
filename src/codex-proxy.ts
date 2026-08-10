import {
  extractRateLimitUpdate,
  getBlockingRateLimitResetAt,
  mergeRateLimits,
  parseRateLimitResetFromError,
  parseRetryAfterHeader
} from './rate-limits.js'
import {
  getNextAccount,
  markAuthInvalid,
  markModelUnsupported,
  markRateLimited,
  markWorkspaceDeactivated
} from './rotation.js'
import { getForceState, isForceActive } from './force-mode.js'
import { getRuntimeSettings } from './settings.js'
import { loadStore, mutateStore, updateAccount, updateAccountInStore } from './store.js'
import { DEFAULT_CONFIG, type AccountRateLimits, type PluginConfig } from './types.js'
import { Errors } from './errors.js'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const URL_PATHS = {
  RESPONSES: '/responses',
  CODEX_RESPONSES: '/codex/responses'
}
const OPENAI_HEADERS = {
  BETA: 'OpenAI-Beta',
  ACCOUNT_ID: 'chatgpt-account-id',
  ORIGINATOR: 'originator',
  SESSION_ID: 'session_id',
  CONVERSATION_ID: 'conversation_id'
}
const OPENAI_HEADER_VALUES = {
  BETA_RESPONSES: 'responses=experimental',
  ORIGINATOR_CODEX: 'codex_cli_rs'
}
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export const DEFAULT_LATEST_CODEX_MODEL = 'gpt-5.5'
export const DEFAULT_CODEX_BASE_URL = CODEX_BASE_URL
let didWarnOutputLimit = false

export interface CodexProxyOptions {
  config?: PluginConfig
}

interface UpstreamErrorSummary {
  alias: string
  status: number
  code?: string
  message?: string
  body?: string
}

function decodeJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(decoded) as Record<string, any>
  } catch {
    return null
  }
}

function extractRequestUrl(input: Request | string | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export function extractPathAndSearch(url: string): string {
  // OpenCode sometimes passes relative paths (e.g. "/chat/completions") or even
  // malformed strings when provider base_url is missing (e.g. "undefined/...").
  // We only need the path+query and then we force the ChatGPT backend base URL.
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    // best-effort fallback
  }

  const trimmed = String(url || '').trim()
  if (trimmed.startsWith('/')) return trimmed
  const firstSlash = trimmed.indexOf('/')
  if (firstSlash >= 0) return trimmed.slice(firstSlash)
  return trimmed
}

export function toCodexBackendUrl(originalUrl: string): string {
  const pathAndSearch = extractPathAndSearch(originalUrl)

  // Map OpenAI v1 endpoints to ChatGPT Codex endpoints.
  let mapped = pathAndSearch
    .replace(/^\/v1(?=\/)/, '')
    .replace(/^\/backend-api(?=\/)/, '')
  if (mapped.includes(URL_PATHS.RESPONSES)) {
    mapped = mapped.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
  } else if (mapped.includes('/chat/completions')) {
    mapped = mapped.replace('/chat/completions', '/codex/chat/completions')
  }

  return `${CODEX_BASE_URL}${mapped.startsWith('/') ? mapped : `/${mapped}`}`
}

function removeForwardedClientHeaders(headers: Headers): void {
  for (const name of [
    'accept-encoding',
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]) {
    headers.delete(name)
  }
}

export function filterInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input
    .filter((item) => item?.type !== 'item_reference')
    .map((item) => {
      if (item && typeof item === 'object' && 'id' in item) {
        const { id, ...rest } = item as Record<string, unknown>
        return rest
      }
      return item
    })
}

function normalizeResponsesInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: input }] }]
  }

  if (Array.isArray(input)) {
    return (filterInput(input) as unknown[]).map((item) => {
      if (!item || typeof item !== 'object') return item
      const record = item as Record<string, unknown>
      if (typeof record.content === 'string') {
        return {
          ...record,
          content: [{ type: 'input_text', text: record.content }]
        }
      }
      return record
    })
  }

  return input
}

export function normalizeResponsesTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return tool
      const record = tool as Record<string, any>
      if (record.type === 'function' && record.function && typeof record.function === 'object') {
        const fn = record.function as Record<string, unknown>
        return {
          type: 'function',
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
          strict: fn.strict
        }
      }
      return record
    })
    .filter((tool) => {
      if (!tool || typeof tool !== 'object') return true
      const record = tool as Record<string, unknown>
      return record.type !== 'function' || typeof record.name === 'string'
    })
}

export function normalizeModel(model: string | undefined): string {
  if (!model) return 'gpt-5.1'

  const modelId = model.includes('/') ? model.split('/').pop()! : model
  const baseModel = modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh|max)$/, '')

  // OpenCode may lag behind the ChatGPT Codex model allowlist. Route known older
  // Codex selections to the latest backend model when users opt in.
  const preferLatestRaw = process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST
  const preferLatest = preferLatestRaw === '1' || preferLatestRaw === 'true'

  if (
    preferLatest &&
    (
      baseModel === 'gpt-5.4' ||
      baseModel === 'gpt-5.3-codex' ||
      baseModel === 'gpt-5.2-codex' ||
      baseModel === 'gpt-5-codex'
    )
  ) {
    const latestModel = (
      process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || DEFAULT_LATEST_CODEX_MODEL
    ).trim()

    if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
      console.log(`[multi-auth] model map: ${baseModel} -> ${latestModel}`)
    }

    return latestModel
  }

  return baseModel
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

export function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.6' || model === 'gpt-5.6-sol' || model === 'gpt-5.5' || model === 'gpt-5.4'
}

function ensureContentType(headers: Headers): Headers {
  const responseHeaders = new Headers(headers)
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8')
  }
  return responseHeaders
}

function extractErrorMessage(payload: any, fallbackText: string = ''): string {
  if (!payload || typeof payload !== 'object') {
    return fallbackText
  }

  const detailMessage = typeof payload?.detail?.message === 'string'
    ? payload.detail.message
    : typeof payload?.detail === 'string'
      ? payload.detail
      : ''

  const errorMessage = typeof payload?.error?.message === 'string'
    ? payload.error.message
    : ''

  const topLevelMessage = typeof payload?.message === 'string'
    ? payload.message
    : ''

  return detailMessage || errorMessage || topLevelMessage || fallbackText
}

function extractErrorCode(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''

  return (
    (typeof payload?.detail?.code === 'string' && payload.detail.code) ||
    (typeof payload?.error?.code === 'string' && payload.error.code) ||
    (typeof payload?.code === 'string' && payload.code) ||
    ''
  )
}

async function summarizeUpstreamError(
  alias: string,
  response: Response,
  parsedPayload?: any
): Promise<UpstreamErrorSummary> {
  const payload = parsedPayload ?? await response.clone().json().catch(() => null)
  const fallbackText = payload ? '' : await response.clone().text().catch(() => '')
  const message = extractErrorMessage(payload, fallbackText)
  const code = extractErrorCode(payload)
  const body = fallbackText || (payload ? JSON.stringify(payload) : '')

  return {
    alias,
    status: response.status,
    code: code || undefined,
    message: message || undefined,
    body: body ? body.slice(0, 1000) : undefined
  }
}

export function isCyberPolicyError(payload: any, fallbackText: string = ''): boolean {
  const code = extractErrorCode(payload).toLowerCase()
  const text = `${extractErrorMessage(payload, fallbackText)} ${fallbackText}`.toLowerCase()

  return code === 'cyber_policy' || text.includes('cyber_policy')
}

function resolveRateLimitedUntil(
  rateLimits: AccountRateLimits | undefined,
  headers: Headers,
  errorText: string,
  fallbackCooldownMs: number,
  now: number = Date.now()
): number {
  const retryAfterUntil = parseRetryAfterHeader(headers.get('retry-after'), now) || 0
  const windowResetUntil =
    getBlockingRateLimitResetAt(rateLimits, now, {
      conservativeWhenRemainingUnknown: true
    }) || 0
  const messageResetUntil = parseRateLimitResetFromError(errorText, now) || 0
  const fallbackUntil = now + fallbackCooldownMs

  return Math.max(fallbackUntil, retryAfterUntil, windowResetUntil, messageResetUntil)
}

function parseSseStream(sseText: string): unknown | null {
  const lines = sseText.split('\n')
  let finalResponse: any = null
  let outputText = ''
  const outputItems: unknown[] = []

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.substring(6)) as { type?: string; response?: unknown }

      if (data?.type === 'response.output_text.delta' && typeof (data as any).delta === 'string') {
        outputText += (data as any).delta
      }

      if (data?.type === 'response.output_text.done' && typeof (data as any).text === 'string') {
        outputText = (data as any).text
      }

      if (data?.type === 'response.output_item.done' && (data as any).item) {
        outputItems.push((data as any).item)
      }

      if (data?.type === 'response.done' || data?.type === 'response.completed') {
        finalResponse = data.response
      }
    } catch {
      // ignore malformed chunks
    }
  }

  if (!finalResponse || typeof finalResponse !== 'object') return finalResponse

  if (outputText && typeof finalResponse.output_text !== 'string') {
    finalResponse.output_text = outputText
  }

  if (Array.isArray(finalResponse.output) && finalResponse.output.length === 0 && outputItems.length > 0) {
    finalResponse.output = outputItems
  }

  return finalResponse
}

async function convertSseToJson(response: Response, headers: Headers): Promise<Response> {
  if (!response.body) {
    throw new Error('[multi-auth] Response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    fullText += decoder.decode(value, { stream: true })
  }

  const finalResponse = parseSseStream(fullText)
  if (!finalResponse) {
    return new Response(fullText, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }

  const jsonHeaders = new Headers(headers)
  jsonHeaders.delete('content-encoding')
  jsonHeaders.delete('content-length')
  jsonHeaders.delete('transfer-encoding')
  jsonHeaders.set('content-type', 'application/json; charset=utf-8')

  return new Response(JSON.stringify(finalResponse), {
    status: response.status,
    statusText: response.statusText,
    headers: jsonHeaders
  })
}

export async function handleCodexProxyRequest(
  input: Request | string | URL,
  init?: RequestInit,
  options?: CodexProxyOptions
): Promise<Response> {
  const pluginConfig = options?.config || DEFAULT_CONFIG
  let body: Record<string, any> = {}
  try {
    body = init?.body ? JSON.parse(init.body as string) : {}
  } catch {
    body = {}
  }

  const normalizedModel = normalizeModel(body.model)

  const store = loadStore()
  const forceState = getForceState()
  const forcePinned = isForceActive() && !!forceState.forcedAlias
  const eligibleCount = Object.values(store.accounts).filter(acc => {
    const now = Date.now()
    return (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
           (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
           (!acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now) &&
           !acc.authInvalid &&
           acc.enabled !== false
  }).length

  const maxAttempts = forcePinned ? 1 : Math.max(1, eligibleCount)
  const triedAliases = new Set<string>()
  let lastUpstreamError: UpstreamErrorSummary | undefined
  let attempt = 0

  while (attempt < maxAttempts) {
    attempt++

    const settings = getRuntimeSettings()
    const effectiveConfig: PluginConfig = {
      ...pluginConfig,
      rotationStrategy: settings.settings.rotationStrategy
    }

    const rotation = await getNextAccount(effectiveConfig, {
      model: normalizedModel
    })

    if (!rotation) {
      if (forcePinned && forceState.forcedAlias) {
        const forced = loadStore().accounts[forceState.forcedAlias]
        const now = Date.now()
        if (forced?.rateLimitedUntil && forced.rateLimitedUntil > now) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: `Forced account '${forced.alias}' is rate-limited until ${new Date(forced.rateLimitedUntil).toISOString()}`,
                details: { alias: forced.alias, rateLimitedUntil: forced.rateLimitedUntil }
              }
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          )
        }
      }
      return new Response(
        JSON.stringify({
          error: Errors.noEligibleAccounts('No available accounts after filtering')
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const { account, token } = rotation

    if (triedAliases.has(account.alias)) {
      continue
    }
    triedAliases.add(account.alias)

    const decoded = decodeJWT(token)
    const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'TOKEN_PARSE_ERROR',
            message: '[multi-auth] Failed to extract accountId from token'
          }
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const originalUrl = extractRequestUrl(input)
    const url = toCodexBackendUrl(originalUrl)

    const isStreaming = body?.stream === true
    const fastMode = /-fast$/.test(body.model || '')
    const supportedFastMode = fastMode && supportsFastMode(normalizedModel)
    const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)

    const payload: Record<string, any> = {
      ...body,
      model: normalizedModel,
      store: false,
      stream: true
    }

    if (
      !didWarnOutputLimit &&
      (payload.max_output_tokens !== undefined ||
        payload.max_completion_tokens !== undefined ||
        payload.max_tokens !== undefined)
    ) {
      didWarnOutputLimit = true
      console.warn('[multi-auth] Codex backend does not support output token limits; ignoring the configured limit')
    }

    delete payload.max_output_tokens
    delete payload.max_completion_tokens
    delete payload.max_tokens
    delete payload.stream_options
    delete payload.verbosity

    if (payload.text && typeof payload.text === 'object' && !Array.isArray(payload.text)) {
      delete payload.text.verbosity
      if (Object.keys(payload.text).length === 0) {
        delete payload.text
      }
    }

    if (payload.truncation === undefined) {
      const truncationRaw = (process.env.OPENCODE_MULTI_AUTH_TRUNCATION || '').trim()
      if (truncationRaw && truncationRaw !== 'disabled' && truncationRaw !== 'false' && truncationRaw !== '0') {
        payload.truncation = truncationRaw
      }
    }

    if (payload.input) {
      payload.input = normalizeResponsesInput(payload.input)
    }

    if (payload.tools) {
      payload.tools = normalizeResponsesTools(payload.tools)
    }

    if (payload.tool_choice && typeof payload.tool_choice === 'object') {
      const choice = payload.tool_choice as Record<string, any>
      if (choice.type === 'function' && choice.function?.name) {
        payload.tool_choice = { type: 'function', name: choice.function.name }
      }
    }

    if (reasoningMatch?.[1]) {
      payload.reasoning = {
        ...(payload.reasoning || {}),
        effort: reasoningMatch[1]
      }

      if (!isSparkModel(normalizedModel)) {
        payload.reasoning.summary = payload.reasoning?.summary || 'auto'
      }
    }

    if (isSparkModel(normalizedModel) && payload.reasoning?.summary !== undefined) {
      delete payload.reasoning.summary
    }

    if (supportedFastMode) {
      payload.service_tier = payload.service_tier || 'priority'

      if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
        console.log(`[multi-auth] fast mode enabled: ${normalizedModel} + service_tier=priority`)
      }
    } else if (fastMode && process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
      console.log(`[multi-auth] fast mode ignored for unsupported model: ${normalizedModel}`)
    }

    if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1' && payload.service_tier === 'priority') {
      console.log(`[multi-auth] priority service tier requested for ${normalizedModel}`)
    }

    delete payload.reasoning_effort

    try {
      const headers = new Headers(init?.headers || {})
      removeForwardedClientHeaders(headers)
      headers.delete('x-api-key')
      headers.set('Content-Type', 'application/json')
      headers.set('Authorization', `Bearer ${token}`)
      headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId)
      headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES)
      headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX)

      const cacheKey = payload?.prompt_cache_key
      if (cacheKey) {
        headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey)
        headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey)
      } else {
        headers.delete(OPENAI_HEADERS.CONVERSATION_ID)
        headers.delete(OPENAI_HEADERS.SESSION_ID)
      }

      headers.set('accept', 'text/event-stream')

      const sendPayload = async (requestPayload: Record<string, any>): Promise<Response> => {
        return fetch(url, {
          method: init?.method || 'POST',
          headers,
          body: JSON.stringify(requestPayload)
        })
      }

      const applyLimitUpdate = (response: Response): AccountRateLimits | undefined => {
        const limitUpdate = extractRateLimitUpdate(response.headers)
        if (!limitUpdate) return loadStore().accounts[account.alias]?.rateLimits

        return mutateStore((store) => {
          const current = store.accounts[account.alias]
          if (!current) return undefined
          const mergedRateLimits = mergeRateLimits(current.rateLimits, limitUpdate)
          updateAccountInStore(store, account.alias, {
            rateLimits: mergedRateLimits,
            rateLimitedUntil: getBlockingRateLimitResetAt(mergedRateLimits)
          })
          return mergedRateLimits
        }).result
      }

      let res = await sendPayload(payload)

      let mergedRateLimits = applyLimitUpdate(res)

      if (res.status === 400 && payload.service_tier === 'priority') {
        const errorData = await res.clone().json().catch(() => ({})) as any
        const errorText = await res.clone().text().catch(() => '')

        if (isCyberPolicyError(errorData, errorText)) {
          if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
            console.log('[multi-auth] cyber_policy on priority tier; retrying once without service_tier')
          }

          const standardTierPayload = { ...payload }
          delete standardTierPayload.service_tier
          res = await sendPayload(standardTierPayload)
          mergedRateLimits = applyLimitUpdate(res)
        }
      }

      if (res.status === 401 || res.status === 403) {
        const errorData = await res.clone().json().catch(() => ({})) as { error?: { message?: string } }
        lastUpstreamError = await summarizeUpstreamError(account.alias, res, errorData)
        const message = errorData?.error?.message || ''
        if (message.toLowerCase().includes('invalidated') || res.status === 401) {
          markAuthInvalid(account.alias, token)
        }

        if (attempt < maxAttempts) {
          continue
        }

        return new Response(
          JSON.stringify({
            error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases), {
              lastUpstreamError
            })
          }),
          { status: res.status, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (res.status === 429) {
        const errorData = await res.clone().json().catch(() => ({})) as any
        lastUpstreamError = await summarizeUpstreamError(account.alias, res, errorData)
        const errorText = extractErrorMessage(errorData)
        const rateLimitedUntil = resolveRateLimitedUntil(
          mergedRateLimits,
          res.headers,
          errorText,
          pluginConfig.rateLimitCooldownMs
        )
        markRateLimited(account.alias, rateLimitedUntil)

        if (attempt < maxAttempts) {
          continue
        }

        return new Response(
          JSON.stringify({
            error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases), {
              lastUpstreamError
            })
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (res.status === 402) {
        const errorData = await res.clone().json().catch(() => null) as any
        lastUpstreamError = await summarizeUpstreamError(account.alias, res, errorData)
        const errorText = await res.clone().text().catch(() => '')

        const code =
          (typeof errorData?.detail?.code === 'string' && errorData.detail.code) ||
          (typeof errorData?.error?.code === 'string' && errorData.error.code) ||
          ''
        const message =
          (typeof errorData?.detail?.message === 'string' && errorData.detail.message) ||
          (typeof errorData?.detail === 'string' && errorData.detail) ||
          (typeof errorData?.error?.message === 'string' && errorData.error.message) ||
          (typeof errorData?.message === 'string' && errorData.message) ||
          errorText ||
          ''

        const isDeactivatedWorkspace =
          code === 'deactivated_workspace' ||
          message.toLowerCase().includes('deactivated_workspace') ||
          message.toLowerCase().includes('deactivated workspace')

        if (isDeactivatedWorkspace) {
          markWorkspaceDeactivated(account.alias, pluginConfig.workspaceDeactivatedCooldownMs, {
            error: message || code
          })

          if (attempt < maxAttempts) {
            continue
          }

          return new Response(
            JSON.stringify({
              error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases), {
                lastUpstreamError
              })
            }),
            { status: 402, headers: { 'Content-Type': 'application/json' } }
          )
        }
      }

      if (res.status === 400) {
        const errorData = await res.clone().json().catch(() => ({})) as any
        lastUpstreamError = await summarizeUpstreamError(account.alias, res, errorData)
        const message =
          (typeof errorData?.detail === 'string' && errorData.detail) ||
          (typeof errorData?.error?.message === 'string' && errorData.error.message) ||
          (typeof errorData?.message === 'string' && errorData.message) ||
          ''

        const isModelUnsupported =
          typeof message === 'string' &&
          message.toLowerCase().includes('model is not supported') &&
          message.toLowerCase().includes('chatgpt account')

        if (isModelUnsupported) {
          markModelUnsupported(account.alias, pluginConfig.modelUnsupportedCooldownMs, {
            model: normalizedModel,
            error: message
          })

          if (attempt < maxAttempts) {
            continue
          }

          return new Response(
            JSON.stringify({
              error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases), {
                lastUpstreamError
              })
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }
      }

      if (!res.ok) {
        return res
      }

      const responseHeaders = ensureContentType(res.headers)
      if (!isStreaming && responseHeaders.get('content-type')?.includes('text/event-stream')) {
        return await convertSseToJson(res, responseHeaders)
      }

      return res
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { code: 'REQUEST_FAILED', message: `[multi-auth] Request failed: ${err}` } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  return new Response(
    JSON.stringify({
      error: Errors.maxRetriesExceeded(attempt, Array.from(triedAliases), {
        lastUpstreamError
      })
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  )
}
