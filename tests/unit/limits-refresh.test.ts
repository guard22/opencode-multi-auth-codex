import { jest } from '@jest/globals'
import type { AccountCredentials } from '../../src/types.js'

const updateAccount = jest.fn()
const loadStore = jest.fn()
const probeRateLimitsForAccount = jest.fn<() => Promise<any>>()
const fetchUsageRateLimitsForAccount = jest.fn<() => Promise<any>>()
const logError = jest.fn()
const logInfo = jest.fn()
const markAuthInvalid = jest.fn()
const clearAuthInvalid = jest.fn()
const markWorkspaceDeactivated = jest.fn()
const ensureValidToken = jest.fn<() => Promise<string | null>>()
const refreshToken = jest.fn<() => Promise<AccountCredentials | null>>()

jest.unstable_mockModule('../../src/store.js', () => ({
  loadStore,
  updateAccount
}))

jest.unstable_mockModule('../../src/probe-limits.js', () => ({
  probeRateLimitsForAccount
}))

jest.unstable_mockModule('../../src/usage-limits.js', () => ({
  fetchUsageRateLimitsForAccount
}))

jest.unstable_mockModule('../../src/logger.js', () => ({
  logError,
  logInfo
}))

jest.unstable_mockModule('../../src/rotation.js', () => ({
  clearAuthInvalid,
  markAuthInvalid,
  markWorkspaceDeactivated
}))

jest.unstable_mockModule('../../src/auth.js', () => ({
  ensureValidToken,
  refreshToken
}))

let refreshRateLimitsForAccount: typeof import('../../src/limits-refresh.js').refreshRateLimitsForAccount

const baseAccount: AccountCredentials = {
  alias: 'dead-token',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  usageCount: 0
}

beforeAll(async () => {
  ;({ refreshRateLimitsForAccount } = await import('../../src/limits-refresh.js'))
})

beforeEach(() => {
  jest.clearAllMocks()
  fetchUsageRateLimitsForAccount.mockReset()
  probeRateLimitsForAccount.mockReset()
  ensureValidToken.mockReset()
  refreshToken.mockReset()
  clearAuthInvalid.mockReset()
  ensureValidToken.mockResolvedValue(baseAccount.accessToken)
  refreshToken.mockResolvedValue(null)
  loadStore.mockReturnValue({
    accounts: { [baseAccount.alias]: { ...baseAccount } },
    activeAlias: null,
    rotationIndex: 0,
    lastRotation: Date.now()
  })
})

