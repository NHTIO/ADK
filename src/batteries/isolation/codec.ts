/**
 * Tiered codec — the cheapest sufficient wire serialization for each call/stream argument and result.
 *
 * @remarks
 * Three tiers, escalating only as far as a given value actually requires:
 *
 * 1. **`raw`** — the value crosses untouched (same reference on a linked in-memory port; structurally
 *    cloned by a real transport). Zero-copy, zero-clone at this layer. Used whenever a value contains
 *    no "exotic" leaf.
 * 2. **Path-sentineled raw** — a container that has ordinary JSON-safe data EXCEPT for a small number
 *    of exotic leaves (e.g. one callback buried in an options bag) is cloned ONLY along the paths that
 *    lead to those leaves, with each exotic leaf replaced by a `{ __nhtio$: <encoded string> }`
 *    sentinel; the rest of the container (and the caller's original object) is untouched.
 * 3. **`nhtio`** — a whole exotic value (a bare function/Error/custom-encodable passed directly as an
 *    argument) is encoded in full via `@nhtio/encoder` (or a BYO codec) and shipped as a plain string.
 *
 * "Exotic leaf" = a function, an `Error`, or (when the `@nhtio/encoder` peer is installed) a value the
 * encoder recognizes as a registered custom-encodable. `TypedArray`/`ArrayBuffer`/`DataView`/`Date`/
 * `RegExp`/`Map`/`Set` are treated as OPAQUE traversal leaves — the traverser never descends into their
 * contents (so a huge `Float32Array` costs O(1) traversal step, not O(bytes)) and they ship raw as-is
 * (a linked in-memory port hands the same reference through; a real transport structurally clones or
 * transfers them).
 *
 * The `@nhtio/encoder` peer is OPTIONAL and NEVER statically imported — every reference to it goes
 * through {@link loadEncoder}, a lazy + memoized dynamic `import()` with an injectable seam for tests.
 *
 * Circular references are fine at the `raw` tier (the traverser's `ctx.circular` flag stops descent
 * without escalating). A circular reference reachable only through an exotic leaf's container throws
 * `E_ISOLATION_UNENCODABLE` — the encoder itself cannot represent it either.
 */

import { Traverse, type TraverseContext } from 'neotraverse/modern'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { E_ISOLATION_ENCODER_REQUIRED, E_ISOLATION_UNENCODABLE } from './exceptions'
import type { CodecMode } from './types'
import type { WireError, WireValue } from './protocol'

// ── Encoder peer: lazy + memoized + injectable ──────────────────────────────────────────────────────

/** The slice of `@nhtio/encoder`'s API surface this codec uses. Deliberately non-generic (`unknown` in,
 *  `unknown` out) — this codec always encodes/decodes values whose shape it cannot statically know, so
 *  the real encoder's `<T extends Encodable>`-constrained signature is narrowed away via
 *  {@link defaultEncoderLoader}'s adapter rather than reflected here. */
export interface EncoderModule {
  /** Encode an arbitrary value to its `@nhtio/encoder` wire string. */
  encode: (value: unknown) => string
  /** Decode a `@nhtio/encoder` wire string back into the original value. */
  decode: (encoded: string) => unknown
  /** Register a class as custom-encodable so `encode`/`decode` round-trip its instances. */
  registerClass: (ctor: { readonly name: string }) => void
  /** Whether `value` is an instance of a class previously passed to `registerClass`. */
  isCustomEncodable: (value: unknown) => boolean
  /** Whether `value` is an `Error` (or subclass), per the encoder's own classification. */
  isError: (value: unknown) => boolean
}

/** @internal Injectable loader seam so tests can simulate "encoder not installed" deterministically
 *  without actually uninstalling the real (installed) peer. Defaults to the real dynamic import. */
export type EncoderLoader = () => Promise<EncoderModule | undefined>

const defaultEncoderLoader: EncoderLoader = async () => {
  try {
    const [core, guards] = await Promise.all([
      import('@nhtio/encoder'),
      import('@nhtio/encoder/type_guards'),
    ])
    return {
      // The real encoder's `encode`/`decode` are generic over its own `Encodable` union; this codec
      // hands it values of unknown shape, so we narrow both to the codec-local `unknown`-based surface.
      encode: core.encode as EncoderModule['encode'],
      decode: core.decode as EncoderModule['decode'],
      registerClass: core.registerClass as EncoderModule['registerClass'],
      isCustomEncodable: guards.isCustomEncodable,
      isError: guards.isError,
    }
  } catch {
    return undefined
  }
}

