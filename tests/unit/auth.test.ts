import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import {
  createAuthorizationFlow,
  ensureValidToken,
  loginAccount,
  refreshToken,
  validateAuthorizationCallback
} from '../../src/auth.js'
import { addAccount, loadStore, updateAccount } from '../../src/store.js'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve free port'))
        return
      }
      server.close((err) => err ? reject(err) : resolve(address.port))
    })
    server.on('error', reject)
  })
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('OAuth callback validation', () => {
  it('keeps the registered localhost redirect URI', async () => {
    const flow = await createAuthorizationFlow(1455)

    expect(flow.redirectUri).toBe('http://localhost:1455/auth/callback')
    expect(new URL(flow.url).searchParams.get('redirect_uri')).toBe(flow.redirectUri)
  })

  it('accepts the complete callback URL for the active flow', async () => {
    const flow = await createAuthorizationFlow(1455)
    const callbackUrl = `${flow.redirectUri}?code=one-time-code&state=${flow.state}`

    expect(validateAuthorizationCallback(flow, callbackUrl)).toBe('one-time-code')
  })

  it.each([
    'not-a-url',
    'http://localhost:1455/auth/callback?state=STATE',
    'http://localhost:1455/auth/callback?code=CODE',
    'http://localhost:1456/auth/callback?code=CODE&state=STATE',
    'https://dashboard.example.com/auth/callback?code=CODE&state=STATE'
  ])('rejects an invalid callback URL: %s', async (callbackUrl) => {
    const flow = await createAuthorizationFlow(1455)
    const value = callbackUrl.replace('STATE', flow.state)

    expect(() => validateAuthorizationCallback(flow, value)).toThrow()
  })

  it('completes an active login from a submitted callback URL', async () => {
    const originalEnv = process.env
    const originalFetch = global.fetch
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-auth-callback-'))
    const port = await getFreePort()
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_REDIRECT_PORTS: String(port),
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json'),
      CODEX_SOFT_STORE_PASSPHRASE: ''
    }

    const accessToken = jwt({ email: 'remote@example.com', exp: 4_102_444_800 })
    global.fetch = jest.fn(async (input: Request | string | URL) => {
      if (String(input).endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ email: 'remote@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    try {
      const flow = await createAuthorizationFlow(port)
      const callbackUrl = Promise.resolve(
        `${flow.redirectUri}?code=remote-code&state=${flow.state}`
      )
      const account = await loginAccount('remote', flow, { callbackUrl })

      expect(account.email).toBe('remote@example.com')
      expect(account.refreshToken).toBe('refresh-token')
      const tokenCall = (global.fetch as jest.Mock).mock.calls[0]
      const tokenInit = tokenCall[1] as RequestInit | undefined
      expect(String(tokenInit?.body)).toContain('redirect_uri=http%3A%2F%2Flocalhost')
    } finally {
      global.fetch = originalFetch
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })
})

describe('token refresh coordination', () => {
  it('shares one token exchange between concurrent callers', async () => {
    const originalEnv = process.env
    const originalFetch = global.fetch
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-auth-refresh-'))
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json'),
      CODEX_SOFT_STORE_PASSPHRASE: ''
    }

    addAccount('concurrent', {
      accessToken: jwt({ exp: 1 }),
      refreshToken: 'original-refresh-token',
      expiresAt: Date.now() - 1
    })

    let releaseResponse: (() => void) | undefined
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const mockFetch = jest.fn(async () => {
      await responseGate
      return new Response(JSON.stringify({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    global.fetch = mockFetch as typeof fetch

    try {
      const first = ensureValidToken('concurrent')
      const second = ensureValidToken('concurrent')
      await new Promise((resolve) => setTimeout(resolve, 10))
      releaseResponse?.()

      const [firstToken, secondToken] = await Promise.all([first, second])

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(firstToken).toBe(secondToken)
      expect(loadStore().accounts.concurrent.refreshToken).toBe('rotated-refresh-token')
    } finally {
      global.fetch = originalFetch
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('returns newer credentials when a failed refresh loses a token race', async () => {
    const originalEnv = process.env
    const originalFetch = global.fetch
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-auth-refresh-race-'))
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json'),
      CODEX_SOFT_STORE_PASSPHRASE: ''
    }

    addAccount('refresh-race', {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: Date.now() - 1
    })

    let releaseResponse: (() => void) | undefined
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let notifyFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve
    })
    global.fetch = jest.fn(async () => {
      notifyFetchStarted?.()
      await responseGate
      return new Response('{}', { status: 401 })
    }) as typeof fetch

    try {
      const refresh = refreshToken('refresh-race')
      await fetchStarted
      updateAccount('refresh-race', {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: Date.now() + 3_600_000,
        authInvalid: false,
        authInvalidatedAt: undefined
      })
      releaseResponse?.()

      const result = await refresh

      expect(result?.accessToken).toBe('new-access-token')
      expect(loadStore().accounts['refresh-race'].authInvalid).toBe(false)
    } finally {
      global.fetch = originalFetch
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('preserves stored credentials when a successful refresh response is malformed', async () => {
    const originalEnv = process.env
    const originalFetch = global.fetch
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-auth-refresh-invalid-'))
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: storeDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(storeDir, 'accounts.json'),
      CODEX_SOFT_STORE_PASSPHRASE: ''
    }
    addAccount('malformed', {
      accessToken: 'original-access-token',
      refreshToken: 'original-refresh-token',
      expiresAt: Date.now() - 1
    })
    global.fetch = jest.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch

    try {
      await expect(refreshToken('malformed')).resolves.toBeNull()
      expect(loadStore().accounts.malformed).toEqual(expect.objectContaining({
        accessToken: 'original-access-token',
        refreshToken: 'original-refresh-token'
      }))
    } finally {
      global.fetch = originalFetch
      process.env = originalEnv
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
  })
})
