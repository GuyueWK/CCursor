import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AvailableModelsResponse_AvailableModelSchema } from '../gen/aiserver_v1_pb'
import {
  buildByokAvailableModels,
  buildClassifierFallbackStubModels,
  toHiddenClassifierStubModel,
} from '../handlers/models/byokModelBuilder'
import { installTestProviders } from './setup'

// Regression test for "Auto-review greyed out under BYOK ON":
// the renderer gates the option on
//   modelConfigService.hasSmartModeClassifierModel()
//     === availableModels.some(m => m.supportsSmartModeClassifier === true)
// (proto field 45), not on model names. Every model we serve must carry it.

describe('supportsSmartModeClassifier flag', () => {
  it('marks every BYOK model as classifier-capable', () => {
    installTestProviders()
    const models = buildByokAvailableModels()
    expect(models.length).toBeGreaterThan(0)
    for (const model of models)
      expect(model.supportsSmartModeClassifier).toBe(true)
  })

  it('marks fallback stubs as classifier-capable', () => {
    const stubs = buildClassifierFallbackStubModels()
    expect(stubs.length).toBeGreaterThan(0)
    for (const stub of stubs) {
      expect(stub.supportsSmartModeClassifier).toBe(true)
      // Stubs must stay out of the Agent picker.
      expect(stub.supportsAgent).toBe(false)
      expect(stub.defaultOn).toBe(false)
    }
  })

  it('preserves the upstream flag when converting to a hidden stub', () => {
    const upstream = create(AvailableModelsResponse_AvailableModelSchema, {
      name: 'claude-4.5-haiku',
      defaultOn: true,
      supportsAgent: true,
      supportsSmartModeClassifier: true,
      clientDisplayName: 'Claude 4.5 Haiku',
      serverModelName: 'claude-4.5-haiku',
      parameterDefinitions: [],
      variants: [],
    })
    const stub = toHiddenClassifierStubModel(upstream)
    expect(stub.supportsSmartModeClassifier).toBe(true)
    expect(stub.supportsAgent).toBe(false)
    expect(stub.name).toBe('claude-4.5-haiku')
  })

  it('defaults the flag to true when upstream omits it', () => {
    const upstream = create(AvailableModelsResponse_AvailableModelSchema, {
      name: 'gpt-5.4-mini',
      defaultOn: false,
      parameterDefinitions: [],
      variants: [],
    })
    expect(upstream.supportsSmartModeClassifier).toBeUndefined()
    const stub = toHiddenClassifierStubModel(upstream)
    expect(stub.supportsSmartModeClassifier).toBe(true)
  })
})