let encoderLoader: EncoderLoader = defaultEncoderLoader
let memoizedEncoder: Promise<EncoderModule | undefined> | undefined

/**
 * @internal Test-only seam: override the encoder loader (e.g. to simulate "peer not installed"). Pass
 * `undefined` to restore the default real dynamic import. Also clears the memoization cache.
 */
export const setEncoderLoaderForTests = (loader?: EncoderLoader): void => {
  encoderLoader = loader ?? defaultEncoderLoader
  memoizedEncoder = undefined
}

/** Lazily load (and memoize) the optional `@nhtio/encoder` peer. Resolves `undefined` when absent. */
const loadEncoder = (): Promise<EncoderModule | undefined> => {
  if (!memoizedEncoder) memoizedEncoder = encoderLoader()
  return memoizedEncoder
}

/** Whether the encoder peer is currently available. Used to populate `ready.encoderAvailable`. */
export const isEncoderAvailable = async (): Promise<boolean> => (await loadEncoder()) !== undefined

// ── Transfer marker ──────────────────────────────────────────────────────────────────────────────────

const TRANSFER_MARKER = Symbol.for('@nhtio/adk/batteries/isolation:transfer')

interface TransferMarked {
  [TRANSFER_MARKER]: true
  value: unknown
  transferables: unknown[]
}

/**
 * Mark `value` for transfer (rather than clone) across a `postMessage`-based transport — WP2's browser
 * transport unwraps this into the message's transfer list. The codec passes marked values through as
 * `raw` with `transferables` preserved on the {@link WireValue} envelope's `transfer` field. Node
 * transports (WP3) ignore the marker entirely (structured-clone/pipe semantics don't have a transfer
 * list), so `transfer()` is safe to use in transport-agnostic code that may run over either.
 */
export const transfer = <T>(value: T, transferables: unknown[]): T => {
  const marked: TransferMarked = { [TRANSFER_MARKER]: true, value, transferables }
  return marked as unknown as T
}

const isTransferMarked = (value: unknown): value is TransferMarked =>
  isObject(value) && (value as Record<PropertyKey, unknown>)[TRANSFER_MARKER] === true

// ── Exotic-leaf classification ───────────────────────────────────────────────────────────────────────

/** Opaque-leaf types the traverser must never descend into (checked before the exotic-leaf probe). */
const isOpaqueContainer = (value: unknown): boolean =>
  isInstanceOf(value, 'Date', Date) ||
  isInstanceOf(value, 'RegExp', RegExp) ||
  isInstanceOf(value, 'Map', Map) ||
  isInstanceOf(value, 'Set', Set) ||
  isInstanceOf(value, 'ArrayBuffer', ArrayBuffer) ||
  ArrayBuffer.isView(value) // TypedArrays + DataView

const isPlainError = (value: unknown): value is Error => isError(value)

/** Classify a leaf as exotic (needs encoding) given the currently-loaded encoder (if any). Returns the
 *  escalation reason string for observability, or `undefined` when the leaf is ordinary. */
const classifyExotic = (value: unknown, encoder: EncoderModule | undefined): string | undefined => {
  if (typeof value === 'function') return 'function'
  if (encoder ? encoder.isError(value) : isPlainError(value)) return 'error'
  if (encoder && encoder.isCustomEncodable(value)) return 'custom-encodable'
  return undefined
}

// ── Path-clone helper ─────────────────────────────────────────────────────────────────────────────────

/** Clone only the containers along `path` (shallow-clone each ancestor), never the caller's original
 *  object, and never siblings off the path. Returns the new root plus a setter for the leaf at `path`. */
