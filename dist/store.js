import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'node:crypto';
import { hasMeaningfulRateLimits } from './rate-limits.js';
const STORE_DIR_ENV = 'OPENCODE_MULTI_AUTH_STORE_DIR';
const STORE_FILE_ENV = 'OPENCODE_MULTI_AUTH_STORE_FILE';
const DEFAULT_STORE_DIR = path.join(os.homedir(), '.config', 'opencode-multi-auth');
const DEFAULT_STORE_FILE = 'accounts.json';
function getStoreDir() {
    const override = process.env[STORE_DIR_ENV];
    if (override && override.trim())
        return path.resolve(override.trim());
    return DEFAULT_STORE_DIR;
}
function getStoreFile() {
    const override = process.env[STORE_FILE_ENV];
    if (override && override.trim())
        return path.resolve(override.trim());
    return path.join(getStoreDir(), DEFAULT_STORE_FILE);
}
const STORE_ENV_PASSPHRASE = 'CODEX_SOFT_STORE_PASSPHRASE';
const CURRENT_STORE_VERSION = 2;
let storeLocked = false;
let lastStoreError = null;
let lastStoreEncrypted = false;
let writeLock = false;
let writeLockQueue = [];
const FILE_LOCK_TIMEOUT_MS = 10_000;
const FILE_LOCK_SLEEP_MS = 25;
const fileLockSleep = new Int32Array(new SharedArrayBuffer(4));
const STORE_REVISION = Symbol('storeRevision');
let fileLockDepth = 0;
let fileLockPath = null;
let fileLockToken = null;
function getStoreRevision(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}
function getCurrentStoreRevision() {
    const file = getStoreFile();
    if (!fs.existsSync(file))
        return 'missing';
    return getStoreRevision(fs.readFileSync(file));
}
function trackStore(store, revision = getCurrentStoreRevision()) {
    Object.defineProperty(store, STORE_REVISION, {
        value: revision,
        writable: true,
        configurable: true
    });
    return store;
}
function ensureDir() {
    const dir = getStoreDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
function acquireFileLock() {
    if (fileLockDepth > 0) {
        throw new Error('Nested store mutations are not supported');
    }
    ensureDir();
    const lockPath = `${getStoreFile()}.lock`;
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    while (true) {
        try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            const token = crypto.randomUUID();
            try {
                fs.writeFileSync(path.join(lockPath, 'owner'), token, { mode: 0o600 });
            }
            catch (err) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw err;
            }
            fileLockDepth = 1;
            fileLockPath = lockPath;
            fileLockToken = token;
            return releaseFileLock;
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                throw err;
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for store lock: ${lockPath}. ` +
                    'If both services are stopped, remove this stale lock directory manually.');
            }
            Atomics.wait(fileLockSleep, 0, 0, FILE_LOCK_SLEEP_MS);
        }
    }
}
function releaseFileLock() {
    if (fileLockDepth === 0)
        return;
    fileLockDepth -= 1;
    if (fileLockDepth > 0)
        return;
    const lockPath = fileLockPath;
    const token = fileLockToken;
    fileLockPath = null;
    fileLockToken = null;
    if (!lockPath || !token)
        return;
    try {
        const owner = fs.readFileSync(path.join(lockPath, 'owner'), 'utf-8');
        if (owner === token) {
            fs.rmSync(lockPath, { recursive: true, force: true });
        }
    }
    catch {
        // Do not remove a lock whose ownership cannot be verified.
    }
}
function emptyStore() {
    return trackStore({
        version: CURRENT_STORE_VERSION,
        accounts: {},
        activeAlias: null,
        rotationIndex: 0,
        lastRotation: Date.now()
    });
}
function getPassphrase() {
    const value = process.env[STORE_ENV_PASSPHRASE];
    return value && value.trim().length > 0 ? value : null;
}
function isEncryptedFile(payload) {
    return Boolean(payload && payload.encrypted === true && typeof payload.data === 'string');
}
function deriveKey(passphrase, salt) {
    return crypto.scryptSync(passphrase, salt, 32);
}
function encryptStore(store, passphrase) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const serialized = JSON.stringify(store);
    const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        encrypted: true,
        version: CURRENT_STORE_VERSION,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64')
    };
}
function decryptStore(file, passphrase) {
    const salt = Buffer.from(file.salt, 'base64');
    const iv = Buffer.from(file.iv, 'base64');
    const tag = Buffer.from(file.tag, 'base64');
    const data = Buffer.from(file.data, 'base64');
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted);
}
function validateAccount(acc, alias) {
    if (!acc || typeof acc !== 'object')
        return null;
    if (typeof acc.accessToken !== 'string' || !acc.accessToken)
        return null;
    if (typeof acc.refreshToken !== 'string' || !acc.refreshToken)
        return null;
    if (typeof acc.expiresAt !== 'number')
        return null;
    const rateLimitHistory = Array.isArray(acc.rateLimitHistory)
        ? acc.rateLimitHistory.filter((entry) => hasMeaningfulRateLimits({ fiveHour: entry?.fiveHour, weekly: entry?.weekly }))
        : undefined;
    const rateLimits = hasMeaningfulRateLimits(acc.rateLimits) ? acc.rateLimits : undefined;
    return {
        alias,
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        idToken: typeof acc.idToken === 'string' ? acc.idToken : undefined,
        accountId: typeof acc.accountId === 'string' ? acc.accountId : undefined,
        accountUserId: typeof acc.accountUserId === 'string' ? acc.accountUserId : undefined,
        userId: typeof acc.userId === 'string' ? acc.userId : undefined,
        planType: typeof acc.planType === 'string' ? acc.planType : undefined,
        expiresAt: acc.expiresAt,
        email: typeof acc.email === 'string' ? acc.email : undefined,
        lastRefresh: typeof acc.lastRefresh === 'string' ? acc.lastRefresh : undefined,
        lastSeenAt: typeof acc.lastSeenAt === 'number' ? acc.lastSeenAt : undefined,
        lastActiveUntil: typeof acc.lastActiveUntil === 'number' ? acc.lastActiveUntil : undefined,
        lastUsed: typeof acc.lastUsed === 'number' ? acc.lastUsed : undefined,
        usageCount: typeof acc.usageCount === 'number' ? acc.usageCount : 0,
        rateLimitedUntil: typeof acc.rateLimitedUntil === 'number' ? acc.rateLimitedUntil : undefined,
        modelUnsupportedUntil: typeof acc.modelUnsupportedUntil === 'number' ? acc.modelUnsupportedUntil : undefined,
        modelUnsupportedAt: typeof acc.modelUnsupportedAt === 'number' ? acc.modelUnsupportedAt : undefined,
        modelUnsupportedModel: typeof acc.modelUnsupportedModel === 'string' ? acc.modelUnsupportedModel : undefined,
        modelUnsupportedError: typeof acc.modelUnsupportedError === 'string' ? acc.modelUnsupportedError : undefined,
        workspaceDeactivatedUntil: typeof acc.workspaceDeactivatedUntil === 'number' ? acc.workspaceDeactivatedUntil : undefined,
        workspaceDeactivatedAt: typeof acc.workspaceDeactivatedAt === 'number' ? acc.workspaceDeactivatedAt : undefined,
        workspaceDeactivatedError: typeof acc.workspaceDeactivatedError === 'string' ? acc.workspaceDeactivatedError : undefined,
        authInvalid: typeof acc.authInvalid === 'boolean' ? acc.authInvalid : undefined,
        authInvalidatedAt: typeof acc.authInvalidatedAt === 'number' ? acc.authInvalidatedAt : undefined,
        // Phase D: Account availability fields
        enabled: typeof acc.enabled === 'boolean' ? acc.enabled : undefined,
        disabledAt: typeof acc.disabledAt === 'number' ? acc.disabledAt : undefined,
        disabledBy: typeof acc.disabledBy === 'string' ? acc.disabledBy : undefined,
        disableReason: typeof acc.disableReason === 'string' ? acc.disableReason : undefined,
        rateLimits,
        rateLimitHistory: rateLimitHistory && rateLimitHistory.length > 0 ? rateLimitHistory : undefined,
        limitStatus: typeof acc.limitStatus === 'string' ? acc.limitStatus : undefined,
        limitError: typeof acc.limitError === 'string' ? acc.limitError : undefined,
        lastLimitProbeAt: typeof acc.lastLimitProbeAt === 'number' ? acc.lastLimitProbeAt : undefined,
        lastLimitErrorAt: typeof acc.lastLimitErrorAt === 'number' ? acc.lastLimitErrorAt : undefined,
        limitsConfidence: acc.limitsConfidence === 'fresh' ||
            acc.limitsConfidence === 'stale' ||
            acc.limitsConfidence === 'error' ||
            acc.limitsConfidence === 'unknown'
            ? acc.limitsConfidence
            : undefined,
        tags: Array.isArray(acc.tags) ? acc.tags : undefined,
        notes: typeof acc.notes === 'string' ? acc.notes : undefined,
        source: acc.source === 'opencode' || acc.source === 'codex' ? acc.source : undefined
    };
}
function validateStore(data) {
    if (!data || typeof data !== 'object')
        return null;
    const accounts = {};
    const rawAccounts = data.accounts;
    if (rawAccounts && typeof rawAccounts === 'object') {
        for (const [alias, acc] of Object.entries(rawAccounts)) {
            const validated = validateAccount(acc, alias);
            if (validated) {
                accounts[alias] = validated;
            }
        }
    }
    return trackStore({
        version: typeof data.version === 'number' ? data.version : undefined,
        accounts,
        activeAlias: typeof data.activeAlias === 'string' ? data.activeAlias : null,
        rotationIndex: typeof data.rotationIndex === 'number' ? data.rotationIndex : 0,
        lastRotation: typeof data.lastRotation === 'number' ? data.lastRotation : Date.now(),
        // Phase E: Preserve force mode fields
        forcedAlias: data.forcedAlias ?? null,
        forcedUntil: data.forcedUntil ?? null,
        previousRotationStrategy: data.previousRotationStrategy ?? null,
        forcedBy: data.forcedBy ?? null,
        // Phase F: Preserve rotation strategy and settings
        rotationStrategy: data.rotationStrategy ?? 'round-robin',
        settings: data.settings ?? undefined
    });
}
function migrateV1toV2(data) {
    return {
        ...data,
        version: 2,
        settings: {
            rotationStrategy: 'round-robin'
        },
        force: {
            forcedAlias: null,
            forcedUntil: null,
            previousRotationStrategy: null,
            forcedBy: null
        }
    };
}
function migrateStore(data) {
    if (!data || typeof data !== 'object')
        return null;
    const version = typeof data.version === 'number' ? data.version : 1;
    if (version > CURRENT_STORE_VERSION) {
        console.warn(`[multi-auth] Store version ${version} is newer than supported ${CURRENT_STORE_VERSION}. Proceeding with caution.`);
        return validateStore(data);
    }
    let migrated = data;
    if (version === 1) {
        migrated = migrateV1toV2(data);
        console.log('[multi-auth] Migrated store from v1 to v2');
    }
    return validateStore(migrated);
}
function getLastKnownGoodPath() {
    return `${getStoreFile()}.lkg`;
}
function saveLastKnownGood(store) {
    // Avoid writing plaintext snapshots when store encryption is enabled.
    if (getPassphrase()) {
        return;
    }
    const lkgPath = getLastKnownGoodPath();
    const tmpPath = `${lkgPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let fd = null;
    try {
        fd = fs.openSync(tmpPath, 'w', 0o600);
        fs.writeFileSync(fd, JSON.stringify(store, null, 2), { encoding: 'utf-8' });
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, lkgPath);
        const dirFd = fs.openSync(path.dirname(lkgPath), 'r');
        try {
            fs.fsyncSync(dirFd);
        }
        finally {
            fs.closeSync(dirFd);
        }
    }
    catch {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // ignore
            }
        }
        try {
            fs.rmSync(tmpPath, { force: true });
        }
        catch {
            // ignore
        }
    }
}
function loadLastKnownGood() {
    const lkgPath = getLastKnownGoodPath();
    if (!fs.existsSync(lkgPath))
        return null;
    try {
        const data = fs.readFileSync(lkgPath, 'utf-8');
        const parsed = JSON.parse(data);
        return validateStore(parsed);
    }
    catch {
        return null;
    }
}
async function acquireWriteLock() {
    if (!writeLock) {
        writeLock = true;
        return;
    }
    return new Promise((resolve) => {
        writeLockQueue.push(resolve);
    });
}
function releaseWriteLock() {
    const next = writeLockQueue.shift();
    if (next) {
        next();
    }
    else {
        writeLock = false;
    }
}
function buildSnapshot(window) {
    if (!window)
        return undefined;
    return {
        remaining: window.remaining,
        limit: window.limit,
        resetAt: window.resetAt
    };
}
function buildHistoryEntry(rateLimits) {
    if (!hasMeaningfulRateLimits(rateLimits))
        return null;
    const updatedAtValues = [rateLimits?.fiveHour?.updatedAt, rateLimits?.weekly?.updatedAt].filter((value) => typeof value === 'number');
    const at = updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : Date.now();
    return {
        at,
        fiveHour: buildSnapshot(rateLimits?.fiveHour),
        weekly: buildSnapshot(rateLimits?.weekly)
    };
}
function appendHistory(history, entry) {
    const next = history ? [...history] : [];
    const last = next[next.length - 1];
    const same = last &&
        last.fiveHour?.remaining === entry.fiveHour?.remaining &&
        last.weekly?.remaining === entry.weekly?.remaining &&
        last.fiveHour?.resetAt === entry.fiveHour?.resetAt &&
        last.weekly?.resetAt === entry.weekly?.resetAt;
    if (!same) {
        next.push(entry);
    }
    if (next.length > 160) {
        return next.slice(next.length - 160);
    }
    return next;
}
export function loadStore() {
    storeLocked = false;
    lastStoreError = null;
    lastStoreEncrypted = false;
    ensureDir();
    const file = getStoreFile();
    if (fs.existsSync(file)) {
        try {
            const data = fs.readFileSync(file, 'utf-8');
            const parsed = JSON.parse(data);
            if (isEncryptedFile(parsed)) {
                lastStoreEncrypted = true;
                const passphrase = getPassphrase();
                if (!passphrase) {
                    storeLocked = true;
                    lastStoreError = `Store is encrypted. Set ${STORE_ENV_PASSPHRASE} to unlock.`;
                    return emptyStore();
                }
                try {
                    const decrypted = decryptStore(parsed, passphrase);
                    const validated = validateStore(decrypted);
                    if (validated) {
                        return trackStore(validated, getStoreRevision(data));
                    }
                    storeLocked = true;
                    lastStoreError = 'Store validation failed after decryption.';
                    const lkg = loadLastKnownGood();
                    if (lkg) {
                        console.warn('[multi-auth] Restored from last-known-good snapshot');
                        return lkg;
                    }
                    return emptyStore();
                }
                catch (err) {
                    storeLocked = true;
                    lastStoreError = 'Failed to decrypt store. Check passphrase.';
                    console.error('[multi-auth] Failed to decrypt store:', err);
                    return emptyStore();
                }
            }
            const migrated = migrateStore(parsed);
            if (migrated) {
                return trackStore(migrated, getStoreRevision(data));
            }
            storeLocked = true;
            lastStoreError = 'Store validation failed.';
            console.error('[multi-auth] Store validation failed');
            const lkg = loadLastKnownGood();
            if (lkg) {
                console.warn('[multi-auth] Restored from last-known-good snapshot');
                return lkg;
            }
            return emptyStore();
        }
        catch (err) {
            storeLocked = true;
            lastStoreError = 'Failed to parse store. Store locked until fixed.';
            console.error('[multi-auth] Failed to parse store:', err);
            const lkg = loadLastKnownGood();
            if (lkg) {
                console.warn('[multi-auth] Restored from last-known-good snapshot');
                return lkg;
            }
        }
    }
    return emptyStore();
}
function saveStoreUnlocked(store) {
    ensureDir();
    if (storeLocked) {
        console.error('[multi-auth] Store locked; refusing to overwrite encrypted file.');
        return;
    }
    const file = getStoreFile();
    const passphrase = getPassphrase();
    const payload = passphrase ? encryptStore(store, passphrase) : store;
    const json = JSON.stringify(payload, null, 2);
    try {
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, `${file}.bak`);
            fs.chmodSync(`${file}.bak`, 0o600);
        }
    }
    catch {
        // ignore backup failures
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'w', 0o600);
        fs.writeFileSync(fd, json, { encoding: 'utf-8' });
        try {
            fs.fsyncSync(fd);
        }
        catch {
            // fsync not supported everywhere; best-effort
        }
    }
    finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // ignore
            }
        }
    }
    try {
        fs.renameSync(tmp, file);
    }
    catch (err) {
        if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
            try {
                fs.unlinkSync(file);
            }
            catch {
                // ignore
            }
            fs.renameSync(tmp, file);
        }
        else {
            try {
                fs.unlinkSync(tmp);
            }
            catch {
                // ignore
            }
            throw err;
        }
    }
    try {
        const dirFd = fs.openSync(getStoreDir(), 'r');
        try {
            fs.fsyncSync(dirFd);
        }
        catch {
            // ignore
        }
        fs.closeSync(dirFd);
    }
    catch {
        // ignore
    }
    try {
        fs.chmodSync(file, 0o600);
    }
    catch {
        // ignore
    }
    saveLastKnownGood(store);
    store[STORE_REVISION] = getStoreRevision(json);
}
export function saveStore(store) {
    const release = acquireFileLock();
    try {
        const expectedRevision = store[STORE_REVISION];
        if (expectedRevision === undefined) {
            throw new Error('Cannot save an untracked store; load it with loadStore() first');
        }
        if (expectedRevision !== getCurrentStoreRevision()) {
            throw new Error('Store changed since it was loaded; retry the mutation');
        }
        saveStoreUnlocked(store);
    }
    finally {
        release();
    }
}
export function mutateStore(mutator) {
    const release = acquireFileLock();
    try {
        const store = loadStore();
        const result = mutator(store);
        if (result && typeof result.then === 'function') {
            throw new Error('Store mutators must be synchronous');
        }
        saveStoreUnlocked(store);
        return { store, result };
    }
    finally {
        release();
    }
}
export async function withWriteLock(fn) {
    await acquireWriteLock();
    try {
        return fn();
    }
    finally {
        releaseWriteLock();
    }
}
export function getStoreDiagnostics() {
    return {
        storeDir: getStoreDir(),
        storeFile: getStoreFile(),
        locked: storeLocked,
        encrypted: lastStoreEncrypted,
        writeLocked: fs.existsSync(`${getStoreFile()}.lock`),
        error: lastStoreError
    };
}
export function addAccount(alias, creds) {
    return mutateStore((store) => {
        const entry = buildHistoryEntry(creds.rateLimits);
        store.accounts[alias] = {
            ...creds,
            alias,
            usageCount: 0,
            rateLimitHistory: entry ? [entry] : creds.rateLimitHistory
        };
        if (!store.activeAlias) {
            store.activeAlias = alias;
        }
    }).store;
}
export function removeAccount(alias) {
    return mutateStore((store) => {
        delete store.accounts[alias];
        if (store.activeAlias === alias) {
            const remaining = Object.keys(store.accounts);
            store.activeAlias = remaining[0] || null;
        }
    }).store;
}
export function updateAccount(alias, updates) {
    return mutateStore((store) => {
        updateAccountInStore(store, alias, updates);
    }).store;
}
export function updateAccountInStore(store, alias, updates) {
    if (store.accounts[alias]) {
        const current = store.accounts[alias];
        const next = { ...current, ...updates };
        if (updates.rateLimits || next.rateLimits) {
            const entry = buildHistoryEntry(next.rateLimits);
            if (entry) {
                next.rateLimitHistory = appendHistory(current.rateLimitHistory, entry);
            }
        }
        store.accounts[alias] = next;
    }
}
export function setActiveAlias(alias) {
    return mutateStore((store) => {
        const now = Date.now();
        const previousAlias = store.activeAlias;
        if (alias === null) {
            store.activeAlias = null;
        }
        else if (store.accounts[alias]) {
            if (previousAlias && previousAlias !== alias && store.accounts[previousAlias]) {
                store.accounts[previousAlias] = {
                    ...store.accounts[previousAlias],
                    lastActiveUntil: now
                };
            }
            store.activeAlias = alias;
            store.accounts[alias] = {
                ...store.accounts[alias],
                lastSeenAt: now,
                lastActiveUntil: undefined
            };
            const aliases = Object.keys(store.accounts);
            const idx = aliases.indexOf(alias);
            if (idx >= 0) {
                store.rotationIndex = idx;
            }
            store.lastRotation = now;
        }
    }).store;
}
export function getActiveAccount() {
    const store = loadStore();
    if (!store.activeAlias)
        return null;
    return store.accounts[store.activeAlias] || null;
}
export function listAccounts() {
    const store = loadStore();
    return Object.values(store.accounts);
}
export function getStorePath() {
    return getStoreFile();
}
export function getStoreStatus() {
    const diag = getStoreDiagnostics();
    return {
        locked: diag.locked,
        encrypted: diag.encrypted,
        writeLocked: diag.writeLocked,
        error: diag.error
    };
}
//# sourceMappingURL=store.js.map