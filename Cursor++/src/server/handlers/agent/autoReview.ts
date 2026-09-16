/**
 * Local Auto-review — allowlist → optional sandbox → BYOK classifier.
 *
 * Cursor 官方 classifier 跑在托管模型上,BYOK 拦流后接不上。这里在同一条
 * Agent exec 通道上复刻官方三步,用用户自选的 providers.json 模型做判定。
 */
import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { getAutoReviewModelId, lookupModel } from '../../config/providersStore'
import { logger } from '../../logger'
import { resolveProviderRuntime } from '../llm/providerRuntime'
import { ModelNotFoundError } from '../models/mapper'
import type { LLMMessage, LLMStreamEvent } from '../llm/types'
import type { ParsedPermissionsAutoRun } from './protocol/types'
import type { AgentSession } from './session'
import { execMessage } from './stream'
import {
    waitForExecClientMessageWithHeartbeat,
    waitForExecStreamCloseWithHeartbeat,
    waitForPromiseWithHeartbeat,
} from './wait'
import type { ToolResultEnvelope } from './toolResults'

export const AUTO_REVIEW_TARGET_TYPES = new Set([
    'shellToolCall',
    'mcpToolCall',
    'webFetchToolCall',
    'readMcpResourceToolCall',
])

const ALLOWLIST_PRECHECK_TIMEOUT_MS = 10_000
const CLASSIFIER_TIMEOUT_MS = 20_000
const CLASSIFIER_MAX_TOKENS = 512
const CONVERSATION_CONTEXT_LIMIT = 8
const CONVERSATION_MESSAGE_CHARS = 800
const ARGUMENTS_CHARS = 4_000

const CLASSIFIER_SYSTEM = `You are Cursor's Auto-review classifier. Decide whether one tool call is safe to run automatically, without a human clicking Approve.

Reply with ONLY compact JSON, no markdown:
{"decision":"allow"}
or
{"decision":"block","reason":"<one sentence the parent agent can use>"}

ALLOW when the action is routine, reversible, scoped to the workspace, or matches allow_instructions.
BLOCK when it is destructive, exfiltrating, privileged, irreversible, matches block_instructions, or you are unsure.

This is not a security boundary. Bias toward blocking when uncertain.`

export interface SmartModeApprovalPayload {
    requestId: string
    reason: string
}

export interface AutoReviewRuntimeConfig {
    enabled: boolean
    forceBlockToken?: string
    currentModelId: string
    conversationId: string
    sandboxEnabled: boolean
    sandboxSupported: boolean
    permissions: {
        user: ParsedPermissionsAutoRun
        project: ParsedPermissionsAutoRun
        admin: ParsedPermissionsAutoRun
    }
}

export type AutoReviewDecision
    = | { kind: 'passthrough' }
        | { kind: 'block', reason: string }
        | {
            kind: 'execute'
            skipApproval: boolean
            sandbox: boolean
            smartModeApproval?: SmartModeApprovalPayload
        }

export interface ClassifierInput {
    action: string
    arguments: Record<string, unknown>
    conversation: Array<{ role: string, content: string }>
    permissions: AutoReviewRuntimeConfig['permissions']
    conversationId: string
    currentModelId: string
}

export type ClassifierFn = (input: ClassifierInput) => Promise<{ decision: 'allow' | 'block', reason?: string }>

const SMART_MODE_KEYS = [
    'request_smart_mode_approval',
    'requestSmartModeApproval',
    'smartModeBlockReason',
    'smart_mode_block_reason',
] as const

export function isAutoReviewTarget(cursorToolType: string): boolean {
    return AUTO_REVIEW_TARGET_TYPES.has(cursorToolType)
}

export function pickSmartModeFields(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of SMART_MODE_KEYS) {
        if (input[key] !== undefined)
            out[key] = input[key]
    }
    return out
}

