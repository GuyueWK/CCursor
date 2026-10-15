/**
 * xAI SuperGrok Subscription - OAuth device-code login + token lifecycle.
 *
 * Ported from the open-source opencode CLI
 * (packages/core/src/plugin/provider/xai.ts, client fingerprint kept
 * identical): SuperGrok is NOT an API key scheme. The user approves a
 * device-code consent screen in the browser, opencode polls xAI's token
 * endpoint, and the resulting OAuth access token is used as a Bearer
 * token against the regular OpenAI-compatible endpoint
 * (https://api.x.ai/v1/chat/completions, /responses).
 *
 * Client fingerprint (must stay in sync with opencode):
 *   client_id = b1a00492-073a-47ea-816f-4c329264a828
 *   issuer    = https://auth.x.ai/oauth2
 *   scope     = openid profile email offline_access grok-cli:access api:access
 *   referrer  = opencode
 *
 * Credentials:
 *   Stored in ~/.ccursor/xai-credentials.json as
 *   { access, refresh, expiresAt (epoch ms), obtainedAt (ISO) }.
 *   Same plaintext security level as providers.json - no extra file perms.
 *   Logs carry token length only, never token content.
 *
 * Injection:
 *   providerRuntime resolves xAI providers (baseUrl contains api.x.ai)
 *   with the fresh OAuth access token instead of the static
 *   provider.auth.value. A statically configured API key keeps working as
 *   fallback (Option B in opencode docs) when no OAuth session exists.
 *
 * Refresh strategy:
 *   No timer polling. ensureFreshXaiAccessToken() is called once before
 *   each Agent conversation (agentOrchestrator) and refreshes when the
 *   access token expires within the safety margin. xAI provider SDK
 *   clients are never cached in providerInstances, so a refreshed token
 *   takes effect on the very next turn without resetProviderInstanceCache.
 */
import type { ProviderEntry } from '../../data/defaults'
import { existsSync, rmSync } from 'node:fs'
import { readJsonOrNull, writeJsonAtomic } from '../../config/atomic'
import { getXaiCredentialsFilePath } from '../../config/paths'
import { logger } from '../../logger'

// ── opencode client fingerprint - keep identical ──

export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai/oauth2'
export const XAI_OAUTH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const XAI_OAUTH_REFERRER = 'opencode'
export const XAI_API_BASE_HOST = 'api.x.ai'
export const XAI_OAUTH_USER_AGENT = 'Cursor++/ccursor (xai-oauth)'

const XAI_REQUEST_TIMEOUT_MS = 15_000
const XAI_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const XAI_POLL_SAFETY_MARGIN_MS = 3_000
const XAI_SLOW_DOWN_EXTRA_MS = 5_000
const XAI_FALLBACK_TOKEN_TTL_SEC = 3_600

// ── Types ──

export interface XaiOAuthCredentials {
  access: string
  refresh: string
  /** Access token expiry as epoch milliseconds. */
  expiresAt: number
  obtainedAt: string
}

export interface XaiLoginStatus {
  loggedIn: boolean
  /** Epoch ms when the current access token expires; absent when logged out. */
  expiresAt?: number
  /** Seconds until access expiry (<= 0 means expired); absent when logged out. */
  expiresInSec?: number
}

export interface XaiDeviceChallenge {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAtMs: number
  intervalSec: number
}

export interface XaiTokenPair {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
}

export interface XaiFreshTokenResult {
  accessToken: string | null
  /** True when a refresh HTTP call succeeded during this ensure. */
  didRefresh: boolean
}

export class XaiOAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'XaiOAuthError'
    this.code = code
  }
}

type FetchImpl = typeof globalThis.fetch

// Test seam: override the credentials file location without touching homedir.
let credentialsFileOverride: string | null = null

/** Test-only override for the credentials file path. Pass null to restore. */
export function setXaiCredentialsFileForTests(filePath: string | null): void {
  credentialsFileOverride = filePath
}

function resolveCredentialsFilePath(): string {
  return credentialsFileOverride ?? getXaiCredentialsFilePath()
}

// ── Provider recognition ──

/** An xAI SuperGrok inference provider is recognised by baseUrl, not by name. */
export function isXaiProvider(provider: ProviderEntry | null | undefined): boolean {
  if (!provider)
    return false
  const baseUrlText = String(provider.baseUrl || '').toLowerCase()
  if (baseUrlText.includes(XAI_API_BASE_HOST))
    return true
  const providerLabel = String(provider.name || provider.id || '')
  return /super[\s_-]*grok/i.test(providerLabel) || /\bxai\b/i.test(providerLabel)
}

