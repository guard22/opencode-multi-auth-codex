import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { clearAuthInvalid, getNextAccount, markAuthInvalid } from '../../src/rotation.js'
import { loadStore, saveStore, updateAccount } from '../../src/store.js'
import { updateSettings } from '../../src/settings.js'
import { DEFAULT_CONFIG, type AccountCredentials } from '../../src/types.js'

const TEST_DIR = path.join(os.tmpdir(), `oma-rotation-test-${Date.now()}`)
const TEST_STORE_FILE = path.join(TEST_DIR, 'accounts.json')
const originalEnv = process.env

function createAccount(alias: string, usageCount: number): AccountCredentials {
  return {
    alias,
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    usageCount,
    enabled: true
  }
}

function createPlanAccount(alias: string, usageCount: number, planType: string): AccountCredentials {
  return {
    ...createAccount(alias, usageCount),
    planType
  }
}

describe('Rotation Strategy Runtime Behavior', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: TEST_DIR,
      OPENCODE_MULTI_AUTH_STORE_FILE: TEST_STORE_FILE
    }
    delete process.env.OPENCODE_MULTI_AUTH_ROTATION_STRATEGY
    delete process.env.OPENCODE_MULTI_AUTH_CRITICAL_THRESHOLD
    delete process.env.OPENCODE_MULTI_AUTH_LOW_THRESHOLD

    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    process.env = originalEnv
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  it('uses persisted least-used strategy even if config still says round-robin', async () => {
    const store = loadStore()
    store.accounts.alpha = createAccount('alpha', 10)
    store.accounts.beta = createAccount('beta', 1)
    saveStore(store)

    const update = updateSettings({ rotationStrategy: 'least-used' }, 'test')
    expect(update.success).toBe(true)

    const rotation = await getNextAccount({
      ...DEFAULT_CONFIG,
      rotationStrategy: 'round-robin'
    })

    expect(rotation?.account.alias).toBe('beta')
  })

  it('applies weighted strategy change immediately', async () => {
    const store = loadStore()
    store.accounts.alpha = createAccount('alpha', 0)
    store.accounts.beta = createAccount('beta', 0)
    saveStore(store)

    const update = updateSettings(
      {
        rotationStrategy: 'weighted-round-robin',
        accountWeights: { beta: 1 }
      },
      'test'
    )
    expect(update.success).toBe(true)

    const rotation = await getNextAccount({
      ...DEFAULT_CONFIG,
      rotationStrategy: 'round-robin'
    })

    expect(rotation?.account.alias).toBe('beta')
  })

  it('prefers pro accounts first for non-spark models', async () => {
    const store = loadStore()
    store.accounts.plus = createPlanAccount('plus', 0, 'plus')
    store.accounts.pro = createPlanAccount('pro', 10, 'pro')
    saveStore(store)

    const rotation = await getNextAccount(
      {
        ...DEFAULT_CONFIG,
        rotationStrategy: 'least-used'
      },
      { model: 'gpt-5.4' }
    )

    expect(rotation?.account.alias).toBe('pro')
  })

  it('restricts spark models to pro accounts only', async () => {
    const store = loadStore()
    store.accounts.plus = createPlanAccount('plus', 0, 'plus')
    store.accounts.pro = createPlanAccount('pro', 10, 'pro')
    saveStore(store)

    const rotation = await getNextAccount(
      {
        ...DEFAULT_CONFIG,
        rotationStrategy: 'least-used'
      },
      { model: 'gpt-5.3-codex-spark' }
    )

    expect(rotation?.account.alias).toBe('pro')
  })

  it('returns null for spark models when no pro accounts are available', async () => {
    const store = loadStore()
    store.accounts.plus = createPlanAccount('plus', 0, 'plus')
    saveStore(store)

    const rotation = await getNextAccount(
      {
        ...DEFAULT_CONFIG,
        rotationStrategy: 'least-used'
      },
      { model: 'gpt-5.3-codex-spark-xhigh' }
    )

    expect(rotation).toBeNull()
  })

  it('does not invalidate credentials that changed after a failed request', () => {
    const store = loadStore()
    store.accounts.alpha = createAccount('alpha', 0)
    saveStore(store)

    expect(markAuthInvalid('alpha', 'stale-token')).toBe(false)
    expect(loadStore().accounts.alpha.authInvalid).not.toBe(true)

    expect(markAuthInvalid('alpha', 'token-alpha')).toBe(true)
    expect(loadStore().accounts.alpha.authInvalid).toBe(true)
  })

  it('does not clear invalidation for credentials that changed after a successful request', () => {
    const store = loadStore()
    store.accounts.alpha = {
      ...createAccount('alpha', 0),
      authInvalid: true,
      authInvalidatedAt: Date.now()
    }
    saveStore(store)
    updateAccount('alpha', { accessToken: 'rotated-token' })

    expect(clearAuthInvalid('alpha', 'token-alpha')).toBe(false)
    expect(loadStore().accounts.alpha.authInvalid).toBe(true)

    expect(clearAuthInvalid('alpha', 'rotated-token')).toBe(true)
    expect(loadStore().accounts.alpha.authInvalid).toBe(false)
  })
})
