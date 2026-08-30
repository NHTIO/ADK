import { describe, expect, it } from 'vitest'
import { forgeMediaTools } from '../../../../src/batteries/media/forge'
import { createMediaPipeline, PCM_MIME } from '../../../../src/batteries/media'
import { exceljsEngine } from '../../../../src/batteries/media/engines/exceljs'
import { makeMediaCtxStub, callMediaTool, mediaOf } from '../../../_fixtures/media_tool_ctx_stub'
import type { Media } from '../../../../src/lib/classes/media'
import type { MediaEngine, MediaPipeline } from '../../../../src/batteries/media'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const textMedia = (text: string, id: string, filename = 'note.txt') =>
  mediaOf(encoder.encode(text), 'text/plain', filename, id)
const jsonMedia = (text: string, id: string, filename = 'note.json') =>
  mediaOf(encoder.encode(text), 'application/json', filename, id)

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

// ── C5: granularSchemaFor's default string branch now `.allow('')` ──────────
//
// `granularSchemaFor`'s `default:` switch case (the one every plain `type: 'string'` verb arg
// falls into) previously built `validator.string()` with no `.allow('')`, so `.required()`
// rejected an explicit empty string outright. This is the one lint-invisible bug in the whole
// sweep: the switch statement it lives in is never analyzed by the new eslint rule (see
// tests/unit/eslint/repo_rules.node.spec.ts's own switch-shape counterexample), so it was
// found and fixed by direct source reading, not by `pnpm lint`.
//
// The fix is a single line — `.allow('')` on the whole `default:` branch — but it reaches
// every verb arg whose `type` is exactly `'string'`: 19 args across 14 verbs. Two of those
// (`update_text.replace`, `redact.replace`) have documented empty-string meaning and get
// dedicated behavioral tests below; the other 17 get a flat regression test each, confirming
// the blanket change's accepted-risk side effect (schema now accepts `''`) without asserting
// any particular downstream behavior for the ones that have none documented.
describe('C5 — granular string args accept "" (granularSchemaFor default branch)', () => {
  it('update_text replace="" performs the documented delete-the-anchor behavior (previously unreachable)', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx, stored } = makeMediaCtxStub({
      attachments: [textMedia('hello WORLD bye', 'doc-1')],
    })
    const outcome = await callMediaTool(tools.update_text, ctx, {
      media_id: 'doc-1',
      anchor: 'WORLD ',
      replace: '',
    })
    expect(outcome.kind).toBe('media')
    const media = (outcome as { media: Media }).media
    const bytes = stored.get(media.id)
    expect(bytes).toBeDefined()
    expect(decoder.decode(bytes)).toBe('hello bye')
  })

  it('redact replace="" blanks the match instead of using the \'█\' default', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx, stored } = makeMediaCtxStub({
      attachments: [textMedia('secret ABC done', 'doc-1')],
    })
    const outcome = await callMediaTool(tools.redact, ctx, {
      media_id: 'doc-1',
      match: 'ABC',
      replace: '',
    })
    expect(outcome.kind).toBe('media')
    const media = (outcome as { media: Media }).media
    const bytes = stored.get(media.id)
    expect(bytes).toBeDefined()
    expect(decoder.decode(bytes)).toBe('secret  done')
  })

  it('update_text anchor="" passes validation and inserts replace at position 0 (String.includes(\'\') is always true)', async () => {
    const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
    const { ctx, stored } = makeMediaCtxStub({
      attachments: [textMedia('hello world', 'doc-1')],
    })
    const outcome = await callMediaTool(tools.update_text, ctx, {
      media_id: 'doc-1',
      anchor: '',
      replace: 'X',
    })
    expect(outcome.kind).toBe('media')
    const media = (outcome as { media: Media }).media
    const bytes = stored.get(media.id)
    expect(bytes).toBeDefined()
    expect(decoder.decode(bytes)).toBe('Xhello world')
  })

  it.each(['data_set', 'data_delete'] as const)(
    '%s path="" passes schema validation but fails at the handler level with the exact tool error',
    async (toolName) => {
      const tools = forgeMediaTools(await makePipeline(), { surface: 'granular' })
      const { ctx } = makeMediaCtxStub({
        attachments: [jsonMedia('{"a":1}', 'doc-1')],
      })
      const args =
        toolName === 'data_set'
          ? { media_id: 'doc-1', path: '', value: '1' }
          : { media_id: 'doc-1', path: '' }
      // Schema validation passes — no E_INVALID_TOOL_ARGS throw.
      const validated = await tools[toolName].validate(args)
      expect(validated).toMatchObject({ path: '' })
      // The handler-level rejection is a clean, actionable failure, not a silent overwrite.
      const outcome = await callMediaTool(tools[toolName], ctx, args)
      expect(outcome.kind).toBe('string')
      const out = (outcome as { out: string }).out
      expect(out).toContain('Error (STEP_FAILED)')
      expect(out).toContain('path must be a non-empty string')
    }
  )

  // The remaining 17 args (everything in the 19-arg/14-verb list minus update_text.replace and
  // redact.replace, which get dedicated behavioral tests above): confirm each now accepts ''
  // as an intentional, accepted-risk side effect of the blanket fix. Schema-level only — most
  // of these have no documented empty-string meaning, so `tool.validate()` (not a full handler
  // run) is the right altitude: it proves the fix's blast radius without asserting invented
  // behavior for args the plan explicitly does not specify one for.
  const stubPcmEngine: MediaEngine = {
    id: 'stub-pcm',
    converts: [
      {
        from: [PCM_MIME],
        to: ['txt'],
        convert: async () => ({ outputs: [{ bytes: new Uint8Array(0), mimeType: 'text/plain' }] }),
      },
    ],
  }

  // `update_text.anchor` is one of the 17 args on the exhaustive checklist, but it already
  // has a dedicated behavioral test above (schema acceptance + the traced "insert at position
  // 0" outcome) — a strict superset of the flat schema-only check every other row does here,
  // so it is intentionally not repeated in this table.
  it.each([
    ['apply_patch', { patch: '' }],
    ['append', { text: '' }],
    ['data_set', { path: '', value: '' }],
    ['data_merge', { fragment: '' }],
    ['data_delete', { path: '' }],
    ['slides_add', { title: '', layout: '' }],
    ['slides_update_text', { placeholder: '', text: '' }],
    ['slides_update_image', { placeholder: '' }],
    ['audio_transcribe', { lang: '' }],
  ] as const)('%s accepts "" for its plain-string arg(s)', async (toolName, extraArgs) => {
    const pipeline =
      toolName === 'audio_transcribe'
        ? await createMediaPipeline({ engines: [stubPcmEngine] })
        : await makePipeline()
    const tools = forgeMediaTools(pipeline, { surface: 'granular' })
    const tool = tools[toolName]
    expect(tool).toBeDefined()
    const args: Record<string, unknown> = { media_id: 'doc-1', ...extraArgs }
    if (toolName === 'slides_update_image') args.with = 'other-doc'
    const validated = (await tool.validate(args)) as Record<string, unknown>
    for (const [k, v] of Object.entries(extraArgs)) {
      expect(validated[k]).toBe(v)
    }
  })

  it.each([
    ['sheet_rename_sheet', { sheet: '', to: '' }],
    ['sheet_add_sheet', { name: '' }],
    ['sheet_remove_sheet', { sheet: '' }],
  ] as const)(
    '%s accepts "" for its plain-string arg(s) (edit-capable engine required to mint the tool)',
    async (toolName, extraArgs) => {
      const pipeline = await createMediaPipeline({ engines: [exceljsEngine()] })
      const tools = forgeMediaTools(pipeline, { surface: 'granular' })
      const tool = tools[toolName]
      expect(tool).toBeDefined()
      const args: Record<string, unknown> = { media_id: 'doc-1', ...extraArgs }
      const validated = (await tool.validate(args)) as Record<string, unknown>
      for (const [k, v] of Object.entries(extraArgs)) {
        expect(validated[k]).toBe(v)
      }
    }
  )
})
