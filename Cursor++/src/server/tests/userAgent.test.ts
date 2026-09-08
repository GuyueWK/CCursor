import { describe, expect, it } from 'vitest'
import {
  SESSION_AFFINITY_HEADER,
  buildDefaultHeaders,
  buildSessionAffinityRequestHeaders,
  resolveSessionAffinityHeader,
  sanitizeSessionId,
} from '../handlers/llm/userAgent'

describe('sanitizeSessionId', () => {
  it('保留安全字符并裁剪空白', () => {
    expect(sanitizeSessionId('  abc-123.XYZ  ')).toBe('abc-123.XYZ')
  })

  it('把不安全字符替换成下划线并去掉首尾下划线', () => {
    expect(sanitizeSessionId('call|special+chars/here=now')).toBe('call_special_chars_here_now')
  })

  it('截断到 128 字符', () => {
    const long = `id-${'a'.repeat(200)}`
    expect(sanitizeSessionId(long).length).toBe(128)
  })

  it('空串返回空', () => {
    expect(sanitizeSessionId('   ')).toBe('')
  })
})

describe('resolveSessionAffinityHeader', () => {
  it('conversationId 优先于静态 headers', () => {
    expect(resolveSessionAffinityHeader('conv-live', {
      [SESSION_AFFINITY_HEADER]: 'static-session',
      'User-Agent': 'Cursor++/test',
    })).toBe('conv-live')
  })

  it('无 conversationId 时回退静态 x-opencode-session', () => {
    expect(resolveSessionAffinityHeader(undefined, {
      [SESSION_AFFINITY_HEADER]: 'static-session',
    })).toBe('static-session')
  })

  it('静态 header 大小写不敏感', () => {
    expect(resolveSessionAffinityHeader('', {
      'X-Opencode-Session': 'Static.Case',
    })).toBe('Static.Case')
  })

  it('两者都缺时返回 undefined', () => {
    expect(resolveSessionAffinityHeader(undefined, { 'User-Agent': 'x' })).toBeUndefined()
    expect(resolveSessionAffinityHeader('  ')).toBeUndefined()
  })
})

describe('buildSessionAffinityRequestHeaders', () => {
  it('有 conversationId 时发出覆盖用的 per-request header', () => {
    expect(buildSessionAffinityRequestHeaders('conv-1', {
      [SESSION_AFFINITY_HEADER]: 'static',
    })).toEqual({ [SESSION_AFFINITY_HEADER]: 'conv-1' })
  })

  it('仅有静态值时不重复发 per-request（交给 defaultHeaders）', () => {
    expect(buildSessionAffinityRequestHeaders(undefined, {
      [SESSION_AFFINITY_HEADER]: 'static',
    })).toBeUndefined()
  })
})

describe('buildDefaultHeaders + User-Agent', () => {
  it('自定义 User-Agent 覆盖默认值', () => {
    const headers = buildDefaultHeaders('openai-responses', {
      'User-Agent': 'Cursor++/0.0.15 (ccursor; test)',
      [SESSION_AFFINITY_HEADER]: 'static-ok',
    })
    expect(headers?.['User-Agent']).toBe('Cursor++/0.0.15 (ccursor; test)')
    expect(headers?.[SESSION_AFFINITY_HEADER]).toBe('static-ok')
  })
})
