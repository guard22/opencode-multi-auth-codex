import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import fs from 'node:fs'
import { syncAuthFromOpenCode } from './auth-sync.js'
import { createAuthorizationFlow, loginAccount } from './auth.js'
import { getDefaultModels } from './models.js'
import { listAccounts } from './store.js'
import { DEFAULT_CONFIG, type PluginConfig } from './types.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_LATEST_CODEX_MODEL,
  handleCodexProxyRequest,
  supportsFastMode
} from './codex-proxy.js'

export { isCyberPolicyError } from './codex-proxy.js'

const PROVIDER_ID = 'openai'
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`

let pluginConfig: PluginConfig = { ...DEFAULT_CONFIG }

function configure(config: Partial<PluginConfig>): void {
  pluginConfig = { ...pluginConfig, ...config }
}

/**
 * Multi-account OAuth plugin for OpenCode
 *
 * Rotates between multiple ChatGPT Plus/Pro accounts for rate limit resilience.
 */
const MultiAuthPlugin: Plugin = async ({ client, $, serverUrl, project, directory }: PluginInput) => {
  const terminalNotifierPath = (() => {
    const candidates = [
      '/opt/homebrew/bin/terminal-notifier',
      '/usr/local/bin/terminal-notifier'
    ]
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        // ignore
      }
    }
    return null
  })()

  const notifyEnabledRaw = process.env.OPENCODE_MULTI_AUTH_NOTIFY
  const notifyEnabled = notifyEnabledRaw === '1' || notifyEnabledRaw === 'true'
  const notifySound = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_SOUND || '/System/Library/Sounds/Glass.aiff').trim()

  const lastStatusBySession = new Map<string, string>()
  const lastNotifiedAtByKey = new Map<string, number>()
  const lastRetryAttemptBySession = new Map<string, number>()

  const escapeAppleScriptString = (value: string): string => {
    return String(value)
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\"')
      .replaceAll(String.fromCharCode(10), '\n')
  }

  let didWarnTerminalNotifier = false

  const notifyMac = (title: string, message: string, clickUrl?: string): void => {
    if (!notifyEnabled) return
    if (process.platform !== 'darwin') return

    const macOpenRaw = process.env.OPENCODE_MULTI_AUTH_NOTIFY_MAC_OPEN
    const macOpenEnabled = macOpenRaw !== '0' && macOpenRaw !== 'false'

    // Best effort: clickable notifications require terminal-notifier.
    if (macOpenEnabled && clickUrl && terminalNotifierPath) {
      try {
        $`${terminalNotifierPath} -title ${title} -message ${message} -open ${clickUrl}`
          .nothrow()
          .catch(() => {})
      } catch {
        // ignore
      }
    } else {
      if (macOpenEnabled && clickUrl && !terminalNotifierPath && !didWarnTerminalNotifier) {
        didWarnTerminalNotifier = true
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log('[multi-auth] mac click-to-open requires terminal-notifier (brew install terminal-notifier)')
        }
      }

      try {
        const osascript = '/usr/bin/osascript'
        const safeTitle = escapeAppleScriptString(title)
        const safeMessage = escapeAppleScriptString(message)
        const script = `display notification "${safeMessage}" with title "${safeTitle}"`

        // Fire-and-forget: never block OpenCode event processing.
        $`${osascript} -e ${script}`.nothrow().catch(() => {})
      } catch {
        // ignore
      }
    }

    if (!notifySound) return

    try {
      const afplay = '/usr/bin/afplay'
      $`${afplay} ${notifySound}`.nothrow().catch(() => {})
    } catch {
      // ignore
    }
  }


  const ntfyUrl = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_NTFY_URL || '').trim()
  const ntfyToken = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_NTFY_TOKEN || '').trim()
  const notifyUiBaseUrl = (process.env.OPENCODE_MULTI_AUTH_NOTIFY_UI_BASE_URL || '').trim()

  const getSessionUrl = (sessionID: string): string => {
    const base = (notifyUiBaseUrl || serverUrl?.origin || '').replace(/\/$/, '')
    if (!base) return ''
    return `${base}/session/${sessionID}`
  }



  const projectLabel = (((project as any)?.name as string | undefined) || project?.id || '').trim() || 'OpenCode'

  type SessionMeta = { title?: string }
  const sessionMetaCache = new Map<string, SessionMeta>()

  const formatTitle = (kind: 'idle' | 'retry' | 'error'): string => {
    if (kind === 'error') return `OpenCode - ${projectLabel} - Error`
    if (kind === 'retry') return `OpenCode - ${projectLabel} - Retrying`
    return `OpenCode - ${projectLabel}`
  }

  const formatBody = (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): string => {
    const meta = sessionMetaCache.get(sessionID) || {}
    const titleLine = meta.title ? `Task: ${meta.title}` : ''
    const url = getSessionUrl(sessionID)

    if (kind === 'idle') {
      return [titleLine, `Session finished: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
    }

    if (kind === 'retry') {
      return [titleLine, `Retrying: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
    }

    return [titleLine, `Error: ${sessionID}`, detail || '', url].filter(Boolean).join('\n')
  }

  const notifyMacRich = (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): void => {
    const body = formatBody(kind, sessionID, detail)
    notifyMac(formatTitle(kind), body, getSessionUrl(sessionID) || undefined)
  }

  const notifyNtfyRich = async (kind: 'idle' | 'retry' | 'error', sessionID: string, detail?: string): Promise<void> => {
    if (!notifyEnabled) return
    if (!ntfyUrl) return

    const sessionUrl = getSessionUrl(sessionID)
    const title = formatTitle(kind)
    const body = formatBody(kind, sessionID, detail)

    // ntfy priority: 1=min, 3=default, 5=max
    const priority = kind === 'error' ? '5' : kind === 'retry' ? '4' : '3'

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': title,
      'Priority': priority
    }

    if (sessionUrl) headers['Click'] = sessionUrl
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`

    try {
      await fetch(ntfyUrl, { method: 'POST', headers, body })
    } catch {
      // ignore
    }
  }
  const shouldThrottle = (key: string, minMs: number): boolean => {
    const last = lastNotifiedAtByKey.get(key) || 0
    const now = Date.now()
    if (now - last < minMs) return true
    lastNotifiedAtByKey.set(key, now)
    return false
  }

  const formatRetryDetail = (status: any): string => {
    const attempt = typeof status?.attempt === 'number' ? status.attempt : undefined
    const message = typeof status?.message === 'string' ? status.message : ''
    const next = typeof status?.next === 'number' ? status.next : undefined

    const parts: string[] = []
    if (typeof attempt === 'number') parts.push(`Attempt: ${attempt}`)
    // OpenCode has emitted both "seconds-until-next" and "epoch ms" variants over time.
    if (typeof next === 'number') {
      const seconds =
        next > 1e12 ? Math.max(0, Math.round((next - Date.now()) / 1000)) : Math.max(0, Math.round(next))
      parts.push(`Next in: ${seconds}s`)
    }
    if (message) parts.push(message)
    return parts.join(' | ')
  }

  const formatErrorDetail = (err: any): string => {
    if (!err || typeof err !== 'object') return ''
    const name = typeof err.name === 'string' ? err.name : ''
    const code = typeof err.code === 'string' ? err.code : ''
    const message =
      (typeof err.message === 'string' && err.message) ||
      (typeof err.error?.message === 'string' && err.error.message) ||
      ''
    return [name, code, message].filter(Boolean).join(': ')
  }

  const notifyRich = async (
    kind: 'idle' | 'retry' | 'error',
    sessionID: string,
    detail?: string
  ): Promise<void> => {
    try {
      notifyMacRich(kind, sessionID, detail)
    } catch {
      // ignore
    }

    try {
      await notifyNtfyRich(kind, sessionID, detail)
    } catch {
      // ignore
    }
  }

  return {
    event: async ({ event }) => {
      if (!notifyEnabled) return
      if (!event || !('type' in event)) return

      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = (event as any).properties?.info as
          | { id?: string; title?: string }
          | undefined
        const id = info?.id
        if (id) {
          sessionMetaCache.set(id, { title: info?.title })
        }
        return
      }

      if (event.type === 'session.status') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        const status = (event as any).properties?.status
        const statusType = status?.type as string | undefined
        if (!sessionID || !statusType) return

        lastStatusBySession.set(sessionID, statusType)

        if (statusType === 'retry') {
          const attempt = typeof status?.attempt === 'number' ? status.attempt : undefined
          const prevAttempt = lastRetryAttemptBySession.get(sessionID)

          if (typeof attempt === 'number') {
            if (prevAttempt === attempt && shouldThrottle(`retry:${sessionID}:${attempt}`, 5000)) {
              return
            }
            lastRetryAttemptBySession.set(sessionID, attempt)
          }

          const key = `retry:${sessionID}:${typeof attempt === 'number' ? attempt : 'na'}`
          if (shouldThrottle(key, 2000)) return

          void notifyRich('retry', sessionID, formatRetryDetail(status))
        }

        return
      }

      if (event.type === 'session.error') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        const id = sessionID || 'unknown'
        const err = (event as any).properties?.error
        const detail = formatErrorDetail(err)
        const key = `error:${id}:${detail}`
        if (shouldThrottle(key, 2000)) return
        void notifyRich('error', id, detail)
        return
      }

      if (event.type === 'session.idle') {
        const sessionID = (event as any).properties?.sessionID as string | undefined
        if (!sessionID) return

        const prev = lastStatusBySession.get(sessionID)
        if (prev === 'busy' || prev === 'retry') {
          if (shouldThrottle(`idle:${sessionID}`, 2000)) return
          void notifyRich('idle', sessionID)
        }

        lastStatusBySession.set(sessionID, 'idle')
      }
    },
    config: async (config) => {
      const injectModelsRaw = process.env.OPENCODE_MULTI_AUTH_INJECT_MODELS
      const injectModels = injectModelsRaw !== '0' && injectModelsRaw !== 'false'
      if (!injectModels) return

      const latestModel = (process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || DEFAULT_LATEST_CODEX_MODEL).trim()
      try {
        const openai = (config.provider?.[PROVIDER_ID] as any) || null
        if (!openai || typeof openai !== 'object') return
        openai.models ||= {}
        openai.whitelist ||= []

        const defaultModels = getDefaultModels()
        const injectedModelIds = [latestModel]
        if (supportsFastMode(latestModel) && defaultModels[`${latestModel}-fast`]) {
          injectedModelIds.push(`${latestModel}-fast`)
        }
        for (const sparkVariant of [
          'gpt-5.3-codex-spark-low',
          'gpt-5.3-codex-spark-medium',
          'gpt-5.3-codex-spark-high',
          'gpt-5.3-codex-spark-xhigh'
        ]) {
          if (defaultModels[sparkVariant]) {
            injectedModelIds.push(sparkVariant)
          }
        }

        for (const modelID of injectedModelIds) {
          const model = defaultModels[modelID]
          if (!model || openai.models[modelID]) continue
          openai.models[modelID] = model
        }

        for (const modelID of injectedModelIds) {
          if (!openai.whitelist.includes(modelID)) {
            openai.whitelist.unshift(modelID)
          }
        }

        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log(`[multi-auth] injected runtime models: ${injectedModelIds.join(', ')}`)
        }
      } catch (err) {
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
          console.log('[multi-auth] config injection failed:', err)
        }
      }
    },

    auth: {
      provider: PROVIDER_ID,

      /**
       * Loader configures the SDK with multi-account rotation
       */
      async loader(getAuth, provider) {
        await syncAuthFromOpenCode(getAuth)
        const accounts = listAccounts()

        if (accounts.length === 0) {
          console.log('[multi-auth] No accounts configured. Run: opencode-multi-auth add <alias>')
          return {}
        }

        const customFetch = async (
          input: Request | string | URL,
          init?: RequestInit
        ): Promise<Response> => {
          await syncAuthFromOpenCode(getAuth)
          return handleCodexProxyRequest(input, init, { config: pluginConfig })
        }

        // Return SDK configuration with custom fetch for rotation
        return {
          apiKey: 'chatgpt-oauth',
          baseURL: DEFAULT_CODEX_BASE_URL,
          fetch: customFetch
        }
      },

      methods: [
        {
          label: 'ChatGPT OAuth (Multi-Account)',
          type: 'oauth' as const,

          prompts: [
            {
              type: 'text' as const,
              key: 'alias',
              message: 'Account alias (e.g., personal, work)',
              placeholder: 'personal'
            }
          ],

          /**
           * OAuth flow - opens browser for ChatGPT login
           */
          authorize: async (inputs?: Record<string, string>) => {
            const alias = inputs?.alias || `account-${Date.now()}`
            const flow = await createAuthorizationFlow()

            return {
              url: flow.url,
              method: 'auto' as const,
              instructions: `Login with your ChatGPT Plus/Pro account for "${alias}"`,

              callback: async () => {
                try {
                  const account = await loginAccount(alias, flow)
                  return {
                    type: 'success' as const,
                    provider: PROVIDER_ID,
                    refresh: account.refreshToken,
                    access: account.accessToken,
                    expires: account.expiresAt
                  }
                } catch {
                  return { type: 'failed' as const }
                }
              }
            }
          }
        },
        {
          label: 'Skip (use existing accounts)',
          type: 'api' as const
        }
      ]
    }
  }
}

export default MultiAuthPlugin
