import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMContentBlock, LLMMessage } from '../llm/types'
import { logger } from '../../logger'
import { restoreStoredMessage, toOfficialCoreMessage } from '../llm/storedTranscript'
import { cachedBlobPayloadBytes, decodeBlob, encodeBlob, isJsonBlobPayload } from './blob'
import { cacheBlob, getCachedBlob } from './blobStore'
import { normalizeBlobMessage, restoreBlobMessageToLLMMessage } from './transcript'
import { createRepairDiagnostics, hasRepairMutations, repairConversationHistory, type RepairDiagnostics } from '../llm/transformMessages'

export interface HistoryEntry {
  blobId: string
  raw: Record<string, unknown>
  message: LLMMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

type BuildKvMessage = (id: number, blobId: string, blobData: string, blobDataRaw?: Uint8Array) => AgentServerMessage

const rewrittenJsonBlobConversations = new Set<string>()

export function resetJsonBlobRewriteForTests(): void {
  rewrittenJsonBlobConversations.clear()
}

/**
 * 把 cache 里的 JSON 历史 blob 按官方 UTF-8 CoreMessage 再写一遍客户端。
 * 旧 BYOK 会话可能是 base64 文本,或 `{role:tool, content:string}` —
 * 官方 `toRedactedToolMessage` 会对 content 无条件 `.map`。
 * 同一 conversation 在本进程里只修一次,避免每轮重传整段历史。
 * blobId 保持不变 (历史索引仍指向旧 id)。
 */
export function* rewriteCachedJsonBlobsForOfficialClient(
  buildKvMessage: BuildKvMessage,
  conversationId: string,
  blobIds: string[],
  startCounter: number,
): Generator<AgentServerMessage, number, void> {
  if (!conversationId || blobIds.length === 0 || rewrittenJsonBlobConversations.has(conversationId))
    return startCounter

  let counter = startCounter
  let rewritten = 0
  for (const blobId of blobIds) {
    const blobData = getCachedBlob(blobId)
    if (!blobData)
      continue
    const raw = cachedBlobPayloadBytes(blobData)
    if (!isJsonBlobPayload(raw))
      continue

    let payloadBytes = raw
    let payloadData = blobData
    try {
      const parsed = decodeBlob(blobData)
      if (isRecord(parsed) && typeof parsed.role === 'string') {
        const stored = restoreStoredMessage(parsed)
        if (stored) {
          payloadBytes = Buffer.from(JSON.stringify(toOfficialCoreMessage(stored)), 'utf-8')
          payloadData = Buffer.from(payloadBytes).toString('base64')
          if (payloadData !== blobData)
            cacheBlob(blobId, payloadData)
        }
      }
    }
    catch (error) {
      logger.warn({ blobId, error: (error as Error).message }, '[SESSION] skipped official JSON blob rewrite')
    }

    yield buildKvMessage(++counter, blobId, payloadData, payloadBytes)
    rewritten++
  }
  rewrittenJsonBlobConversations.add(conversationId)
  if (rewritten > 0) {
    logger.info({ conversationId, rewritten, total: blobIds.length }, '[SESSION] rewrote JSON history blobs as official CoreMessage')
  }
  return counter
}

export function* sendAndCacheBlob(
  buildKvMessage: BuildKvMessage,
  id: number,
  data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean, providerOptions?: Record<string, unknown> },
  blobIds: string[],
): Generator<AgentServerMessage, void, void> {
  const normalized = normalizeBlobMessage(data)
  const blob = encodeBlob(normalized)
  blobIds.push(blob.blobId)
  cacheBlob(blob.blobId, blob.blobData)
  yield buildKvMessage(id, blob.blobId, blob.blobData, blob.blobDataRaw)
}

export function* flushMessageBlobs(
  buildKvMessage: BuildKvMessage,
  messages: LLMMessage[],
  startIndex: number,
  blobCounter: number,
  blobIds: string[],
): Generator<AgentServerMessage, { nextIndex: number, blobCounter: number }, void> {
  let nextIndex = startIndex
  let nextBlobCounter = blobCounter

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]
    yield* sendAndCacheBlob(buildKvMessage, ++nextBlobCounter, {
      role: msg.role,
      content: msg.content,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      isError: msg.isError,
    }, blobIds)
    nextIndex = i + 1
  }

  return { nextIndex, blobCounter: nextBlobCounter }
}

