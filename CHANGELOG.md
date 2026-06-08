# Changelog

All notable changes to `@nhtio/adk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2026-06-07

### Added

- **SoDK — a mental-model doc that teaches the loop in human terms.** A new page,
  `docs/sodk.md` ("Society Development Kit"), retells [How agents work](https://adk.nht.io/how-agents-work)
  and [What ADK is](https://adk.nht.io/what-adk-is) with exactly one noun swapped: where ADK says
  *model*, SoDK says *person*. It is a teaching device for the reader who can't yet see why an agent
  is the loop, not the LLM — role↔agent, task↔turn, briefing↔context, request↔tool, process↔middleware,
  "say where things get filed"↔the required storage callbacks. The human-facing prose plays it
  straight; the `<llm-only>` block names the metaphor outright and carries the full 1:1 map, so an
  agent answering a question can explain a concept *through* the framing or translate either way. Wired
  into the sidebar and home listing, and cross-linked from both source docs. Docs only — no code, types,
  or package surface change.

- **Importable ESLint plugin (`@nhtio/adk/eslint`).** The harness's documented contracts are now
  machine-checkable: a flat-config plugin that flags footguns the TypeScript compiler cannot see
  because they live in runtime validators or conventions, not types. Five rules ship —
  `require-validator-any-required` (a `validator.any()` chain with no explicit
  `.required()`/`.optional()`/`.default()`/`.forbidden()` silently admits null/undefined),
  `thought-payload-requires-replay-tag` (a `Thought` with a vendor `payload` but no
  `replayCompatibility` can never be safely replayed), `token-encoding-requires-context-window` (a
  Chat Completions adapter that counts tokens with no budget never runs its overflow guard),
  `artifact-tool-forbids-artifact-constructor` (an `ArtifactTool` that wraps another artifact
  recurses forever), and `no-model-in-tool-handler` (a model call inside a tool handler hides an
  unmanaged dispatch — unless the handler runs its own scoped sub-agent via `new TurnRunner(...)` or
  `DispatchRunner.dispatch(...)`). Import the assembled plugin
  from `@nhtio/adk/eslint` (or `adk.configs.recommended` for all five), or individual rules from
  `@nhtio/adk/eslint/rules/<name>`. `eslint` and `@typescript-eslint/utils` are **optional peers** —
  installed only by consumers who lint with the plugin. Rules are report-only with inline
  `eslint-disable` carve-outs. See the new **Developer Tools** docs section, which also now houses
  the ADK Assembly MCP guide.

- **Vector conformance harness is now public (`@nhtio/adk/batteries/vector/conformance`).** The
  `runVectorStoreConformance` suite (plus `stubEncoder` / `paddedStubEncoder`) that the 29 shipped
  adapters test against is now an exported, deep-import-only subpath, so anyone writing their own
  adapter can prove it against the exact same contract. The subpath imports `vitest`, declared as an
  **optional peer** (`peerDependenciesMeta`) — install it to run the suite; it is never pulled in by
  the `@nhtio/adk/batteries/vector` barrel, so a `createVectorStore` consumer takes on no test-runner
  dependency. See `docs/batteries/vector/custom-adapter.md`.

- **Query-builder grouping callbacks — mix AND and OR.** The `VectorQueryBuilder` filter methods
  (`.where` / `.andWhere` / `.orWhere` / `.whereNot` / new `.orWhereNot`) now accept a callback that
  receives a filter-only `FilterBuilder`, so you can express `A AND (B OR C)` and negated groups
  (`{ not: <group> }`) at any nesting depth — previously the builder could only emit flat DNF. The
  scalar forms are unchanged (`.whereNot('f', v)` is still `→ ne`). Groups compile to the neutral
  `FilterGroup` tree; the 6 native filter translators recurse over it and the over-fetch adapters
  JS-evaluate it. **Chroma** rejects a `not` group with `E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR`
  (consistent with its existing `exists`/`contains` limits); nested AND/OR works on all 29. See
  `docs/batteries/vector/query-builder.md`.

### Fixed

- **`.orWhere()` no longer silently drops its branch.** `where(A).where(B).orWhere(C)` previously
  compiled to `(A AND B) OR (A AND B AND C)`, which collapses to just `(A AND B)` — the `.orWhere(C)`
  was a no-op. It now correctly yields `(A AND B) OR C`, matching the documented knex semantics.

- **Chroma multi-row filter-scan.** A filter-scan (no `.near*()`) that matched more than one record
  returned only the first row: the adapter unwrapped `query()`'s nested result arrays on the `get()`
  path too. Fixed to unwrap only on the similarity path.

## 2026-06-06

### Added

- **Cloudflare Vectorize adapter (`@nhtio/adk/batteries/vector/cloudflare`).** Managed, serverless
  vector store over the Vectorize **V2 REST API** — pure `fetch`, no driver/peer dependency. A
  logical collection maps to a Vectorize index (`indexNamePrefix` isolates per use). Upserts use
  the NDJSON multipart endpoint (field `vectors`); query/get/delete use JSON. Dimensions must be
  **32–1536**. KNN `score` is recomputed locally from the returned values to the `[0,1]` contract;
  the document rides in a reserved `__document` metadata key. Native metadata filtering needs
  pre-created metadata indexes and lacks `$and`/`$or`, so the adapter **over-fetches (topK 50, the
  service cap when returning values/metadata) and JS-filters** via the neutral `evaluateFilter`
  for full cross-adapter parity. Cloudflare Vectorize is **aggressively eventually-consistent** —
  a fresh index takes ~8–34s before its first write is queryable and the query index flaps for
  seconds after writes/deletes; the adapter settle-polls the query index for stability, and the
  integration spec additionally uses **vitest `retry`** to ride out the flap deterministically
  (slow, ~8 min, but green). Managed, so no docker/CI matrix entry (like Pinecone / S3 Vectors).
  Verified 7/7 conformance against live Cloudflare Vectorize. This also adds an optional
  `retry`/`timeout` parameter to the shared `runVectorStoreConformance` harness (defaults preserve
  existing behavior).

- **Oracle 23ai AI Vector Search adapter (`@nhtio/adk/batteries/vector/oracle23ai`).** Each
  collection is a table with a native `VECTOR(dims, FLOAT32)` column; vectors are bound/read as
  `Float32Array` via the `oracledb` driver in **thin mode** (no Instant Client). KNN uses
  `VECTOR_DISTANCE(vec, :q, COSINE|EUCLIDEAN|DOT) ORDER BY … FETCH APPROX FIRST k ROWS ONLY`; the
  raw distance only orders candidates — the `[0,1]` score is recomputed locally from the stored
  vector. Metadata is a JSON-string CLOB (read via `fetchInfo` STRING) filtered with the neutral
  `evaluateFilter`; identifiers are double-quoted and `tablePrefix` isolates collections. Strongly
  consistent (commit per write). NB: VECTOR columns are rejected in the SYSTEM tablespace — the
  connecting user must default to a normal tablespace (e.g. USERS) and have CREATE TABLE; the
  docker `oracle` profile provisions such a user via `APP_USER`. Verified 7/7 conformance ×3
  against a live Oracle Free 23ai. Closes the Oracle 23ai gap in the Open WebUI minimum-support set.

- **AWS S3 Vectors adapter (`@nhtio/adk/batteries/vector/s3vectors`).** Managed, serverless vector
  store (no container, like Pinecone). The vector bucket is provisioned out-of-band; a logical
  collection maps to an **index** inside the bucket (`indexPrefix` isolates per use — index names
  must be 3–63 chars). KNN via `QueryVectors` (the returned `distance` is converted to the
  battery's normalized `[0,1]` score — cosine `sim = 1 - distance`); `PutVectors`/`GetVectors`/
  `DeleteVectors` for upsert/fetch/delete by key; metadata is native JSON with the document under a
  reserved `__document` key. `topK` is capped at the service max of **100**, so filtered/scan reads
  over-fetch to that ceiling and JS-filter via the neutral `evaluateFilter` for cross-adapter
  parity; eventual-consistency settle-polling makes read-after-write deterministic. Metrics:
  `cosine`/`euclidean` (S3 Vectors has no dot-product — `dot` throws at createCollection). Driver:
  `@aws-sdk/client-s3vectors` (lazy; credentials from the ambient AWS chain). Verified 7/7
  conformance ×3 against a live bucket in eu-west-1. Closes the S3 Vector Bucket gap in the Open
  WebUI minimum-support set.

- **Elasticsearch 8 vector adapter (`@nhtio/adk/batteries/vector/elasticsearch`).** A dedicated
  adapter for the Elasticsearch 8 dialect — each collection is an index with a `dense_vector`
  field, and KNN uses ES8's **top-level `knn` search clause** with an optional `filter`. This is
  distinct from the existing `opensearch` adapter, which speaks OpenSearch's `knn_vector` /
  `query.knn` dialect (an ES client cannot drive it). The neutral filter tree compiles to ES
  bool/term/range over `metadata.*` (`.keyword` for strings) via the exported
  `translateElasticsearchFilter`; writes use `bulk({ refresh: true })` for strong consistency;
  cosine `_score` (already `(sim+1)/2 ∈ [0,1]`) is normalized defensively. Driver:
  `@elastic/elasticsearch` (lazy; use the **v8** client against an 8.x server — a v9 client sends a
  compatibility header an 8.x server rejects). BYO client supported via
  `connection.client`. Verified 7/7 conformance ×3 against a live Elasticsearch 8.18.

- **Vespa vector adapter (`@nhtio/adk/batteries/vector/vespa`).** Vespa has no runtime
  collection creation — a collection is a *document type* declared in a deployed **application
  package**. The adapter holds the package state in memory and rebuilds + redeploys it (via a
  dependency-free, store-only ZIP writer — no zip lib needed) to the config server's
  `prepareandactivate` endpoint on each `createCollection`/`dropCollection`, generating
  `services.xml`, `hosts.xml`, a `validation-overrides.xml` (≤30-day window, for schema-removal /
  type-change), and a `schemas/<collection>.sd` per collection with an HNSW tensor field. KNN uses
  a YQL `nearestNeighbor` query with a `closeness` rank profile; filter-scan/delete use YQL +
  document-API; scores are re-computed locally from the stored vector via `normalizeScore` for the
  [0,1] contract guarantee (metric maps cosine→angular, dot→dotproduct, euclidean→euclidean). No
  npm driver — pure HTTP/`fetch`. Metadata is a JSON string field filtered with the neutral
  evaluator. Verified 7/7 conformance ×3 against a live Vespa.

- **Couchbase vector adapter (`@nhtio/adk/batteries/vector/couchbase`).** Enterprise Edition only —
  vector search is an EE feature; Community throws "vector typed fields not supported". A logical
  collection maps to a Couchbase scope.collection. KV operations (upsert/get/remove) are strongly
  consistent and serve point reads; the scoped FTS vector index is async, so it is settle-polled
  after writes and used **only** to retrieve the KNN candidate id set — scores are then
  re-computed locally from the stored vector via `normalizeScore`, guaranteeing the [0,1] contract
  regardless of the backend metric (cosine/dot_product/l2_norm). Filter-scan, enumerate and
  delete-by-filter use N1QL with `RequestPlus` for strong reads. `collectionPrefix` isolates
  collections (avoids per-test FTS-index rebuild churn). Metadata is a JSON string field filtered
  with the neutral evaluator. Driver: `couchbase`. Cluster/bucket are provisioned non-interactively
  (REST `clusterInit` + bucket create — see the docker-compose `couchbase` profile's init sidecar);
  the adapter manages scopes/collections + the FTS vector index. Omitted from the CI matrix (its
  two-step init can't be expressed as a single service alias); verified 7/7 conformance ×3 against
  a live Couchbase EE 8.0.

## 2026-06-05

### Added

- **MongoDB Atlas Vector Search adapter (`@nhtio/adk/batteries/vector/mongodb`).** Each collection
  is a MongoDB collection with an Atlas `vectorSearch` index on `vec`; KNN uses the `$vectorSearch`
  aggregation stage (cosine `vectorSearchScore`, [0,1]). Because the Atlas vector *index* updates
  asynchronously (~1s) while the document store is strongly consistent, filter-scans / fetch-by-id
  / delete read-back use a plain `find()` (immediate) and only KNN goes through `$vectorSearch` —
  with a post-write settle polling until the inserted ids are index-visible. `collectionPrefix`
  isolates collections (avoids per-test index rebuild churn). Metadata is a JSON string field
  filtered with the neutral evaluator. Driver: `mongodb`; works against `mongodb/mongodb-atlas-local`
  or a real Atlas cluster. Verified 7/7 conformance against a live atlas-local.

- **Apache Solr vector adapter (`@nhtio/adk/batteries/vector/solr`).** Dense-vector / kNN query
  parser (Solr 9+): a collection maps to a Solr core, the adapter ensures a `DenseVectorField`
  (`vec`) + `document`/`metadata` fields in the core schema, and searches with
  `{!knn f=vec topK=N}[…]` (cosine score already [0,1]). Metadata is a JSON string field filtered
  with the neutral filter tree's JS reference evaluator. No driver dependency — plain HTTP/JSON via
  `fetch`. The target core must already exist (`solr-precreate <core>`); the adapter manages its
  schema, not the core. Verified 7/7 conformance against a live Solr 9.

- **HNSWLib vector adapter (`@nhtio/adk/batteries/vector/hnswlib`).** Embedded, in-process (no
  server). Wraps the `hnswlib-node` native ANN index for KNN, paired with a JS sidecar that owns
  id↔label mapping and the document/metadata records (hnswlib stores vectors only); metadata
  filtering, filter-scans, projection, and delete are served from the sidecar via the neutral
  filter tree's JS reference evaluator. Native build must be approved (pnpm-workspace.yaml
  `allowBuilds`). Verified 7/7 conformance in-process.

- **ArangoDB vector adapter (`@nhtio/adk/batteries/vector/arangodb`).** Each collection is an
  ArangoDB document collection keyed by `_key`; KNN uses the exact AQL `COSINE_SIMILARITY` /
  `L2_DISTANCE` functions (no index required, always correct), with the experimental IVF
  `vector` index created lazily on first upsert for production-scale ANN. Metadata in a JSON
  string attribute filtered with the neutral filter tree's JS reference evaluator. Driver:
  `arangojs`. Verified 7/7 conformance against a live ArangoDB 3.12 backend.

- **Neo4j vector adapter (`@nhtio/adk/batteries/vector/neo4j`).** Native vector index (5.13+):
  each collection is a node label with a `VECTOR INDEX` on `vec`; KNN via
  `db.index.vector.queryNodes` (cosine score already [0,1]). Metadata is a JSON string property
  filtered with the neutral filter tree's JS reference evaluator. Upsert via `MERGE`; integer
  params wrapped with `neo4j.int()`. Driver: `neo4j-driver`. Verified 7/7 conformance against a
  live Neo4j 5 backend.

- **SurrealDB vector adapter (`@nhtio/adk/batteries/vector/surrealdb`).** Multi-model; each
  collection is a SurrealDB table storing the vector as an array field, KNN via
  `vector::similarity::cosine` / `vector::distance::euclidean` ordered appropriately. Metadata in
  a JSON string field filtered with the neutral filter tree's JS reference evaluator. All queries
  parameterized (`type::thing`, `$bindings`). Upsert via `UPSERT`. Driver: `surrealdb`. Verified
  7/7 conformance against a live SurrealDB v2 backend.

- **LanceDB vector adapter (`@nhtio/adk/batteries/vector/lancedb`).** Embedded, no server
  (file-based, like sqlite-vec/duckdb). Each collection is a Lance table with an explicit Arrow
  schema (`vec` as `FixedSizeList<Float32>`); KNN via `table.search(vector).distanceType(...)`,
  metadata in a JSON string column filtered with the neutral filter tree's JS reference evaluator.
  Upsert via merge-insert on `id`. Drivers: `@lancedb/lancedb` + `apache-arrow` (prebuilt binary,
  no native compile). Verified 7/7 conformance in-process (temp dir).

- **MariaDB vector adapter (`@nhtio/adk/batteries/vector/mariadb`).** Native `VECTOR(N)` columns
  (MariaDB 11.7+): vectors written with `VEC_FromText` / read with `VEC_ToText`, KNN via
  `VEC_DISTANCE_COSINE` / `VEC_DISTANCE_EUCLIDEAN`; metadata in a `JSON` column filtered with the
  neutral filter tree's JS reference evaluator. SQL backend → transactions + rawSql. Upsert via
  `ON DUPLICATE KEY UPDATE`. Driver: `mariadb`. Verified 7/7 conformance against a live MariaDB 11.7.

- **Meilisearch vector adapter (`@nhtio/adk/batteries/vector/meilisearch`).** Each collection is a
  Meilisearch index with a `userProvided` embedder (BYO vectors under `_vectors.default`); KNN via
  semantic search (`vector` + `hybrid.semanticRatio = 1`), `_rankingScore` maps directly to the
  [0,1] score contract. Metadata is a JSON string field filtered with the neutral filter tree's JS
  reference evaluator. Writes await task completion (strongly consistent). Enables the `vectorStore`
  experimental feature on connect. Driver: `meilisearch`. Verified 7/7 conformance against a live
  Meilisearch backend.

- **Typesense vector adapter (`@nhtio/adk/batteries/vector/typesense`).** Each collection is a
  Typesense collection with a native `float[]` vector field (KNN via `vector_query`); metadata is
  a JSON string field filtered with the neutral filter tree's JS reference evaluator. Native upsert
  by id; strongly consistent (writes searchable on resolve). Driver: `typesense`. Verified 7/7
  conformance against a live Typesense backend.

- **Elasticsearch / OpenSearch vector adapter (`@nhtio/adk/batteries/vector/opensearch`).** One
  adapter for the whole family — they share the kNN `_search` data model. Each collection is an
  index with a `knn_vector` (HNSW/Lucene) field; the neutral filter tree compiles to a bool-query
  over `metadata.*` keyword/numeric sub-fields. Writes use `refresh: true` for read-after-write
  consistency. Driver: `@opensearch-project/opensearch` by default; pass an `@elastic/elasticsearch`
  client via `connection.client` to target Elasticsearch. Verified 7/7 conformance against a live
  OpenSearch backend.

- **ClickHouse vector adapter (`@nhtio/adk/batteries/vector/clickhouse`).** Vectors in an
  `Array(Float32)` column, KNN via `cosineDistance` / `L2Distance` / negative-inner-product
  ordered ascending; metadata in a JSON `String` column. MergeTree allows duplicate keys, so
  upsert is delete-then-insert, and writes are made read-after-write consistent with
  `mutations_sync = 2`. Driver: `@clickhouse/client`. Verified 7/7 conformance against a live
  ClickHouse backend.

- **DuckDB vector adapter (`@nhtio/adk/batteries/vector/duckdb`).** In-process, no server
  (like sqlite-vec) — uses the `vss` community extension's `array_*_distance` functions over a
  `FLOAT[N]` column for KNN, with metadata in a `JSON` column. Driver: `@duckdb/node-api`.
  Verified 7/7 conformance in-process (`:memory:`).

- **Redis / Valkey vector adapter (`@nhtio/adk/batteries/vector/redis`).** One adapter for the
  whole Redis family via the RediSearch module (`redis/redis-stack-server`, or any Redis/Valkey
  with RediSearch loaded). Vectors are stored as FLOAT32 blobs on Redis hashes and searched with
  `FT.SEARCH ... KNN`; the neutral filter tree compiles to RediSearch query syntax (TAG/NUMERIC).
  Verified 7/7 conformance against a live RediSearch backend.

- **The `evaluate_katex` math tool now evaluates calculus numerically.** It previously mangled any
  calculus input — `\int_{0}^{1} x dx` had its bounds stripped by the LaTeX flattener and produced a
  cryptic `Syntax error in part "\int^(1) x dx"`. The tool now detects calculus on the raw LaTeX
  before flattening and computes it numerically with the bundled mathjs (no new dependency):
  definite integrals (`\int_{a}^{b} f \,dx`) via Simpson quadrature, derivatives at a point
  (`\frac{d}{dx} f \big|_{x=a}`) via central finite difference, and limits (`\lim_{x \to a} f`,
  including `a = \pm\infty`) via a two-sided approach. Results are rounded and labelled
  `Result (numeric):` to flag the approximation. Genuinely uncomputable inputs (indefinite integrals,
  derivatives without a point, infinite integration bounds, singular integrands, divergent limits)
  return a specific, guiding error instead of a garbled one. mathjs has no symbolic integration and
  its symbolic `derivative` is intentionally blocklisted here, so these are numeric methods.

### Fixed

- **`evaluate_katex` now maps inverse trig to the correct mathjs names.** `\arcsin`, `\arccos`, and
  `\arctan` were passed through as `arcsin`/`arccos`/`arctan`, which mathjs does not define, so every
  inverse-trig expression errored with `Undefined function`. They now translate to `asin`/`acos`/`atan`.

### Changed

- **Replaced the hand-rolled LaTeX regex parser with evaluatex.** The `evaluate_katex` tool's
  LaTeX-to-mathjs translator (`latexToMathjs`) used brittle regex substitutions that could not handle
  nested braces, causing expressions like `\frac{\sqrt{100}}{2}` to produce a Syntax Error.
  It is replaced by the evaluatex library (v2.2.0, zero deps, ~56KB, works in Node.js and all browsers),
  which parses LaTeX with a proper recursive parser. The scalar evaluation path now uses evaluatex
  directly; the numeric calculus path (integrals, derivatives, limits) still uses mathjs for
  per-point evaluation via a shared lightweight LaTeX-to-string translator. evaluatex is an optional
  peer dependency, following the existing battery pattern.

- **`ToolRegistry` now supports hidden tools.** A tool can be registered and callable without being
  immediately visible to the model — hidden state lives on the registry, not the tool. New methods:
  `hide(...names)`, `unhide(...names)`, `setHidden(...names)`, `clearHidden()`, `visible()`, and
  `hidden()`. The LLM batteries now read `visible()` instead of `all()` when building the tool
  definition list, so hidden tools are excluded from the rendered tool list but still resolve when
  called by name. Hidden state propagates through `ToolRegistry.merge`, and unregistering a tool
  automatically cleans up its hidden state. This enables discovery patterns where an agent has a
  tool that enumerates available tools, and the model picks one to call in a subsequent iteration
  without listing everything upfront.

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
