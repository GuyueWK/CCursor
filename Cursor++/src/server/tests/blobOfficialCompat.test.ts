import { toJson } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import {
  cachedBlobPayloadBytes,
  decodeBlob,
  encodeBlob,
  isJsonBlobPayload,
} from '../handlers/agent/blob'
import { cacheBlob, getCachedBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { hydrateHistoryEntries, rebuildConversationHistory, resetJsonBlobRewriteForTests, rewriteCachedJsonBlobsForOfficialClient } from '../handlers/agent/historyManager'
import { kvMessage } from '../handlers/agent/stream'
import { restoreBlobMessageToLLMMessage } from '../handlers/agent/transcript'
import { repairConversationHistory } from '../handlers/llm/transformMessages'

function kvBlobUtf8(frame: ReturnType<typeof kvMessage>): string {
  expect(frame.message.case).toBe('kvServerMessage')
  if (frame.message.case !== 'kvServerMessage')
    throw new Error('expected kvServerMessage')
  expect(frame.message.value.message.case).toBe('setBlobArgs')
  if (frame.message.value.message.case !== 'setBlobArgs')
    throw new Error('expected setBlobArgs')
  return Buffer.from(frame.message.value.message.value.blobData).toString('utf-8')
}

/** Mirrors official toRedacted* after JSON.parse — tool content must be .map-able. */
function assertOfficialCoreMessage(wire: unknown): void {
  expect(wire).toBeTypeOf('object')
  const msg = wire as { role: string, content: unknown }
  expect(['system', 'user', 'assistant', 'tool']).toContain(msg.role)

  if (msg.role === 'system') {
    expect(typeof msg.content).toBe('string')
    return
  }

  if (msg.role === 'tool') {
    expect(Array.isArray(msg.content), 'official toRedactedToolMessage does content.map').toBe(true)
    for (const part of msg.content as Array<Record<string, unknown>>) {
      expect(part.type).toBe('tool-result')
      expect(typeof part.toolCallId).toBe('string')
      expect(typeof part.toolName).toBe('string')
      const resultStr = typeof part.result === 'string' ? part.result : JSON.stringify(part.result)
      expect(typeof resultStr).toBe('string')
    }
    return
  }

  if (typeof msg.content === 'string')
    return

  expect(Array.isArray(msg.content)).toBe(true)
  for (const part of msg.content as Array<Record<string, unknown>>) {
    if (msg.role === 'user')
      expect(['text', 'image', 'file']).toContain(part.type)
    if (part.type === 'image')
      expect(part.image ?? part.data).toBeTruthy()
    if (part.type === 'tool-call') {
      expect(typeof part.toolCallId).toBe('string')
      expect(typeof part.toolName).toBe('string')
    }
  }
}

async function drainRewrite(blobIds: string[], start: number) {
  const frames: ReturnType<typeof kvMessage>[] = []
  const gen = rewriteCachedJsonBlobsForOfficialClient(kvMessage, 'conv-1', blobIds, start)
  let next = await gen.next()
  while (!next.done) {
    frames.push(next.value)
    next = await gen.next()
  }
  return { frames, counter: next.value }
}

function noopFrames() {
  return function* () {
    // no-op
  }
}

describe('encodeBlob official-compatible JSON payload', () => {
  it('writes user content as official text parts so JSON.parse + content.map succeed', () => {
    const blob = encodeBlob({ role: 'user', content: 'hi' })
    const wire = Buffer.from(blob.blobDataRaw).toString('utf-8')
    expect(wire.startsWith('{')).toBe(true)
    const parsed = JSON.parse(wire)
    expect(parsed).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    assertOfficialCoreMessage(parsed)
    expect(decodeBlob(blob.blobData)).toEqual(parsed)
    expect(restoreBlobMessageToLLMMessage(parsed)).toEqual({ role: 'user', content: 'hi' })
  })

  it('keeps assistant single-text as a string (official toCoreAssistantContent)', () => {
    const blob = encodeBlob({ role: 'assistant', content: 'ok' })
    const parsed = JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))
    expect(parsed).toEqual({ role: 'assistant', content: 'ok' })
    assertOfficialCoreMessage(parsed)

    const withRaw = kvMessage(1, blob.blobId, blob.blobData, blob.blobDataRaw)
    expect(JSON.parse(kvBlobUtf8(withRaw))).toEqual({ role: 'assistant', content: 'ok' })

    const legacy = kvMessage(1, blob.blobId, blob.blobData)
    const legacyText = kvBlobUtf8(legacy)
    expect(legacyText.startsWith('eyJ')).toBe(true)
    expect(() => JSON.parse(legacyText)).toThrow(/not valid JSON/)
  })

  it('wraps tool string content as tool-result[] (the official content.map crash)', () => {
    const blob = encodeBlob({
      role: 'tool',
      content: 'shell out',
      toolCallId: 'call_1',
      toolName: 'Shell',
    })
    const parsed = JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))
    expect(parsed).toEqual({
      role: 'tool',
      id: 'call_1',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'Shell',
        result: 'shell out',
      }],
    })
    assertOfficialCoreMessage(parsed)
    expect(restoreBlobMessageToLLMMessage(parsed)).toEqual({
      role: 'tool',
      content: 'shell out',
      toolCallId: 'call_1',
      toolName: 'Shell',
    })
  })

  it('keeps system content as a string', () => {
    const payload = { role: 'system', content: 'sys' }
    const blob = encodeBlob(payload)
    expect(JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))).toEqual(payload)
    expect(decodeBlob(JSON.stringify(payload))).toEqual(payload)
    expect(decodeBlob(Buffer.from(JSON.stringify(payload)).toString('base64'))).toEqual(payload)
    const legacyWire = Buffer.from(JSON.stringify(payload)).toString('base64')
    expect(decodeBlob(Buffer.from(legacyWire, 'utf-8').toString('base64'))).toEqual(payload)
  })

  it('writes user images as official {type:image, image, mimeType}', () => {
    const blob = encodeBlob({
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
        { type: 'text', text: 'what is this' },
      ],
    })
    const parsed = JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))
    expect(parsed).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'data:image/png;base64,abc123', mimeType: 'image/png' },
        { type: 'text', text: 'what is this' },
      ],
    })
    assertOfficialCoreMessage(parsed)
    expect(restoreBlobMessageToLLMMessage(parsed)).toEqual({
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
        { type: 'text', text: 'what is this' },
      ],
    })
  })

  it('writes assistant tool_use as official tool-call parts', () => {
    const blob = encodeBlob({
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
      ],
    })
    const parsed = JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))
    expect(parsed).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool-call', toolCallId: 'call_A', toolName: 'Read', args: { path: 'a.ts' } },
      ],
    })
    assertOfficialCoreMessage(parsed)
    expect(restoreBlobMessageToLLMMessage(parsed)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
      ],
    })
  })

  it('cached payload helpers recognize JSON vs binary', () => {
    const json = encodeBlob({ role: 'user', content: 'x' })
    expect(isJsonBlobPayload(cachedBlobPayloadBytes(json.blobData))).toBe(true)
    expect(isJsonBlobPayload(Uint8Array.from([0x0A, 0x08, 0x01]))).toBe(false)
  })
})

