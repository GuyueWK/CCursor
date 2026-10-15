/**
 * OpenCode Go usage - Zen quota endpoint + conversation-end refresh + chat slot text.
  *
  * Background:
  *   Go plans are metered server-side by dollar-value (5h = 20% of monthly,
  *   week = 50%), so local token counting never matches. There is no public
  *   usage API in the docs; the web console itself reads the Zen endpoint
  *   (same one the mellena1/opencode-go-usage TUI plugin uses):
  *     GET https://opencode.ai/zen/go/v1/usage
  *     Authorization: Bearer <Go API key>
  *   which returns the three subscription windows as used percentages:
  *     { usage: {
  *         rolling: { status, percent, resetsAt },
  *         weekly:  { status, percent, resetsAt },
  *         monthly: { status, percent, resetsAt } } }
  *
  * Credentials:
  *   The Go API key is the SAME key already used for inference
  *   (provider.auth.value of the opencode Go provider). No browser session
  *   cookie, no workspaceId, no HTML scraping. The old cookie chain
  *   (workspace/:id/go page + __Host-console_session / auth cookie) is gone:
  *   it 302-bounced to /console/login whenever the session was not
  *   recognised and was impossible to debug from status codes alone.
  *
  * Display gating:
  *   Usage is shown only when the currently selected model belongs to an
  *   opencode Go provider. Selection is tracked from the last Agent RunSSE
  *   model (recordGoUsageModelSeen, called by agentOrchestrator); before any
  *   chat runs, the default model (first defaultOn) is used instead.
 *   Anything else - including a default that points at a non-opencode
 *   provider - falls back to `BYOK — unlimited` and never blocks chat.
 *
 * Refresh strategy:
 *   No timer polling. The snapshot is refreshed once after each completed
 *   Agent conversation (agentOrchestrator calls
 *   refreshGoUsageAfterConversation); GetCurrentPeriodUsage only reads the
 *   cached snapshot and fetches on first display when the cache is empty.
 *
 * Safety:
 *   - Logs carry provider id + key length only, never the key itself.
 *   - 401 = key rejected, 403 = key valid but no Go subscription.
 */
 import type { ProviderEntry } from '../../data/defaults'
 import { isModelDefaultOn } from '../../data/defaults'
 import { flattenModels, loadProviders, lookupModel } from '../../config/providersStore'
 import { createProxiedFetch } from '../../handlers/llm/proxyFetch'
 import { logger } from '../../logger'

export const GO_USAGE_FALLBACK_MESSAGE = 'BYOK — unlimited'
const GO_USAGE_FETCH_TIMEOUT_MS = 10_000
 const DEFAULT_ZEN_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
 const GO_USAGE_USER_AGENT = 'Cursor++/ccursor (go-usage-zen)'

 export interface GoUsageWindow {
   percent: number
   resetInSec?: number
 }

 export interface GoUsageSnapshot {
   rolling: GoUsageWindow
   weekly: GoUsageWindow
   monthly: GoUsageWindow
   plan?: string
   fetchedAt: string
 }

