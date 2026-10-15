import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearXaiCredentials,
  computeXaiTokenExpiryMs,
  ensureFreshXaiAccessToken,
  getEffectiveXaiApiKey,
  getXaiLoginStatus,
  isXaiOAuthCompatibleType,
  isXaiProvider,
  loadXaiCredentials,
  pollXaiDeviceAuthorization,
  refreshXaiAccessToken,
  resolveXaiAccessTokenSync,
  setXaiCredentialsFileForTests,
  startXaiDeviceAuthorization,
  storeXaiDeviceTokenPair,
  XaiOAuthError,
} from '../services/account/xaiOAuth'

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'xai',
    name: 'xAI SuperGrok',
    type: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    auth: { kind: 'apiKey', value: '' },
    models: [],
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(error: string, status = 400, description?: string): Response {
  return jsonResponse(description ? { error, error_description: description } : { error }, status)
}

// access_token 只需要点分隔三段, payload 段按需填 exp。
function fakeJwt(exp?: number): string {
  const payload = Buffer.from(JSON.stringify(exp === undefined ? {} : { exp })).toString('base64url')
  return `header.${payload}.signature`
}

describe('xaiOAuth (supergrok)', () => {
  let credentialsFile = ''

  beforeEach(() => {
    credentialsFile = join(mkdtempSync(join(tmpdir(), 'ccursor-xai-')), 'xai-credentials.json')
    setXaiCredentialsFileForTests(credentialsFile)
  })

  it('recognises xAI providers by baseUrl, supergrok name, or xai label', () => {
    expect(isXaiProvider(makeProvider() as never)).toBe(true)
    expect(isXaiProvider(makeProvider({ baseUrl: 'https://proxy.local/x', name: 'SuperGrok Sub' }) as never)).toBe(true)
    expect(isXaiProvider(makeProvider({ baseUrl: '', name: 'plain', id: 'plain' }) as never)).toBe(false)
    expect(isXaiProvider(null)).toBe(false)
  })

  it('only openai-compatible types carry the OAuth bearer', () => {
    expect(isXaiOAuthCompatibleType('openai-chat')).toBe(true)
    expect(isXaiOAuthCompatibleType('openai-responses')).toBe(true)
    expect(isXaiOAuthCompatibleType('anthropic')).toBe(false)
    expect(isXaiOAuthCompatibleType('gemini')).toBe(false)
  })

  it('prefers fresh OAuth token, falls back to static key, ignores other providers', () => {
    const staticProvider = makeProvider({ auth: { kind: 'apiKey', value: 'xai-static' } })
    // 未登录: 静态 key 原样返回。
    expect(getEffectiveXaiApiKey(staticProvider as never)).toBe('xai-static')
    storeXaiDeviceTokenPair({
      accessToken: 'oauth-access',
      refreshToken: 'oauth-refresh',
      expiresAtMs: Date.now() + 3600 * 1000,
    })
    // 已登录且新鲜: OAuth 优先。
    expect(getEffectiveXaiApiKey(staticProvider as never)).toBe('oauth-access')
    expect(resolveXaiAccessTokenSync()).toBe('oauth-access')
    // 非 xAI provider 不受影响。
    const other = makeProvider({ baseUrl: 'https://example.com', name: 'plain', id: 'plain', auth: { kind: 'apiKey', value: 'sk-x' } })
    expect(getEffectiveXaiApiKey(other as never)).toBe('sk-x')
  })

  it('expired access token falls back to static key and reports expiry', () => {
    storeXaiDeviceTokenPair({
      accessToken: 'stale-access',
      refreshToken: 'still-good-refresh',
      expiresAtMs: Date.now() - 1000,
    })
    const provider = makeProvider({ auth: { kind: 'apiKey', value: 'xai-static' } })
    expect(resolveXaiAccessTokenSync()).toBeNull()
    expect(getEffectiveXaiApiKey(provider as never)).toBe('xai-static')
    const status = getXaiLoginStatus()
    expect(status.loggedIn).toBe(true)
    expect(status.expiresInSec ?? 0).toBeLessThanOrEqual(0)
  })

  it('logout clears the session file', () => {
    storeXaiDeviceTokenPair({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs: Date.now() + 3600 * 1000,
    })
    expect(loadXaiCredentials()).not.toBeNull()
    clearXaiCredentials()
    expect(loadXaiCredentials()).toBeNull()
    expect(getXaiLoginStatus()).toEqual({ loggedIn: false })
  })

  it('computes expiry from expires_in, JWT exp, then 1h fallback', () => {
    const before = Date.now()
    const fromExpiresIn = computeXaiTokenExpiryMs({ expires_in: 3600, access_token: 'opaque' })
    expect(fromExpiresIn - before).toBeGreaterThan(3599 * 1000)
    const futureExp = Math.floor(Date.now() / 1000) + 7200
    const fromJwt = computeXaiTokenExpiryMs({ access_token: fakeJwt(futureExp) })
    expect(Math.abs(fromJwt - futureExp * 1000)).toBeLessThan(5000)
    const fallback = computeXaiTokenExpiryMs({ access_token: 'opaque-no-dots' })
    expect(fallback - Date.now()).toBeGreaterThan(3599 * 1000)
  })

  it('starts device authorization and parses the challenge', async () => {
    const stubFetch = vi.fn(async () =>
      jsonResponse({
        device_code: 'device-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://x.ai/activate',
        verification_uri_complete: 'https://x.ai/activate?code=ABCD-1234',
        expires_in: 600,
        interval: 5,
      }),
    )
    const challenge = await startXaiDeviceAuthorization(stubFetch as never)
    expect(challenge.deviceCode).toBe('device-123')
    expect(challenge.userCode).toBe('ABCD-1234')
    expect(challenge.verificationUriComplete).toContain('ABCD-1234')
    expect(challenge.intervalSec).toBe(5)
    expect(challenge.expiresAtMs).toBeGreaterThan(Date.now())
    expect(stubFetch).toHaveBeenCalledTimes(1)
    const [url, init] = stubFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://auth.x.ai/oauth2/device/code')
    const bodyText = String(init.body)
    expect(bodyText).toContain('client_id=b1a00492-073a-47ea-816f-4c329264a828')
    expect(bodyText).toContain('referrer=opencode')
  })

  it('poll succeeds immediately once the user approves', async () => {
    const stubFetch = vi.fn(async () =>
      jsonResponse({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
    )
    const pair = await pollXaiDeviceAuthorization('device-123', 5, Date.now() + 600 * 1000, stubFetch as never)
    expect(pair.accessToken).toBe('fresh-access')
    expect(pair.refreshToken).toBe('fresh-refresh')
    expect(pair.expiresAtMs).toBeGreaterThan(Date.now())
    expect(stubFetch).toHaveBeenCalledTimes(1)
  })

  it('poll maps denial to an actionable error', async () => {
    const stubFetch = vi.fn(async () => errorResponse('authorization_denied'))
    await expect(
      pollXaiDeviceAuthorization('device-123', 5, Date.now() + 600 * 1000, stubFetch as never),
    ).rejects.toMatchObject({ name: 'XaiOAuthError', code: 'denied' })
  })

  it('refresh persists the new pair and reuses the old refresh when absent', async () => {
    const stubFetch = vi.fn(async () =>
      jsonResponse({ access_token: 'rotated-access', expires_in: 1800 }),
    )
    const pair = await refreshXaiAccessToken('old-refresh', stubFetch as never)
    expect(pair.accessToken).toBe('rotated-access')
    expect(pair.refreshToken).toBe('old-refresh')
    expect(loadXaiCredentials()?.access).toBe('rotated-access')
  })

  it('invalid_grant clears the session so the panel shows logged-out', async () => {
    storeXaiDeviceTokenPair({
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
      expiresAtMs: Date.now() - 1000,
    })
    const stubFetch = vi.fn(async () => errorResponse('invalid_grant', 400, 'token revoked'))
    await expect(refreshXaiAccessToken('revoked-refresh', stubFetch as never)).rejects.toBeInstanceOf(XaiOAuthError)
    expect(loadXaiCredentials()).toBeNull()
  })

  it('ensure returns fresh token without network, refreshes when stale, never throws', async () => {
    // 新鲜: 零网络调用。
    storeXaiDeviceTokenPair({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAtMs: Date.now() + 3600 * 1000,
    })
    const networkSpy = vi.fn(async () => jsonResponse({}))
    const fresh = await ensureFreshXaiAccessToken(networkSpy as never)
    expect(fresh).toEqual({ accessToken: 'fresh-access', didRefresh: false })
    expect(networkSpy).not.toHaveBeenCalled()
    // 过期: 刷一次。
    storeXaiDeviceTokenPair({
      accessToken: 'stale-access',
      refreshToken: 'good-refresh',
      expiresAtMs: Date.now() - 1000,
    })
    const refreshStub = vi.fn(async () =>
      jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    )
    const refreshed = await ensureFreshXaiAccessToken(refreshStub as never)
    expect(refreshed).toEqual({ accessToken: 'new-access', didRefresh: true })
    // 刷新失败: 不抛, 降级 null (invalid_grant 已清文件)。
    storeXaiDeviceTokenPair({
      accessToken: 'stale-access',
      refreshToken: 'bad-refresh',
      expiresAtMs: Date.now() - 1000,
    })
    const failingStub = vi.fn(async () => errorResponse('invalid_grant'))
    const degraded = await ensureFreshXaiAccessToken(failingStub as never)
    expect(degraded.accessToken).toBeNull()
  })
})
