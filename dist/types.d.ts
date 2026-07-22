export interface AccountCredentials {
    alias: string;
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    accountId?: string;
    accountUserId?: string;
    userId?: string;
    planType?: string;
    expiresAt: number;
    email?: string;
    lastRefresh?: string;
    lastSeenAt?: number;
    lastActiveUntil?: number;
    lastUsed?: number;
    usageCount: number;
    rateLimitedUntil?: number;
    modelUnsupportedUntil?: number;
    modelUnsupportedAt?: number;
    modelUnsupportedModel?: string;
    modelUnsupportedError?: string;
    workspaceDeactivatedUntil?: number;
    workspaceDeactivatedAt?: number;
    workspaceDeactivatedError?: string;
    authInvalid?: boolean;
    authInvalidatedAt?: number;
    enabled?: boolean;
    disabledAt?: number;
    disabledBy?: string;
    disableReason?: string;
    rateLimits?: AccountRateLimits;
    rateLimitHistory?: RateLimitHistoryEntry[];
    limitStatus?: LimitStatus;
    limitError?: string;
    lastLimitProbeAt?: number;
    lastLimitErrorAt?: number;
    limitsConfidence?: LimitsConfidence;
    tags?: string[];
    notes?: string;
    source?: 'opencode' | 'codex';
}
export interface RateLimitWindow {
    limit?: number;
    remaining?: number;
    resetAt?: number;
    updatedAt?: number;
}
export interface AccountRateLimits {
    fiveHour?: RateLimitWindow;
    weekly?: RateLimitWindow;
}
export interface RateLimitSnapshot {
    remaining?: number;
    limit?: number;
    resetAt?: number;
}
export interface RateLimitHistoryEntry {
    at: number;
    fiveHour?: RateLimitSnapshot;
    weekly?: RateLimitSnapshot;
}
export type LimitStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'stopped';
export type LimitsConfidence = 'fresh' | 'stale' | 'error' | 'unknown';
export declare function calculateLimitsConfidence(lastProbeAt: number | undefined, lastErrorAt: number | undefined, limitStatus: LimitStatus | undefined): LimitsConfidence;
export interface AccountStore {
    version?: number;
    accounts: Record<string, AccountCredentials>;
    activeAlias: string | null;
    rotationIndex: number;
    lastRotation: number;
    forcedAlias?: string | null;
    forcedUntil?: number | null;
    previousRotationStrategy?: string | null;
    forcedBy?: string | null;
    rotationStrategy?: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin';
    settings?: RotationSettings;
}
export interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}
export interface PluginConfig {
    rotationStrategy: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin';
    autoRefreshTokens: boolean;
    rateLimitCooldownMs: number;
    modelUnsupportedCooldownMs: number;
    workspaceDeactivatedCooldownMs: number;
    modelFilter: RegExp;
}
export interface ProviderModel {
    name: string;
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    modalities: {
        input: string[];
        output: string[];
    };
    options: {
        reasoningEffort: string;
        reasoningSummary: string;
        include: string[];
        store: boolean;
        service_tier?: string;
    };
}
export declare const DEFAULT_CONFIG: PluginConfig;
export interface RotationSettings {
    rotationStrategy: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin';
    criticalThreshold: number;
    lowThreshold: number;
    accountWeights: Record<string, number>;
    featureFlags?: FeatureFlags;
    updatedAt?: number;
    updatedBy?: string;
}
export interface FeatureFlags {
    antigravityEnabled: boolean;
}
export declare const DEFAULT_FEATURE_FLAGS: FeatureFlags;
export type WeightPreset = 'balanced' | 'conservative' | 'aggressive' | 'custom';
export interface WeightedPresetConfig {
    name: WeightPreset;
    description: string;
    defaultWeights: Record<string, number>;
    thresholds: {
        critical: number;
        low: number;
    };
}
export declare const DEFAULT_ROTATION_SETTINGS: RotationSettings;
export declare const WEIGHTED_PRESETS: Record<WeightPreset, WeightedPresetConfig>;
export interface SettingsValidationError {
    field: string;
    message: string;
    constraint: string;
}
export declare function validateSettings(settings: Partial<RotationSettings>): SettingsValidationError[];
//# sourceMappingURL=types.d.ts.map