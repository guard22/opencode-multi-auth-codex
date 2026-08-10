import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { withAccountRefreshLock } from '../../src/token-refresh-lock.js'

const execFileAsync = promisify(execFile)

describe('account refresh lock', () => {
  it('serializes refresh work for the same account', async () => {
    const originalEnv = process.env
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-refresh-lock-'))
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json')
    }

    let running = 0
    let maxRunning = 0
    const work = async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, 25))
      running -= 1
    }

    try {
      await Promise.all([
        withAccountRefreshLock('shared', work),
        withAccountRefreshLock('shared', work)
      ])

      expect(maxRunning).toBe(1)
    } finally {
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('serializes refresh work across processes', async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-refresh-lock-process-'))
    const eventsFile = path.join(storeDir, 'events.log')
    const lockModule = new URL('../../dist/token-refresh-lock.js', import.meta.url).href
    const env = {
      ...process.env,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json')
    }
    const worker = (id: string) => `
      import fs from 'node:fs/promises'
      import { withAccountRefreshLock } from ${JSON.stringify(lockModule)}
      await withAccountRefreshLock('shared-process', async () => {
        await fs.appendFile(${JSON.stringify(eventsFile)}, 'start-${id}\\n')
        await new Promise((resolve) => setTimeout(resolve, 75))
        await fs.appendFile(${JSON.stringify(eventsFile)}, 'end-${id}\\n')
      })
    `

    try {
      await Promise.all([
        execFileAsync(process.execPath, ['--input-type=module', '--eval', worker('one')], { env }),
        execFileAsync(process.execPath, ['--input-type=module', '--eval', worker('two')], { env })
      ])

      const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n')
      expect(events).toHaveLength(4)
      expect(events[0]).toMatch(/^start-/)
      expect(events[1]).toBe(events[0].replace('start-', 'end-'))
      expect(events[2]).toMatch(/^start-/)
      expect(events[3]).toBe(events[2].replace('start-', 'end-'))
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('releases the lock when refresh work fails', async () => {
    const originalEnv = process.env
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-refresh-lock-error-'))
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json')
    }

    try {
      await expect(withAccountRefreshLock('failing', async () => {
        throw new Error('refresh failed')
      })).rejects.toThrow('refresh failed')

      await expect(withAccountRefreshLock('failing', async () => 'recovered'))
        .resolves.toBe('recovered')
    } finally {
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })
})
