/**
 * Agent glue: forge ADK tools from a media pipeline, so a model can drive local media work.
 *
 * @module @nhtio/adk/batteries/media/forge
 *
 * @remarks
 * The pipeline core (`@nhtio/adk/batteries/media`) is agent-agnostic; this module is the layer
 * that knows the ADK loop. {@link forgeMediaTools} mints `Tool` instances over a configured
 * {@link @nhtio/adk/batteries/media!MediaPipeline} in one of two surfaces (the consumer picks
 * per deployment):
 *
 * - `'composite'` — one `media_query` tool taking `{ media_id, q }` (a pipe expression — the
 *   headline LLM DSL) or `{ media_id, ops }` (structured form), plus `list_media`. The tool
 *   description embeds the engine-narrowed verb grammar so the model never sees a verb the
 *   deployment can't run. One round-trip for multi-step work.
 * - `'granular'` — one narrow tool per available verb (`doc_select`, `sheet_update_cells`, …),
 *   each internally a one-verb plan. Friendlier to small models; bigger tool list.
 *
 * Media flows in by reference: the model passes `media_id` values it discovered via the
 * `list_media` tool (or inline id markers, where the LLM battery renders them); the resolver
 * scans `ctx.turnMessages[].attachments` and `ctx.turnToolCalls[].results` by default. Outputs
 * are persisted through `ctx.storeMediaBytes` and returned as `Media.toolGenerated(...)`, so
 * file results land on `ToolCall.results` as first-class media.
 *
 * Processing failures return readable strings (`Error (CODE): …`) the model can act on; the
 * pipe DSL's own syntax/semantic errors render the same way, so a model can repair its
 * statement and retry. An optional {@link ToolGateFn} runs before every execution — the seam
 * for human-approval/RBAC flows built on `ctx.waitFor` (the ADK gates primitive).
 */

import { toPipe } from './plan'
import { EMPTY_MIME } from './contracts'
import { isError } from '@nhtio/adk/guards'
import { availableVerbs } from './validate'
import { validator } from '@nhtio/validation'
import { VERB_INDEX, foldVerb } from './verbs'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from './exceptions'
// Documented exception (see CONTRIBUTING.md → Design Decisions → #13 Battery design): this module
// mints ADK `Tool` instances (`new Tool(...)`), calls `Media` static factories (`Media.isMedia`,
// `Media.toolGenerated`), and hands `SpooledJsonArtifact` to the forge as a constructor value
// (`artifactConstructor: () => SpooledJsonArtifact`) — all genuine runtime construction, not
// type-position use, so these stay value imports.
import { Tool, Media, SpooledJsonArtifact } from '@nhtio/adk/common'
import type { MediaPipeline } from './index'
import type { EngineRegistry } from './registry'
import type { MediaOp, MediaArgValue } from './plan'
import type { VerbSpec, VerbArgSpec } from './verbs'
import type { DispatchContext } from '@nhtio/adk/types'
import type { StepPayload, PlanResult } from './runtime'

/**
 * Resolves a `media_id` to a {@link @nhtio/adk!Media} visible in the current dispatch.
 * The default implementation scans turn messages' attachments and prior tool-call results.
 */
export type MediaResolverFn = (
  ctx: DispatchContext,
  mediaId: string
) => Media | undefined | Promise<Media | undefined>

/**
 * Optional per-call gate run before any pipeline execution. Throwing aborts the call and
 * surfaces through the standard tool-error path. The canonical implementation awaits
 * `ctx.waitFor({ reason: 'tool_approval', payload: call })` and throws on denial — WHO
 * approves and HOW is the consumer's contract; this is the seam.
 */
export type ToolGateFn = (
  ctx: DispatchContext,
  call: { tool: string; args: unknown }
) => void | Promise<void>

/** Options for {@link forgeMediaTools}. */
export interface ForgeMediaToolsOptions {
  /** Which tool surface to mint. */
  surface: 'composite' | 'granular'
  /** Media-id resolution. Default: scan turn attachments + tool-call Media results. */
  resolveMedia?: MediaResolverFn
  /** Optional pre-execution gate (see {@link ToolGateFn}). */
  gate?: ToolGateFn
  /** Per-tool name/description overrides, keyed by the minted tool's default name. */
  overrides?: Record<string, { name?: string; description?: string }>
}

