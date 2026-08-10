import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { findLatestSessionRateLimits } from './sessions-limits.js';
import { loadStore, mutateStore, updateAccountInStore } from './store.js';
import { withAccountRefreshLock } from './token-refresh-lock.js';
const CODEX_HOME_ROOT = path.join(os.homedir(), '.codex-multi');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const DEFAULT_PROMPT = 'Reply ONLY with OK. Do not run any commands.';
const EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5-codex'];
const DEFAULT_PROBE_EFFORT = 'low';
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function decodeJwtPayload(token) {
    if (!token)
        return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    }
    catch {
        return null;
    }
}
function getEmailFromClaims(claims) {
    if (!claims)
        return undefined;
    if (typeof claims.email === 'string')
        return claims.email;
    const profile = claims['https://api.openai.com/profile'];
    if (typeof profile?.email === 'string')
        return profile.email;
    return undefined;
}
function getAuthClaim(claims) {
    if (!claims)
        return undefined;
    const auth = claims['https://api.openai.com/auth'];
    if (!auth || typeof auth !== 'object')
        return undefined;
    return auth;
}
function readProbeAuthTokens(codexHome) {
    const authPath = path.join(codexHome, 'auth.json');
    if (!fs.existsSync(authPath))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    }
    catch {
        return null;
    }
    const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : parsed;
    const accessToken = asString(tokens?.access_token ?? tokens?.accessToken ?? parsed?.access_token ?? parsed?.accessToken);
    const refreshToken = asString(tokens?.refresh_token ?? tokens?.refreshToken ?? parsed?.refresh_token ?? parsed?.refreshToken);
    const idToken = asString(tokens?.id_token ?? tokens?.idToken ?? parsed?.id_token ?? parsed?.idToken);
    const accountIdFromToken = asString(tokens?.account_id ?? tokens?.accountId ?? parsed?.account_id ?? parsed?.accountId);
    if (!accessToken && !refreshToken)
        return null;
    const accessClaims = decodeJwtPayload(accessToken);
    const idClaims = decodeJwtPayload(idToken);
    const authAccess = getAuthClaim(accessClaims);
    const authId = getAuthClaim(idClaims);
    const accountId = accountIdFromToken ||
        asString(authAccess?.chatgpt_account_id) ||
        asString(authId?.chatgpt_account_id);
    const accountUserId = asString(authAccess?.chatgpt_account_user_id) ||
        asString(authId?.chatgpt_account_user_id);
    const userId = asString(authAccess?.user_id) ||
        asString(authAccess?.chatgpt_user_id) ||
        asString(authId?.user_id) ||
        asString(authId?.chatgpt_user_id);
    const planType = asString(authAccess?.chatgpt_plan_type) ||
        asString(authId?.chatgpt_plan_type);
    const email = getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims);
    const exp = accessClaims?.exp ?? idClaims?.exp;
    const expiresAt = typeof exp === 'number' ? exp * 1000 : undefined;
    const lastRefresh = asString(parsed?.last_refresh ?? parsed?.lastRefresh);
    return {
        accessToken,
        refreshToken,
        idToken,
        accountId,
        accountUserId,
        userId,
        planType,
        email,
        expiresAt,
        lastRefresh
    };
}
export function syncAccountTokensFromProbeHome(alias, codexHome, expectedAccessToken, expectedRefreshToken) {
    const parsed = readProbeAuthTokens(codexHome);
    if (!parsed?.accessToken || !parsed.refreshToken)
        return undefined;
    let syncedAccessToken;
    mutateStore((store) => {
        const current = store.accounts[alias];
        if (!current ||
            current.accessToken !== expectedAccessToken ||
            current.refreshToken !== expectedRefreshToken) {
            return;
        }
        const tokenChanged = Boolean(current.accessToken !== parsed.accessToken ||
            current.refreshToken !== parsed.refreshToken ||
            (parsed.idToken && current.idToken !== parsed.idToken));
        const updates = {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            lastSeenAt: Date.now(),
            source: 'codex'
        };
        if (parsed.idToken)
            updates.idToken = parsed.idToken;
        if (parsed.accountId)
            updates.accountId = parsed.accountId;
        if (parsed.accountUserId)
            updates.accountUserId = parsed.accountUserId;
        if (parsed.userId)
            updates.userId = parsed.userId;
        if (parsed.planType)
            updates.planType = parsed.planType;
        if (parsed.email)
            updates.email = parsed.email;
        if (typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
            updates.expiresAt = parsed.expiresAt;
        }
        if (tokenChanged && parsed.lastRefresh)
            updates.lastRefresh = parsed.lastRefresh;
        updateAccountInStore(store, alias, updates);
        syncedAccessToken = parsed.accessToken;
    });
    return syncedAccessToken;
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
function sanitizeAlias(alias) {
    return alias.replace(/[^a-zA-Z0-9._-]/g, '_');
}
function getAliasHome(alias) {
    return path.join(CODEX_HOME_ROOT, sanitizeAlias(alias));
}
function writeAuthJson(dir, account) {
    if (!account.accessToken || !account.refreshToken) {
        throw new Error('Missing tokens for alias');
    }
    const tokens = {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        account_id: account.accountId
    };
    if (account.idToken) {
        tokens.id_token = account.idToken;
    }
    const auth = {
        OPENAI_API_KEY: null,
        tokens,
        last_refresh: new Date().toISOString()
    };
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
}
function copyConfigToml(dir) {
    if (!fs.existsSync(CODEX_CONFIG_PATH))
        return;
    const target = path.join(dir, 'config.toml');
    try {
        fs.copyFileSync(CODEX_CONFIG_PATH, target);
    }
    catch {
        // ignore config copy errors
    }
}
export function shouldRetryWithFallback(error) {
    if (!error)
        return false;
    const text = error.toLowerCase();
    return (text.includes('model_not_found') ||
        text.includes('model is not supported') ||
        text.includes('requested model') ||
        text.includes('does not exist') ||
        // Phase C: Handle reasoning.effort and unsupported_value errors
        text.includes('unsupported_value') ||
        text.includes('reasoning.effort') ||
        text.includes('reasoning effort'));
}
// Phase C: Get probe effort from environment or default to 'low'
export function getProbeEffort() {
    const envEffort = process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT;
    if (envEffort && ['low', 'medium', 'high'].includes(envEffort.toLowerCase())) {
        return envEffort.toLowerCase();
    }
    return DEFAULT_PROBE_EFFORT;
}
export function getProbeModels() {
    const raw = (process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS || '').trim();
    const fromEnv = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const candidates = fromEnv.length > 0 ? fromEnv : DEFAULT_PROBE_MODELS;
    return Array.from(new Set(candidates));
}
async function runCodexExec(codexHome, model, effort) {
    return new Promise((resolve) => {
        const args = [
            'exec',
            '--skip-git-repo-check',
            '--cd',
            codexHome,
            '--sandbox',
            'read-only'
        ];
        if (model) {
            args.push('-m', model);
        }
        // Phase C: Add reasoning effort configuration
        if (effort) {
            args.push('-c', `model_reasoning_effort="${effort}"`);
        }
        args.push(DEFAULT_PROMPT);
        let stderr = '';
        let stdout = '';
        const startTime = Date.now();
        const codexBin = process.env.CODEX_CLI_BIN?.trim() || 'codex';
        const child = spawn(codexBin, args, {
            env: { ...process.env, CODEX_HOME: codexHome },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            const durationMs = Date.now() - startTime;
            resolve({ ok: false, error: 'codex exec timed out', durationMs });
        }, EXEC_TIMEOUT_MS);
        child.stdout.on('data', (data) => {
            stdout += data.toString();
            if (stdout.length > 4000)
                stdout = stdout.slice(-4000);
        });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
            if (stderr.length > 4000)
                stderr = stderr.slice(-4000);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startTime;
            resolve({ ok: false, error: String(err), durationMs });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startTime;
            if (code === 0) {
                resolve({ ok: true, durationMs });
            }
            else {
                const message = stderr.trim() || stdout.trim() || `codex exec failed (code ${code})`;
                resolve({ ok: false, error: message, durationMs });
            }
        });
    });
}
async function runProbeInHome(codexHome) {
    const sessionsDir = path.join(codexHome, 'sessions');
    const probeModels = getProbeModels();
    const probeEffort = getProbeEffort();
    let lastError = 'No usable rate_limits data found in current Codex session output';
    const attemptErrors = [];
    for (let idx = 0; idx < probeModels.length; idx++) {
        const probeModel = probeModels[idx];
        const startedAt = Date.now();
        // Phase C: Pass effort config and track duration
        const execResult = await runCodexExec(codexHome, probeModel, probeEffort);
        const latest = findLatestSessionRateLimits({
            sessionsDir,
            sinceMs: startedAt - 5_000
        });
        // Phase C: Only accept authoritative data from successful completions
        if (execResult.ok && latest?.rateLimits) {
            return {
                rateLimits: latest.rateLimits,
                eventTs: latest.eventTs,
                sourceFile: latest.sourceFile,
                probeModel,
                probeEffort,
                probeDurationMs: execResult.durationMs,
                isAuthoritative: true
            };
        }
        if (execResult.error) {
            lastError = execResult.error;
            attemptErrors.push(`[model=${probeModel}, effort=${probeEffort}] ${execResult.error}`);
        }
        const hasNext = idx < probeModels.length - 1;
        if (!hasNext)
            break;
        // Phase C: Retry with fallback on unsupported_value / reasoning.effort errors
        if (shouldRetryWithFallback(execResult.error)) {
            // Try with 'low' effort explicitly if current effort failed
            if (probeEffort !== 'low' && execResult.error?.toLowerCase().includes('reasoning')) {
                const lowEffortResult = await runCodexExec(codexHome, probeModel, 'low');
                const lowEffortLatest = findLatestSessionRateLimits({
                    sessionsDir,
                    sinceMs: Date.now() - 5_000
                });
                if (lowEffortResult.ok && lowEffortLatest?.rateLimits) {
                    return {
                        rateLimits: lowEffortLatest.rateLimits,
                        eventTs: lowEffortLatest.eventTs,
                        sourceFile: lowEffortLatest.sourceFile,
                        probeModel,
                        probeEffort: 'low',
                        probeDurationMs: lowEffortResult.durationMs,
                        isAuthoritative: true
                    };
                }
                if (lowEffortResult.error) {
                    attemptErrors.push(`[model=${probeModel}, effort=low] ${lowEffortResult.error}`);
                }
            }
            continue;
        }
        // Don't retry if it's not a fallback-eligible error
        break;
    }
    if (attemptErrors.length > 0) {
        return {
            error: attemptErrors[attemptErrors.length - 1],
            isAuthoritative: false
        };
    }
    return {
        error: lastError,
        isAuthoritative: false
    };
}
async function probeRateLimitsWithCredentials(account) {
    const aliasHome = getAliasHome(account.alias);
    ensureDir(aliasHome);
    const codexHome = fs.mkdtempSync(path.join(aliasHome, 'probe-'));
    let result;
    let validatedAccessToken;
    try {
        writeAuthJson(codexHome, account);
        copyConfigToml(codexHome);
        result = await runProbeInHome(codexHome);
    }
    finally {
        try {
            validatedAccessToken = syncAccountTokensFromProbeHome(account.alias, codexHome, account.accessToken, account.refreshToken);
        }
        finally {
            fs.rmSync(codexHome, { recursive: true, force: true });
        }
    }
    if (result.isAuthoritative && validatedAccessToken) {
        result.validatedAccessToken = validatedAccessToken;
    }
    return result;
}
export async function probeRateLimitsForAccount(account) {
    try {
        return await withAccountRefreshLock(account.alias, async () => {
            const coordinatedAccount = loadStore().accounts[account.alias];
            if (!coordinatedAccount?.accessToken || !coordinatedAccount.refreshToken) {
                return {
                    isAuthoritative: false,
                    error: 'Account credentials unavailable after acquiring probe refresh lock'
                };
            }
            return probeRateLimitsWithCredentials(coordinatedAccount);
        });
    }
    catch (err) {
        return {
            isAuthoritative: false,
            error: `Probe refresh coordination failed: ${String(err)}`
        };
    }
}
export function getProbeHomeRoot() {
    return CODEX_HOME_ROOT;
}
//# sourceMappingURL=probe-limits.js.map