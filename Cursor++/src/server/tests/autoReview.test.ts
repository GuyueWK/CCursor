import type { AutoReviewRuntimeConfig } from '../handlers/agent/autoReview'
import { describe, expect, it } from 'vitest'
import { getAutoReviewModelId, setProvidersForTests } from '../config/providersStore'
import {
  applyAutoReviewToArgs,
  attachSmartModeSchema,
  buildAutoReviewBlockResult,
  buildClassifierPrompt,
  buildConversationContext,
  parseClassifierResponse,
  parseSmartModeApprovalRequest,
  reviewRiskyToolCall,
} from '../handlers/agent/autoReview'
import { parseRunRequest } from '../handlers/agent/protocol'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { listBuiltinLlmTools } from '../handlers/agent/toolkit/registry'
import { resolveToolCall } from '../handlers/agent/tools'
import { installTestProviders } from './setup'

const EMPTY_PERMISSIONS = {
  user: { allowInstructions: [] as string[], blockInstructions: [] as string[] },
  project: { allowInstructions: [] as string[], blockInstructions: [] as string[] },
  admin: { allowInstructions: [] as string[], blockInstructions: [] as string[] },
}

function config(overrides: Partial<AutoReviewRuntimeConfig> = {}): AutoReviewRuntimeConfig {
  return {
    enabled: true,
    currentModelId: 'claude-sonnet-4',
    conversationId: 'conv-auto-review',
    sandboxEnabled: false,
    sandboxSupported: false,
    permissions: EMPTY_PERMISSIONS,
    ...overrides,
  }
}

async function drain<T>(gen: AsyncGenerator<unknown, T, void>): Promise<T> {
  while (true) {
    const next = await gen.next()
    if (next.done)
      return next.value
  }
}

describe('parseClassifierResponse', () => {
  it('parses allow and block JSON', () => {
    expect(parseClassifierResponse('{"decision":"allow"}')).toEqual({ decision: 'allow', reason: undefined })
    expect(parseClassifierResponse('{"decision":"BLOCK","reason":"rm -rf is destructive"}')).toEqual({
      decision: 'block',
      reason: 'rm -rf is destructive',
    })
  })

  it('extracts JSON from a fenced block', () => {
    expect(parseClassifierResponse('Sure.\n```json\n{"decision":"allow"}\n```')).toEqual({
      decision: 'allow',
      reason: undefined,
    })
  })

  it('returns null for garbage', () => {
    expect(parseClassifierResponse('I cannot decide')).toBeNull()
    expect(parseClassifierResponse('')).toBeNull()
  })
})

describe('parseSmartModeApprovalRequest', () => {
  it('requires both the retry flag and the original block reason', () => {
    expect(parseSmartModeApprovalRequest({ request_smart_mode_approval: true }, 'c1')).toBeUndefined()
    expect(parseSmartModeApprovalRequest({
      request_smart_mode_approval: true,
      smartModeBlockReason: 'destructive',
    }, 'c1')).toEqual({ requestId: 'c1', reason: 'destructive' })
    expect(parseSmartModeApprovalRequest({
      requestSmartModeApproval: true,
      smartModeBlockReason: 'mcp writes prod',
    }, 'c2')).toEqual({ requestId: 'c2', reason: 'mcp writes prod' })
    expect(parseSmartModeApprovalRequest({
      args: {
        requestSmartModeApproval: true,
        smartModeBlockReason: 'nested envelope',
      },
    }, 'c3')).toEqual({ requestId: 'c3', reason: 'nested envelope' })
  })
})

