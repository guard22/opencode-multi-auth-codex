import { loadStore, mutateStore } from './store.js';
import { logInfo, logError } from './logger.js';
import { DEFAULT_ROTATION_SETTINGS, WEIGHTED_PRESETS, validateSettings } from './types.js';
function resolveSettings(includeEnvOverrides) {
    const store = loadStore();
    // Start with defaults
    let settings = { ...DEFAULT_ROTATION_SETTINGS };
    let source = 'default';
    // Layer 1: Persisted settings from store
    if (store.settings) {
        settings = {
            ...settings,
            ...store.settings
        };
        source = 'persisted';
    }
    // Layer 2: Environment variables override (optional for runtime behavior)
    if (includeEnvOverrides) {
        const envStrategy = process.env.OPENCODE_MULTI_AUTH_ROTATION_STRATEGY;
        if (envStrategy && ['round-robin', 'least-used', 'random', 'weighted-round-robin'].includes(envStrategy)) {
            settings.rotationStrategy = envStrategy;
            source = 'env';
        }
        const envCriticalThreshold = process.env.OPENCODE_MULTI_AUTH_CRITICAL_THRESHOLD;
        if (envCriticalThreshold) {
            const parsed = parseFloat(envCriticalThreshold);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
                settings.criticalThreshold = parsed;
                source = 'env';
            }
        }
        const envLowThreshold = process.env.OPENCODE_MULTI_AUTH_LOW_THRESHOLD;
        if (envLowThreshold) {
            const parsed = parseFloat(envLowThreshold);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
                settings.lowThreshold = parsed;
                source = 'env';
            }
        }
        // Phase G: Feature flag environment overrides
        const envAntigravity = process.env.OPENCODE_MULTI_AUTH_ANTIGRAVITY_ENABLED;
        if (envAntigravity) {
            const enabled = envAntigravity.toLowerCase() === 'true' || envAntigravity === '1';
            settings.featureFlags = {
                ...(settings.featureFlags || {}),
                antigravityEnabled: enabled
            };
            source = 'env';
        }
    }
    // Validate final settings
    const errors = validateSettings(settings);
    if (errors.length > 0) {
        logError(`Settings validation errors: ${errors.map(e => e.message).join(', ')}`);
    }
    return { settings, source, errors: errors.length > 0 ? errors : undefined };
}
// Phase F: Get settings with proper precedence (including env overrides)
export function getSettings() {
    return resolveSettings(true);
}
// Runtime behavior should use persisted settings so dashboard changes take effect immediately.
export function getRuntimeSettings() {
    return resolveSettings(false);
}
// Phase F: Update settings with validation
export function updateSettings(updates, actor = 'system') {
    const current = getRuntimeSettings();
    // Merge updates with current settings
    const newSettings = {
        ...current.settings,
        ...updates,
        updatedAt: Date.now(),
        updatedBy: actor
    };
    // Validate new settings
    const errors = validateSettings(newSettings);
    if (errors.length > 0) {
        logError(`Settings update failed validation: ${errors.map(e => e.message).join(', ')}`);
        return { success: false, errors };
    }
    // Save to store
    mutateStore((store) => {
        store.settings = newSettings;
        // Keep legacy field in sync for force-mode compatibility.
        store.rotationStrategy = newSettings.rotationStrategy;
    });
    logInfo(`Settings updated by ${actor}: ${JSON.stringify(updates)}`);
    return { success: true, settings: newSettings };
}
// Phase F: Reset settings to defaults
export function resetSettings(actor = 'system') {
    mutateStore((store) => {
        delete store.settings;
        store.rotationStrategy = DEFAULT_ROTATION_SETTINGS.rotationStrategy;
    });
    logInfo(`Settings reset to defaults by ${actor}`);
    return { ...DEFAULT_ROTATION_SETTINGS };
}
// Phase F: Apply a preset
export function applyPreset(preset, actor = 'system') {
    const store = loadStore();
    const accounts = Object.keys(store.accounts);
    const presetConfig = WEIGHTED_PRESETS[preset];
    let accountWeights = {};
    if (preset === 'balanced') {
        // Equal weights for all accounts
        const weight = accounts.length > 0 ? 1 / accounts.length : 0;
        accounts.forEach(alias => {
            accountWeights[alias] = weight;
        });
    }
    else if (preset === 'conservative') {
        // Weights based on limit health
        accounts.forEach(alias => {
            const account = store.accounts[alias];
            const fiveHourRemaining = account.rateLimits?.fiveHour?.remaining ?? 50;
            const weeklyRemaining = account.rateLimits?.weekly?.remaining ?? 50;
            const health = (fiveHourRemaining + weeklyRemaining) / 2;
            accountWeights[alias] = health / 100;
        });
        // Normalize to sum to 1
        const total = Object.values(accountWeights).reduce((sum, w) => sum + w, 0);
        if (total > 0) {
            accounts.forEach(alias => {
                accountWeights[alias] = accountWeights[alias] / total;
            });
        }
    }
    else if (preset === 'aggressive') {
        // Favor accounts with high usage (lower remaining)
        accounts.forEach(alias => {
            const account = store.accounts[alias];
            const fiveHourRemaining = account.rateLimits?.fiveHour?.remaining ?? 50;
            const weeklyRemaining = account.rateLimits?.weekly?.remaining ?? 50;
            const health = (fiveHourRemaining + weeklyRemaining) / 2;
            // Inverse: lower health = higher weight
            accountWeights[alias] = (100 - health) / 100;
        });
        // Normalize to sum to 1
        const total = Object.values(accountWeights).reduce((sum, w) => sum + w, 0);
        if (total > 0) {
            accounts.forEach(alias => {
                accountWeights[alias] = accountWeights[alias] / total;
            });
        }
    }
    const updates = {
        rotationStrategy: 'weighted-round-robin',
        criticalThreshold: presetConfig.thresholds.critical,
        lowThreshold: presetConfig.thresholds.low,
        accountWeights
    };
    return updateSettings(updates, actor);
}
// Phase F: Calculate weighted selection
export function calculateWeightedSelection(aliases, weights) {
    if (aliases.length === 0)
        return null;
    // Filter to only available aliases
    const available = aliases.filter(alias => weights[alias] > 0);
    if (available.length === 0)
        return null;
    // Calculate total weight
    const totalWeight = available.reduce((sum, alias) => sum + (weights[alias] || 0), 0);
    if (totalWeight === 0)
        return null;
    // Weighted random selection
    let random = Math.random() * totalWeight;
    for (const alias of available) {
        random -= weights[alias] || 0;
        if (random <= 0) {
            return alias;
        }
    }
    // Fallback to last
    return available[available.length - 1];
}
// Phase F: Get settings with environment info
export function getSettingsWithInfo() {
    const result = getSettings();
    const store = loadStore();
    // Detect if using a preset
    let preset;
    if (result.settings.rotationStrategy === 'weighted-round-robin') {
        // Check if weights match a preset pattern
        for (const [presetName, config] of Object.entries(WEIGHTED_PRESETS)) {
            if (presetName !== 'custom' &&
                Math.abs(result.settings.criticalThreshold - config.thresholds.critical) < 0.01 &&
                Math.abs(result.settings.lowThreshold - config.thresholds.low) < 0.01) {
                preset = presetName;
                break;
            }
        }
    }
    return {
        settings: result.settings,
        source: result.source,
        preset,
        canReset: !!store.settings
    };
}
// Phase G: Check if a feature flag is enabled
export function isFeatureEnabled(flag) {
    const settings = getSettings();
    return settings.settings.featureFlags?.[flag] ?? false;
}
//# sourceMappingURL=settings.js.map