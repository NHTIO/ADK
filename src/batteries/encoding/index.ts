/**
 * Opt-in serialization battery: make the ADK primitives round-trip through `@nhtio/encoder`.
 *
 * @module @nhtio/adk/batteries/encoding
 *
 * @remarks
 * The ADK primitives already carry the `@nhtio/encoder` custom-class contract — they implement the
 * `Symbol.for('@nhtio/encoder:toEncoded' | ':fromEncoded')` methods with **zero dependency** on the
 * encoder. That half works whether or not `@nhtio/encoder` is installed. This battery wires up the
 * *other* half — the part that genuinely needs the encoder — and nothing else imports it:
 *
 * 1. `registerAdkEncodables()` — tells the decoder how to map each `custom:<ClassName>` wire tag back to
 *    its constructor. Call it **once, before your first `decode()`**. Without it, `encode()` still works
 *    but `decode()` throws on every ADK primitive.
 * 2. Auto-registers the **in-memory** and **fetch** reader resolvers (they carry no live binding, so they
 *    need nothing from you). Durable-store resolvers — flydrive `Disk`, OPFS root — you register yourself
 *    with {@link registerSpoolReaderResolver} / {@link registerMediaReaderResolver}, because only you hold
 *    the live binding the serialised locator cannot carry.
 *
 * ::: what this battery does NOT do
 * It serialises the **conversation graph**, not your storage. It does not persist anything — it turns a
 * live object tree into a string and back. It does not conjure live bindings: a reader handle decodes to
 * a working reader only if you registered a resolver for its tag. It does not make closures portable: a
 * {@link @nhtio/adk!Tool} handler serialises by source text only (see {@link @nhtio/adk!Tool}). And it
 * cannot serialise a {@link @nhtio/adk!TurnGate} — a live pending Promise has no serialised form.
 * :::
 *
 * @example Register once at startup, then encode/decode freely.
 * ```typescript
 * import { encode, decode } from '@nhtio/encoder'
 * import { registerAdkEncodables } from '@nhtio/adk/batteries/encoding'
 *
 * registerAdkEncodables()
 *
 * const wire = encode(message)            // a Message with nested Identity / Tokenizable / Media
 * const restored = decode<Message>(wire)  // instanceof Message, nested primitives intact
 * ```
 *
 * @example Durable-store media/artifacts need a resolver carrying the live binding.
 * ```typescript
 * import { Disk } from 'flydrive'
 * import { FlydriveSpoolReader } from '@nhtio/adk/batteries/storage/flydrive'
 * import { registerAdkEncodables, registerSpoolReaderResolver } from '@nhtio/adk/batteries/encoding'
 *
 * registerAdkEncodables()
 * const disk = new Disk(myDriver)
 * registerSpoolReaderResolver('spool:flydrive', (locator) => {
 *   const { key, streamThresholdBytes } = locator as { key: string; streamThresholdBytes?: number }
 *   return new FlydriveSpoolReader(disk, key, { streamThresholdBytes })
 * })
 * ```
 */

import { registerClass } from '@nhtio/encoder'
import {
  InMemorySpoolReader,
  SPOOL_READER_TAG_IN_MEMORY,
} from '@nhtio/adk/batteries/storage/in_memory'
import {
  registerMediaReaderResolver,
  registerSpoolReaderResolver,
  inMemoryMediaReader,
  fromFetch,
  decodeBase64,
  MEDIA_READER_TAG_IN_MEMORY,
  MEDIA_READER_TAG_FETCH,
} from '@nhtio/adk/common'
import {
  Tokenizable,
  Registry,
  Identity,
  Memory,
  Message,
  Retrievable,
  Thought,
  ToolCall,
  Tool,
  ArtifactTool,
  ToolRegistry,
  SpooledArtifact,
  SpooledJsonArtifact,
  SpooledMarkdownArtifact,
  Media,
} from '@nhtio/adk'
import type { LocatorValue } from '@nhtio/adk/common'

/**
 * Re-export the resolver-registration functions so consumers wire durable-store bindings from one place.
 */
export {
  registerMediaReaderResolver,
  registerSpoolReaderResolver,
  resolveMediaReader,
  resolveSpoolReader,
} from '@nhtio/adk/common'
export type {
  ReaderDescriptor,
  LocatorValue,
  MediaReaderResolver,
  SpoolReaderResolver,
} from '@nhtio/adk/common'

/**
 * Every ADK primitive that opts in to the `@nhtio/encoder` custom-class contract.
 *
 * @remarks
 * `TurnGate` is intentionally absent — it wraps a live pending Promise and `AbortController` that cannot
 * survive serialisation. Each entry must expose a static `[DECODE_METHOD]`, which `registerClass`
 * requires.
 */
const ENCODABLE_CLASSES = [
  Tokenizable,
  Registry,
  Identity,
  Memory,
  Message,
  Retrievable,
  Thought,
  ToolCall,
  Tool,
  ArtifactTool,
  ToolRegistry,
  SpooledArtifact,
  SpooledJsonArtifact,
  SpooledMarkdownArtifact,
  Media,
] as const

let autoResolversRegistered = false

/**
 * Auto-register the resolvers that need no live binding: in-memory (bytes inlined in the locator) and
 * fetch (URL re-issued on read). Idempotent.
 */
const registerBindingFreeResolvers = (): void => {
  if (autoResolversRegistered) return
  autoResolversRegistered = true

  registerMediaReaderResolver(MEDIA_READER_TAG_IN_MEMORY, (locator: LocatorValue) => {
    const { bytesBase64 } = locator as { bytesBase64: string }
    return inMemoryMediaReader(decodeBase64(bytesBase64))
  })

  registerMediaReaderResolver(MEDIA_READER_TAG_FETCH, (locator: LocatorValue) => {
    const { url, init } = locator as unknown as { url: string; init?: RequestInit }
    return fromFetch(url, init)
  })

  registerSpoolReaderResolver(SPOOL_READER_TAG_IN_MEMORY, (locator: LocatorValue) => {
    const { content } = locator as { content: string }
    return new InMemorySpoolReader(content)
  })
}

/**
 * Register every ADK primitive with the `@nhtio/encoder` decoder, and auto-register the binding-free
 * reader resolvers (in-memory, fetch).
 *
 * @remarks
 * Idempotent — safe to call more than once (re-registering a class is a no-op overwrite). Call it once at
 * application startup, before the first `decode()`. Encoding never needs this; only decoding does,
 * because the decoder must map a `custom:<ClassName>` tag back to a constructor.
 *
 * Durable-store reader resolvers (flydrive, OPFS) are NOT registered here — they need the live `Disk` /
 * OPFS root only you hold. Register them yourself with {@link registerSpoolReaderResolver}.
 */
export const registerAdkEncodables = (): void => {
  for (const ctor of ENCODABLE_CLASSES) {
    // The ADK primitives implement the contract via raw `Symbol.for()` keys (zero-dep "Option B"), so
    // their static `[DECODE_METHOD]` is keyed by a symbol nominally distinct from the encoder's own
    // `unique symbol` — identical at runtime (`Symbol.for('@nhtio/encoder:fromEncoded')`), but not
    // structurally assignable to `DecodableConstructor` at the type level. The cast bridges that gap.
    registerClass(ctor as unknown as Parameters<typeof registerClass>[0])
  }
  registerBindingFreeResolvers()
}
