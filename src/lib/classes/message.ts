import { Media } from './media'
import { Identity } from './identity'
import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { E_INVALID_INITIAL_MESSAGE_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'
import type { RawIdentity } from './identity'

/**
 * The roles a {@link Message} author can hold.
 *
 * @remarks
 * Restricted to `user` and `assistant` — system instructions, developer directives, and
 * tool results are handled separately and never appear in the persisted message history.
 */
export type MessageRole = 'user' | 'assistant'

/**
 * Plain input object supplied to {@link Message} at construction time.
 *
 * @remarks
 * Validated against `rawMessageSchema` before the `Message` instance is created.
 * Temporal fields accept any value that Luxon can parse — ISO strings, Unix timestamps,
 * `Date` objects, or existing `DateTime` instances.
 *
 * At least one of `content` or `attachments` (non-empty) must be present — a message with
 * neither throws {@link @nhtio/adk!E_INVALID_INITIAL_MESSAGE_VALUE}.
 */
export interface RawMessage {
  /** Stable unique identifier for this message. */
  id: string
  /** Whether this message is from the human participant or the model. */
  role: MessageRole
  /**
   * The message content as a plain string or an existing {@link @nhtio/adk!Tokenizable} instance.
   *
   * @remarks
   * Optional — but required when `attachments` is absent or empty. The cross-field rule on
   * `rawMessageSchema` enforces that at least one of `content` or `attachments` is present.
   */
  content?: string | Tokenizable
  /**
   * Media attachments carried by this message — images, audio, video, documents.
   *
   * @remarks
   * Optional and symmetric across roles: both `user` and `assistant` messages may carry
   * attachments. Each attachment carries its own `trustTier` and `modalityHazard`, which the
   * renderer uses to wrap the asset in its own trust envelope independent of the message
   * envelope. How a renderer orders text vs attachments in the on-the-wire content array is
   * a renderer-policy concern, not a contract of {@link Message}.
   */
  attachments?: Media[]
  /**
   * The identity of the participant who authored this message.
   *
   * @remarks
   * Optional. When omitted, the `role` value is used as both the system-facing `identifier`
   * and the model-facing `representation`. Three accepted forms when provided:
   * - A plain `string` — used as both `identifier` and `representation`.
   * - A {@link @nhtio/adk!RawIdentity} object — validated and wrapped into an {@link @nhtio/adk!Identity}.
   * - An existing {@link @nhtio/adk!Identity} instance — passed through unchanged.
   */
  identity?: string | RawIdentity | Identity
  /** When this message was created. */
  createdAt: string | number | Date | DateTime
  /** When this message was last modified. */
  updatedAt: string | number | Date | DateTime
}

/**
 * A fully-resolved {@link RawMessage} where temporal fields have been normalised to Luxon
 * `DateTime` instances and `identity` is a validated {@link @nhtio/adk!Identity}.
 *
 * @remarks
 * Used internally by the {@link Message} constructor to assign private fields with
 * guaranteed types.
 */
interface ResolvedMessage {
  id: string
  role: MessageRole
  content?: Tokenizable
  attachments: Media[]
  identity: string | RawIdentity | Identity
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawMessage} before constructing a {@link Message}.
 *
 * @remarks
 * Validates all fields of {@link RawMessage}:
 * - `id` — required non-empty string.
 * - `role` — required; must be `'user'` or `'assistant'`.
 * - `content` — optional string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.schema}.
 * - `attachments` — optional array of {@link @nhtio/adk!Media} instances. Defaults to `[]`.
 * - At least one of `content` or `attachments` must be present and non-empty; a message with
 *   neither is invalid.
 * - `identity` — required string, {@link @nhtio/adk!RawIdentity}, or {@link @nhtio/adk!Identity}; a plain string is
 *   mapped to both `identifier` and `representation` automatically.
 * - `createdAt` / `updatedAt` — required datetime-parseable values, normalised to `DateTime`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_MESSAGE_VALUE} (via the {@link Message} constructor) when
 * validation fails.
 */
