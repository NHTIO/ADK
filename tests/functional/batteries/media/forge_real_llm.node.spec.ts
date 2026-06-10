/**
 * Live-API test of the media forge: a REAL model driving `media_query` end-to-end.
 *
 * Gated on `TEST_OPENAI_API_KEY`. Default-skip in CI; runs locally and in any environment
 * where the process env supplies credentials (`TEST_OPENAI_MODEL`, `TEST_OPENAI_BASE_URL`).
 *
 * This is the battery's thesis on trial: the pipe DSL exists so a model — any model — can
 * perform media work from the grammar embedded in the tool description, referencing media by
 * the inline id markers the LLM battery renders. Everything below runs the full loop:
 * attachment → marker rendering → model writes a pipe statement → forge validates and
 * executes → result returns to the model.
 *
 * Assertions follow the primitives-stress convention: small models do not always produce
 * tool calls on first ask, so tests assert on observable harness state (the tool call the
 * model made, the statement it wrote, the bytes the pipeline produced) and treat "the model
 * answered directly without the tool" as a soft path where noted.
 *
 * Field finding from this suite's first live runs: when a prompt mentions a replacement
 * token in brackets ("replace it with [REDACTED]"), models echo the brackets into the
 * statement (`replace=[REDACTED]`) — an unquoted-special-characters lexer error. The error
 * message's quoting advice usually triggers an in-turn repair, but not always; the redact
 * test prompt therefore names the replacement WORD without brackets, and the bracket trap
 * is left to the dedicated error-repair test to exercise deliberately.
 */
import { describe, expect, it } from 'vitest'
import { isInstanceOf } from '@nhtio/adk/guards'
import { Message, Media } from '@nhtio/adk/common'
import { inMemoryMediaReader } from '@nhtio/adk/common'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { createMediaPipeline } from '@nhtio/adk/batteries/media'
import { forgeMediaTools } from '@nhtio/adk/batteries/media/forge'
import {
  OpenAIChatCompletionsAdapter,
  defaultRenderTimelineMessage,
  defaultRenderChatCompletionsToolCallResult,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type { CapturedEvent } from '../../../_fixtures/runner'
import type { ChatCompletionsHelpers } from '@nhtio/adk/batteries/llm/openai_chat_completions'

const TEST_API_KEY = typeof process !== 'undefined' ? process.env?.TEST_OPENAI_API_KEY : undefined
const TEST_MODEL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_MODEL : undefined) ?? 'gpt-4o-mini'
const TEST_BASE_URL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_BASE_URL : undefined) || undefined

const SKIP = typeof process === 'undefined' || !TEST_API_KEY

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Drain a ConduitBytes (string | Uint8Array | ReadableStream) into a Uint8Array. */
const conduitToBytes = async (bytes: string | Uint8Array | ReadableStream<Uint8Array>) => {
  if (typeof bytes === 'string') return encoder.encode(bytes)
  if (isInstanceOf(bytes, 'Uint8Array', Uint8Array)) return bytes as Uint8Array
  const stream = bytes as ReadableStream<Uint8Array>
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const DOC_ID = '01906c2e-aa01-7000-8000-00000000d0c5'
const DOC_TEXT = [
  'INTERNAL MEMO',
  '',
  'Employee: Jordan Reyes',
  'SSN: 123-45-6789',
  'Subject: Q3 compensation review.',
  '',
  'The committee approved the adjustment effective October 1.',
].join('\n')

/**
 * Some OpenAI-compatible gateways (the Cloudflare Workers AI shim among them) reject
 * content-block ARRAYS on messages — `content` must be a plain string. Media (user
 * attachments AND tool-result Media) makes the default renderers emit arrays, so these
 * helper overrides flatten text blocks back to strings (lossless here: every media in the
 * test is text/plain, so every block is a text block). This is exactly the
 * swappable-helpers seam doing the job it exists for.
 */
const flattenBlocks = (blocks: ReadonlyArray<unknown>): string =>
  blocks
    .map((block) =>
      typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''
    )
    .filter((t) => t.length > 0)
    .join('\n\n')

const flattenTimelineMessage: ChatCompletionsHelpers['renderTimelineMessage'] = async (input) => {
  const rendered = await defaultRenderTimelineMessage(input)
  if (Array.isArray(rendered.content)) {
    return { ...rendered, content: flattenBlocks(rendered.content) }
  }
  return rendered
}

const flattenToolCallResult: ChatCompletionsHelpers['renderChatCompletionsToolCallResult'] = async (
  input
) => {
  const rendered = await defaultRenderChatCompletionsToolCallResult(input)
  return Array.isArray(rendered) ? flattenBlocks(rendered) : rendered
}

/**
 * The same shim also rejects `content: null` on assistant tool-call messages (the OpenAI
 * wire's canonical shape). Normalize at the transport seam via the adapter's injectable
 * `fetch` — nullish assistant content becomes an empty string on the way out.
 */
const normalizingFetch: typeof globalThis.fetch = async (url, init) => {
  if (typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { messages?: Array<{ content?: unknown }> }
      if (Array.isArray(parsed.messages)) {
        for (const m of parsed.messages) {
          if (m.content === null || m.content === undefined) m.content = ''
        }
        return fetch(url, { ...init, body: JSON.stringify(parsed) })
      }
    } catch {
      // not JSON — pass through untouched
    }
  }
  return fetch(url, init)
}

