/**
 * 默认 User-Agent 字符串
 *
 * 按 provider type 对齐官方 CLI 产品的 UA 格式:
 *   - Anthropic → Claude Code: `claude-cli/{version} (external, cli)`
 *   - OpenAI    → Codex CLI:   `codex_cli_rs/{version} ({os}; {arch})`
 *   - Gemini    → 不覆盖 (SDK 默认)
 *
 * 用户可通过 ProviderEntry.headers 中的 "User-Agent" 字段覆盖。
 *
 * Session affinity:
 *   Outbound LLM requests may also carry `x-opencode-session` for gateway
 *   sticky routing / prompt-cache affinity (e.g. OpenCode Go).
 *   Prefer the live conversationId; fall back to a static value in
 *   ProviderEntry.headers when no conversation id is available.
 */
import os from 'node:os'
import type { ProviderType } from '../../data/defaults'

const CLAUDE_CODE_VERSION = '2.1.154'
const CODEX_VERSION = '0.133.0'

/** Gateway sticky / prompt-cache session header (OpenCode Go and similar). */
export const SESSION_AFFINITY_HEADER = 'x-opencode-session'

const SESSION_HEADER_MAX_LEN = 128

function getOsToken(): string {
    const platform = os.platform()
    const release = os.release()
    const arch = os.arch()
    const osName = platform === 'darwin' ? 'Mac OS' : platform === 'win32' ? 'Windows' : 'Linux'
    return `${osName} ${release}; ${arch}`
}

const UA_BY_PROVIDER_TYPE: Partial<Record<ProviderType, string>> = {
    'anthropic': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    'openai-responses': `codex_cli_rs/${CODEX_VERSION} (${getOsToken()})`,
}

export function getDefaultUserAgent(providerType: ProviderType): string | undefined {
    return UA_BY_PROVIDER_TYPE[providerType]
}

export function buildDefaultHeaders(
    providerType: ProviderType,
    customHeaders?: Record<string, string>,
): Record<string, string> | undefined {
    const ua = getDefaultUserAgent(providerType)
    if (!ua && !customHeaders) return undefined

    const headers: Record<string, string> = {}
    if (ua) headers['User-Agent'] = ua
    if (customHeaders) Object.assign(headers, customHeaders)
    return Object.keys(headers).length > 0 ? headers : undefined
}

/** Sanitize an opaque session id for use as x-opencode-session (clamp ≤128). */
export function sanitizeSessionId(id: string): string {
    const trimmed = id.trim()
    if (!trimmed) return ''
    // Keep opaque ids readable; replace runs of unsafe chars with underscore.
    return trimmed.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, SESSION_HEADER_MAX_LEN)
}

function lookupHeaderIgnoreCase(
    headers: Record<string, string> | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined
    const target = name.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target)
            return value
    }
    return undefined
}

/**
 * Resolve x-opencode-session for one LLM request.
 *
 * Precedence: non-empty conversationId (sanitized) wins over a static
 * ProviderEntry.headers value. Returns undefined when neither is set.
 */
export function resolveSessionAffinityHeader(
    conversationId?: string,
    customHeaders?: Record<string, string>,
): string | undefined {
    const fromConversation = conversationId?.trim() ? sanitizeSessionId(conversationId) : ''
    if (fromConversation)
        return fromConversation

    const staticRaw = lookupHeaderIgnoreCase(customHeaders, SESSION_AFFINITY_HEADER)
    const fromStatic = staticRaw?.trim() ? sanitizeSessionId(staticRaw) : ''
    return fromStatic || undefined
}

/**
 * Per-request headers that override client defaultHeaders for this call.
 *
 * Only emitted when conversationId is present so the dynamic value wins over
 * any static x-opencode-session baked into defaultHeaders. When only a static
 * value exists, defaultHeaders already carry it — no per-request duplicate.
 */
export function buildSessionAffinityRequestHeaders(
    conversationId?: string,
    customHeaders?: Record<string, string>,
): Record<string, string> | undefined {
    if (!conversationId?.trim())
        return undefined
    const value = resolveSessionAffinityHeader(conversationId, customHeaders)
    if (!value) return undefined
    return { [SESSION_AFFINITY_HEADER]: value }
}