/** Only OpenAI-compatible provider types can carry a SuperGrok Bearer token. */
export function isXaiOAuthCompatibleType(providerType: string): boolean {
  return providerType === 'openai-chat' || providerType === 'openai-responses'
}

// ── Credential file IO (synchronous - used on the hot inference path) ──

function isValidStoredCredentials(value: unknown): value is XaiOAuthCredentials {
  if (!value || typeof value !== 'object')
    return false
  const record = value as Record<string, unknown>
  return typeof record.access === 'string'
    && record.access.length > 0
    && typeof record.refresh === 'string'
    && record.refresh.length > 0
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt)
    && record.expiresAt > 0
}

/** Load stored OAuth credentials; null when logged out or the file is corrupt. */
export function loadXaiCredentials(): XaiOAuthCredentials | null {
  const parsed = readJsonOrNull<unknown>(resolveCredentialsFilePath())
  if (!isValidStoredCredentials(parsed)) {
    if (parsed !== null)
      logger.warn('[XAI_AUTH] credentials file corrupt - treating as logged out')
    return null
  }
  return parsed
}

function persistXaiCredentials(credentials: XaiOAuthCredentials): void {
  writeJsonAtomic(resolveCredentialsFilePath(), credentials)
}

/** Delete the stored session. Never throws - logout must not break the panel. */
export function clearXaiCredentials(): void {
  try {
    const filePath = resolveCredentialsFilePath()
    if (existsSync(filePath))
      rmSync(filePath)
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[XAI_AUTH] failed to delete credentials file')
  }
}

// ── Token expiry ──

function decodeJwtExpiryMs(accessToken: string): number | null {
  const tokenPayload = accessToken.split('.')[1]
  if (!tokenPayload)
    return null
  try {
    const claimsJson = Buffer.from(tokenPayload, 'base64url').toString('utf-8')
    const claims = JSON.parse(claimsJson) as { exp?: unknown }
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > 0)
      return claims.exp * 1000
    return null
  }
  catch {
    return null
  }
}

/**
 * Absolute expiry (epoch ms) for a fresh token response.
 * Prefers expires_in, falls back to the JWT exp claim, then to 1 hour -
 * mirrors opencode's tokenExpiration().
 */
export function computeXaiTokenExpiryMs(tokenResponse: { expires_in?: unknown, access_token: string }): number {
  const expiresInSec = Number(tokenResponse.expires_in)
  if (Number.isFinite(expiresInSec) && expiresInSec > 0)
    return Date.now() + expiresInSec * 1000
  return decodeJwtExpiryMs(tokenResponse.access_token) ?? (Date.now() + XAI_FALLBACK_TOKEN_TTL_SEC * 1000)
}

function isAccessTokenFresh(credentials: XaiOAuthCredentials, nowMs: number): boolean {
  return credentials.expiresAt - nowMs > XAI_TOKEN_REFRESH_MARGIN_MS
}

/** Login summary for the control panel. Synchronous, never touches network. */
export function getXaiLoginStatus(): XaiLoginStatus {
  const credentials = loadXaiCredentials()
  if (!credentials || !credentials.refresh)
    return { loggedIn: false }
  const expiresInSec = Math.round((credentials.expiresAt - Date.now()) / 1000)
  return { loggedIn: true, expiresAt: credentials.expiresAt, expiresInSec }
}

/**
 * Synchronous fast path for the inference hot path: fresh OAuth access
 * token, or null when absent/expiring (caller falls back to the static
 * provider.auth.value API key).
 */
export function resolveXaiAccessTokenSync(): string | null {
  const credentials = loadXaiCredentials()
  if (!credentials)
    return null
  if (!isAccessTokenFresh(credentials, Date.now()))
    return null
  return credentials.access
}

/**
 * Effective Bearer key for an xAI provider entry: fresh OAuth access
 * token first, static auth.value (pay-as-you-go API key) as fallback.
 * Non-xAI providers always use their static auth.value untouched.
 */
export function getEffectiveXaiApiKey(provider: ProviderEntry): string {
  const staticKey = String(provider.auth?.value ?? '')
  if (!isXaiProvider(provider) || !isXaiOAuthCompatibleType(provider.type))
    return staticKey
  return resolveXaiAccessTokenSync() ?? staticKey
}

// ── HTTP helpers ──

function buildXaiFormHeaders(): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': XAI_OAUTH_USER_AGENT,
  }
}

function positiveSeconds(value: unknown, fallbackSec: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSec
}

function describeTokenForLog(token: string): string {
  return `len=${token.length} hint=${token.slice(0, 4)}...`
}

