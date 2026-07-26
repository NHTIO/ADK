import { isError, isInstanceOf, isObject } from '../../src/lib/utils/guards'

/**
 * Cross-env test cassette system for OpenAI-Chat-Completions-compatible
 * adapters.
 *
 * Design borrows three ideas:
 *   - VCR.py / pytest-recording: one cassette per scenario, declarative
 *     request matchers, deterministic replay.
 *   - openai-api-mock: programmatic response builders (chat completion,
 *     streaming, tool calls, errors) so synthetic cases don't need
 *     hand-crafted payloads.
 *   - The existing tests/_fixtures/openai_chat_completions_recorded.ts:
 *     captures from real upstream responses, stored verbatim, replayed
 *     through an injected fetch.
 *
 * Cross-env safe — uses globalThis fetch primitives (`Response`,
 * `ReadableStream`, `TextEncoder`) only. No `nock`, no `node:` imports.
 * Loadable in both Node and browser vitest projects.
 */

// ─── frame types ─────────────────────────────────────────────────────────────

/**
 * A single SSE frame in a cassette. Strings are wrapped as `data: <s>\n\n`;
 * the literal '[DONE]' emits the SSE terminator; `{ json }` is serialised
 * and wrapped as a data frame; `{ raw }` is enqueued verbatim; `{ comment }`
 * emits an SSE keep-alive comment line; `{ delayMs }` pauses the stream;
 * `{ error }` aborts the stream with the supplied error.
 */
export type SSEFrame =
  | string
  | { json: unknown }
  | { raw: string }
  | { comment: string }
  | { delayMs: number }
  | { error: string | Error }

/**
 * A single NDJSON (newline-delimited JSON) frame in a cassette — the streaming shape Ollama's
 * native `/api/chat` emits. Unlike SSE there is no `data:` prefix and no `[DONE]` sentinel:
 * `{ json }` is serialised and terminated with a single `\n`; `{ raw }` is enqueued verbatim (use
 * for partial-line / split-object tests); `{ delayMs }` pauses the stream; `{ error }` aborts the
 * stream with the supplied error. Stream termination is signalled in-band by a frame whose JSON
 * carries `done: true`, not by a separate sentinel frame.
 */
export type NdjsonFrame =
  | { json: unknown }
  | { raw: string }
  | { delayMs: number }
  | { error: string | Error }

/** Programmatic representation of one HTTP response. */
export interface CassetteResponse {
  status?: number
  headers?: Record<string, string>
  /** JSON body for single-response (non-streaming). Mutually exclusive with `sse` / `ndjson`. */
  body?: unknown
  /** SSE frames for streaming responses. Mutually exclusive with `body` / `ndjson`. */
  sse?: ReadonlyArray<SSEFrame>
  /**
   * NDJSON frames for newline-delimited streaming responses (Ollama native `/api/chat`).
   * Mutually exclusive with `body` / `sse`. Served with `content-type: application/x-ndjson`.
   */
  ndjson?: ReadonlyArray<NdjsonFrame>
}

/** Match criteria for a single request — all supplied criteria must hold. */
export interface RequestMatcher {
  method?: string
  /** Exact URL string, RegExp, or predicate. */
  url?: string | RegExp | ((url: string) => boolean)
  /**
   * Partial JSON body match — every key in `body` must be present in the
   * actual parsed body with a deep-equal value. Or pass a predicate.
   */
  body?: Record<string, unknown> | ((body: unknown) => boolean)
  /** Required headers. Each header name's actual value must equal the expected one. */
  headers?: Record<string, string>
}

/** A single recorded request → response pair. */
export interface Interaction {
  /** Optional label used in error messages. */
  label?: string
  request?: RequestMatcher
  response: CassetteResponse
}

/** A cassette is a named, ordered list of interactions. */
export interface Cassette {
  name: string
  interactions: ReadonlyArray<Interaction>
  /**
   * - `'once'` (default): interactions are consumed in order; each matches one
   *   request and is then exhausted. Extra requests after exhaustion error.
   * - `'reusable'`: interactions match on every request that satisfies them;
   *   useful for retry tests where the same response should fire repeatedly.
   */
  mode?: 'once' | 'reusable'
}

// ─── response materialisation ────────────────────────────────────────────────

const encoder = new TextEncoder()

