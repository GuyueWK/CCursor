import { toJson } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import {
  cachedBlobPayloadBytes,
  decodeBlob,
  encodeBlob,
  isJsonBlobPayload,
} from '../handlers/agent/blob'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { resetJsonBlobRewriteForTests, rewriteCachedJsonBlobsForOfficialClient } from '../handlers/agent/historyManager'
import { kvMessage } from '../handlers/agent/stream'

function kvBlobUtf8(frame: ReturnType<typeof kvMessage>): string {
  expect(frame.message.case).toBe('kvServerMessage')
  if (frame.message.case !== 'kvServerMessage')
    throw new Error('expected kvServerMessage')
  expect(frame.message.value.message.case).toBe('setBlobArgs')
  if (frame.message.value.message.case !== 'setBlobArgs')
    throw new Error('expected setBlobArgs')
  return Buffer.from(frame.message.value.message.value.blobData).toString('utf-8')
}

describe('encodeBlob official-compatible JSON payload', () => {
  it('stores utf-8 JSON on the wire so JSON.parse succeeds', () => {
    const blob = encodeBlob({ role: 'user', content: 'hi' })
    const wire = Buffer.from(blob.blobDataRaw).toString('utf-8')
    expect(wire.startsWith('{')).toBe(true)
    expect(JSON.parse(wire)).toEqual({ role: 'user', content: 'hi' })
    expect(decodeBlob(blob.blobData)).toEqual({ role: 'user', content: 'hi' })
  })

  it('kvMessage with blobDataRaw writes JSON bytes, not base64 text', () => {
    const blob = encodeBlob({ role: 'assistant', content: 'ok' })
    const withRaw = kvMessage(1, blob.blobId, blob.blobData, blob.blobDataRaw)
    expect(JSON.parse(kvBlobUtf8(withRaw))).toEqual({ role: 'assistant', content: 'ok' })

    const legacy = kvMessage(1, blob.blobId, blob.blobData)
    const legacyText = kvBlobUtf8(legacy)
    expect(legacyText.startsWith('eyJ')).toBe(true)
    expect(() => JSON.parse(legacyText)).toThrow(/not valid JSON/)
  })

  it('decodeBlob accepts raw JSON, base64 JSON, and double-wrapped legacy cache', () => {
    const payload = { role: 'system', content: 'sys' }
    expect(decodeBlob(JSON.stringify(payload))).toEqual(payload)
    expect(decodeBlob(Buffer.from(JSON.stringify(payload)).toString('base64'))).toEqual(payload)
    const legacyWire = Buffer.from(JSON.stringify(payload)).toString('base64')
    expect(decodeBlob(Buffer.from(legacyWire, 'utf-8').toString('base64'))).toEqual(payload)
  })

  it('cached payload helpers recognize JSON vs binary', () => {
    const json = encodeBlob({ role: 'user', content: 'x' })
    expect(isJsonBlobPayload(cachedBlobPayloadBytes(json.blobData))).toBe(true)
    expect(isJsonBlobPayload(Uint8Array.from([0x0A, 0x08, 0x01]))).toBe(false)
  })
})

describe('rewriteCachedJsonBlobsForOfficialClient', () => {
  it('re-sends JSON history blobs as utf-8 once per conversation', () => {
    resetBlobCacheForTests()
    resetJsonBlobRewriteForTests()
    const blob = encodeBlob({ role: 'user', content: 'history' })
    cacheBlob(blob.blobId, blob.blobData)

    async function drain(start: number) {
      const frames: ReturnType<typeof kvMessage>[] = []
      const gen = rewriteCachedJsonBlobsForOfficialClient(kvMessage, 'conv-1', [blob.blobId], start)
      let next = await gen.next()
      while (!next.done) {
        frames.push(next.value)
        next = await gen.next()
      }
      return { frames, counter: next.value }
    }

    return drain(3).then(async (first) => {
      expect(first.frames).toHaveLength(1)
      expect(first.counter).toBe(4)
      expect(JSON.parse(kvBlobUtf8(first.frames[0]!))).toEqual({ role: 'user', content: 'history' })

      const second = await drain(4)
      expect(second.frames).toHaveLength(0)
      expect(second.counter).toBe(4)
    })
  })
})

describe('kvMessage JSON vs protobuf encoding contract', () => {
  it('toJson still serializes setBlobArgs', () => {
    const blob = encodeBlob({ role: 'user', content: 'x' })
    const json = toJson(AgentServerMessageSchema, kvMessage(1, blob.blobId, blob.blobData, blob.blobDataRaw)) as Record<string, unknown>
    expect(JSON.stringify(json)).toMatch(/setBlobArgs/)
  })
})
