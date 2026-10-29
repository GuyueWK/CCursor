import type { ProviderModel, ProvidersConfig } from '../data/defaults'
import { expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { isModelDefaultOn } from '../data/defaults'
import { buildByokAvailableModels } from '../handlers/models/byokModelBuilder'
import { DEFAULT_MODEL_SEED_DATE, handleGetDefaultModel, handleGetDefaultModelNudgeData } from '../services/core/AiService'

/**
 * defaultOn 的判定口径 — AvailableModels 与 GetDefaultModel 必须一致。
 *
 * 回归点: GetDefaultModel 曾用 `defaultOn !== false` 挑候选,
 * 而 byokModelBuilder 下发 AvailableModel.defaultOn 用 `?? false`。
 * 于是没写 defaultOn 的模型在选择器里是关闭状态,却会被推成默认模型。
 */

function model(id: string, extra: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id,
    apiModel: id,
    displayName: id,
    thinking: false,
    contextTokenLimit: 200000,
    ...extra,
  }
}

function useProviders(models: ProviderModel[]): void {
  const config: ProvidersConfig = {
    $schemaVersion: 1,
    providers: [
      {
        id: 'p1',
        name: 'P1',
        type: 'anthropic',
        baseUrl: '',
        auth: { kind: 'apiKey', value: 'test-key' },
        models,
      },
    ],
  }
  setProvidersForTests(config)
}

it('treats a missing defaultOn as off', () => {
  expect(isModelDefaultOn(model('a'))).toBe(false)
  expect(isModelDefaultOn(model('b', { defaultOn: false }))).toBe(false)
  expect(isModelDefaultOn(model('c', { defaultOn: true }))).toBe(true)
})

it('does not push a default model when none is enabled', async () => {
  useProviders([model('no-flag'), model('explicitly-off', { defaultOn: false })])

  // 没有任何启用模型 → 返回空,客户端保留上次选择
  expect(await handleGetDefaultModel()).toEqual({})
})

it('picks the first enabled model, and the first enabled thinking model', async () => {
  useProviders([
    model('off-but-first'),
    model('enabled-plain', { defaultOn: true }),
    model('enabled-thinking', { defaultOn: true, thinking: true }),
  ])

  const res = await handleGetDefaultModel() as Record<string, unknown>

  expect(res.model).toBe('enabled-plain')
  expect(res.thinkingModel).toBe('enabled-thinking')
  expect(res.nextDefaultSetDate).toBe(DEFAULT_MODEL_SEED_DATE)
})

it('does not advance the seed date, so a refresh cannot overwrite the last selection', async () => {
  useProviders([
    model('first-enabled', { defaultOn: true }),
    model('recently-used', { defaultOn: true }),
  ])

  const first = await handleGetDefaultModel() as Record<string, unknown>
  const second = await handleGetDefaultModel() as Record<string, unknown>

  expect(first.nextDefaultSetDate).toBe(DEFAULT_MODEL_SEED_DATE)
  expect(second.nextDefaultSetDate).toBe(first.nextDefaultSetDate)
  expect(Number(first.nextDefaultSetDate)).toBeLessThan(Date.now())
})

it('does not ask the client to switch back to default on a new chat', async () => {
  useProviders([
    model('off', { defaultOn: false }),
    model('recently-used', { defaultOn: true }),
  ])

  const nudge = await handleGetDefaultModelNudgeData()

  expect(nudge.nudgeDate).toBe('0')
  expect(nudge.shouldDefaultSwitchOnNewChat).toBe(false)
  expect(nudge.modelsWithNoDefaultSwitch).toEqual(['off', 'recently-used'])
})

it('never pushes a model that AvailableModels reports as off', async () => {
  useProviders([
    model('no-flag'),
    model('explicitly-off', { defaultOn: false }),
    model('enabled', { defaultOn: true }),
  ])

  const pushed = (await handleGetDefaultModel() as Record<string, unknown>).model
  const offInPicker = buildByokAvailableModels()
    .filter(m => !m.defaultOn)
    .map(m => m.name)

  expect(offInPicker).toEqual(['no-flag', 'explicitly-off'])
  expect(offInPicker).not.toContain(pushed)
})