/**
 * The default media resolver: scan `ctx.turnMessages[].attachments`, then
 * `ctx.turnToolCalls[].results`, for a Media with the given id.
 *
 * @param ctx - The dispatch context.
 * @param mediaId - The id to find.
 * @returns The Media, or `undefined` when nothing in the turn carries that id.
 */
export const defaultResolveMedia: MediaResolverFn = (ctx, mediaId) => {
  for (const message of ctx.turnMessages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.id === mediaId) return attachment
    }
  }
  for (const toolCall of ctx.turnToolCalls) {
    const results = toolCall.results
    if (Media.isMedia(results) && results.id === mediaId) return results
    if (Array.isArray(results)) {
      const hit = results.find((r) => Media.isMedia(r) && r.id === mediaId)
      if (hit) return hit as Media
    }
  }
  return undefined
}

/** Enumerate every Media visible in the turn (for `list_media` and MEDIA_NOT_FOUND hints). */
const enumerateMedia = (
  ctx: DispatchContext
): Array<{
  id: string
  filename: string
  kind: string
  mimeType: string
  source?: string
  origin: string
}> => {
  const out: Array<{
    id: string
    filename: string
    kind: string
    mimeType: string
    source?: string
    origin: string
  }> = []
  for (const message of ctx.turnMessages) {
    for (const attachment of message.attachments ?? []) {
      out.push({
        id: attachment.id,
        filename: attachment.filename,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        source: attachment.source,
        origin: 'attachment',
      })
    }
  }
  for (const toolCall of ctx.turnToolCalls) {
    const results = toolCall.results
    const mediaList = Media.isMedia(results)
      ? [results]
      : Array.isArray(results)
        ? results.filter((r): r is Media => Media.isMedia(r))
        : []
    for (const media of mediaList) {
      out.push({
        id: media.id,
        filename: media.filename,
        kind: media.kind,
        mimeType: media.mimeType,
        source: media.source,
        origin: 'tool-result',
      })
    }
  }
  return out
}

const failure = (code: string, message: string): string => `Error (${code}): ${message}`

// ── media generation (the empty:<format> sentinel) ───────────────────────────

/**
 * Extract the format token from an `empty:<format>` sentinel id, or undefined for normal ids.
 * Harness-minted ids are UUIDs, which can never start with `empty:` — the sentinel occupies
 * input space that was previously a guaranteed MEDIA_NOT_FOUND.
 */
const emptyFormatOf = (mediaId: string): string | undefined => {
  if (!mediaId.toLowerCase().startsWith('empty:')) return undefined
  return mediaId.slice('empty:'.length).trim().toLowerCase()
}

/** The format tokens creatable in this deployment (reachable from {@link EMPTY_MIME}). */
const creatableFormats = (registry: EngineRegistry): readonly string[] =>
  registry.convertTargets(EMPTY_MIME)

/** Materialize a new blank media payload for the sentinel, or a model-actionable failure. */
const materializeEmpty = async (
  registry: EngineRegistry,
  format: string,
  signal?: AbortSignal
): Promise<{ ok: true; payload: StepPayload } | { ok: false; failure: string }> => {
  const creatable = creatableFormats(registry)
  if (!creatable.includes(format)) {
    return {
      ok: false,
      failure: failure(
        'EMPTY_FORMAT_UNAVAILABLE',
        `cannot create "${format}" media in this deployment. Creatable formats: ${creatable.join(', ') || '(none)'}. Do not retry this format here.`
      ),
    }
  }
  const result = await registry.convert({
    bytes: new Uint8Array(0),
    mimeType: EMPTY_MIME,
    filename: 'untitled',
    to: format,
    signal,
  })
  const output = result.outputs[0]
  if (!output) {
    return {
      ok: false,
      failure: failure('EMPTY_GENERATION_FAILED', `generating "${format}" produced no output`),
    }
  }
  return {
    ok: true,
    payload: {
      bytes: output.bytes,
      mimeType: output.mimeType,
      filename: `untitled.${format}`,
    },
  }
}

