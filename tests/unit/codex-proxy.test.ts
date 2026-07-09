import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import {
  filterInput,
  handleCodexProxyRequest,
  normalizeModel,
  normalizeResponsesTools,
  supportsFastMode,
  toCodexBackendUrl
} from '../../src/codex-proxy.js'
import { DEFAULT_CONFIG } from '../../src/types.js'

describe('codex proxy helpers', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST
    delete process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('normalizes provider-prefixed and option-suffixed model ids', () => {
    expect(normalizeModel('openai/gpt-5.5-high')).toBe('gpt-5.5')
    expect(normalizeModel('gpt-5.4-fast')).toBe('gpt-5.4')
    expect(normalizeModel(undefined)).toBe('gpt-5.1')
  })

  it('maps older Codex models to latest when enabled', () => {
    process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST = '1'
    process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL = 'gpt-5.6'

    expect(normalizeModel('openai/gpt-5.4-medium')).toBe('gpt-5.6')
  })

  it('rewrites OpenAI-compatible paths to ChatGPT Codex backend paths', () => {
    expect(toCodexBackendUrl('https://chatgpt.com/backend-api/responses?foo=bar')).toBe(
      'https://chatgpt.com/backend-api/codex/responses?foo=bar'
    )
    expect(toCodexBackendUrl('/v1/chat/completions')).toBe(
      'https://chatgpt.com/backend-api/codex/chat/completions'
    )
    expect(toCodexBackendUrl('/v1/responses')).toBe(
      'https://chatgpt.com/backend-api/codex/responses'
    )
  })

  it('removes unsupported item references and ids from input arrays', () => {
    expect(filterInput([
      { type: 'message', id: 'msg_1', content: 'hello' },
      { type: 'item_reference', id: 'ref_1' },
      'literal'
    ])).toEqual([
      { type: 'message', content: 'hello' },
      'literal'
    ])
  })

  it('leaves non-array inputs unchanged for low-level filtering', () => {
    expect(filterInput('hello')).toBe('hello')
  })

  it('detects supported fast-mode models', () => {
    expect(supportsFastMode('gpt-5.5')).toBe(true)
    expect(supportsFastMode('gpt-5.4')).toBe(true)
    expect(supportsFastMode('gpt-5.3-codex')).toBe(false)
  })

  it('normalizes OpenAI function tools for Responses API', () => {
    expect(normalizeResponsesTools([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' }
        }
      }
    ])).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' },
        strict: undefined
      }
    ])
  })
})

describe('codex proxy runtime', () => {
  const originalEnv = process.env
  let testDir = ''
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `oma-codex-proxy-${Date.now()}-${Math.random()}`)
    fs.mkdirSync(testDir, { recursive: true })
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_STORE_DIR: testDir,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(testDir, 'accounts.json')
    }
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    process.env = originalEnv
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('returns a deterministic no-eligible-accounts error without configured accounts', async () => {
    const response = await handleCodexProxyRequest('/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' })
    }, { config: DEFAULT_CONFIG })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NO_ELIGIBLE_ACCOUNTS',
        message: 'No available accounts after filtering'
      }
    })
  })
})
