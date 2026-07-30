import { Identity } from './identity'
import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_INVALID_INITIAL_THOUGHT_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'
import type { RawIdentity } from './identity'
import type { AdkEncodableSnapshot } from './encodable'

/**
 * Plain input object supplied to {@link Thought} at construction time.
 *
 * @remarks
 * Validated against `rawThoughtSchema` before the `Thought` instance is created.
 * Temporal fields accept any value that Luxon can parse — ISO strings, Unix timestamps,
 * `Date` objects, or existing `DateTime` instances.
 */
export interface RawThought {
  /** Stable unique identifier for this thought. */
  id: string
  /**
   * The reasoning content as a plain string or an existing {@link @nhtio/adk!Tokenizable} instance.
   *
   * @remarks
   * Required and non-empty in plain-text mode. In opaque mode ({@link RawThought.payload} present) it
   * may be empty or omitted — the payload carries the meaning — and resolves to an empty
   * {@link @nhtio/adk!Tokenizable}. `Thought.content` is therefore ALWAYS a `Tokenizable`, never
   * `undefined`, so readers need no guard.
   */
  content?: string | Tokenizable
  /**
   * The identity of the agent who produced this thought.
   *
   * @remarks
   * Required in multi-agent conversations to attribute reasoning traces to a specific agent.
   * Three accepted forms when provided:
   * - A plain `string` — used as both `identifier` and `representation`.
   * - A {@link @nhtio/adk!RawIdentity} object — validated and wrapped into an {@link @nhtio/adk!Identity}.
   * - An existing {@link @nhtio/adk!Identity} instance — passed through unchanged.
   *
   * When omitted, defaults to `'assistant'` (both `identifier` and `representation`).
   */
  identity?: string | RawIdentity | Identity
  /**
   * Optional vendor-opaque payload that round-trips back to a matching model wire.
   *
   * @remarks
   * Carries anything the ADK cannot interpret but a specific provider can — for example,
   * an Anthropic Messages thinking-block `signature`, an OpenAI Responses
   * `ResponseReasoningItem.encrypted_content` blob, a DeepSeek server-side reasoning handle,
   * or an MCP-mediated reasoning item.
   *
   * When present, an LLM battery MUST treat the thought as **opaque-mode**: do NOT inline
   * `content` through the plain `<thought>` envelope; serialise `payload` back to the wire in
   * whichever shape the matching {@link RawThought.replayCompatibility} identifier specifies.
   * The plain-text `content` is kept alongside for token-accounting and human/observer
   * inspection — it is not the thing the model sees.
   *
   * Cross-field invariant: a present `payload` REQUIRES a present {@link RawThought.replayCompatibility}.
   * A `payload` without `replayCompatibility` is malformed (the ADK has no way to know
   * which adapter can consume it) and {@link Thought.schema} rejects with
   * {@link @nhtio/adk!E_INVALID_INITIAL_THOUGHT_VALUE}.
   *
   * @defaultValue `undefined`
   */
  payload?: unknown
  /**
   * Optional free-form identifier describing which adapter wire-shape this thought can be
   * safely replayed into.
   *
   * @remarks
   * Examples (none of these are reserved by the ADK — they are consumer conventions):
   *   - `'plain-text'` — replayable into every LLM battery
   *   - `'anthropic-messages-thinking-v1'`
   *   - `'openai-responses-reasoning-item-v1'`
   *   - `'deepseek-reasoning-handle-v1'`
   *
   * LLM batteries declare via constructor option which tags they can safely replay; matching
   * opaque thoughts are routed to the wire's typed reasoning channel where it exists, or to a
   * documented side-channel key on the request body where the wire has none. Non-matching
   * opaque thoughts are elided from the current dispatch but NOT removed from
   * `ctx.turnThoughts` — they remain in context so a subsequent dispatch to a different
   * adapter that DOES declare the matching tag can pick them up.
   *
   * Plain-text thoughts (`payload === undefined` AND `replayCompatibility === undefined`, or
   * explicit `replayCompatibility: 'plain-text'`) are always replayable.
   *
   * A `replayCompatibility` without a `payload` is allowed — it documents intent ("this
   * plain-text thought is only meaningful to a specific fine-tuned variant") without
   * requiring an opaque blob.
   *
   * @defaultValue `undefined`
   */
  replayCompatibility?: string
  /** When this thought was recorded. */
  createdAt: string | number | Date | DateTime
  /** When this thought was last modified. */
  updatedAt: string | number | Date | DateTime
}