const renderSseFrame = (
  frame: SSEFrame,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> | void => {
  if (typeof frame === 'string') {
    if (frame === '[DONE]') {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    } else {
      controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
    }
    return
  }
  if ('json' in frame) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame.json)}\n\n`))
    return
  }
  if ('raw' in frame) {
    controller.enqueue(encoder.encode(frame.raw))
    return
  }
  if ('comment' in frame) {
    controller.enqueue(encoder.encode(`:${frame.comment}\n\n`))
    return
  }
  if ('delayMs' in frame) {
    return new Promise((resolve) => setTimeout(resolve, frame.delayMs))
  }
  if ('error' in frame) {
    const err = isError(frame.error) ? frame.error : new Error(frame.error)
    controller.error(err)
    return
  }
}

const renderNdjsonFrame = (
  frame: NdjsonFrame,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> | void => {
  if ('json' in frame) {
    controller.enqueue(encoder.encode(`${JSON.stringify(frame.json)}\n`))
    return
  }
  if ('raw' in frame) {
    controller.enqueue(encoder.encode(frame.raw))
    return
  }
  if ('delayMs' in frame) {
    return new Promise((resolve) => setTimeout(resolve, frame.delayMs))
  }
  if ('error' in frame) {
    const err = isError(frame.error) ? frame.error : new Error(frame.error)
    controller.error(err)
    return
  }
}

/** Build a `Response` object from a `CassetteResponse`. */
export const materializeCassetteResponse = (resp: CassetteResponse): Response => {
  const status = resp.status ?? 200
  if (resp.ndjson) {
    const frames = resp.ndjson
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let errored = false
          for (const f of frames) {
            if (isObject(f) && 'error' in f) {
              const errVal = (f as { error: unknown }).error
              const err = isError(errVal) ? errVal : new Error(String(errVal))
              controller.error(err)
              errored = true
              break
            }
            const result = renderNdjsonFrame(f, controller)
            if (isInstanceOf(result, 'Promise', Promise)) await result
          }
          if (!errored) controller.close()
        } catch (e) {
          controller.error(e as Error)
        }
      },
    })
    return new Response(body, {
      status,
      headers: {
        'content-type': 'application/x-ndjson',
        ...(resp.headers ?? {}),
      },
    })
  }
  if (resp.sse) {
    const frames = resp.sse
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let errored = false
          for (const f of frames) {
            if (isObject(f) && 'error' in f) {
              const errVal = (f as { error: unknown }).error
              const err = isError(errVal) ? errVal : new Error(String(errVal))
              controller.error(err)
              errored = true
              break
            }
            const result = renderSseFrame(f, controller)
            if (isInstanceOf(result, 'Promise', Promise)) await result
          }
          if (!errored) controller.close()
        } catch (e) {
          controller.error(e as Error)
        }
      },
    })
    return new Response(body, {
      status,
      headers: {
        'content-type': 'text/event-stream',
        ...(resp.headers ?? {}),
      },
    })
  }
  const bodyText = resp.body === undefined ? '' : JSON.stringify(resp.body)
  return new Response(bodyText, {
    status,
    headers: {
      'content-type': 'application/json',
      ...(resp.headers ?? {}),
    },
  })
}

// ─── request matching ────────────────────────────────────────────────────────

const deepIncludes = (actual: unknown, expected: unknown): boolean => {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    if (actual.length !== expected.length) return false
    return expected.every((v, i) => deepIncludes(actual[i], v))
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return false
  }
  const a = actual as Record<string, unknown>
  const e = expected as Record<string, unknown>
  for (const k of Object.keys(e)) {
    if (!deepIncludes(a[k], e[k])) return false
  }
  return true
}

const matchUrl = (expected: NonNullable<RequestMatcher['url']>, actual: string): boolean => {
  if (typeof expected === 'string') return expected === actual
  if (isInstanceOf(expected, 'RegExp', RegExp)) return expected.test(actual)
  return expected(actual)
}

const matchBody = (expected: NonNullable<RequestMatcher['body']>, actual: unknown): boolean => {
  if (typeof expected === 'function') return expected(actual)
  return deepIncludes(actual, expected)
}

const matchHeaders = (
  expected: NonNullable<RequestMatcher['headers']>,
  actual: Headers | undefined
): boolean => {
  if (!actual) return Object.keys(expected).length === 0
  for (const [name, value] of Object.entries(expected)) {
    if (actual.get(name) !== value) return false
  }
  return true
}

interface ParsedRequest {
  method: string
  url: string
  headers: Headers
  body: unknown
}

const parseFetchCall = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): ParsedRequest => {
  let method = 'GET'
  let url = ''
  let headers = new Headers()
  let bodyRaw: string | undefined
  if (typeof input === 'string') {
    url = input
  } else if (isInstanceOf(input, 'URL', URL)) {
    url = input.toString()
  } else {
    // Request instance
    const req = input as Request
    url = req.url
    method = req.method
    headers = new Headers(req.headers)
  }
  if (init) {
    if (init.method) method = init.method
    if (init.headers) headers = new Headers(init.headers as HeadersInit)
    if (typeof init.body === 'string') bodyRaw = init.body
  }
  let body: unknown
  if (bodyRaw !== undefined) {
    try {
      body = JSON.parse(bodyRaw)
    } catch {
      body = bodyRaw
    }
  }
  if (init?.method) method = init.method
  return { method, url, headers, body }
}

const matchesInteraction = (interaction: Interaction, req: ParsedRequest): boolean => {
  const m = interaction.request
  if (!m) return true
  if (m.method && m.method.toUpperCase() !== req.method.toUpperCase()) return false
  if (m.url !== undefined && !matchUrl(m.url, req.url)) return false
  if (m.body !== undefined && !matchBody(m.body, req.body)) return false
  if (m.headers !== undefined && !matchHeaders(m.headers, req.headers)) return false
  return true
}

// ─── replay engine ───────────────────────────────────────────────────────────

/**
 * Construct a `fetch`-shaped function that serves responses from a cassette.
 * The returned fn is a plain async function; wrap with `vi.fn(...)` if you
 * need call-counting / spy semantics in vitest.
 *
 * Match semantics:
 *   - `'once'` (default): walks `interactions` in order. The first not-yet-consumed
 *     interaction whose matcher accepts the request fires and is then marked
 *     consumed. Once all are consumed, further requests throw.
 *   - `'reusable'`: every request scans all interactions and fires the first match
 *     found; no consumption tracking.
 *
 * On no-match, the function throws an Error describing the unmatched request and
 * the remaining interactions, so test failures point at the cassette/request
 * mismatch rather than a generic "fetch failed".
 */
export const cassetteFetch = (
  cassette: Cassette
): ((
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
) => Promise<Response>) => {
  const mode = cassette.mode ?? 'once'
  const consumed = new Set<number>()
  let callIndex = 0
  return async (input, init) => {
    const req = parseFetchCall(input, init)
    const idx = callIndex++
    for (let i = 0; i < cassette.interactions.length; i++) {
      if (mode === 'once' && consumed.has(i)) continue
      const interaction = cassette.interactions[i]
      if (matchesInteraction(interaction, req)) {
        if (mode === 'once') consumed.add(i)
        return materializeCassetteResponse(interaction.response)
      }
    }
    const remaining =
      mode === 'once'
        ? cassette.interactions
            .filter((_, i) => !consumed.has(i))
            .map((it, i) => it.label ?? `#${i}`)
        : cassette.interactions.map((it, i) => it.label ?? `#${i}`)
    throw new Error(
      `[cassette ${cassette.name}] no interaction matched fetch call #${idx} ` +
        `(${req.method} ${req.url}). Remaining: [${remaining.join(', ')}]`
    )
  }
}

