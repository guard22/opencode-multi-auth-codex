import * as http from 'node:http'
import { once } from 'node:events'
import { jest } from '@jest/globals'
import {
  chatCompletionsToResponsesPayload,
  responsesPayloadToChatCompletion,
  startApiServer
} from '../../src/api-server.js'

type TestResponse = {
  status: number
  body: any
}

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
    process.env = { ...originalEnv, OPENCODE_MULTI_AUTH_API_KEY: 'test-key' }
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
  })

  it('serves health without inference API auth', async () => {
    const res = await request(port, '/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'opencode-multi-auth-api',
      accountCount: expect.any(Number)
    }))
  })

  it('requires API auth for OpenAI-compatible routes when a key is configured', async () => {
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
})

describe('chat completions compatibility', () => {
  it('converts chat-completions payloads to Responses API payloads', () => {
    expect(chatCompletionsToResponsesPayload({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      temperature: 0.2
    })).toEqual({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hello' }],
      stream: false,
      temperature: 0.2
    })
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
})
