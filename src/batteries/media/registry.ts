/**
 * The engine registry: capability-filtered, middleware-arbitrated, ordered dispatch over the
 * pipeline's engine array.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry (re-exported through the barrel).
 * One selection rule everywhere: gather every engine whose declarations match the request
 * (capability filter), run the consumer's selection onion (stages may exclude or reorder
 * candidates, never add), then the first survivor in supply order wins.
 *
 * Convert dispatch additionally computes multi-hop paths: when no single engine declares a
 * direct edge for the requested (input, target) pair, a breadth-first search over the format
 * graph finds the shortest chain of hops (capped at {@link MAX_HOPS}), with supply order
 * breaking ties at equal length. Pathfinding explores capability declarations only — cheap
 * and synchronous; the selection onion runs once per executed hop with real bytes in hand.
 */

import { EXT_TO_MIME } from './formats'
import { Middleware } from '@nhtio/middleware'
import type { NextFn } from '@nhtio/middleware'
import type { CapabilityProbe } from './validate'
import type {
  MediaEngine,
  ConvertRequest,
  ConvertResult,
  ConvertCapability,
  MutateRequest,
  MutateCapability,
  EditRequest,
  EditResult,
  EditCapability,
  EngineBytesResult,
} from './contracts'

/** The maximum number of conversion hops a computed path may take. */
const MAX_HOPS = 3

/**
 * The no-lossy-intermediates ROUTING rule — and nothing else. These format tokens are valid
 * conversion endpoints but never intermediate path nodes: without this rule the pathfinder
 * would happily route `docx → txt → …` (lossy garbage in, garbage out) or auto-chain
 * `audio → pcm → txt` (skipping the resample the transcription step performs between those
 * legs).
 *
 * This set does NOT gate mutation, creation, or advertising. A lossy format as the *desired
 * output* is still valid media: `txt` can be created (`empty:txt`), appended to, patched,
 * diffed, and targeted by `convert to=txt` — terminality only forbids silently routing
 * *through* it on the way to somewhere else.
 */
const TERMINAL_TOKENS: ReadonlySet<string> = new Set([
  'txt',
  'json',
  'hocr',
  'srt',
  'vtt',
  'md',
  'csv',
  'pcm',
  'images',
])

/** Normalize a MIME type for comparison (lowercase, parameters stripped). */
const normalizeMime = (mimeType: string): string => mimeType.toLowerCase().split(';')[0].trim()

/** `true` when `mime` matches `pattern` (exact, or a `family/*` wildcard). */
const matchesMime = (pattern: string, mime: string): boolean => {
  const p = pattern.toLowerCase()
  if (p.endsWith('/*')) return mime.startsWith(p.slice(0, -1))
  return p === mime
}

/** `true` when any pattern in `patterns` matches `mime`. */
const matchesAny = (patterns: readonly string[], mime: string): boolean =>
  patterns.some((p) => matchesMime(p, mime))

/**
 * The request summary a selection stage sees: enough to implement content- and
 * format-dependent rules without exposing dispatch internals.
 */
export interface EngineSelectionContext {
  /** Which capability is being dispatched. */
  kind: 'convert' | 'mutate' | 'edit'
  /** The dispatch request (for convert under multi-hop, the CURRENT hop's input/target). */
  request: {
    /** The input MIME type. */
    mimeType: string
    /** The input filename. */
    filename: string
    /** The input bytes — content-dependent rules (e.g. workbook complexity) need them. */
    bytes: Uint8Array
    /** The convert target token, or the mutate `format.to` when a re-encode was requested. */
    to?: string
    /** The requested mutate operations. */
    ops?: readonly string[]
  }
  /**
   * The capable engines, in supply order. Stages may exclude or reorder (mutate in place or
   * reassign); survivors are re-filtered against the original capable set, so a stage can
   * never add an engine the capability filter rejected.
   */
  candidates: MediaEngine[]
}

/**
 * A selection-middleware stage — the seam for quality heuristics and implementor overrides
 * when several engines can perform the same transform (e.g. route complex workbooks past a
 * pure-JS converter to LibreOffice). Same onion shape as the battery's `use` interceptors;
 * a fresh runner is minted per dispatch. Keep stages cheap or memoized: they run with bytes
 * in hand on every dispatch.
 */