describe('refreshRateLimitsForAccount', () => {
  it('does not launch probe fallback for auth-invalid usage errors', async () => {
    fetchUsageRateLimitsForAccount.mockResolvedValue({
      source: 'usage-api',
      error: 'Usage API returned 401: {"error":{"code":"token_expired"}}',
      shouldProbeFallback: false,
      authInvalid: true
    })

    const result = await refreshRateLimitsForAccount({ ...baseAccount })

    expect(probeRateLimitsForAccount).not.toHaveBeenCalled()
    expect(refreshToken).toHaveBeenCalledWith('dead-token')
    expect(markAuthInvalid).toHaveBeenCalledWith('dead-token', 'access-token')
    expect(markWorkspaceDeactivated).not.toHaveBeenCalled()
    expect(updateAccount).toHaveBeenLastCalledWith(
      'dead-token',
      expect.objectContaining({
        limitStatus: 'error',
        limitError: expect.stringContaining('Usage API returned 401'),
        lastLimitErrorAt: expect.any(Number),
        limitsConfidence: expect.any(String)
      })
    )
    expect(result).toEqual({
      alias: 'dead-token',
      updated: false,
      error: 'Usage API returned 401: {"error":{"code":"token_expired"}}'
    })
  })

  it('refreshes and retries usage once before invalidating the account', async () => {
    const refreshedAccount: AccountCredentials = {
      ...baseAccount,
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: Date.now() + 3_600_000
    }
    fetchUsageRateLimitsForAccount
      .mockResolvedValueOnce({
        source: 'usage-api',
        error: 'Usage API returned 401: {"error":{"code":"token_invalidated"}}',
        shouldProbeFallback: false,
        authInvalid: true
      })
      .mockResolvedValueOnce({
        source: 'usage-api',
        rateLimits: {
          fiveHour: { remaining: 60, resetAt: Date.now() + 60_000 },
          weekly: { remaining: 70, resetAt: Date.now() + 120_000 }
        }
      })
    refreshToken.mockResolvedValue(refreshedAccount)

    const result = await refreshRateLimitsForAccount({ ...baseAccount })

    expect(refreshToken).toHaveBeenCalledWith('dead-token')
    expect(fetchUsageRateLimitsForAccount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: 'refreshed-access-token' })
    )
    expect(markAuthInvalid).not.toHaveBeenCalled()
    expect(result).toEqual({ alias: 'dead-token', updated: true })
  })

  it('uses the complete post-refresh credentials for probe fallback', async () => {
    const refreshedAccount: AccountCredentials = {
      ...baseAccount,
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: Date.now() + 3_600_000
    }
    ensureValidToken.mockImplementation(async () => {
      loadStore.mockReturnValue({
        accounts: { [baseAccount.alias]: refreshedAccount },
        activeAlias: null,
        rotationIndex: 0,
        lastRotation: Date.now()
      })
      return 'stale-ensure-token'
    })
    fetchUsageRateLimitsForAccount.mockResolvedValue({
      source: 'usage-api',
      error: 'Usage API unavailable',
      shouldProbeFallback: true
    })
    probeRateLimitsForAccount.mockResolvedValue({
      isAuthoritative: false,
      error: 'Probe unavailable'
    })

    await refreshRateLimitsForAccount({ ...baseAccount })

    expect(fetchUsageRateLimitsForAccount).toHaveBeenCalledWith(refreshedAccount)
    expect(probeRateLimitsForAccount).toHaveBeenCalledWith(refreshedAccount)
  })

  it('conditionally clears auth invalidation after successful probe fallback', async () => {
    fetchUsageRateLimitsForAccount.mockResolvedValue({
      source: 'usage-api',
      error: 'Usage API unavailable',
      shouldProbeFallback: true
    })
    probeRateLimitsForAccount.mockResolvedValue({
      isAuthoritative: true,
      probeModel: 'gpt-5.4',
      rateLimits: {
        fiveHour: { remaining: 40, resetAt: Date.now() + 60_000 },
        weekly: { remaining: 50, resetAt: Date.now() + 120_000 }
      }
    })

    await refreshRateLimitsForAccount({ ...baseAccount })

    expect(clearAuthInvalid).toHaveBeenCalledWith('dead-token', 'access-token')
    expect(updateAccount).not.toHaveBeenLastCalledWith(
      'dead-token',
      expect.objectContaining({ authInvalid: expect.anything() })
    )
  })

  it('does not launch probe fallback for deactivated workspaces', async () => {
    const workspaceAccount = { ...baseAccount, alias: 'workspace-dead' }
    loadStore.mockReturnValue({
      accounts: { [workspaceAccount.alias]: workspaceAccount },
      activeAlias: null,
      rotationIndex: 0,
      lastRotation: Date.now()
    })
    fetchUsageRateLimitsForAccount.mockResolvedValue({
      source: 'usage-api',
      error: 'Usage API returned 402: {"detail":{"code":"deactivated_workspace"}}',
      shouldProbeFallback: false,
      workspaceDeactivated: true,
      workspaceDeactivatedReason: 'deactivated_workspace'
    })

    const result = await refreshRateLimitsForAccount(workspaceAccount)

    expect(probeRateLimitsForAccount).not.toHaveBeenCalled()
    expect(markAuthInvalid).not.toHaveBeenCalled()
    expect(markWorkspaceDeactivated).toHaveBeenCalledWith(
      'workspace-dead',
      30 * 60 * 1000,
      { error: 'deactivated_workspace' }
    )
    expect(result).toEqual({
      alias: 'workspace-dead',
      updated: false,
      error: 'Usage API returned 402: {"detail":{"code":"deactivated_workspace"}}'
    })
  })

  it('clears stale auth invalid state after successful usage refresh', async () => {
    fetchUsageRateLimitsForAccount.mockResolvedValue({
      source: 'usage-api',
      rateLimits: {
        fiveHour: { remaining: 50, resetAt: Date.now() + 60_000 },
        weekly: { remaining: 80, resetAt: Date.now() + 120_000 }
      },
      planType: 'pro'
    })

    const result = await refreshRateLimitsForAccount({
      ...baseAccount,
      authInvalid: true,
      authInvalidatedAt: Date.now() - 10_000
    })

    expect(probeRateLimitsForAccount).not.toHaveBeenCalled()
    expect(clearAuthInvalid).toHaveBeenCalledWith('dead-token', 'access-token')
    expect(updateAccount).toHaveBeenLastCalledWith(
      'dead-token',
      expect.objectContaining({
        limitStatus: 'success',
        planType: 'pro'
      })
    )
    expect(updateAccount).not.toHaveBeenLastCalledWith(
      'dead-token',
      expect.objectContaining({ authInvalid: expect.anything() })
    )
    expect(result).toEqual({ alias: 'dead-token', updated: true })
  })
})
