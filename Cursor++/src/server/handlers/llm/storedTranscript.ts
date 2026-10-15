import type { LLMContentBlock, LLMMessage } from './types'

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | StoredBlock[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  id?: string
  providerOptions?: Record<string, unknown>
}

export type StoredBlock
  = | { type: 'text', text: string }
    | { type: 'image', mimeType: string, data: string }
    | { type: 'reasoning', text: string, signature?: string, providerOptions?: Record<string, unknown> }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: Record<string, unknown> }
    | { type: 'tool-result', toolCallId: string, toolName?: string, result: string, isError?: boolean, structured?: unknown }

/** Stashed on mixed user+tool_result blobs so official role:tool still round-trips leftover user text. */
const BYOK_LEGACY_USER_TEXT_KEY = 'byokLegacyUserText'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (value === undefined || value === null)
    return ''
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value))
    return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed))
        return parsed
    }
    catch {
      // keep empty args
    }
  }
  return {}
}

function fromDataUrlOrBase64(value: string, fallbackMime = 'image/png'): { data: string, mimeType: string } {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/iu.exec(value)
  if (match)
    return { mimeType: match[1] || fallbackMime, data: match[2] ?? '' }
  return { data: value, mimeType: fallbackMime }
}

function parseStoredImage(block: Record<string, unknown>): Extract<StoredBlock, { type: 'image' }> | null {
  const fallbackMime = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/png'
  if (typeof block.image === 'string' && block.image) {
    const parsed = fromDataUrlOrBase64(block.image, fallbackMime)
    return { type: 'image', mimeType: parsed.mimeType, data: parsed.data }
  }
  if (typeof block.data === 'string' && block.data) {
    const parsed = fromDataUrlOrBase64(block.data, fallbackMime)
    return { type: 'image', mimeType: parsed.mimeType, data: parsed.data }
  }
  return null
}

function pushExperimentalImages(target: StoredBlock[], experimental: unknown): void {
  if (!Array.isArray(experimental))
    return
  for (const item of experimental) {
    if (!isRecord(item) || item.type !== 'image')
      continue
    const image = parseStoredImage(item)
    if (image)
      target.push(image)
  }
}

function flattenTextBlocks(content: StoredBlock[]): string {
  return content
    .filter((block): block is Extract<StoredBlock, { type: 'text' | 'reasoning' }> => block.type === 'text' || block.type === 'reasoning')
    .map(block => block.text)
    .join('')
}

function readLegacyUserText(providerOptions?: Record<string, unknown>): string {
  const value = providerOptions?.[BYOK_LEGACY_USER_TEXT_KEY]
  return typeof value === 'string' ? value : ''
}

function stripLegacyUserText(providerOptions?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!providerOptions || !(BYOK_LEGACY_USER_TEXT_KEY in providerOptions))
    return providerOptions
  const next = { ...providerOptions }
  delete next[BYOK_LEGACY_USER_TEXT_KEY]
  return Object.keys(next).length > 0 ? next : undefined
}

function parseContentBlocks(blocks: unknown[]): StoredBlock[] {
  const content: StoredBlock[] = []
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== 'string')
      continue
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
        break
      case 'image': {
        const image = parseStoredImage(block)
        if (image)
          content.push(image)
        break
      }
      case 'reasoning':
      case 'thinking':
        content.push({
          type: 'reasoning',
          text: typeof block.text === 'string' ? block.text : '',
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(isRecord(block.providerOptions) ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        content.push({
          type: 'tool-call',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          toolName: typeof block.toolName === 'string' ? block.toolName : '',
          args: parseArgs(block.args),
        })
        break
      case 'tool_use':
        content.push({
          type: 'tool-call',
          toolCallId: typeof block.id === 'string' ? block.id : '',
          toolName: typeof block.name === 'string' ? block.name : '',
          args: parseArgs(block.input),
        })
        break
      case 'tool-result':
        content.push({
          type: 'tool-result',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: stringifyUnknown(block.result),
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
          ...(block.structured !== undefined ? { structured: block.structured } : {}),
        })
        pushExperimentalImages(content, block.experimental_content)
        break
      case 'tool_result':
        content.push({
          type: 'tool-result',
          toolCallId: typeof block.toolUseId === 'string' ? block.toolUseId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: stringifyUnknown(block.content),
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
        })
        break
      default:
        break
    }
  }
  return content
}

export function normalizeStoredMessage(message: {
  role: string
  content: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  id?: string
  providerOptions?: Record<string, unknown>
}): StoredMessage {
  if (!Array.isArray(message.content)) {
    return {
      role: message.role as StoredMessage['role'],
      content: typeof message.content === 'string' ? message.content : '',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      id: message.id,
      providerOptions: message.providerOptions,
    }
  }

  return {
    role: message.role as StoredMessage['role'],
    content: parseContentBlocks(message.content as unknown[]),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    id: message.id,
    providerOptions: message.providerOptions,
  }
}

