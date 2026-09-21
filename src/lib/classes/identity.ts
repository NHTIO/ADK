import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError, isObject } from '../utils/guards'
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
 * Registry of every {@link Identity} genuinely constructed by this module, in this realm.
 *
 * @remarks
 * The brand that {@link identityOrRawIdentitySchema} trusts to bypass raw-object validation. A
 * {@link WeakSet} keyed by the instance is unforgeable (unlike {@link Identity.isIdentity}, which
 * falls back to a `constructor.name` comparison for cross-realm reach and therefore also accepts a
 * hand-rolled look-alike) and holds no strong reference. Every instance adds itself in the
 * constructor; membership means the instance carries real, intact private fields.
 */
const liveIdentities = new WeakSet<object>()

/**
 * Public schema fragment that accepts either a plain {@link RawIdentity} object or an existing
 * {@link Identity} instance.
 *
 * @remarks
 * A genuinely-constructed live {@link Identity} passes through the custom branch UNCHANGED — mirroring
 * {@link @nhtio/adk!Tokenizable.schema}. This matters because Joi's object schema *clones* any value it
 * validates, and cloning an `Identity` produces a look-alike with the right prototype but no private
 * `#identifier` / `#representation` fields (the constructor never ran), which then throws on
 * `[ENCODE_METHOD]`. Returning the live instance verbatim keeps its private state intact so it encodes
 * and re-wraps losslessly.
 *
 * Only a **branded** instance (one this module actually constructed — see {@link liveIdentities})
 * bypasses validation. A bare `constructor.name === 'Identity'` is NOT enough: a look-alike or a
 * cross-realm instance is not in the brand set, so it falls through to {@link rawIdentitySchema},
 * which validates its fields (rejecting a malformed `representation`) rather than retaining an
 * unvalidated husk that would later produce invalid serialized state. Plain {@link RawIdentity}
 * objects fall through the same way.
 */
const identityOrRawIdentitySchema = validator
  .alternatives(
    validator.custom((value, helpers) => {
      if (isObject(value) && liveIdentities.has(value)) {
        return value
      }
      return helpers.error('any.invalid')
    }),
    rawIdentitySchema
  )
  .custom((value) => {
    // A genuinely-branded live instance passes through the first alternative untouched. Anything
    // else — a plain RawIdentity, a hand-rolled look-alike, or a FOREIGN/cross-realm `Identity`
    // (a second copy of the package in the dependency tree) — arrives here as the field-validated
    // output of `rawIdentitySchema`. Joi cloned it, so a foreign instance is now a husk that still
    // carries an `Identity`-named prototype but has NO private fields; `Identity.isIdentity` accepts
    // it (name/prototype fallback) yet `[ENCODE_METHOD]` throws reading the missing privates.
    // Rebuild any non-branded value into a genuine LOCAL Identity so every consumer stores real,
    // encodable private state regardless of where the value originated.
    if (isObject(value) && liveIdentities.has(value)) {
      return value
    }
    return new Identity(value as RawIdentity)
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
   * Validator schema that accepts a {@link RawIdentity} object OR an existing {@link Identity} instance.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest an identity — for example,
   * as a required field inside a message schema. A locally branded {@link Identity} passes through
   * unchanged (its private state is preserved, so it still encodes losslessly); foreign/cross-realm
   * identities and plain {@link RawIdentity} values are validated field-by-field and rebuilt locally.
   * See {@link identityOrRawIdentitySchema}.
   */
  public static schema = identityOrRawIdentitySchema

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

    // Brand this genuinely-constructed instance so `identityOrRawIdentitySchema` can trust it to
    // bypass raw-object validation. A look-alike or cross-realm object is never in this set.
    liveIdentities.add(this)
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
