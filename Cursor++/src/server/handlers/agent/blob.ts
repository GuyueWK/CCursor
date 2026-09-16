/**
 * KV Blob Store 处理
 *
 * Agent 协议使用 KV Blob Store 传输大块数据:
 *   - Server → Client: kvServerMessage.setBlobArgs { blobId, blobData }
 *   - Client → Server: kvClientMessage.setBlobResult { id? }
 *
 * 内部 cache (`blobData` 字符串) 是 payload 的 base64,方便 sqlite / UploadConversationBlobs。
 * 发给客户端的 `blobDataRaw` 必须是 payload 原字节:
 *   - JSON 消息: UTF-8 `{"role":...}` —— 官方客户端直接 JSON.parse
 *   - protobuf: raw bytes —— 官方 fromBinary
 *
 * 旧实现把 JSON 的 base64 文本再 UTF-8 编码后写入客户端,官方切回时
 * JSON.parse("eyJyb2xlI...") 失败。encodeBlob 现在同时返回 json utf-8 raw。
 */
import { createHash } from 'crypto'

function finalizeBlobData(blobData: string): { blobId: string, blobData: string } {
  const blobId = createHash('sha256').update(blobData).digest('base64')
  return { blobId, blobData }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trimStart()
  if (trimmed[0] !== '{' && trimmed[0] !== '[')
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** 将 JSON 对象编码为 blob (cache=base64, wire=utf-8 JSON) 并计算 blobId (sha256) */
export function encodeBlob(data: unknown): { blobId: string, blobData: string, blobDataRaw: Uint8Array } {
  const jsonBytes = Buffer.from(JSON.stringify(data), 'utf-8')
  const { blobId, blobData } = finalizeBlobData(jsonBytes.toString('base64'))
  return { blobId, blobData, blobDataRaw: jsonBytes }
}

/** 将 protobuf / binary 数据编码为 blob (base64) 并计算 blobId (sha256)。
 *  blobDataRaw 保留原始 bytes，供 kvMessage 直接发给客户端（fork 时客户端 fromBinary 需要 raw protobuf）。 */
export function encodeBinaryBlob(bytes: Uint8Array): { blobId: string, blobData: string, blobDataRaw: Uint8Array } {
  const { blobId, blobData } = finalizeBlobData(Buffer.from(bytes).toString('base64'))
  return { blobId, blobData, blobDataRaw: bytes }
}

/** 内部 cache 的 base64 payload → 原始 bytes (JSON utf-8 或 protobuf) */
export function cachedBlobPayloadBytes(blobData: string): Uint8Array {
  return Buffer.from(blobData, 'base64')
}

export function isJsonBlobPayload(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0A || bytes[i] === 0x0D))
    i++
  return bytes[i] === 0x7B || bytes[i] === 0x5B
}

/** 解码 blob cache 值 → JSON。兼容 raw JSON、base64(JSON)、以及旧双层 base64。 */
export function decodeBlob(blobData: string): unknown {
  const direct = tryParseJson(blobData)
  if (direct !== undefined)
    return direct

  const decoded = Buffer.from(blobData, 'base64').toString('utf-8')
  const once = tryParseJson(decoded)
  if (once !== undefined)
    return once

  const nested = tryParseJson(Buffer.from(decoded, 'base64').toString('utf-8'))
  if (nested !== undefined)
    return nested

  throw new SyntaxError('blob is not valid JSON')
}

/** 构造 system prompt blob */
export function buildSystemPromptBlob(modelId: string): { blobId: string, blobData: string, blobDataRaw: Uint8Array } {
  return encodeBlob({
    role: 'system',
    content: `You are an AI coding assistant, powered by ${modelId}.\n\nYou operate in Cursor.\n\nYou are a coding agent that helps the USER with software engineering tasks.`,
  })
}

/** 构造 user message blob */
export function buildUserMessageBlob(
  text: string,
  env?: { osVersion?: string, shell?: string, workspacePaths?: string[] },
): { blobId: string, blobData: string, blobDataRaw: Uint8Array } {
  let content = ''

  if (env) {
    content += '<user_info>\n'
    if (env.osVersion)
      content += `OS Version: ${env.osVersion}\n`
    if (env.shell)
      content += `Shell: ${env.shell}\n`
    if (env.workspacePaths?.length)
      content += `Workspace Path: ${env.workspacePaths[0]}\n`
    content += '</user_info>\n\n'
  }

  content += `<user_query>\n${text}\n</user_query>`

  return encodeBlob({ role: 'user', content })
}
