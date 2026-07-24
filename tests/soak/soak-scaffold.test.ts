import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { addAccount, getStorePath, loadStore, updateAccount } from '../../src/store.js'

const SOAK_ROOT = path.join(os.tmpdir(), 'oma-soak-tests')
const originalEnv = process.env

describe('soak scaffold', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CODEX_SOFT_STORE_PASSPHRASE: '',
      OPENCODE_MULTI_AUTH_STORE_DIR: SOAK_ROOT,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(SOAK_ROOT, 'accounts.json')
    }

    if (fs.existsSync(SOAK_ROOT)) {
      fs.rmSync(SOAK_ROOT, { recursive: true, force: true })
    }
    fs.mkdirSync(SOAK_ROOT, { recursive: true })
  })

  afterEach(() => {
    process.env = originalEnv
    if (fs.existsSync(SOAK_ROOT)) {
      fs.rmSync(SOAK_ROOT, { recursive: true, force: true })
    }
  })

  it('runs sustained update loop without corruption', async () => {
    const durationMs = Number(process.env.OPENCODE_MULTI_AUTH_SOAK_MS || '2000')
    const startedAt = Date.now()

    for (let i = 0; i < 3; i += 1) {
      addAccount(`soak-${i}`, {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      })
    }

    let iterations = 0
    while (Date.now() - startedAt < durationMs) {
      const alias = `soak-${iterations % 3}`
      updateAccount(alias, {
        usageCount: iterations,
        lastUsed: Date.now(),
        notes: `soak-${iterations}`
      })
      iterations += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const raw = fs.readFileSync(getStorePath(), 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()

    const finalStore = loadStore()
    expect(Object.keys(finalStore.accounts)).toHaveLength(3)
    expect(iterations).toBeGreaterThan(20)
  }, 120_000)
})
