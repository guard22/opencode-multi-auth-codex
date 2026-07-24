import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { 
  loadStore, 
  saveStore, 
  getStoreDiagnostics,
  withWriteLock,
  mutateStore,
  addAccount,
  updateAccount,
  removeAccount
} from '../../src/store.js'

const tmpDir = path.join(os.tmpdir(), 'oma-test-' + Date.now())
const originalEnv = process.env

function setupEnv() {
  process.env = { ...originalEnv }
  process.env.CODEX_SOFT_STORE_PASSPHRASE = ''
  process.env.OPENCODE_MULTI_AUTH_STORE_DIR = tmpDir
}

function cleanupEnv() {
  process.env = originalEnv
}

function cleanup() {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('Store Operations', () => {
  beforeEach(() => {
    cleanup()
    setupEnv()
  })
  afterEach(() => {
    cleanupEnv()
    cleanup()
  })

  it('should create empty store when no file exists', () => {
    const store = loadStore()
    expect(store.accounts).toEqual({})
    expect(store.activeAlias).toBeNull()
  })

  it('should add an account', () => {
    const store = addAccount('test-alias', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000,
      email: 'test@example.com'
    })
    expect(store.accounts['test-alias']).toBeDefined()
    expect(store.accounts['test-alias'].usageCount).toBe(0)
    expect(store.activeAlias).toBe('test-alias')
  })

  it('should update an account', () => {
    addAccount('test-alias', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000
    })
    const updated = updateAccount('test-alias', { email: 'updated@example.com' })
    expect(updated.accounts['test-alias'].email).toBe('updated@example.com')
  })

  it('should persist accountUserId and userId across reload', () => {
    addAccount('test-alias', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000
    })

    updateAccount('test-alias', {
      accountUserId: 'account-user-123',
      userId: 'user-456'
    })

    const reloaded = loadStore()
    expect(reloaded.accounts['test-alias'].accountUserId).toBe('account-user-123')
    expect(reloaded.accounts['test-alias'].userId).toBe('user-456')
  })

  it('should remove an account', () => {
    addAccount('alias1', {
      accessToken: 'token1',
      refreshToken: 'refresh1',
      expiresAt: Date.now() + 3600000
    })
    addAccount('alias2', {
      accessToken: 'token2',
      refreshToken: 'refresh2',
      expiresAt: Date.now() + 3600000
    })
    const store = removeAccount('alias1')
    expect(store.accounts['alias1']).toBeUndefined()
    expect(store.accounts['alias2']).toBeDefined()
  })

  it('should return store diagnostics', () => {
    loadStore()
    const diag = getStoreDiagnostics()
    expect(diag.storeDir).toBe(tmpDir)
    expect(diag.locked).toBe(false)
    expect(diag.error).toBeNull()
  })

  it('should not write plaintext LKG when encryption is enabled', () => {
    process.env.CODEX_SOFT_STORE_PASSPHRASE = 'test-passphrase'
    const lkgPath = path.join(tmpDir, 'accounts.json.lkg')
    if (fs.existsSync(lkgPath)) {
      fs.unlinkSync(lkgPath)
    }

    addAccount('encrypted-alias', {
      accessToken: 'enc-access-token',
      refreshToken: 'enc-refresh-token',
      expiresAt: Date.now() + 3600000
    })

    expect(fs.existsSync(lkgPath)).toBe(false)
    delete process.env.CODEX_SOFT_STORE_PASSPHRASE
  })

  it('rejects stale load-modify-save snapshots', () => {
    addAccount('test-alias', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000
    })
    const stale = loadStore()
    const current = loadStore()
    current.accounts['test-alias'].notes = 'current'
    saveStore(current)

    stale.accounts['test-alias'].email = 'stale@example.com'
    expect(() => saveStore(stale)).toThrow(/changed since it was loaded/)
  })

  it('rejects nested store mutations without losing updates', () => {
    addAccount('test-alias', {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000
    })

    expect(() => mutateStore(() => {
      updateAccount('test-alias', { notes: 'nested' })
    })).toThrow(/Nested store mutations/)
    expect(loadStore().accounts['test-alias'].notes).toBeUndefined()
  })

  it('rejects asynchronous store mutators', () => {
    expect(() => mutateStore(async () => {
      await Promise.resolve()
    })).toThrow(/must be synchronous/)
  })
})

describe('Write Lock', () => {
  it('should execute function with write lock', async () => {
    let executed = false
    const result = await withWriteLock(() => {
      executed = true
      return true
    })
    expect(executed).toBe(true)
    expect(result).toBe(true)
  })

  it('should release lock after execution', async () => {
    await withWriteLock(() => 'result1')
    const result = await withWriteLock(() => 'result2')
    expect(result).toBe('result2')
  })

  it('should release lock on error', async () => {
    try {
      await withWriteLock(() => {
        throw new Error('test error')
      })
    } catch (e) {
      // expected
    }
    
    const result = await withWriteLock(() => 'after error')
    expect(result).toBe('after error')
  })
})
