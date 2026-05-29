/**
 * Recorded non-streaming Chat Completions response from a live
 * OpenAI-Chat-Completions-compatible gateway (LiteLLM fronting
 * `gemma4:e4b-it-q4_K_M`). Captured verbatim so the adapter test exercises a
 * real provider's quirks (gateway-mangled model id, snake-case usage block,
 * etc.) without credentials at run-time.
 *
 * Wrapped as a {@link Cassette} so it composes through `cassetteFetch(...)`
 * the same way synthetic cassettes do.
 */

import type { Cassette } from '../../cassette.ts'

/** Final assistant content this cassette resolves to. */
export const GEMMA4_NON_STREAMING_FINAL_CONTENT = 'hello'

export const gemma4NonStreamingHelloCassette: Cassette = {
  name: 'gemma4_non_streaming_hello',
  mode: 'once',
  interactions: [
    {
      label: 'gemma4-non-streaming-hello',
      request: {
        method: 'POST',
        url: /\/chat\/completions$/,
        body: (b) => {
          if (b === null || typeof b !== 'object') return false
          return (b as Record<string, unknown>).stream !== true
        },
      },
      response: {
        body: {
          id: 'chatcmpl-896ca41b-a953-49c3-b97a-cd338d10fe87',
          object: 'chat.completion',
          created: 1779539289,
          model: 'gemma4:e4b-it-q4_K_M',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 },
        },
      },
    },
  ],
}