/**
 * A fully-resolved {@link RawThought} where temporal fields have been normalised to Luxon
 * `DateTime` instances.
 *
 * @remarks
 * Used internally by the {@link Thought} constructor to assign private fields with
 * guaranteed types.
 */
interface ResolvedThought {
  id: string
  content?: string | Tokenizable
  identity: string | RawIdentity | Identity
  payload?: unknown
  replayCompatibility?: string
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawThought} before constructing a {@link Thought}.
 *
 * @remarks
 * Validates all fields of {@link RawThought}:
 * - `id` — required non-empty string.
 * - `content` — string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.emptyableSchema}.
 *   Required and non-empty in plain-text mode; may be empty or omitted in opaque mode (see the
 *   content-OR-payload rule below).
 * - `identity` — optional string, {@link @nhtio/adk!RawIdentity}, or {@link @nhtio/adk!Identity}; defaults to
 *   `'assistant'` when omitted.
 * - `createdAt` / `updatedAt` — required datetime-parseable values, normalised to `DateTime`.
 *
 * Cross-field rule — a thought must carry meaning through EITHER its prose OR an opaque replay
 * `payload`. A NULLISH payload (`undefined` or `null`) carries no replay data and so counts as ABSENT
 * for both halves of the rule:
 * - `payload` ABSENT (plain-text mode) — `content` is REQUIRED and must be non-empty. The prose is
 *   the only thing the thought has; an empty one is indistinguishable from a bug.
 * - `payload` PRESENT (opaque mode) — `content` may be empty or omitted, and resolves to an empty
 *   {@link @nhtio/adk!Tokenizable}. The payload is what round-trips to the wire; `content` is kept only
 *   for token-accounting and human/observer inspection (see {@link RawThought.payload}), so a
 *   signed-but-textless provider thinking block is legitimate. Rejecting it would discard the
 *   payload's replay data — strictly worse than storing a thought with no prose.
 *
 * A present `payload` additionally REQUIRES a present `replayCompatibility`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_THOUGHT_VALUE} (via the {@link Thought} constructor) when
 * validation fails.
 */
const rawThoughtSchema = validator
  .object<RawThought>({
    id: validator.string().required(),
    // Emptiness is adjudicated by the cross-field rule below, which needs to see `payload` to decide.
    content: Tokenizable.emptyableSchema.optional(),
    identity: validator.alternatives(validator.string(), Identity.schema).default('assistant'),
    payload: validator.any().optional(),
    replayCompatibility: validator.string().min(1).optional(),
    createdAt: validator.datetime().required(),
    updatedAt: validator.datetime().required(),
  })
  .custom((value, helpers) => {
    const v = value as RawThought
    // A NULLISH payload carries no replay data, so it is opaque mode in NEITHER rule below. `null`
    // reaches here easily — JSON round-tripping, a serializer normalising absent fields, a provider
    // mapper assigning a nullish thinking block — and treating it as "present" would both demand a
    // pointless `replayCompatibility` and, worse, waive the content requirement for a thought that has
    // no prose AND no payload: the exact state the either-or exists to forbid.
    const hasPayload = v.payload !== undefined && v.payload !== null
    if (hasPayload && (v.replayCompatibility === undefined || v.replayCompatibility === null)) {
      return helpers.error('any.invalid')
    }
    // content-OR-payload: only an opaque thought may go without prose. A Tokenizable counts as
    // present without being unwrapped — a dynamic one would evaluate its callback just to be measured,
    // and its emptiness is not knowable until prompt-assembly anyway.
    if (!hasPayload) {
      const hasContent = Tokenizable.isTokenizable(v.content)
        ? true
        : typeof v.content === 'string' && v.content.length > 0
      if (!hasContent) {
        return helpers.error('any.invalid')
      }
    }
    return value
  })

/**
 * An immutable, validated internal reasoning trace produced by an agent.
 *
 * @remarks
 * Represents an agent's internal thinking — distinct from {@link @nhtio/adk!Message} (which is part of
 * the visible conversation) and never shown to end users directly. Carries an `identity` so
 * reasoning traces can be attributed to a specific agent in multi-agent conversations.
 * Constructed from a {@link RawThought} via `rawThoughtSchema`. The `content` field is always
 * a {@link @nhtio/adk!Tokenizable} so token cost can be estimated inline — including when the raw input
 * omitted it or supplied `''`, which is legal in opaque-replay mode and resolves to an empty
 * {@link @nhtio/adk!Tokenizable}.
 */
