/**
 * Framework-agnostic typed output for skill tools.
 *
 * A skill tool is third-party code that should not have to import this library to describe what it
 * produced. Core's tool contract accepts `string | Uint8Array | Media | Media[]`, but constructing
 * a `Media` — let alone a `Retrievable` — means importing `@nhtio/adk/common`, which a tool written
 * against any other framework will not do. The wrapper is already the adaptation boundary for the
 * gate, errors and trust; this makes it the adaptation boundary for OUTPUT too.
 *
 * A tool may therefore return a plain-object DESCRIPTOR and the host builds the primitive:
 *
 * - `{ bytes, mimeType, filename? }` → a {@link Media}. The tool says what it produced (a PDF, a
 *   WAV); the host wraps the bytes in a reader via `ctx.storeMediaBytes`, infers `kind` and the
 *   conservative `modalityHazard` from the MIME type, and FLOORS the trust tier from the skill's own
 *   tier — a skill can never label its output first-party.
 * - `{ retrievable: { content, … } }` → a {@link Retrievable} the model can cite, search and hold a
 *   handle to. Its plain-string content is handed to `ctx.storeRetrievable`, which collision-checks,
 *   spools the text behind a handle, and PERSISTS the record DURABLY. It is durable work product —
 *   not the reclaimable instruction set a skill BODY is, nor the transient-within-dispatch stdout a
 *   SCRIPT produces — so it outlives the turn and an `unload_skill`.
 *
 * A prebuilt `SpooledArtifact` is still refused (it would bypass the deployer's artifact binding),
 * and anything not matching an accepted shape is still `E_SKILL_TOOL_BAD_RESPONSE`.
 */
import { v6 as uuidv6 } from 'uuid'
import { E_SKILL_TOOL_BAD_RESPONSE } from './exceptions'
import { isObject, isInstanceOf } from '@nhtio/adk/guards'
import { Media, Retrievable, SpooledArtifact } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { RetrievableTrustTier } from '@nhtio/adk/common'
import type { MediaKind, MediaModalityHazard, MediaTrustTier } from '@nhtio/adk/common'

/** The skill trust tiers the battery threads through, shared by scripts and typed output. */
export type SkillTrustTier = 'first-party' | 'third-party-public' | 'third-party-private'

/**
 * Restriction rank of a trust tier: higher is MORE restricted. Mirrors the envelope renderer's own
 * ordering (`first-party` 0 < `third-party-public` 1 < `third-party-private` 2). Used to reject a
 * prebuilt primitive whose tier is MORE PRIVILEGED (lower rank) than the skill's floored output
 * tier — a skill must never elevate its output, but a stricter tier than the floor is fine.
 */
const tierRank: Record<MediaTrustTier & RetrievableTrustTier, number> = {
  'first-party': 0,
  'third-party-public': 1,
  'third-party-private': 2,
}

/**
 * The output kind a descriptor may DECLARE for a tool. When present, a runtime shape that disagrees
 * is a detectable failure rather than a silent reinterpretation; when absent, the wrapper sniffs.
 */
export type SkillOutputKind = 'text' | 'binary' | 'media' | 'retrievable'

/** Bytes-with-a-content-type: the framework-agnostic path to typed binary. */
export interface SkillBinaryOutput {
  /** The raw bytes. The host wraps them in a reader via `ctx.storeMediaBytes`. */
  readonly bytes: Uint8Array
  /** MIME type of the bytes; the `MediaKind` and modality hazard are inferred from it. */
  readonly mimeType: string
  /** Optional filename; a stable default derived from the tool name is used when omitted. */
  readonly filename?: string
}

/** A framework-agnostic retrievable descriptor. `content` is plain text; the host spools it. */
export interface SkillRetrievableOutput {
  /** The retrievable to construct. Its text is spooled behind a handle and its tier is floored. */
  readonly retrievable: {
    /** Plain text the model can cite, search, and hold a handle to. */
    readonly content: string
    /** Optional provenance string (URL, document path, knowledge-base id). */
    readonly source?: string
    /** Optional semantic label (e.g. `'reference'`, `'policy'`); defaults to `'skill-tool'`. */
    readonly kind?: string
    /** Optional relevance score in `[0, 1]`. */
    readonly score?: number
    /** Render inline rather than as a handle; defaults to `false`. */
    readonly inline?: boolean
  }
}

/**
 * Floor a skill's trust tier onto its output, shared with tier-3 scripts: `first-party` becomes
 * `third-party-private`; both third-party tiers pass through. Program output from a first-party
 * skill is still program output, never deployer-authored prose, so it never gets the first-party
 * envelope.
 */
export const floorOutputTier = (
  tier: SkillTrustTier | undefined
): MediaTrustTier & RetrievableTrustTier =>
  tier === 'first-party' ? 'third-party-private' : (tier ?? 'third-party-public')

