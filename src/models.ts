import type { OpenAIModel, ProviderModel } from './types.js'

const MODELS_ENDPOINT = 'https://api.openai.com/v1/models'

const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
type ReasoningLevel = typeof REASONING_LEVELS[number]

const MODEL_LIMITS: Record<string, { context: number; input?: number; output: number }> = {
  'gpt-5.5': { context: 530000, input: 400000, output: 130000 },
  'gpt-5.4': { context: 1050000, input: 922000, output: 128000 },
  'gpt-5.3': { context: 272000, output: 128000 },
  'gpt-5.3-codex-spark': { context: 272000, output: 128000 },
  'gpt-5.2': { context: 272000, output: 128000 },
  'gpt-5.3-codex': { context: 272000, output: 128000 },
  'gpt-5.2-codex': { context: 272000, output: 128000 },
  'gpt-5.1': { context: 272000, output: 128000 },
  'gpt-5.1-codex': { context: 272000, output: 128000 },
  'gpt-5.1-codex-max': { context: 272000, output: 128000 },
  'gpt-5.1-codex-mini': { context: 272000, output: 128000 },
}

function getModelLimits(modelId: string): { context: number; input?: number; output: number } {
  for (const [prefix, limits] of Object.entries(MODEL_LIMITS)) {
    if (modelId.startsWith(prefix)) return limits
  }
  return { context: 128000, output: 32000 }
}

function buildProviderModel(baseId: string, reasoning: ReasoningLevel): ProviderModel {
  const limits = getModelLimits(baseId)
  const displayName = `${baseId} ${reasoning.charAt(0).toUpperCase() + reasoning.slice(1)} (OAuth)`

  return {
    name: displayName,
    limit: limits,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    options: {
      reasoningEffort: reasoning,
      reasoningSummary: reasoning === 'high' || reasoning === 'xhigh' ? 'detailed' : 'auto',
      include: ['reasoning.encrypted_content'],
      store: false
    }
  }
}

function buildDefaultProviderModel(baseId: string): ProviderModel {
  return {
    ...buildProviderModel(baseId, 'medium'),
    name: `${baseId} (OAuth)`
  }
}

function supportsFastMode(baseId: string): boolean {
  return baseId === 'gpt-5.5' || baseId === 'gpt-5.4'
}

function buildFastProviderModel(baseId: string): ProviderModel {
  const limits = getModelLimits(baseId)

  return {
    name: `${baseId} Fast (OAuth)`,
    limit: limits,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    options: {
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
      store: false,
      service_tier: 'priority'
    }
  }
}

export async function fetchAvailableModels(token: string): Promise<OpenAIModel[]> {
  try {
    const res = await fetch(MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!res.ok) {
      console.error(`[multi-auth] Failed to fetch models: ${res.status}`)
      return []
    }

    const data = (await res.json()) as { data?: OpenAIModel[] }
    return data.data || []
  } catch (err) {
    console.error('[multi-auth] Error fetching models:', err)
    return []
  }
}

export function filterGPT5Models(models: OpenAIModel[]): OpenAIModel[] {
  return models.filter(m => m.id.match(/^gpt-5/))
}

export function generateModelVariants(baseModels: OpenAIModel[]): Record<string, ProviderModel> {
  const result: Record<string, ProviderModel> = {}

  for (const model of baseModels) {
    const baseId = model.id
    const isCodex = baseId.includes('codex')

    result[baseId] = buildDefaultProviderModel(baseId)

    const levels: ReasoningLevel[] = isCodex
      ? ['low', 'medium', 'high', 'xhigh']
      : ['none', 'low', 'medium', 'high', 'xhigh']

    for (const level of levels) {
      const variantId = `${baseId}-${level}`
      result[variantId] = buildProviderModel(baseId, level)
    }

    if (supportsFastMode(baseId)) {
      result[`${baseId}-fast`] = buildFastProviderModel(baseId)
    }
  }

  return result
}

export function getDefaultModels(): Record<string, ProviderModel> {
  const defaults = [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3',
    'gpt-5.3-codex-spark',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini'
  ]

  const result: Record<string, ProviderModel> = {}

  for (const baseId of defaults) {
    const isCodex = baseId.includes('codex')
    const levels: ReasoningLevel[] = isCodex
      ? ['low', 'medium', 'high', 'xhigh']
      : ['none', 'low', 'medium', 'high', 'xhigh']

    result[baseId] = buildDefaultProviderModel(baseId)

    for (const level of levels) {
      if (baseId === 'gpt-5.1-codex-mini' && !['medium', 'high'].includes(level)) continue
      if (baseId === 'gpt-5.1-codex' && level === 'xhigh') continue
      if (baseId === 'gpt-5.1' && level === 'xhigh') continue

      const variantId = `${baseId}-${level}`
      result[variantId] = buildProviderModel(baseId, level)
    }

    if (supportsFastMode(baseId)) {
      result[`${baseId}-fast`] = buildFastProviderModel(baseId)
    }
  }

  return result
}

let cachedModels: Record<string, ProviderModel> | null = null
let cacheExpiry = 0

export async function getModels(token?: string): Promise<Record<string, ProviderModel>> {
  const now = Date.now()
  const CACHE_TTL = 60 * 60 * 1000

  if (cachedModels && now < cacheExpiry) {
    return cachedModels
  }

  if (token) {
    const fetched = await fetchAvailableModels(token)
    const gpt5 = filterGPT5Models(fetched)

    if (gpt5.length > 0) {
      cachedModels = generateModelVariants(gpt5)
      cacheExpiry = now + CACHE_TTL
      return cachedModels
    }
  }

  cachedModels = getDefaultModels()
  cacheExpiry = now + CACHE_TTL
  return cachedModels
}
