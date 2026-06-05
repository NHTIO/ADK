# Changelog

All notable changes to `@nhtio/adk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2026-06-04

### Fixed

- **LLM batteries now surface reasoning from providers that use the `reasoning` field.** The OpenAI
  and WebLLM Chat Completions batteries read only `reasoning_content`, so thinking output from
  endpoints that emit `reasoning` (Ollama's `/v1`, post-rename vLLM, OpenRouter) produced **no**
  thought events in either streaming or non-streaming mode. Reasoning is not part of OpenAI's
  official Chat Completions spec, so OpenAI-compatible providers disagree on the field name; both
  batteries now read `reasoning` and `reasoning_content` across both the streaming delta and
  non-streaming message shapes. Verified live against a per-model matrix of real endpoints
  (claude-haiku-4-5, gemini-3.5-flash, gemma4, deepseek-v4-flash, glm-5.1, gpt-oss:20b, kimi-k2.6,
  and a workstation Ollama tag).

### Added

- **`reasoningFieldPrecedence` option on the Chat Completions batteries.** An ordered, de-duplicating
  control over which provider reasoning field wins. When more than one listed field is present with
  identical content (or only one is present) a single thought is emitted, attributed to the
  highest-precedence field; when they diverge, each surfaces as its own thought rather than silently
  dropping one (in streaming mode both stream live and are de-duplicated by content at persistence).
  Defaults to `['reasoning', 'reasoning_content']`. A typed `reasoning` field was added to the
  `ChatCompletionsChunkDelta` and `ChatCompletionsResponseMessage` wire shapes, and the new
  `ReasoningField` / `ReasoningFieldPrecedence` / `ReasoningExtract` types plus the
  `extractReasoningFields` helper are exported from both batteries.

## 2026-06-03

### Changed

- **MCP install examples now render the current package version at docs build time.** The ADK MCP
  guide uses a `{{ADK_VERSION}}` token for pinned `@nhtio/adk@...` examples, and the docs build
  rewrites it from `package.json` for VitePress pages, LLM artifacts, the Ask ADK index, and the
  packaged MCP corpus. Release docs now stay aligned with the published package version without
  hand-editing install snippets before every tag.

## 2026-06-02

### Fixed

- **Corrected the `callId` documentation on the tool-execution events.** `ToolExecutionStartEvent.callId`
  and `ToolExecutionEndEvent.callId` were documented as correlating with `ToolCall.id`. They do not:
  `callId` is `sha256({ tool, args })` — the same value as `TurnToolCallContent.checksum` and
  `ToolCall.checksum`. The two buses join on **`toolCall.checksum === toolExecution*.callId`**, never
  on `toolCall.id`. The hash collides by design for identical `(tool, args)` (that is what
  `DispatchContext.toolCallCount` counts), so order or disambiguate repeated calls by the `DateTime`
  fields (`createdAt` / `updatedAt`, `startedAt` / `endedAt`). TSDoc and the Events guides now state
  this contract; no runtime behavior changed.

## 2026-06-01

### Added

- **Embeddings batteries** (`@nhtio/adk/batteries/embeddings/openai`,
  `@nhtio/adk/batteries/embeddings/webllm`) — two opt-in embedders that share one shape and differ
  only in their engine. `OpenAIEmbeddingsAdapter` POSTs to any OpenAI-`/v1/embeddings`-compatible
  endpoint over raw `fetch` (Node/browser/edge/workers); `WebLLMEmbeddingsAdapter` embeds in-process
  on WebGPU via `@mlc-ai/web-llm`. Both expose `embed` / `embedMany` / `dimensions` / `preload` /
  `reset` / `isAvailable`, return wire-native `number[]` / `number[][]`, require an explicit `model`
  (no default), and handle query/document instruction prefixes identically via a shared
  `kind: 'query' | 'document'` option. The environment-neutral OpenAI battery is re-exported from
  `@nhtio/adk/batteries/embeddings`; the WebGPU-only WebLLM battery is reachable only via its own
  subpath. Embedders are tools you call from your own retrieval middleware — they do not plug into
  an executor slot. See the new `docs/assembly/batteries-embeddings.md`.

### Fixed

- **`E_INVALID_TURN_RUNNER_CONFIG` now names the offending field.** A misconfigured `TurnRunner`
  previously threw a generic "cannot be instantiated with the provided configuration" with no
  indication of which field failed. The exception now carries the validator's field-level detail
  (e.g. `…: storeMediaBytesCallback is required`) and attaches the raw `ValidationError` on `cause`.
- **Unknown-tool errors now list the available tools.** When the model calls a tool that is not in
  the registry, the OpenAI and WebLLM Chat Completions batteries persist a tool-call error reading
  `Tool not found: <name>. Available tools: <a, b, c>.` (or `No tools are available this turn.`) so
  the model can self-correct on the next iteration instead of dead-ending on an opaque "not found".

## 2026-05-31

### Added

- **Packaged ADK Assembly MCP server** (`src/mcp/server.ts`) — `@nhtio/adk` now ships a local
  stdio MCP server that can be launched with `npx -y @nhtio/adk`. The server exposes ADK assembly
  guidance, packaged documentation search, document reads, generated API lookup, and pasted-code
  assembly review through MCP tools, resources, and prompts.
- **Version-aligned MCP documentation corpus** (`dist/mcp/adk-docs-corpus.json`) — package
  generation now copies hand-written docs, generated TypeDoc API pages, changelog content, and the
  ADK assembly Skill into a read-only corpus for the MCP server. The corpus is built from the docs
  available at package time so MCP answers match the installed package version.
- **ADK MCP documentation page** (`docs/mcp.md`) — added a VitePress guide for installing and using
  the ADK MCP across common coding-agent clients, including VS Code / Copilot, Claude Code, Claude
  Desktop, Cursor, Windsurf, Cline / Roo Code, and Continue.
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

- **Documentation now builds before the library package in CI.** The package build consumes the
  generated docs, API reference, and changelog artifact so the npm package always includes the MCP
  documentation corpus when built from tagged/default-branch CI jobs.
- **The generated npm package now exposes an `adk` binary.** `bin/package.ts` writes
  `bin.adk = "./adk-mcp.mjs"` into the packaged manifest and bundles the MCP SDK/Zod-backed server
  entry while keeping those MCP implementation dependencies out of the published runtime dependency
  list.
- **Render helpers are now async.** `renderFirstPartyRetrievables`,
  `renderThirdPartyPublicRetrievables`, `renderThirdPartyPrivateRetrievables`, `renderRetrievables`,
  and `renderChatCompletionsSystemPrompt` on `ChatCompletionsHelpers` now return `Promise<string>`
  (previously `string`). Consumers who override these helpers must update their signatures.
- **`TurnRunnerConfig` gains two required callbacks** — `storeMediaBytesCallback` and
  `storeRetrievableBytesCallback` (both arity 3). `RawDispatchContext` gains the matching required
  `storeMediaBytes` / `storeRetrievableBytes` fields.
- **Tool-output spool writes are now awaited** — a custom `spoolStore.write()` may return a
  `Promise` (required for `ReadableStream` input).
