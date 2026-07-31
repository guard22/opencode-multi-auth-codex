import { createHash, randomBytes } from 'node:crypto';
import * as http from 'http';
import { addAccount, updateAccount, loadStore } from './store.js';
import { clearAuthInvalid } from './rotation.js';
import { decodeJwtPayload, getAccountIdFromClaims, getEmailFromClaims, getExpiryFromClaims, getPlanTypeFromClaims } from './codex-auth.js';
const OPENAI_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459];
const SCOPES = ['openid', 'profile', 'email', 'offline_access'];
function getRedirectUri(port) {
    return `http://localhost:${port}/auth/callback`;
}
function getRedirectPorts() {
    const configured = (process.env.OPENCODE_MULTI_AUTH_REDIRECT_PORTS || '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
    return configured.length > 0 ? Array.from(new Set(configured)) : DEFAULT_REDIRECT_PORTS;
}
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
export async function createAuthorizationFlow(port) {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const redirectPort = port || getRedirectPorts()[0];
    const redirectUri = getRedirectUri(redirectPort);
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('audience', 'https://api.openai.com/v1');
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'codex_cli_rs');
    return { pkce, state, url: authUrl.toString(), redirectUri, port: redirectPort };
}
function tryListenOnPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('error', onError);
            reject(err);
        };
        server.on('error', onError);
        server.listen(port, () => {
            server.off('error', onError);
            resolve();
        });
    });
}
async function findAvailablePort(server, ports) {
    for (const port of ports) {
        try {
            await tryListenOnPort(server, port);
            return port;
        }
        catch (err) {
            if (err.code === 'EADDRINUSE') {
                continue;
            }
            throw err;
        }
    }
    throw new Error(`All ports ${ports.join(', ')} are in use. Stop Codex CLI if running.`);
}
export function validateAuthorizationCallback(flow, callbackUrl) {
    let parsed;
    try {
        parsed = new URL(callbackUrl);
    }
    catch {
        throw new Error('Callback must be the full localhost URL from the browser');
    }
    const expected = new URL(flow.redirectUri);
    if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) {
        throw new Error(`Callback must start with ${flow.redirectUri}`);
    }
    const code = parsed.searchParams.get('code');
    if (!code)
        throw new Error('Callback URL has no authorization code');
    if (parsed.searchParams.get('state') !== flow.state) {
        throw new Error('Callback URL has an invalid state');
    }
    return code;
}
async function completeAuthorizationCallback(alias, flow, callbackUrl) {
    const code = validateAuthorizationCallback(flow, callbackUrl);
    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code,
            code_verifier: flow.pkce.verifier,
            redirect_uri: flow.redirectUri
        })
    });
    if (!tokenRes.ok) {
        throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }
    const tokens = (await tokenRes.json());
    if (!tokens.refresh_token) {
        throw new Error('Token exchange did not return a refresh_token');
    }
    const now = Date.now();
    const accessClaims = decodeJwtPayload(tokens.access_token);
    const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
    const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || now + tokens.expires_in * 1000;
    let email = getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims);
    try {
        const userRes = await fetch(`${OPENAI_ISSUER}/userinfo`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (userRes.ok) {
            const user = (await userRes.json());
            email = user.email || email;
        }
    }
    catch {
        /* user info fetch is non-critical */
    }
    const accountId = getAccountIdFromClaims(idClaims) ||
        getAccountIdFromClaims(accessClaims);
    const planType = getPlanTypeFromClaims(idClaims) ||
        getPlanTypeFromClaims(accessClaims);
    const store = addAccount(alias, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        accountId,
        planType,
        expiresAt,
        email,
        lastRefresh: new Date(now).toISOString(),
        lastSeenAt: now,
        source: 'opencode',
        authInvalid: false,
        authInvalidatedAt: undefined
    });
    return store.accounts[alias];
}
export async function loginAccount(alias, flow, options) {
    const ports = getRedirectPorts();
    let activeFlow = flow;
    let server = null;
    const timeoutMs = Math.max(30_000, options?.timeoutMs ?? 5 * 60 * 1000);
    return new Promise(async (resolve, reject) => {
        let finished = false;
        let callbackInFlight = false;
        let timeout = null;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (server) {
                server.close();
                server = null;
            }
        };
        const finish = (fn) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            fn();
        };
        const processCallback = async (callbackUrl) => {
            if (finished || callbackInFlight || !activeFlow) {
                throw new Error('Authorization callback is no longer pending');
            }
            callbackInFlight = true;
            return completeAuthorizationCallback(alias, activeFlow, callbackUrl);
        };
        server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith('/auth/callback')) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            if (!activeFlow) {
                res.writeHead(500);
                res.end('No active flow');
                finish(() => reject(new Error('No active flow')));
                return;
            }
            try {
                const callbackUrl = new URL(req.url, activeFlow.redirectUri).toString();
                const account = await processCallback(callbackUrl);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Account "${alias}" authenticated!</h1>
              <p>${account.email || 'Unknown email'}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
                finish(() => resolve(account));
            }
            catch (err) {
                res.writeHead(500);
                res.end('Authentication failed');
                finish(() => reject(err));
            }
        });
        try {
            const actualPort = await findAvailablePort(server, ports);
            if (!activeFlow || activeFlow.port !== actualPort) {
                activeFlow = await createAuthorizationFlow(actualPort);
            }
            console.log(`\n[multi-auth] Login for account "${alias}"`);
            console.log(`[multi-auth] Open this URL in your browser:\n`);
            console.log(`  ${activeFlow.url}\n`);
            console.log(`[multi-auth] Waiting for callback on port ${actualPort}...`);
            if (options?.callbackUrl) {
                void options.callbackUrl.then(async (callbackUrl) => {
                    if (finished || !activeFlow)
                        return;
                    try {
                        const account = await processCallback(callbackUrl);
                        finish(() => resolve(account));
                    }
                    catch (err) {
                        finish(() => reject(err));
                    }
                });
            }
        }
        catch (err) {
            finish(() => reject(err));
            return;
        }
        timeout = setTimeout(() => {
            finish(() => reject(new Error(`Login timeout after ${Math.round(timeoutMs / 1000)}s - no callback received`)));
        }, timeoutMs);
    });
}
export async function refreshToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account?.refreshToken) {
        console.error(`[multi-auth] No refresh token for ${alias}`);
        return null;
    }
    try {
        const tokenRes = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                refresh_token: account.refreshToken
            })
        });
        if (!tokenRes.ok) {
            console.error(`[multi-auth] Refresh failed for ${alias}: ${tokenRes.status}`);
            if (tokenRes.status === 401 || tokenRes.status === 403) {
                try {
                    updateAccount(alias, {
                        authInvalid: true,
                        authInvalidatedAt: Date.now()
                    });
                }
                catch {
                    // ignore
                }
            }
            return null;
        }
        const tokens = (await tokenRes.json());
        const accessClaims = decodeJwtPayload(tokens.access_token);
        const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
        const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || Date.now() + tokens.expires_in * 1000;
        const updates = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || account.refreshToken,
            expiresAt,
            lastRefresh: new Date().toISOString(),
            idToken: tokens.id_token || account.idToken,
            accountId: getAccountIdFromClaims(idClaims) ||
                getAccountIdFromClaims(accessClaims) ||
                account.accountId,
            planType: getPlanTypeFromClaims(idClaims) ||
                getPlanTypeFromClaims(accessClaims) ||
                account.planType
        };
        const updatedStore = updateAccount(alias, updates);
        clearAuthInvalid(alias);
        return updatedStore.accounts[alias];
    }
    catch (err) {
        console.error(`[multi-auth] Refresh error for ${alias}:`, err);
        return null;
    }
}
export async function ensureValidToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account)
        return null;
    const bufferMs = 5 * 60 * 1000;
    if (account.expiresAt < Date.now() + bufferMs) {
        console.log(`[multi-auth] Refreshing token for ${alias}`);
        const refreshed = await refreshToken(alias);
        return refreshed?.accessToken || null;
    }
    return account.accessToken;
}
//# sourceMappingURL=auth.js.map