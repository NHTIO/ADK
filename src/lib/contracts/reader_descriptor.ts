/**
 * The serialisable handle a reader emits so a reader-backed primitive can round-trip through
 * `encode()`/`decode()` without inlining its bytes.
 *
 * @module
 */

/**
 * A JSON-shaped value a reader descriptor's `locator` may carry.
 *
 * @remarks
 * Deliberately decoupled from `@nhtio/encoder`'s `Encodable`: the reader contracts live in the core and
 * must not depend on the optional encoder peer. A locator is a plain pointer (a storage key, a URL plus
 * fetch init, a base64 buffer for in-memory readers) — always JSON-expressible — so this narrower type
 * is sufficient and keeps the contract dependency-free. The `@nhtio/encoder` `Encodable` type is a
 * superset, so any `LocatorValue` is trivially encodable when the descriptor is serialised.
 */
export type LocatorValue =
  | string
  | number
  | boolean
  | null
  | LocatorValue[]
  | { [key: string]: LocatorValue }

/**
 * A tagged, serialisable description of *where* a reader's bytes live — never the bytes themselves.
 *
 * @remarks
 * Reader-backed primitives ({@link @nhtio/adk!Media}, {@link @nhtio/adk!SpooledArtifact}) serialise as
 * **handles**. On `encode()`, the reader emits this descriptor via its optional `describe()` method; on
 * `decode()`, the registered resolver for `tag` re-binds the `locator` to a live reader (re-injecting
 * the ambient `Disk`/OPFS root/`fetch` the locator alone cannot carry).
 *
 * - `tag` — the resolver key (e.g. `"spool:flydrive"`, `"media:in-memory"`, `"media:fetch"`). Namespaced
 *   `media:` / `spool:` so the two reader families never collide in their respective registries.
 * - `locator` — the JSON pointer the resolver needs: a storage key, a URL, or (for in-memory readers
 *   that own their bytes) the buffer itself, base64-encoded.
 */
export interface ReaderDescriptor {
  /** Resolver key identifying which registered resolver re-binds this handle on decode. */
  tag: string
  /** JSON-expressible pointer the resolver consumes to re-open the byte source. */
  locator: LocatorValue
}