function isTruthy(value: unknown): boolean {
    return value === true || value === 1 || value === 'true' || value === '1'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function parseSmartModeApprovalFromRecord(
    input: Record<string, unknown>,
    callId: string,
): SmartModeApprovalPayload | undefined {
    const requested = isTruthy(input.request_smart_mode_approval) || isTruthy(input.requestSmartModeApproval)
    if (!requested)
        return undefined
    const reason = typeof input.smartModeBlockReason === 'string'
        ? input.smartModeBlockReason
        : typeof input.smart_mode_block_reason === 'string'
            ? input.smart_mode_block_reason
            : ''
    if (!reason.trim())
        return undefined
    return { requestId: callId, reason: reason.trim() }
}

export function parseSmartModeApprovalRequest(
    input: Record<string, unknown>,
    callId: string,
): SmartModeApprovalPayload | undefined {
    const nested = asRecord(input.args) ?? asRecord(input.arguments)
    return parseSmartModeApprovalFromRecord(input, callId)
        ?? (nested ? parseSmartModeApprovalFromRecord(nested, callId) : undefined)
}

export function parseClassifierResponse(text: string): { decision: 'allow' | 'block', reason?: string } | null {
    const trimmed = text.trim()
    if (!trimmed)
        return null
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const candidate = (fenced?.[1] ?? trimmed).trim()
    const jsonMatch = candidate.match(/\{[\s\S]*\}/)
    if (!jsonMatch)
        return null
    try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
        const raw = String(parsed.decision ?? parsed.Decision ?? '').trim().toLowerCase()
        if (raw === 'allow' || raw === 'allowed')
            return { decision: 'allow', reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
        if (raw === 'block' || raw === 'blocked' || raw === 'deny' || raw === 'denied')
            return { decision: 'block', reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Auto-review blocked this call.' }
        return null
    }
    catch {
        return null
    }
}

export function buildConversationContext(messages: LLMMessage[], limit = CONVERSATION_CONTEXT_LIMIT): Array<{ role: string, content: string }> {
    const flattened: Array<{ role: string, content: string }> = []
    for (const message of messages) {
        if (message.role === 'system')
            continue
        const content = flattenMessageContent(message)
        if (!content)
            continue
        flattened.push({
            role: message.role,
            content: content.length > CONVERSATION_MESSAGE_CHARS
                ? `${content.slice(0, CONVERSATION_MESSAGE_CHARS)}…`
                : content,
        })
    }
    return flattened.slice(-limit)
}

function flattenMessageContent(message: LLMMessage): string {
    if (typeof message.content === 'string')
        return message.content.trim()
    return message.content
        .map((block) => {
            if (block.type === 'text')
                return block.text
            if (block.type === 'tool_use')
                return `[tool_use ${block.name}]`
            if (block.type === 'tool_result')
                return `[tool_result ${block.toolName ?? block.toolUseId}]`
            return ''
        })
        .filter(Boolean)
        .join('\n')
        .trim()
}

function actionLabel(cursorToolType: string): string {
    switch (cursorToolType) {
        case 'shellToolCall': return 'Shell'
        case 'mcpToolCall': return 'MCP'
        case 'webFetchToolCall': return 'WebFetch'
        case 'readMcpResourceToolCall': return 'FetchMcpResource'
        default: return cursorToolType
    }
}

function stripSmartModeFields(input: Record<string, unknown>): Record<string, unknown> {
    const out = { ...input }
    for (const key of SMART_MODE_KEYS)
        delete out[key]
    return out
}

function mergeInstructions(permissions: AutoReviewRuntimeConfig['permissions']): { allow: string[], block: string[] } {
    return {
        allow: [
            ...permissions.admin.allowInstructions,
            ...permissions.project.allowInstructions,
            ...permissions.user.allowInstructions,
        ],
        block: [
            ...permissions.admin.blockInstructions,
            ...permissions.project.blockInstructions,
            ...permissions.user.blockInstructions,
        ],
    }
}

export function buildClassifierPrompt(input: ClassifierInput): string {
    const merged = mergeInstructions(input.permissions)
    const argsJson = JSON.stringify(input.arguments)
    const args = argsJson.length > ARGUMENTS_CHARS ? `${argsJson.slice(0, ARGUMENTS_CHARS)}…` : argsJson
    const lines = [
        `Action: ${input.action}`,
        `Arguments: ${args}`,
    ]
    if (merged.allow.length > 0) {
        lines.push('Allow instructions:')
        for (const item of merged.allow)
            lines.push(`- ${item}`)
    }
    if (merged.block.length > 0) {
        lines.push('Block instructions:')
        for (const item of merged.block)
            lines.push(`- ${item}`)
    }
    if (input.conversation.length > 0) {
        lines.push('Recent conversation:')
        for (const message of input.conversation)
            lines.push(`${message.role}: ${message.content}`)
    }
    return lines.join('\n')
}

function resolveClassifierModelId(currentModelId: string): string {
    const configured = getAutoReviewModelId()
    if (configured && lookupModel(configured))
        return configured
    if (configured) {
        logger.warn({ configured, fallback: currentModelId }, '[AUTO-REVIEW] configured classifier model not in providers.json — falling back to current Agent model')
    }
    return currentModelId
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (error) => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}

async function collectClassifierText(stream: AsyncIterable<LLMStreamEvent>): Promise<string> {
    let text = ''
    for await (const event of stream) {
        if (event.type === 'text_delta')
            text += event.text
    }
    return text
}

export async function runDefaultClassifier(input: ClassifierInput): Promise<{ decision: 'allow' | 'block', reason?: string }> {
    const modelId = resolveClassifierModelId(input.currentModelId)
    const runtime = resolveProviderRuntime(modelId)
    const prepared = runtime.prepareStreamRequest(
        [
            { role: 'system', content: CLASSIFIER_SYSTEM },
            { role: 'user', content: buildClassifierPrompt(input) },
        ],
        [],
        CLASSIFIER_MAX_TOKENS,
        undefined,
        { thinking: false },
        input.conversationId ? `${input.conversationId}-auto-review` : undefined,
        false,
        undefined,
        undefined,
        undefined,
        [],
    )
    prepared.request.thinking = false
    delete prepared.request.thinkingLevel
    delete prepared.request.thinkingBudgetTokens
    prepared.request.tools = []

    logger.info({ modelId, action: input.action }, '[AUTO-REVIEW] classifying tool call')
    const text = await withTimeout(
        collectClassifierText(runtime.provider.stream(prepared.request)),
        CLASSIFIER_TIMEOUT_MS,
        'classifier',
    )
    const parsed = parseClassifierResponse(text)
    if (!parsed)
        throw new Error(`classifier returned unparseable response: ${text.slice(0, 200)}`)
    return parsed
}

function canSandboxShell(cursorToolType: string, config: AutoReviewRuntimeConfig): boolean {
    return cursorToolType === 'shellToolCall'
        && config.sandboxEnabled === true
        && config.sandboxSupported === true
}

function buildAllowlistPrecheck(
    cursorToolType: string,
    input: Record<string, unknown>,
    callId: string,
): { argsType: string, args: Record<string, unknown> } | null {
    if (cursorToolType === 'shellToolCall') {
        const command = String(input.command ?? '')
        const workingDirectory = String(input.workingDirectory ?? input.cwd ?? '')
        const parts = command.trim().split(/\s+/).filter(Boolean)
        const cmdName = parts[0] || ''
        return {
            argsType: 'shellAllowlistPrecheckArgs',
            args: {
                command,
                workingDirectory,
                toolCallId: callId,
                parsingResult: parts.length > 0
                    ? {
                            executableCommands: [{
                                name: cmdName,
                                fullText: command,
                                args: parts.slice(1).map(value => ({ type: 'word', value })),
                            }],
                        }
                    : undefined,
            },
        }
    }
    if (cursorToolType === 'mcpToolCall') {
        return {
            argsType: 'mcpAllowlistPrecheckArgs',
            args: {
                providerIdentifier: String(input.providerIdentifier ?? input.provider ?? input.serverIdentifier ?? ''),
                toolName: String(input.toolName ?? input.tool_name ?? ''),
                toolCallId: callId,
            },
        }
    }
    if (cursorToolType === 'webFetchToolCall') {
        return {
            argsType: 'webFetchAllowlistPrecheckArgs',
            args: {
                url: String(input.url ?? ''),
                toolCallId: callId,
            },
        }
    }
    return null
}

function readAllowlisted(execClientMessage: Record<string, unknown> | undefined): boolean | null {
    if (!execClientMessage)
        return null
    const payloads = [
        execClientMessage.shellAllowlistPrecheckResult,
        execClientMessage.mcpAllowlistPrecheckResult,
        execClientMessage.webFetchAllowlistPrecheckResult,
    ]
    for (const payload of payloads) {
        if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).allowlisted === 'boolean')
            return (payload as Record<string, unknown>).allowlisted as boolean
    }
    return null
}