const mediaKindOf = (mimeType: string): 'image' | 'audio' | 'video' | 'document' => {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

/** Load a resolved Media's bytes into a pipeline payload. */
const toPayload = async (media: Media): Promise<StepPayload> => ({
  bytes: await media.asBytes(),
  mimeType: media.mimeType,
  filename: media.filename,
})

/** Persist a payload through the dispatch byte conduit and mint a first-party Media. */
const toMedia = async (
  ctx: DispatchContext,
  payload: StepPayload,
  toolName: string
): Promise<Media> => {
  const id = crypto.randomUUID()
  const reader = await ctx.storeMediaBytes(id, payload.bytes)
  return Media.toolGenerated({
    id,
    kind: mediaKindOf(payload.mimeType),
    mimeType: payload.mimeType,
    filename: payload.filename,
    reader,
    source: `tool:${toolName}`,
  })
}

/** Render a plan result as a tool handler return value. */
const renderResult = async (
  ctx: DispatchContext,
  result: PlanResult,
  toolName: string
): Promise<string | Media | Media[]> => {
  if (result.kind === 'media') return toMedia(ctx, result.payload, toolName)
  if (result.kind === 'media-list') {
    return Promise.all(result.payloads.map((p) => toMedia(ctx, p, toolName)))
  }
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
}

/** Resolve + acquire the input media or produce a model-actionable failure string. */
const acquire = async (
  ctx: DispatchContext,
  registry: EngineRegistry,
  resolveMedia: MediaResolverFn,
  mediaId: string
): Promise<{ ok: true; payload: StepPayload } | { ok: false; failure: string }> => {
  // The empty:<format> sentinel creates NEW media instead of resolving existing bytes.
  const format = emptyFormatOf(mediaId)
  if (format !== undefined) return materializeEmpty(registry, format, ctx.abortSignal)
  const media = await resolveMedia(ctx, mediaId)
  if (!media) {
    const visible = enumerateMedia(ctx)
    const creatable = creatableFormats(registry)
    const createHint =
      creatable.length > 0
        ? ` To create NEW media instead, pass media_id "empty:<format>" (available: ${creatable.join(', ')}).`
        : ''
    const hint =
      visible.length > 0
        ? `Visible media ids: ${visible.map((m) => `${m.id} (${m.filename})`).join(', ')}`
        : 'No media is visible in this turn — ask the user to attach a file, or call list_media to check.'
    return {
      ok: false,
      failure: failure('MEDIA_NOT_FOUND', `no media with id "${mediaId}". ${hint}${createHint}`),
    }
  }
  return { ok: true, payload: await toPayload(media) }
}

/** Build a per-run @id ref resolver bound to this dispatch's visible media. */
const refResolverFor =
  (ctx: DispatchContext, registry: EngineRegistry, resolveMedia: MediaResolverFn) =>
  async (id: string): Promise<StepPayload> => {
    // @empty:<format> refs mint a blank file inline (merge with=@empty:xlsx, …).
    const format = emptyFormatOf(id)
    if (format !== undefined) {
      const made = await materializeEmpty(registry, format, ctx.abortSignal)
      if (!made.ok) throw new Error(made.failure)
      return made.payload
    }
    const media = await resolveMedia(ctx, id)
    if (!media) {
      const visible = enumerateMedia(ctx)
        .map((m) => m.id)
        .join(', ')
      throw new Error(
        `referenced media @${id} was not found in this turn. Visible ids: ${visible || '(none)'}`
      )
    }
    return toPayload(media)
  }

/** Run the optional gate; a throw becomes the tool's error (standard downstream wrapping). */
const runGate = async (
  gate: ToolGateFn | undefined,
  ctx: DispatchContext,
  tool: string,
  args: unknown
): Promise<void> => {
  if (gate) await gate(ctx, { tool, args })
}

/** Map a thrown pipeline error to a readable failure string the model can act on. */
const renderError = (err: unknown): string => {
  if (isError(err) && err.name.startsWith('E_MEDIA_')) {
    return failure(err.name.replace(/^E_MEDIA_/, ''), err.message)
  }
  throw err
}

// ── grammar text generation (composite surface) ──────────────────────────────

const argHelp = (name: string, arg: VerbArgSpec): string => {
  const req = arg.required ? '' : '?'
  const type =
    arg.type === 'enum' ? (arg.values ?? []).join('|') : arg.type === 'json' ? "'<JSON>'" : arg.type
  return `${name}${req}=${type}`
}

const verbHelp = (spec: VerbSpec): string => {
  const verb = spec.id.replace(/\./g, ' ')
  const args = Object.entries(spec.args)
    .map(([n, a]) => argHelp(n, a))
    .join(' ')
  return args.length > 0 ? `${verb} ${args}` : verb
}

/**
 * Generate the model-facing grammar text for the configured deployment: only available verbs,
 * with arg signatures, plus few-shot examples rendered from real plans via `toPipe` so they
 * can never drift from the parser.
 */
const grammarText = (pipeline: MediaPipeline): string => {
  const available = new Set(availableVerbs(pipeline.capabilities))
  const lines: string[] = []
  for (const spec of VERB_INDEX.values()) {
    if (!available.has(spec.id.replace(/[._]+/g, ' '))) continue
    lines.push(`- ${verbHelp(spec)} — ${spec.description}`)
  }
  const examples: string[] = [
    toPipe({
      steps: [
        { verb: 'select', args: { pages: [2, 3, 4, 5] } },
        { verb: 'extract.text', args: {} },
      ],
    }),
    toPipe({
      steps: [
        { verb: 'extract.text', args: {} },
        { verb: 'chunk', args: { by: 'sentence', size: 512 } },
      ],
    }),
  ]
  if (available.has('redact')) {
    examples.push(
      toPipe({
        steps: [
          {
            verb: 'redact',
            args: { match: [{ source: '\\d{3}-\\d{2}-\\d{4}', flags: '' }], replace: '[SSN]' },
          },
        ],
      })
    )
  }
  const creatable = creatableFormats(pipeline.capabilities)
  const creating: string[] =
    creatable.length > 0
      ? [
          '',
          'Creating new media:',
          `Pass media_id "empty:<format>" to create a NEW blank file instead of processing an existing one (available: ${creatable.join(', ')}).`,
          `Example: media_id "empty:xlsx" with q "${toPipe({
            steps: [
              {
                verb: 'sheet.update_cells',
                args: { updates: [{ address: 'A1', value: 'Title' }] },
              },
            ],
          })}"`,
          'Blank images are 1024×1024 white — resize in the same statement (empty:png + "image resize width=64").',
          'The same sentinel works as a ref: merge with=@empty:xlsx.',
        ]
      : []
  return [
    'Statements are pipe expressions: verb name=value ... | verb name=value ...',
    'Named args only. Indices are 1-based. Quote values containing spaces or dashes.',
    'Structured payloads are quoted JSON: updates=\'[{"address":"B2","value":3}]\'.',
    'Reference other media inline by id: merge with=@<media id> (ids come from list_media).',
    '',
    'Available verbs:',
    ...lines,
    ...creating,
    '',
    'Examples (remember: inside JSON tool args, backslashes must be doubled — \\\\d):',
    ...examples.map((e) => `  ${e}`),
  ].join('\n')
}

// ── the tools ────────────────────────────────────────────────────────────────

const buildListMediaTool = (overrides: ForgeMediaToolsOptions['overrides']): Tool => {
  const name = overrides?.list_media?.name ?? 'list_media'
  return new Tool({
    name,
    description:
      overrides?.list_media?.description ??
      'Lists every media file visible in this conversation turn (user attachments and files produced by prior tool calls), with the media ids other media tools require.',
    inputSchema: validator.object({}),
    artifactConstructor: () => SpooledJsonArtifact,
    handler: async (_args, ctx) => {
      const media = enumerateMedia(ctx as DispatchContext)
      return JSON.stringify(media, null, 2)
    },
  })
}

const buildCompositeTool = (
  pipeline: MediaPipeline,
  resolveMedia: MediaResolverFn,
  gate: ToolGateFn | undefined,
  overrides: ForgeMediaToolsOptions['overrides']
): Tool => {
  const name = overrides?.media_query?.name ?? 'media_query'
  const description =
    overrides?.media_query?.description ??
    `Runs a media-processing statement against a file from this conversation, locally (no external services). Provide media_id (from list_media) and either q (a pipe statement) or ops (structured steps).

${grammarText(pipeline)}`
  const creatable = creatableFormats(pipeline.capabilities)
  const mediaIdDescription =
    creatable.length > 0
      ? `The id of the media to process (call list_media to discover ids), or "empty:<format>" to create a new blank file (available: ${creatable.join(', ')}).`
      : 'The id of the media to process (call list_media to discover ids).'
  return new Tool({
    name,
    description,
    inputSchema: validator.object({
      media_id: validator.string().required().description(mediaIdDescription),
      q: validator
        .string()
        .description('A pipe statement, e.g. "select pages=2-5 | extract text".'),
      ops: validator
        .array()
        .items(
          validator.object({
            verb: validator.string().required(),
            args: validator.object().unknown(true).required(),
          })
        )
        .description('Structured alternative to q: [{ verb, args }] steps.'),
    }),
    handler: async (args, ctx) => {
      const {
        media_id: mediaId,
        q,
        ops,
      } = args as { media_id: string; q?: string; ops?: MediaOp[] }
      if ((q === undefined) === (ops === undefined)) {
        return failure(
          'BAD_REQUEST',
          'provide exactly one of q (pipe statement) or ops (structured steps)'
        )
      }
      const dispatch = ctx as DispatchContext
      await runGate(gate, dispatch, name, args)
      const acquired = await acquire(dispatch, pipeline.capabilities, resolveMedia, mediaId)
      if (!acquired.ok) return acquired.failure
      try {
        const runOptions = {
          signal: dispatch.abortSignal,
          resolveRef: refResolverFor(dispatch, pipeline.capabilities, resolveMedia),
        }
        const result =
          q !== undefined
            ? await pipeline.query(acquired.payload, q, runOptions)
            : await pipeline.ops(acquired.payload, ops as MediaOp[], runOptions)
        return await renderResult(dispatch, result, name)
      } catch (err) {
        return renderError(err)
      }
    },
  })
}

/** Convert a granular tool's flat args into the verb's op args (drops media_id). */
const opArgsFrom = (args: Record<string, unknown>): Record<string, MediaArgValue> => {
  const out: Record<string, MediaArgValue> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k === 'media_id' || v === undefined) continue
    out[k] = v as MediaArgValue
  }
  return out
}