const cloneAlongPath = (
  root: unknown,
  path: PropertyKey[]
): { root: unknown; setLeaf: (value: unknown) => void } => {
  if (path.length === 0) {
    let leafHolder = root
    return {
      root: leafHolder,
      setLeaf: (value) => {
        leafHolder = value
      },
    }
  }
  const shallowClone = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.slice()
    if (node && typeof node === 'object') return { ...(node as Record<PropertyKey, unknown>) }
    return node
  }
  const newRoot = shallowClone(root) as Record<PropertyKey, unknown>
  let cursor: Record<PropertyKey, unknown> = newRoot
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const cloned = shallowClone(cursor[key]) as Record<PropertyKey, unknown>
    cursor[key] = cloned
    cursor = cloned
  }
  const lastKey = path[path.length - 1]
  return {
    root: newRoot,
    setLeaf: (value) => {
      cursor[lastKey] = value
    },
  }
}

// ── Encode (per-argument) ────────────────────────────────────────────────────────────────────────────

/** Result of scanning an argument for exotic leaves. */
interface ExoticScan {
  /** Every exotic leaf found, with its path from the argument's root. */
  leaves: Array<{ path: PropertyKey[]; value: unknown; reason: string }>
  /** `true` when a circular reference was found ANYWHERE reachable only via an exotic-leaf subtree
   *  (i.e. traversal reached a cycle while already inside/leading to exotic territory is irrelevant —
   *  what matters is whether the OVERALL value has both a cycle and an exotic leaf, since the encoder
   *  cannot represent either the whole value nor a sentineled fragment that itself cycles back outside
   *  the cloned path). */
  circular: boolean
}

const scanForExotic = (arg: unknown, encoder: EncoderModule | undefined): ExoticScan => {
  const leaves: ExoticScan['leaves'] = []
  let circular = false
  if (arg === null || typeof arg !== 'object') {
    const reason = classifyExotic(arg, encoder)
    if (reason) leaves.push({ path: [], value: arg, reason })
    return { leaves, circular }
  }
  new Traverse(arg).forEach((ctx: TraverseContext, node: unknown) => {
    if (ctx.circular) {
      circular = true
      return
    }
    // Opaque containers (including the root itself, e.g. a bare TypedArray argument): never exotic,
    // block descent so traversal costs O(container) rather than O(bytes) for large typed arrays.
    if (isOpaqueContainer(node)) {
      ctx.block()
      return
    }
    const reason = classifyExotic(node, encoder)
    if (reason) {
      leaves.push({ path: ctx.path.slice(), value: node, reason })
      ctx.block()
    }
  })
  return { leaves, circular }
}

/** Options threaded through {@link encodeArgument} for observability + BYO-codec support. */
export interface CodecContext {
  /** Codec mode/override for this argument (method/stream-level `codec` option). Default `'auto'`. */
  mode?: CodecMode
  /** Called once per exotic leaf found in `'auto'` mode, before encoding it — observability hook seam
   *  (`host.ts`/`serve.ts` wire this to `codec:escalate` reports). Given the ARGUMENT-RELATIVE path
   *  (e.g. `['onProgress']`) and the classification reason. */
  onEscalate?: (path: PropertyKey[], reason: string) => void
  /** Human-readable label for this argument, used in thrown exception messages (e.g. `'args[0]'`). */
  label: string
}

/**
 * Encode a single call/stream argument (or return value) into a {@link WireValue} per the tiered
 * strategy described in this module's header.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_ENCODER_REQUIRED} when escalation is needed
 *   but no encoder (peer or BYO) is available.
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNENCODABLE} when a value contains a
 *   circular reference alongside an exotic leaf, or the encoder itself rejects the value.
 */
