/**
 * The snapshot type a primitive's `[ENCODE_METHOD]()` returns.
 *
 * @module
 *
 * @remarks
 * Deliberately decoupled from `@nhtio/encoder`'s own `Encodable` type: the primitives live in the core
 * and implement the encoder contract via raw `Symbol.for()` keys (the "Option B" zero-dependency opt-in),
 * so the core must not type-depend on the optional encoder peer — a consumer who never installs
 * `@nhtio/encoder` must still be able to type-check against `@nhtio/adk`.
 *
 * A snapshot is whatever the encoder can serialise: primitives, plain objects, arrays, `Map`, `Set`,
 * `bigint`, typed arrays, `Date`, Luxon values, and *other registered custom-class instances* (which is
 * why this is intentionally broad — a `Message` snapshot legitimately holds live `Tokenizable` /
 * `Identity` / `Media` instances, and the encoder recurses into them). `unknown` is the honest type: the
 * encoder validates serialisability at runtime and throws `E_UNENCODABLE_VALUE` on anything it cannot
 * handle. The alias exists for intent and readability, not for compile-time enforcement.
 */
export type AdkEncodableSnapshot = unknown
