# Changelog

All notable changes to `@nhtio/adk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Unified `ByteStore<R>` storage contract** (`src/lib/contracts/byte_store.ts`) — the single
  low-level "give bytes, get a reader" shape every storage layer implements, with `SpoolStore`
  (`ByteStore<SpoolReader>`) and `MediaStore` (`ByteStore<MediaReader>`) semantic aliases. `write`
  accepts `string | Uint8Array | ReadableStream<Uint8Array>`; string input is UTF-8-encoded.
  Exported alongside `implementsByteStore` and `byteStoreSchema`.
- **Injectable `spoolStore` option** on the OpenAI and WebLLM Chat Completions batteries — back
  tool-output artifacts with durable storage (`OpfsSpoolStore`, a Flydrive-backed store) instead of
  the default per-dispatch in-memory store. Durable stores also stream large/binary tool output to
  disk rather than buffering it in memory.
- **`ctx.storeMediaBytes(id, bytes)` → `MediaReader`** and **`ctx.storeRetrievableBytes(id, bytes)`
  → `SpoolReader`** — handler-reachable byte-persistence conduits that route tool-generated media
  and large extracted RAG text into consumer storage. Both accept a `ReadableStream`. Exposed on
  `TurnContext` and `DispatchContext`; `ConduitBytes` is exported from the public API.
- **Reader-backed `Retrievable.content`** — `content` now accepts a `SpooledArtifact` in addition
  to `string | Tokenizable`, so large extracted RAG text can live in a consumer `ByteStore` instead
  of permanently on the heap. New `Retrievable.estimateTokens(encoding)` and
  `Retrievable.contentString()` accessors. (Note: token estimation and render still materialise the
  body transiently; reader-backing removes *permanent* heap residency, not the transient
  allocation.)

### Fixed

- **`InMemorySpoolStore` no longer corrupts binary tool output.** It previously UTF-8-decoded every
  `Uint8Array` at write time, mangling non-text bytes (PDFs, images). Bytes are now stored
  byte-faithfully; `InMemorySpoolReader` decodes on demand for line/text reads and reports the true
  stored byte length.

### Changed (BREAKING)

- **Render helpers are now async.** `renderFirstPartyRetrievables`,
  `renderThirdPartyPublicRetrievables`, `renderThirdPartyPrivateRetrievables`, `renderRetrievables`,
  and `renderChatCompletionsSystemPrompt` on `ChatCompletionsHelpers` now return `Promise<string>`
  (previously `string`). Consumers who override these helpers must update their signatures.
- **`TurnRunnerConfig` gains two required callbacks** — `storeMediaBytesCallback` and
  `storeRetrievableBytesCallback` (both arity 3). `RawDispatchContext` gains the matching required
  `storeMediaBytes` / `storeRetrievableBytes` fields.
- **Tool-output spool writes are now awaited** — a custom `spoolStore.write()` may return a
  `Promise` (required for `ReadableStream` input).