export type EngineSelectionMiddlewareFn = (
  ctx: EngineSelectionContext,
  next: NextFn
) => void | Promise<void>

/** Ordered capability-filtered dispatch over the pipeline's engines. */
export interface EngineRegistry extends CapabilityProbe {
  /** The resolved engines, in supply order (inspection/debugging). */
  readonly engines: readonly MediaEngine[]
  /**
   * Every format token reachable from `fromMime` — directly or through a computed path of up
   * to three hops. Drives "supported targets" error messages.
   *
   * @param fromMime - The input MIME type.
   */
  convertTargets(fromMime: string): readonly string[]
  /**
   * Convert via the shortest capable path (direct edge = one hop). The selection rule picks
   * the engine for each executed hop; options are forwarded to every hop (engines ignore
   * keys they don't understand).
   *
   * @param request - The input bytes, target token, and options.
   * @returns The final hop's outputs.
   */
  convert(request: ConvertRequest): Promise<ConvertResult>
  /**
   * Apply a fused same-format transform. Candidates are engines whose `over` matches the
   * input, whose `ops` cover the requested operations, and — when a re-encode is requested —
   * whose `encodes` include the target.
   *
   * @param request - The fused operations and input bytes.
   * @returns The transformed bytes.
   */
  mutate(request: MutateRequest): Promise<EngineBytesResult>
  /**
   * Apply one structural document operation. Candidates are engines whose `over` matches the
   * input and whose `ops` include the requested op; the selection rule arbitrates between
   * engines of differing fidelity (supply order wins by default).
   *
   * @param request - The op, its args, and the input bytes.
   * @returns The restructured bytes plus optional change counts.
   */
  edit(request: EditRequest): Promise<EditResult>
}

/** One engine's matching capability group for a dispatch. */
interface ConvertCandidate {
  engine: MediaEngine
  capability: ConvertCapability
}
interface MutateCandidate {
  engine: MediaEngine
  capability: MutateCapability
}
interface EditCandidate {
  engine: MediaEngine
  capability: EditCapability
}

/** One hop of a computed conversion path. */
interface ConvertHop {
  /** The hop's input MIME. */
  fromMime: string
  /** The format token this hop produces. */
  to: string
}

/** The mutate operations requested by a fused request. */
const requestedOps = (request: MutateRequest): string[] => {
  const ops: string[] = []
  if (request.resize) ops.push('resize')
  if (request.rotate !== undefined) ops.push('rotate')
  if (request.flip) ops.push('flip')
  if (request.stripMetadata) ops.push('strip_metadata')
  return ops
}

/**
 * Build the registry over a resolved, validated engine array.
 *
 * @param engines - The engines, in supply (priority) order.
 * @param selection - Optional selection-middleware stages arbitrating multi-candidate dispatches.
 * @returns The registry.
 */
