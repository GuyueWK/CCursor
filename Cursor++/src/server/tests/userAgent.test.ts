import { describe, expect, it } from 'vitest'
import {
  buildDefaultHeaders,
  buildTemplatedRequestHeaders,
  headerValueHasTemplate,
  partitionCustomHeaders,
  resolveHeaderTemplates,
  sanitizeSessionId,
  SESSION_AFFINITY_HEADER,
} from '../handlers/llm/userAgent'

/** Literal `${conversationId}` without triggering no-template-curly-in-string. */
const CONVERSATION_ID_TEMPLATE = '${' + 'conversationId}'

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

describe('partitionCustomHeaders', () => {
  it('把模板头和静态头分开', () => {
    const { staticHeaders, templatedHeaders } = partitionCustomHeaders({
      'User-Agent': 'Cursor++/test',
      [SESSION_AFFINITY_HEADER]: CONVERSATION_ID_TEMPLATE,
      'X-Debug': 'static',
    })
    expect(staticHeaders).toEqual({
      'User-Agent': 'Cursor++/test',
      'X-Debug': 'static',
    })
    expect(templatedHeaders).toEqual({
      [SESSION_AFFINITY_HEADER]: CONVERSATION_ID_TEMPLATE,
    })
  })

  it('headerValueHasTemplate 识别占位符', () => {
    expect(headerValueHasTemplate(CONVERSATION_ID_TEMPLATE)).toBe(true)
    expect(headerValueHasTemplate(`prefix-${CONVERSATION_ID_TEMPLATE.slice(2)}`)).toBe(true)
    expect(headerValueHasTemplate('prefix-' + CONVERSATION_ID_TEMPLATE + '-suffix')).toBe(true)
    expect(headerValueHasTemplate('no-template')).toBe(false)
  })
})

describe('resolveHeaderTemplates', () => {
  it('解析 conversationId 模板', () => {
    expect(resolveHeaderTemplates({
      [SESSION_AFFINITY_HEADER]: CONVERSATION_ID_TEMPLATE,
      'X-Trace': 'chat/' + CONVERSATION_ID_TEMPLATE + '/v1',
    }, { conversationId: 'conv-live' })).toEqual({
      [SESSION_AFFINITY_HEADER]: 'conv-live',
      'X-Trace': 'chat/conv-live/v1',
    })
  })

  it('conversationId 缺失时省略仅依赖它的头', () => {
    expect(resolveHeaderTemplates({
      [SESSION_AFFINITY_HEADER]: CONVERSATION_ID_TEMPLATE,
    }, {})).toBeUndefined()
  })

  it('未知变量展开为空', () => {
    expect(resolveHeaderTemplates({
      'X-Foo': '${' + 'unknownVar}',
    }, { conversationId: 'c1' })).toBeUndefined()
  })

  it('对 x-opencode-session 做 sanitize', () => {
    expect(resolveHeaderTemplates({
      [SESSION_AFFINITY_HEADER]: 'raw|' + CONVERSATION_ID_TEMPLATE + '|id',
    }, { conversationId: 'a/b' })).toEqual({
      [SESSION_AFFINITY_HEADER]: 'raw_a_b_id',
    })
  })
})

describe('buildTemplatedRequestHeaders', () => {
  it('只解析模板头，忽略静态头', () => {
    expect(buildTemplatedRequestHeaders({
      'User-Agent': 'Cursor++/test',
      [SESSION_AFFINITY_HEADER]: CONVERSATION_ID_TEMPLATE,
    }, { conversationId: 'conv-1' })).toEqual({
      [SESSION_AFFINITY_HEADER]: 'conv-1',
    })
  })
})

describe('buildDefaultHeaders + User-Agent', () => {
  it('自定义 User-Agent 覆盖默认值', () => {
    const headers = buildDefaultHeaders('openai-responses', {
      'User-Agent': 'Cursor++/0.0.15 (ccursor; test)',
    })
    expect(headers?.['User-Agent']).toBe('Cursor++/0.0.15 (ccursor; test)')
  })
})