const granularSchemaFor = (
  spec: VerbSpec,
  creatable: readonly string[]
): ReturnType<typeof validator.object> => {
  const mediaIdDescription =
    creatable.length > 0
      ? `The id of the media to process (call list_media to discover ids), or "empty:<format>" to create a new blank file (available: ${creatable.join(', ')}).`
      : 'The id of the media to process (call list_media to discover ids).'
  const shape: Record<string, ReturnType<typeof validator.any>> = {
    media_id: validator.string().required().description(mediaIdDescription),
  }
  for (const [argName, arg] of Object.entries(spec.args)) {
    let schema
    switch (arg.type) {
      case 'number':
        schema = validator.number()
        if (arg.min !== undefined) schema = schema.min(arg.min)
        if (arg.max !== undefined) schema = schema.max(arg.max)
        break
      case 'boolean':
        schema = validator.boolean()
        break
      case 'enum':
        schema = validator.string().valid(...(arg.values ?? []))
        break
      case 'number-list':
        schema = validator.array().items(validator.number().min(arg.min ?? 1))
        break
      case 'string-list':
        schema = arg.values
          ? validator.array().items(validator.string().valid(...arg.values))
          : validator.array().items(validator.string())
        break
      case 'media-ref':
        schema = validator
          .string()
          .description('A media id (from list_media) for the other media in this operation.')
        break
      case 'media-ref-list':
        schema = validator.array().items(validator.string())
        break
      case 'name-or-index':
        schema = validator
          .alternatives()
          .try(validator.number().integer().min(1), validator.string())
        break
      case 'regex-or-string-list':
        schema = validator
          .alternatives()
          .try(validator.string(), validator.array().items(validator.string()))
        break
      case 'json':
        schema = validator.any().optional()
        break
      default:
        schema = validator.string().allow('')
    }
    schema = schema.description(arg.description)
    if (arg.required) schema = schema.required()
    shape[argName] = schema
  }
  return validator.object(shape)
}

