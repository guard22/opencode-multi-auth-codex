// Account credentials stored locally
export interface AccountCredentials {
  alias: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  accountUserId?: string
  userId?: string
  planType?: string
  expiresAt: number // Unix timestamp
  email?: string
  lastRefresh?: string
  lastSeenAt?: number
  lastActiveUntil?: number
  lastUsed?: number
  usageCount: number
  rateLimitedUntil?: number // If hit rate limit, when it resets
  // Some accounts don't have access to a given Codex model yet (staged rollout).
  // We temporarily skip them instead of hard-invalidating the account.
  modelUnsupportedUntil?: number
  modelUnsupportedAt?: number
  modelUnsupportedModel?: string
  modelUnsupportedError?: string
  // Some ChatGPT accounts can be in a deactivated workspace state (402 Payment Required,
  // detail.code = "deactivated_workspace"). Treat this as a temporary block and rotate.
  workspaceDeactivatedUntil?: number
  workspaceDeactivatedAt?: number
  workspaceDeactivatedError?: string
  authInvalid?: boolean
  authInvalidatedAt?: number
  // Phase D: Account availability fields
  enabled?: boolean // Defaults to true if not set
  disabledAt?: number
  disabledBy?: string
  disableReason?: string
  rateLimits?: AccountRateLimits
  rateLimitHistory?: RateLimitHistoryEntry[]
  limitStatus?: LimitStatus
  limitError?: string
  lastLimitProbeAt?: number
  lastLimitErrorAt?: number
  // Phase C: Freshness/confidence state
  limitsConfidence?: LimitsConfidence
  tags?: string[]
  notes?: string
  source?: 'opencode' | 'codex'
}

export interface RateLimitWindow {
  limit?: number
  remaining?: number
  resetAt?: number
  updatedAt?: number
}

export interface AccountRateLimits {
  fiveHour?: RateLimitWindow
  weekly?: RateLimitWindow
}

export interface RateLimitSnapshot {
  remaining?: number
  limit?: number
  resetAt?: number
}

export interface RateLimitHistoryEntry {
  at: number
  fiveHour?: RateLimitSnapshot
  weekly?: RateLimitSnapshot
}

export type LimitStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'stopped'

// Phase C: Freshness/confidence state for limits data
export type LimitsConfidence = 'fresh' | 'stale' | 'error' | 'unknown'

// Phase C: Calculate limits confidence based on probe timestamps
export function calculateLimitsConfidence(
  lastProbeAt: number | undefined,
  lastErrorAt: number | undefined,
  limitStatus: LimitStatus | undefined
): LimitsConfidence {
  const now = Date.now()
  const FRESH_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
  const STALE_THRESHOLD_MS = 60 * 60 * 1000 // 60 minutes
  
  // If we have an error more recent than last success, show error
  if (lastErrorAt && (!lastProbeAt || lastErrorAt > lastProbeAt)) {
    // If we have some successful data, show stale with error
    if (lastProbeAt && now - lastProbeAt < STALE_THRESHOLD_MS) {
      return 'error'
    }
  }
  
  // No successful probe ever
  if (!lastProbeAt) {
    return 'unknown'
  }
  
  const ageMs = now - lastProbeAt
  
  if (ageMs < FRESH_THRESHOLD_MS) {
    return 'fresh'
  } else if (ageMs < STALE_THRESHOLD_MS) {
    return 'stale'
  } else {
    // Data is too old, treat as unknown
    return 'unknown'
  }
}

// Local store for all accounts
export interface AccountStore {
  version?: number // Store version for migrations
  accounts: Record<string, AccountCredentials>
  activeAlias: string | null
  rotationIndex: number
  lastRotation: number
  // Phase E: Force mode fields
  forcedAlias?: string | null
  forcedUntil?: number | null
  previousRotationStrategy?: string | null
  forcedBy?: string | null
  rotationStrategy?: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin'
  // Phase F: Settings
  settings?: RotationSettings
}

// OpenAI model info
export interface OpenAIModel {
  id: string
  object: string
  created: number
  owned_by: string
}

// Plugin config
export interface PluginConfig {
  rotationStrategy: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin'
  autoRefreshTokens: boolean
  rateLimitCooldownMs: number // How long to skip rate-limited accounts
  modelUnsupportedCooldownMs: number // How long to skip accounts that don't support the requested model
  workspaceDeactivatedCooldownMs: number // How long to skip accounts with deactivated workspaces
  modelFilter: RegExp // Which models to expose
}

// OpenCode provider model definition
export interface ProviderModel {
  name: string
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities: {
    input: string[]
    output: string[]
  }
  options: {
    reasoningEffort: string
    reasoningSummary: string
    include: string[]
    store: boolean
    service_tier?: string
  }
}