// ─── programmatic builders ───────────────────────────────────────────────────

let synthCounter = 0
const synthId = (prefix: string): string => {
  synthCounter += 1
  return `${prefix}-${synthCounter.toString(36)}`
}

/** Reset the synthetic id counter — call in `beforeEach` for stable test output. */
export const resetCassetteIds = (): void => {
  synthCounter = 0
}

/** Programmatically build a non-streaming Chat Completions response body. */
export const buildChatCompletion = (input: {
  content?: string
  model?: string
  toolCalls?: ReadonlyArray<{
    id?: string
    name: string
    arguments: unknown
    type?: 'function' | 'custom'
  }>
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  id?: string
}): Record<string, unknown> => {
  const id = input.id ?? synthId('chatcmpl')
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: input.content ?? null,
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    message.tool_calls = input.toolCalls.map((tc, i) => ({
      id: tc.id ?? `call_${id}_${i}`,
      type: tc.type ?? 'function',
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
    }))
  }
  const finishReason =
    input.finishReason ?? (input.toolCalls && input.toolCalls.length > 0 ? 'tool_calls' : 'stop')
  return {
    id,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: input.model ?? 'gpt-x',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(input.usage ? { usage: input.usage } : {}),
  }
}

/**
 * Programmatically build SSE frames for a streaming Chat Completions response.
 * Returns the frame array (NOT the final `[DONE]` terminator — call sites
 * append that, or pass it through `buildStreamingResponse`).
 */