async function* precheckAllowlist(
    session: AgentSession,
    allocateExecMessageId: () => number,
    cursorToolType: string,
    input: Record<string, unknown>,
    callId: string,
): AsyncGenerator<AgentServerMessage, boolean, void> {
    const precheck = buildAllowlistPrecheck(cursorToolType, input, callId)
    if (!precheck)
        return false
    const execMessageId = allocateExecMessageId()
    yield execMessage(execMessageId, `${callId}-allowlist`, precheck.argsType, precheck.args)
    const msg = yield* waitForExecClientMessageWithHeartbeat(session, execMessageId, ALLOWLIST_PRECHECK_TIMEOUT_MS)
    if (!msg || !('execClientMessage' in msg)) {
        logger.warn({ cursorToolType, callId }, '[AUTO-REVIEW] allowlist precheck timed out — treating as not allowlisted')
        return false
    }
    yield* waitForExecStreamCloseWithHeartbeat(session, execMessageId, 5_000)
    const allowlisted = readAllowlisted(msg.execClientMessage as Record<string, unknown>)
    logger.info({ cursorToolType, callId, allowlisted }, '[AUTO-REVIEW] allowlist precheck')
    return allowlisted === true
}

export function applyAutoReviewToArgs(
    args: Record<string, unknown>,
    cursorToolType: string,
    decision: Extract<AutoReviewDecision, { kind: 'execute' }>,
): Record<string, unknown> {
    const next = { ...args }
    if (decision.skipApproval)
        next.skipApproval = true
    if (decision.smartModeApproval) {
        next.smartModeApproval = decision.smartModeApproval
        if (cursorToolType === 'mcpToolCall')
            next.smartModeApprovalOnly = true
    }
    if (decision.sandbox && cursorToolType === 'shellToolCall')
        next.requestedSandboxPolicy = { type: 2 }
    else
        delete next.requestedSandboxPolicy
    return next
}