export const encodeArgument = async (arg: unknown, ctx: CodecContext): Promise<WireValue> => {
  const mode = ctx.mode ?? 'auto'

  if (mode === 'raw') {
    return toRawWireValue(arg)
  }

  if (typeof mode === 'object') {
    // BYO codec: whole-value encode via the injected functions, verbatim.
    const encoded = await mode.encode(arg)
    return { enc: 'nhtio', v: encoded }
  }

  if (mode === 'encoded') {
    const encoder = await loadEncoder()
    if (!encoder) {
      throw new E_ISOLATION_ENCODER_REQUIRED([ctx.label])
    }
    try {
      return { enc: 'nhtio', v: encoder.encode(arg) }
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([ctx.label], { cause: err })
    }
  }

  // mode === 'auto'
  const encoder = await loadEncoder()
  const { leaves, circular } = scanForExotic(arg, encoder)

  if (leaves.length === 0) {
    // No exotic leaves anywhere — including if `arg` itself is circular but plain. Ship raw untouched.
    return toRawWireValue(arg)
  }

  if (circular) {
    // A circular reference co-exists with an exotic leaf — the encoder cannot represent this shape.
    throw new E_ISOLATION_UNENCODABLE([ctx.label])
  }

  if (leaves.length === 1 && leaves[0].path.length === 0) {
    // The WHOLE argument is itself exotic (a bare function/Error/custom-encodable) — encode it directly.
    if (!encoder) throw new E_ISOLATION_ENCODER_REQUIRED([ctx.label])
    ctx.onEscalate?.([], leaves[0].reason)
    try {
      return { enc: 'nhtio', v: encoder.encode(arg) }
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([ctx.label], { cause: err })
    }
  }

  if (!encoder) {
    throw new E_ISOLATION_ENCODER_REQUIRED([`${ctx.label}${formatPath(leaves[0].path)}`])
  }

  // Path-clone along each exotic leaf's path ONLY, replacing it with a `{ __nhtio$ }` sentinel. Never
  // mutates the caller's original object; siblings off every exotic path stay untouched (same refs).
  let root = arg
  for (const leaf of leaves) {
    ctx.onEscalate?.(leaf.path, leaf.reason)
    let encodedLeaf: string
    try {
      encodedLeaf = encoder.encode(leaf.value)
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([`${ctx.label}${formatPath(leaf.path)}`], { cause: err })
    }
    const { root: newRoot, setLeaf } = cloneAlongPath(root, leaf.path)
    setLeaf({ __nhtio$: encodedLeaf })
    root = newRoot
  }
  return toRawWireValue(root)
}

const formatPath = (path: PropertyKey[]): string =>
  path.length === 0 ? '' : `.${path.map(String).join('.')}`

/** Build a `raw` {@link WireValue}, unwrapping a {@link transfer} marker into the envelope's
 *  `transfer` field when present. */
const toRawWireValue = (value: unknown): WireValue => {
  if (isTransferMarked(value)) {
    return { enc: 'raw', v: value.value, transfer: value.transferables }
  }
  return { enc: 'raw', v: value }
}

// ── Decode (per-argument) ────────────────────────────────────────────────────────────────────────────

/** A raw value's sentinel shape for a path-cloned exotic leaf. */
interface NhtioSentinel {
  __nhtio$: string
}

const isNhtioSentinel = (value: unknown): value is NhtioSentinel =>
  isObject(value) &&
  typeof (value as Record<string, unknown>).__nhtio$ === 'string' &&
  Object.keys(value as object).length === 1

/**
 * Decode a {@link WireValue} back into the original value, rehydrating any `{ __nhtio$ }` sentinels
 * found while re-traversing a `raw` payload.
 *
 * @param wireValue - The value as it arrived over the wire.
 * @param mode - The SAME codec mode the sender used to encode it (needed for the BYO-codec case; ignored
 *   otherwise — the wire tier (`raw` vs `nhtio`) is otherwise self-describing).
 * @param label - Human-readable label for thrown exception messages.
 */
