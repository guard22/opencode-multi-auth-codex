import { loadStore, mutateStore } from './store.js';
const FORCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ROTATION_STRATEGIES = new Set([
    'round-robin',
    'least-used',
    'random',
    'weighted-round-robin'
]);
function isRotationStrategy(value) {
    return typeof value === 'string' && ROTATION_STRATEGIES.has(value);
}
export function getForceState() {
    const store = loadStore();
    return {
        forcedAlias: store.forcedAlias ?? null,
        forcedUntil: store.forcedUntil ?? null,
        previousRotationStrategy: store.previousRotationStrategy ?? null,
        forcedBy: store.forcedBy ?? null
    };
}
export function isForceActive() {
    const state = getForceState();
    if (!state.forcedAlias || !state.forcedUntil) {
        return false;
    }
    const now = Date.now();
    if (now > state.forcedUntil) {
        return false;
    }
    // Check if forced alias still exists and is eligible
    const store = loadStore();
    const forcedAccount = store.accounts[state.forcedAlias];
    if (!forcedAccount) {
        return false;
    }
    // Check if account is disabled
    if (forcedAccount.enabled === false) {
        return false;
    }
    return true;
}
export function activateForce(alias, actor = 'system') {
    return mutateStore((store) => {
        if (!store.accounts[alias]) {
            return { success: false, error: `Account '${alias}' not found` };
        }
        if (store.accounts[alias].enabled === false) {
            return { success: false, error: `Account '${alias}' is disabled` };
        }
        const now = Date.now();
        const keepExistingTtl = store.forcedAlias === alias &&
            typeof store.forcedUntil === 'number' &&
            store.forcedUntil > now;
        const forcedUntil = keepExistingTtl ? store.forcedUntil : now + FORCE_TTL_MS;
        const currentStrategy = store.settings?.rotationStrategy ||
            store.rotationStrategy ||
            'round-robin';
        const previousStrategy = (store.forcedAlias ? store.previousRotationStrategy : currentStrategy) ?? null;
        store.forcedAlias = alias;
        store.forcedUntil = forcedUntil;
        store.previousRotationStrategy = previousStrategy;
        store.forcedBy = actor;
        return {
            success: true,
            state: {
                forcedAlias: alias,
                forcedUntil,
                previousRotationStrategy: previousStrategy,
                forcedBy: actor
            }
        };
    }).result;
}
export function clearForce() {
    return mutateStore((store) => {
        const restoredStrategy = store.previousRotationStrategy;
        const currentStrategy = store.settings?.rotationStrategy ||
            store.rotationStrategy ||
            'round-robin';
        const nextStrategy = isRotationStrategy(restoredStrategy)
            ? restoredStrategy
            : currentStrategy;
        store.forcedAlias = null;
        store.forcedUntil = null;
        store.rotationStrategy = nextStrategy;
        store.previousRotationStrategy = null;
        store.forcedBy = null;
        if (store.settings) {
            store.settings = {
                ...store.settings,
                rotationStrategy: nextStrategy
            };
        }
        return { success: true, restoredStrategy };
    }).result;
}
export function checkAndAutoClearForce() {
    const state = getForceState();
    if (!state.forcedAlias) {
        return { wasCleared: false };
    }
    const store = loadStore();
    const now = Date.now();
    // Check expiry
    if (state.forcedUntil && now > state.forcedUntil) {
        clearForce();
        return { wasCleared: true, reason: 'expired' };
    }
    // Check if alias still exists
    if (!store.accounts[state.forcedAlias]) {
        clearForce();
        return { wasCleared: true, reason: 'account_removed' };
    }
    // Check if alias is disabled
    if (store.accounts[state.forcedAlias].enabled === false) {
        clearForce();
        return { wasCleared: true, reason: 'account_disabled' };
    }
    return { wasCleared: false };
}
export function getRemainingForceTimeMs() {
    const state = getForceState();
    if (!state.forcedUntil) {
        return 0;
    }
    const remaining = state.forcedUntil - Date.now();
    return Math.max(0, remaining);
}
export function formatForceDuration(ms) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}
//# sourceMappingURL=force-mode.js.map