interface CachedGoUsage {
  snapshot: GoUsageSnapshot
}

 interface ZenUsageWindowNode {
   percent?: unknown
   status?: unknown
   resetsAt?: unknown
 }

 interface ZenUsageNode {
   rolling?: unknown
   weekly?: unknown
   monthly?: unknown
   plan?: unknown
 }

 const usageCache = new Map<string, CachedGoUsage>()
 const inflightRequests = new Map<string, Promise<GoUsageSnapshot | null>>()

 // Last model id seen on the Agent RunSSE path. Set by agentOrchestrator
 // after parseRunRequest; read by getActiveGoUsageProvider to decide whether
 // the currently selected model belongs to an opencode Go provider.
 let lastSeenModelId = ''

 /** Agent chain calls this with parsed.modelId on every RunSSE turn. */
 export function recordGoUsageModelSeen(modelId: unknown): void {
   if (typeof modelId !== 'string')
     return
   const trimmedModelId = modelId.trim()
   if (!trimmedModelId)
     return
   lastSeenModelId = trimmedModelId
 }

 /** Currently selected model id as far as usage gating is concerned. */
 export function getLastSeenGoUsageModelId(): string {
   return lastSeenModelId
 }

 /** An opencode Go inference provider is recognised by baseUrl, not by name. */
 export function isOpencodeGoProvider(provider: ProviderEntry | null | undefined): boolean {
   if (!provider)
     return false
   const baseUrlText = String(provider.baseUrl || '').toLowerCase()
   if (baseUrlText.includes('opencode.ai/zen/go'))
     return true
   const providerLabel = String(provider.name || provider.id || '')
   return /opencode[\s_-]*go/i.test(providerLabel)
 }

 // Strip Bearer prefix / wrapping quotes / whitespace pasted from dashboards.
 // Only subtracts, never rewrites the key body, so it is safe to run always.
 export function normalizeGoApiKey(raw: unknown): string {
   if (typeof raw !== 'string')
     return ''
   let cleanedKey = raw.trim()
   if (cleanedKey.length >= 2) {
     const firstChar = cleanedKey[0]
     const lastChar = cleanedKey[cleanedKey.length - 1]
     if ((firstChar === '"' && lastChar === '"') || (firstChar === '\'' && lastChar === '\''))
       cleanedKey = cleanedKey.slice(1, -1).trim()
   }
   cleanedKey = cleanedKey.replace(/^bearer\s+/i, '').trim()
   cleanedKey = cleanedKey.replace(/\s+/g, '')
   return cleanedKey
 }

 function resolveProviderApiKey(provider: ProviderEntry): string {
   return normalizeGoApiKey(provider.auth?.value ?? '')
 }

 /**
  * Usage URL derived from the provider's own inference baseUrl so proxies
  * and self-hosted mirrors keep working:
  *   .../zen/go/v1        -> .../zen/go/v1/usage
  *   .../zen/go           -> .../zen/go/v1/usage
  *   .../zen/go/v1/usage  -> as-is
  * Anything else falls back to the public default.
  */
 export function buildZenUsageUrl(provider: ProviderEntry): string {
   const fallbackUrl = DEFAULT_ZEN_USAGE_URL
   const rawBaseUrl = String(provider.baseUrl || '').trim().replace(/\/+$/, '')
   if (!rawBaseUrl)
     return fallbackUrl
   let parsedBaseUrl: URL | null = null
   try {
     parsedBaseUrl = new URL(rawBaseUrl)
   }
   catch {
     return fallbackUrl
   }
   if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:')
     return fallbackUrl
   if (rawBaseUrl.endsWith('/v1/usage'))
     return rawBaseUrl
   if (rawBaseUrl.endsWith('/v1'))
     return `${rawBaseUrl}/usage`
   if (rawBaseUrl.includes('/zen/go'))
     return `${rawBaseUrl}/v1/usage`
   return fallbackUrl
 }

 function pickFetchForProvider(provider: ProviderEntry): typeof globalThis.fetch {
   if (provider.proxyUrl?.trim())
     return createProxiedFetch(provider.proxyUrl.trim())
   return globalThis.fetch
 }

 function convertResetsAtToSeconds(resetsAt: unknown): number | undefined {
   if (typeof resetsAt !== 'string' || !resetsAt)
     return undefined
   const resetsAtMs = Date.parse(resetsAt)
   if (Number.isNaN(resetsAtMs))
     return undefined
   return Math.max(0, Math.round((resetsAtMs - Date.now()) / 1000))
 }

 function parseZenWindowNode(node: unknown): GoUsageWindow | null {
   if (!node || typeof node !== 'object')
     return null
   const windowNode = node as ZenUsageWindowNode
   const percentValue = Number(windowNode.percent)
   if (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 100)
     return null
   const resetInSec = convertResetsAtToSeconds(windowNode.resetsAt)
   return resetInSec === undefined ? { percent: percentValue } : { percent: percentValue, resetInSec }
 }

 function extractUsageNode(payload: unknown): ZenUsageNode | null {
   if (!payload || typeof payload !== 'object')
     return null
   const rootNode = payload as Record<string, unknown>
   const directUsage = rootNode.usage
   if (directUsage && typeof directUsage === 'object')
     return directUsage as ZenUsageNode
   const dataNode = rootNode.data
   if (dataNode && typeof dataNode === 'object') {
     const nestedUsage = (dataNode as Record<string, unknown>).usage
     if (nestedUsage && typeof nestedUsage === 'object')
       return nestedUsage as ZenUsageNode
   }
   // Some mirrors return the three windows at top level.
   if ('rolling' in rootNode || 'weekly' in rootNode || 'monthly' in rootNode)
     return rootNode as unknown as ZenUsageNode
   return null
 }

 /** Parse the Zen /v1/usage JSON into the three windows; null when unrecognised. */
 export function parseZenUsagePayload(payload: unknown): GoUsageSnapshot | null {
   const usageNode = extractUsageNode(payload)
   if (!usageNode)
     return null
   const rolling = parseZenWindowNode(usageNode.rolling)
   const weekly = parseZenWindowNode(usageNode.weekly)
   const monthly = parseZenWindowNode(usageNode.monthly)
   if (!rolling || !weekly || !monthly)
     return null
   const planNode = (usageNode as Record<string, unknown>).plan ?? (payload as Record<string, unknown>).plan
   const planText = typeof planNode === 'string' && planNode.length > 0 && planNode.length <= 32 ? planNode : undefined
   return {
     rolling,
     weekly,
     monthly,
     ...(planText ? { plan: planText } : {}),
     fetchedAt: new Date().toISOString(),
   }
 }

 function findFirstOpencodeProviderWithKey(providers: ProviderEntry[]): ProviderEntry | null {
   for (const provider of providers) {
     if (!isOpencodeGoProvider(provider))
       continue
     if (!resolveProviderApiKey(provider))
       continue
     return provider
   }
   return null
 }

 function resolveProviderForModelId(modelId: string): ProviderEntry | null {
   if (!modelId)
     return null
   try {
     const resolved = lookupModel(modelId)
     return resolved?.provider ?? null
   }
   catch {
     return null
   }
 }

 /**
  * Active Go usage provider: only when the selected model belongs to an
  * opencode Go provider with an API key. Selection order:
  *   1. last Agent RunSSE model (the chat model the user actually picked);
  *   2. default model (first defaultOn) before any chat has run;
  *   3. first opencode provider when no defaultOn is configured at all.
  * A selected/default model on a non-opencode provider returns null so the
  * chat slot keeps `BYOK — unlimited` instead of showing another Go quota.
  */
 export function getActiveGoUsageProvider(): ProviderEntry | null {
   try {
     const config = loadProviders()
     const providers = config.providers ?? []
     if (lastSeenModelId) {
       const selectedProvider = resolveProviderForModelId(lastSeenModelId)
       if (selectedProvider) {
         if (isOpencodeGoProvider(selectedProvider) && resolveProviderApiKey(selectedProvider))
           return selectedProvider
         return null
       }
     }
     const defaultModels = flattenModels().filter(entry => isModelDefaultOn(entry.model))
     if (defaultModels.length === 0)
       return findFirstOpencodeProviderWithKey(providers)
     const defaultProvider = defaultModels[0].provider
     if (isOpencodeGoProvider(defaultProvider) && resolveProviderApiKey(defaultProvider))
       return defaultProvider
     return null
   }
   catch (error) {
     logger.warn({ error: (error as Error).message }, '[GO_USAGE] load providers failed')
     return null
   }
 }

 async function fetchGoUsageSnapshotUncached(provider: ProviderEntry): Promise<GoUsageSnapshot | null> {
   const apiKey = resolveProviderApiKey(provider)
   if (!apiKey)
     return null
   const url = buildZenUsageUrl(provider)
   const fetcher = pickFetchForProvider(provider)
   const viaProxy = Boolean(provider.proxyUrl?.trim())
   let response: Response
   try {
     response = await fetcher(url, {
       method: 'GET',
       headers: {
         'Accept': 'application/json',
         'Authorization': `Bearer ${apiKey}`,
         'User-Agent': GO_USAGE_USER_AGENT,
       },
       redirect: 'manual',
       signal: AbortSignal.timeout(GO_USAGE_FETCH_TIMEOUT_MS),
     })
   }
   catch (error) {
     logger.warn({ providerId: provider.id, viaProxy, error: (error as Error).message }, '[GO_USAGE] fetch failed')
     return null
   }
   const responseType = (response as Response & { type?: string }).type ?? ''
   if (response.status === 0 || responseType === 'opaqueredirect') {
     logger.warn({ providerId: provider.id, viaProxy }, '[GO_USAGE] redirected (opaqueredirect)')
     return null
   }
   if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
     const location = response.headers?.get?.('location') ?? ''
     logger.warn({
       providerId: provider.id,
       status: response.status,
       location: location.slice(0, 200),
       viaProxy,
     }, '[GO_USAGE] redirected - endpoint moved?')
     return null
   }
   if (response.status === 401) {
     logger.warn({ providerId: provider.id, viaProxy }, '[GO_USAGE] 401 - Go API key rejected')
     return null
   }
   if (response.status === 403) {
     logger.warn({ providerId: provider.id, viaProxy }, '[GO_USAGE] 403 - key valid but no Go subscription')
     return null
   }
   if (!response.ok) {
     logger.warn({ providerId: provider.id, status: response.status, viaProxy }, '[GO_USAGE] unexpected status')
     return null
   }
   const bodyText = await response.text().catch(() => '')
   if (!bodyText) {
     logger.warn({ providerId: provider.id }, '[GO_USAGE] empty response body')
     return null
   }
   let payload: unknown = null
   try {
     payload = JSON.parse(bodyText)
   }
   catch {
     logger.warn({ providerId: provider.id, sampleLength: bodyText.length }, '[GO_USAGE] non-JSON response')
     return null
   }
   const snapshot = parseZenUsagePayload(payload)
   if (!snapshot) {
     const topLevelKeys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : []
     logger.warn({ providerId: provider.id, topLevelKeys }, '[GO_USAGE] unrecognised usage shape')
     return null
   }
   logger.info({
     providerId: provider.id,
     rolling: snapshot.rolling.percent,
     weekly: snapshot.weekly.percent,
     monthly: snapshot.monthly.percent,
   }, '[GO_USAGE] fetched')
   return snapshot
 }

