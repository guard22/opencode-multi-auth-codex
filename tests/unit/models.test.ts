import {
  generateModelVariants,
  getDefaultModels
} from '../../src/models.js'

describe('model defaults', () => {
  it('exposes the GPT-5.6 family and reasoning variants', () => {
    const models = getDefaultModels()

    for (const id of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(models[id]).toEqual(
        expect.objectContaining({
          name: `${id} (OAuth)`,
          limit: { context: 1050000, input: 922000, output: 128000 },
          options: expect.objectContaining({ reasoningEffort: 'medium' })
        })
      )
      expect(models[`${id}-none`]).toBeDefined()
      expect(models[`${id}-xhigh`]).toBeDefined()
      expect(models[`${id}-max`]).toBeDefined()
    }

    expect(models['gpt-5.6-fast']?.options.service_tier).toBe('priority')
    expect(models['gpt-5.6-sol-fast']?.options.service_tier).toBe('priority')
    expect(models['gpt-5.6-terra-fast']).toBeUndefined()
    expect(models['gpt-5.6-luna-fast']).toBeUndefined()
  })

  it('exposes GPT-5.5 reasoning and fast variants', () => {
    const models = getDefaultModels()

    expect(models['gpt-5.5']).toEqual(
      expect.objectContaining({
        name: 'gpt-5.5 (OAuth)',
        limit: { context: 530000, input: 400000, output: 130000 },
        options: expect.objectContaining({
          reasoningEffort: 'medium'
        })
      })
    )
    expect(models['gpt-5.5']?.options).not.toHaveProperty('textVerbosity')
    expect(models['gpt-5.5-none']).toBeDefined()
    expect(models['gpt-5.5-low']).toBeDefined()
    expect(models['gpt-5.5-medium']).toBeDefined()
    expect(models['gpt-5.5-high']).toBeDefined()
    expect(models['gpt-5.5-xhigh']).toBeDefined()
    expect(models['gpt-5.5-fast']).toEqual(
      expect.objectContaining({
        limit: { context: 530000, input: 400000, output: 130000 },
        options: expect.objectContaining({
          service_tier: 'priority'
        })
      })
    )
  })

  it('builds fast variants for discovered GPT-5.5 models', () => {
    const models = generateModelVariants([
      {
        id: 'gpt-5.5',
        object: 'model',
        created: 0,
        owned_by: 'openai'
      }
    ])

    expect(models['gpt-5.5']?.limit.context).toBe(530000)
    expect(models['gpt-5.5']?.limit.input).toBe(400000)
    expect(models['gpt-5.5-fast']?.options.service_tier).toBe('priority')
    expect(models['gpt-5.5-medium']?.limit.context).toBe(530000)
  })

  it('builds max and fast variants for discovered GPT-5.6 Sol models', () => {
    const models = generateModelVariants([
      {
        id: 'gpt-5.6-sol',
        object: 'model',
        created: 0,
        owned_by: 'openai'
      }
    ])

    expect(models['gpt-5.6-sol']?.limit).toEqual({
      context: 1050000,
      input: 922000,
      output: 128000
    })
    expect(models['gpt-5.6-sol-max']?.options.reasoningEffort).toBe('max')
    expect(models['gpt-5.6-sol-fast']?.options.service_tier).toBe('priority')
  })
})
