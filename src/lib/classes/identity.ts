import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_INVALID_INITIAL_IDENTITY_VALUE } from '../exceptions/runtime'
import type { AdkEncodableSnapshot } from './encodable'

/**
 * Plain input object supplied to {@link Identity} at construction time.
 *
 * @remarks
 * Validated against `rawIdentitySchema` before the `Identity` instance is created.
 */
export interface RawIdentity {
  /**
   * The system-facing identifier for this participant.
   *
   * @remarks
   * Used internally to correlate messages to a specific participant — e.g. a database ID or
   * a username. Never sent to the model directly; use `representation` for that.
   */
  identifier: string | number
  /**
   * How this participant should be presented to the model.
   *
   * @remarks
   * Accepts a plain string or an existing {@link @nhtio/adk!Tokenizable} instance. This is what the model
   * sees when it needs to distinguish between participants of the same role.
   */
  representation: string | Tokenizable
}

/**
 * A fully-resolved {@link RawIdentity} where `representation` has been normalised to a
 * {@link @nhtio/adk!Tokenizable} instance.
 *
 * @remarks
 * Used internally by the {@link Identity} constructor to assign private fields with
 * guaranteed types.
 */
interface ResolvedIdentity {
  identifier: string | number
  representation: Tokenizable
}

/**
 * Validator schema used to validate a {@link RawIdentity} before constructing an {@link Identity}.
 *
 * @remarks
 * Validates both fields of {@link RawIdentity}:
 * - `identifier` — required string or number.
 * - `representation` — required string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.schema}.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_IDENTITY_VALUE} (via the {@link Identity} constructor) when
 * validation fails.
 */
const rawIdentitySchema = validator.object<RawIdentity>({
  identifier: validator.alternatives(validator.string(), validator.number()).required(),
  representation: Tokenizable.schema.required(),
})

/**
 * An immutable, validated participant identity attached to a {@link @nhtio/adk!Message}.
 *
 * @remarks
 * Carries two distinct representations of the same participant: `identifier` is the
 * system-facing key (e.g. a database ID) used to correlate messages programmatically;
 * `representation` is what the model sees when it needs to distinguish between participants
 * sharing the same role. The `representation` is always a {@link @nhtio/adk!Tokenizable} so token cost
 * can be estimated inline.
 */
export class Identity {
  /**
   * Validator schema that accepts a {@link RawIdentity} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest an identity — for example,
   * as a required field inside a message schema.
   */
  public static schema = rawIdentitySchema

  /**
   * Returns `true` if `value` is an {@link Identity} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an {@link Identity} instance.
   */
  public static isIdentity(value: unknown): value is Identity {
    return isInstanceOf(value, 'Identity', Identity)
  }

  /**
   * The system-facing identifier for this participant — never sent to the model directly.
   */
  declare readonly identifier: string | number

  /**
   * How this participant is presented to the model, as a {@link @nhtio/adk!Tokenizable} for inline
   * token estimation.
   */
  declare readonly representation: Tokenizable

  #identifier: string | number
  #representation: Tokenizable

  /**
   * @param raw - The raw identity input validated against `rawIdentitySchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_IDENTITY_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawIdentity) {
    let resolved: ResolvedIdentity
    try {
      resolved = validateOrThrow<ResolvedIdentity>(rawIdentitySchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_IDENTITY_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#identifier = resolved.identifier
    this.#representation = Tokenizable.isTokenizable(resolved.representation)
      ? resolved.representation
      : new Tokenizable(resolved.representation)

    Object.defineProperties(this, {
      identifier: {
        get: () => this.#identifier,
        enumerable: true,
        configurable: false,
      },
      representation: {
        get: () => this.#representation,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Serialise this Identity into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * Emits a {@link RawIdentity}-shaped object; `representation` is the live {@link @nhtio/adk!Tokenizable}
   * instance (the encoder recurses into it). Round-trips via {@link Identity.[DECODE_METHOD]}, which
   * re-validates through the constructor.
   *
   * @returns A {@link RawIdentity}-shaped snapshot.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      identifier: this.#identifier,
      representation: this.#representation,
    }
  }

  /**
   * Reconstruct an {@link Identity} from an {@link Identity.[ENCODE_METHOD]} snapshot.
   *
   * @param data - The snapshot produced by {@link Identity.[ENCODE_METHOD]}.
   * @returns A fully-validated {@link Identity}.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): Identity {
    return new Identity(data as RawIdentity)
  }
}
