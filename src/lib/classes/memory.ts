import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { E_INVALID_INITIAL_MEMORY_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'

/**
 * Plain input object supplied to {@link Memory} at construction time.
 *
 * @remarks
 * Validated against `rawMemorySchema` before the `Memory` instance is created.
 * Temporal fields accept any value that Luxon can parse — ISO strings, Unix timestamps,
 * `Date` objects, or existing `DateTime` instances.
 */
export interface RawMemory {
  /** Stable unique identifier for this memory entry. */
  id: string
  /** The memory content as a plain string or an existing {@link @nhtio/adk!Tokenizable} instance. */
  content: string | Tokenizable
  /** Confidence score in the range `[0, 1]` — how certain the agent is that this memory is accurate. */
  confidence: number
  /** Importance score in the range `[0, 1]` — how much weight this memory should carry during retrieval. */
  importance: number
  /** When this memory was first recorded. */
  createdAt: string | number | Date | DateTime
  /** When this memory was last modified. */
  updatedAt: string | number | Date | DateTime
}

/**
 * A fully-resolved {@link RawMemory} where all fields have been validated and temporal values
 * normalised to Luxon `DateTime` instances.
 *
 * @remarks
 * This is the shape returned by `rawMemorySchema` after validation — used internally by the
 * {@link Memory} constructor to assign private fields with guaranteed types.
 */
interface ResolvedMemory {
  id: string
  content: Tokenizable
  confidence: number
  importance: number
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawMemory} before constructing a {@link Memory}.
 *
 * @remarks
 * Validates all six fields of {@link RawMemory}:
 * - `id` — required non-empty string.
 * - `content` — required string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.schema}.
 * - `confidence` — required number in `[0, 1]`.
 * - `importance` — required number in `[0, 1]`.
 * - `createdAt` / `updatedAt` — required datetime-parseable values, normalised to `DateTime`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_MEMORY_VALUE} (via the {@link Memory} constructor) when
 * validation fails.
 */
const rawMemorySchema = validator.object<RawMemory>({
  id: validator.string().required(),
  content: Tokenizable.schema.required(),
  confidence: validator.number().min(0).max(1).required(),
  importance: validator.number().min(0).max(1).required(),
  createdAt: validator.datetime().required(),
  updatedAt: validator.datetime().required(),
})

/**
 * An immutable, validated memory entry held by the agent.
 *
 * @remarks
 * Constructed from a {@link RawMemory} via `rawMemorySchema`. All temporal fields are
 * normalised to Luxon `DateTime` instances at construction time. The `content` field is
 * always a {@link @nhtio/adk!Tokenizable} so callers can estimate token cost without an additional
 * wrapping step.
 */
export class Memory {
  /**
   * Validator schema that accepts a {@link RawMemory} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a memory entry — for
   * example, a collection schema that holds an array of memories.
   */
  public static schema = rawMemorySchema

  /**
   * Returns `true` if `value` is a {@link Memory} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Memory} instance.
   */
  public static isMemory(value: unknown): value is Memory {
    return isInstanceOf(value, 'Memory', Memory)
  }
  /** Stable unique identifier for this memory entry. */
  declare readonly id: string
  /** The memory content as a {@link @nhtio/adk!Tokenizable} for inline token estimation. */
  declare readonly content: Tokenizable
  /** Confidence score in the range `[0, 1]`. */
  declare readonly confidence: number
  /** Importance score in the range `[0, 1]`. */
  declare readonly importance: number
  /** When this memory was first recorded. */
  declare readonly createdAt: DateTime
  /** When this memory was last modified. */
  declare readonly updatedAt: DateTime

  #id: string
  #content: Tokenizable
  #confidence: number
  #importance: number
  #createdAt: DateTime
  #updatedAt: DateTime

  /**
   * @param raw - The raw memory input validated against `rawMemorySchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_MEMORY_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawMemory) {
    let resolved: ResolvedMemory
    try {
      resolved = validateOrThrow<ResolvedMemory>(rawMemorySchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_MEMORY_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#id = resolved.id
    this.#content = Tokenizable.isTokenizable(resolved.content)
      ? resolved.content
      : new Tokenizable(resolved.content)
    this.#confidence = resolved.confidence
    this.#importance = resolved.importance
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
      confidence: {
        get: () => this.#confidence,
        enumerable: true,
        configurable: false,
      },
      importance: {
        get: () => this.#importance,
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
