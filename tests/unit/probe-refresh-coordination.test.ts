import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { jest } from '@jest/globals'
import type { AccountCredentials } from '../../src/types.js'

const withAccountRefreshLock = jest.fn<(
  alias: string,
  work: () => Promise<unknown>
) => Promise<unknown>>()
const loadStore = jest.fn()
const mutateStore = jest.fn<(mutator: (store: any) => void) => void>()
const updateAccountInStore = jest.fn()
const spawn = jest.fn<(...args: any[]) => any>()
const findLatestSessionRateLimits = jest.fn()

jest.unstable_mockModule('../../src/token-refresh-lock.js', () => ({
  withAccountRefreshLock
}))

jest.unstable_mockModule('../../src/store.js', () => ({
  loadStore,
  mutateStore,
  updateAccountInStore
}))

jest.unstable_mockModule('node:child_process', () => ({
  spawn
}))

jest.unstable_mockModule('../../src/sessions-limits.js', () => ({
  findLatestSessionRateLimits
}))

let probeRateLimitsForAccount: typeof import('../../src/probe-limits.js').probeRateLimitsForAccount

const staleAccount: AccountCredentials = {
  alias: 'probe-lock',
  accessToken: 'stale-access-token',
  refreshToken: 'stale-refresh-token',
  expiresAt: Date.now() + 60_000,
  usageCount: 0
}

const latestAccount: AccountCredentials = {
  ...staleAccount,
  accessToken: 'latest-access-token',
  refreshToken: 'latest-refresh-token'
}

beforeAll(async () => {
  ;({ probeRateLimitsForAccount } = await import('../../src/probe-limits.js'))
})

beforeEach(() => {
  jest.clearAllMocks()
  withAccountRefreshLock.mockImplementation(async (_alias, work) => work())
  loadStore.mockReturnValue({ accounts: { [staleAccount.alias]: latestAccount } })
  mutateStore.mockImplementation((mutator: (store: any) => void) => {
    mutator({ accounts: { [staleAccount.alias]: latestAccount } })
  })
  findLatestSessionRateLimits.mockReturnValue(null)
  spawn.mockImplementation((_command: string, _args: string[], options: any) => {
    const auth = JSON.parse(fs.readFileSync(`${options.env.CODEX_HOME}/auth.json`, 'utf8'))
    expect(auth.tokens.access_token).toBe(latestAccount.accessToken)
    expect(auth.tokens.refresh_token).toBe(latestAccount.refreshToken)

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    queueMicrotask(() => child.emit('close', 1))
    return child
  })
})

describe('probe refresh coordination', () => {
  it('runs the probe under the account refresh lock with credentials reloaded after acquisition', async () => {
    await probeRateLimitsForAccount(staleAccount)

    expect(withAccountRefreshLock).toHaveBeenCalledWith(
      staleAccount.alias,
      expect.any(Function)
    )
    expect(loadStore).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalled()
  })
})