function getCachedSnapshot(providerId: string): GoUsageSnapshot | null {
  return usageCache.get(providerId)?.snapshot ?? null
}

function fetchAndStoreSnapshot(provider: ProviderEntry): Promise<GoUsageSnapshot | null> {
  const inflight = inflightRequests.get(provider.id)
  if (inflight)
    return inflight
  const task = (async () => {
    try {
      const snapshot = await fetchGoUsageSnapshotUncached(provider)
      if (snapshot)
        usageCache.set(provider.id, { snapshot })
      return snapshot
    }
    finally {
      inflightRequests.delete(provider.id)
    }
  })()
  inflightRequests.set(provider.id, task)
  return task
}

/**
 * Display-path read: serve the cached snapshot; fetch only when the cache is
 * empty (first display). Never refetches on a timer - freshness comes from
 * refreshGoUsageAfterConversation after each completed conversation.
 */
export async function getGoUsageSnapshot(provider: ProviderEntry): Promise<GoUsageSnapshot | null> {
  return getCachedSnapshot(provider.id) ?? fetchAndStoreSnapshot(provider)
}

/**
 * Conversation-end refresh: force a fresh Zen fetch for the currently active
 * Go provider and update the cache. Called by agentOrchestrator after each
 * completed conversation run. Resolves null (no fetch) when the selected
 * model is not on an opencode Go provider.
 */