export function extractPlainTextContent(message: LLMMessage): string {
  if (typeof message.content === 'string')
    return message.content
  return message.content
    .filter((block): block is Extract<LLMContentBlock, { type: 'text' | 'thinking' }> => block.type === 'text' || block.type === 'thinking')
    .map(block => block.text)
    .join('')
}

export function extractComparableUserTexts(message: LLMMessage): string[] {
  const text = extractPlainTextContent(message).trim()
  if (!text)
    return []

  const values = new Set<string>([text])
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const userQueryMatches = text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)
  for (const match of userQueryMatches) {
    const inner = match[1]?.trim()
    if (inner)
      values.add(inner)
  }

  return [...values]
}

export function hasSystemMessage(messages: LLMMessage[]): boolean {
  return messages.some(message => message.role === 'system')
}

export function isPreambleUserMessage(message: LLMMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string')
    return false
  return message.content.includes('<user_info>')
    && !message.content.includes('<user_query>')
}

export function hasPreambleUserMessage(messages: LLMMessage[]): boolean {
  return messages.some(isPreambleUserMessage)
}

function syncConversationScaffold(messages: LLMMessage[], systemMessage: LLMMessage, preambleUserMessage: LLMMessage): { messages: LLMMessage[], systemReplaced: boolean, preambleReplaced: boolean } {
  const next = [...messages]
  let systemReplaced = false
  let preambleReplaced = false

  const systemIndex = next.findIndex(message => message.role === 'system')
  if (systemIndex >= 0 && next[systemIndex]?.content !== systemMessage.content) {
    next[systemIndex] = systemMessage
    systemReplaced = true
  }

  const preambleIndex = next.findIndex(isPreambleUserMessage)
  if (preambleIndex >= 0 && next[preambleIndex]?.content !== preambleUserMessage.content) {
    next[preambleIndex] = preambleUserMessage
    preambleReplaced = true
  }

  return { messages: next, systemReplaced, preambleReplaced }
}

export function mergePrependUserMessages(
  messages: LLMMessage[],
  prependUserMessages: Array<{ text: string, messageId?: string }>,
): { messages: LLMMessage[], insertedTexts: string[] } {
  if (prependUserMessages.length === 0)
    return { messages, insertedTexts: [] }

  const existingUserTexts = new Set(
    messages
      .filter(message => message.role === 'user')
      .flatMap(extractComparableUserTexts)
      .filter(text => text.length > 0),
  )

  const missing = prependUserMessages
    .map(entry => entry.text)
    .filter(text => text.length > 0 && !existingUserTexts.has(text))

  if (missing.length === 0) {
    logger.info({ prependCount: prependUserMessages.length }, '[SESSION] prepend user messages already satisfied by history')
    return { messages, insertedTexts: [] }
  }

  const insertAt = messages.findIndex(message => message.role !== 'system' && !isPreambleUserMessage(message))
  const prefix = missing.map(text => ({ role: 'user' as const, content: text }))

  logger.info({
    prependCount: prependUserMessages.length,
    missingCount: missing.length,
    firstMissing: missing[0],
  }, '[SESSION] merging prepend user messages into history')

  if (insertAt === -1)
    return { messages: [...messages, ...prefix], insertedTexts: missing }
  return {
    messages: [...messages.slice(0, insertAt), ...prefix, ...messages.slice(insertAt)],
    insertedTexts: missing,
  }
}

export function isSummaryBlobMessage(raw: Record<string, unknown>): boolean {
  const providerOptions = raw.providerOptions
  if (!isRecord(providerOptions))
    return false
  const cursor = providerOptions.cursor
  return isRecord(cursor) && cursor.isSummary === true
}