export class Thought {
  /**
   * Validator schema that accepts a {@link RawThought} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a thought entry.
   */
  public static schema = rawThoughtSchema

  /**
   * Returns `true` if `value` is a {@link Thought} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Thought} instance.
   */
  public static isThought(value: unknown): value is Thought {
    return isInstanceOf(value, 'Thought', Thought)
  }

  /** Stable unique identifier for this thought. */
  declare readonly id: string
  /**
   * The reasoning content as a {@link @nhtio/adk!Tokenizable} for inline token estimation.
   *
   * @remarks
   * Never `undefined` — an opaque thought constructed without prose carries an empty
   * {@link @nhtio/adk!Tokenizable} here, so readers need no presence guard.
   */
  declare readonly content: Tokenizable
  /** The identity of the agent who produced this thought. */
  declare readonly identity: Identity
  /**
   * Optional vendor-opaque payload that round-trips back to a matching model wire.
   * See {@link RawThought.payload}.
   */
  declare readonly payload: unknown
  /**
   * Optional wire-shape identifier describing which adapter can safely replay this thought.
   * See {@link RawThought.replayCompatibility}.
   */
  declare readonly replayCompatibility: string | undefined
  /** When this thought was recorded. */
  declare readonly createdAt: DateTime
  /** When this thought was last modified. */
  declare readonly updatedAt: DateTime

  #id: string
  #content: Tokenizable
  #identity: Identity
  #payload: unknown
  #replayCompatibility: string | undefined
  #createdAt: DateTime
  #updatedAt: DateTime

  /**
   * @param raw - The raw thought input validated against `rawThoughtSchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_THOUGHT_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawThought) {
    let resolved: ResolvedThought
    try {
      resolved = validateOrThrow<ResolvedThought>(rawThoughtSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_THOUGHT_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#id = resolved.id
    // Absent content is legal only in opaque mode (enforced by rawThoughtSchema). Resolve it to an
    // EMPTY Tokenizable rather than leaving it undefined so `content` stays a total field — every
    // reader can call `.toString()` / measure it without a guard.
    this.#content = Tokenizable.isTokenizable(resolved.content)
      ? resolved.content
      : new Tokenizable(resolved.content ?? '')
    const rawIdentity = resolved.identity
    this.#identity = Identity.isIdentity(rawIdentity)
      ? rawIdentity
      : typeof rawIdentity === 'string'
        ? new Identity({ identifier: rawIdentity, representation: rawIdentity })
        : new Identity(rawIdentity)
    this.#payload = resolved.payload
    this.#replayCompatibility = resolved.replayCompatibility
    this.#createdAt = resolved.createdAt
    this.#updatedAt = resolved.updatedAt

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      content: {
        get: () => this.#content,
        enumerable: true,
        configurable: false,
      },
      identity: {
        get: () => this.#identity,
        enumerable: true,
        configurable: false,
      },
      payload: {
        get: () => this.#payload,
        enumerable: true,
        configurable: false,
      },
      replayCompatibility: {
        get: () => this.#replayCompatibility,
        enumerable: true,
        configurable: false,
      },
      createdAt: {
        get: () => this.#createdAt,
        enumerable: true,
        configurable: false,
      },
      updatedAt: {
        get: () => this.#updatedAt,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Serialise this Thought into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * Emits a {@link RawThought}-shaped object; `content` is the live {@link @nhtio/adk!Tokenizable},
   * `identity` the live {@link @nhtio/adk!Identity}, and the temporal fields live Luxon `DateTime`s (the
   * encoder recurses into each). The vendor-opaque `payload` is passed through as-is — if it holds a
   * value the encoder cannot serialise, encode throws (standard encoder behaviour). Round-trips via
   * {@link Thought.[DECODE_METHOD]}, which re-validates through the constructor.
   *
   * @returns A {@link RawThought}-shaped snapshot.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      id: this.#id,
      content: this.#content,
      identity: this.#identity,
      payload: this.#payload,
      replayCompatibility: this.#replayCompatibility,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
    }
  }

  /**
   * Reconstruct a {@link Thought} from a {@link Thought.[ENCODE_METHOD]} snapshot.
   *
   * @param data - The snapshot produced by {@link Thought.[ENCODE_METHOD]}.
   * @returns A fully-validated {@link Thought}.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): Thought {
    return new Thought(data as RawThought)
  }
}
