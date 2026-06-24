/**
 * Decode-time registries that re-bind a serialised {@link ReaderDescriptor} to a live reader.
 *
 * @module
 *
 * @remarks
 * Reader-backed primitives serialise as **handles**: `encode()` writes a `{ tag, locator }` descriptor;
 * `decode()` looks up the resolver registered for `tag` and calls it with the `locator` to produce a
 * working {@link @nhtio/adk!MediaReader} / {@link @nhtio/adk!SpoolReader}. The resolver closure is where
 * the *live binding* the locator cannot carry — a flydrive `Disk`, an OPFS root, `fetch` — is
 * re-injected.
 *
 * Two separate registries (media vs spool) so a `media:` tag can never resolve to a spool reader or vice
 * versa. The `register*` functions are re-exported from the `@nhtio/adk/batteries/encoding` battery for
 * consumers; the `resolve*` functions are called by the primitives' `[DECODE_METHOD]`.
 */

import { E_NO_READER_RESOLVER } from '../exceptions/runtime'
import type { MediaReader } from './media_reader'
import type { SpoolReader } from './spool_reader'
import type { LocatorValue, ReaderDescriptor } from './reader_descriptor'

/**
 * A factory that re-binds a descriptor's `locator` to a live {@link MediaReader}.
 *
 * @param locator - The JSON pointer captured at encode time.
 * @returns A working media reader over the same bytes.
 */
export type MediaReaderResolver = (locator: LocatorValue) => MediaReader

/**
 * A factory that re-binds a descriptor's `locator` to a live {@link SpoolReader}.
 *
 * @param locator - The JSON pointer captured at encode time.
 * @returns A working spool reader over the same bytes.
 */
export type SpoolReaderResolver = (locator: LocatorValue) => SpoolReader

const mediaResolvers = new Map<string, MediaReaderResolver>()
const spoolResolvers = new Map<string, SpoolReaderResolver>()

/**
 * Register (or replace) the resolver that re-binds a `media:` reader handle on decode.
 *
 * @remarks
 * Call once at application startup, before `decode()`. For durable stores, the resolver closure must
 * capture the same live binding the bytes were written with (e.g. the `fetch`-equivalent, an HTTP
 * client). The in-memory and fetch resolvers auto-register when the encoding battery loads; you only
 * register custom or durable ones yourself. Idempotent: re-registering the same `tag` overwrites.
 *
 * @param tag - The descriptor tag this resolver handles (e.g. `"media:in-memory"`).
 * @param resolver - Factory turning a captured locator back into a live {@link MediaReader}.
 */
export const registerMediaReaderResolver = (tag: string, resolver: MediaReaderResolver): void => {
  mediaResolvers.set(tag, resolver)
}

/**
 * Register (or replace) the resolver that re-binds a `spool:` reader handle on decode.
 *
 * @remarks
 * Call once at application startup, before `decode()`. Durable-store resolvers (flydrive, OPFS) must
 * capture the live `Disk`/OPFS root — the locator carries only the key. The in-memory resolver
 * auto-registers when the encoding battery loads. Idempotent: re-registering the same `tag` overwrites.
 *
 * @param tag - The descriptor tag this resolver handles (e.g. `"spool:flydrive"`).
 * @param resolver - Factory turning a captured locator back into a live {@link SpoolReader}.
 */
export const registerSpoolReaderResolver = (tag: string, resolver: SpoolReaderResolver): void => {
  spoolResolvers.set(tag, resolver)
}

/**
 * Re-bind a media reader descriptor to a live {@link MediaReader}.
 *
 * @remarks
 * Called by {@link @nhtio/adk!Media}'s `[DECODE_METHOD]`. Throws if no resolver is registered for the
 * descriptor's `tag` — the fix is to register one (with its live binding) before decoding.
 *
 * @param descriptor - The handle captured at encode time.
 * @returns A working media reader.
 * @throws {@link @nhtio/adk!E_NO_READER_RESOLVER} when no resolver is registered for `descriptor.tag`.
 */
export const resolveMediaReader = (descriptor: ReaderDescriptor): MediaReader => {
  const resolver = mediaResolvers.get(descriptor.tag)
  if (!resolver) {
    throw new E_NO_READER_RESOLVER([descriptor.tag])
  }
  return resolver(descriptor.locator)
}

/**
 * Re-bind a spool reader descriptor to a live {@link SpoolReader}.
 *
 * @remarks
 * Called by {@link @nhtio/adk!SpooledArtifact}'s `[DECODE_METHOD]` (and its subclasses'). Throws if no
 * resolver is registered for the descriptor's `tag`.
 *
 * @param descriptor - The handle captured at encode time.
 * @returns A working spool reader.
 * @throws {@link @nhtio/adk!E_NO_READER_RESOLVER} when no resolver is registered for `descriptor.tag`.
 */
export const resolveSpoolReader = (descriptor: ReaderDescriptor): SpoolReader => {
  const resolver = spoolResolvers.get(descriptor.tag)
  if (!resolver) {
    throw new E_NO_READER_RESOLVER([descriptor.tag])
  }
  return resolver(descriptor.locator)
}