export function hydrateHistoryEntries(blobIds: string[]): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const blobId of blobIds) {
    const blobData = getCachedBlob(blobId)
    if (!blobData)
      continue
    try {
      const decoded = decodeBlob(blobData)
      if (!isRecord(decoded))
        continue
      const restored = restoreBlobMessageToLLMMessage(decoded)
      if (!restored)
        continue
      entries.push({ blobId, raw: decoded, message: restored })
    }
    catch (error) {
      logger.warn({ blobId, error: (error as Error).message }, '[SESSION] failed to hydrate history entry')
    }
  }
  return entries
}

export function materializeHistoryEntries(messages: LLMMessage[]): HistoryEntry[] {
  return messages.map((message) => {
    const normalized = normalizeBlobMessage({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    })
    const blob = encodeBlob(normalized)
    cacheBlob(blob.blobId, blob.blobData)
    return {
      blobId: blob.blobId,
      raw: normalized as unknown as Record<string, unknown>,
      message,
    }
  })
}

function logHistoryRepair(stage: string, diagnostics: RepairDiagnostics, extra: Record<string, unknown> = {}): void {
  if (!hasRepairMutations(diagnostics))
    return
  logger.debug({
    stage,
    ...extra,
    ...diagnostics,
  }, '[HISTORY_REPAIR] canonicalized conversation history')
}

export function repairHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const diagnostics = createRepairDiagnostics(entries.length)
  const repaired = repairConversationHistory(entries.map(entry => entry.message), diagnostics)
  logHistoryRepair('repairHistoryEntries', diagnostics, {
    entryCount: entries.length,
    inputBlobIds: entries.length,
  })
  return materializeHistoryEntries(repaired)
}

export function* rebuildConversationHistory(params: {
  historyBlobIds: string[]
  prependUserMessages: Array<{ text: string, messageId?: string }>
  systemMessage: LLMMessage
  preambleUserMessage: LLMMessage
  currentUserMessage: LLMMessage
  systemContent: string
  preambleUserContent: string
  sendSystemScaffoldBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => Generator<AgentServerMessage, void, void>
  sendOrderedBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => Generator<AgentServerMessage, void, void>
}): Generator<AgentServerMessage, { messages: LLMMessage[], insertedPrependUserTexts: string[] }, void> {
  let messages: LLMMessage[] = []
  let insertedPrependUserTexts: string[] = []

  if (params.historyBlobIds.length > 0) {
    const historyEntries = hydrateHistoryEntries(params.historyBlobIds)
    logger.info({
      requestedBlobs: params.historyBlobIds.length,
      resolvedBlobs: historyEntries.length,
      prependUserMessages: params.prependUserMessages.length,
    }, '[SESSION] history blobs from cache')

    messages = historyEntries.map(entry => entry.message)

    const scaffoldSynced = syncConversationScaffold(messages, params.systemMessage, params.preambleUserMessage)
    messages = scaffoldSynced.messages
    if (scaffoldSynced.systemReplaced || scaffoldSynced.preambleReplaced) {
      logger.debug({
        systemReplaced: scaffoldSynced.systemReplaced,
        preambleReplaced: scaffoldSynced.preambleReplaced,
      }, '[HISTORY_REPAIR] replaced provider-specific scaffold in restored history')
    }

    if (!hasSystemMessage(messages)) {
      messages.unshift(params.systemMessage)
      yield* params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })
    }

    if (!hasPreambleUserMessage(messages)) {
      const insertAt = messages.findIndex(message => message.role !== 'system')
      if (insertAt === -1)
        messages.push(params.preambleUserMessage)
      else messages.splice(insertAt, 0, params.preambleUserMessage)
      yield* params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent })
    }

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
    messages.push(params.currentUserMessage)
  }
  else {
    messages.push(params.systemMessage)
    yield* params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })

    messages.push(params.preambleUserMessage)
    yield* params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent });

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
    messages.push(params.currentUserMessage)
  }

  const diagnostics = createRepairDiagnostics(messages.length)
  const repaired = repairConversationHistory(messages, diagnostics)
  logHistoryRepair('rebuildConversationHistory', diagnostics, {
    historyBlobIds: params.historyBlobIds.length,
    insertedPrependUserTexts: insertedPrependUserTexts.length,
  })

  return {
    messages: repaired,
    insertedPrependUserTexts,
  }
}
