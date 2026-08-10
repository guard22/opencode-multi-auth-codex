import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import lockfile from 'proper-lockfile'
import { getStorePath } from './store.js'

const LOCK_STALE_MS = 30_000
const LOCK_UPDATE_MS = 5_000
const LOCK_TIMEOUT_MS = 45_000
const LOCK_POLL_MS = 25

function getLockPath(alias: string): string {
  const key = createHash('sha256').update(alias).digest('hex').slice(0, 24)
  return path.join(`${getStorePath()}.refresh-locks`, key)
}

async function acquireAccountRefreshLock(alias: string): Promise<() => Promise<void>> {
  const lockPath = getLockPath(alias)
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(lockPath, '', { flag: 'a', mode: 0o600 })
  return lockfile.lock(lockPath, {
    realpath: false,
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
    retries: {
      retries: Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS),
      factor: 1,
      minTimeout: LOCK_POLL_MS,
      maxTimeout: LOCK_POLL_MS,
      randomize: true
    }
  })
}

export async function withAccountRefreshLock<T>(
  alias: string,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireAccountRefreshLock(alias)
  try {
    return await work()
  } finally {
    await release()
  }
}
