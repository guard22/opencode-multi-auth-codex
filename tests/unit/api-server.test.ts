import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { once } from 'node:events'
import { jest } from '@jest/globals'
import {
  chatCompletionsToResponsesPayload,
  responsesPayloadToChatCompletion,
  sanitizeUpstreamHeaders,
  splitSseEvents,
  startApiServer,
  writeChatCompletionStreamResponse
} from '../../src/api-server.js'
import { addAccount, updateAccount } from '../../src/store.js'
import { activateForce } from '../../src/force-mode.js'

type TestResponse = {
  status: number
  body: any
}

const API_TEST_DIR = path.join(os.tmpdir(), 'oma-api-server-tests')

function request(port: number, path: string, options?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options?.method || 'GET',
      headers: options?.headers
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 0,
            body: raw ? JSON.parse(raw) : null
          })
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    if (options?.body) req.write(options.body)
    req.end()
  })
}

function requestRaw(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve(raw))
    }).on('error', reject)
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve())
  })
}

describe('api server', () => {
  const originalEnv = process.env
  let server: http.Server | null = null
  let port = 0
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>

  beforeEach(async () => {
    fs.rmSync(API_TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(API_TEST_DIR, { recursive: true })
    process.env = {
      ...originalEnv,
      CODEX_SOFT_STORE_PASSPHRASE: '',
      OPENCODE_MULTI_AUTH_API_KEY: 'test-key',
      OPENCODE_MULTI_AUTH_STORE_DIR: API_TEST_DIR,
      OPENCODE_MULTI_AUTH_STORE_FILE: path.join(API_TEST_DIR, 'accounts.json')
    }
    addAccount('api-test', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000
    })
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    server = startApiServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind to TCP')
    port = address.port
  })

  afterEach(async () => {
    if (server) {
      await closeServer(server)
      server = null
    }
    consoleLogSpy.mockRestore()
    process.env = originalEnv
    fs.rmSync(API_TEST_DIR, { recursive: true, force: true })
  })

  it('serves health without inference API auth', async () => {
    const res = await request(port, '/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'opencode-multi-auth-api',
      ready: true
    }))
  })

  it('reports not ready when no account is eligible', async () => {
    updateAccount('api-test', { enabled: false })

    const res = await request(port, '/api/health')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      ok: false,
      ready: false,
      service: 'opencode-multi-auth-api'
    })
  })

  it('reports not ready when force mode pins a blocked account', async () => {
    addAccount('fallback', {
      accessToken: 'fallback-access',
      refreshToken: 'fallback-refresh',
      expiresAt: Date.now() + 60_000
    })
    activateForce('api-test', 'test')
    updateAccount('api-test', { rateLimitedUntil: Date.now() + 60_000 })

    const res = await request(port, '/api/health')

    expect(res.status).toBe(503)
    expect(res.body.ready).toBe(false)
  })

  it('ignores force mode when its alias is disabled', async () => {
    addAccount('fallback', {
      accessToken: 'fallback-access',
      refreshToken: 'fallback-refresh',
      expiresAt: Date.now() + 60_000
    })
    activateForce('api-test', 'test')
    updateAccount('api-test', { enabled: false })

    const res = await request(port, '/api/health')

    expect(res.status).toBe(200)
    expect(res.body.ready).toBe(true)
  })

  it('requires API auth for OpenAI-compatible routes', async () => {
    const res = await request(port, '/v1/models')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns OpenAI-style model list with bearer auth', async () => {
    const res = await request(port, '/v1/models', {
      headers: { Authorization: 'Bearer test-key' }
    })

    expect(res.status).toBe(200)
    expect(res.body.object).toBe('list')
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-5.6', object: 'model' }),
      expect.objectContaining({ id: 'gpt-5.6-sol', object: 'model' }),
      expect.objectContaining({ id: 'gpt-5.6-terra', object: 'model' }),
      expect.objectContaining({ id: 'gpt-5.6-luna', object: 'model' }),
      expect.objectContaining({ id: 'gpt-5.6-sol-max', object: 'model' }),
      expect.objectContaining({ id: 'gpt-5.5', object: 'model' })
    ]))
  })

  it('rejects malformed JSON before invoking proxy runtime', async () => {
    const res = await request(port, '/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json'
      },
      body: '{bad json'
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_JSON')
  })

  it('returns 413 for oversized request bodies', async () => {
    const res = await request(port, '/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json'
      },
      body: 'x'.repeat(25 * 1024 * 1024 + 1)
    })

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('allows clients that always send output limits to reach the proxy', async () => {
    updateAccount('api-test', { expiresAt: Date.now() + 60 * 60_000 })

    const res = await request(port, '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        max_completion_tokens: 20
      })
    })

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_PARSE_ERROR')
  })

  it('requires an API key when starting the server', () => {
    delete process.env.OPENCODE_MULTI_AUTH_API_KEY
    expect(() => startApiServer({ host: '127.0.0.1', port: 0 })).toThrow(/API_KEY_REQUIRED/)
  })
})

