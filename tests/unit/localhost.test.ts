import { isLocalhostHost, isWebHostAllowed } from '../../src/web.js'

describe('Localhost Binding', () => {
  const originalAllowRemoteHost = process.env.OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST

  afterEach(() => {
    if (originalAllowRemoteHost === undefined) {
      delete process.env.OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST
    } else {
      process.env.OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST = originalAllowRemoteHost
    }
  })

  it('should accept 127.0.0.1', () => {
    expect(isLocalhostHost('127.0.0.1')).toBe(true)
  })

  it('should accept ::1', () => {
    expect(isLocalhostHost('::1')).toBe(true)
  })

  it('should accept localhost', () => {
    expect(isLocalhostHost('localhost')).toBe(true)
  })

  it('should accept LOCALHOST (case insensitive)', () => {
    expect(isLocalhostHost('LOCALHOST')).toBe(true)
  })

  it('should reject 0.0.0.0', () => {
    expect(isLocalhostHost('0.0.0.0')).toBe(false)
  })

  it('should reject external IP', () => {
    expect(isLocalhostHost('192.168.1.1')).toBe(false)
  })

  it('should reject public IP', () => {
    expect(isLocalhostHost('8.8.8.8')).toBe(false)
  })

  it('should reject domain name', () => {
    expect(isLocalhostHost('example.com')).toBe(false)
  })

  it('should reject :: (all interfaces IPv6)', () => {
    expect(isLocalhostHost('::')).toBe(false)
  })

  it('allows container binding only with an explicit opt-in', () => {
    delete process.env.OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST
    expect(isWebHostAllowed('0.0.0.0')).toBe(false)

    process.env.OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST = '1'
    expect(isWebHostAllowed('0.0.0.0')).toBe(true)
  })
})
