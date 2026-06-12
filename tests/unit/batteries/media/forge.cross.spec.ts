import { describe, expect, it } from 'vitest'
import { createMediaPipeline } from '../../../../src/batteries/media'
import { forgeMediaTools } from '../../../../src/batteries/media/forge'
import { makeMediaCtxStub, callMediaTool, mediaOf } from '../../../_fixtures/media_tool_ctx_stub'
import type { Media } from '../../../../src/lib/classes/media'
import type { MediaPipeline } from '../../../../src/batteries/media'

const encoder = new TextEncoder()
const textMedia = (text: string, id: string, filename = 'note.txt') =>
  mediaOf(encoder.encode(text), 'text/plain', filename, id)

const makePipeline = (): Promise<MediaPipeline> => createMediaPipeline()

describe('forgeMediaTools — composite surface', () => {
  it('mints list_media + media_query, keyed by name', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    expect(Object.keys(tools).sort()).toEqual(['list_media', 'media_query'])
  })

  it('media_query description embeds only available verbs', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const description = tools.media_query.description
    expect(description).toContain('select pages')
    expect(description).toContain('extract text')
    expect(description).not.toContain('- convert to=')
  })

  it('list_media enumerates attachments and tool results with origins', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({
      attachments: [textMedia('a', 'id-a', 'a.txt')],
      toolResults: [textMedia('b', 'id-b', 'b.txt')],
    })
    const outcome = await callMediaTool(tools.list_media, ctx, {})
    expect(outcome.kind).toBe('string')
    const listed = JSON.parse((outcome as { out: string }).out) as Array<Record<string, string>>
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ id: 'id-a', origin: 'attachment' })
    expect(listed[1]).toMatchObject({ id: 'id-b', origin: 'tool-result' })
  })

  it('runs a pipe statement against an attachment and returns first-party Media', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx, stored } = makeMediaCtxStub({
      attachments: [textMedia('ssn 123-45-6789', 'doc-1')],
    })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-1',
      q: 'redact match=/\\d{3}-\\d{2}-\\d{4}/ replace="[X]"',
    })
    expect(outcome.kind).toBe('media')
    const media = (outcome as { media: Media }).media
    expect(media.trustTier).toBe('first-party')
    expect(media.source).toBe('tool:media_query')
    const bytes = stored.get(media.id)
    expect(bytes).toBeDefined()
    expect(new TextDecoder().decode(bytes)).toBe('ssn [X]')
  })

  it('accepts ops as the structured alternative and yields the same plan result', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('a.\n\nb.', 'doc-1')] })
    const viaQ = await callMediaTool(tools.media_query, ctx, { media_id: 'doc-1', q: 'chunk' })
    const viaOps = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-1',
      ops: [{ verb: 'chunk', args: {} }],
    })
    expect(viaQ.kind).toBe('string')
    expect(viaOps).toEqual(viaQ)
  })

  it('rejects both-or-neither of q/ops with a readable failure', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'doc-1')] })
    const neither = await callMediaTool(tools.media_query, ctx, { media_id: 'doc-1' })
    expect(neither.kind).toBe('string')
    expect((neither as { out: string }).out).toContain('Error (BAD_REQUEST)')
    const both = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-1',
      q: 'chunk',
      ops: [{ verb: 'chunk', args: {} }],
    })
    expect((both as { out: string }).out).toContain('Error (BAD_REQUEST)')
  })

  it('MEDIA_NOT_FOUND lists visible ids', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'real-id', 'real.txt')] })
    const outcome = await callMediaTool(tools.media_query, ctx, { media_id: 'nope', q: 'chunk' })
    expect(outcome.kind).toBe('string')
    const out = (outcome as { out: string }).out
    expect(out).toContain('Error (MEDIA_NOT_FOUND)')
    expect(out).toContain('real-id')
    expect(out).toContain('real.txt')
  })

  it('pipe syntax errors render as readable failure strings (model can repair)', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'doc-1')] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-1',
      q: 'redackt match=x',
    })
    expect(outcome.kind).toBe('string')
    const out = (outcome as { out: string }).out
    expect(out).toContain('Error (UNKNOWN_VERB)')
    expect(out).toContain('did you mean "redact"')
  })

  it('multi-input verbs resolve @id refs through the media resolver', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({
      attachments: [
        textMedia('line one\n', 'doc-a', 'a.txt'),
        textMedia('line two\n', 'doc-b', 'b.txt'),
      ],
    })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-a',
      q: 'diff with=@doc-b',
    })
    expect(outcome.kind).toBe('string')
    expect((outcome as { out: string }).out).toContain('-line one')
    expect((outcome as { out: string }).out).toContain('+line two')
  })
})