interface XaiTokenResponseBody {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

interface XaiDeviceCodeResponseBody {
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  verification_uri_complete?: unknown
  expires_in?: unknown
  interval?: unknown
}

interface XaiDeviceErrorBody {
  error?: unknown
  error_description?: unknown
}

function parseJsonBody(rawText: string): Record<string, unknown> | null {
  if (!rawText)
    return null
  try {
    const parsed: unknown = JSON.parse(rawText)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

function toTokenPair(body: XaiTokenResponseBody, previousRefresh?: string): XaiTokenPair {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token
    ? body.refresh_token
    : (previousRefresh ?? '')
  if (!accessToken)
    throw new XaiOAuthError('invalid_response', 'xAI token response is missing access_token')
  if (!refreshToken)
    throw new XaiOAuthError('invalid_response', 'xAI token response is missing refresh_token')
  return {
    accessToken,
    refreshToken,
    expiresAtMs: computeXaiTokenExpiryMs({ expires_in: body.expires_in, access_token: accessToken }),
  }
}

function storeTokenPair(pair: XaiTokenPair): void {
  persistXaiCredentials({
    access: pair.accessToken,
    refresh: pair.refreshToken,
    expiresAt: pair.expiresAtMs,
    obtainedAt: new Date().toISOString(),
  })
}

// ── Device authorization: start ──

/**
 * Step 1 of the device flow: ask xAI for a user code + verification link.
 * The caller shows verificationUriComplete + userCode to the user, then
 * calls pollXaiDeviceAuthorization() until approval (or expiry).
 */
export async function startXaiDeviceAuthorization(fetchImpl: FetchImpl = globalThis.fetch): Promise<XaiDeviceChallenge> {
  let response: Response
  try {
    response = await fetchImpl(`${XAI_OAUTH_ISSUER}/device/code`, {
      method: 'POST',
      headers: buildXaiFormHeaders(),
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
        referrer: XAI_OAUTH_REFERRER,
      }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS),
    })
  }
  catch (error) {
    throw new XaiOAuthError('network', `xAI device-code request failed: ${(error as Error).message}`)
  }
  const rawText = await response.text().catch(() => '')
  if (!response.ok)
    throw new XaiOAuthError('invalid_response', `xAI device-code request failed (${response.status})${rawText ? `: ${rawText.slice(0, 200)}` : ''}`)
  const body = parseJsonBody(rawText) as XaiDeviceCodeResponseBody | null
  const deviceCode = typeof body?.device_code === 'string' ? body.device_code : ''
  const userCode = typeof body?.user_code === 'string' ? body.user_code : ''
  const verificationUri = typeof body?.verification_uri === 'string' ? body.verification_uri : ''
  if (!deviceCode || !userCode || !verificationUri)
    throw new XaiOAuthError('invalid_response', 'xAI device-code response is missing device_code/user_code/verification_uri')
  const verificationUriComplete = typeof body?.verification_uri_complete === 'string' && body.verification_uri_complete
    ? body.verification_uri_complete
    : verificationUri
  const expiresInSec = positiveSeconds(body?.expires_in, 300)
  const intervalSec = positiveSeconds(body?.interval, 5)
  logger.info({ userCodeLength: userCode.length }, '[XAI_AUTH] device challenge issued')
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    intervalSec,
  }
}

// ── Device authorization: poll ──

