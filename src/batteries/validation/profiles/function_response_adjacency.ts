/**
 * Gemini function-call immediate-adjacency guard.
 *
 * This ADK has no separate tool-result Message primitive: results live on ToolCall itself.
 * Consequently no correlation field is needed; this directly rejects an unrelated Message
 * immediately following a ToolCall before the function-call sequence continues.
 */
import type { OrderingProfile } from '../types'

export const functionResponseAdjacency: OrderingProfile = {
  name: 'function-response-adjacency',
  description:
    'A Message may not immediately follow a ToolCall; ToolCall owns its function result in this ADK.',
  rules: [
    {
      type: 'adjacency',
      id: 'message-not-immediately-after-function-call',
      first: 'toolCall',
      disallowBetween: ['message'],
    },
  ],
}