export function buildAutoReviewBlockResult(
    cursorToolType: string,
    reason: string,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    const retryHint = [
        `Auto-review blocked this call: ${reason}`,
        '',
        'If this action is still required, retry the exact same call with request_smart_mode_approval=true (or requestSmartModeApproval=true) and smartModeBlockReason set to the block reason above. That shows a native approval card instead of re-running the classifier.',
    ].join('\n')
    if (cursorToolType === 'webFetchToolCall') {
        return { result: { case: 'error', value: { url: String(input.url ?? ''), error: retryHint } } }
    }
    if (cursorToolType === 'mcpToolCall' || cursorToolType === 'readMcpResourceToolCall') {
        return { result: { case: 'error', value: { error: retryHint } } }
    }
    return { result: { case: 'error', value: { message: retryHint } } }
}

export async function* reviewRiskyToolCall(params: {
    config: AutoReviewRuntimeConfig | undefined
    session: AgentSession | null
    cursorToolType: string
    input: Record<string, unknown>
    callId: string
    messages: LLMMessage[]
    allocateExecMessageId: () => number
    classify?: ClassifierFn
}): AsyncGenerator<AgentServerMessage, AutoReviewDecision, void> {
    const config = params.config
    if (!config?.enabled || !isAutoReviewTarget(params.cursorToolType))
        return { kind: 'passthrough' }

    const approval = parseSmartModeApprovalRequest(params.input, params.callId)
    if (approval) {
        logger.info({ callId: params.callId, cursorToolType: params.cursorToolType }, '[AUTO-REVIEW] native approval card requested — skipping classifier')
        return { kind: 'execute', skipApproval: false, sandbox: false, smartModeApproval: approval }
    }

    if (params.session) {
        const allowlisted = yield* precheckAllowlist(
            params.session,
            params.allocateExecMessageId,
            params.cursorToolType,
            params.input,
            params.callId,
        )
        if (allowlisted)
            return { kind: 'execute', skipApproval: true, sandbox: false }
    }

    if (canSandboxShell(params.cursorToolType, config)) {
        logger.info({ callId: params.callId }, '[AUTO-REVIEW] running shell in sandbox')
        return { kind: 'execute', skipApproval: true, sandbox: true }
    }

    return yield* classifyRiskyToolCall({
        config,
        cursorToolType: params.cursorToolType,
        input: params.input,
        callId: params.callId,
        messages: params.messages,
        classify: params.classify,
    })
}

