/**
 * Recorded real-API responses captured from a live OpenAI-Chat-Completions-
 * compatible gateway (LiteLLM fronting `gemma4:e4b-it-q4_K_M`). Used as
 * regression fixtures by the e2e-style adapter test so the same dispatch
 * shape can be exercised without credentials.
 *
 * The captures preserve the upstream payload verbatim — including the
 * gateway-mangled model id (`gemma4:e4b-it-q4_K_M` when the request named
 * `gemma4`) and the `usage` block — to confirm the adapter tolerates real
 * provider quirks rather than just textbook OpenAI responses.
 */

/** Recorded non-streaming response body. */
export const RECORDED_NON_STREAMING_BODY = {
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
} as const

/**
 * Recorded streaming SSE frames as raw JSON strings (each one is the body of
 * a `data: ...` line). Caller wraps with the SSE envelope and appends a
 * `[DONE]` terminator.
 */
export const RECORDED_STREAMING_FRAMES: ReadonlyArray<string> = [
  JSON.stringify({
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-4bbaa25c-baf8-4604-8d46-2271e61aac6a',
    object: 'chat.completion.chunk',
    created: 1779539297,
    model: 'gemma4:e4b-it-q4_K_M',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 },
  }),
]

/** Final assistant content the streaming frames concatenate to. */
export const RECORDED_STREAMING_FINAL_CONTENT = 'hi there'

/** Final assistant content the non-streaming body carries. */
export const RECORDED_NON_STREAMING_FINAL_CONTENT = 'hello'