describe('forgeMediaTools — granular surface', () => {
  it('mints one tool per available verb plus list_media; engine-gated verbs absent', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    expect(tools.list_media).toBeDefined()
    expect(tools.select).toBeDefined()
    expect(tools.extract_text).toBeDefined()
    // sheet.* verbs now require an edit-capable engine (exceljs/sheetjs) — none configured.
    expect(tools.sheet_update_cells).toBeUndefined()
    expect(tools.convert).toBeUndefined()
    expect(tools.image_resize).toBeUndefined()
    expect(tools.audio_transcribe).toBeUndefined()
  })

  it('a granular tool runs its one-verb plan', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('one.\n\ntwo.', 'doc-1')] })
    const outcome = await callMediaTool(tools.chunk, ctx, { media_id: 'doc-1', by: 'paragraph' })
    expect(outcome.kind).toBe('string')
    const chunks = JSON.parse((outcome as { out: string }).out) as unknown[]
    expect(chunks).toHaveLength(2)
  })

  it('granular media-ref args accept id strings', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx } = makeMediaCtxStub({
      attachments: [textMedia('a\n', 'doc-a'), textMedia('b\n', 'doc-b')],
    })
    const outcome = await callMediaTool(tools.diff, ctx, { media_id: 'doc-a', with: 'doc-b' })
    expect(outcome.kind).toBe('string')
    expect((outcome as { out: string }).out).toContain('+b')
  })

  it('schema validation rejects bad enum values before the handler runs', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'doc-1')] })
    const outcome = await callMediaTool(tools.chunk, ctx, { media_id: 'doc-1', by: 'bogus' })
    expect(outcome.kind).toBe('threw')
    expect((outcome as { errorName: string }).errorName).toContain('E_INVALID_TOOL_ARGS')
  })
})

describe('the gate seam', () => {
  it('the gate runs before execution and sees the call', async () => {
    const calls: Array<{ tool: string; args: unknown }> = []
    const tools = forgeMediaTools(await makePipeline(), {
      surface: 'composite',
      gate: (_ctx, call) => {
        calls.push(call)
      },
    })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'doc-1')] })
    await callMediaTool(tools.media_query, ctx, { media_id: 'doc-1', q: 'chunk' })
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('media_query')
  })

  it('a gate denial short-circuits into the tool-error path', async () => {
    const tools = forgeMediaTools(await makePipeline(), {
      surface: 'composite',
      gate: () => {
        throw new Error('operator denied this operation')
      },
    })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('x', 'doc-1')] })
    const outcome = await callMediaTool(tools.media_query, ctx, { media_id: 'doc-1', q: 'chunk' })
    expect(outcome.kind).toBe('threw')
    const threw = outcome as { errorName: string; error: unknown }
    expect(threw.errorName).toBe('E_TOOL_DOWNSTREAM_ERROR')
    expect(((threw.error as Error).cause as Error).message).toContain('operator denied')
  })

  it('no gate configured means zero behavior change', async () => {
    const gated = forgeMediaTools(await makePipeline(), {
      surface: 'composite',
      gate: async () => {},
    })
    const ungated = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx: ctxA } = makeMediaCtxStub({ attachments: [textMedia('a.\n\nb.', 'doc-1')] })
    const { ctx: ctxB } = makeMediaCtxStub({ attachments: [textMedia('a.\n\nb.', 'doc-1')] })
    const a = await callMediaTool(gated.media_query, ctxA, { media_id: 'doc-1', q: 'chunk' })
    const b = await callMediaTool(ungated.media_query, ctxB, { media_id: 'doc-1', q: 'chunk' })
    expect(a).toEqual(b)
  })
})