export async function* classifyRiskyToolCall(params: {
    config: AutoReviewRuntimeConfig
    cursorToolType: string
    input: Record<string, unknown>
    callId: string
    messages: LLMMessage[]
    classify?: ClassifierFn
}): AsyncGenerator<AgentServerMessage, AutoReviewDecision, void> {
    if (params.config.forceBlockToken) {
        logger.info({ callId: params.callId, token: params.config.forceBlockToken }, '[AUTO-REVIEW] forced block token')
        return { kind: 'block', reason: params.config.forceBlockToken }
    }

    const classify = params.classify ?? runDefaultClassifier
    try {
        const result = yield* waitForPromiseWithHeartbeat(classify({
            action: actionLabel(params.cursorToolType),
            arguments: stripSmartModeFields(params.input),
            conversation: buildConversationContext(params.messages),
            permissions: params.config.permissions,
            conversationId: params.config.conversationId,
            currentModelId: params.config.currentModelId,
        }))
        if (result.decision === 'block') {
            logger.info({ callId: params.callId, reason: result.reason }, '[AUTO-REVIEW] classifier blocked')
            return { kind: 'block', reason: result.reason ?? 'Auto-review blocked this call.' }
        }
        logger.info({ callId: params.callId }, '[AUTO-REVIEW] classifier allowed')
        return { kind: 'execute', skipApproval: true, sandbox: false }
    }
    catch (error) {
        const message = error instanceof ModelNotFoundError
            ? error.message
            : error instanceof Error ? error.message : String(error)
        logger.warn({ callId: params.callId, error: message }, '[AUTO-REVIEW] classifier failed — falling back to native approval')
        return { kind: 'passthrough' }
    }
}

export function attachSmartModeSchema(
    tool: { name: string, description: string, inputSchema: Record<string, unknown> },
    family: 'anthropic' | 'openai' | 'gemini',
): { name: string, description: string, inputSchema: Record<string, unknown> } {
    const gemini = family === 'gemini'
    const boolType = gemini ? 'BOOLEAN' : 'boolean'
    const stringType = gemini ? 'STRING' : 'string'
    const properties = tool.inputSchema.properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
        return tool

    const shell = tool.name === 'Shell'
    const camel = tool.name === 'CallDynamicTool' || tool.name === 'CallMcpTool'
        || tool.name === 'WebFetch' || tool.name === 'FetchMcpResource'
    if (!shell && !camel)
        return tool

    const extra: Record<string, unknown> = shell
        ? {
                request_smart_mode_approval: {
                    type: boolType,
                    description: 'Set to true when immediately retrying the exact same command after Auto-review blocks it and you decide the user should approve it through the native approval card.',
                },
                smartModeBlockReason: {
                    type: stringType,
                    description: 'Provide the exact block reason returned by Auto-review in the prior rejection. Required when request_smart_mode_approval is true so the approval card shows the original classifier reason without re-running the classifier.',
                },
            }
        : {
                requestSmartModeApproval: {
                    type: boolType,
                    description: 'Set to true when immediately retrying the exact same call after Auto-review blocks it and you decide the user should approve it through the native approval card.',
                },
                smartModeBlockReason: {
                    type: stringType,
                    description: 'Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier.',
                },
            }

    return {
        ...tool,
        inputSchema: {
            ...tool.inputSchema,
            properties: { ...(properties as Record<string, unknown>), ...extra },
        },
    }
}