describe('chat completions compatibility', () => {
  it('splits LF and CRLF-delimited SSE events', () => {
    expect(splitSseEvents('data: {"a":1}\r\n\r\ndata: {"b":2}\n\npartial')).toEqual({
      events: ['data: {"a":1}', 'data: {"b":2}'],
      rest: 'partial'
    })
  })

  it('streams tool calls and a final usage chunk from CRLF SSE', async () => {
    const upstreamBody = [
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5', created_at: 123 } },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' }
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"Kyiv"}' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
        }
      }
    ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
    const server = http.createServer((_req, res) => {
      void writeChatCompletionStreamResponse(
        res,
        new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }),
        'gpt-5.5',
        true
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Server did not bind to TCP')
      const raw = await requestRaw(address.port)
      const chunks = raw
        .split('\n\n')
        .filter((entry) => entry.startsWith('data: {'))
        .map((entry) => JSON.parse(entry.slice(6)))

      expect(chunks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          choices: [expect.objectContaining({
            delta: { tool_calls: [expect.objectContaining({ index: 0, id: 'call_1' })] }
          })]
        }),
        expect.objectContaining({
          choices: [expect.objectContaining({ finish_reason: 'tool_calls' })]
        }),
        expect.objectContaining({
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        })
      ]))
      expect(raw).toContain('data: [DONE]')
    } finally {
      await closeServer(server)
    }
  })

  it('removes stale body-encoding headers before forwarding decoded bytes', () => {
    const headers = sanitizeUpstreamHeaders(new Headers({
      'content-encoding': 'gzip',
      'content-length': '123',
      'content-type': 'application/json',
      'transfer-encoding': 'chunked'
    }))

    expect(headers.get('content-encoding')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('transfer-encoding')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('converts chat-completions payloads to Responses API payloads', () => {
    expect(chatCompletionsToResponsesPayload({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      max_completion_tokens: 25,
      temperature: 0.2
    })).toEqual({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: false,
      temperature: 0.2
    })
  })

  it('converts assistant history to output content', () => {
    expect(chatCompletionsToResponsesPayload({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hello back' },
        { role: 'user', content: 'continue' }
      ]
    })).toEqual(expect.objectContaining({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hello back' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
      ]
    }))
  })

  it('converts Responses API payloads to chat-completions payloads', () => {
    expect(responsesPayloadToChatCompletion({
      id: 'resp_123',
      model: 'gpt-5.5',
      created_at: 123,
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'hello back' }
          ]
        }
      ],
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5
      }
    })).toEqual({
      id: 'resp_123',
      object: 'chat.completion',
      created: 123,
      model: 'gpt-5.5',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello back'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5
      }
    })
  })

  it('converts chat tool calls and tool results to Responses input items', () => {
    expect(chatCompletionsToResponsesPayload({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Kyiv"}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call_123', content: '{"temperature":20}' }
      ]
    })).toEqual(expect.objectContaining({
      input: [
        {
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '{"city":"Kyiv"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_123',
          output: '{"temperature":20}'
        }
      ]
    }))
  })

  it('preserves multimodal image detail when converting chat input', () => {
    expect(chatCompletionsToResponsesPayload({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } }
        ]
      }]
    })).toEqual(expect.objectContaining({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' }
        ]
      }]
    }))
  })

  it('converts text-array tool results without serializing wrapper objects', () => {
    expect(chatCompletionsToResponsesPayload({
      messages: [{
        role: 'tool',
        tool_call_id: 'call_123',
        content: [
          { type: 'text', text: 'temperature: ' },
          { type: 'text', text: '20C' }
        ]
      }]
    })).toEqual(expect.objectContaining({
      input: [{
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'temperature: 20C'
      }]
    }))
  })

  it('converts Responses function calls to chat tool calls', () => {
    expect(responsesPayloadToChatCompletion({
      id: 'resp_tool',
      model: 'gpt-5.5',
      output: [{
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"city":"Kyiv"}'
      }]
    })).toEqual(expect.objectContaining({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Kyiv"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }))
  })
})