export const buildEngineRegistry = (
  engines: readonly MediaEngine[],
  selection: readonly EngineSelectionMiddlewareFn[] = []
): EngineRegistry => {
  // ── capability filters (declaration-only, sync) ───────────────────────────
  const convertCandidates = (fromMime: string, to: string): ConvertCandidate[] => {
    const mime = normalizeMime(fromMime)
    const out: ConvertCandidate[] = []
    for (const engine of engines) {
      for (const capability of engine.converts ?? []) {
        if (capability.to.includes(to) && matchesAny(capability.from, mime)) {
          out.push({ engine, capability })
          break // one entry per engine; its first matching group serves the edge
        }
      }
    }
    return out
  }

  const mutateCandidates = (request: MutateRequest): MutateCandidate[] => {
    const mime = normalizeMime(request.mimeType)
    const ops = requestedOps(request)
    const out: MutateCandidate[] = []
    for (const engine of engines) {
      for (const capability of engine.mutates ?? []) {
        if (!matchesAny(capability.over, mime)) continue
        if (!ops.every((op) => capability.ops.includes(op))) continue
        if (request.format && !capability.encodes.includes(request.format.to)) continue
        out.push({ engine, capability })
        break
      }
    }
    return out
  }

  const editCandidates = (mimeType: string, op: string): EditCandidate[] => {
    const mime = normalizeMime(mimeType)
    const out: EditCandidate[] = []
    for (const engine of engines) {
      for (const capability of engine.edits ?? []) {
        if (!matchesAny(capability.over, mime)) continue
        if (!capability.ops.includes(op)) continue
        out.push({ engine, capability })
        break
      }
    }
    return out
  }

  // ── the selection rule ─────────────────────────────────────────────────────
  const arbitrate = async <C extends { engine: MediaEngine }>(
    kind: 'convert' | 'mutate' | 'edit',
    request: EngineSelectionContext['request'],
    candidates: C[]
  ): Promise<C | undefined> => {
    if (candidates.length === 0) return undefined
    if (selection.length === 0 || candidates.length === 1) return candidates[0]
    const ctx: EngineSelectionContext = {
      kind,
      request,
      candidates: candidates.map((c) => c.engine),
    }
    const mw = new Middleware<EngineSelectionMiddlewareFn>()
    for (const fn of selection) mw.add(fn)
    let failed: unknown
    await mw
      .runner()
      .errorHandler(async (error: unknown) => {
        failed = error
      })
      .finalHandler(async () => {})
      .run((fn, next) => Promise.resolve(fn(ctx, next)))
    if (failed !== undefined) throw failed
    // Re-filter: stages narrow/reorder, never widen. First survivor in the stages' order wins.
    for (const engine of ctx.candidates) {
      const survivor = candidates.find((c) => c.engine === engine)
      if (survivor) return survivor
    }
    return undefined
  }

  // ── convert pathfinding (declarations only) ───────────────────────────────
  const findPath = (fromMime: string, target: string): ConvertHop[] | undefined => {
    const start = normalizeMime(fromMime)
    const queue: Array<{ mime: string; path: ConvertHop[] }> = [{ mime: start, path: [] }]
    const visited = new Set<string>([start])
    while (queue.length > 0) {
      const { mime, path } = queue.shift()!
      if (path.length >= MAX_HOPS) continue
      // Direct edge from this node?
      if (convertCandidates(mime, target).length > 0) {
        return [...path, { fromMime: mime, to: target }]
      }
      // Expand through non-terminal tokens.
      for (const engine of engines) {
        for (const capability of engine.converts ?? []) {
          if (!matchesAny(capability.from, mime)) continue
          for (const to of capability.to) {
            if (TERMINAL_TOKENS.has(to)) continue
            const nextMime = EXT_TO_MIME[to]
            if (!nextMime || visited.has(nextMime)) continue
            visited.add(nextMime)
            queue.push({ mime: nextMime, path: [...path, { fromMime: mime, to }] })
          }
        }
      }
    }
    return undefined
  }

  const hasConvert = (from?: string, to?: string): boolean => {
    for (const engine of engines) {
      for (const capability of engine.converts ?? []) {
        if (from !== undefined && !matchesAny(capability.from, normalizeMime(from))) continue
        if (to !== undefined && !capability.to.includes(to)) continue
        return true
      }
    }
    return false
  }

  const convertTargets = (fromMime: string): readonly string[] => {
    const reachable: string[] = []
    const seen = new Set<string>()
    let frontier = [normalizeMime(fromMime)]
    const visitedMimes = new Set<string>(frontier)
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
      const next: string[] = []
      for (const mime of frontier) {
        for (const engine of engines) {
          for (const capability of engine.converts ?? []) {
            if (!matchesAny(capability.from, mime)) continue
            for (const to of capability.to) {
              if (!seen.has(to)) {
                seen.add(to)
                reachable.push(to)
              }
              if (TERMINAL_TOKENS.has(to)) continue
              const nextMime = EXT_TO_MIME[to]
              if (nextMime && !visitedMimes.has(nextMime)) {
                visitedMimes.add(nextMime)
                next.push(nextMime)
              }
            }
          }
        }
      }
      frontier = next
    }
    return reachable
  }

  const ids = (): string => engines.map((e) => e.id).join(', ') || '(none)'

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const path = findPath(request.mimeType, request.to)
    if (!path) {
      const supported = convertTargets(request.mimeType)
      throw new Error(
        `no configured engine (or computed path) can convert ${request.mimeType} to "${request.to}"; reachable targets: ${supported.join(', ') || '(none)'} (engines: ${ids()})`
      )
    }
    let bytes = request.bytes
    let mimeType = request.mimeType
    let result: ConvertResult | undefined
    for (const hop of path) {
      const candidates = convertCandidates(mimeType, hop.to)
      const chosen = await arbitrate(
        'convert',
        { mimeType, filename: request.filename, bytes, to: hop.to },
        candidates
      )
      if (!chosen) {
        throw new Error(
          `all engines capable of converting ${mimeType} to "${hop.to}" (${candidates.map((c) => c.engine.id).join(', ')}) were excluded by selection middleware`
        )
      }
      result = await chosen.capability.convert({
        bytes,
        mimeType,
        filename: request.filename,
        to: hop.to,
        options: request.options,
        signal: request.signal,
      })
      const first = result.outputs[0]
      if (!first) {
        throw new Error(
          `engine "${chosen.engine.id}" converted ${mimeType} to "${hop.to}" but produced no outputs`
        )
      }
      bytes = first.bytes
      mimeType = first.mimeType
    }
    return result!
  }

  const mutate = async (request: MutateRequest): Promise<EngineBytesResult> => {
    const candidates = mutateCandidates(request)
    if (candidates.length === 0) {
      const allOps = new Set<string>()
      const allEncodes = new Set<string>()
      for (const engine of engines) {
        for (const capability of engine.mutates ?? []) {
          for (const op of capability.ops) allOps.add(op)
          for (const enc of capability.encodes) allEncodes.add(enc)
        }
      }
      const wanted = requestedOps(request).join(', ') || '(none)'
      const encodeNote = request.format
        ? `; requested encoding "${request.format.to}" — declared encodings: ${[...allEncodes].join(', ') || '(none)'}. A different engine (e.g. sharp) may support it`
        : ''
      throw new Error(
        `no configured engine can mutate ${request.mimeType} with ops [${wanted}]${encodeNote} (engines: ${ids()})`
      )
    }
    const chosen = await arbitrate(
      'mutate',
      {
        mimeType: request.mimeType,
        filename: '',
        bytes: request.bytes,
        to: request.format?.to,
        ops: requestedOps(request),
      },
      candidates
    )
    if (!chosen) {
      throw new Error(
        `all engines capable of this mutate (${candidates.map((c) => c.engine.id).join(', ')}) were excluded by selection middleware`
      )
    }
    return chosen.capability.mutate(request)
  }

  const edit = async (request: EditRequest): Promise<EditResult> => {
    const candidates = editCandidates(request.mimeType, request.op)
    if (candidates.length === 0) {
      const allOps = new Set<string>()
      for (const engine of engines) {
        for (const capability of engine.edits ?? []) {
          for (const op of capability.ops) allOps.add(op)
        }
      }
      throw new Error(
        `no configured engine can apply "${request.op}" to ${request.mimeType}; declared edit ops: ${[...allOps].join(', ') || '(none)'} (engines: ${ids()})`
      )
    }
    const chosen = await arbitrate(
      'edit',
      {
        mimeType: request.mimeType,
        filename: '',
        bytes: request.bytes,
        ops: [request.op],
      },
      candidates
    )
    if (!chosen) {
      throw new Error(
        `all engines capable of "${request.op}" (${candidates.map((c) => c.engine.id).join(', ')}) were excluded by selection middleware`
      )
    }
    return chosen.capability.edit(request)
  }

  return {
    engines,
    hasConvert,
    hasMutate: () => engines.some((e) => (e.mutates ?? []).length > 0),
    hasEdit: (mime?: string, op?: string): boolean => {
      for (const engine of engines) {
        for (const capability of engine.edits ?? []) {
          if (mime !== undefined && !matchesAny(capability.over, normalizeMime(mime))) continue
          if (op !== undefined && !capability.ops.includes(op)) continue
          return true
        }
      }
      return false
    },
    convertTargets,
    convert,
    mutate,
    edit,
  }
}