/** Normalize a granular tool's media-ref string args to MediaRef IR values. */
const normalizeRefArgs = (spec: VerbSpec, args: Record<string, MediaArgValue>): void => {
  for (const [argName, arg] of Object.entries(spec.args)) {
    const value = args[argName]
    if (value === undefined) continue
    if (arg.type === 'media-ref' && typeof value === 'string') {
      args[argName] = { kind: 'id', id: value }
    }
    if (arg.type === 'media-ref-list' && Array.isArray(value)) {
      args[argName] = (value as unknown[]).map((v) =>
        typeof v === 'string' ? { kind: 'id', id: v } : (v as MediaArgValue)
      ) as MediaArgValue
    }
  }
}

const buildGranularTool = (
  pipeline: MediaPipeline,
  spec: VerbSpec,
  resolveMedia: MediaResolverFn,
  gate: ToolGateFn | undefined,
  overrides: ForgeMediaToolsOptions['overrides']
): Tool => {
  const defaultName = spec.id.replace(/\./g, '_')
  const name = overrides?.[defaultName]?.name ?? defaultName
  return new Tool({
    name,
    description:
      overrides?.[defaultName]?.description ??
      `${spec.description} Processes a media file from this conversation locally. Indices are 1-based.`,
    inputSchema: granularSchemaFor(spec, creatableFormats(pipeline.capabilities)),
    handler: async (args, ctx) => {
      const dispatch = ctx as DispatchContext
      const { media_id: mediaId } = args as { media_id: string }
      await runGate(gate, dispatch, name, args)
      const acquired = await acquire(dispatch, pipeline.capabilities, resolveMedia, mediaId)
      if (!acquired.ok) return acquired.failure
      const opArgs = opArgsFrom(args as Record<string, unknown>)
      normalizeRefArgs(spec, opArgs)
      try {
        const result = await pipeline.ops(acquired.payload, [{ verb: spec.id, args: opArgs }], {
          signal: dispatch.abortSignal,
          resolveRef: refResolverFor(dispatch, pipeline.capabilities, resolveMedia),
        })
        return await renderResult(dispatch, result, name)
      } catch (err) {
        return renderError(err)
      }
    },
  })
}

