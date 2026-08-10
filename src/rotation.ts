import { getStoreDiagnostics, loadStore, mutateStore, updateAccount } from './store.js'
import { ensureValidToken } from './auth.js'
import { decodeJwtPayload, getPlanTypeFromClaims } from './codex-auth.js'
import { isForceActive, checkAndAutoClearForce, getForceState, clearForce } from './force-mode.js'
import { getRuntimeSettings, calculateWeightedSelection } from './settings.js'
import type { AccountCredentials, DEFAULT_CONFIG } from './types.js'

export interface RotationResult {
  account: AccountCredentials
  token: string
  forceState?: {
    active: boolean
    alias: string | null
    remainingMs: number
  }
}

export interface AccountSelectionContext {
  model?: string
}

const HEALTH_HYSTERESIS_MS = 10_000
const RECENT_FAILURE_WINDOW_MS = 60_000

function shuffled<T>(input: T[]): T[] {
  const a = [...input]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function normalizePlanType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : undefined
}

function getAccountPlanType(acc: AccountCredentials): string | undefined {
  const persisted = normalizePlanType(acc.planType)
  if (persisted) return persisted

  const idClaims = acc.idToken ? decodeJwtPayload(acc.idToken) : null
  const accessClaims = acc.accessToken ? decodeJwtPayload(acc.accessToken) : null
  return normalizePlanType(getPlanTypeFromClaims(idClaims) || getPlanTypeFromClaims(accessClaims))
}