const rawMessageSchema = validator
  .object<RawMessage>({
    id: validator.string().required(),
    role: validator.string().valid('user', 'assistant').required(),
    content: Tokenizable.schema.optional(),
    attachments: validator
      .array()
      .items(
        validator.any().custom((value, helpers) => {
          if (Media.isMedia(value)) return value
          return helpers.error('any.invalid')
        })
      )
      .default([]),
    identity: validator
      .alternatives(validator.string(), Identity.schema)
      .default(validator.ref('role')),
    createdAt: validator.datetime().required(),
    updatedAt: validator.datetime().required(),
  })
  .custom((value, helpers) => {
    const resolved = value as ResolvedMessage
    const hasContent = resolved.content !== undefined && resolved.content !== null
    const hasAttachments = Array.isArray(resolved.attachments) && resolved.attachments.length > 0
    if (!hasContent && !hasAttachments) {
      return helpers.error('any.invalid')
    }
    return resolved
  })

/**
 * An immutable, validated conversation message from a human participant or the model.
 *
 * @remarks
 * Covers only `user` and `assistant` roles — system instructions, developer directives, and
 * tool results are not represented here. Constructed from a {@link RawMessage} via
 * `rawMessageSchema`. Temporal fields are normalised to Luxon `DateTime` instances at
 * construction time. Both `content` and `identity.representation` are {@link @nhtio/adk!Tokenizable} so
 * token cost can be estimated inline.
 *
 * A message may carry `content` (text), `attachments` (media), or both. The cross-field rule
 * on `rawMessageSchema` enforces that at least one is present. Downstream code that reaches
 * for `message.content` must handle the attachments-only case where `content` is `undefined`.
 */
export class Message {
  /**
   * Validator schema that accepts a {@link RawMessage} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a message entry — for
   * example, a collection schema that holds an array of messages.
   */
  public static schema = rawMessageSchema

  /**
   * Returns `true` if `value` is a {@link Message} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Message} instance.
   */
  public static isMessage(value: unknown): value is Message {
    return isInstanceOf(value, 'Message', Message)
  }

  /** Stable unique identifier for this message. */
  declare readonly id: string
  /** Whether this message is from the human participant or the model. */
  declare readonly role: MessageRole
  /**
   * The message content as a {@link @nhtio/adk!Tokenizable} for inline token estimation, or `undefined`
   * for attachments-only messages.
   *
   * @remarks
   * `undefined` when the message was constructed with only `attachments`. Render code that
   * needs the text portion must guard for the missing case rather than blindly calling
   * `message.content.toString()`.
   */
  declare readonly content: Tokenizable | undefined
  /**
   * Media attachments carried by this message.
   *
   * @remarks
   * Always defined as a frozen array — empty when the message has no attachments. Both
   * `user` and `assistant` messages may carry attachments. Each entry carries its own
   * `trustTier` and `modalityHazard`; the renderer wraps each in its own trust envelope
   * independent of the message envelope.
   */
  declare readonly attachments: ReadonlyArray<Media>
  /** The identity of the participant who authored this message. */
  declare readonly identity: Identity
  /** When this message was created. */
  declare readonly createdAt: DateTime
  /** When this message was last modified. */
  declare readonly updatedAt: DateTime

  #id: string
  #role: MessageRole
  #content: Tokenizable | undefined
  #attachments: ReadonlyArray<Media>
  #identity: Identity
  #createdAt: DateTime
  #updatedAt: DateTime

  /**
   * @param raw - The raw message input validated against `rawMessageSchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_MESSAGE_VALUE} when `raw` does not satisfy the schema —
   *   including the cross-field rule that at least one of `content` or `attachments` must be
   *   present and non-empty.
   */
  constructor(raw: RawMessage) {
    let resolved: ResolvedMessage
    try {
      resolved = validateOrThrow<ResolvedMessage>(rawMessageSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_MESSAGE_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#id = resolved.id
    this.#role = resolved.role
    this.#content =
      resolved.content === undefined || resolved.content === null
        ? undefined
        : Tokenizable.isTokenizable(resolved.content)
          ? resolved.content
          : new Tokenizable(resolved.content)
    this.#attachments = Object.freeze([...(resolved.attachments ?? [])])
    const rawIdentity = resolved.identity
    this.#identity = Identity.isIdentity(rawIdentity)
      ? rawIdentity
      : typeof rawIdentity === 'string'
        ? new Identity({ identifier: rawIdentity, representation: rawIdentity })
        : new Identity(rawIdentity)
    this.#createdAt = resolved.createdAt
    this.#updatedAt = resolved.updatedAt

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      role: {
        get: () => this.#role,
        enumerable: true,
        configurable: false,
      },
      content: {
        get: () => this.#content,
        enumerable: true,
        configurable: false,
      },
      attachments: {
        get: () => this.#attachments,
        enumerable: true,
        configurable: false,
      },
      identity: {
        get: () => this.#identity,
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
