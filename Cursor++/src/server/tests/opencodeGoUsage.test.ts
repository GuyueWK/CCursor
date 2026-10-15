import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetProvidersCacheForTests, setProvidersForTests } from '../config/providersStore'
import { buildZenUsageUrl, formatGoUsageDisplay, getActiveGoUsageProvider, getGoUsageDisplayMessage, GO_USAGE_FALLBACK_MESSAGE, isOpencodeGoProvider, normalizeGoApiKey, parseZenUsagePayload, recordGoUsageModelSeen, refreshGoUsageAfterConversation, resetGoUsageCacheForTests } from '../services/account/opencodeGoUsage'

function makeGoProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'go',
    name: 'opencode-go',
    type: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    auth: { kind: 'apiKey', value: 'sk-go-test' },
    models: [
      {
        id: 'go-model',
        apiModel: 'opencode/go-model',
        displayName: 'Go Model',
        thinking: false,
        defaultOn: true,
      },
    ],
    ...overrides,
  }
}

function makePlainProvider() {
  return {
    id: 'plain',
    name: 'plain',
    type: 'openai-chat',
    baseUrl: 'https://example.com',
    auth: { kind: 'apiKey', value: 'sk-x' },
    models: [
      {
        id: 'plain-model',
        apiModel: 'plain-model',
        displayName: 'Plain Model',
        thinking: false,
        defaultOn: false,
      },
    ],
  }
}

describe('opencodeGoUsage (zen)', () => {
  beforeEach(() => {
    resetGoUsageCacheForTests()
    resetProvidersCacheForTests()
  })

  it('parses rolling/weekly/monthly from zen usage payload', () => {
    const resetsAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const snapshot = parseZenUsagePayload({
      usage: {
        rolling: { status: 'ok', percent: 42, resetsAt },
        weekly: { status: 'ok', percent: 18, resetsAt },
        monthly: { status: 'ok', percent: 9, resetsAt },
      },
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.rolling.percent).toBe(42)
    expect(snapshot?.weekly.percent).toBe(18)
    expect(snapshot?.monthly.percent).toBe(9)
    expect(snapshot?.rolling.resetInSec).toBeGreaterThan(3000)
  })

  it('returns null when usage shape is unknown (fallback to unlimited)', () => {
    expect(parseZenUsagePayload({ hello: 'world' })).toBeNull()
    expect(parseZenUsagePayload(null)).toBeNull()
  })

  it('formats chat slot message with reset durations', () => {
    const text = formatGoUsageDisplay({
      rolling: { percent: 42, resetInSec: 4860 },
      weekly: { percent: 18, resetInSec: 126983 },
      monthly: { percent: 9 },
      fetchedAt: new Date().toISOString(),
    })
    expect(text).toContain('Go 5h 42%')
    expect(text).toContain('Week 18%')
    expect(text).toContain('Month 9%')
    expect(text).toContain('1h21m')
  })

  it('detects opencode go providers by baseUrl', () => {
    expect(isOpencodeGoProvider(makeGoProvider() as never)).toBe(true)
    expect(isOpencodeGoProvider(makePlainProvider() as never)).toBe(false)
    expect(isOpencodeGoProvider(null)).toBe(false)
  })

  it('derives usage url from provider baseUrl', () => {
    expect(buildZenUsageUrl(makeGoProvider() as never)).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(buildZenUsageUrl(makeGoProvider({ baseUrl: 'https://opencode.ai/zen/go/' }) as never))
      .toBe('https://opencode.ai/zen/go/v1/usage')
    expect(buildZenUsageUrl(makePlainProvider() as never)).toBe('https://opencode.ai/zen/go/v1/usage')
  })

  it('normalizeGoApiKey strips bearer prefix, quotes and whitespace', () => {
    expect(normalizeGoApiKey('Bearer sk-abc')).toBe('sk-abc')
    expect(normalizeGoApiKey('"sk-abc"')).toBe('sk-abc')
    expect(normalizeGoApiKey('  sk-ab\nc  ')).toBe('sk-abc')
    expect(normalizeGoApiKey(123)).toBe('')
  })

  it('uses default model provider when nothing has been chatted yet', () => {
    setProvidersForTests({
      $schemaVersion: 1,
      providers: [makePlainProvider(), makeGoProvider()] as never,
    })
    expect(getActiveGoUsageProvider()?.id).toBe('go')
  })

  it('returns null when default model is a non-opencode provider', () => {
    setProvidersForTests({
      $schemaVersion: 1,
      providers: [
        {
          ...makePlainProvider(),
          models: [{ id: 'plain-model', apiModel: 'plain', displayName: 'Plain', thinking: false, defaultOn: true }],
        },
        makeGoProvider({ models: [{ id: 'go-model', apiModel: 'go', displayName: 'Go', thinking: false }] }),
      ] as never,
    })
    expect(getActiveGoUsageProvider()).toBeNull()
    expect(GO_USAGE_FALLBACK_MESSAGE).toBe('BYOK — unlimited')
  })

  it('follows the last chatted model: opencode selected shows, plain selected hides', () => {
    setProvidersForTests({
      $schemaVersion: 1,
      providers: [
        {
          ...makePlainProvider(),
          models: [{ id: 'plain-model', apiModel: 'plain', displayName: 'Plain', thinking: false, defaultOn: true }],
        },
        makeGoProvider({ models: [{ id: 'go-model', apiModel: 'go', displayName: 'Go', thinking: false, defaultOn: true }] }),
      ] as never,
    })
    recordGoUsageModelSeen('go-model')
    expect(getActiveGoUsageProvider()?.id).toBe('go')
    recordGoUsageModelSeen('plain-model')
    expect(getActiveGoUsageProvider()).toBeNull()
  })

  it('refreshes on demand and serves display from cache without refetching', async () => {
    setProvidersForTests({
      $schemaVersion: 1,
      providers: [makeGoProvider()] as never,
    })
    const resetsAt = new Date(Date.now() + 3600 * 1000).toISOString()
    const stubFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 42, resetsAt },
          weekly: { status: 'ok', percent: 18, resetsAt },
          monthly: { status: 'ok', percent: 9, resetsAt },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', stubFetch)
    try {
      recordGoUsageModelSeen('go-model')
      const refreshed = await refreshGoUsageAfterConversation()
      expect(refreshed?.rolling.percent).toBe(42)
      expect(stubFetch).toHaveBeenCalledTimes(1)
      const message = await getGoUsageDisplayMessage()
      expect(message).toContain('Go 5h 42%')
      expect(message).toContain('Week 18%')
      expect(message).toContain('Month 9%')
      expect(stubFetch).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