export const buildStreamingChatCompletionFrames = (input: {
  deltas?: ReadonlyArray<string>
  /** Reasoning content deltas (compatible providers; e.g. DeepSeek). */
  reasoningDeltas?: ReadonlyArray<string>
  toolCallDeltas?: ReadonlyArray<{
    index: number
    id?: string
    type?: 'function' | 'custom'
    name?: string
    argumentsChunk?: string
  }>
  model?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  id?: string
  /** Emit a `role: 'assistant'` first frame (the typical OpenAI shape). */
  emitRole?: boolean
  /** Emit a final usage frame after `finishReason` (compatible with stream_options.include_usage). */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}): SSEFrame[] => {
  const id = input.id ?? synthId('chatcmpl-stream')
  const model = input.model ?? 'gpt-x'
  const frames: SSEFrame[] = []
  const baseChunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  if (input.emitRole !== false && (input.deltas?.length ?? 0) > 0) {
    frames.push({ json: baseChunk({ role: 'assistant', content: input.deltas![0] }, null) })
    for (let i = 1; i < input.deltas!.length; i++) {
      frames.push({ json: baseChunk({ content: input.deltas![i] }, null) })
    }
  } else if (input.deltas) {
    for (const d of input.deltas) {
      frames.push({ json: baseChunk({ content: d }, null) })
    }
  }
  if (input.reasoningDeltas) {
    for (const r of input.reasoningDeltas) {
      frames.push({ json: baseChunk({ reasoning_content: r }, null) })
    }
  }
  if (input.toolCallDeltas) {
    for (const tc of input.toolCallDeltas) {
      const fn: Record<string, unknown> = {}
      if (tc.name !== undefined) fn.name = tc.name
      if (tc.argumentsChunk !== undefined) fn.arguments = tc.argumentsChunk
      const entry: Record<string, unknown> = { index: tc.index, function: fn }
      if (tc.id !== undefined) entry.id = tc.id
      if (tc.type !== undefined) entry.type = tc.type
      frames.push({ json: baseChunk({ tool_calls: [entry] }, null) })
    }
  }
  const finishReason = input.finishReason === undefined ? 'stop' : input.finishReason
  if (finishReason !== null) {
    frames.push({ json: baseChunk({}, finishReason) })
  }
  if (input.usage) {
    frames.push({
      json: {
        id,
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: input.usage,
      },
    })
  }
  return frames
}

/** Convenience: build complete SSE frame list including the `[DONE]` terminator. */
export const buildStreamingResponse = (
  input: Parameters<typeof buildStreamingChatCompletionFrames>[0]
): SSEFrame[] => [...buildStreamingChatCompletionFrames(input), '[DONE]']

/** Build an error response (non-2xx). Optional `retryAfter` becomes a header. */
export const buildErrorResponse = (input: {
  status: number
  body?: unknown
  retryAfter?: string | number
  headers?: Record<string, string>
}): CassetteResponse => {
  const headers: Record<string, string> = { ...(input.headers ?? {}) }
  if (input.retryAfter !== undefined) {
    headers['retry-after'] = String(input.retryAfter)
  }
  return {
    status: input.status,
    headers,
    body: input.body ?? { error: { message: `HTTP ${input.status}` } },
  }
}

// ─── convenience composers ───────────────────────────────────────────────────

/**
 * One-liner cassette for a single non-streaming response. The match is
 * permissive (any POST to anything) so the cassette can be dropped into any
 * adapter test as a sanity backstop.
 */
export const singleChatCompletionCassette = (
  name: string,
  input: Parameters<typeof buildChatCompletion>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-response',
      request: { method: 'POST' },
      response: { body: buildChatCompletion(input) },
    },
  ],
})