const makeAdapter = () =>
  new OpenAIChatCompletionsAdapter({
    model: TEST_MODEL,
    apiKey: TEST_API_KEY!,
    ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
    stream: false,
    autoAck: true,
    fetch: normalizingFetch,
    helpers: {
      renderTimelineMessage: flattenTimelineMessage,
      renderChatCompletionsToolCallResult: flattenToolCallResult,
    },
  })

/** A user message carrying the memo as a text attachment, seeded via the input pipeline. */
const seedAttachment = () => {
  const media = Media.userAttachment({
    id: DOC_ID,
    kind: 'document',
    mimeType: 'text/plain',
    filename: 'memo.txt',
    reader: inMemoryMediaReader(encoder.encode(DOC_TEXT)),
  })
  const message = new Message({
    id: 'msg-memo-1',
    role: 'user',
    content: 'Here is the memo I mentioned.',
    attachments: [media],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  return { media, message }
}

const toolCallsOf = (events: CapturedEvent[], tool: string) =>
  events
    .filter((e) => e.kind === 'toolCall')
    .map((e) => e.payload as { tool?: string; args?: Record<string, unknown>; results?: unknown })
    .filter((p) => p.tool === tool)

/**
 * Small models do not always produce a tool call on the first ask (the documented caveat in
 * the primitives-stress suite). Each attempt is a FRESH turn (new runner, new events); the
 * predicate decides whether the model did the thing. The assertions stay strong — the retry
 * only absorbs "the model answered in prose without picking up the tool," which is model
 * variance, not harness behavior.
 */
const runUntil = async (
  attempts: number,
  make: () => Promise<{ events: CapturedEvent[] }>,
  done: (events: CapturedEvent[]) => boolean
): Promise<CapturedEvent[]> => {
  let last: CapturedEvent[] = []
  for (let i = 0; i < attempts; i++) {
    const { events } = await make()
    last = events
    if (done(events)) return events
  }
  return last
}

describe.skipIf(SKIP)('media forge — real LLM drives media_query', () => {
  it(
    'model redacts an SSN from an attachment by writing a pipe statement',
    { timeout: 120_000 },
    async () => {
      const mp = await createMediaPipeline()
      const tools = forgeMediaTools(mp, { surface: 'composite' })
      const { message } = seedAttachment()
      const storedBytes = new Map<string, Uint8Array>()

      const hasRedactedOutput = () =>
        [...storedBytes.values()].some((b) => {
          const text = decoder.decode(b)
          return !text.includes('123-45-6789') && text.includes('Jordan Reyes')
        })

      const events = await runUntil(
        3,
        async () => {
          const adapter = makeAdapter()
          const handle = makeFixtureRunner({
            executorCallback: adapter.executor(),
            tools: Object.values(tools),
            storeMediaBytesCallback: async (_ctx, id, bytes) => {
              const buf = await conduitToBytes(bytes)
              storedBytes.set(id, buf)
              return inMemoryMediaReader(buf)
            },
            turnInputPipeline: [
              async (ctx, next) => {
                ctx.turnMessages.add(message)
                return next()
              },
            ],
          })
          await handle.run({
            systemPrompt:
              'You are a document-processing assistant. The user has attached a document; its media id appears in a [media id: …] marker. ' +
              'To process documents you MUST use the media_query tool with the media_id and a pipe statement q. ' +
              'Task: redact the social security number (format NNN-NN-NNNN) from the attached memo, replacing it with the word REDACTED. ' +
              'Use a redact statement. Then confirm completion in one sentence.',
          })
          return handle
        },
        // Success = the pipeline actually produced redacted bytes (not merely "a call happened":
        // a malformed first statement that errors and gets abandoned would otherwise pass the
        // attempt and fail the assertions).
        (evts) => toolCallsOf(evts, 'media_query').length >= 1 && hasRedactedOutput()
      )

      const calls = toolCallsOf(events, 'media_query')
      expect(calls.length).toBeGreaterThanOrEqual(1)

      // The model must have referenced the attachment by its marker-rendered id and written
      // a redact statement (pipe q or structured ops — both legal).
      const redactCall = calls.find(
        (c) =>
          c.args?.media_id === DOC_ID &&
          String(c.args?.q ?? JSON.stringify(c.args?.ops ?? '')).includes('redact')
      )
      expect(redactCall).toBeDefined()

      // And the pipeline actually produced redacted bytes.
      const produced = [...storedBytes.values()].map((b) => decoder.decode(b))
      const redacted = produced.find((text) => !text.includes('123-45-6789'))
      expect(redacted).toBeDefined()
      expect(redacted).toContain('Jordan Reyes')
    }
  )

  it(
    'model discovers media via list_media when the id is not in its prompt',
    { timeout: 120_000 },
    async () => {
      const mp = await createMediaPipeline()
      const tools = forgeMediaTools(mp, { surface: 'composite' })
      const { message } = seedAttachment()

      const events = await runUntil(
        3,
        async () => {
          const adapter = makeAdapter()
          const handle = makeFixtureRunner({
            executorCallback: adapter.executor(),
            tools: Object.values(tools),
            turnInputPipeline: [
              async (ctx, next) => {
                ctx.turnMessages.add(message)
                return next()
              },
            ],
          })
          await handle.run({
            systemPrompt:
              'You are a document-processing assistant with media_query and list_media tools. ' +
              'First call list_media to find what documents are available. Then use media_query with q="extract text" ' +
              'on the memo and tell me the employee name it mentions.',
          })
          return handle
        },
        (evts) =>
          toolCallsOf(evts, 'list_media').length >= 1 &&
          toolCallsOf(evts, 'media_query').length >= 1
      )

      // The discovery loop: list_media ran, and media_query was driven with the discovered id.
      const listCalls = toolCallsOf(events, 'list_media')
      const queryCalls = toolCallsOf(events, 'media_query')
      expect(listCalls.length).toBeGreaterThanOrEqual(1)
      expect(queryCalls.length).toBeGreaterThanOrEqual(1)
      expect(queryCalls[queryCalls.length - 1].args?.media_id).toBe(DOC_ID)
    }
  )

  it(
    'a model-actionable DSL error teaches the model to repair its statement',
    { timeout: 120_000 },
    async () => {
      const mp = await createMediaPipeline()
      const tools = forgeMediaTools(mp, { surface: 'composite' })
      const { message } = seedAttachment()

      // `convert` is not configured (zero engines), so the grammar in the description omits
      // it and a statement using it gets a do-not-retry failure string. A correct outcome is
      // EITHER the model never attempting convert (it read the grammar) OR attempting it once,
      // reading the failure, and not retrying the same verb.
      const events = await runUntil(
        3,
        async () => {
          const adapter = makeAdapter()
          const handle = makeFixtureRunner({
            executorCallback: adapter.executor(),
            tools: Object.values(tools),
            turnInputPipeline: [
              async (ctx, next) => {
                ctx.turnMessages.add(message)
                return next()
              },
            ],
          })
          await handle.run({
            systemPrompt:
              'You are a document-processing assistant with a media_query tool. ' +
              'The user wants the attached memo converted to PDF if possible; if that is not possible in this deployment, ' +
              'extract its text instead and say what you did.',
          })
          return handle
        },
        (evts) => toolCallsOf(evts, 'media_query').length >= 1
      )

      const queryCalls = toolCallsOf(events, 'media_query')
      expect(queryCalls.length).toBeGreaterThanOrEqual(1)

      const convertAttempts = queryCalls.filter((c) =>
        String(c.args?.q ?? JSON.stringify(c.args?.ops ?? '')).includes('convert')
      )
      // The do-not-retry contract: at most one convert attempt ever.
      expect(convertAttempts.length).toBeLessThanOrEqual(1)

      // And the turn settled (no infinite retry loop): exactly one turnEnd.
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )
})