describe('reviewRiskyToolCall', () => {
  it('passthrough when Auto-review is off', async () => {
    const decision = await drain(reviewRiskyToolCall({
      config: config({ enabled: false }),
      session: null,
      cursorToolType: 'shellToolCall',
      input: { command: 'ls' },
      callId: 'call-1',
      messages: [],
      allocateExecMessageId: () => 1,
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })

  it('skips classifier when the agent requests the native approval card', async () => {
    const decision = await drain(reviewRiskyToolCall({
      config: config(),
      session: null,
      cursorToolType: 'shellToolCall',
      input: {
        command: 'rm -rf dist',
        request_smart_mode_approval: true,
        smartModeBlockReason: 'destructive',
      },
      callId: 'call-2',
      messages: [],
      allocateExecMessageId: () => 1,
    }))
    expect(decision).toEqual({
      kind: 'execute',
      skipApproval: false,
      sandbox: false,
      smartModeApproval: { requestId: 'call-2', reason: 'destructive' },
    })
  })

  it('auto-runs allowlisted calls without classifying', async () => {
    const session = createEphemeralSession('allowlist')
    pushSessionMessage(session, {
      execClientMessage: { id: 7, shellAllowlistPrecheckResult: { allowlisted: true } },
    })
    pushSessionMessage(session, {
      execClientControlMessage: { streamClose: { id: 7 } },
    })
    const decision = await drain(reviewRiskyToolCall({
      config: config(),
      session,
      cursorToolType: 'shellToolCall',
      input: { command: 'git status' },
      callId: 'call-3',
      messages: [],
      allocateExecMessageId: () => 7,
    }))
    expect(decision).toEqual({ kind: 'execute', skipApproval: true, sandbox: false })
  })

  it('sandboxes non-allowlisted shell when the client supports it', async () => {
    const decision = await drain(reviewRiskyToolCall({
      config: config({ sandboxEnabled: true, sandboxSupported: true }),
      session: null,
      cursorToolType: 'shellToolCall',
      input: { command: 'ls' },
      callId: 'call-4',
      messages: [],
      allocateExecMessageId: () => 1,
    }))
    expect(decision).toEqual({ kind: 'execute', skipApproval: true, sandbox: true })
  })

  it('returns classifier allow / block', async () => {
    const allowed = await drain(reviewRiskyToolCall({
      config: config(),
      session: null,
      cursorToolType: 'webFetchToolCall',
      input: { url: 'https://example.com' },
      callId: 'call-5',
      messages: [],
      allocateExecMessageId: () => 1,
      classify: async () => ({ decision: 'allow' }),
    }))
    expect(allowed).toEqual({ kind: 'execute', skipApproval: true, sandbox: false })

    const blocked = await drain(reviewRiskyToolCall({
      config: config(),
      session: null,
      cursorToolType: 'mcpToolCall',
      input: { toolName: 'delete_repo' },
      callId: 'call-6',
      messages: [],
      allocateExecMessageId: () => 1,
      classify: async () => ({ decision: 'block', reason: 'deletes remote resources' }),
    }))
    expect(blocked).toEqual({ kind: 'block', reason: 'deletes remote resources' })
  })

  it('falls back to native approval when the classifier throws', async () => {
    const decision = await drain(reviewRiskyToolCall({
      config: config(),
      session: null,
      cursorToolType: 'webFetchToolCall',
      input: { url: 'https://example.com' },
      callId: 'call-7',
      messages: [],
      allocateExecMessageId: () => 1,
      classify: async () => {
        throw new Error('upstream 529')
      },
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })
})

describe('auto-review helpers', () => {
  it('applies skipApproval and sandbox policy to shell exec args', () => {
    const args = applyAutoReviewToArgs(
      { command: 'ls', skipApproval: false },
      'shellToolCall',
      { kind: 'execute', skipApproval: true, sandbox: true },
    )
    expect(args.skipApproval).toBe(true)
    expect(args.requestedSandboxPolicy).toEqual({ type: 2 })
  })

  it('puts the retry hint into the block result', () => {
    const result = buildAutoReviewBlockResult('shellToolCall', 'destructive', { command: 'rm' })
    expect(result.result.case).toBe('error')
    expect(String((result.result.value as Record<string, unknown>).message)).toContain('request_smart_mode_approval=true')
  })

  it('attaches smart-mode params to Shell and CallDynamicTool schemas', () => {
    const shell = listBuiltinLlmTools('anthropic').find(tool => tool.name === 'Shell')
    const call = listBuiltinLlmTools('openai-chat').find(tool => tool.name === 'CallDynamicTool')
    const fetch = listBuiltinLlmTools('gemini').find(tool => tool.name === 'WebFetch')
    expect(shell?.inputSchema.properties).toHaveProperty('request_smart_mode_approval')
    expect(call?.inputSchema.properties).toHaveProperty('requestSmartModeApproval')
    expect(fetch?.inputSchema.properties).toHaveProperty('requestSmartModeApproval')
    const geminiProp = (fetch?.inputSchema.properties as Record<string, { type: string }>)?.requestSmartModeApproval
    expect(geminiProp?.type).toBe('BOOLEAN')
  })

  it('keeps CallDynamicTool smart-mode fields when unpacking to a native tool', () => {
    const resolved = resolveToolCall('CallDynamicTool', {
      namespace: 'cursor',
      toolName: 'Shell',
      arguments: { command: 'git status' },
      requestSmartModeApproval: true,
      smartModeBlockReason: 'needs approval',
    }, [], [{ tool: 'Shell' }])
    expect(resolved.cursorToolType).toBe('shellToolCall')
    expect(resolved.sanitizedInput.requestSmartModeApproval).toBe(true)
    expect(resolved.sanitizedInput.smartModeBlockReason).toBe('needs approval')
  })

  it('builds conversation context without system messages', () => {
    const ctx = buildConversationContext([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(ctx).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('includes allow/block instructions in the classifier prompt', () => {
    const prompt = buildClassifierPrompt({
      action: 'Shell',
      arguments: { command: 'aws s3 rm s3://prod' },
      conversation: [],
      permissions: {
        ...EMPTY_PERMISSIONS,
        user: { allowInstructions: [], blockInstructions: ['Every AWS CLI command should go through approval first.'] },
      },
      conversationId: 'c',
      currentModelId: 'claude-sonnet-4',
    })
    expect(prompt).toContain('Every AWS CLI command should go through approval first.')
    expect(prompt).toContain('aws s3 rm')
  })
})

describe('parseRunRequest auto-review fields', () => {
  it('extracts classifier auto mode and permissions.json instructions', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c-ar',
        action: {
          userMessageAction: {
            userMessage: { text: 'hi', mode: 'AGENT_MODE_AGENT' },
            requestContext: {
              env: {
                smartModeClassifierAutoModeEnabled: true,
                sandboxEnabled: true,
                sandboxSupported: true,
              },
              userPermissionsAutoRun: {
                allowInstructions: ['git status is always fine'],
                blockInstructions: [],
              },
              projectPermissionsAutoRun: {
                allowInstructions: [],
                blockInstructions: ['Do not push to main'],
              },
            },
          },
        },
        modelDetails: { modelId: 'claude-sonnet-4' },
      },
    })
    expect(parsed.env.smartModeClassifierAutoModeEnabled).toBe(true)
    expect(parsed.permissionsAutoRun.user.allowInstructions).toEqual(['git status is always fine'])
    expect(parsed.permissionsAutoRun.project.blockInstructions).toEqual(['Do not push to main'])
  })
})

describe('providers.json autoReviewModelId', () => {
  it('round-trips the selected classifier model', () => {
    try {
      setProvidersForTests({
        $schemaVersion: 1,
        autoReviewModelId: 'glm-5',
        providers: [{
          id: 'p',
          name: 'P',
          type: 'anthropic',
          baseUrl: '',
          auth: { kind: 'apiKey', value: 'k' },
          models: [{
            id: 'glm-5',
            apiModel: 'glm-5',
            displayName: 'GLM 5',
            thinking: false,
            contextTokenLimit: 200000,
          }],
        }],
      })
      expect(getAutoReviewModelId()).toBe('glm-5')
    }
    finally {
      installTestProviders()
    }
  })
})

describe('attachSmartModeSchema is a copy', () => {
  it('does not mutate the original tool object', () => {
    const original = {
      name: 'Shell',
      description: 'x',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    }
    const attached = attachSmartModeSchema(original, 'anthropic')
    expect(original.inputSchema.properties).not.toHaveProperty('request_smart_mode_approval')
    expect(attached.inputSchema.properties).toHaveProperty('request_smart_mode_approval')
  })
})