/** One-liner cassette for a single streaming response. */
export const singleStreamingCassette = (
  name: string,
  input: Parameters<typeof buildStreamingResponse>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-stream',
      request: { method: 'POST' },
      response: { sse: buildStreamingResponse(input) },
    },
  ],
})

// ─── Ollama native /api/chat builders ─────────────────────────────────────────

/** Native Ollama generation-stats fields carried on the terminal (`done: true`) object. */
export interface OllamaStats {
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

/** Native Ollama tool-call shape — `arguments` is a JSON OBJECT, and there is no `id`/`type`. */
export interface OllamaToolCallSpec {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Programmatically build a non-streaming Ollama `/api/chat` response object (`done: true`).
 * Note the native shape: a single top-level `message` (not `choices[]`), `thinking` for reasoning,
 * `tool_calls[].function.arguments` as an object, and `done_reason` + ns stats at the top level.
 */
export const buildOllamaChatResponse = (input: {
  content?: string
  thinking?: string
  toolCalls?: ReadonlyArray<OllamaToolCallSpec>
  model?: string
  doneReason?: 'stop' | 'load' | 'unload'
  stats?: OllamaStats
}): Record<string, unknown> => {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: input.content ?? '',
  }
  if (input.thinking !== undefined) message.thinking = input.thinking
  if (input.toolCalls && input.toolCalls.length > 0) {
    message.tool_calls = input.toolCalls.map((tc) => ({
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }
  return {
    model: input.model ?? 'llama3.2',
    created_at: '2026-01-01T00:00:00.000000Z',
    message,
    done: true,
    done_reason: input.doneReason ?? 'stop',
    ...(input.stats ?? {}),
  }
}

/**
 * Programmatically build NDJSON frames for a streaming Ollama `/api/chat` response.
 * Emits a `message` chunk per content / thinking delta (and whole `tool_calls` on a single chunk,
 * as Ollama does — no fragment accumulation), then a terminal `{ done: true, ...stats }` frame.
 * There is no `[DONE]` sentinel; the `done: true` frame IS the terminator.
 */
export const buildOllamaStreamFrames = (input: {
  contentDeltas?: ReadonlyArray<string>
  thinkingDeltas?: ReadonlyArray<string>
  toolCalls?: ReadonlyArray<OllamaToolCallSpec>
  model?: string
  doneReason?: 'stop' | 'load' | 'unload'
  stats?: OllamaStats
}): NdjsonFrame[] => {
  const model = input.model ?? 'llama3.2'
  const createdAt = '2026-01-01T00:00:00.000000Z'
  const frames: NdjsonFrame[] = []
  const chunk = (message: Record<string, unknown>): NdjsonFrame => ({
    json: { model, created_at: createdAt, message, done: false },
  })
  for (const d of input.thinkingDeltas ?? []) {
    frames.push(chunk({ role: 'assistant', content: '', thinking: d }))
  }
  for (const d of input.contentDeltas ?? []) {
    frames.push(chunk({ role: 'assistant', content: d }))
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    frames.push(
      chunk({
        role: 'assistant',
        content: '',
        tool_calls: input.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      })
    )
  }
  // Terminal frame: empty message + done:true + stats. This is the NDJSON terminator.
  frames.push({
    json: {
      model,
      created_at: createdAt,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: input.doneReason ?? 'stop',
      ...(input.stats ?? {}),
    },
  })
  return frames
}

/** One-liner cassette for a single non-streaming Ollama `/api/chat` response. */
export const singleOllamaResponseCassette = (
  name: string,
  input: Parameters<typeof buildOllamaChatResponse>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-ollama-response',
      request: { method: 'POST' },
      response: { body: buildOllamaChatResponse(input) },
    },
  ],
})

/** One-liner cassette for a single streaming Ollama `/api/chat` response. */
export const singleOllamaStreamCassette = (
  name: string,
  input: Parameters<typeof buildOllamaStreamFrames>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-ollama-stream',
      request: { method: 'POST' },
      response: { ndjson: buildOllamaStreamFrames(input) },
    },
  ],
})

// ─── Anthropic native /v1/messages builders ───────────────────────────────────

/** Minimal Anthropic text block builder input. */
export interface AnthropicThinkingBlockSpec {
  thinking: string
  signature: string
}