export const decodeArgument = async (
  wireValue: WireValue,
  mode: CodecMode | undefined,
  label: string
): Promise<unknown> => {
  if (wireValue.enc === 'nhtio') {
    if (typeof mode === 'object') {
      return mode.decode(wireValue.v)
    }
    const encoder = await loadEncoder()
    if (!encoder) throw new E_ISOLATION_ENCODER_REQUIRED([label])
    try {
      return encoder.decode(wireValue.v)
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([label], { cause: err })
    }
  }

  // enc === 'raw': re-traverse looking for `{ __nhtio$ }` sentinels to rehydrate. Fast-path: primitives
  // and objects with no sentinel anywhere pass through completely untouched (same reference).
  const raw = wireValue.v
  if (raw === null || typeof raw !== 'object') return raw
  if (isNhtioSentinel(raw)) {
    const encoder = await loadEncoder()
    if (!encoder) throw new E_ISOLATION_ENCODER_REQUIRED([label])
    try {
      return encoder.decode(raw.__nhtio$)
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([label], { cause: err })
    }
  }

  const sentinelPaths: PropertyKey[][] = []
  new Traverse(raw).forEach((ctx: TraverseContext, node: unknown) => {
    if (ctx.circular) return
    // Uniform opaque-container short-circuit (including at the root) — same O(container)-not-O(bytes)
    // requirement as `scanForExotic`'s encode-side traversal.
    if (isOpaqueContainer(node)) {
      ctx.block()
      return
    }
    if (isNhtioSentinel(node)) {
      sentinelPaths.push(ctx.path.slice())
      ctx.block()
    }
  })
  if (sentinelPaths.length === 0) return raw

  const encoder = await loadEncoder()
  if (!encoder) throw new E_ISOLATION_ENCODER_REQUIRED([label])
  let root: unknown = raw
  for (const path of sentinelPaths) {
    const traverseHelper = new Traverse(root)
    const sentinel = traverseHelper.get(path as PropertyKey[]) as NhtioSentinel
    let decoded: unknown
    try {
      decoded = encoder.decode(sentinel.__nhtio$)
    } catch (err) {
      throw new E_ISOLATION_UNENCODABLE([`${label}${formatPath(path)}`], { cause: err })
    }
    const { root: newRoot, setLeaf } = cloneAlongPath(root, path)
    setLeaf(decoded)
    root = newRoot
  }
  return root
}

/** Register classes for `@nhtio/encoder`'s custom-encodable round-trip (sugar over `registerClass`,
 *  called lazily once the encoder is loaded). Throws `E_ISOLATION_ENCODER_REQUIRED` when classes are
 *  listed but the peer is not installed. */
export const registerEncodableClasses = async (
  encodables: ReadonlyArray<{ readonly name: string }>
): Promise<void> => {
  if (encodables.length === 0) return
  const encoder = await loadEncoder()
  if (!encoder) {
    throw new E_ISOLATION_ENCODER_REQUIRED(['encodables option'])
  }
  for (const ctor of encodables) {
    encoder.registerClass(ctor as never)
  }
}

// ── Error crossing (WireError) ───────────────────────────────────────────────────────────────────────

/**
 * Build a {@link WireError} from a thrown value. The baseline `message`/`name`/`stack` fields are
 * ALWAYS populated (never omitted regardless of encoder availability) — error-classification-by-
 * message-signature must keep working even when the encoder is unavailable or a decode later fails.
 * When `includeRich` is `true` (both sides advertised `encoderAvailable`), ALSO attempts to encode the
 * original error via `@nhtio/encoder` onto `nhtio` — best-effort: an encode failure silently omits
 * `nhtio` rather than failing the whole error-crossing.
 */
export const toWireError = async (err: unknown, includeRich: boolean): Promise<WireError> => {
  const isErr = isError(err)
  const message = isErr ? err.message : typeof err === 'string' ? err : String(err)
  const name = isErr ? err.name : 'Error'
  const stack = isErr ? err.stack : undefined
  const wireError: WireError = { message, name, stack }
  if (includeRich && isErr) {
    const encoder = await loadEncoder()
    if (encoder) {
      try {
        wireError.nhtio = encoder.encode(err)
      } catch {
        // Best-effort rich path — the baseline fields already carry full message/name/stack fidelity.
      }
    }
  }
  return wireError
}

/**
 * Reconstruct an `Error` from a {@link WireError}, preferring the `nhtio`-encoded original when present
 * and decodable. Falls back silently to the baseline `name`/`message`/`stack` fields on ANY decode
 * failure (missing encoder, corrupt payload, version mismatch) — the baseline is always sufficient for
 * message-signature-based classification.
 */
export const fromWireError = async (wireError: WireError): Promise<Error> => {
  if (wireError.nhtio) {
    const encoder = await loadEncoder()
    if (encoder) {
      try {
        const decoded = encoder.decode(wireError.nhtio)
        if (isError(decoded)) return decoded
      } catch {
        // Fall through to the baseline reconstruction below.
      }
    }
  }
  const err = new Error(wireError.message)
  err.name = wireError.name
  if (wireError.stack) err.stack = wireError.stack
  return err
}