describe('rewriteCachedJsonBlobsForOfficialClient', () => {
  it('re-sends JSON history blobs as utf-8 CoreMessage once per conversation', () => {
    resetBlobCacheForTests()
    resetJsonBlobRewriteForTests()
    const blob = encodeBlob({ role: 'user', content: 'history' })
    cacheBlob(blob.blobId, blob.blobData)

    return drainRewrite([blob.blobId], 3).then(async (first) => {
      expect(first.frames).toHaveLength(1)
      expect(first.counter).toBe(4)
      const parsed = JSON.parse(kvBlobUtf8(first.frames[0]!))
      expect(parsed).toEqual({ role: 'user', content: [{ type: 'text', text: 'history' }] })
      assertOfficialCoreMessage(parsed)

      const second = await drainRewrite([blob.blobId], 4)
      expect(second.frames).toHaveLength(0)
      expect(second.counter).toBe(4)
    })
  })

  it('converts cached BYOK tool strings to official tool-result[] without changing blobId', async () => {
    resetBlobCacheForTests()
    resetJsonBlobRewriteForTests()
    const legacy = { role: 'tool', content: 'shell out', toolCallId: 'call_1', toolName: 'Shell' }
    const blobData = Buffer.from(JSON.stringify(legacy), 'utf-8').toString('base64')
    cacheBlob('legacy-tool-id', blobData)

    const first = await drainRewrite(['legacy-tool-id'], 0)
    expect(first.frames).toHaveLength(1)
    const parsed = JSON.parse(kvBlobUtf8(first.frames[0]!))
    expect(parsed).toEqual({
      role: 'tool',
      id: 'call_1',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'Shell',
        result: 'shell out',
      }],
    })
    assertOfficialCoreMessage(parsed)
    expect(first.frames[0]!.message.case).toBe('kvServerMessage')
    if (first.frames[0]!.message.case === 'kvServerMessage'
      && first.frames[0]!.message.value.message.case === 'setBlobArgs') {
      expect(new TextDecoder().decode(first.frames[0]!.message.value.message.value.blobId)).toBe('legacy-tool-id')
    }

    const cached = getCachedBlob('legacy-tool-id')
    expect(cached).toBeTruthy()
    expect(decodeBlob(cached!)).toEqual(parsed)
  })

  it('hydrateHistoryEntries restores official wire back to LLM string tool/user messages', () => {
    resetBlobCacheForTests()
    const user = encodeBlob({ role: 'user', content: 'hello' })
    const tool = encodeBlob({ role: 'tool', content: 'out', toolCallId: 't1', toolName: 'Shell' })
    cacheBlob(user.blobId, user.blobData)
    cacheBlob(tool.blobId, tool.blobData)
    const entries = hydrateHistoryEntries([user.blobId, tool.blobId])
    expect(entries.map(e => e.message)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'out', toolCallId: 't1', toolName: 'Shell' },
    ])
  })

  it('legacy user tool_result blobs become official tool[] and restore for history repair', () => {
    const blob = encodeBlob({
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_A', toolName: 'Read', content: 'read result' },
        { type: 'tool_result', toolUseId: 'call_B', toolName: 'Grep', content: 'grep result' },
        { type: 'text', text: '继续分析这些结果' },
      ],
    })
    const wire = JSON.parse(Buffer.from(blob.blobDataRaw).toString('utf-8'))
    assertOfficialCoreMessage(wire)
    expect(wire.role).toBe('tool')
    expect(wire.content).toHaveLength(2)

    const restored = restoreBlobMessageToLLMMessage(wire)
    expect(restored?.role).toBe('user')
    const repaired = repairConversationHistory([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先查一下。' },
          { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_B', name: 'Grep', input: { path: '.', pattern: 'x' } },
        ],
      },
      restored!,
    ])
    expect(repaired.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['call_A', 'call_B'])
    expect(repaired.some(m => m.role === 'user' && JSON.stringify(m.content).includes('继续分析这些结果'))).toBe(true)
  })

  it('rebuildConversationHistory treats official user text arrays as preamble strings', () => {
    resetBlobCacheForTests()
    const oldSystem = encodeBlob({ role: 'system', content: 'OpenAI system prompt mentions ApplyPatch and ReadFile' })
    const oldPreamble = encodeBlob({ role: 'user', content: '<user_info>old provider preamble with ReadFile</user_info>' })
    const historyUser = encodeBlob({ role: 'user', content: 'history user' })
    for (const blob of [oldSystem, oldPreamble, historyUser])
      cacheBlob(blob.blobId, blob.blobData)

    const iterator = rebuildConversationHistory({
      historyBlobIds: [oldSystem.blobId, oldPreamble.blobId, historyUser.blobId],
      prependUserMessages: [],
      systemMessage: { role: 'system', content: 'Anthropic system prompt uses Read and must not mention ApplyPatch' },
      preambleUserMessage: { role: 'user', content: '<user_info>new provider preamble with Read</user_info>' },
      currentUserMessage: { role: 'user', content: '继续' },
      systemContent: 'Anthropic system prompt uses Read and must not mention ApplyPatch',
      preambleUserContent: '<user_info>new provider preamble with Read</user_info>',
      sendSystemScaffoldBlob: noopFrames(),
      sendOrderedBlob: noopFrames(),
    })
    let result: { messages: Array<{ role: string, content: unknown }>, insertedPrependUserTexts: string[] } | undefined
    for (;;) {
      const next = iterator.next()
      if (next.done) {
        result = next.value
        break
      }
    }
    expect(result?.messages).toEqual([
      { role: 'system', content: 'Anthropic system prompt uses Read and must not mention ApplyPatch' },
      { role: 'user', content: '<user_info>new provider preamble with Read</user_info>' },
      { role: 'user', content: 'history user' },
      { role: 'user', content: '继续' },
    ])
  })
})

describe('kvMessage JSON vs protobuf encoding contract', () => {
  it('toJson still serializes setBlobArgs', () => {
    const blob = encodeBlob({ role: 'user', content: 'x' })
    const json = toJson(AgentServerMessageSchema, kvMessage(1, blob.blobId, blob.blobData, blob.blobDataRaw)) as Record<string, unknown>
    expect(JSON.stringify(json)).toMatch(/setBlobArgs/)
  })
})
