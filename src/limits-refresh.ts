import {
  getBlockingRateLimitResetAt,
  isRateLimitErrorText,
  mergeRateLimits,
  parseRateLimitResetFromError
} from './rate-limits.js'
import { clearAuthInvalid, markAuthInvalid, markWorkspaceDeactivated } from './rotation.js'
import { loadStore, updateAccount } from './store.js'
import { probeRateLimitsForAccount } from './probe-limits.js'
import { logError, logInfo } from './logger.js'
import { DEFAULT_CONFIG, calculateLimitsConfidence } from './types.js'
import { fetchUsageRateLimitsForAccount } from './usage-limits.js'
import { ensureValidToken, refreshToken } from './auth.js'
import type { AccountCredentials } from './types.js'

export interface LimitRefreshResult {
  alias: string
  updated: boolean
  error?: string
}

export async function refreshRateLimitsForAccount(account: AccountCredentials): Promise<LimitRefreshResult> {
  updateAccount(account.alias, { limitStatus: 'running', limitError: undefined })
  logInfo(`Refreshing limits for ${account.alias}`)
  await ensureValidToken(account.alias)
  const latestAccount = loadStore().accounts[account.alias]
  if (!latestAccount) {
    const error = 'Account removed during token refresh'
    logError(`Limit refresh failed for ${account.alias}: ${error}`)
    return { alias: account.alias, updated: false, error }
  }
  let requestAccount = latestAccount
  let usage = await fetchUsageRateLimitsForAccount(requestAccount)

  if (usage.authInvalid) {
    const current = loadStore().accounts[account.alias]
    if (current && current.accessToken !== requestAccount.accessToken) {
      requestAccount = current
      usage = await fetchUsageRateLimitsForAccount(requestAccount)
    } else {
      const refreshed = await refreshToken(account.alias)
      if (refreshed && refreshed.accessToken !== requestAccount.accessToken) {
        requestAccount = refreshed
        usage = await fetchUsageRateLimitsForAccount(requestAccount)
      }
    }
  }

  if (usage.rateLimits) {
    const now = Date.now()
    const updates: Partial<AccountCredentials> = {
      rateLimits: mergeRateLimits(account.rateLimits, usage.rateLimits),
      limitStatus: 'success',
      limitError: undefined,
      lastLimitProbeAt: now,
      limitsConfidence: calculateLimitsConfidence(now, account.lastLimitErrorAt, 'success')
    }
    if (usage.planType) {
      updates.planType = usage.planType
    }
    if (typeof usage.rateLimitedUntil === 'number' && usage.rateLimitedUntil > now) {
      updates.rateLimitedUntil = usage.rateLimitedUntil
    }
    updateAccount(account.alias, updates)
    clearAuthInvalid(account.alias, requestAccount.accessToken)
    logInfo(`Limits refreshed for ${account.alias} via usage API`)
    return { alias: account.alias, updated: true }
  }

  if (usage.error) {
    if (usage.shouldProbeFallback === false) {
      const now = Date.now()
      if (usage.authInvalid) {
        markAuthInvalid(account.alias, requestAccount.accessToken)
      }
      if (usage.workspaceDeactivated) {
        markWorkspaceDeactivated(
          account.alias,
          DEFAULT_CONFIG.workspaceDeactivatedCooldownMs,
          { error: usage.workspaceDeactivatedReason || usage.error }
        )
      }

      updateAccount(account.alias, {
        limitStatus: 'error',
        limitError: usage.error,
        lastLimitErrorAt: now,
        limitsConfidence: calculateLimitsConfidence(
          account.lastLimitProbeAt,
          now,
          'error'
        )
      })
      logInfo(`Skipping limits probe for ${account.alias}: ${usage.error}`)
      return {
        alias: account.alias,
        updated: false,
        error: usage.error
      }
    }

    logInfo(`Usage API limits lookup failed for ${account.alias}, falling back to probe: ${usage.error}`)
  }

  const probeAccount = loadStore().accounts[account.alias] || requestAccount
  const probe = await probeRateLimitsForAccount(probeAccount)

  if (!probe.isAuthoritative || !probe.rateLimits) {
    const now = Date.now()
    const errorText = usage.error || probe.error || 'Probe failed'
    logError(`Limit refresh failed for ${account.alias}: ${errorText}`)
    const likelyRateLimit = isRateLimitErrorText(errorText)
    const parsedResetAt = parseRateLimitResetFromError(errorText, now)
    const fallbackResetAt = likelyRateLimit
      ? getBlockingRateLimitResetAt(account.rateLimits, now, {
          conservativeWhenRemainingUnknown: true
        })
      : undefined
    const rateLimitedUntil = parsedResetAt ?? fallbackResetAt
    
    const updates: Partial<AccountCredentials> = {
      limitStatus: 'error',
      limitError: errorText,
      lastLimitErrorAt: now,
      limitsConfidence: calculateLimitsConfidence(
        account.lastLimitProbeAt,
        now,
        'error'
      )
    }
    if (typeof rateLimitedUntil === 'number' && rateLimitedUntil > now) {
      updates.rateLimitedUntil = rateLimitedUntil
    }
    updateAccount(account.alias, updates)
    return {
      alias: account.alias,
      updated: false,
      error: errorText
    }
  }

  const now = Date.now()
  const mergedRateLimits = mergeRateLimits(probeAccount.rateLimits, probe.rateLimits)
  const blockingResetAt = getBlockingRateLimitResetAt(mergedRateLimits, now)
  updateAccount(account.alias, {
    rateLimits: mergedRateLimits,
    limitStatus: 'success',
    limitError: undefined,
    lastLimitProbeAt: now,
    limitsConfidence: calculateLimitsConfidence(now, probeAccount.lastLimitErrorAt, 'success'),
    rateLimitedUntil: blockingResetAt
  })
  if (probe.validatedAccessToken) {
    clearAuthInvalid(account.alias, probe.validatedAccessToken)
  }

  logInfo(`Limits refreshed for ${account.alias} using model ${probe.probeModel || 'unknown'}, effort ${probe.probeEffort || 'default'}`)
  return { alias: account.alias, updated: true }
}

export async function refreshRateLimits(
  accounts: AccountCredentials[],
  alias?: string
): Promise<LimitRefreshResult[]> {
  if (alias) {
    const account = accounts.find((acc) => acc.alias === alias)
    if (!account) {
      return [{ alias, updated: false, error: 'Unknown alias' }]
    }
    return [await refreshRateLimitsForAccount(account)]
  }

  const store = loadStore()
  const results: LimitRefreshResult[] = []
  for (const account of accounts) {
    results.push(await refreshRateLimitsForAccount(account))
  }
  if (results.length === 0 && !store.activeAlias) {
    return [{ alias: 'active', updated: false, error: 'No accounts configured' }]
  }
  return results
}