const mediaKindOf = (mimeType: string): MediaKind => {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

/** Documents can carry hidden instructions; other modalities are opaque-perceptual. */
const hazardForKind = (kind: MediaKind): MediaModalityHazard =>
  kind === 'document' ? 'extractable-instructions' : 'opaque-perceptual'

const isBinaryOutput = (value: unknown): value is SkillBinaryOutput =>
  isObject(value) &&
  isInstanceOf((value as { bytes?: unknown }).bytes, 'Uint8Array', Uint8Array) &&
  typeof (value as { mimeType?: unknown }).mimeType === 'string'

const isRetrievableOutput = (value: unknown): value is SkillRetrievableOutput =>
  isObject(value) &&
  isObject((value as { retrievable?: unknown }).retrievable) &&
  typeof (value as { retrievable: { content?: unknown } }).retrievable.content === 'string'

/**
 * Build a {@link Media} from a framework-agnostic bytes descriptor. The reader is created via
 * `ctx.storeMediaBytes`, so the tool never supplies a `MediaReader` and never imports ADK.
 */
const buildMedia = async (
  out: SkillBinaryOutput,
  ctx: DispatchContext,
  tier: SkillTrustTier | undefined,
  toolName: string
): Promise<Media> => {
  // Validate the descriptor BEFORE storing bytes: `new Media` would otherwise reject an invalid
  // filename only after `storeMediaBytes` has written the bytes, orphaning them in the store.
  if (!out.mimeType)
    throw new E_SKILL_TOOL_BAD_RESPONSE([`${toolName}: binary output missing mimeType`])
  if (out.filename !== undefined && typeof out.filename !== 'string')
    throw new E_SKILL_TOOL_BAD_RESPONSE([`${toolName}: binary output has a non-string filename`])
  const kind = mediaKindOf(out.mimeType)
  const id = uuidv6()
  const reader = await ctx.storeMediaBytes(id, out.bytes)
  return new Media({
    id,
    kind,
    mimeType: out.mimeType,
    filename: out.filename ?? `${toolName}-${id}`,
    reader,
    trustTier: floorOutputTier(tier),
    modalityHazard: hazardForKind(kind),
    source: toolName,
  })
}

/**
 * Build a {@link Retrievable} from a framework-agnostic descriptor and PERSIST it through
 * `ctx.storeRetrievable`, following the canonical `retrievables` tool-battery pattern EXACTLY: hand
 * `storeRetrievable` a plain-STRING `content` and let core do the work. A skill tool's explicit
 * `{ retrievable }` is a declared knowledge record — durable work product, not the reclaimable
 * instruction set a skill BODY is, and not the transient-within-dispatch stdout a SCRIPT produces.
 *
 * Passing string content is what makes this atomic-in-order: `storeRetrievable` (core's
 * `#doStoreRetrievable`) runs its id-collision check FIRST, then `autoSpoolRetrievable` writes the
 * bytes through the consumer's own `storeRetrievableBytes` conduit, then registers the record and
 * fires the consumer's `storeRetrievable` callback. Nothing is written before the check, so a
 * collision throw stores nothing; and because the byte write is core's own (not a separate pre-write
 * of ours), there is no window where spooled bytes exist without a registered record on the paths
 * this battery controls.
 *
 * Byte cleanup after a rejecting persistence callback is DELIBERATELY OUT OF SCOPE for this library
 * — it is the consumer's to handle, and it must be, not merely a gap we tolerate. When the consumer's
 * `storeRetrievable` callback rejects, core has already spooled the bytes via the consumer's OWN
 * `storeRetrievableBytes` conduit under a known id; the consumer therefore holds both the id and the
 * store and is the only party that can reconcile a spooled id whose record write failed. The library
 * exposes no byte-delete conduit (`deleteRetrievable` removes the record, not the bytes) precisely
 * because adding one would push a failure the consumer already owns back across the boundary. Core
 * does not roll back for ANY `storeRetrievable` caller, and the canonical `retrievables` tool battery
 * makes the same choice; this battery is consistent with both. A consumer whose byte store must not
 * accumulate orphans on persistence failure cleans up in its own `storeRetrievable` callback.
 *
 * The tier is floored (a skill can never elevate its output) and the id is an unguessable UUID so
 * injected content cannot forge the closing tag. Returns the acknowledgement for the model.
 */
const addRetrievable = async (
  out: SkillRetrievableOutput,
  ctx: DispatchContext,
  tier: SkillTrustTier | undefined,
  toolName: string
): Promise<string> => {
  const { content, source, kind, score, inline } = out.retrievable
  // Validate optional fields up front so an out-of-range score or a non-boolean inline fails as a
  // clean bad-response rather than surfacing from the primitive constructor deeper in the stack.
  if (
    (source !== undefined && typeof source !== 'string') ||
    (kind !== undefined && typeof kind !== 'string') ||
    (score !== undefined &&
      (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) ||
    (inline !== undefined && typeof inline !== 'boolean')
  )
    throw new E_SKILL_TOOL_BAD_RESPONSE([`${toolName}: invalid retrievable output`])
  const id = uuidv6()
  const byteLength = new TextEncoder().encode(content).byteLength
  // Plain-string content: core collision-checks, THEN spools, THEN persists — no pre-write to orphan.
  // If the consumer's storeRetrievable callback rejects after core spools, cleaning up the bytes is
  // the consumer's responsibility (see the doc comment) — the rejection propagates unchanged.
  await ctx.storeRetrievable(
    new Retrievable({
      id,
      content,
      trustTier: floorOutputTier(tier),
      source: source ?? toolName,
      kind: kind ?? 'skill-tool',
      ...(score !== undefined ? { score } : {}),
      inline: inline ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  )
  return `Retrievable ${id} added (${byteLength} bytes)`
}

/**
 * Validate a raw skill-tool return and resolve it to a core-legal tool result, constructing typed
 * primitives from framework-agnostic descriptors host-side. `declared`, when the descriptor set it,
 * is enforced: a runtime shape that disagrees fails rather than being silently reinterpreted.
 */
export const resolveSkillToolOutput = async (o: {
  raw: unknown
  ctx: DispatchContext
  toolName: string
  trustTier: SkillTrustTier | undefined
  declared?: SkillOutputKind
}): Promise<string | Uint8Array | Media | Media[]> => {
  const { raw, ctx, toolName, trustTier, declared } = o

  // A prebuilt artifact is refused first and unconditionally: it would bypass the deployer's binding.
  if (isInstanceOf(raw, 'SpooledArtifact', SpooledArtifact))
    throw new E_SKILL_TOOL_BAD_RESPONSE([`${toolName} returned a SpooledArtifact`])

  // Sniff by what the return PRODUCES: a raw Uint8Array is anonymous `'binary'`; a
  // `{bytes, mimeType}` descriptor and a `Media`/`Media[]` all produce typed `'media'`; a
  // retrievable descriptor is `'retrievable'`; a string is `'text'`.
  const sniffed: SkillOutputKind | undefined =
    typeof raw === 'string'
      ? 'text'
      : isInstanceOf(raw, 'Uint8Array', Uint8Array)
        ? 'binary'
        : isInstanceOf(raw, 'Media', Media) ||
            // An empty array is a valid `Media[]` result — a tool reporting no media. `every` is
            // vacuously true for `[]`, so no length guard: it stays 'media', not undefined/rejected.
            (Array.isArray(raw) && raw.every((i) => isInstanceOf(i, 'Media', Media))) ||
            isBinaryOutput(raw)
          ? 'media'
          : isRetrievableOutput(raw)
            ? 'retrievable'
            : undefined

  if (sniffed === undefined) throw new E_SKILL_TOOL_BAD_RESPONSE([toolName])
  // A declared kind that disagrees with the produced shape is a detectable bug.
  if (declared !== undefined && declared !== sniffed)
    throw new E_SKILL_TOOL_BAD_RESPONSE([
      `${toolName}: declared ${declared} output but returned ${sniffed}`,
    ])

  if (typeof raw === 'string') return raw
  if (isInstanceOf(raw, 'Uint8Array', Uint8Array)) return raw as Uint8Array
  // A prebuilt Media must not carry a tier MORE PRIVILEGED than the skill's floored output tier:
  // otherwise a skill constructing `Media.firstParty(...)` would render third-party content under a
  // first-party envelope. Equal or stricter (higher rank) is fine — flooring only ever restricts.
  const floor = floorOutputTier(trustTier)
  if (isInstanceOf(raw, 'Media', Media)) {
    if (tierRank[(raw as Media).trustTier] < tierRank[floor])
      throw new E_SKILL_TOOL_BAD_RESPONSE([
        `${toolName}: Media trust tier exceeds skill output tier`,
      ])
    return raw as Media
  }
  if (Array.isArray(raw)) {
    if ((raw as Media[]).some((item) => tierRank[item.trustTier] < tierRank[floor]))
      throw new E_SKILL_TOOL_BAD_RESPONSE([
        `${toolName}: a Media in the array exceeds skill output tier`,
      ])
    return raw as Media[]
  }
  if (isBinaryOutput(raw)) return buildMedia(raw, ctx, trustTier, toolName)
  return addRetrievable(raw as SkillRetrievableOutput, ctx, trustTier, toolName)
}
