import { createAuthorizationFlow } from '../../src/auth.js'

describe('OAuth redirect URI', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OPENCODE_MULTI_AUTH_REDIRECT_URI
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('uses the local callback by default', async () => {
    const flow = await createAuthorizationFlow(1457)

    expect(flow.redirectUri).toBe('http://localhost:1457/auth/callback')
    expect(new URL(flow.url).searchParams.get('redirect_uri')).toBe(flow.redirectUri)
  })

  it('uses a configured public callback', async () => {
    process.env.OPENCODE_MULTI_AUTH_REDIRECT_URI =
      'https://dashboard.pool.anw1.anstar.com/auth/callback'

    const flow = await createAuthorizationFlow(1455)

    expect(flow.redirectUri).toBe(
      'https://dashboard.pool.anw1.anstar.com/auth/callback'
    )
    expect(new URL(flow.url).searchParams.get('redirect_uri')).toBe(flow.redirectUri)
    expect(flow.port).toBe(1455)
  })

  it.each([
    'dashboard.example.com/auth/callback',
    'ftp://dashboard.example.com/auth/callback',
    'https://dashboard.example.com/wrong-path',
    'https://dashboard.example.com/auth/callback?source=test'
  ])('rejects invalid configured callback %s', async (redirectUri) => {
    process.env.OPENCODE_MULTI_AUTH_REDIRECT_URI = redirectUri

    await expect(createAuthorizationFlow(1455)).rejects.toThrow(
      'OPENCODE_MULTI_AUTH_REDIRECT_URI'
    )
  })
})
