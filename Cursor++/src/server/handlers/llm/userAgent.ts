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
 * Header templates:
 *   Custom header values may include `${conversationId}` (and future vars).
 *   Templated headers are resolved per LLM request; static headers stay on
 *   the SDK client as defaultHeaders. Example for OpenCode Go:
 *     { "x-opencode-session": "${conversationId}" }
 *   plus optional static headers like `{ "User-Agent": "Cursor++/<version> (ccursor)" }`.
 */
import os from 'node:os'
import type { ProviderType } from '../../data/defaults'
import { logger } from '../../logger'

const CLAUDE_CODE_VERSION = '2.1.154'
const CODEX_VERSION = '0.133.0'

/** Common gateway sticky / prompt-cache session header name. */
export const SESSION_AFFINITY_HEADER = 'x-opencode-session'

const SESSION_HEADER_MAX_LEN = 128
// Detection regex is intentionally non-global so `test()` stays stateless
// (a shared `/g` regex would carry `lastIndex` between calls).
const HEADER_TEMPLATE_DETECT_RE = /\$\{[a-zA-Z_][a-zA-Z0-9_]*\}/
const HEADER_TEMPLATE_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

export interface HeaderResolveContext {
    conversationId?: string
}

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

/**
 * Sanitize an opaque session id for use as x-opencode-session (clamp ≤128).
 *
 * Unsafe runs collapse to a single underscore; leading/trailing underscores
 * are trimmed, so e.g. `"_abc_"` becomes `"abc"`. For opaque ids this is
 * fine, but callers should not rely on round-trip fidelity.
 */
export function sanitizeSessionId(id: string): string {
    const trimmed = id.trim()
    if (!trimmed) return ''
    // Keep opaque ids readable; replace runs of unsafe chars with underscore.
    return trimmed.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, SESSION_HEADER_MAX_LEN)
}

export function headerValueHasTemplate(value: string): boolean {
    return HEADER_TEMPLATE_DETECT_RE.test(value)
}

/** Split custom headers into static (client defaultHeaders) vs templated (per-request). */
export function partitionCustomHeaders(customHeaders?: Record<string, string>): {
    staticHeaders: Record<string, string>
    templatedHeaders: Record<string, string>
} {
    const staticHeaders: Record<string, string> = {}
    const templatedHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(customHeaders ?? {})) {
        if (headerValueHasTemplate(value))
            templatedHeaders[key] = value
        else
            staticHeaders[key] = value
    }
    return { staticHeaders, templatedHeaders }
}

function buildTemplateVars(ctx: HeaderResolveContext): Record<string, string> {
    return {
        conversationId: ctx.conversationId?.trim() ?? '',
    }
}

/**
 * Resolve `${var}` placeholders in header values.
 *
 * Unknown vars expand to empty string (and warn, since it is almost always
 * a typo like `${conversatonId}`). Keys whose value is empty after
 * resolution are omitted (so `${conversationId}` alone is skipped when
 * there is no conversation yet). `x-opencode-session` is sanitized.
 */
export function resolveHeaderTemplates(
    templates: Record<string, string> | undefined,
    ctx: HeaderResolveContext,
): Record<string, string> | undefined {
    if (!templates || Object.keys(templates).length === 0)
        return undefined

    const vars = buildTemplateVars(ctx)
    const out: Record<string, string> = {}

    for (const [key, template] of Object.entries(templates)) {
        const resolved = template.replace(HEADER_TEMPLATE_RE, (_match, name: string) => {
            if (Object.prototype.hasOwnProperty.call(vars, name))
                return vars[name]!
            logger.warn({ headerKey: key, varName: name, template }, '[HEADERS] unknown template variable expanded to empty string')
            return ''
        })
        let value = resolved.trim()
        if (key.toLowerCase() === SESSION_AFFINITY_HEADER)
            value = sanitizeSessionId(value)
        if (value)
            out[key] = value
    }

    return Object.keys(out).length > 0 ? out : undefined
}

/** Resolve only the templated subset of ProviderEntry.headers for one request. */
export function buildTemplatedRequestHeaders(
    customHeaders: Record<string, string> | undefined,
    ctx: HeaderResolveContext,
): Record<string, string> | undefined {
    const { templatedHeaders } = partitionCustomHeaders(customHeaders)
    return resolveHeaderTemplates(templatedHeaders, ctx)
}
