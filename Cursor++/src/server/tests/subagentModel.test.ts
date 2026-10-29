import type { ProvidersConfig } from '../data/defaults'
import type { ParsedCustomSubagent } from '../handlers/agent/protocol/types'
import { afterEach, describe, expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { resolveSubagentModel } from '../handlers/agent/toolRuntime'

function makeSubagent(name: string, model: string, extra?: Partial<ParsedCustomSubagent>): ParsedCustomSubagent {
  return {
    fullPath: `/workspace/.cursor/agents/${name}.md`,
    name,
    description: `${name} description`,
    tools: [],
    model,
    prompt: 'prompt',
    permissionMode: 'default',
    isBackground: false,
    forceDefaultModel: false,
    raw: {},
    ...extra,
  }
}

const TEST_PROVIDERS_WITH_DEFAULT: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [{
    id: 'alias-test',
    name: 'Alias Test',
    type: 'anthropic',
    baseUrl: '',
    auth: { kind: 'apiKey', value: 'test-key' },
    models: [
      {
        id: 'parent-model',
        apiModel: 'parent-api',
        displayName: 'Parent',
        thinking: false,
        defaultOn: false,
        contextTokenLimit: 200000,
      },
      {
        id: 'md-model',
        apiModel: 'md-api',
        displayName: 'Md Model',
        thinking: false,
        defaultOn: false,
        contextTokenLimit: 200000,
      },
      {
        id: 'default-model',
        apiModel: 'default-api',
        displayName: 'Default',
        thinking: false,
        defaultOn: true,
        contextTokenLimit: 200000,
      },
    ],
  }],
}

function restoreSharedProviders(): void {
  setProvidersForTests({
    $schemaVersion: 1,
    providers: [{
      id: 'restored',
      name: 'Restored',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [{
        id: 'claude-sonnet-4',
        apiModel: 'claude-sonnet-4',
        displayName: 'Claude Sonnet 4',
        thinking: false,
        contextTokenLimit: 200000,
      }],
    }],
  })
}

describe('resolveSubagentModel with .md fallback', () => {
  afterEach(restoreSharedProviders)

  it('prefers Settings override over .md model', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    const result = resolveSubagentModel(
      'implementer',
      'parent-model',
      [{ subagentType: 'implementer', selection: { case: 'model', modelId: 'default-model' } }],
      [makeSubagent('implementer', 'md-model')],
    )
    expect(result).toBe('default-model')
  })

  it('uses .md model when no override exists', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    const result = resolveSubagentModel('implementer', 'parent-model', [], [makeSubagent('implementer', 'md-model')])
    expect(result).toBe('md-model')
  })

  it('inherits parent for empty / inherit placeholders', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    for (const placeholder of ['', '  ', 'inherit', 'INHERIT']) {
      const result = resolveSubagentModel('implementer', 'parent-model', [], [makeSubagent('implementer', placeholder)])
      expect(result).toBe('parent-model')
    }
    // .md 里根本没有这个子代理定义时同样继承
    expect(resolveSubagentModel('implementer', 'parent-model', [], [])).toBe('parent-model')
  })

  it('falls back to parent when .md model is not registered', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    const result = resolveSubagentModel(
      'implementer',
      'parent-model',
      [],
      [makeSubagent('implementer', 'composer-2-fast')],
    )
    expect(result).toBe('parent-model')
  })

  it('resolves default alias in .md through providers.json', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    const result = resolveSubagentModel('implementer', 'parent-model', [], [makeSubagent('implementer', 'default')])
    expect(result).toBe('default-model')
  })

  it('honors forceDefaultModel when no explicit override exists', () => {
    setProvidersForTests(TEST_PROVIDERS_WITH_DEFAULT)
    const result = resolveSubagentModel(
      'implementer',
      'parent-model',
      [],
      [makeSubagent('implementer', '', { forceDefaultModel: true })],
    )
    expect(result).toBe('default-model')
  })
})
