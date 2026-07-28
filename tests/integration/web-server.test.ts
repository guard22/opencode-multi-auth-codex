import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as http from 'node:http'
import { once } from 'node:events'

const SANDBOX_ROOT = path.join(os.tmpdir(), 'oma-web-integration-sandbox')
const STORE_FILE = path.join(SANDBOX_ROOT, 'accounts.json')
const AUTH_FILE = path.join(SANDBOX_ROOT, 'auth.json')
const originalEnv = process.env

let startWebConsole: typeof import('../../src/web.js').startWebConsole
let getCodexAuthPath: typeof import('../../src/codex-auth.js').getCodexAuthPath

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve free port'))
        return
      }
      const port = address.port
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(port)
      })
    })
    server.on('error', reject)
  })
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

beforeAll(async () => {
  if (fs.existsSync(SANDBOX_ROOT)) {
    fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true })
  }
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true })
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }, null, 2))

  process.env = {
    ...originalEnv,
    OPENCODE_MULTI_AUTH_STORE_DIR: SANDBOX_ROOT,
    OPENCODE_MULTI_AUTH_STORE_FILE: STORE_FILE,
    OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE: AUTH_FILE
  }

  ;({ startWebConsole } = await import('../../src/web.js'))
  ;({ getCodexAuthPath } = await import('../../src/codex-auth.js'))
})

afterAll(() => {
  try {
    if (getCodexAuthPath) {
      fs.unwatchFile(getCodexAuthPath())
    }
  } catch {
    // ignore
  }
  process.env = originalEnv
  if (fs.existsSync(SANDBOX_ROOT)) {
    fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true })
  }
})

describe('web server hardening', () => {
  it('rejects non-loopback host binding', () => {
    expect(() => startWebConsole({ host: '0.0.0.0', port: 4120 })).toThrow(/LOCALHOST_ONLY|localhost/i)
  })

  it('returns 400 for invalid JSON and keeps server alive', async () => {
    const port = await getFreePort()
    const server = startWebConsole({ host: '127.0.0.1', port })

    try {
      await once(server, 'listening')

      const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json'
      })

      expect(invalidResponse.status).toBe(400)
      const invalidPayload = (await invalidResponse.json()) as { code?: string }
      expect(invalidPayload.code).toBe('INVALID_JSON')

      const healthyResponse = await fetch(`http://127.0.0.1:${port}/api/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })

      expect(healthyResponse.status).toBe(400)
    } finally {
      await closeServer(server)
      fs.unwatchFile(getCodexAuthPath())
    }
  })

  it('rejects callback submission when no login is pending', async () => {
    const port = await getFreePort()
    const server = startWebConsole({ host: '127.0.0.1', port })

    try {
      await once(server, 'listening')
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callbackUrl: 'http://localhost:1455/auth/callback?code=test&state=test'
        })
      })

      expect(response.status).toBe(409)
    } finally {
      await closeServer(server)
      fs.unwatchFile(getCodexAuthPath())
    }
  })

  it('completes both auth and re-auth through callback submission', async () => {
    const port = await getFreePort()
    const callbackPort = await getFreePort()
    const originalFetch = global.fetch
    process.env.OPENCODE_MULTI_AUTH_REDIRECT_PORTS = String(callbackPort)
    const accessToken = jwt({ email: 'remote@example.com', exp: 4_102_444_800 })
    global.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const target = String(input)
      if (target === 'https://auth.openai.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (target === 'https://auth.openai.com/userinfo') {
        return new Response(JSON.stringify({ email: 'remote@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch
    const server = startWebConsole({ host: '127.0.0.1', port })
    const baseUrl = `http://127.0.0.1:${port}`

    const completeFlow = async (authorizationUrl: string, code: string): Promise<void> => {
      const authorize = new URL(authorizationUrl)
      const redirectUri = authorize.searchParams.get('redirect_uri')
      const state = authorize.searchParams.get('state')
      expect(redirectUri).toBe(`http://localhost:${callbackPort}/auth/callback`)
      expect(state).toBeTruthy()

      const response = await originalFetch(`${baseUrl}/api/auth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl: `${redirectUri}?code=${code}&state=${state}` })
      })
      expect(response.status).toBe(202)

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const stateResponse = await originalFetch(`${baseUrl}/api/state`)
        const dashboardState = await stateResponse.json() as {
          login: unknown
          accounts: Array<{ alias: string }>
        }
        if (!dashboardState.login && dashboardState.accounts.some((account) => account.alias === 'remote')) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('OAuth callback did not complete')
    }

    try {
      await once(server, 'listening')
      const authResponse = await originalFetch(`${baseUrl}/api/auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'remote' })
      })
      expect(authResponse.status).toBe(200)
      const authResult = await authResponse.json() as { url: string }
      await completeFlow(authResult.url, 'initial-code')

      const reauthResponse = await originalFetch(`${baseUrl}/api/accounts/remote/reauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'dashboard' })
      })
      expect(reauthResponse.status).toBe(200)
      const reauthResult = await reauthResponse.json() as { url: string }

      const pendingResponse = await originalFetch(`${baseUrl}/api/state`)
      const pendingState = await pendingResponse.json() as {
        login: { alias?: string; mode?: string } | null
      }
      expect(pendingState.login).toMatchObject({ alias: 'remote', mode: 'manual' })
      await completeFlow(reauthResult.url, 'reauth-code')
    } finally {
      global.fetch = originalFetch
      delete process.env.OPENCODE_MULTI_AUTH_REDIRECT_PORTS
      await closeServer(server)
      fs.unwatchFile(getCodexAuthPath())
    }
  })
})