function isProAccount(acc: AccountCredentials): boolean {
  return getAccountPlanType(acc) === 'pro'
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

function getPreferredPools(
  store: ReturnType<typeof loadStore>,
  availableAliases: string[],
  selection?: AccountSelectionContext
): { primaryAliases: string[]; fallbackAliases: string[] } {
  const proAliases = availableAliases.filter((alias) => isProAccount(store.accounts[alias]))
  const nonProAliases = availableAliases.filter((alias) => !isProAccount(store.accounts[alias]))

  if (isSparkModel(selection?.model)) {
    return {
      primaryAliases: proAliases,
      fallbackAliases: []
    }
  }

  if (proAliases.length > 0) {
    return {
      primaryAliases: proAliases,
      fallbackAliases: nonProAliases
    }
  }

  return {
    primaryAliases: availableAliases,
    fallbackAliases: []
  }
}

interface AccountHealth {
  alias: string
  isHealthy: boolean
  isInProbation: boolean
  recentFailures: number
  priority: number
}

function evaluateAccountHealth(acc: AccountCredentials, now: number): AccountHealth {
  const wasRateLimited: boolean = !!(acc.rateLimitedUntil && acc.rateLimitedUntil > now - HEALTH_HYSTERESIS_MS)
  const wasModelUnsupported: boolean = !!(acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now - HEALTH_HYSTERESIS_MS)
  const wasWorkspaceDeactivated: boolean = !!(acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now - HEALTH_HYSTERESIS_MS)
  
  // Phase D: Check if account is disabled
  const isDisabled: boolean = acc.enabled === false
  
  const currentlyBlocked: boolean = 
    !!(acc.rateLimitedUntil && acc.rateLimitedUntil > now) ||
    !!(acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now) ||
    !!(acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now) ||
    !!acc.authInvalid ||
    isDisabled // Phase D: Exclude disabled accounts

  const isInProbation: boolean = !currentlyBlocked && (wasRateLimited || wasModelUnsupported || wasWorkspaceDeactivated)
  
  let recentFailures = 0
  if (acc.lastLimitErrorAt && acc.lastLimitErrorAt > now - RECENT_FAILURE_WINDOW_MS) {
    recentFailures++
  }
  if (acc.authInvalidatedAt && acc.authInvalidatedAt > now - RECENT_FAILURE_WINDOW_MS) {
    recentFailures++
  }

  let priority = 100
  if (isInProbation) priority -= 30
  if (recentFailures > 0) priority -= recentFailures * 10
  if (acc.usageCount === 0) priority -= 5
  if (currentlyBlocked) priority = 0
  // Phase D: Disabled accounts get lowest priority
  if (isDisabled) priority = -1
  
  return {
    alias: acc.alias,
    isHealthy: !currentlyBlocked && !acc.authInvalid && !isDisabled,
    isInProbation,
    recentFailures,
    priority
  }
}

export async function getNextAccount(
  config: typeof DEFAULT_CONFIG,
  selection?: AccountSelectionContext
): Promise<RotationResult | null> {
  // Phase E: Check and auto-clear expired/invalid force state
  const autoClear = checkAndAutoClearForce()
  if (autoClear.wasCleared) {
    console.log(`[multi-auth] Force mode auto-cleared: ${autoClear.reason}`)
  }
  
  // Phase E: Check if force mode is active
  const forceActive = isForceActive()
  const forceState = getForceState()
  
  let store = loadStore()
  const aliases = Object.keys(store.accounts)

  if (aliases.length === 0) {
    const diag = getStoreDiagnostics()
    const extra = diag.error ? ` (${diag.error})` : ''
    console.error(
      `[multi-auth] No accounts configured. Run: opencode-multi-auth add <alias>${extra}`
    )
    if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
      console.error(`[multi-auth] store file: ${diag.storeFile}`)
    }
    return null
  }

  const now = Date.now()
  
  // Phase E: If force mode is active, never fall back to another alias.
  if (forceActive && forceState.forcedAlias) {
    const forcedAlias = forceState.forcedAlias
    const forcedAccount = store.accounts[forcedAlias]
    
    if (forcedAccount) {
      const health = evaluateAccountHealth(forcedAccount, now)
      
      if (health.isHealthy) {
        const token = await ensureValidToken(forcedAlias)
        if (token) {
          store = mutateStore((latest) => {
            const account = latest.accounts[forcedAlias]
            if (!account) return
            latest.accounts[forcedAlias] = {
              ...account,
              usageCount: (account.usageCount || 0) + 1,
              lastUsed: now,
              limitError: undefined
            }
            latest.activeAlias = forcedAlias
            latest.lastRotation = now
          }).store
          
          console.log(`[multi-auth] Force mode: using ${forcedAlias}`)
          return {
            account: store.accounts[forcedAlias],
            token,
            forceState: {
              active: true,
              alias: forcedAlias,
              remainingMs: forceState.forcedUntil ? forceState.forcedUntil - now : 0
            }
          }
        } else {
          console.warn(`[multi-auth] Force mode: ${forcedAlias} token unavailable; refusing fallback`)
          return null
        }
      } else {
        console.warn(`[multi-auth] Force mode: ${forcedAlias} currently blocked; refusing fallback`)
        return null
      }
    } else {
      // Forced account no longer exists - clear force and proceed normally.
      console.warn(`[multi-auth] Force mode: ${forcedAlias} not found, clearing force`)
      clearForce()
    }
  }
  
  const healthMap = new Map<string, AccountHealth>()
  for (const alias of aliases) {
    const acc = store.accounts[alias]
    healthMap.set(alias, evaluateAccountHealth(acc, now))
  }

  const availableAliases = aliases.filter(alias => {
    const health = healthMap.get(alias)
    return health?.isHealthy === true
  })

  if (availableAliases.length === 0) {
    console.warn('[multi-auth] No available accounts (rate-limited or invalidated).')
    return null
  }

  const tokenFailureCooldownMs = (() => {
    const raw = process.env.OPENCODE_MULTI_AUTH_TOKEN_FAILURE_COOLDOWN_MS
    const parsed = raw ? Number(raw) : NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return 60_000
  })()

  const runtimeSettings = getRuntimeSettings()
  const rotationStrategy = runtimeSettings.settings.rotationStrategy || config.rotationStrategy

  const buildCandidates = (candidateAliases: string[]): { aliases: string[]; nextIndex?: (selected: string) => number } => {
    switch (rotationStrategy) {
      case 'least-used': {
        const sorted = [...candidateAliases].sort((a, b) => {
          const aa = store.accounts[a]
          const bb = store.accounts[b]
          const healthA = healthMap.get(a)
          const healthB = healthMap.get(b)
          
          const priorityDiff = (healthB?.priority || 0) - (healthA?.priority || 0)
          if (priorityDiff !== 0) return priorityDiff
          
          const usageDiff = (aa?.usageCount || 0) - (bb?.usageCount || 0)
          if (usageDiff !== 0) return usageDiff
          const lastDiff = (aa?.lastUsed || 0) - (bb?.lastUsed || 0)
          if (lastDiff !== 0) return lastDiff
          return a.localeCompare(b)
        })
        return { aliases: sorted }
      }
      case 'random': {
        const sorted = [...candidateAliases].sort((a, b) => {
          const healthA = healthMap.get(a)
          const healthB = healthMap.get(b)
          return (healthB?.priority || 0) - (healthA?.priority || 0)
        })
        const topPriority = sorted.slice(0, Math.ceil(sorted.length / 2))
        return { aliases: shuffled(topPriority.length > 0 ? topPriority : sorted) }
      }
      // Phase F: Weighted round-robin
      case 'weighted-round-robin': {
        const weights = runtimeSettings.settings.accountWeights
        
        // Filter to healthy accounts with weights
        const weightedAliases = candidateAliases.filter(alias => (weights[alias] || 0) > 0)
        
        if (weightedAliases.length === 0) {
          // Fallback to round-robin if no weights defined
          const sorted = [...candidateAliases].sort((a, b) => {
            const healthA = healthMap.get(a)
            const healthB = healthMap.get(b)
            return (healthB?.priority || 0) - (healthA?.priority || 0)
          })
          const start = store.rotationIndex % sorted.length
          const rr = sorted.map(
            (_, i) => sorted[(start + i) % sorted.length]
          )
          const nextIndex = (selected: string): number => {
            const idx = sorted.indexOf(selected)
            if (idx < 0) return store.rotationIndex
            return (idx + 1) % sorted.length
          }
          return { aliases: rr, nextIndex }
        }
        
        // Use weighted selection
        const selected = calculateWeightedSelection(weightedAliases, weights)
        if (!selected) {
          // Fallback to round-robin
          const sorted = [...candidateAliases].sort((a, b) => {
            const healthA = healthMap.get(a)
            const healthB = healthMap.get(b)
            return (healthB?.priority || 0) - (healthA?.priority || 0)
          })
          const start = store.rotationIndex % sorted.length
          const rr = sorted.map(
            (_, i) => sorted[(start + i) % sorted.length]
          )
          return { aliases: rr }
        }
        
        return { aliases: [selected] }
      }
      case 'round-robin':
      default: {
        const sorted = [...candidateAliases].sort((a, b) => {
          const healthA = healthMap.get(a)
          const healthB = healthMap.get(b)
          return (healthB?.priority || 0) - (healthA?.priority || 0)
        })
        const start = store.rotationIndex % sorted.length
        const rr = sorted.map(
          (_, i) => sorted[(start + i) % sorted.length]
        )
        const nextIndex = (selected: string): number => {
          const idx = sorted.indexOf(selected)
          if (idx < 0) return store.rotationIndex
          return (idx + 1) % sorted.length
        }
        return { aliases: rr, nextIndex }
      }
    }
  }

  const { primaryAliases, fallbackAliases } = getPreferredPools(store, availableAliases, selection)
  const primary = buildCandidates(primaryAliases)
  const fallback = fallbackAliases.length > 0 ? buildCandidates(fallbackAliases) : { aliases: [] as string[] }
  const candidates = [...primary.aliases, ...fallback.aliases]

  for (const candidate of candidates) {
    const token = await ensureValidToken(candidate)
    if (!token) {
      store = updateAccount(candidate, {
        rateLimitedUntil: now + tokenFailureCooldownMs,
        limitError: '[multi-auth] Token unavailable (refresh failed?)',
        lastLimitErrorAt: now
      })
      continue
    }

    const nextIndex = primary.aliases.includes(candidate) ? primary.nextIndex : fallback.nextIndex
    store = mutateStore((latest) => {
      const account = latest.accounts[candidate]
      if (!account) return
      latest.accounts[candidate] = {
        ...account,
        usageCount: (account.usageCount || 0) + 1,
        lastUsed: now,
        limitError: undefined
      }
      latest.activeAlias = candidate
      latest.lastRotation = now
      if (nextIndex) {
        latest.rotationIndex = nextIndex(candidate)
      }
    }).store

    const currentForceState = getForceState()
    return {
      account: store.accounts[candidate],
      token,
      forceState: {
        active: isForceActive(),
        alias: currentForceState.forcedAlias,
        remainingMs: currentForceState.forcedUntil ? currentForceState.forcedUntil - now : 0
      }
    }
  }

  console.error('[multi-auth] No available accounts (token refresh failed on all candidates).')
  return null
}

