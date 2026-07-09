import * as http from 'node:http';
import { getDefaultModels } from './models.js';
import { getSettings } from './settings.js';
import { getStoreStatus, loadStore } from './store.js';
import { DEFAULT_CONFIG } from './types.js';
import { handleCodexProxyRequest } from './codex-proxy.js';
const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 3435;
const LOCALHOST_HOST_PATTERN = /^(127\.0\.0\.1|::1|localhost)$/i;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
function getEnvFlag(name) {
    const raw = (process.env[name] || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}
function getApiKey() {
    return (process.env.OPENCODE_MULTI_AUTH_API_KEY || '').trim();
}
function isLocalhostHost(host) {
    return LOCALHOST_HOST_PATTERN.test(host.trim());
}
function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}
function getRequestAuth(req) {
    const auth = req.headers.authorization || '';
    if (Array.isArray(auth))
        return auth[0] || '';
    return auth;
}
function getRequestApiKey(req) {
    const header = req.headers['x-api-key'] || '';
    if (Array.isArray(header))
        return header[0] || '';
    return header;
}
function isAuthorized(req) {
    const apiKey = getApiKey();
    if (!apiKey)
        return true;
    const auth = getRequestAuth(req);
    if (auth === `Bearer ${apiKey}`)
        return true;
    return getRequestApiKey(req) === apiKey;
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            total += Buffer.byteLength(chunk);
            if (total > MAX_BODY_BYTES) {
                const err = new Error('Payload too large');
                err.code = 'PAYLOAD_TOO_LARGE';
                reject(err);
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
async function writeFetchResponse(res, upstream) {
    res.statusCode = upstream.status;
    res.statusMessage = upstream.statusText;
    upstream.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });
    if (!upstream.body) {
        res.end();
        return;
    }
    const reader = upstream.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            res.write(Buffer.from(value));
        }
        res.end();
    }
    catch (err) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
}
function createModelsPayload() {
    const models = getDefaultModels();
    return {
        object: 'list',
        data: Object.keys(models).map((id) => ({
            id,
            object: 'model',
            created: 0,
            owned_by: 'openai'
        }))
    };
}
function createHealthPayload() {
    const store = loadStore();
    const settings = getSettings();
    return {
        ok: true,
        service: 'opencode-multi-auth-api',
        accountCount: Object.keys(store.accounts).length,
        activeAlias: store.activeAlias,
        storeStatus: getStoreStatus(),
        featureFlags: settings.settings.featureFlags || { antigravityEnabled: false }
    };
}
export function chatCompletionsToResponsesPayload(payload) {
    const { messages, stream, ...rest } = payload && typeof payload === 'object' ? payload : {};
    delete rest.max_output_tokens;
    delete rest.max_completion_tokens;
    delete rest.max_tokens;
    return {
        ...rest,
        input: Array.isArray(messages)
            ? messages.map((message) => {
                if (!message || typeof message !== 'object')
                    return message;
                if (typeof message.content !== 'string')
                    return message;
                return {
                    ...message,
                    content: [{ type: 'input_text', text: message.content }]
                };
            })
            : [],
        stream: false
    };
}
function extractTextFromResponsePayload(payload) {
    if (typeof payload?.output_text === 'string')
        return payload.output_text;
    const output = Array.isArray(payload?.output) ? payload.output : [];
    const parts = [];
    for (const item of output) {
        if (typeof item?.text === 'string') {
            parts.push(item.text);
        }
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const contentItem of content) {
            if (typeof contentItem?.text === 'string') {
                parts.push(contentItem.text);
            }
        }
    }
    return parts.join('');
}
export function responsesPayloadToChatCompletion(payload, fallbackModel) {
    const model = typeof payload?.model === 'string' ? payload.model : fallbackModel || 'unknown';
    const created = typeof payload?.created_at === 'number'
        ? Math.floor(payload.created_at)
        : Math.floor(Date.now() / 1000);
    const text = extractTextFromResponsePayload(payload);
    const usage = payload?.usage && typeof payload.usage === 'object'
        ? {
            prompt_tokens: payload.usage.input_tokens,
            completion_tokens: payload.usage.output_tokens,
            total_tokens: payload.usage.total_tokens
        }
        : undefined;
    return {
        id: typeof payload?.id === 'string' ? payload.id : `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created,
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: text
                },
                finish_reason: 'stop'
            }
        ],
        usage
    };
}
async function writeChatCompletionResponse(res, upstream, fallbackModel) {
    if (!upstream.ok) {
        await writeFetchResponse(res, upstream);
        return;
    }
    const payload = await upstream.json().catch(() => null);
    sendJson(res, upstream.status, responsesPayloadToChatCompletion(payload, fallbackModel));
}
function writeSseData(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function writeChatCompletionStreamResponse(res, upstream, fallbackModel) {
    if (!upstream.ok) {
        await writeFetchResponse(res, upstream);
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    if (!upstream.body) {
        res.end('data: [DONE]\n\n');
        return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseId = `chatcmpl-${Date.now()}`;
    let model = fallbackModel || 'unknown';
    let created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    const sendRole = () => {
        if (sentRole)
            return;
        sentRole = true;
        writeSseData(res, {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        });
    };
    const sendContent = (content) => {
        sendRole();
        writeSseData(res, {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }]
        });
    };
    const finish = () => {
        sendRole();
        writeSseData(res, {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        });
        res.write('data: [DONE]\n\n');
        res.end();
    };
    const handleEvent = (chunk) => {
        const dataLine = chunk
            .split('\n')
            .find((line) => line.startsWith('data: '));
        if (!dataLine)
            return;
        let data;
        try {
            data = JSON.parse(dataLine.slice(6));
        }
        catch {
            return;
        }
        if (data?.response) {
            if (typeof data.response.id === 'string')
                responseId = data.response.id;
            if (typeof data.response.model === 'string')
                model = data.response.model;
            if (typeof data.response.created_at === 'number')
                created = Math.floor(data.response.created_at);
        }
        if (data?.type === 'response.output_text.delta' && typeof data.delta === 'string') {
            sendContent(data.delta);
            return;
        }
        if (data?.type === 'response.completed' || data?.type === 'response.done') {
            finish();
        }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
                handleEvent(event);
                if (res.writableEnded)
                    return;
            }
        }
        if (!res.writableEnded) {
            finish();
        }
    }
    catch (err) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
}
export function startApiServer(options) {
    const host = options?.host ?? process.env.OPENCODE_MULTI_AUTH_API_HOST ?? DEFAULT_API_HOST;
    const portRaw = process.env.OPENCODE_MULTI_AUTH_API_PORT;
    const port = options?.port ?? (portRaw ? Number(portRaw) : DEFAULT_API_PORT);
    const config = options?.config || DEFAULT_CONFIG;
    const allowRemote = getEnvFlag('OPENCODE_MULTI_AUTH_ALLOW_REMOTE_API');
    const apiKey = getApiKey();
    if (!Number.isFinite(port)) {
        throw new Error('INVALID_PORT: API port must be a number');
    }
    if (!isLocalhostHost(host)) {
        if (!allowRemote) {
            throw new Error('REMOTE_API_DISABLED: set OPENCODE_MULTI_AUTH_ALLOW_REMOTE_API=1 to bind the API remotely');
        }
        if (!apiKey) {
            throw new Error('API_KEY_REQUIRED: OPENCODE_MULTI_AUTH_API_KEY is required for remote API binding');
        }
    }
    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
        const path = requestUrl.pathname;
        try {
            if (req.method === 'GET' && path === '/api/health') {
                sendJson(res, 200, createHealthPayload());
                return;
            }
            if (path.startsWith('/v1/')) {
                if (!isAuthorized(req)) {
                    sendJson(res, 401, {
                        error: {
                            code: 'UNAUTHORIZED',
                            message: 'Missing or invalid API key'
                        }
                    });
                    return;
                }
                if (req.method === 'GET' && path === '/v1/models') {
                    sendJson(res, 200, createModelsPayload());
                    return;
                }
                if (req.method === 'POST' && (path === '/v1/responses' || path === '/v1/chat/completions')) {
                    const rawBody = await readBody(req);
                    const body = rawBody.trim() ? rawBody : '{}';
                    let parsedBody;
                    try {
                        parsedBody = JSON.parse(body);
                    }
                    catch {
                        sendJson(res, 400, {
                            error: {
                                code: 'INVALID_JSON',
                                message: 'Invalid JSON payload'
                            }
                        });
                        return;
                    }
                    if (path === '/v1/chat/completions') {
                        const stream = parsedBody?.stream === true;
                        const responsesBody = JSON.stringify({
                            ...chatCompletionsToResponsesPayload(parsedBody),
                            stream
                        });
                        const upstream = await handleCodexProxyRequest('/v1/responses' + requestUrl.search, {
                            method: req.method,
                            headers: new Headers(req.headers),
                            body: responsesBody
                        }, { config });
                        if (stream) {
                            await writeChatCompletionStreamResponse(res, upstream, parsedBody?.model);
                        }
                        else {
                            await writeChatCompletionResponse(res, upstream, parsedBody?.model);
                        }
                        return;
                    }
                    const upstream = await handleCodexProxyRequest(path + requestUrl.search, {
                        method: req.method,
                        headers: new Headers(req.headers),
                        body
                    }, { config });
                    await writeFetchResponse(res, upstream);
                    return;
                }
            }
            sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        }
        catch (err) {
            if (res.writableEnded)
                return;
            const code = err?.code;
            if (code === 'PAYLOAD_TOO_LARGE') {
                sendJson(res, 413, { error: { code, message: 'Payload too large' } });
                return;
            }
            sendJson(res, 500, {
                error: {
                    code: 'INTERNAL_ERROR',
                    message: err instanceof Error ? err.message : String(err)
                }
            });
        }
    });
    server.listen(port, host, () => {
        console.log(`[multi-auth] API server running at http://${host}:${port}`);
    });
    return server;
}
//# sourceMappingURL=api-server.js.map