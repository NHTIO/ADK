/**
 * Recorded streaming Chat Completions SSE frames from a live
 * OpenAI-Chat-Completions-compatible gateway (LiteLLM fronting
 * `gemma4:e4b-it-q4_K_M`). Captured verbatim — three content deltas
 * (`hi`, ` there`, terminal usage frame) plus a `[DONE]` terminator.
 *
 * Wrapped as a {@link Cassette} so it composes through `cassetteFetch(...)`
 * the same way synthetic cassettes do.
 */

import type { Cassette } from '../../cassette.ts'

/** Final assistant content the streaming frames concatenate to. */
export const GEMMA4_STREAMING_FINAL_CONTENT = 'hi there'

const FRAMES = [
  {
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 },
  },
]

export const gemma4StreamingHiThereCassette: Cassette = {
  name: 'gemma4_streaming_hi_there',
  mode: 'once',
  interactions: [
    {
      label: 'gemma4-streaming-hi-there',
      request: {
        method: 'POST',
        url: /\/chat\/completions$/,
        body: (b) => {
          if (b === null || typeof b !== 'object') return false
          return (b as Record<string, unknown>).stream === true
        },
      },
      response: {
        sse: [...FRAMES.map((f) => ({ json: f })), '[DONE]'],
      },
    },
  ],
}