export function markRateLimited(alias: string, rateLimitedUntil: number): void {
  const now = Date.now()
  const safeUntil = Math.max(rateLimitedUntil, now + 1000)
  const seconds = Math.max(1, Math.ceil((safeUntil - now) / 1000))
  updateAccount(alias, {
    rateLimitedUntil: safeUntil
  })
  console.warn(`[multi-auth] Account ${alias} marked rate-limited for ${seconds}s`)
}

export function clearRateLimit(alias: string): void {
  updateAccount(alias, {
    rateLimitedUntil: undefined
  })
}

export function markModelUnsupported(
  alias: string,
  cooldownMs: number,
  info?: { model?: string; error?: string }
): void {
  updateAccount(alias, {
    modelUnsupportedUntil: Date.now() + cooldownMs,
    modelUnsupportedAt: Date.now(),
    modelUnsupportedModel: info?.model,
    modelUnsupportedError: info?.error
  })
  const extra = info?.model ? ` (model=${info.model})` : ''
  console.warn(
    `[multi-auth] Account ${alias} marked model-unsupported for ${cooldownMs / 1000}s${extra}`
  )
}

export function clearModelUnsupported(alias: string): void {
  updateAccount(alias, {
    modelUnsupportedUntil: undefined,
    modelUnsupportedAt: undefined,
    modelUnsupportedModel: undefined,
    modelUnsupportedError: undefined
  })
}

