import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { calculateLimitsConfidence, type LimitsConfidence } from '../../src/types.js'
import { 
  shouldRetryWithFallback, 
  getProbeEffort, 
  getProbeModels,
  syncAccountTokensFromProbeHome,
  type ProbeResult 
} from '../../src/probe-limits.js'
import { addAccount, loadStore, updateAccount } from '../../src/store.js'

describe('Phase C: Limits Accuracy - Probe Authority', () => {
  describe('probe credential synchronization', () => {
    it('does not overwrite credentials rotated while a probe was running', () => {
      const originalEnv = process.env
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-probe-token-race-'))
      const codexHome = path.join(testDir, 'probe-home')
      fs.mkdirSync(codexHome, { recursive: true })
      process.env = {
        ...originalEnv,
        CODEX_SOFT_STORE_PASSPHRASE: '',
        OPENCODE_MULTI_AUTH_STORE_DIR: testDir,
        OPENCODE_MULTI_AUTH_STORE_FILE: path.join(testDir, 'accounts.json')
      }
      addAccount('probe-race', {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: Date.now() + 3_600_000
      })
      fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
        tokens: {
          access_token: 'probe-access-token',
          refresh_token: 'probe-refresh-token'
        }
      }))
      updateAccount('probe-race', {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token'
      })

      try {
        expect(syncAccountTokensFromProbeHome(
          'probe-race',
          codexHome,
          'old-access-token',
          'old-refresh-token'
        )).toBeUndefined()
        expect(loadStore().accounts['probe-race']).toEqual(expect.objectContaining({
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token'
        }))
      } finally {
        process.env = originalEnv
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe('calculateLimitsConfidence', () => {
    const now = Date.now()
    const fiveMinutesAgo = now - 5 * 60 * 1000
    const tenMinutesAgo = now - 10 * 60 * 1000
    const thirtyMinutesAgo = now - 30 * 60 * 1000
    const twoHoursAgo = now - 2 * 60 * 60 * 1000
    const twoHoursFromNow = now + 2 * 60 * 60 * 1000

    it('should return "fresh" when probe succeeded within 5 minutes', () => {
      const confidence = calculateLimitsConfidence(now, undefined, 'success')
      expect(confidence).toBe('fresh')
    })

    it('should return "stale" when probe succeeded 5-60 minutes ago', () => {
      const confidence = calculateLimitsConfidence(tenMinutesAgo, undefined, 'success')
      expect(confidence).toBe('stale')
    })

    it('should return "error" when last probe failed and < 60 min since success', () => {
      const confidence = calculateLimitsConfidence(tenMinutesAgo, now, 'error')
      expect(confidence).toBe('error')
    })

    it('should return "unknown" when no successful probe ever', () => {
      const confidence = calculateLimitsConfidence(undefined, undefined, 'idle')
      expect(confidence).toBe('unknown')
    })

    it('should return "unknown" when last success > 60 minutes ago', () => {
      const confidence = calculateLimitsConfidence(twoHoursAgo, undefined, 'success')
      expect(confidence).toBe('unknown')
    })

    it('should return "unknown" when error is more recent than success', () => {
      const confidence = calculateLimitsConfidence(twoHoursAgo, thirtyMinutesAgo, 'error')
      expect(confidence).toBe('unknown')
    })

    it('should return "stale" when data is 30 minutes old', () => {
      const confidence = calculateLimitsConfidence(thirtyMinutesAgo, undefined, 'success')
      expect(confidence).toBe('stale')
    })
  })

  describe('shouldRetryWithFallback', () => {
    it('should return false for null error', () => {
      expect(shouldRetryWithFallback(null as any)).toBe(false)
      expect(shouldRetryWithFallback(undefined)).toBe(false)
    })

    it('should return true for model_not_found error', () => {
      expect(shouldRetryWithFallback('model_not_found')).toBe(true)
    })

    it('should return true for unsupported_value error', () => {
      expect(shouldRetryWithFallback('unsupported_value')).toBe(true)
      expect(shouldRetryWithFallback('UNSUPPORTED_VALUE')).toBe(true)
    })

    it('should return true for reasoning.effort error', () => {
      expect(shouldRetryWithFallback('reasoning.effort not supported')).toBe(true)
      expect(shouldRetryWithFallback('REASONING.EFFORT error')).toBe(true)
    })

    it('should return true for reasoning effort error', () => {
      expect(shouldRetryWithFallback('reasoning effort')).toBe(true)
    })

    it('should return true for model is not supported error', () => {
      expect(shouldRetryWithFallback('model is not supported')).toBe(true)
    })

    it('should return false for auth error', () => {
      expect(shouldRetryWithFallback('unauthorized')).toBe(false)
    })
  })

  describe('getProbeEffort', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should return "low" by default', () => {
      expect(getProbeEffort()).toBe('low')
    })

    it('should return environment value when set to "low"', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = 'low'
      expect(getProbeEffort()).toBe('low')
    })

    it('should return environment value when set to "medium"', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = 'medium'
      expect(getProbeEffort()).toBe('medium')
    })

    it('should return environment value when set to "high"', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = 'high'
      expect(getProbeEffort()).toBe('high')
    })

    it('should handle uppercase environment values', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = 'HIGH'
      expect(getProbeEffort()).toBe('high')
    })

    it('should return default for invalid values', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = 'invalid'
      expect(getProbeEffort()).toBe('low')
    })

    it('should return default for empty string', () => {
      process.env.OPENCODE_MULTI_AUTH_PROBE_EFFORT = ''
      expect(getProbeEffort()).toBe('low')
    })
  })

  describe('getProbeModels', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should prefer gpt-5.5 first in default list', () => {
      const models = getProbeModels()
      expect(models[0]).toBe('gpt-5.5')
      expect(models).toContain('gpt-5.4')
      expect(models).toContain('gpt-5.3-codex')
      expect(models).toContain('gpt-5.2-codex')
      expect(models).toContain('gpt-5-codex')
    })

    it('should use environment variable when set', () => {
      process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS = 'custom-model-1,custom-model-2'
      const models = getProbeModels()
      expect(models).toEqual(['custom-model-1', 'custom-model-2'])
    })

    it('should trim whitespace from environment models', () => {
      process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS = ' model1 , model2 '
      const models = getProbeModels()
      expect(models).toEqual(['model1', 'model2'])
    })

    it('should remove duplicates', () => {
      process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS = 'model1,model1,model2'
      const models = getProbeModels()
      expect(models).toEqual(['model1', 'model2'])
    })

    it('should filter empty strings', () => {
      process.env.OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS = 'model1,,model2'
      const models = getProbeModels()
      expect(models).toEqual(['model1', 'model2'])
    })
  })
})
