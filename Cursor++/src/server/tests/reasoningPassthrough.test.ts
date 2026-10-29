import type { LLMMessage } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { encodeResponsesInput } from '../handlers/llm/conversationCodec'
import {
  llmMessageToStoredMessage,
  storedMessageToLLMMessage,
} from '../handlers/llm/storedTranscript'
import { transformMessages } from '../handlers/llm/transformMessages'

describe('reasoning passthrough (opencode Go 400)', () => {
  it('blob 往返保留 thinking sourceModel', () => {
    const message: LLMMessage = {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          text: 'summary',
          signature: JSON.stringify({ type: 'reasoning', id: 'rs_123', encrypted_content: 'abc' }),
          sourceModel: 'openai-responses:opencode/go-model',
        },
        { type: 'text', text: 'hello' },
      ],
    }
    const stored = llmMessageToStoredMessage(message)
    const restored = storedMessageToLLMMessage(stored)
    const thinking = (restored.content as Extract<LLMMessage['content'], Array<unknown>> as Array<{ type: string, sourceModel?: string }>).find(
      block => block.type === 'thinking',
    )
    expect(thinking?.sourceModel).toBe('openai-responses:opencode/go-model')
  })

  it('老 blob (无 sourceModel 但有合法 reasoning signature) 按同模型保留', () => {
    const signature = JSON.stringify({ type: 'reasoning', id: 'rs_legacy', encrypted_content: 'abc' })
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '', signature },
          { type: 'text', text: 'hello' },
        ],
      },
    ]
    const result = transformMessages(messages, 'openai-responses', undefined, 'opencode/go-model')
    const blocks = result[0].content as Array<{ type: string, signature?: string }>
    expect(blocks.some(block => block.type === 'thinking' && block.signature === signature)).toBe(true)
  })

  it('无有效 signature 的 thinking 文本不静默丢失', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'orphan reasoning', sourceModel: 'openai-responses:opencode/go-model' },
          { type: 'text', text: 'hello' },
        ],
      },
    ]
    const encoded = encodeResponsesInput(messages)
    const assistantInputs = encoded.items.filter(
      (item): item is Extract<typeof item, { role: string }> => 'role' in item && item.role === 'assistant',
    )
    expect(assistantInputs.some(item => String((item as { content: unknown }).content).includes('orphan reasoning'))).toBe(true)
  })
})