describe('forge config validation', () => {
  it('requires a valid surface', async () => {
    const pipeline = await makePipeline()
    // @ts-expect-error missing surface
    expect(() => forgeMediaTools(pipeline, {})).toThrow(/surface/)
  })

  it('overrides rename tools and the record key follows', async () => {
    const tools = forgeMediaTools(await makePipeline(), {
      surface: 'composite',
      overrides: { media_query: { name: 'process_file' } },
    })
    expect(tools.process_file).toBeDefined()
    expect(tools.media_query).toBeUndefined()
  })
})

// ── media generation: the empty:<format> sentinel ───────────────────────────

/** A stub generator engine — keeps the browser project peer-free. */
const stubGeneratorEngine = () => ({
  id: 'stub-gen',
  converts: [
    {
      from: ['application/x-adk-empty'],
      to: ['xlsx', 'txt'],
      convert: async (request: { to: string }) => ({
        outputs: [
          request.to === 'xlsx'
            ? {
                bytes: new TextEncoder().encode('stub-xlsx-bytes'),
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              }
            : { bytes: new TextEncoder().encode(''), mimeType: 'text/plain' },
        ],
      }),
    },
  ],
})

const makeGenPipeline = (): Promise<MediaPipeline> =>
  createMediaPipeline({ engines: [stubGeneratorEngine()] })

describe('media generation — the empty:<format> sentinel', () => {
  it('empty:txt + q creates new media without touching resolveMedia', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'empty:txt',
      q: 'append text="created from nothing"',
    })
    expect(outcome.kind).toBe('media')
    const media = (outcome as { media: Media }).media
    expect(media.filename).toBe('untitled.txt')
    expect(new TextDecoder().decode(await media.asBytes())).toBe('created from nothing\n')
  })

  it('empty:nope fails with EMPTY_FORMAT_UNAVAILABLE listing creatable formats', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'empty:nope',
      q: 'append text=x',
    })
    expect(outcome.kind).toBe('string')
    const out = (outcome as { out: string }).out
    expect(out).toContain('Error (EMPTY_FORMAT_UNAVAILABLE)')
    expect(out).toContain('xlsx')
    expect(out).toContain('txt')
    expect(out).toContain('Do not retry')
  })

  it('with no generator engine the sentinel is unavailable and never advertised', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    expect(tools.media_query.description).not.toContain('Creating new media')
    const { ctx } = makeMediaCtxStub({ attachments: [] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'empty:txt',
      q: 'chunk',
    })
    expect((outcome as { out: string }).out).toContain('Error (EMPTY_FORMAT_UNAVAILABLE)')
  })

  it('with a generator engine the descriptions advertise creation', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    expect(tools.media_query.description).toContain('Creating new media')
    expect(tools.media_query.description).toContain('empty:<format>')
    const granular = forgeMediaTools(await makeGenPipeline(), { surface: 'granular' })
    const appendTool = granular.append
    expect(appendTool).toBeDefined()
  })

  it('MEDIA_NOT_FOUND gains the create exemplar when creation is possible', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'no-such-id',
      q: 'chunk',
    })
    const out = (outcome as { out: string }).out
    expect(out).toContain('Error (MEDIA_NOT_FOUND)')
    expect(out).toContain('To create NEW media instead')
  })

  it('MEDIA_NOT_FOUND stays unchanged when nothing is creatable', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'no-such-id',
      q: 'chunk',
    })
    const out = (outcome as { out: string }).out
    expect(out).toContain('Error (MEDIA_NOT_FOUND)')
    expect(out).not.toContain('To create NEW media instead')
  })

  it('@empty:<format> works as a ref in pipe statements (lexes and resolves)', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({
      attachments: [textMedia('original\n', 'doc-a', 'a.txt')],
    })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-a',
      q: 'diff with=@empty:txt',
    })
    expect(outcome.kind).toBe('string')
    expect((outcome as { out: string }).out).toContain('-original')
  })

  it('normal ids resolve exactly as before (the sentinel path is additive)', async () => {
    const tools = forgeMediaTools(await makeGenPipeline(), { surface: 'composite' })
    const { ctx } = makeMediaCtxStub({ attachments: [textMedia('hello', 'doc-1')] })
    const outcome = await callMediaTool(tools.media_query, ctx, {
      media_id: 'doc-1',
      q: 'append text=world',
    })
    expect(outcome.kind).toBe('media')
  })
})