export const DEFAULT_CONFIG: PluginConfig = {
  rotationStrategy: 'round-robin',
  autoRefreshTokens: true,
  rateLimitCooldownMs: 5 * 60 * 1000, // 5 minutes
  modelUnsupportedCooldownMs: 30 * 60 * 1000, // 30 minutes
  workspaceDeactivatedCooldownMs: 30 * 60 * 1000, // 30 minutes
  modelFilter: /^gpt-5/
}

// Phase F: Settings model for weighted rotation and thresholds
export interface RotationSettings {
  // Rotation strategy
  rotationStrategy: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin'
  
  // Rate limit thresholds (0-100)
  criticalThreshold: number // Account skipped below this (default: 10)
  lowThreshold: number      // Warning threshold (default: 30)
  
  // Account weights for weighted rotation (0-1, sum should be 1)
  accountWeights: Record<string, number>
  
  // Phase G: Feature flags
  featureFlags?: FeatureFlags
  
  // Last updated
  updatedAt?: number
  updatedBy?: string
}

// Phase G: Feature flags for non-core functionality
export interface FeatureFlags {
  // Antigravity integration (default: false)
  antigravityEnabled: boolean
}

// Phase G: Default feature flags
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  antigravityEnabled: false
}

// Phase F: Weighted rotation presets
export type WeightPreset = 'balanced' | 'conservative' | 'aggressive' | 'custom'

export interface WeightedPresetConfig {
  name: WeightPreset
  description: string
  defaultWeights: Record<string, number>
  thresholds: {
    critical: number
    low: number
  }
}

// Phase F: Default settings
export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  rotationStrategy: 'round-robin',
  criticalThreshold: 10,
  lowThreshold: 30,
  accountWeights: {},
  featureFlags: { ...DEFAULT_FEATURE_FLAGS }
}

// Phase F: Preset configurations
export const WEIGHTED_PRESETS: Record<WeightPreset, WeightedPresetConfig> = {
  balanced: {
    name: 'balanced',
    description: 'Equal distribution across all accounts',
    defaultWeights: {}, // Calculated dynamically as 1/n
    thresholds: { critical: 10, low: 30 }
  },
  conservative: {
    name: 'conservative',
    description: 'Prefer accounts with higher remaining limits',
    defaultWeights: {}, // Calculated based on limit health
    thresholds: { critical: 20, low: 40 }
  },
  aggressive: {
    name: 'aggressive',
    description: 'Maximize throughput, accept higher risk',
    defaultWeights: {}, // Favor accounts with high usage
    thresholds: { critical: 5, low: 20 }
  },
  custom: {
    name: 'custom',
    description: 'User-defined weights and thresholds',
    defaultWeights: {},
    thresholds: { critical: 10, low: 30 }
  }
}

// Phase F: Settings validation
export interface SettingsValidationError {
  field: string
  message: string
  constraint: string
}

export function validateSettings(settings: Partial<RotationSettings>): SettingsValidationError[] {
  const errors: SettingsValidationError[] = []
  
  // Validate thresholds are in 0-100 range
  if (settings.criticalThreshold !== undefined) {
    if (settings.criticalThreshold < 0 || settings.criticalThreshold > 100) {
      errors.push({
        field: 'criticalThreshold',
        message: 'Critical threshold must be between 0 and 100',
        constraint: '0 <= criticalThreshold <= 100'
      })
    }
  }
  
  if (settings.lowThreshold !== undefined) {
    if (settings.lowThreshold < 0 || settings.lowThreshold > 100) {
      errors.push({
        field: 'lowThreshold',
        message: 'Low threshold must be between 0 and 100',
        constraint: '0 <= lowThreshold <= 100'
      })
    }
  }
  
  // Validate critical < low
  if (settings.criticalThreshold !== undefined && settings.lowThreshold !== undefined) {
    if (settings.criticalThreshold >= settings.lowThreshold) {
      errors.push({
        field: 'thresholds',
        message: 'Critical threshold must be less than low threshold',
        constraint: 'criticalThreshold < lowThreshold'
      })
    }
  }
  
  // Validate weights are in (0, 1] range
  if (settings.accountWeights) {
    for (const [alias, weight] of Object.entries(settings.accountWeights)) {
      if (weight <= 0 || weight > 1) {
        errors.push({
          field: `accountWeights.${alias}`,
          message: `Weight for ${alias} must be between 0 and 1`,
          constraint: '0 < weight <= 1'
        })
      }
    }
    
    // Validate weights sum to approximately 1
    const totalWeight = Object.values(settings.accountWeights).reduce((sum, w) => sum + w, 0)
    if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.01) {
      errors.push({
        field: 'accountWeights',
        message: 'Total weights must sum to 1.0',
        constraint: 'sum(weights) ≈ 1.0'
      })
    }
  }
  
  return errors
}