export function restoreStoredMessage(message: Record<string, unknown>): StoredMessage | null {
  if (typeof message.role !== 'string')
    return null

  const id = typeof message.id === 'string' ? message.id : undefined
  const providerOptions = isRecord(message.providerOptions) ? message.providerOptions : undefined
  let toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
  let toolName = typeof message.toolName === 'string' ? message.toolName : undefined
  let isError = typeof message.isError === 'boolean' ? message.isError : undefined

  if (!Array.isArray(message.content)) {
    return {
      role: message.role as StoredMessage['role'],
      content: typeof message.content === 'string' ? message.content : '',
      toolCallId: toolCallId ?? id,
      toolName,
      isError,
      id,
      providerOptions: stripLegacyUserText(providerOptions),
    }
  }

  const content = parseContentBlocks(message.content)
  const firstResult = content.find((block): block is Extract<StoredBlock, { type: 'tool-result' }> => block.type === 'tool-result')
  if (firstResult) {
    toolCallId = toolCallId || firstResult.toolCallId || id
    toolName = toolName || firstResult.toolName
    if (isError === undefined)
      isError = firstResult.isError
  }

  const leftoverUserText = readLegacyUserText(providerOptions)
  const cleanedProviderOptions = stripLegacyUserText(providerOptions)
  const role = message.role as StoredMessage['role']

  if (role === 'system') {
    return {
      role: 'system',
      content: flattenTextBlocks(content),
      id,
      providerOptions: cleanedProviderOptions,
    }
  }

  if (role === 'tool') {
    const results = content.filter((block): block is Extract<StoredBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    const images = content.filter((block): block is Extract<StoredBlock, { type: 'image' }> => block.type === 'image')
    if (leftoverUserText || results.length > 1) {
      const userContent: StoredBlock[] = [...results]
      if (leftoverUserText)
        userContent.push({ type: 'text', text: leftoverUserText })
      userContent.push(...images)
      return {
        role: 'user',
        content: userContent,
        providerOptions: cleanedProviderOptions,
      }
    }
    if (results.length <= 1 && images.length === 0) {
      return {
        role: 'tool',
        content: results[0]?.result ?? flattenTextBlocks(content),
        toolCallId,
        toolName,
        isError,
        id,
        providerOptions: cleanedProviderOptions,
      }
    }
    return {
      role: 'tool',
      content,
      toolCallId,
      toolName,
      isError,
      id,
      providerOptions: cleanedProviderOptions,
    }
  }

  if (content.length > 0 && content.every(block => block.type === 'text')) {
    return {
      role,
      content: content.map(block => block.type === 'text' ? block.text : '').join(''),
      id,
      providerOptions: cleanedProviderOptions,
    }
  }

  return {
    role,
    content,
    toolCallId,
    toolName,
    isError,
    id,
    providerOptions: cleanedProviderOptions,
  }
}

export function storedMessageToLLMMessage(message: StoredMessage): LLMMessage {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    }
  }

  const content: LLMContentBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        break
      case 'reasoning':
        content.push({
          type: 'thinking',
          text: block.text,
          ...(block.signature ? { signature: block.signature } : {}),
          ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        content.push({ type: 'tool_use', id: block.toolCallId, name: block.toolName, input: block.args })
        break
      case 'tool-result':
        content.push({
          type: 'tool_result',
          toolUseId: block.toolCallId,
          toolName: block.toolName,
          content: block.result,
          ...(block.isError ? { isError: true } : {}),
        })
        break
    }
  }

  return {
    role: message.role,
    content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
  }
}

export function llmMessageToStoredMessage(message: LLMMessage): StoredMessage {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    }
  }

  const content: StoredBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        break
      case 'thinking':
        content.push({
          type: 'reasoning',
          text: block.text,
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool_use':
        content.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, args: block.input })
        break
      case 'tool_result':
        content.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: block.toolName,
          result: block.content,
          ...(block.isError ? { isError: true } : {}),
        })
        break
    }
  }

  return {
    role: message.role,
    content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
  }
}

