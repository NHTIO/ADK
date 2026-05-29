import { Identity } from './identity'
import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { E_INVALID_INITIAL_THOUGHT_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'
import type { RawIdentity } from './identity'

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
  /** The reasoning content as a plain string or an existing {@link @nhtio/adk!Tokenizable} instance. */
  content: string | Tokenizable
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
  content: Tokenizable
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
 * - `content` — required string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.schema}.
 * - `identity` — optional string, {@link @nhtio/adk!RawIdentity}, or {@link @nhtio/adk!Identity}; defaults to
 *   `'assistant'` when omitted.
 * - `createdAt` / `updatedAt` — required datetime-parseable values, normalised to `DateTime`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_THOUGHT_VALUE} (via the {@link Thought} constructor) when
 * validation fails.
 */
const rawThoughtSchema = validator
  .object<RawThought>({
    id: validator.string().required(),
    content: Tokenizable.schema.required(),
    identity: validator.alternatives(validator.string(), Identity.schema).default('assistant'),
    payload: validator.any().optional(),
    replayCompatibility: validator.string().min(1).optional(),
    createdAt: validator.datetime().required(),
    updatedAt: validator.datetime().required(),
  })
  .custom((value, helpers) => {
    const v = value as RawThought
    if (
      v.payload !== undefined &&
      (v.replayCompatibility === undefined || v.replayCompatibility === null)
    ) {
      return helpers.error('any.invalid')
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
 * a {@link @nhtio/adk!Tokenizable} so token cost can be estimated inline.
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
  /** The reasoning content as a {@link @nhtio/adk!Tokenizable} for inline token estimation. */
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
    this.#content = Tokenizable.isTokenizable(resolved.content)
      ? resolved.content
      : new Tokenizable(resolved.content)
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
}