export function markWorkspaceDeactivated(
  alias: string,
  cooldownMs: number,
  info?: { error?: string }
): void {
  updateAccount(alias, {
    workspaceDeactivatedUntil: Date.now() + cooldownMs,
    workspaceDeactivatedAt: Date.now(),
    workspaceDeactivatedError: info?.error
  })
  console.warn(
    `[multi-auth] Account ${alias} marked workspace-deactivated for ${cooldownMs / 1000}s`
  )
}

export function clearWorkspaceDeactivated(alias: string): void {
  updateAccount(alias, {
    workspaceDeactivatedUntil: undefined,
    workspaceDeactivatedAt: undefined,
    workspaceDeactivatedError: undefined
  })
}

export function markAuthInvalid(alias: string, expectedAccessToken: string): boolean {
  let marked = false
  mutateStore((store) => {
    const account = store.accounts[alias]
    if (!account) return
    if (account.accessToken !== expectedAccessToken) return
    store.accounts[alias] = {
      ...account,
      authInvalid: true,
      authInvalidatedAt: Date.now()
    }
    marked = true
  })
  if (marked) {
    console.warn(`[multi-auth] Account ${alias} marked invalidated`)
  }
  return marked
}

export function clearAuthInvalid(alias: string, expectedAccessToken: string): boolean {
  let cleared = false
  mutateStore((store) => {
    const account = store.accounts[alias]
    if (!account || account.accessToken !== expectedAccessToken) return
    store.accounts[alias] = {
      ...account,
      authInvalid: false,
      authInvalidatedAt: undefined
    }
    cleared = true
  })
  return cleared
}