function sleepMs(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new XaiOAuthError('cancelled', 'xAI device authorization was cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new XaiOAuthError('cancelled', 'xAI device authorization was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Step 2 of the device flow: poll the token endpoint until the user
 * approves (or denies / the code expires). Mirrors opencode's poll():
 * authorization_pending keeps the interval, slow_down adds 5s, denial
 * and expiry fail fast with actionable messages.
 */
export async function pollXaiDeviceAuthorization(
  deviceCode: string,
  intervalSec: number,
  expiresAtMs: number,
  fetchImpl: FetchImpl = globalThis.fetch,
  signal?: AbortSignal,
): Promise<XaiTokenPair> {
  let intervalMs = Math.max(positiveSeconds(intervalSec, 5) * 1000, 1000)
  for (;;) {
    if (Date.now() >= expiresAtMs)
      throw new XaiOAuthError('expired', 'xAI device code expired - please re-run login')
    if (signal?.aborted)
      throw new XaiOAuthError('cancelled', 'xAI device authorization was cancelled')
    let response: Response
    try {
      response = await fetchImpl(`${XAI_OAUTH_ISSUER}/token`, {
        method: 'POST',
        headers: buildXaiFormHeaders(),
        body: new URLSearchParams({
          grant_type: XAI_OAUTH_DEVICE_GRANT,
          client_id: XAI_OAUTH_CLIENT_ID,
          device_code: deviceCode,
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS),
      })
    }
    catch (error) {
      if (error instanceof XaiOAuthError)
        throw error
      throw new XaiOAuthError('network', `xAI device token poll failed: ${(error as Error).message}`)
    }
    if (response.ok) {
      const rawText = await response.text().catch(() => '')
      const body = parseJsonBody(rawText) as XaiTokenResponseBody | null
      if (!body)
        throw new XaiOAuthError('invalid_response', 'xAI device token response is not JSON')
      const pair = toTokenPair(body)
      logger.info({ access: describeTokenForLog(pair.accessToken) }, '[XAI_AUTH] device authorization approved')
      return pair
    }
    const rawText = await response.text().catch(() => '')
    const errorBody = parseJsonBody(rawText) as XaiDeviceErrorBody | null
    const errorCode = typeof errorBody?.error === 'string' ? errorBody.error : ''
    if (errorCode === 'authorization_pending') {
      await sleepMs(intervalMs + XAI_POLL_SAFETY_MARGIN_MS, signal)
      continue
    }
    if (errorCode === 'slow_down') {
      intervalMs += XAI_SLOW_DOWN_EXTRA_MS
      await sleepMs(intervalMs + XAI_POLL_SAFETY_MARGIN_MS, signal)
      continue
    }
    if (errorCode === 'access_denied' || errorCode === 'authorization_denied')
      throw new XaiOAuthError('denied', 'xAI device authorization was denied')
    if (errorCode === 'expired_token')
      throw new XaiOAuthError('expired', 'xAI device code expired - please re-run login')
    const detail = typeof errorBody?.error_description === 'string' && errorBody.error_description
      ? errorBody.error_description
      : errorCode
    throw new XaiOAuthError('invalid_response', `xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
}

// ── Refresh ──

/**
 * Exchange a refresh token for a new pair. On success the new pair is
 * persisted; on invalid_grant (revoked/rotated refresh token) the stored
 * session is deleted so the panel correctly shows logged-out.
 */
export async function refreshXaiAccessToken(
  refreshToken: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<XaiTokenPair> {
  let response: Response
  try {
    response = await fetchImpl(`${XAI_OAUTH_ISSUER}/token`, {
      method: 'POST',
      headers: buildXaiFormHeaders(),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: XAI_OAUTH_CLIENT_ID,
      }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS),
    })
  }
  catch (error) {
    throw new XaiOAuthError('network', `xAI token refresh failed: ${(error as Error).message}`)
  }
  const rawText = await response.text().catch(() => '')
  if (!response.ok) {
    const errorBody = parseJsonBody(rawText) as XaiDeviceErrorBody | null
    const errorCode = typeof errorBody?.error === 'string' ? errorBody.error : ''
    if (errorCode === 'invalid_grant') {
      clearXaiCredentials()
      throw new XaiOAuthError('invalid_grant', 'xAI session expired (refresh token rejected) - please log in again')
    }
    throw new XaiOAuthError('invalid_response', `xAI token refresh failed (${response.status})${rawText ? `: ${rawText.slice(0, 200)}` : ''}`)
  }
  const body = parseJsonBody(rawText) as XaiTokenResponseBody | null
  if (!body)
    throw new XaiOAuthError('invalid_response', 'xAI token refresh response is not JSON')
  const pair = toTokenPair(body, refreshToken)
  storeTokenPair(pair)
  logger.info({ access: describeTokenForLog(pair.accessToken) }, '[XAI_AUTH] access token refreshed')
  return pair
}

/**
 * Pre-conversation ensure: return a usable access token, refreshing once
 * when the stored one is missing/expiring. Never throws - auth failure
 * must degrade to the static API key path, never block the chat turn.
 */
export async function ensureFreshXaiAccessToken(fetchImpl: FetchImpl = globalThis.fetch): Promise<XaiFreshTokenResult> {
  const credentials = loadXaiCredentials()
  if (!credentials || !credentials.refresh)
    return { accessToken: null, didRefresh: false }
  if (isAccessTokenFresh(credentials, Date.now()))
    return { accessToken: credentials.access, didRefresh: false }
  try {
    const pair = await refreshXaiAccessToken(credentials.refresh, fetchImpl)
    return { accessToken: pair.accessToken, didRefresh: true }
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[XAI_AUTH] background refresh failed - falling back to static key')
    // Refresh failed but the old access token may still be accepted for a
    // short grace window; hand it out rather than failing the turn.
    // invalid_grant already cleared the file above, so loadXaiCredentials
    // returning null here correctly yields accessToken: null.
    const remaining = loadXaiCredentials()
    return { accessToken: remaining?.access ?? null, didRefresh: false }
  }
}

/** Persist a device-flow token pair after the user approves the challenge. */
export function storeXaiDeviceTokenPair(pair: XaiTokenPair): void {
  storeTokenPair(pair)
  logger.info({ access: describeTokenForLog(pair.accessToken) }, '[XAI_AUTH] device login stored')
}