export async function refreshGoUsageAfterConversation(): Promise<GoUsageSnapshot | null> {
  const provider = getActiveGoUsageProvider()
  if (!provider)
    return null
  return fetchAndStoreSnapshot(provider)
}

 function formatResetDuration(resetInSec?: number): string {
   if (resetInSec === undefined || !Number.isFinite(resetInSec) || resetInSec < 0)
     return ''
   const totalMinutes = Math.max(1, Math.round(resetInSec / 60))
   if (totalMinutes < 60)
     return `${totalMinutes}m`
   const totalHours = Math.floor(totalMinutes / 60)
   const restMinutes = totalMinutes % 60
   if (totalHours < 24)
     return restMinutes > 0 ? `${totalHours}h${restMinutes}m` : `${totalHours}h`
   const days = Math.floor(totalHours / 24)
   const restHours = totalHours % 24
   return restHours > 0 ? `${days}d${restHours}h` : `${days}d`
 }

 function formatWindowShort(percent: number, resetInSec?: number): string {
   const reset = formatResetDuration(resetInSec)
   const rounded = Math.round(percent)
   return reset ? `${rounded}%(${reset})` : `${rounded}%`
 }

/** Chat slot text: `Go 5h 42%(1h21m) · Week 18%(1d1h) · Month 9%(20d1h)`, caller falls back on null. */
export function formatGoUsageDisplay(snapshot: GoUsageSnapshot): string {
  const rollingText = formatWindowShort(snapshot.rolling.percent, snapshot.rolling.resetInSec)
  const weeklyText = formatWindowShort(snapshot.weekly.percent, snapshot.weekly.resetInSec)
  const monthlyText = formatWindowShort(snapshot.monthly.percent, snapshot.monthly.resetInSec)
  return `Go 5h ${rollingText} · Week ${weeklyText} · Month ${monthlyText}`
}

 /**
  * Dashboard text entry - called by GetCurrentPeriodUsage.
  * Any miss or failure falls back to `BYOK — unlimited`, never blocks chat.
  */
 export async function getGoUsageDisplayMessage(): Promise<string> {
   const provider = getActiveGoUsageProvider()
   if (!provider)
     return GO_USAGE_FALLBACK_MESSAGE
   const snapshot = await getGoUsageSnapshot(provider).catch((error) => {
     logger.warn({ providerId: provider.id, error: (error as Error).message }, '[GO_USAGE] snapshot failed')
     return null
   })
   if (!snapshot)
     return GO_USAGE_FALLBACK_MESSAGE
   return formatGoUsageDisplay(snapshot)
 }

 /** Tests: clear cache, inflight and last-seen model. */
 export function resetGoUsageCacheForTests(): void {
   usageCache.clear()
   inflightRequests.clear()
   lastSeenModelId = ''
 }

 /** Tests: clear only the last-seen model id. */
 export function resetGoUsageModelSeenForTests(): void {
   lastSeenModelId = ''
 }
