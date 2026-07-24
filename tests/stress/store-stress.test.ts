import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  addAccount,
  getStorePath,
  listAccounts,
  loadStore,
  updateAccount
} from '../../src/store.js'

const STRESS_DIR = path.join(os.tmpdir(), 'oma-stress-tests-sandbox')
const originalEnv = process.env
const execFileAsync = promisify(execFile)

describe('stress: store consistency', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CODEX_SOFT_STORE_PASSPHRASE: '',
      OPENCODE_MULTI_AUTH_STORE_DIR: STRESS_DIR,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(STRESS_DIR, 'accounts.json')
    }

    if (fs.existsSync(STRESS_DIR)) {
      fs.rmSync(STRESS_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(STRESS_DIR, { recursive: true })

    for (let i = 0; i < 5; i += 1) {
      addAccount(`stress-${i}`, {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      })
    }
  })

  afterEach(() => {
    process.env = originalEnv
    if (fs.existsSync(STRESS_DIR)) {
      fs.rmSync(STRESS_DIR, { recursive: true, force: true })
    }
  })

  it('handles burst updates without store corruption', async () => {
    const operations = Array.from({ length: 200 }, (_, idx) => {
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const alias = `stress-${idx % 5}`
          updateAccount(alias, {
            usageCount: idx,
            lastUsed: Date.now(),
            notes: `burst-${idx}`
          })
          resolve()
        })
      })
    })

    await Promise.all(operations)

    const storePath = getStorePath()
    const raw = fs.readFileSync(storePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()

    const store = loadStore()
    expect(Object.keys(store.accounts)).toHaveLength(5)
    expect(listAccounts()).toHaveLength(5)
  })

  it('preserves updates from concurrent processes', async () => {
    const storeModule = new URL('../../dist/store.js', import.meta.url).href
    const worker = `
      import { mutateStore } from ${JSON.stringify(storeModule)}
      for (let i = 0; i < 25; i += 1) {
        mutateStore((store) => {
          const account = store.accounts['stress-0']
          account.usageCount = (account.usageCount || 0) + 1
        })
      }
    `
    const env = {
      ...process.env,
      CODEX_SOFT_STORE_PASSPHRASE: '',
      OPENCODE_MULTI_AUTH_STORE_DIR: STRESS_DIR,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(STRESS_DIR, 'accounts.json')
    }

    await Promise.all(Array.from({ length: 4 }, () =>
      execFileAsync(process.execPath, ['--input-type=module', '--eval', worker], { env })
    ))

    expect(loadStore().accounts['stress-0'].usageCount).toBe(100)
  })
})