function toDataUrl(data: string, mimeType: string): string {
  if (!data || /^data:/i.test(data) || /^https?:\/\//i.test(data))
    return data
  return `data:${mimeType || 'image/png'};base64,${data}`
}

function stripDataUrl(data: string): string {
  const match = /^data:image\/[^;,]+;base64,([\s\S]*)$/iu.exec(data)
  return match?.[1] ?? data
}

function flattenStoredText(content: string | StoredBlock[]): string {
  return typeof content === 'string' ? content : flattenTextBlocks(content)
}

function officialToolResultPart(
  toolCallId: string,
  toolName: string,
  result: string,
  isError?: boolean,
): Record<string, unknown> {
  return {
    type: 'tool-result',
    toolCallId,
    toolName,
    result,
    ...(isError ? { isError: true } : {}),
  }
}

function officialToolMessage(message: StoredMessage): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = []
  const leftoverTexts: string[] = []
  const experimental: Array<Record<string, unknown>> = []

  if (typeof message.content === 'string') {
    parts.push(officialToolResultPart(
      message.toolCallId || message.id || '',
      message.toolName || '',
      message.content,
      message.isError,
    ))
  }
  else {
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        parts.push(officialToolResultPart(
          block.toolCallId || message.toolCallId || '',
          block.toolName || message.toolName || '',
          block.result,
          block.isError ?? message.isError,
        ))
      }
      else if (block.type === 'text') {
        if (message.role === 'tool') {
          parts.push(officialToolResultPart(
            message.toolCallId || message.id || '',
            message.toolName || '',
            block.text,
            message.isError,
          ))
        }
        else {
          leftoverTexts.push(block.text)
        }
      }
      else if (block.type === 'image') {
        experimental.push({
          type: 'image',
          data: stripDataUrl(block.data),
          mimeType: block.mimeType,
        })
      }
    }
  }

  if (parts.length === 0) {
    parts.push(officialToolResultPart(
      message.toolCallId || message.id || '',
      message.toolName || '',
      leftoverTexts.join('\n'),
      message.isError,
    ))
    leftoverTexts.length = 0
  }

  if (experimental.length > 0)
    parts[0]!.experimental_content = experimental

  const out: Record<string, unknown> = { role: 'tool', content: parts }
  const id = message.id || message.toolCallId || (typeof parts[0]?.toolCallId === 'string' ? parts[0].toolCallId : '')
  if (id)
    out.id = id

  const leftover = leftoverTexts.join('\n')
  const providerOptions = message.providerOptions ? { ...message.providerOptions } : {}
  if (leftover && message.role !== 'tool')
    providerOptions[BYOK_LEGACY_USER_TEXT_KEY] = leftover
  if (Object.keys(providerOptions).length > 0)
    out.providerOptions = providerOptions

  return out
}

function officialUserAssistantParts(message: StoredMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string')
    return [{ type: 'text', text: message.content }]

  const parts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        parts.push({
          type: 'image',
          image: toDataUrl(block.data, block.mimeType),
          mimeType: block.mimeType,
        })
        break
      case 'reasoning':
        parts.push({
          type: 'reasoning',
          text: block.text,
          ...(block.signature ? { signature: block.signature } : {}),
          ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        parts.push({
          type: 'tool-call',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          args: block.args,
        })
        break
      default:
        break
    }
  }
  return parts
}

/**
 * Cursor KV blobs are AI SDK CoreMessage JSON (see daemon CoreMessageSerde /
 * conversationHistoryToCoreMessages / toRedactedToolMessage):
 *   system    → content: string
 *   user      → content: [{type:'text'|'image'|'file', ...}]  (image uses `image`, not `data`)
 *   assistant → content: string | [{type:'text'|'reasoning'|'tool-call', ...}]
 *   tool      → content: [{type:'tool-result', toolCallId, toolName, result, isError?}]
 */
export function toOfficialCoreMessage(message: StoredMessage): Record<string, unknown> {
  if (message.role === 'system') {
    const out: Record<string, unknown> = {
      role: 'system',
      content: flattenStoredText(message.content),
    }
    if (message.id)
      out.id = message.id
    if (message.providerOptions)
      out.providerOptions = message.providerOptions
    return out
  }

  if (message.role === 'tool' || (Array.isArray(message.content) && message.content.some(block => block.type === 'tool-result')))
    return officialToolMessage(message)

  const parts = officialUserAssistantParts(message)
  const out: Record<string, unknown> = { role: message.role }

  if (message.role === 'assistant') {
    if (typeof message.content === 'string')
      out.content = message.content
    else if (parts.length === 0)
      out.content = ''
    else if (parts.length === 1 && parts[0]?.type === 'text')
      out.content = parts[0].text
    else
      out.content = parts
  }
  else {
    out.content = parts.length > 0 ? parts : [{ type: 'text', text: flattenStoredText(message.content) }]
  }

  if (message.id)
    out.id = message.id
  if (message.providerOptions)
    out.providerOptions = message.providerOptions
  return out
}