/** Minimal Anthropic tool-use block builder input. */
export interface AnthropicToolUseSpec {
  id: string
  name: string
  input: Record<string, unknown>
}

/** Programmatically build a non-streaming Anthropic `/v1/messages` response object. */
export const buildAnthropicMessagesResponse = (input: {
  id?: string
  model?: string
  content?: string
  thinking?: ReadonlyArray<AnthropicThinkingBlockSpec>
  redactedThinking?: ReadonlyArray<{ data: string }>
  toolUses?: ReadonlyArray<AnthropicToolUseSpec>
  stopReason?: string | null
  stopSequence?: string | null
  stopDetails?: unknown
  usage?: Record<string, unknown>
}): Record<string, unknown> => {
  const content: Array<Record<string, unknown>> = []
  for (const block of input.thinking ?? []) {
    content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
  }
  for (const block of input.redactedThinking ?? []) {
    content.push({ type: 'redacted_thinking', data: block.data })
  }
  if ((input.content ?? '').length > 0) {
    content.push({ type: 'text', text: input.content ?? '' })
  }
  for (const tool of input.toolUses ?? []) {
    content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })
  }
  return {
    id: input.id ?? 'msg_anthem_1',
    type: 'message',
    role: 'assistant',
    model: input.model ?? 'claude-opus-5',
    content,
    stop_reason: input.stopReason ?? 'end_turn',
    stop_sequence: input.stopSequence ?? null,
    ...(input.stopDetails !== undefined ? { stop_details: input.stopDetails } : {}),
    usage: input.usage ?? { input_tokens: 11, output_tokens: 2 },
  }
}

const anthropicEventFrame = (event: Record<string, unknown>): SSEFrame => ({
  raw: `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
})

/**
 * Programmatically build named-event SSE frames for a streaming Anthropic `/v1/messages` response.
 * Unlike OpenAI-style data-only SSE, Anthropic keys off the `event:` line, so every frame is
 * emitted verbatim as `{ raw }`.
 */
export const buildAnthropicStreamFrames = (input: {
  id?: string
  model?: string
  events?: ReadonlyArray<Record<string, unknown>>
  stopReason?: string | null
  stopSequence?: string | null
  stopDetails?: unknown
  usageStart?: Record<string, unknown>
  usageDelta?: Record<string, unknown>
  includeMessageStart?: boolean
  includeMessageDelta?: boolean
  includeMessageStop?: boolean
}): SSEFrame[] => {
  const model = input.model ?? 'claude-opus-5'
  const frames: SSEFrame[] = []
  if (input.includeMessageStart !== false) {
    frames.push(
      anthropicEventFrame({
        type: 'message_start',
        message: {
          id: input.id ?? 'msg_anthem_stream_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: input.usageStart ?? { input_tokens: 9, output_tokens: 0 },
        },
      })
    )
  }
  for (const event of input.events ?? []) {
    frames.push(anthropicEventFrame(event))
  }
  if (input.includeMessageDelta !== false) {
    frames.push(
      anthropicEventFrame({
        type: 'message_delta',
        delta: {
          stop_reason: input.stopReason ?? 'end_turn',
          stop_sequence: input.stopSequence ?? null,
          ...(input.stopDetails !== undefined ? { stop_details: input.stopDetails } : {}),
        },
        usage: input.usageDelta ?? { output_tokens: 2 },
      })
    )
  }
  if (input.includeMessageStop !== false) {
    frames.push(anthropicEventFrame({ type: 'message_stop' }))
  }
  return frames
}

/** One-liner cassette for a single non-streaming Anthropic `/v1/messages` response. */
export const singleAnthropicResponseCassette = (
  name: string,
  input: Parameters<typeof buildAnthropicMessagesResponse>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-anthropic-response',
      request: { method: 'POST' },
      response: { body: buildAnthropicMessagesResponse(input) },
    },
  ],
})

/** One-liner cassette for a single streaming Anthropic `/v1/messages` response. */
export const singleAnthropicStreamCassette = (
  name: string,
  input: Parameters<typeof buildAnthropicStreamFrames>[0]
): Cassette => ({
  name,
  interactions: [
    {
      label: 'single-anthropic-stream',
      request: { method: 'POST' },
      response: { sse: buildAnthropicStreamFrames(input) },
    },
  ],
})