/**
 * Forge agent tools over a configured media pipeline.
 *
 * @remarks
 * The minted set follows the pipeline's configured engines: in the composite surface the
 * `media_query` grammar text only advertises available verbs; in the granular surface a tool
 * is minted only for verbs whose engine (if any) is configured. Either way `list_media` is
 * included — it is the model's entry point for discovering `media_id` values.
 *
 * The returned record is keyed by tool name so consumers can register selectively or pass
 * `Object.values(tools)` to `TurnRunnerConfig.tools`.
 *
 * @param pipeline - A pipeline from `createMediaPipeline`.
 * @param options - Surface, resolver, gate, and overrides.
 * @returns The minted tools, keyed by name.
 */
export const forgeMediaTools = (
  pipeline: MediaPipeline,
  options: ForgeMediaToolsOptions
): Record<string, Tool> => {
  if (options?.surface !== 'composite' && options?.surface !== 'granular') {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      `forgeMediaTools requires surface: 'composite' | 'granular'`,
    ])
  }
  const resolveMedia = options.resolveMedia ?? defaultResolveMedia
  const tools: Record<string, Tool> = {}
  const listTool = buildListMediaTool(options.overrides)
  tools[listTool.name] = listTool

  if (options.surface === 'composite') {
    const composite = buildCompositeTool(pipeline, resolveMedia, options.gate, options.overrides)
    tools[composite.name] = composite
    return tools
  }

  const available = new Set(availableVerbs(pipeline.capabilities))
  for (const spec of VERB_INDEX.values()) {
    if (!available.has(spec.id.replace(/[._]+/g, ' '))) continue
    const tool = buildGranularTool(pipeline, spec, resolveMedia, options.gate, options.overrides)
    tools[tool.name] = tool
  }
  return tools
}

/** Re-exported so consumers can fold verbs the same way the forge does. */
export { foldVerb }
