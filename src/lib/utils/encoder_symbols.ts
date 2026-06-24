/**
 * Well-known `Symbol.for()` keys for the `@nhtio/encoder` custom-class contract.
 *
 * @remarks
 * A primitive opts in to `encode()`/`decode()` by implementing two symbol-keyed methods:
 *
 * - `[ENCODE_METHOD](): Encodable` — an **instance** method returning a serialisable snapshot of self.
 * - `static [DECODE_METHOD](data): T` — a **static** factory reconstructing the instance from that snapshot.
 *
 * These are the docs' "Option B" (zero-dependency) opt-in: because `Symbol.for()` resolves against the
 * global symbol registry by string key, a class implements the contract **without importing
 * `@nhtio/encoder`**. The encoder only enters the picture for *decoding* — `registerClass()` (shipped by
 * the `@nhtio/adk/batteries/encoding` battery) maps the wire tag back to a constructor.
 *
 * The string keys are written here exactly once. Every encodable primitive imports these constants
 * rather than re-typing the literals — a typo in one class would otherwise silently make it
 * un-encodable (the encoder would flatten the instance to a plain object instead of throwing).
 *
 * The `: unique symbol` annotation is required: TypeScript only permits a `unique symbol`-typed value
 * as a computed class-member name.
 */

/** Instance method key: serialise the instance into an `Encodable` snapshot. */
export const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')

/** Static method key: reconstruct an instance from an `Encodable` snapshot. */
export const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')
