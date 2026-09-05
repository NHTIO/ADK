/**
 * Universal tool-call/message immediate-adjacency guard for OpenAI-shaped conversations.
 *
 * Tool results are stored on ToolCall itself in this ADK, not as correlated Message payloads.
 * This catches a malformed Message wedged immediately after a ToolCall.
 */
import { toolCallIdUniqueness } from './tool_call_id_uniqueness'
import type { OrderingProfile } from '../types'

export const openaiShapeBaseline: OrderingProfile = {
  name: 'openai-shape-baseline',
  description:
    'A Message may not be immediately wedged after a ToolCall; tool results live on ToolCall itself in this ADK.',
  rules: [
    {
      type: 'adjacency',
      id: 'message-not-immediately-after-tool-call',
      first: 'toolCall',
      disallowBetween: ['message'],
    },
    ...toolCallIdUniqueness.rules,
  ],
}
