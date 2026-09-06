# Changelog

All notable changes to `@nhtio/adk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This project does **not** use strict Semantic Versioning. Versions are
`<major>.<YYYYMMDD>.<n>` — a hybrid of one SemVer-like signal and
[CalVer](https://calver.org/): the major version increases only when the **core contract**
breaks (the primitives every assembly depends on — the runners, the callback contracts, the
artifact/retrievable model); the date is the release day; `<n>` counts same-day releases from
zero. Everything else — including breaking changes to individual batteries — ships under the
same major, called out explicitly in the entries below. So within a major, the version tells
you *when* you got it, not *what changed*: a `^` range will float across battery-level
breaking changes, so pin an exact version if you need stability and read the entry before
upgrading.

## 2026-09-06

### Changed

- **BREAKING (orchestration, one release-day of exposure): `runPlanStoreConformance` is no longer re-exported from the battery barrel.** It is reachable only at `@nhtio/adk/batteries/orchestration/conformance`, which is the subpath the documentation and the changelog already used. With `vitest` installed the barrel export DID resolve, so a test file that imported it from `@nhtio/adk/batteries/orchestration` must change its specifier. It is called out as breaking rather than filed quietly under a fix because that is what it is — the mitigating facts are that the export existed only in `1.20260905.1`, and that any consumer without `vitest` could not import the battery at all (see below).

### Fixed

- **Importing the orchestration battery required `vitest` to be installed.** The barrel re-exported `runPlanStoreConformance`, which pulled `conformance.ts` — and its `import { describe, expect, it } from 'vitest'` — into the module graph of every consumer. `vitest` is an **optional** peer dependency, so a package manager does not install it, and any consumer without a test runner got a hard `ERR_MODULE_NOT_FOUND` on `@nhtio/adk/batteries/orchestration` itself. The suite is now subpath-only (`@nhtio/adk/batteries/orchestration/conformance`), matching `batteries/vector`, whose conformance suite is likewise vitest-based and likewise excluded from its barrel. Nothing in this repository referenced it through the barrel — the spec, both documentation pages and the changelog already used the subpath. Found by installing the published `1.20260905.1` tarball as a real consumer; the in-repo test suite aliases `@nhtio/adk` to `./src` and is structurally incapable of catching this class.

## 2026-09-05

### Added

- **The orchestration battery — a staging environment for tool calls.** `@nhtio/adk/batteries/orchestration`, deep-import only. A plan is a persisted, content-addressed graph of the steps a model intends to take: it explores, stages the work, and stops, and the whole graph is reviewed and approved before a single side effect runs. **The permission gate IS the `reviewable → executable` lifecycle transition**, so "approved" and "executable" are one fact rather than two that can drift — there is no separate flag to forget to check, and a full re-gate after an edit needs no enforcement code, because an edit requires an unfreeze and the only route back passes through the gate again. Approval binds a lossless content digest AND the canonicalised authority set of every reachable `call`, so approving one plan can never authorise another. Seven node kinds (`entry`, `call`, `reason`, `transform`, `branch`, `select`, `join`), six edge handles, a BYO `PlanStore` with a conformance suite that has teeth, three predicate cells (`structured` zero-dependency, `jexl` expression-only, `lua` Node-only and sandboxed), and a three-tier tool surface where the split is a threat-model boundary: a conversational agent gets three tools and cannot reach graph mechanics at all. Ships with 591 tests and nine documentation pages. See [Orchestration](/batteries/orchestration/).
- **`@nhtio/adk/batteries/orchestration/conformance` — `runPlanStoreConformance`**, a vitest suite proving a BYO `PlanStore` actually holds the contract, including the parts that are easy to satisfy incorrectly: an append refused in `reviewable` and in `executable`, the settlement batch committing atomically (asserted by killing between the two appends), the stale-approval interleaving, `claimRun` succeeding exactly once against two concurrent claimants, artifact HANDLES surviving a `frontier_snapshot` round trip, and re-entry admitted after `aborted`/`halted` but refused after `completed`.

- **`tool_call_id_uniqueness` — a BLOCKING rule that stops tool-call id collisions from corrupting the wire.** Some OpenAI-compatible upstreams number tool-call ids **per response** rather than per conversation; confirmed live against `xai.grok-4.3` on Bedrock Mantle, where five sequential tool-calling turns each returned `call_0`. The OpenAI-family adapters adopt the vendor's id verbatim, so the collision reached ADK primitives intact and produced three distinct harms: the pre-rendered tool-result cache keyed by id collapsed two calls to one entry and sent the first call paired with the **second** call's result (indistinguishable from a cache hit); a reused completed id made the dispatch's `toolCallStreams` map throw on iteration 2; and a durable spool store keyed by id silently overwrote turn 1's bytes. The new `IdentifierUniquenessRule` (a cross-entry set property, not a per-entry predicate) detects the collision group and, under `action: 'mutate'`, repairs it via `renumber-colliding-ids` — renaming **every** member of the group through a new atomic group-replacement capability on the context. It is **blocking** because an advisory finding can never be repaired, and it applies to the **dispatch surface only** (`surface: 'dispatch'`), so it stays inert on the turn middleware where a blocking collision would abort the turn before the dispatch that could repair it ever ran. See [Atomic Behaviors](/batteries/validation/behaviors#_21-tool-call-id-uniqueness).
- **`toolCallIdFilter` — an opt-in ingress seam to de-collide a provider's id before it reaches storage.** A `(id, ctx) => string` hook, default absent = identity, plus a shipped `deCollideToolCallIds` that returns a fresh `uuidv6()` only on an actual collision. Six batteries expose it (`openai_chat_completions`, `openai_responses`, `anthropic_messages`, `bedrock_converse`, `ollama`, `webllm_chat_completions`); four deliberately do not, because they mint their own ids and have nothing to filter (`gemini_generate_content`, `transformers_js`, `litert_lm` mint `uuidv6()` where their wires supply none; `claude_code_cli` adopts a locally generated MCP `requestId`). `openai_responses` ships a composite-aware `deCollideOpenAIResponsesToolCallIds` that rewrites only the `callId` half of a `` `${call_id}|${itemId}` `` id and preserves a valid `fc_…` item id, because a bare-uuid replacement would drop the reasoning-item replay link. See [The Shared Contract](/batteries/llm/shared-contract).
- **The pre-rendered tool-result cache is now keyed by `ToolCall` instance, not id, in all ten LLM batteries.** Writer and reader iterate the same live primitives, so no id lookup is needed and the collision becomes impossible by construction. Anthropic's `count_tokens.ts` builds its own id-keyed map and is fixed too, or token counts would disagree with what is sent.
- **An optional `replaceToolCallGroupCallback` on the storage contract**, giving a storage adapter a transactional seam for the group repair. Atomicity is a property of the callback, not of the repair: when present the group write is genuinely atomic, and when absent the repair still runs as a sequential delete-then-store that is **not** atomic — a storage failure partway through leaves the store partially replaced, so the repair surfaces the failure and attaches the already-deleted ids for reconciliation. The degraded path is the expected production behaviour, since most adapters will not implement the callback, and it requires a consumer's delete to tolerate the same id arriving once per group member. See [Bring your own storage](/assembly/byo-storage).

### Changed

- **BREAKING: `OrderingGuardResult` gains a REQUIRED `repairFailures` field.** The battery barrel is `export * from './types'`, so the type is public and hand-constructing one now fails to compile. Required is deliberate — every result carries a failure collection, `[]` when nothing failed, so a consumer never has to distinguish an absent channel from an empty one — but it is not additive. A consumer who constructs `OrderingGuardResult` by hand must add `repairFailures: []` (or the serialized failures from a failed repair).
- **BREAKING: the pre-rendered tool-result cache is keyed by `ToolCall` instance, not id.** Anyone overriding `buildChatCompletionsHistory` (or a sibling helper) via the `helpers` option must change their map key type from `string` to `ToolCall`. No compatibility union is retained — deliberately, since a supported id-keyed shape would re-open the exact bug the fix exists to close.
- **BREAKING: `openai_shape_baseline` now carries a BLOCKING rule, reaching 25 of 38 recipes.** The id contract is part of the OpenAI shape, and the rule self-limits once an upstream fixes its counter. On `enforce`, a colliding history newly rejects where it previously dispatched corrupt results — a consumer on `enforce` whose upstream collides will newly nack. On `mutate`, the collision is repaired instead.

### Fixed

- **Nine defects in the orchestration battery, every one found by writing the tests that were specified and never written.** The work packages shipped code with all gates green — type-check, lint, doc-coverage — and 15 of 21 specified test suites missing. Writing them found: `types.ts` declaring five values with `export declare` that the built module never exported, so the shipped `.d.ts` promised `NodeRef`/`branchKey`/`foldRun` and a consumer following it got a hard ESM link error; the **join barrier not existing at all**, so a join settled and fired on every arrival and the node after a two-route diamond ran TWICE while the run reported `completed`; a `transform` that could not find its own source artifact, because the lookup assumed the entry route where an omitted `branchId` means "do not filter"; per-node instead of per-field declassification, so declaring one output field safe laundered every sibling; the structured cell passing a `ReadonlyMap` to a property walk and therefore reading NOTHING, plus a `select` whose loop made every case after the first unreachable; the jexl cell keying its snapshot by a table key its own grammar cannot address, and an unguarded `evalSync` that let a predicate fault halt an approved run; and a store marking a run terminally settled on any outcome, so `resumeRunId` refused exactly the aborted runs it exists to resume. Each fix ships with a spec proven to fail against the restored defect.
- **The Lua predicate cell shipped in no bundle at all.** It was the one orchestration module missing an `@module` tag, and `getEntries` derives the build's entry map by scanning for those tags — so `pnpm build` emitted no `cells/lua.mjs`, and the deep subpath the battery documents as the only way to reach it resolved to nothing. It also fell outside `doc:coverage`, which scans the same map, which is why the gate stayed green while a whole module went unexamined.
- **`foldOps` no longer mutates the caller's ops.** The fold wrote through to the op objects it was handed, so a historical prefix fold returned the LATER value and every past revision was silently corrupted.

- **Two colliding tool calls no longer cross-wire their results.** Previously the second call overwrote the first in the id-keyed cache, so the first call reached the model paired with the second's result — wrong data on the wire, undetectable from the call site. Keying by instance closes it by construction.
- **The isolation battery no longer discards the final chunk of every stream.** The host-side stream sink decoded deltas asynchronously but closed the stream synchronously, so a `stream:end` arriving behind the last `stream:delta` closed the controller while that delta was still awaiting `decodeArgument` — and the enqueue was thrown away against an already-closed controller. Any consumer streaming across a process boundary lost the LAST chunk of every stream; for an LLM token stream, the final token of every response. All three sink callbacks are now chained onto one promise, so a terminal signal cannot overtake a delta that preceded it on the wire. Delta counters still increment synchronously, so the telemetry keeps measuring wire arrival rather than decode completion. This presented as a flaky test for months because CPU contention decides how often the close wins the race; it reproduces deterministically when the spec is run on its own.

## 2026-09-03

### Added

- **Two new LLM batteries that speak a vendor's own wire**, for when you need to reason about what
  the VENDOR received rather than what a translator sent on your behalf — a wire-shape audit, an
  ordering guard, a bug report filed upstream. Both are ordinary {@link DispatchExecutorFn}s and
  wire in one line like every other battery.
  - `@nhtio/adk/batteries/llm/gemini_generate_content` — {@link GeminiGenerateContentAdapter},
    Google's native `:generateContent` over plain `fetch`. `contents[]` with role `model` (never
    `assistant`), no `system` role (top-level `systemInstruction`), heterogeneous `parts[]`, and
    `functionCall`/`functionResponse` parts correlated BY DECLARED TOOL NAME rather than a call id.
    Handles Gemini 3+ thought signatures, and sanitizes tool schemas of the JSON-Schema keywords
    Google's OpenAPI parser rejects. `STASH_KEY` `geminiGenerateContent`.
    See [Gemini generateContent](/batteries/llm/gemini).
  - `@nhtio/adk/batteries/llm/bedrock_converse` — {@link BedrockConverseAdapter}, Bedrock's native
    Converse over plain HTTPS with a bearer `ABSK` key. No AWS SDK and no SigV4 signer, so it stays
    cross-environment. Typed content blocks, tool results on a `user` turn, a selectable
    `alternationPolicy` (`'merge'` | `'filler'` | `'reject'`), and the `toolConfig` backfill that
    makes history replay possible at all. `STASH_KEY` `bedrockConverse`.
    See [AWS Bedrock Converse](/batteries/llm/bedrock-converse).

- **Four ordering rule types derived from measured vendor behaviour**, rather than from
  documentation: `identifierFormat`, `nonEmptyTurn`, `toolIdentity`, and `schemaIntegrity`.
  The last two read the request's declared tools, which surfaced two real causes of the
  "successful response with no content" outcome: a `functionResponse.name` that matches no
  declared tool, and a tool schema requiring a key absent from its own `properties`.

### Fixed

- **`@nhtio/adk/batteries/validation`: `action: 'mutate'` no longer rejects dispatches it is
  supposed to repair.** Three independent defects made the ordering guard a net negative for
  most family recipes — on a nine-seat review panel, six seats died at iteration 0–2 and the
  three survivors were exactly those whose family carried no structural rule
  ([#15](https://gitlab.com/nhtio/adk/-/issues/15)).
  - **`AdjacencyRule` had no repair strategy at all**, so `mutate` and `enforce` were
    behaviourally identical for the 25 of 38 recipes carrying `openai_shape_baseline` — the
    guard could only ever reject. Adjacency violations now repair via `reorder-adjacent`,
    which moves the disallowed successor to just before the primitive it may not follow.
    Every primitive survives; only relative position changes.
  - **Alternation fillers had no lifecycle.** They were stored and never removed, so each
    dispatch re-evaluated the previous dispatch's output and generated fillers *between its
    own fillers*, with ids nesting exponentially (2 → 5 → 9 fillers, duplicate ids, and a
    139-character id by the second iteration) until the guard reported `repaired` **and**
    `unrepaired` for the same pass and nacked anyway. Each pass now reaps the previous pass's
    fillers through `ctx.deleteMessage` and excludes any that remain from the timeline it
    evaluates, giving the repair a fixed point. A filler's content is also now a neutral
    acknowledgement rather than its own `__ordering-guard-filler-…` id, which was being sent
    to the model as a literal turn.
  - **`gemini-3` had no working configuration.** `thought_signature_required` is blocking and
    its only repair sat behind the global `allowMetadataFallbackRepair`, so replayed or
    cross-vendor history could not dispatch under any setting: `enforce` rejected it, `mutate`
    rejected it, and the one flag that worked is documented as a last resort. A rule may now
    authorize its own fallback with `fallbackRepairAuthorized: true`, reserved for values the
    vendor itself publishes — a sentinel is not a forged signature, it is a documented way of
    stating that no signature exists. `thought_signature_required` sets it; every other rule
    still requires the global opt-in, which is unchanged.

### Changed

- **Ordering rules are now advisory by default.** A live audit dispatched every rule in the
  catalog against its own **native** vendor API and found 16 of 17 describe shapes the vendor
  in fact accepts. `severity` is now available on every rule type (previously only
  `requiredMetadata` and `roleRemap`) and defaults to `'advisory'`, so a rule records its
  finding without rejecting a dispatch. `thought_signature_required` is the one rule that
  keeps `severity: 'blocking'` explicitly: Gemini genuinely returns a `400` naming both the
  field and its position, and the same history with a sentinel returns `200`.

  This is a bugfix for behaviour that shipped broken, not a contract change — a guard that
  rejected valid turn state was never the intended behaviour. Recipes that want the old
  gating can set `severity: 'blocking'` per rule.

- **A rule is a claim about a model reached through a specific API, not about the model.**
  Every intermediary normalizes, and a gateway's repair is invisible in the response — AWS's
  Converse API is itself a translator, and an OpenAI-compatible gateway merges same-role turns
  before the vendor ever sees them. Applying a rule on a surface it was not derived from
  guards against a constraint that layer already handles. See
  [API surface scope](/batteries/validation/api-surface-scope).

## 2026-09-02

### Added

- **New `dev_tools` battery** (`@nhtio/adk/batteries/dev-tools`, plus `/forge` and `/conformance`) — a development-editing pipeline built on the media battery's architecture rather than inside it. Media's pipe DSL cannot carry code: `unquote` applies its escape replacements in order, so `C:\\temp` becomes `C:\<TAB>emp`, and `apply_patch` already had to bypass the pipe for the same reason. The battery keeps what transfers — one plan IR, self-declaring engines, capability narrowing, an interceptor onion — over a workspace of files instead of a single payload, so `edit → write → eslint --fix → typecheck` is one plan, one gate per step, one composite result.
  - **Engines are deployment-supplied** and declare `format`/`lint`/`check` capabilities. Selection arbitrates over `(engineId, capabilityIndex)` pairs: `format` takes one capability per extension group, `lint` and `check` run every survivor, and a selection stage may narrow or reorder but never widen or duplicate.
  - **In-place fixers are first-class.** A capability that writes to disk itself receives a scoped `DevFileAccess` façade and triggers an authoritative re-read of its authorization envelope, so `write` sits mid-chain and a later `check` sees the fixed content rather than what the model wrote. Paths dirtied in memory earlier in the same step are withheld from subsequent in-place allowlists — otherwise a fixer reads the stale on-disk copy and its re-read discards the predecessor's edit.
  - **Every step gates once, acquisition included**, since acquisition reads the whole path set before any step runs. Granular forged tools persist within the call and carry `persists: true`, so a mutating tool answers two prompts rather than three.
  - `edit` lowers to `ParsedHunk` and delegates to the existing `applyUpdateHunks`, inheriting its match-uniquely-or-refuse contract; `apply_patch` accepts the structured envelope only and clones before applying, because the shared primitive mutates its argument and throws mid-loop.

- **Dev Tools documentation section** (`docs/batteries/dev-tools/`) — six pages under Featured Batteries: the hub, the workspace and its two baselines, the steps, engines and capability selection, in-place fixers, and the agent tool surface. Plus a showcase page, *Building an agent tool surface in hostile conditions*, covering what the composition costs once nothing about it is glossed: the pipe grammar's ordered `unquote`, the path translator that throws for absent mutation targets, the four-method filesystem contract, and the non-atomic write path.

- **The AI review stage is one job, and there is no bypass.** It was split into a reporting job that always exited 0 and a gate job that re-read the findings artifact; `REVIEW_ENFORCE_GATE` was already the switch, so the split cost a second job and an artifact round-trip to express what an exit code does. The gate never re-ran the panel, so collapsing them adds no LLM spend. The `REVIEW_GATE_BYPASS` escape hatch is deleted: a finding is fixed, or the panel resolves it on re-review after seeing the fix. A gate that can be turned green while findings stand is advisory, and an advisory gate is not one.
- **`CONTRIBUTING.md` documents the build, which was filed under "Typedoc / API Docs" and undersold.** A `@module` tag is not doc metadata the build happens to reuse — it *is* the export declaration: `getEntries` scans every `.ts` under `src/`, the remainder after stripping the package name becomes the entry key, and `bin/package.ts` turns each key into an `exports` entry at publish time. So the committed `package.json` (one export, version `0.0.1`) is not the shipped one, a stray tag silently creates a public subpath, and a duplicate key throws the build. All four consequences are now stated. The import section is rewritten too: the battery barrel rule already existed, but not the fact that three spellings resolve to the same file, one of which (`@nhtio/adk/*`) is a tsconfig alias that reads like a package import and grants nothing. `dev_tools` now imports `guards` through the barrel as the rule requires; `isTextual`/`decodeText` have no barrel and are marked a known deviation rather than quietly left.

### Changed

- **`SANDBOX_EXTENSION_MIME` maps programming-language extensions.** The map had `html`/`json`/`yaml`/`csv`/`md` but no `ts`, `py`, `go`, `rs` or similar, so `stage_file('src/index.ts')` yielded `application/octet-stream` and every MIME-gated text verb refused it. `isTextual` moves to `src/lib/mime/` as one predicate shared by media's verbs and dev-tools acquisition, and now admits `xml`/`+xml` subtypes — so `redact`, `update_text`, `sanitize`, `normalize` and `append` accept SVG as the markup it is. `extract.text` needed a routing change rather than a guard change: SVG was reaching OCR before the textual branch, though `ocr: 'force'` still wins.
- **`SandboxSearch` accepts the arguments its own allow-list already permitted.** `ALLOWED_RIPGREP_FLAGS` listed `--ignore-case`, `--fixed-strings`, `--iglob`, `--hidden` and `--no-ignore`, but no tool argument reached them. Split per method — content search takes the full set, path search only what `rg --files` honours — with `limit` required on both and truncation bounding what reaches the model, not adapter memory. `Done` gains a third arm for the over-limit case rather than widening `bound`, since its existing incomplete arm mandates `maxDepth`. `follow` is **rejected at schema validation** unless the adapter sets the new `supportsFollow` flag, declaring it contains symlinked descendants; the bundled ripgrep adapter has not audited that and does not declare it, and additionally throws if reached directly. The narrowing is `.valid(false)` on a *copy* of the permissive rule, so a BYO adapter that has verified containment still gets the full option — the flag is not disabled package-wide to spare the bundled case a runtime error. **All of it is now documented** — the argument table, `limit`'s post-collection truncation semantics, the `list_directory` protocol-violation rule, and the reason the schema stays permissive while the bundled adapter refuses: a BYO adapter that has verified its own containment may honour `follow`, and one that cannot must reject it itself. The model-facing tool descriptions say so too; they previously advertised `max_depth` as the only boundary, which stopped being true when `limit` became required.
- **`SandboxFileSystem` gains optional `delete`/`rename`/`mkdir`.** The contract declared only `stat`/`list`/`read`/`write`, so persisting a patch's `Delete File` or `Move to` was silently wrong. Optional plus a construction-time probe: a missing operation omits the one capability that declared `needs` for it, never the engine or the pipeline, and the duck-type guard is unchanged so existing four-method adapters keep working. `ConformanceMutations` is a sibling fixture rather than more members of `ConformanceSources`, which is path-free and pre-bound and cannot express a mutation.
- **`runOnion` extracted to `src/lib/middleware/`** and media's step onion migrated onto it. It owns the fresh runner per execution, the capture-and-rethrow idiom, and the did-not-call-`next()` sentinel — which now tracks terminal invocation explicitly, because inferring it from an `undefined` return made every void-core step throw.
- **Patch primitives and `decodeText` move to `src/lib/`.** `parseStructuredPatch`, `applyOperations`, `applyUpdateHunks`, `normalizeWorkspacePath` and friends now live in `src/lib/patch/`, and `decodeText` in `src/lib/text/`, imported by both batteries. Media's public surface is unchanged.

### Fixed

- **`find_files` threw an I/O failure the moment it hit its own `limit`.** The over-limit protocol-violation throw is meant for `list_directory`, which has no `limit` and for which such a frame is impossible; it was also wired into the shared search handler, where it intercepted `find_files` — a tool whose `limit` is required and whose truncation is its ordinary outcome. The correct `result-limited` narration already sat below it, unreachable. The existing test asserted the throw, so it read as coverage while pinning the defect; it now asserts the truncation contract.
- **The ripgrep adapter accepted a nonpositive `limit`.** The contract names the adapter as the enforcement point for "integer >= 1", but nothing enforced it, so `limit: 0` made the first result trip the over-limit branch and returned an empty incomplete result that reads as "no matches". Both methods now reject a nonpositive or fractional limit before spawning, and the contract documents the bound it was relying on.
- **A middleware or step rejecting with `undefined` was silently ignored.** Five capture-and-rethrow sites tested the captured *value* (`if (caught !== undefined) throw caught`), which cannot distinguish a thrown `undefined` — legal JS — from "nothing was thrown". The onion resolved as a success: for `runOnion` the chain fell through to its did-not-call-`next()` diagnostic and blamed the interceptor's contract for what was actually a rejection; for both selection registries the stage's rejection was dropped and arbitration continued as though it had passed. All five now set a flag in the `errorHandler` instead (`runOnion`, the media and dev-tools registries, and both pipelines in the shared tools helper — where the input pipeline additionally skipped its short-circuit check).
- **`applyUpdateHunks` rewrote every line of a CRLF file.** It split on normalized LF and rejoined with `'\n'` unconditionally, so a one-line edit to a CRLF file came back as a whole-file newline-only diff. It now rejoins with the convention its input arrived in. Dev-tools is unaffected either way — its text is LF by the time a hunk sees it, since acquisition normalizes in `decodeText` — but media's structured patch path and any direct caller get a localized edit that stays localized.
- **`decodeText` normalized CRLF only on the UTF-8 path.** The UTF-16 BOM branches returned early, so a BOM-marked UTF-16 file kept its `\r\n` line endings through `chunk`, `extract.text`, `redact`, `update_text`, `diff` and `apply_patch` — and line numbering in diagnostics disagreed with the file. Normalization moved after the encoding branch.

## 2026-09-01 (earlier — v1.20260901.0)

### Added

- **New `openai_responses` LLM battery** — a vanilla adapter for OpenAI's Responses API, distinct from `openai_chat_completions` in wire shape rather than in provider. The Responses API replaces the flat `messages[]` array with a flat `input: Item[]` array, where a tool call and its result are two *sibling top-level items* (`function_call` then `function_call_output`) rather than one message carrying both; the system prompt lives in a top-level `instructions` string by default (`systemPromptChannel` can render it as a leading `developer`/`system` item instead for gateways that only understand the item form). Hand-rolled `fetch` + SSE, no `openai` SDK dependency, matching the sibling batteries.
  - **Native reasoning-item replay** (`reasoningReplay: 'off' | 'encrypted' | 'summary-only'`, default `'off'`; also requires `replayCompatibility: ['openai-responses-reasoning-v1']`, which defaults to an empty list). Guarded by an adjacency-sweep pass over the assembled `input`, because the Responses API enforces an **undocumented** constraint — a `reasoning` item must sit immediately beside its paired output item, in both directions ([`openai/openai-node#1791`](https://github.com/openai/openai-node/issues/1791), reproduced across five official SDKs). OpenAI's own docs state the opposite (that stray reasoning items are silently discarded), so a rejection is treated as *recoverable*: the adapter strips every reasoning item and retries once, degrading to no-replay rather than failing the turn.
  - **Document media** (`Media.kind === 'document'` → `input_file`) with the wire contract confirmed against the live API. Audio and video have no Responses representation and route through `unsupportedMediaPolicy` — unlike `openai_chat_completions`, which supports audio natively.
  - **Deliberately stateless.** `store` is hard-rejected as a settable option (always sent `false`), and `previous_response_id` / `conversation` / `prompt` / `context_management` are refused outright: ADK owns history, and the full `input` array is resent every iteration. `background: true` is rejected at validation time, since the adapter has no polling/resumption path for an async response.
  - Extracted the canonical-JSON + SHA-256 prefix-fingerprinting primitive out of `anthropic_messages`'s private helpers into a shared `canonicalFingerprint()` in `chat_common`, now used by both batteries (a refactor with no behaviour change to the Anthropic path).
- New `tests/unit/build/published_subpath_imports.node.spec.ts` — asserts every `@nhtio/adk/...` subpath the test suite imports actually exists in the published `exports` map, using the same `getEntries` the packaging step uses. Subpaths exist only for `@module`-tagged modules, and several (`batteries/llm/chat_common` and its `helpers`/`types`) are deliberately private; because only the master-only smoke jobs resolve the built package, a bad import previously survived every MR pipeline and broke master. This closes that gap on every MR.

### Fixed

- **`tests/_fixtures/scripted_executor.ts` imported a subpath that is not published**, which took all four smoke checks and 19 functional suites down at import time with `Missing "./batteries/llm/chat_common/helpers" specifier`. The bad import dated to 2026-08-11 and had simply never met a master smoke run.
- **Pinecone integration tests leaked namespaces** until the `adk-vector-test` index hit its 100-namespace serverless cap and every subsequent upsert failed. Two causes: the cleanup list was populated only *after* `connect()`/`createCollection()` succeeded — so a store that failed to initialise (which is what happens once the cap is reached) was never tracked and never reclaimed, making each failing run leak further; and a failed reclaim logged one `console.warn` per store, which scrolls past unread in an otherwise-passing run. Cleanup now registers up front and reports leaks loudly, in aggregate.

### Changed

- The `AI Code Review` CI job now runs with `NODE_OPTIONS=--max-old-space-size=8192`. Node caps its default old-space around 4 GB regardless of host memory, so the `bigmem` runner tag was supplying memory V8 would not use; the job died with `Reached heap limit … JavaScript heap out of memory` (exit 134) after climbing to ~2.5 GB. Peak heap scales with the concurrent reviewer count and the diff size, so a further OOM at 8 GiB means fewer seats in `REVIEW_MODELS`, not a larger ceiling.

## 2026-08-30

### Fixed

- **`adk/require-string-empty-disposition` (repo-internal copy) mis-analyzed two variable shapes**, in ways that could both raise a false positive and silently miss a real one:
  - A straight-line chain split across reassignments lost everything the earlier assignment applied — the accumulated call list was overwritten rather than appended to, so `let s = validator.string().allow(''); s = s.optional()` saw only `.optional()` and reported a schema that was correctly disposed.
  - Tracked events were grouped by variable **name** alone, so a nested block shadowing an identifier joined the outer variable's event list. Since the inner declaration re-roots at `validator.string()` — a disqualifying re-root under the Shape-A grammar — it suppressed a genuine finding on the *outer* schema. Events now key on the declaring binding, with `var` correctly hoisted to its function scope rather than keyed to the block it is written in (`let`/`const` remain per-block).
- **Tool-parameter descriptions across every battery touched by the 2026-08-28 empty-string fix now state what an empty string actually does.** The schemas accepted `""` but their descriptions never said so, and the description string is the only thing a model reads — a schema that silently accepts a value its documentation doesn't mention is a documentation defect, not a cosmetic one. Updated for `scrapper` (`device`/`user_agent`/`extra_http_headers`/`proxy_server`), `datetime_extended` (four `timezone` params plus `reference_date`/`to`), `datetime_math`, `time`, `memory`, `retrievables`, `searxng`, `data_structure`, `formatting`'s `currency`, `string_processing`'s `flags`, `parsing`'s `delimiter`, and `media`'s `redact.replace`.

### Added

- Published-plugin test coverage for the `.empty('')` clearing method, which shares one predicate with `.allow('')` but had never been exercised independently and could therefore regress unnoticed.

## 2026-08-29

### Fixed

- `openai_responses` battery: fixed four issues surfaced by AI code review on the `openai_responses`/empty-string-fixes MR:
  - Timeline media rendering ignored a caller-supplied `renderUntrustedContent`/`renderTrustedContent` override, falling back to the module defaults on nested media blocks instead.
  - Reasoning-item persistence recorded the *preceding* item's id as `pairedItemId` instead of the *following* item's id, undermining the reasoning/output-item adjacency-sweep validation.
  - Streaming SSE frame parsing only split on a bare `\n\n`, silently dropping every event once a gateway/proxy normalised line endings to CRLF.
  - A terminal event (or any other event) arriving as the very last bytes of a stream, with no trailing blank-line separator before EOF, was left sitting unprocessed in the internal buffer and silently dropped — the decoder is now flushed and the final buffered frame is processed once more after EOF.
  - `reasoningReplay: 'summary-only'` returned the stored reasoning item verbatim instead of stripping `content`/`encrypted_content`, leaking full reasoning text the mode promises to omit.

### Changed

- `openai_responses` battery: `background: true` is now rejected at validation time (`E_INVALID_OPENAI_RESPONSES_OPTIONS`) rather than silently accepted and mishandled — the adapter has no polling/resumption logic for a `queued`/`in_progress` background response, so it was previously treating the initial async response as a completed, empty answer and discarding whatever the background job eventually produced. `background: false`/omitted (the default, synchronous request) is unaffected.

## 2026-08-28

### Added

- New `adk/require-string-empty-disposition` ESLint rule, in both the repo-internal plugin (`eslint-rules/`, broader detection covering straight-line/bounded-conditional variable tracking and `ScrapperParamSpec`-shaped object literals) and the published `@nhtio/adk/eslint` plugin (narrower, scoped to a `validator.string()` chain written literally inside a `new Tool`/`new ArtifactTool` `inputSchema`). Flags an `.optional()`/`.default(...)` string schema with no `.allow('')`/`.empty('')`/`.valid(...)`/`.forbidden()` disposition — the exact shape behind the fixes below. `switch`-statement-based schema assembly is permanently out of scope for both copies (see the `media` fix below, found by direct source review instead).

### Fixed

- **`validator.string()` (Joi-based) rejects an empty string `""` on an `.optional()`/`.default(...)` schema, regardless of the modifier — including when `""` is the schema's own configured default.** A model filling in a tool call routinely sends `""` instead of omitting an unwanted optional parameter, which previously failed schema validation outright instead of degrading gracefully. Fixed across every battery the new lint rule (and, for `media`, direct source review) found affected:
  - **`scrapper`** — `device`/`user_agent`/`extra_http_headers`/`proxy_server` now accept `""` and are correctly omitted from the outgoing request (an empty string is never forwarded as a wire query value, including when pinned via `config.fixed`).
  - **`data_structure`**'s `set_operations` — `data_b`/`compare_key` now accept `""`, treated identically to omission.
  - **`memory`/`retrievables`** — `content` (`update_memory`/`update_retrievable`) now treats `""` as "no change, keep the existing value"; `id` (`store_memory`/`store_retrievable`) now treats `""` as "auto-generate"; `source`/`kind` (`store_retrievable`) now normalize `""` to `undefined` on the newly constructed record.
  - **`searxng`** — `categories`/`engines`/`language` now accept `""`, correctly omitted from the search request.
  - **`sandbox`**'s `run_shell_command` — `cwd` now accepts an explicit `""`, resolving to the workspace root exactly like an omitted `cwd`.
  - **`media`** — `granularSchemaFor`'s string-type verb args (19 args across 14 verbs, including `update_text.replace`/`redact.replace`) now accept `""`. This is a real functional fix, not just a validation nicety: `update_text`'s own documented contract ("empty string deletes") was previously unreachable through the granular per-verb tool surface. Note the accepted side effects: `update_text.anchor: ''` now inserts the replacement at position 0 (since `String.prototype.includes('')` is always `true`), and `data.set`/`data.delete` with `path: ''` passes schema validation but still fails cleanly at the handler level (`path must be a non-empty string`).
  - **`datetime_extended`/`datetime_math`/`time`** — timezone-shaped params now accept `""`, resolving to UTC exactly like an omitted value (`time`'s `get_current_time`/`convert_time`, which lacked the other two batteries' existing falsy-check normalization, needed an additional handler-side fix to avoid a worse "Invalid timezone" error after the schema loosened).
  - **`formatting`** — `currency` now accepts `""`, degrading to the same "currency required" error as omission; `locale` deliberately keeps rejecting `""` (not a valid BCP 47 tag) via an explicit lint-rule exception.
  - **`string_processing`**'s `string_extract` — `flags` now accepts `""`, degrading to the same effective `'g'`-flag behavior as omission.

- New `openai_responses` LLM battery: a vanilla adapter for OpenAI's Responses API, wrapping the flat `input: Item[]` wire shape (a tool call and its result are two sibling top-level items — `function_call`/`function_call_output` — not one message containing both) rather than the Chat Completions `messages[]` array. Ships hand-rolled `fetch`+SSE streaming (no `openai` SDK dependency), the same swappable-translation-helper and three-layer-options-merge design as the sibling Chat Completions/Anthropic batteries, native reasoning-item replay (`reasoningReplay: 'off' | 'encrypted' | 'summary-only'`, with a reasoning/output-item adjacency-sweep pass working around an undocumented pairing constraint in the upstream API), and document-media support (`Media.kind === 'document'` → `input_file` with a `data:<mime>;base64,<b64>` payload, confirmed against the real API). The adapter is deliberately stateless: `store` is hard-rejected as a settable option (always sent as `false`), and `previous_response_id`/`conversation`/`prompt`/`context_management` are all rejected outright — the full `input` array is resent every iteration, same as every other battery. No Azure/Codex/Mistral/Gemini/Bedrock variants shipped alongside it; this is the vanilla OpenAI Responses API only.

### Fixed

- Extracted the canonical-JSON-plus-SHA-256 prefix-fingerprinting primitive out of `anthropic_messages`'s private `fingerprint()`/`canonical()` pair into a new exported `canonicalFingerprint()` in `chat_common/helpers.ts`, reused by both the Anthropic battery (refactor only, no behavior change) and the new `openai_responses` battery's reasoning-replay adjacency sweep.

## 2026-08-27

### Added

- New `claude_code_cli` LLM battery: a CLI-harness adapter wrapping the Claude Code CLI binary as a `DispatchExecutorFn` destination. Every dispatch iteration is stateless — the full history renders into one `-p` prompt and spawns a fresh, permission-bypassed `claude --bare` process with its own built-in tools fully disabled (`--tools ""`). Real ADK tools are bridged into the CLI's tool loop over a local MCP server; the bridge itself (not `--allowedTools`) enforces which bridged tools are callable, since `--dangerously-skip-permissions` removes the permission engine an allow-rule would otherwise feed. Supports both `apiKey`/`authToken` auth (mutually exclusive), a capability-probed `maxTurns` for forward compatibility with CLIs that support it, and CLI-native `maxBudgetUsd` safety caps in place of client-side context-window accounting. POSIX-only in v1 (`darwin`/`linux`) — reliable process-group cleanup has no Windows equivalent. This is the first of a new "CLI harness battery" family; the wrapper-process/wire-protocol pattern is documented in `CONTRIBUTING.md` as the template for future Codex CLI / Pi agent batteries.

## 2026-08-26

### Changed

- Retrievable records backed by spooled artifacts now render as handles by default; storage-time auto-spooling covers store/mutate on both context types, fetch results, and DispatchRunner preload normalization, except from-scratch `turnRetrievables.add()` records. Dynamic `Tokenizable` content remains unspooled. Handle-mode budget accounting now applies across all six LLM adapters; the thrift pass excludes unhinted, unmeasurable handle-mode records unconditionally rather than guessing. This may leave orphaned bytes when persistence fails after a successful spool write. Non-core duck-typed thrift callers must set `sizeUnknown` themselves for the same safety guarantee.
- `web_retrieval` converters now accept `ToRetrievableOptions.inline`; links default to `true` so short link text remains inline after auto-spooling. `scrapperLinksToRetrievables` now accepts `recommend` and genuinely supports its declared `spool` hook, in parity with the other converters.

## 2026-08-24

### Fixed

- **`orderingGuardDispatchMiddleware` in `action: 'mutate'` mode killed the turn on its third
  dispatch iteration, even with zero ordering rules in play.** `runGuard` unconditionally stashed
  the live, in-flight timeline (real `Message`/`Thought`/`ToolCall` instances, `.value` untouched)
  under `EFFECTIVE_TIMELINE` on every pass. `ctx.stash` (a `Registry`) klona-clones its *entire*
  backing store on every `.get()`, regardless of which key is requested — and klona's
  generic-object clone strategy calls `new x.constructor()` with zero arguments before copying
  properties. `Message`/`Thought`/`ToolCall` (and `Thought`'s nested `Identity`) all throw on
  zero-arg construction, so the very next unrelated stash read (the guard's own `SNAPSHOT` read on
  the following iteration) walked the whole store, hit the poisoned entry, and crashed the
  dispatch. Fixed by projecting each stashed entry's `.value` onto a bare plain object carrying
  only the fields any consumer of the stashed timeline actually reads (`id`, `payload`,
  `replayCompatibility`) instead of the live class instance or its `[ENCODE_METHOD]()` snapshot —
  the latter was tried first and found insufficient, since it still nests other live class
  instances (`Identity`, Luxon `DateTime`) that klona chokes on one level deeper. Closes #13.

## 2026-08-23

### Added

- **New opt-in battery `@nhtio/adk/batteries/validation` — the `ordering_guard` turn-state
  validation battery.** Every existing LLM adapter assembles wire history by sorting
  `Message`/`Thought`/`ToolCall` primitives purely by `createdAt`, with no enforcement that a
  vendor's own ordering rules (Anthropic thinking-before-tool-use, Gemini's mandatory
  `thoughtSignature` on the first function call, Nova/Gemma/DeepSeek strict role alternation, Kimi/
  MiniMax/Qwen history-retention invariants, and more) are actually satisfied before dispatch. This
  battery closes that gap: seven typed `OrderingRule` variants (`OrderRule`, `RequiredMetadataRule`,
  `AlternationRule`, `AdjacencyRule`, `PreservationRule`, `RoleRemapRule`,
  `StaleContentAdvisoryRule`) compose into 16 atomic behavior profiles and 38 pre-built family
  recipes spanning Anthropic, Gemini, Nova, Bedrock Converse, DeepSeek, Qwen, GLM, Kimi, MiniMax,
  Mistral, Llama, Nemotron, Gemma, GPT-OSS, Cohere, Phi, Granite, Grok, and a few explicitly-flagged
  unconfirmed baselines.

  Two operating modes via `action`: `'enforce'` (strict, zero-mutation validation — rejects any
  violation) and `'mutate'` (best-effort automated repair — reorders primitives, inserts
  alternation fillers, and optionally fills missing vendor metadata). Any repair that could
  fabricate provenance-sensitive metadata (e.g. Gemini's `thoughtSignature` sentinel bypass) is
  gated behind an explicit double opt-in (`allowMetadataFallbackRepair: true`, on top of
  `action: 'mutate'`) so a caller never gets silent metadata fabrication as a side effect of
  turning mutate mode on.

  `orderingGuardDispatchMiddleware` and `orderingGuardTurnMiddleware` wire into existing
  `dispatchInputPipeline`/`turnInputPipeline` arrays. `ToolCall` gains an optional
  `payload`/`replayCompatibility` pair (mirroring `Thought`'s existing pattern) to carry
  vendor-opaque metadata like Gemini's thought signature.

  See the [Ordering Guard & Validation Battery](https://claude-adk.nhtio.co/batteries/validation/)
  documentation for the full atomic-behavior catalog, the family-recipe lookup table, and the
  repair-strategy reference.

### Fixed

- **`mutateMessage`/`mutateThought`/`mutateToolCall`/`mutateRetrievable`/`mutateMemory` silently
  duplicated the primitive instead of replacing it, in both `DispatchContext` and the parent-flush
  path `DispatchRunner` uses when a nested dispatch runs against a `TurnContext`.** `Set.add()`
  compares by reference, not by a primitive's `id` — a "mutated" instance is always a *new* object,
  so every one of these five `#doMutate*` methods on `DispatchContext` called `Set.add(newInstance)`
  without first removing the stale instance sharing that `id`. The stale and fresh copies then
  coexisted in `turnMessages`/`turnThoughts`/`turnToolCalls`/`turnRetrievables`/`turnMemories`
  forever, and any adapter reading those Sets to build a wire payload saw both. The identical bug
  existed independently in `DispatchRunner`'s `#applyDeltaToParent` — the mechanism that flushes a
  nested dispatch's mutation back onto its parent `TurnContext` at the end of each iteration — so a
  mutation correctly deduplicated on a child `DispatchContext` still re-duplicated the moment it
  reached the parent.

  Surfaced while building the `ordering_guard` battery's `mutate`-mode repair path, which calls
  these methods directly and was the first code in this ADK to actually exercise them at scale.
  Confirmed via a full audit that this was a genuine oversight rather than a design choice: the
  sibling `#doDelete*` methods, written in the very same initial commit, already contained the
  correct find-by-id-then-remove pattern, and no test anywhere exercised `mutate*`'s effect on Set
  contents before now.

  Fixed at both layers: `DispatchContext`'s five `#doMutate*` methods now remove *every* stale
  same-id instance (not just the first — a state the bug itself could produce) before inserting the
  replacement, preserving the replaced primitive's original insertion-order position rather than
  relocating it to the end (several adapters, and this battery's own timeline builder, use Set
  iteration order as the deterministic tie-break for primitives sharing an identical `createdAt`).
  `DispatchRunner` gained an equivalent in-place `Set` rebuild for its own parent-flush path.

- **The `ordering_guard` battery's `mutate`-mode reorder repair now genuinely reaches the live turn
  state.** It previously only reordered a private in-memory copy of the timeline and recorded a
  `__orderingGuardSeqOverride` stash hint no adapter ever consumed — the guard reported the repair
  as "applied" and let dispatch proceed, but the real `turnMessages`/`turnThoughts`/`turnToolCalls`
  Sets (and therefore the wire payload an adapter would build) were untouched. Now shifts the
  offending primitive's `createdAt` via the real `ctx.mutateMessage`/`mutateThought`/`mutateToolCall`
  call, which is what the `DispatchContext`/`DispatchRunner` fix above made trustworthy. The
  now-superseded stash mechanism and its `ORDERING_GUARD_SEQ_OVERRIDE_STASH_KEY` export were removed.

## 2026-08-22

### Added

- **The OpenAI Chat Completions battery now reports generation stats.** `finish_reason` and
  `usage` were already typed on this adapter's own response types, but nothing ever read them —
  `helpers.reportGenerationStats` was never called on either the streaming or non-streaming path,
  making the adapter behaviorally inconsistent with its `ollama` and `anthropic_messages` siblings.

  Non-streaming: `reportGenerationStats` now fires once per dispatch, reading `finish_reason` and
  `usage.{prompt,completion,total}_tokens` off the response body.

  Streaming: the adapter now defaults `stream_options: { include_usage: true }` into the request
  body when streaming (left untouched if the consumer already set one) — OpenAI only sends `usage`
  on the final SSE chunk, and only when this option is set. `finish_reason` and `usage` are read
  independently off the stream rather than off "the last chunk", because OpenAI splits them across
  two different chunks: `finish_reason` arrives on the last content-bearing chunk, while `usage`
  arrives on a SEPARATE final chunk with an EMPTY `choices` array.

## 2026-08-21

### Fixed

- **An empty tool-call name from the model crashed the turn, in all six LLM battery adapters.**
  Every adapter's "unknown tool name" and "malformed tool-call args" fallback branches — the code
  that exists specifically to survive a bad `call.name` from the model — built their error-carrying
  `ToolCall` from the raw `call.name` unguarded. `ToolCall.tool` is validated by a bare
  `validator.string().required()`, which rejects the empty string (not just `undefined`/`null`), so
  the one input those branches exist to handle gracefully crashed them instead with
  `E_INVALID_INITIAL_TOOL_CALL_VALUE`, surfaced to a consumer logging only `err.message` as the
  generic `The LLM execution executor callback threw an error.` — no indication the cause was an
  unnamed tool call, and no path back to the model to self-correct.

  Observed in production: a model emitted a tool call with `name: ""` mid-run in a multi-vendor
  review panel, permanently killing that one seat for the rest of the job with no retry.

  Added `normalizeToolName` (`chat_common/helpers`), substituting a `'(unnamed tool call)'`
  placeholder for an empty name at every such construction site, in `anthropic_messages`,
  `litert_lm`, `ollama`, `openai_chat_completions`, `transformers_js`, and
  `webllm_chat_completions`. The malformed-args branch runs before the unknown-tool-name check and
  has the identical unguarded pattern, so both are fixed identically — a model degenerating enough
  to emit an empty name is just as likely to also emit garbage args.

## 2026-08-16

### Fixed

- **The Qdrant vector-store battery was unusable from a published-package install (three
  independent defects).** None of the three reproduced from ADK's own `src/`, because the test
  suite aliases `@nhtio/adk` straight to source — only a real `pnpm install` of the built package
  hit them.

  1. `uuidFromId` called `require('js-sha256')` directly. The published build (rolldown) rewrites
     bare `require` calls into a runtime shim that throws in real Node ESM (`"type": "module"`, no
     `require` global) — so every `upsert()` failed with
     `E_VECTOR_STORE_DRIVER_UNAVAILABLE: js-sha256`. Now imports `sha256` statically, matching the
     `weaviate` battery's existing pattern.
  2. Search called `client.search(...)`, which `@qdrant/js-client-rest` removed in `1.19.0` —
     a version the package's own `^1.18.0` range permits resolving to. Switched to `client.query(...)`
     with a `{ nearest: vector }` query, which exists at both `1.18.0` and `1.19.0`.
  3. `close()` called `this.#client.close()`, a method `QdrantClient` has never had at either
     client version — so every `close()` call threw. It now just drops the client reference, matching
     the other REST-only vector batteries (`pinecone`, `typesense`, `meilisearch`).

  Verified against a live `qdrant/qdrant` container, driving the built `dist` bundle from outside
  the repo (not vitest's source aliasing), at both `@qdrant/js-client-rest@1.18.0` and `1.19.0`.

## 2026-08-14

### Changed

- **BREAKING (sandbox battery): a sandboxed child no longer inherits the host environment.** It gets
  `PATH` and nothing else — not `HOME`, not `USER`, not `TMPDIR`, and none of your credentials.

  Before this, `srtEnforcer` spawned every child with the full `process.env`, and the tool factory had
  no way to change that. Since `run_shell_command` exists to run commands the **model** chose, and `env`
  is one of them, every secret in the host process was one tool call from the model's own context — and
  no filesystem or network policy prevents that, because the value arrives in the tool result rather
  than over the wire.

  Two new `srtEnforcer` options control it: `envAllowList` (default `['PATH']`) names what a child may
  inherit, and **replaces** that default rather than extending it — pass `['PATH', 'CARGO_HOME']`, not
  `['CARGO_HOME']`, or binaries stop resolving. `inheritHostEnv: true` restores the old behaviour in one
  line, and hands the model every secret in the process; prefer naming what you need.
  `createRunShellCommandTool` also gains an `env` option for explicit per-call variables, applied last.

  SRT's own proxy, CA and git plumbing is injected separately and always survives, so the network
  boundary is unaffected. Most deployments need no change: `PATH` is what ordinary commands and the
  ripgrep searcher actually depend on.

### Added

- **`enableWeakerNestedSandbox` on `srtEnforcer`**, for running the sandbox inside an unprivileged
  container — a containerised CI job being the common case. Bubblewrap cannot mount a fresh `/proc`
  there, so every sandboxed command failed with `apply-seccomp: write /proc/self/uid_map: Operation not
  permitted` and **no diagnostics** — exit 1, empty stdout, indistinguishable from a policy denial.
  There was previously no way to express the option at all.

  It lands on the enforcer's options rather than on `SandboxPolicy`, which is deliberately SRT-neutral
  vocabulary. Upstream's caveat applies and is worth repeating: the bind-mounted `/proc` exposes process
  information a fresh mount would hide, so enable it only when the **outer** container already provides
  the isolation you need.

- **A CI job that runs the Linux sandbox suite**, in docker-in-docker so it executes in an unprivileged
  container. Until now no job ran bubblewrap at all: the live suites skip themselves into a passing
  report, which is how the missing environment control above shipped unnoticed.

  Its first runs established a limit worth stating rather than discovering later: **this runner's dind
  daemon forbids unprivileged user namespaces outright**, so bubblewrap fails before the `/proc`
  question arises — an earlier failure than the one issue #5 reports. `enableWeakerNestedSandbox`
  therefore cannot be validated in CI; confirming it fixes a real container needs a kernel that permits
  capability-bearing unprivileged user namespaces. The job is non-blocking and reports what it observed.

## 2026-08-12

### Added

- **Sandbox batteries — an OS boundary and a JavaScript boundary, deliberately distinct**
  (`@nhtio/adk/batteries/sandbox`, `.../sandbox/tools`, `.../sandbox/node`, `.../sandbox/js`). The ADK
  shipped 23 tool categories and could not run `ls`; that gap was deliberate, because an ungated shell
  is the most dangerous thing you can hand a model. Two boundaries answer two different questions —
  *what can this **process** reach?* (Anthropic's `@anthropic-ai/sandbox-runtime`: Seatbelt /
  bubblewrap+seccomp / WFP, no container) and *what can this **code** reach?* (a hardened `ses`
  `Compartment`). Both are optional peers; neither substitutes for the other.

  Nine tools, every one gated: `run_shell_command` (the streaming shell — and the git tool),
  `open_file`/`open_json_file`/`open_markdown_file` (query, returning a spooled artifact),
  `stage_file`/`save_media` (mutate, then make it real on disk), `list_directory`,
  `search_files`/`find_files`, plus `evaluate_javascript` on the SES side. `sandboxedExecutor` adapts
  the existing `BinaryExecutor` for media pipelines.

  **Gates are mandatory on every tool, reads included, and no reference gate ships.** The threat model
  for a read is exfiltration — a read of `.env` is unrecoverable, and `search_files` is a
  secret-discovery primitive — so a shipped default would be adopted unread as "the safe config". A
  gate is a real suspension: a harness with no decider hangs the turn.

  **Failures throw a narrated `E_SANDBOX_*` rather than returning a string, deliberately against house
  style.** A returned string is spooled and renders as an artifact *handle*, so the model would spend a
  call querying an artifact to read one line of refusal. What the model actually reads is
  `The tool handler threw an error during execution. <narration>` — that prefix is core behaviour, so
  the narrated exception must be the direct cause. Outcomes that *did* run return their artifact
  instead: a non-zero exit is a final line, a timeout returns the partial output, and a sandbox
  violation is woven in where it was observed.

  **Read the docs before deploying.** `docs/batteries/sandbox/` states the residuals where you meet
  them: TOCTOU on the in-process paths, the four (not one) platform case-matching rules, the fact that
  only the shell and search paths get OS enforcement, and that a green CI run is **no evidence** the OS
  boundary works — the suites that prove it skip silently without `TEST_SANDBOX_LIVE`. Browser
  deployments **require** CSP: CORS gates response readability, not request emission.

  Measured and disclosed rather than assumed: on macOS with SRT 0.0.71, `diagnosticsFor()` returns `[]`
  for both a denied read and a blocked host while enforcement itself works correctly — so the
  structured violation this battery's value-add rests on is not populated on that platform today.

  A command that cannot be spawned at all — a missing wrapper binary, an unusable `cwd` — settles as a
  failed command rather than taking the host process down with it. An unhandled `'error'` on a
  `ChildProcess` is an uncaught exception, so a sandbox misconfiguration would otherwise have killed the
  agent instead of failing one tool call.

### Changed

- **`ToolHandler` may now return a `SpooledArtifact`** (core). Previously the return union was
  `string | Uint8Array | Media | Media[]`, so a handler that streamed a large file into storage and
  held a reader had no way to return it — and an artifact returned anyway fell into a defensive branch
  and was spooled as **`"[object Object]"` with no error**. That silent corruption is gone. Additive:
  no existing handler can return an artifact today, so nothing observable changes for current code.

- **The Anthropic Messages battery now honours `ToolCall.inline`.** `inline` is core vocabulary
  defaulting to `false`, and the other five LLM batteries render a spooled result as a handle
  accordingly; this adapter ignored the flag and inlined the entire artifact. A 5 MB log was a handle
  on five backends and 5 MB of prompt on the sixth. **This is a behavioural change for Anthropic
  deployments**: results that previously arrived inline now arrive as artifact handles. Set
  `inline: true` on the producing call to keep the old behaviour. The `SpooledArtifact[]` array path
  still inlines on every adapter — a wider, separate defect, recorded rather than silently folded in.

## 2026-08-02

### Added

- **`resolveErrorStatus` on the Anthropic Messages battery — a seam for recovering an HTTP status the
  SDK never saw** (`@nhtio/adk/batteries/llm/anthropic_messages`). Unlike the Ollama and OpenAI
  batteries, which read `response.status` off a raw `fetch` and therefore always observe the real
  code, this battery classifies from the SDK's `APIError`. When a gateway terminates the HTTP request
  itself and reports the upstream failure *inside the response body*, `err.status` is absent, coerces
  to `0`, matches nothing in `retry.retriableStatuses`, and the error is classified **fatal** — so a
  transient upstream `529 overloaded_error` failed on first occurrence with `retry.maxAttempts` never
  consulted. The symptom is a distinctive `Anthropic Messages HTTP error 0: 529 {...}`, where the `0`
  is the coercion and the real status sits in the body.

  The new optional {@link AnthropicMessagesAdapterOptions.resolveErrorStatus} hook receives
  `{ error, bodyText, sdkStatus }` and returns a status to classify against, or `undefined` to
  decline. The resolved status is what reaches `retriableStatuses`, the
  `E_ANTHROPIC_MESSAGES_HTTP_ERROR` payload, and the log line — so a recovered `529` is reported as
  `529`, not `0`. It runs before both the context-overflow body-text check and retriable
  classification. A resolver that throws, returns a non-integer, or returns a value outside 100–599
  is ignored with a warning and treated as declining, so a misbehaving hook can never replace the
  real upstream error with one from the diagnostic path.

  **The ADK deliberately ships no default parser and no behaviour change.** A gateway's error
  envelope is the consumer's knowledge, not the ADK's; a built-in regex would risk reading a
  three-digit request id — or a genuine deterministic `4xx` — as a retriable status. Without a
  resolver, classification is byte-for-byte what it was before this release, including a statusless
  `APIError` remaining fatal. Consumers behind such a gateway opt in explicitly.

### Fixed

- **`countTokens()` shared the same statusless-`APIError` misclassification.** The token-count path
  carried a byte-identical private copy of the error classifier, so the defect above existed there
  too and was not covered by the original report. Both paths now share one
  `translateAnthropicError` (exported, along with `CONTEXT_OVERFLOW_PHRASE` and the
  `AnthropicErrorClassification` type), which is why a single fix now reaches both instead of
  silently leaving one wrong.

## 2026-07-29

### Fixed

- **An empty thinking block no longer kills the turn** (`@nhtio/adk/batteries/llm/anthropic_messages`,
  {@link Thought}). When Anthropic returned a thinking block whose text was empty, the adapter built a
  {@link Thought} with `content: ''` — and `Thought`'s schema rejected the empty string, throwing out of
  the dispatch executor callback and aborting the whole agent turn. The failure was entirely
  client-side: the API call succeeded and the crash happened while persisting the response, so there
  was no HTTP error and no 4xx to point at. Any consumer with thinking enabled could lose a turn
  non-deterministically, depending only on whether the model happened to emit an empty thinking block;
  a response whose only thinking block was `redacted_thinking` (which by definition carries no
  plaintext) failed every time.

  {@link Thought} now validates `content` and `payload` as an **either-or**: a thought must carry
  meaning through its prose *or* through an opaque replay payload.
  - `payload` **absent** (plain-text mode) — `content` stays REQUIRED and non-empty, exactly as before.
    The prose is the only thing the thought has, so an empty one is indistinguishable from a bug.
  - `payload` **present** (opaque mode) — `content` may now be empty or omitted. This is what the
    opaque-mode contract already promised: the payload is what round-trips to the wire, and `content`
    is kept only for token-accounting and human/observer inspection. A signed-but-textless thinking
    block still carries a replayable `signature`, so discarding the thought to dodge validation would
    have silently broken signed-thinking replay — strictly worse than storing a thought with no prose.

  `Thought.content` remains a `Tokenizable` in every case and is never `undefined` (absent input
  resolves to an empty `Tokenizable`), so no reader needs a presence guard and no existing consumer
  changes. `RawThought.content` is now optional at the type level, which affects only code that *reads*
  a `RawThought` and assumes presence; constructing one is unchanged. New
  {@link Tokenizable.emptyableSchema} backs the emptyable field — {@link Tokenizable.schema} stays
  strict, so an empty `systemPrompt`, standing instruction, `Identity.representation`, or
  `Memory.content` is still a validation error.

- **`E_LLM_EXECUTION_EXECUTOR_ERROR` now names the underlying failure in its own `message`.** The cause
  chain was already preserved, but the wrapper's text was the static `The LLM execution executor
  callback threw an error.` — so a consumer logging `err.message` (the common case) got no signal at
  all, not even the category of failure: a client-side validation error read identically to a transport
  failure, an engine abort, or a bug in the executor. The cause's message is now appended after the
  static text, which is retained as the prefix so existing log greps and string matches keep working.
  Nothing is appended when the cause adds nothing, so unchanged cases stay byte-for-byte identical, and
  `.cause` is untouched.

## 2026-07-18

### Added

- **New opt-in LLM battery `@nhtio/adk/batteries/llm/anthropic_messages` — Anthropic's first-party Messages API.** Ships {@link AnthropicMessagesAdapter}, a complete {@link DispatchExecutorFn} for Claude/Anthropic-shaped Messages endpoints with prompt caching, signed thinking replay (`anthropic-messages-thinking-v1`), native `refusal` stop handling with `stop_details`, image + base64-PDF input, token counting via `countTokens(input, overrides?)`, ADK-owned retry/timeout behavior, and the battery-scoped `E_ANTHROPIC_MESSAGES_*` exception family. `model` and `maxTokens` are required. The adapter is node-first; `dangerouslyAllowBrowser` is exposed but a gateway/server is the supported browser pattern so first-party Anthropic keys are not shipped to users. The battery warns but does not repair request-shape hazards such as invalid tool-use IDs, unsupported `output_config.format` schema keywords, deprecated sampling params, or incompatible model/param combinations.
  - **`@anthropic-ai/sdk` is an optional peer dependency** — it is not bundled into `@nhtio/adk`. Install it yourself (`pnpm add @anthropic-ai/sdk`) when you want this battery; importing either the Anthropic subpath or the aggregate LLM barrel without the peer produces the normal module-not-found for the missing SDK.

- **New generation engine: `local_diffusion` — a BYO-inference-subprocess image-generation engine over a stdio line protocol.** The Node-only {@link LocalDiffusionGenerationAdapter} (`@nhtio/adk/batteries/generation/local_diffusion`, subpath-only — excluded from the environment-neutral generation aggregate) drives a user-supplied inference subprocess over a stdin/stdout line protocol (modeled on DiffusionBee), so a consumer can run a local Stable-Diffusion checkpoint without the ADK bundling Python/torch. Same `generate`/`edit` → `Promise<GeneratedMediaOutput[]>` contract as the other generation engines, plus streamed per-step progress (`dnpr` → the `generating` lifecycle phase), best-effort cancellation (`AbortSignal` → advisory `__stop__`, with `reset()`/`dispose()` as the hard stop), single-flight admission, `outputDir`-contained cleanup of backend-written files, and both inline-base64 and file-path image results. Ships the protocol + a documented Python reference backend; the consumer supplies the process.

## 2026-07-13

### Added

- **New battery domain: `tts` — text-to-speech synthesis generating audio from text.** Two new engines under the shared contract `synthesize(text, opts?) → Promise<GeneratedMediaOutput>`: a model-backed {@link TransformersJsTtsAdapter} (`@nhtio/adk/batteries/tts/transformers_js`, MMS-VITS / SpeechT5 via `@huggingface/transformers`), and a zero-config, node-only {@link NativeTtsAdapter} (`@nhtio/adk/batteries/tts/native`) that shells out to macOS `say`, Linux `espeak-ng`, or Windows PowerShell.
- **New embeddings battery: Ollama.** A fourth engine ships under the shared embeddings shape, targeting Ollama's native `/api/embed` endpoint. The new {@link OllamaEmbeddingsAdapter} (`@nhtio/adk/batteries/embeddings/ollama`) supports `baseURL`, `truncate`, `keepAlive`, and runtime `options`, with zero environment constraints (runs in Node, browser, edge).

## 2026-07-12

### Added

- **New battery domain: `specialists` — on-device speech-to-text, OCR, and image captioning, each a
  narrow single-purpose model turning one modality into TEXT for any text-only LLM.** Three adapters:
  {@link TransformersJsSttAdapter} (`@nhtio/adk/batteries/specialists/stt/transformers_js`, Whisper-family
  ASR via `@huggingface/transformers`, `transcribe(input, opts?) → { text, segments? }`),
  {@link TesseractJsOcrAdapter} (`@nhtio/adk/batteries/specialists/ocr/tesseract_js`, pure-WASM
  `tesseract.js`, `recognize(input, opts?) → { text, confidence? }`), and
  {@link TransformersJsCaptionAdapter} (`@nhtio/adk/batteries/specialists/caption/transformers_js`,
  transformers.js's `image-to-text` pipeline, `describe(input, opts?) → { text }`). All three mirror the
  embeddings adapters' construct-once/`preload`/`reset`/`dispose` shape and are ENVIRONMENT-NEUTRAL —
  `isAvailable()` is always `true`, no WebGPU or platform gate — proven against real weights in both Node
  and a headed, real-GPU Chromium session
  (`tests/functional/batteries/specialists/specialists.webgpu.spec.ts`).
  - **Zero-core-import at the structural-contract layer**, the same posture as the `thrift`/`compact`
    context batteries: `SpecialistMediaLike`/`SpecialistAudioInput`/`SpecialistImageInput`
    (`src/batteries/specialists/_shared`) are locally-declared duck types a real `@nhtio/adk` `Media`
    satisfies without either side importing the other. STT resamples any input — pre-decoded PCM at any
    sample rate, or an encoded container via an injectable `DecodeAudioFn` (default: lazy `audio-decode`
    peer + downmix-to-mono) — to 16kHz mono before the pipeline call; the linear-interpolation resampler
    and the mono-downmix helper were lifted into a shared `lib/utils/audio` module rather than duplicated
    per adapter.
  - **OCR's cached-worker posture is a deliberate divergence from the media battery's own `tesseract_js`
    engine**: one `TesseractJsOcrAdapter` holds a single warm worker across every `recognize()` call
    (construct-once, single-flight resolution) instead of booting a fresh worker per call. tesseract.js v7
    has no safe way to re-language an already-booted worker, so a per-call `languages` override that
    doesn't match the constructor's set throws `E_TESSERACT_JS_OCR_ENGINE_ERROR` rather than silently
    switching; `reset()` and `dispose()` are aliases here (both terminate the worker — no lighter tier
    exists for a live WASM worker).
  - **Composition, proven**: `tests/functional/batteries/specialists/specialist_compose.node.spec.ts`
    feeds Whisper's transcript of `speech.wav` ("The quick brown fox jumps over the lazy dog.") and
    Tesseract's OCR of `sample_ocr.png` ("HELLO OCR\n123") to a separate text-only Llama-3.2-1B, which
    grounds its answer ("Fox") on that text alone — the pattern this domain exists to enable, not just
    each specialist's own accuracy.
  - **Deliberately no agent integration and no cloud engines.** Same posture as the embeddings batteries:
    the adapter is the whole product — no `Tool` class, no forged tool, no `TurnRunnerConfig` wiring. And
    unlike the LLM/vector batteries (which abstract a real, converged wire contract), the cloud
    STT/OCR/vision landscape has no such convergence — every vendor's API has its own auth model, request
    shape, and SDK, with nothing worth abstracting — so this domain draws the line at on-device only, on
    all three adapters, full stop. New docs section `docs/batteries/specialists/` (overview + one
    reference page per adapter) covers the thesis and the three ways a consumer actually wires one in: a
    BYO `Tool` over the adapter (byo-tools pattern), a direct call outside the tool-call loop, or a
    courtesy write to `Media.stash` that an LLM battery's `fallback-stash` `UnsupportedMediaPolicy` reads
    automatically.
- **New battery domain: `isolation` — a transport-agnostic protocol substrate for running heavy or
  untrusted work off the main thread (Web Worker) or out of process (node `child_process`), instead of
  hand-rolling the spawn/request-response/crash-recovery plumbing per callsite.** Declare a service once
  with {@link defineIsolatedService} (`methods`/`streams`/`events`), implement it guest-side via
  {@link serveIsolated}/{@link serveIsolatedOverPort}, and drive it host-side via
  {@link createIsolatedService} — over a real browser Web Worker ({@link spawnIsolated}/
  {@link createWorkerTransport}, `@nhtio/adk/batteries/isolation`) or a real node `child_process`
  ({@link forkIsolated}/{@link createChildProcessTransport}, the node-only deep import
  `@nhtio/adk/batteries/isolation/child_process` — not re-exported from the main barrel or the batteries
  aggregate because it imports `node:child_process` directly).
  - **`child_process` over `worker_threads`, deliberately**: threads share the host's address space, so a
    native-addon segfault or V8 fatal error inside one can take the whole host process down with it; a
    real OS child process only kills itself, surfacing to the host as an ordinary `'exit'`/`'error'`
    event. `forkIsolated` pins `serialization: 'advanced'` by default so the tiered codec's opaque
    containers (`TypedArray`/`ArrayBuffer`/`DataView`/`Date`/`RegExp`/`Map`/`Set`) round-trip faithfully
    rather than silently degrading under node's default JSON-style IPC serialization.
  - **Crash containment and recovery**: a transport-reported crash rejects in-flight calls/streams with
    `E_ISOLATED_CRASHED`, flips `state` to `'crashed'`, and fans out to `.onCrash(...)` subscribers;
    recover via manual `.recycle()` or `autoRespawn: { policy }`, a sliding-window {@link createCrashPolicy}
    generalizing the flagship agent's hand-rolled `GpuLossPolicy` into a domain-neutral decider either
    transport's crash can consult.
  - **This exact pattern was hand-rolled three separate times in this repo before the battery shipped**:
    the flagship's 582-line LiteRT-LM worker pair, the media battery's `BinaryExecutor` seam, and the
    specialists' `createPipeline` factory seams — the battery generalizes all three into one spec-first
    substrate. Proven by refit, not by assertion: a `CreateLiteRtLmEngine`-typed factory over
    `forkIsolated` drives a LiteRT-shaped guest end-to-end
    (`tests/functional/batteries/isolation/litert_refit.node.spec.ts`, plus a Web Worker variant), and
    the REAL, unmodified {@link TransformersJsEmbeddingsAdapter} runs its feature-extraction pipeline
    out-of-process through its public `createPipeline` injection seam
    (`tests/functional/batteries/isolation/embeddings_pipeline.node.spec.ts`).
  - **`isolateFunction`** is a separate Blob-URL escape hatch for running an in-memory function value in a
    throwaway Worker without writing a guest file — an explicit, opt-in, `eval`-equivalent trust surface
    gated behind the literal `{ allowSourceRehydration: true }` acknowledgement, both at the type level and
    at runtime.
  - New docs section `docs/batteries/isolation/` (hub, browser, node, recipes) covers the thesis, both
    transports' full option surfaces, and four end-to-end recipes: the LiteRT-LM worker pair refit,
    isolated embeddings over a real adapter unchanged, custom classes crossing the wire via
    `@nhtio/encoder`'s custom-encodable protocol, and wiring an observability dashboard.
- **New battery domain: `generation` — text-to-image generation and image editing, three engines behind one
  shared contract, for agents that PRODUCE media instead of just consuming it.** Every engine exposes the
  same `generate(prompt, opts?)` / `edit(inputs, prompt, opts?)` → `Promise<GeneratedMediaOutput[]>`
  contract over the same `BaseGenerationAdapterOptions{ model: string }` base (required, no default,
  mirroring the embeddings batteries): {@link OpenAIGenerationAdapter}
  (`@nhtio/adk/batteries/generation/openai`, raw `fetch` against `/v1/images/generations` +
  `/v1/images/edits`, multipart edits, `responseFormatMode` tri-state for the `dall-e`/`gpt-image` split),
  {@link GeminiGenerationAdapter} (`@nhtio/adk/batteries/generation/gemini`, raw `fetch` against the native
  `generateContent` REST surface, probe-confirmed image-parts-first/text-last part ordering for `edit()`,
  refusals surfaced as a thrown malformed-response error with the refusal text embedded), and
  {@link TransformersJsGenerationAdapter} (`@nhtio/adk/batteries/generation/transformers_js`, EXPERIMENTAL
  on-device text→image via DeepSeek Janus's `MultiModalityCausalLM.generate_images()` — the only
  image-generation surface transformers.js exposes, no `pipeline('text-to-image')` task exists — real
  knobs cross-verified against the installed package's own sampler/config source).
  - **`edit()` support is not uniform across engines**: OpenAI and Gemini both support it (multipart form
    data vs. inline base64 image parts, respectively); the transformers.js engine always throws
    `E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION(['edit', reason])` — Janus is text-conditioned
    generation only, with no image-conditioned edit/inpaint entry point in the installed API.
  - **Live-verified through the same LB gateway topology the other cloud batteries use**: both engines'
    `.cross.spec.ts` specs route through the repo's own polyglot LB rather than each vendor's API directly,
    authenticating via a gateway-style `Authorization: Bearer` header instead of each adapter's own native
    scheme (`x-goog-api-key` for Gemini, its own `Authorization: Bearer` for OpenAI). The OpenAI-shaped
    live spec only exercises `generate()` — probing the gateway's `/v1/images/edits` route returned a 404
    (the gateway does not implement OpenAI-shaped image edits, only generations) — while the Gemini live
    spec proves both `generate()` and `edit()` (including a real pixel-level recolor of a fixture image)
    through that same gateway.
  - **Deliberately no agent integration**, the same posture as every other domain in this family: the
    adapter is the whole product — no `Tool` class, no forged tool, no `TurnRunnerConfig` wiring.
    `GenerationImageInput` accepts a real `Media` instance structurally (`{ mimeType, asBytes() }`), zero
    import coupling either direction. New docs section `docs/batteries/generation/` (hub, one reference
    page per engine, recipes) covers the shared contract, each engine's full wire behavior, and how to wire
    a `generate`/`edit` call into a BYO `Tool`, an edit-tool consuming an inbound `Media` attachment, a
    courtesy `Media.stash` caption, and running the on-device engine behind `forkIsolated`.

## 2026-07-07

### Security

- **Prototype pollution in the `data.*` media steps (GHSA-xwg2-cvvj-3w4v).** `data.set` and
  `data.delete` walk a caller-supplied dot/bracket path (`a.b[2].c`) with plain bracket access
  (`container[seg]`); a path segment of `__proto__`, `prototype`, or `constructor` resolved
  through the real prototype chain instead of stopping at an own property, so `data.set` with
  `path: "__proto__.polluted"` reached `Object.prototype` and poisoned every plain object in
  the process for the remainder of its lifetime — reachable from LLM tool-call arguments via
  the forged `media_query`/`data_set` tool surface. `parsePath` now rejects any segment in that
  denylist before `walkToParent` ever runs, closing both verbs (they share the same parser).
  `data.merge` used a different code path (`{ ...target }` spread) that is not independently
  exploitable — spreading onto a fresh object literal makes `__proto__` an inert own property,
  not a prototype reassignment — but a new `assertSafeObjectKeys` guard now rejects the same
  three keys anywhere in a merge fragment's tree before either the shallow or deep merge
  strategy runs, so the verb can't be used to smuggle a poisoned key back out through a
  round-tripped document.
- **Defense-in-depth: reject the same three keys in vector-adapter metadata.** An audit for
  the same vulnerability class found five adapters (`pinecone`, `s3vectors`, `qdrant`, `redis`,
  `cloudflare`) that spread caller-supplied `record.metadata` onto a fresh object literal before
  upsert. None of these were independently exploitable for the reason above — the spread target
  is always a new `{}`, never a walked reference — but a `__proto__`-keyed metadata object would
  otherwise round-trip verbatim through storage and back out to a caller. A new
  `sanitizeMetadata` helper (`src/batteries/vector/helpers.ts`) strips `__proto__`, `prototype`,
  and `constructor` keys before each adapter's upsert path builds its stored record.
- Audited the rest of the codebase for the same reachable-prototype-chain pattern — the
  `data_structure` and `structured_data` tool batteries, the `apply_patch` media step, the
  data-format `MediaEngine`, and `Registry`'s `dset`-backed path storage — and found no further
  instances; everything else either only reads, or only ever writes to a freshly constructed
  object.

### Added

- **`Tokenizable` accepts a dynamic evaluator, resolved at prompt-assembly time.** Alongside a plain
  string, the constructor now takes a {@link TokenizableEvaluator} — a `(ctx?) => string` — so wrapped
  content can compute itself coherent with the live `DispatchContext` it ships in (e.g. an instruction
  that adapts to whether a tool survived the subtractive-context pass). Resolutions are cached
  per-context in a `WeakMap` so repeated measures of the same dispatch (subtractive pass + overflow
  guard) don't re-invoke the evaluator. A `render(ctx)` method is the explicit, context-aware read;
  the standard string-coercion protocol (`toString`/`valueOf`/`toJSON`) resolves with no context, hitting
  the evaluator's own `undefined`-branch fallback. An evaluator that throws or returns a non-string
  raises the new `E_TOKENIZABLE_EVALUATOR_INVALID` — loud, no silent coercion. New `'gemma'` encoding
  identifier for {@link Tokenizable.estimateTokens} (Gemma 2/3/4, backed by the same
  `@lenml/tokenizer-gemini` SentencePiece vocabulary as `'gemini'` — deliberate reuse, distinct name).
  Files: `src/lib/classes/tokenizable.ts`, `src/lib/exceptions/runtime.ts`.
- **Token-estimation failures degrade instead of silently returning `Infinity`.** A real-tokenizer
  failure (e.g. a special-token literal, an encoder bug) inside a `TurnRunner` run or `DispatchRunner`
  dispatch now emits a `warning` and falls back to a char-based guesstimate, rather than the previous
  silent `Number.POSITIVE_INFINITY` — which, combined with the overflow guards, could spuriously trip
  an `E_*_CONTEXT_OVERFLOW` on ordinary text. Outside any runner execution, the failure still re-throws
  (a genuine bug in non-runner code must surface). The ambient channel a runner publishes for the
  duration of its run is `src/lib/utils/estimation_context.ts` (new) — a LIFO stack of warn-emit sinks
  so a dispatch nested inside a turn routes to its own (richer) emitter.
- **WebGPU memory observability for the on-device LLM batteries.** `probeGpuBudget()`
  (`src/batteries/llm/chat_common/gpu_budget.ts`, new) reads the WebGPU adapter's buffer-size limits
  and adapter info, non-invasively — observability only, allocates nothing. A new opt-in
  `instrumentGpuBuffers()` wraps `GPUDevice.prototype.createBuffer` to track live/peak GPU buffer bytes
  against that budget, for an application that wants a live "you're at X of Y GiB" gauge. Paired with a
  new typed `E_LLM_GPU_OUT_OF_MEMORY` (`chat_common/exceptions.ts`, new) — `isGpuOutOfMemoryError()`
  matches ORT-web's several GPU-exhaustion and WASM-linear-memory-exhaustion error signatures and both
  the `transformers_js` and `litert_lm` batteries translate a raw provider throw into this one typed,
  catchable error, surfaced via a non-fatal `ctx.nack(...)` rather than a throw. A new `gpuBudget` field
  on the battery lifecycle report carries the probed snapshot. Consistent with the ADK's
  surface-don't-impose stance: the batteries never auto-cap the caller's context window.
- **Shared tool-call parser layer expanded and hardened.** The `gemma` parser is rewritten as a
  string-aware balanced-brace scanner — correctly handles nested argument objects and the curly smart
  quotes (`“…”`, `‘…’`) small models emit in place of ASCII quotes, instead of the previous lazy-regex
  approach. Two new parser families: `'bare_pythonic'` and `'loose_keyed'` (`toolCallParser` /
  `ToolCallParserName`). New observer seams on every LLM battery's options: `onRawGeneration` (the raw
  model text for a completed generation, after envelope-stripping but before persistence — reasoning /
  tool-call parser bring-up, live abstention debugging, fixture capture) and `onPromptAssembled` (the
  fully-assembled request about to ship, the mirror tap on the way in). Both are purely observational,
  default-absent, and consumed by all five LLM batteries (`chat_common/tool_parsers.ts`,
  `chat_common/lifecycle.ts`, `chat_common/types.ts`).
- **`litert_lm` battery: engine hosted in a disposable Web Worker.** New standalone worker build
  configs — `litert-lm-worker.vite.config.mts` and `webllm-worker.vite.config.mts` — with matching
  `build:litert-lm-worker` / `build:webllm-worker` package scripts, compiling the LiteRT-LM (IIFE,
  classic-worker-compatible — LiteRT's Emscripten glue calls `importScripts()`, illegal in a module
  worker) and WebLLM (ES module worker) engine handlers as separate bundles co-located with their wasm
  assets, so a long-lived session can recover from a browser-level WebGPU device loss by terminating
  and respawning the worker rather than reusing a dead `GPUAdapter`. The adapter's existing
  `createEngine` injection seam (`LiteRtLmAdapterOptions.createEngine`) is what a host wires a
  worker-backed engine through; the battery itself stays runtime-agnostic.
- **`DispatchRunner` / `TurnRunner` emit a `WarningEvent`** observability payload — non-fatal
  conditions (starting with the token-estimation degrade above) surfaced through the same observability
  bus as `LogEvent` / `GenerationStatsEvent`, carrying `dispatchId`/`iteration`, a `source`, and a
  `kind`. Executor-thrown and nacked errors also now preserve a meaningful `Error`-shaped `cause` even
  when the thrown/nacked value is not itself a strict `Error` (a raw string or cross-realm error no
  longer collapses to a cause-less generic wrapper) — `toErrorCause` in `src/lib/dispatch_runner.ts`.
- **Documentation: the "Punching Above Its Weights" showcase family.** The flagship agent showcase
  (`docs/showcase/punching-above-its-weights.md`) demonstrates building a real tool-using agent under
  hostile conditions — Gemma-4 E2B via `LiteRtLmAdapter` in a browser tab, a 4GB GPU ceiling, a
  live-draggable context window — technique by technique (planner book-end, subtractive pass over the
  shipped context battery, gate cascade, artifact handles, GPU survival), each with real code embeds
  and field-note receipts, closing on the blind-judged 5-cell evaluation matrix. Its companion
  **"The Agent, In Full"** (`docs/showcase/punching-above-its-weights-source.md`) exposes the complete
  31-file agent source in a read-only in-page Monaco viewer, with an LLM-consumable full-source
  mirror emitted through the docs pipeline for coding agents to port from. Method-side pages:
  **Token Thrift** (`docs/the-loop/token-thrift.md`, the context-discipline lever), **Behavioral
  Rails** (`docs/the-loop/behavioral-rails.md`, gates/own-voice nudges/the planner contract), **Read
  the Wire** (`docs/the-loop/read-the-wire.md`, evidence-directed agent debugging), and **Runtime
  Loading** (`docs/assembly/runtime-loading.md`, the `@nhtio/adk/shims` consumption guide). The
  underlying evaluation/research harness (corpus runs, floor calibration, adversarial threads, the
  LiteRT worker Step-0 probe) is committed under `research/`.

- **New context battery domain: `thrift` and `compact`, two strategies for what goes into one
  dispatch's window.** `src/batteries/context/thrift` is the subtractive strategy already backing
  the Token Thrift work above — `subtractToFit`, `stripPriorTurnThoughts`, and the calibrated
  `selectRelevantTurns`/`scaledRelevanceFloor` relevance-based turn selection (floor constants
  `RELEVANCE_FLOOR_MIN`/`MAX`/`CURVE` calibrated against a triple-oracle, 94-turn stress corpus) are
  now a standalone, importable battery rather than flagship-agent-only code.
  `src/batteries/context/compact` is new: a faithful extraction of the flagship agent's own
  Claude-Code-style auto-compaction (`assembleCompactedTurns`, `summariseTurns`,
  `COMPACTION_SYSTEM_PROMPT`) — keep the newest turns verbatim, fold everything older into a
  rolling summary once it crosses a token threshold. Both batteries are built entirely on injected
  resolvers rather than bundled capabilities: `EstimateTokensFn` (no default tokenizer) and, for
  `compact`, `SummarizeFn` (no default model transport) — with **zero imports from `@nhtio/adk`
  core** at the structural-contract layer (`WorkingMessage`, `WorkingMemory`, `WorkingRetrievable`,
  and friends are locally-declared, duck-typed shapes a real core object satisfies structurally
  without either side importing the other). This decoupling is practical against real models
  because of the token-estimator registry added above ({@link registerTokenEstimator}) — a caller
  can register a custom encoding's estimator without editing `Tokenizable`'s internal switch, so
  `thrift`/`compact` work against any encoding a project uses, built-in or not. The two batteries
  are composable: `thrift`'s `isSummaryMessage` predicate (default id `'__compact-summary'`,
  matching `compact`'s `DEFAULT_SUMMARY_MESSAGE_ID`) protects `compact`'s rolling summary message
  from being shed like an ordinary old turn when both run in the same pipeline. Evaluated
  head-to-head against a naive-recency baseline across five model/window cells on a shared 94-turn
  corpus: thrift is the lightest arm nearly everywhere and never collapses, while compact tops the
  two cells where real context pressure meets a paid summarizer budget (kimi-k2.5 @ 128k, 1.48 vs.
  1.13; gemma-31b @ 128k, 1.48 vs. 1.35 — both 3-judge) — documented in full,
  including the naive baseline's 0.08 collapse on the kimi cell and per-cell dispatch/summarizer-
  overhead tables, in the new `docs/batteries/context/` pages.

- **`@nhtio/adk/shims` — an async-resolver seam for binding a runtime-loaded ADK bundle without
  importing core into the consumer's module graph.** {@link createAdkShim} wraps a consumer-supplied
  {@link AdkResolverFn} (all environment knowledge — `fetch` + dynamic `import()`, a Worker handshake,
  a host-injected global — lives in that one function; the shim ships no loading policy of its own)
  and returns `{ resolve, get, resolved, proxy }`: single-flight `resolve()`, a synchronous `get()` for
  already-resolved reads, a live `resolved` boolean, and a `proxy` that replaces the hand-rolled
  `export let Foo: typeof Module.Foo` holder pattern with one destructurable object. Memoization is
  GC-safe — the resolved bundle is held via `WeakRef` (never strongly retained by the shim itself),
  falling back to a plain strong reference only where `WeakRef` is unavailable. A module-scope ambient
  variant (`registerAdkResolver` + `adk`) covers the "many files, one shared binding" case. Three typed
  exceptions cover the failure modes: `E_SHIM_NOT_RESOLVED` (a sync read before anything resolved),
  `E_SHIM_RESOLUTION_FAILED` (the resolver rejected or threw, cause preserved), and
  `E_SHIM_RESOLVER_ALREADY_RESOLVED` (re-registering the ambient resolver after it already resolved
  once — a split-brain guard). `src/shims/index.ts` is a **leaf module** — proven at dist level
  (`shims.mjs`, 17.7KB) to import only the exceptions chunk plus `@nhtio/validation` and `fast-printf`,
  zero core graph — and deliberately not re-exported from the root `@nhtio/adk` barrel, since doing so
  would drag the very module graph this subpath exists to let you avoid back into the import. The docs
  site itself now dogfoods this exact seam: `docs/.vitepress/theme/components/quickstart_demo_runtime.ts`
  replaced its own four-times-hand-rolled memoizing loader (the one that exists because importing ADK
  source into the VitePress module graph overflows the JS call stack on iOS WebKit) with
  `createAdkShim(resolver)`, the resolver supplying only the docs app's URL-resolving policy.

### Changed

- **`@sqlite.org/sqlite-wasm` and `kysely` are now docs-site devDependencies** — used by the docs
  site's in-browser SQLite demo tooling, never shipped in the published package. **`katex`** is now a
  runtime `dependency` (previously absent) — it backs the math tools battery
  (`src/batteries/tools/math/index.ts`).

## 2026-06-26

### Added

- **Portable generation vocabulary shared by the two text-out on-device batteries** (`transformers_js`,
  `litert_lm`). Both now accept one canonical {@link ChatGenerationOptions} surface — `maxTokens`, `sampler`
  (`'greedy'`|`'top-k'`|`'top-p'`), `temperature`, `topK`, `topP`, `seed`, `enableThinking`,
  `multimodal: { image, audio }` — and each adapter maps it onto its own runtime API. Precedence is
  **canonical-wins**: the canonical field is honored and the battery's native field (transformers.js
  `maxNewTokens`, LiteRT `maxOutputTokens` / `samplerParams`) is the fallback consulted only when the canonical
  one is absent, so existing native-field config keeps working. Defaults are identical across both batteries
  and chosen for reproducibility (`sampler: 'greedy'`, `enableThinking: false` — many reasoning templates
  default thinking *on* and burn the token budget before the answer; this turns it off unless asked).
- **Normalized lifecycle hook surface across all on-device batteries** (`transformers_js`, `litert_lm`,
  `webllm_chat_completions`, and the transformers.js embeddings battery). A new opt-in {@link BatteryLifecycleHooks}
  block: an `onLifecycle` firehose plus per-phase hooks `onLoading` → `onCompiling` → `onReady` →
  `onGenerating` → `onComplete` (or `onError`), each handed a normalized `BatteryLifecycleReport`
  (`{ phase, battery, model, at, detail?, progress?, raw?, error? }`). `progress` is normalized to `0..1`
  during `loading` when the provider reports it; the `compiling` phase marks the WebGPU/wasm shader/graph
  build between download and first token — often the slowest part of a cold start, and previously invisible.
  Purely additive — omit the hooks and behavior is byte-for-byte unchanged; a throwing consumer hook can never
  abort a load or a turn. The existing per-provider `onInitProgress` is untouched.
- **Multimodal INPUT for the transformers.js battery.** Image and audio flow through the model's processor
  (called positionally, `_call(text, images, audio)`); a multimodal model genuinely perceives them. For the
  common audio case — uncompressed PCM WAV — the battery decodes the RIFF itself with a `DataView`,
  dependency-free and **env-neutral**, *before* importing the heavy peer (transformers.js's own `read_audio`
  needs the Web Audio API's `AudioContext`, which does not exist in Node; compressed containers still fall
  back to it, browser-only). Enable per kind via the canonical `multimodal: { image, audio }`.
- **Opt-in media-OUTPUT seam (`extractMediaOutputs`) on the `transformers_js` and `litert_lm` batteries.**
  Default absent → text-out, byte-for-byte unchanged. Supply the hook and a wrapped media-emitting model's
  generated audio/image is persisted via `ctx.storeMediaBytes`, wrapped as a first-party `Media.toolGenerated(...)`,
  and surfaced as an assistant `Message.attachments` entry (a media-only turn — empty text + attachment — is
  legitimate). The batteries remain multimodal-in / text-out by default; this is for an LLM turn that produces
  media alongside or instead of text.
- **`'phi'` tool-call parser** added to the shared parser layer's `toolCallParser` set and the `'auto'`
  priority order (`hermes → gemma → gpt_oss → phi → pythonic → llama3_json → mistral → qwen3_coder`). Anchored
  on the literal `functools` token (verified against vLLM's `phi4_mini_json` parser), so it runs with the
  other marker-anchored families ahead of the weak-signal JSON/pythonic forms.
- **`EmbeddingGemma 300M`** (`onnx-community/embeddinggemma-300m-ONNX`) verified through the
  `transformers_js` embeddings battery — 768-dim, unit-norm, deterministic — alongside the existing
  MiniLM / BGE-small / Arctic-S entries.
- **The real-model test matrix** (`tests/_fixtures/model_matrix.ts`, gated on `TEST_MODEL_MATRIX=1`): loads
  each real ONNX / `.litertlm` model, drives one dispatch turn, and asserts the expected parser family or
  multimodal grounding is extracted — because a small model may not emit the format its chat template implies
  (Gemma 4 E2B emits the decoder-stripped `call:NAME{k:v}`, not the template's `<|tool_call>…`). A Node half
  (`pnpm run test:matrix`) and a headed-WebGPU browser half (`pnpm run test:matrix:browser`, local-only — CI
  runners have no GPU). `bin/capture_tool_outputs.ts` (`pnpm run capture:tools`) captures real raw output from
  hosted big-only families (`qwen3_coder`, `gpt_oss`, `mistral`) via any OpenAI-compatible proxy into committed
  parser fixtures — configured with `--base-url`/`--api-key` or the generic `CAPTURE_BASE_URL` /
  `CAPTURE_API_KEY` env vars; never run in CI.
- **Documentation: a dedicated "LLM Batteries" section** under Featured Batteries — an overview hub, a
  "Shared Contract" page (the three `chat_common` pillars: parser layer, portable generation vocabulary,
  lifecycle hooks), and a reference page per battery (OpenAI, Ollama, WebLLM, LiteRT-LM, Transformers.js) each
  carrying a tested-model table grounded in the matrix. Plus a showcase, "Building the On-Device Batteries,"
  documenting the parser archaeology, the false-green fixtures, and the one wall we could not engineer around:
  **LiteRT-LM in the browser runs Gemma and only Gemma**, proven at the file-format level
  (`tf_lite_prefill_decode` vs `tf_lite_artisan_text_decoder`) — converting a non-Gemma model to a
  browser-runnable `.litertlm` is a dead end with the public toolchain. The dead `convert_model` / `deploy_model`
  scripts (which described a fictional CLI) were removed and the conversion doc rewritten as "The Real-Model
  Matrix." Docs are bundled in the npm package and served by the ADK Assembly MCP, so this ships with the release.

### Changed

- **`bin/capture_tool_outputs.ts` now reads its proxy URL/key from `CAPTURE_BASE_URL` / `CAPTURE_API_KEY`**
  (or the existing `--base-url` / `--api-key` flags), replacing internal-specific env-var names. Dev tool only;
  not part of the published runtime surface.

### Fixed

- Fixed the documentation release pipeline.

## 2026-06-25

### Added

- **New opt-in LLM battery `@nhtio/adk/batteries/llm/transformers_js` — on-device ONNX text generation,
  in Node AND the browser.** Ships `TransformersJsAdapter`, a one-line {@link DispatchExecutorFn} wrapping
  [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (an optional peer,
  already present for the media ASR engine). Unlike the WebLLM and LiteRT-LM batteries (WebGPU/browser-only),
  transformers.js is **environment-neutral** — it auto-selects `onnxruntime-node` (native, plain Node, no GPU)
  or `onnxruntime-web` (WASM + WebGPU) — so this battery runs server-side and client-side from one codepath
  and does **not** gate on `navigator.gpu`. `device`/`dtype` pick the backend and quantization. `STASH_KEY`
  is `'transformersJs'`.
- **New opt-in embeddings battery `@nhtio/adk/batteries/embeddings/transformers_js`.** Ships
  `TransformersJsEmbeddingsAdapter` — on-device `feature-extraction` embeddings with the same
  `embed`/`embedMany`/`dimensions`/`preload`/`reset`/`isAvailable` surface and `number[]` return shape as the
  OpenAI and WebLLM embedders, plus `pooling` (default `'mean'`) and `normalize` (default `true`). Being
  environment-neutral, it is surfaced from the `@nhtio/adk/batteries/embeddings` aggregate barrel (alongside
  OpenAI; WebLLM stays deep-import-only).
- **New shared, configurable tool-call + reasoning text-parser layer** (re-exported from both
  `transformers_js` and `litert_lm`). Text-only on-device runtimes inject tool definitions into the chat
  template but emit tool calls and reasoning as **family-specific raw text**, not structured fields — so the
  battery parses them out, the way vLLM/SGLang/Ollama do (post-hoc, per-family, flag-selected). Two options,
  both defaulting to `'auto'` (try the bundled family parsers in priority order, first match wins):
  - `toolCallParser`: `'auto'` · `'hermes'` · `'gemma'` (E2B/E4B) · `'gpt_oss'` (Harmony) · `'pythonic'` ·
    `'llama3_json'` · `'mistral'` · `'qwen3_coder'` · `'none'` · a custom `ToolCallParserFn`.
  - `reasoningParser`: `'auto'` · `'think_tag'` (`<think>…</think>`) · `'harmony_analysis'` · `'gemma_channel'`
    · `'none'` · a custom `ReasoningParserFn`.
  Marker-anchored families run first (no cross-family false positives); weak-signal JSON/pythonic forms are
  gated on the callee being a real tool. Parsed reasoning becomes ADK Thoughts; cleaned prose is the assistant
  Message; tool-call `arguments` are a plain object (no `JSON.parse`). Bundled defaults target the small ONNX /
  Ollama-Cloud-tier open-weight families (Gemma 4 E2B/E4B, gpt-oss:20b, Qwen3-Instruct, Llama 3.2, SmolLM).
  Gemma's tool-call + reasoning delimiters were verified byte-exact against the model's own
  `tokenizer_config.json`; both batteries were validated end-to-end against real ONNX models (MiniLM embeddings,
  SmolLM2-135M generation).

### Fixed

- **LiteRT-LM tool calling and reasoning extraction now actually work** (`@nhtio/adk/batteries/llm/litert_lm`).
  The battery as first shipped (v1.20260625.0) read `Message.tool_calls` and `Message.channels` off model
  output — but the `@litert-lm/core` v0.13.1 JS runtime is **text-in / text-out** and never populates those
  fields on output (they are input-only wire fields; the package README confirms text-only I/O). So the prior
  tool-calling and reasoning support was **non-functional against real models** (the mocked tests passed
  because the fakes populated the fields). The adapter now parses tool calls and reasoning out of the model's
  **text** via the new shared parser layer, with the same `toolCallParser` / `reasoningParser` options
  (default `'auto'`). If you relied on LiteRT-LM tool calls or thoughts before, they begin functioning with
  this release.

## 2026-06-24

### Added

- **New opt-in LLM battery `@nhtio/adk/batteries/llm/litert_lm` — on-device WebGPU inference of Google's
  `.litertlm` models.** Ships `LiteRtLmAdapter`, a one-line {@link DispatchExecutorFn} wrapping
  [`@litert-lm/core`](https://www.npmjs.com/package/@litert-lm/core) (browser/WebGPU + a bundled wasm
  runtime). Unlike the WebLLM battery it is **standalone, not an OpenAI-wire subclass**: it drives
  LiteRT's native `Engine.create() → createConversation({ preface }) → sendMessageStreaming():
  ReadableStream<Message>` API, takes tool-call `arguments` as a parsed object (no `JSON.parse`), and
  surfaces "thinking" via `Message.channels` → ADK thoughts. Full parity with the other batteries: text,
  streaming, thoughts, tool use, sampler/limit controls (`samplerParams`, `maxOutputTokens`,
  `maxNumTokens`, `backend`), and the typed multimodal contract (`audioModalityEnabled` /
  `visionModalityEnabled`). It reuses the format-agnostic render helpers; only the wire-shape mappers are
  LiteRT-native (`buildLiteRtConversationInput`, `toolsToLiteRtTools`, `renderLiteRtToolResult`, the
  streaming accumulator), each swappable via `helpers`. `STASH_KEY` is `'liteRtLm'`; exceptions are the
  `E_LITERT_LM_*` family plus `E_INVALID_LITERT_LM_OPTIONS` and `E_UNSUPPORTED_MEDIA_MODALITY`.
  - **`@litert-lm/core` is an optional peer dependency**, pinned exact (`0.13.1`) — it ships its own
    ~19 MB wasm and is **not** bundled into `@nhtio/adk`. Install it yourself (`pnpm add @litert-lm/core`)
    when you want this battery; it is never required for type-checking a consumer.
  - **The published `@litert-lm/core` docs lag the library** — tool use, channels, sampler controls, and
    multimodality are typed but undocumented. The adapter is mapped against the installed `.d.ts` (the
    source of truth); re-verify on upgrade. Preview `.litertlm` models are text-in/text-out today, so the
    native multimodal path is built-to-contract but not yet exercisable end-to-end.
- **Serialization: the ADK primitives now round-trip through [`@nhtio/encoder`](https://encoder.nht.io).**
  Encode an entire conversation graph — `Message`s with nested `Identity`, `Tokenizable`, and `Media`;
  `ToolCall`s with their results; `Memory`, `Thought`, `Retrievable`, `Registry` — to a string with
  `encode()` and rebuild it (instances, not plain objects) with `decode()`. Every primitive implements
  the encoder's custom-class contract via raw `Symbol.for()` keys, so **the contract adds zero
  dependency to the core** — `@nhtio/encoder` is an optional peer, pulled in only by the new battery.
- **New opt-in battery `@nhtio/adk/batteries/encoding`.** Call `registerAdkEncodables()` once at startup,
  before your first `decode()` — it registers every primitive with the decoder and auto-registers the
  binding-free reader resolvers (in-memory, fetch). This is the only code that imports `@nhtio/encoder`.
- **Reader handles round-trip, not bytes.** `Media` and `SpooledArtifact` serialize the *handle* — a
  tagged, re-openable locator — via a new optional `describe()` method on the `MediaReader` /
  `SpoolReader` contracts. On decode, a tag→reader resolver registry (`registerMediaReaderResolver` /
  `registerSpoolReaderResolver`) re-binds the handle to a live reader; for durable stores (flydrive,
  OPFS) the consumer registers the resolver carrying the live `Disk`/root the locator cannot itself
  carry. In-memory readers inline their buffer; the fetch reader captures its URL.
- **New exceptions** `E_READER_NOT_DESCRIBABLE` (encoding a primitive whose reader has no `describe()` —
  e.g. a `fromWebFile`-backed `Media`) and `E_NO_READER_RESOLVER` (decoding a handle whose tag has no
  registered resolver), both exported from `@nhtio/adk/exceptions`.

#### Not encodable, by design

- **`TurnGate`** wraps a live pending Promise + `AbortController` — there is no serialized form of "a
  thing some caller is awaiting", so it deliberately does not implement the contract.
- **`Tool` handlers serialize by source text only.** A handler that closes over `ctx`, service clients,
  or config loses those bindings on decode (the captured variables read back `undefined`); a `.bind()`-ed
  or native handler cannot be serialized at all. `Tool.inputSchema` round-trips losslessly via
  `@nhtio/validation`'s own `encode`/`decode`. Tools are rarely serialized; when they are, reconstruct
  dependencies inside the handler body rather than closing over them.
- **`fromWebFile`-backed `Media`** is not encodable — a browser `Blob` has no re-openable locator and the
  synchronous encoder cannot drain it. Persist to a media/spool store and wrap in a describable reader
  first.

This release is **additive — no major bump** (per the `<major>.<YYYYMMDD>.<n>` scheme, the major moves
only on core-contract breaks). The symbol methods are new surface; the new optional `describe()` on the
reader contracts is backward-compatible (optional method, duck-typed schemas unchanged); no existing
primitive constructor or field changed.

### Fixed

- **`Message` with empty `attachments` is no longer mis-rejected by its own serializer.** The
  newly-added `Message` encode path emitted `attachments: []` for text-only messages, which the message
  schema's "at least one of content/attachments, and a present `attachments` must be non-empty"
  cross-field rule then rejected on `decode()`. The encode snapshot now omits `attachments` entirely when
  empty. Only reachable via the new serialization path — no impact on existing construction.

## 2026-06-23

### Fixed

- **`Tokenizable` now caches the tiktoken encoder instead of rebuilding it per call**
  (reported against `1.20260612.0` from a Node/AdonisJS host embedding the ADK). `js-tiktoken`'s
  `getEncoding` has no internal cache — every call does `new Tiktoken(<ranks>)`, parsing the full
  BPE rank table (~800 ms for `o200k_base`), which is ~1000× the cost of the `encode()` that
  follows. The tiktoken backend was the one estimator that never got the lazy-singleton treatment
  the Gemini and Llama backends already had, so a fresh encoder was constructed on **every**
  `estimateTokens` invocation that missed the per-value memo. On a tool-heavy turn — where a
  battery re-measures an accumulating dispatch context once per iteration — this rebuilt the BPE
  table O(results × iterations) times, saturating a single-threaded host's event loop (CPU pegged,
  RSS oscillating multi-GB under GC of the repeatedly-allocated vocabulary, co-tenant HTTP
  starved). The encoder is now memoized in a module-level `Map<TokenEncoding, Tiktoken>`, mirroring
  the existing Gemini/Llama singletons; construction drops to once per encoding per process.
  Behaviour-preserving (`Tiktoken` instances are stateless and reusable), benefits every
  tokenization path ADK-wide, and is the single highest-leverage change against the reported
  event-loop starvation.

## 2026-06-12

### Added

- **Media generation: the `empty:<format>` sentinel.** Agents can now CREATE media, not just
  derive it. `media_id: "empty:xlsx"` (or `empty:png`, `empty:json`, …) mints a brand-new
  blank file and runs the statement against it — creation and population in one round-trip;
  `@empty:<format>` works as a statement ref too (`merge with=@empty:xlsx`). Strictly
  additive: harness ids are UUIDs, so every `empty:*` value was previously a guaranteed
  `MEDIA_NOT_FOUND`. Under the hood, generation is one new convert edge — the virtual source
  MIME `EMPTY_MIME` (`application/x-adk-empty`) — declared per engine; the creatable set is
  pure graph reachability (`convertTargets(EMPTY_MIME)`, multi-hop included), never a policy
  list. Deterministic generation (blank workbook/canvas/silence) ships bundled; model-based
  semantic generation (diffusion/TTS) is BYO via the same edge. Generation edges landed on
  jimp + sharp (1024×1024 white canvas), audio_decode (1 s of 16-bit mono silence at
  44100 Hz, dependency-free), soffice (its whole matrix, via zero-byte seed files —
  LibreOffice treats an empty seed as an empty document; pinned by a binary-gated spec), and
  the three new engines below.
- **`edits` — a third engine capability kind** (additive: `MediaEngine.edits?`,
  `EditCapability`/`EditRequest`/`EditResult`, `registry.edit()`/`hasEdit()`, selection
  middleware sees `kind: 'edit'`). Structural document ops are now declared, dispatched, and
  swappable like converts and mutates — and two engines may declare the same ops with
  different fidelity, with supply order picking the winner.
- **New engine `engines/sheetjs`** (`sheetjsEngine()`, optional peer `xlsx` **>=0.20.2 — install
  from the SheetJS CDN**, the npm registry copy is frozen at 0.18.5 with CVE-2023-30533 and
  CVE-2024-22363): the in-process, cross-env spreadsheet engine. Reads
  xlsx/xlsm/xlsb/xls(all BIFFs)/ods/fods/csv/NUMBERS/sylk/dif/dbf; writes those plus
  txt/html/rtf/json; generates any write target from `EMPTY_MIME`; edits every `sheet.*` op
  over its whole read matrix. SheetJS CE strips styling — documented loudly, asserted in
  tests, and the reason exceljs exists alongside it.
- **New engine `engines/exceljs`** (`exceljsEngine()`): workbook editing promoted out of the
  `sheet.*` steps into a fleet-visible engine. Edits every `sheet.*` op over xlsx with
  **styling preserved** (bold/fills/comments/formulas survive untouched — the fidelity pin is
  a test), and generates blank xlsx from `EMPTY_MIME`. Compose it before sheetjs when
  formatting matters; sheetjs alone covers data-only workloads without the extra peer.
- **New engine `engines/data`** (`dataEngine()`): the deterministic text/data engine. Generates
  txt/md/json/yaml/csv/html seeds from `EMPTY_MIME`; converts json⇄yaml, json⇄csv (papaparse
  peer, lazy), json→txt.
- **New verbs: `append`, `data.set`, `data.merge`, `data.delete`.** The lossy text family is
  first-class media now: append a line to txt/md/csv/yaml, set/merge/delete at a JSON or YAML
  path (output format follows the input). `empty:json | data set path=… value=…` is a
  complete create-then-populate chain with zero engine requirements.
- **Structured `apply_patch` envelope** — the GitHub Copilot apply_patch dialect
  (`*** Begin Patch`, Add/Delete/Update File, `*** Move to:`, `@@` context hunks), preserved
  exactly because models already know it. Multi-file via `with=@refs`; Add File can grow the
  workspace, so the result may be multiple media. Ambiguous hunk context fails rather than
  guessing. The unified-diff path is untouched, and the diff→apply_patch round-trip is now a
  tested contract (`diff A with=@B` applied to A reproduces B byte-exact).
- **`redact` and `update_text` on ODF** (odt/ods/odp — in-place `content.xml` edits with the
  same paragraph-aggregation matching the OOXML path uses) and **`redact` on PDF** — VISUAL
  redaction via pdf-lib (draw-over on matching pages + metadata strip). The caveat ships in
  the verb description and the docs because it is a trust boundary: content streams keep the
  original text; for content-level redaction, extract text first.
- **Spreadsheet vocabulary expansion**: xlsm/xlsb/fods/sylk/dif/dbf/numbers/yaml join the
  format tables and `convert to=` targets; all spreadsheet-family MIMEs normalize to xlsx for
  `sheet.*` edits whenever any configured engine declares the conversion (sheetjs in-process,
  or soffice).

### Changed

- **`sheet.*` verbs now require a registered edit-capable engine** (`requires: { capability:
  'edit' }`). Previously the steps lazy-imported exceljs directly, so merely installing the
  peer lit the verbs up; now the consumer registers `exceljsEngine()` (or `sheetjsEngine()`)
  in the engines array like every other capability. This is a behavior change for deployments
  that installed exceljs without declaring it — the failure message names the exact fix, and
  the engines docs carry a migration note.
- `convert` may newly appear in image-only deployments: jimp/sharp now declare generation
  convert edges, so `hasConvert()` turns true. A model attempting an unreachable conversion
  still gets the existing model-actionable reachable-targets failure.
- `MediaPipeline.capabilities` is now typed as the full `EngineRegistry` (the runtime value
  always was); `CapabilityProbe` gains an optional `hasEdit()`.
- **`dist/package.json` gains `mcpName: "io.nht/adk-assembly"`** and the build emits
  `dist/server.json` for the MCP Registry. No behavioral change for existing consumers.

## 2026-06-11

### Security

- **npm trusted publishing is live — releases no longer use a long-lived token.** Completing
  the groundwork below: the package's Trusted Publisher is configured on npmjs.com (GitLab
  CI/CD → this project's `.gitlab-ci.yml`, `npm publish` only), and both npm deploy jobs now
  authenticate exclusively with the short-lived OIDC `id_token` — every `NPM_TOKEN` reference
  is gone from this repository's CI. Verified live twice before removal: npm preferred the
  OIDC exchange even with the token fallback still present (publisher identity
  `GitLab CI/CD <npm-oidc-no-reply@github.com>`), and the first fully tokenless publish
  succeeded with the same identity. A stolen CI token — the credential class behind most of
  the recent registry-compromise worms — can no longer publish this package; publish rights
  are bound to this repository's pipeline identity instead of a bearer secret.
- **Supply-chain hardening across the build and dependency pipeline** (prompted by the recent
  npm worm campaigns; none of these change the published API):
  - **Release cooldown**: pnpm now refuses to resolve any dependency version published less
    than 3 days ago (`minimumReleaseAge` in `pnpm-workspace.yaml`). Compromised releases in
    recent supply-chain attacks were typically yanked within hours-to-days; the cooldown means
    a poisoned version ages out of the registry before it can enter our lockfile.
  - **Frozen lockfile in CI**: every pipeline job now installs with
    `pnpm install --frozen-lockfile`, so CI can never silently resolve packages that aren't in
    the committed, cooldown-vetted lockfile.
  - **Dependency floors** for transitive advisories in the dev tree: `dompurify >=3.4.0`
    (XSS bypasses; pinned older by monaco-editor), `lodash-es >=4.18.1` (`_.template` code
    injection; via chevrotain), and `uuid ^11.1.1` under exceljs (buffer-bounds advisory).
  - **Dropped `@xenova/transformers`** (dev) in favor of the already-present
    `@huggingface/transformers` for the Ask ADK embedder, reranker, and index builder. The
    abandoned v2 line dragged in `protobufjs ≤7.5.5` via `onnxruntime-web`, which carries a
    critical arbitrary-code-execution advisory plus seven others — all gone. Both the
    build-time index embedder and the browser query embedder migrated together (same runtime,
    same `q8` weights), so index and query vectors stay comparable.
  - **Trusted-publishing groundwork**: the npm deploy job now requests a GitLab OIDC
    `id_token` with the npm registry audience. Once the package's Trusted Publisher is
    configured on npmjs.com, the long-lived `NPM_TOKEN` CI secret — the artifact stolen in
    most registry-compromise incidents — can be deleted outright.
  - Net effect: consumer-facing prod tree remains at zero known vulnerabilities; the dev-tree
    audit drops from 27 advisories to 7 (all in the docs-site toolchain: vitepress's vite 5
    line and markdown-it, not reachable from any published code path).
  - Housekeeping from the lockfile rebuild: `@nhtio/eslint-config` is pinned to exactly
    `1.20260518.0` — its `1.20260609.0` successor ships stricter jsdoc rules that fail the
    current tree (~1,300 errors in `bin/` and the docs theme). Dev-only; upgrading the config
    is a separate chore with that cleanup attached.

### Changed

- **The Cloudflare Vectorize conformance suite is now opt-in and out of CI.** Vectorize's public
  endpoint is aggressively eventually-consistent — its query index flaps for seconds after a
  write or delete — and even with the conformance harness's retries the read-after-write race
  lost often enough to red-flag otherwise-green releases (it had been carried as an
  `allow_failure` job, which is just noise that trains you to ignore red). It now requires an
  explicit `TEST_VECTOR_CLOUDFLARE_ENABLED=1` opt-in on top of its credentials and skips
  otherwise. Run it by hand when you want to exercise the adapter against live Vectorize. The
  `cloudflare` adapter itself is unchanged and still shipped.

### Fixed

- **Vector adapter query-construction hardening** (from an internal security review; neither
  issue crossed a privilege or data boundary, both are belt-and-braces):
  - The Milvus adapter's `nearId` seed-vector lookup now serializes the id with
    `JSON.stringify` instead of raw template interpolation, matching the adapter's own
    delete path — an id containing a double quote can no longer alter the filter expression.
  - The Redis adapter's numeric range filters (`gt`/`gte`/`lt`/`lte`, and numeric `eq`/`ne`)
    now coerce the bound through `Number()` and throw
    `E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR` on non-finite results, so a non-numeric
    string can no longer break out of the RediSearch `[lo hi]` bracket and append query
    clauses. Numeric strings (`'2024'`) still work.

## 2026-06-10

### Added

- **The Media Pipeline battery (`@nhtio/adk/batteries/media`)** — a knex-inspired local media
  pipeline: one declarative `MediaPlan` with three front-ends (a chainable thenable builder, a
  pipe-string DSL, and JSON ops) compiling identically, executed as an `@nhtio/middleware` onion
  over in-memory bytes. Most stacks process media by shipping bytes to an external API or
  flooding the context window; this is the third option — local processing, no external APIs by
  default, your data stays in your infrastructure unless an engine you composed says otherwise.
  Verbs cover documents (select/split/merge/reorder/redact/sanitize/normalize/update_text/diff/
  apply_patch/convert/extract assets), unified text extraction (`extract text` routes PDF, DOCX,
  XLSX, ODT/ODS/ODP, PPTX, plain text, and images through one verb, with OCR fallback for
  scanned input), chunking and metadata, ten `sheet.*` mutations (ExcelJS), eight `slides.*`
  mutations (JSZip OOXML surgery), fused `image.*` transforms (adjacent steps cost one
  decode/encode), and `audio.transcribe` (decode → 16 kHz mono resample → ASR).
- **The pipe DSL** — the LLM-facing surface: `select pages=2-5 | redact match=/…/ | convert
  to=pdf`. Named args only, separator-insensitive verb folding, 1-based indices, bare-number-is-
  index/quoted-string-is-name targeting, quoted-JSON structured payloads, inline `@id` media
  refs, and two-layer model-actionable errors (position-bearing syntax errors plus semantic
  did-you-mean narrowed to the deployment's configured engines, every message ending in a
  corrective exemplar). Round-trip is fixed-point and pipe/ops forms produce identical plans.
- **Engines as self-declaring capability providers** (`@nhtio/adk/batteries/media/contracts` +
  one subpath per implementation): a `MediaEngine` is `{ id, converts?, mutates? }` — exactly
  two capability shapes, because a media engine only ever changes the format or changes the
  content. `ConvertCapability` declares uniform from×to blocks over MIME patterns and format
  tokens (OCR is `image/*`→txt, transcription is `pcm`→txt/srt/vtt/json, audio decoding is
  `audio/*`→pcm, PDF embedded-image extraction is `pdf`→images multi-output); a new capability
  is a new edge in the data, never a new contract. Engines are supplied as a **flat ordered
  array** (`engines: [resolver, …]`) resolved eagerly at construction — declarations drive
  verb narrowing; heavy peers still lazy-load inside capability methods. Dispatch is one rule
  everywhere: capability filter, then an optional `selection` middleware onion (stages may
  exclude or reorder candidates, never add — the seam for content-dependent quality rules like
  routing complex workbooks past a pure-JS converter to LibreOffice), then array order among
  survivors. Convert computes shortest multi-hop paths (up to three hops) through the declared
  format graph when no direct edge exists, with lossy/virtual tokens (txt, json, srt, `pcm`,
  `images`) as endpoints, never intermediates. `ConvertRequest.options` is a typed,
  consumer-augmentable `ConvertOptions` interface (declaration merging against the contracts
  subpath). Bundled: `engines/jimp` (cross-env image mutate), `engines/sharp` (Node mutate
  incl. webp/avif + `fromSharp` BYO adapter), `engines/tesseract_js` (cross-env OCR convert;
  languages required), `engines/audio_decode` (cross-env audio→pcm, no ffmpeg),
  `engines/transformers_asr` (cross-env Whisper pcm→text; model id required — no silent
  multi-hundred-MB downloads), and `engines/soffice` (the LibreOffice convert matrix, which
  now also covers ODS/legacy-xls→xlsx — sheet normalization is just a conversion edge, not a
  separate engine). Binary-backed engines compose two further BYO contracts: `BinaryExecutor`
  (bundled `engines/execa_executor`) and `ScratchWorkspace` (bundled `engines/fs_workspace`;
  explicit root, no `os.tmpdir()` default) — process execution and filesystem access are
  movable seams, not Node assumptions. The registry is exported (`buildEngineRegistry`) for
  standalone dispatch.
- **A battery-scoped ESLint plugin for the media pipeline**
  (`@nhtio/adk/batteries/media/lint`, namespace `adk-media`) — battery-specific contracts ship
  with the battery, not the core `@nhtio/adk/eslint` plugin. Three rules:
  `adk-media/prefer-engine-resolver` (static value imports of bundled engine subpaths — the
  canonical supply form is the dynamic-import resolver; type-only imports pass),
  `adk-media/no-shadowed-engine` (an engine whose statically-known capabilities are fully
  covered by an earlier engine in the array is dead code under first-capable-wins dispatch),
  and `adk-media/augment-contracts-module` (`ConvertOptions` declaration merging that targets
  any module other than `batteries/media/contracts` silently never merges).
- **Forged agent tools** (`@nhtio/adk/batteries/media/forge`): `forgeMediaTools(mp, { surface })`
  mints either the composite surface (one `media_query` tool taking `{ media_id, q | ops }`,
  its description embedding the engine-narrowed grammar with toPipe-generated examples, plus
  `list_media`) or the granular surface (one tool per available verb). Outputs persist via
  `ctx.storeMediaBytes` and return first-party `Media`; processing and DSL failures render as
  readable `Error (CODE): …` strings the model can repair from. An optional `gate?: ToolGateFn`
  runs before every execution — the human-approval/RBAC seam built on `ctx.waitFor`.
- **Inline media id-markers in every LLM battery.** Rendered media (attachments and tool
  results) is now preceded by a harness-authored `[media id: <id> | <filename>]` text block so
  models can reference media by id in tool calls without a discovery round-trip. The marker is
  structural reference data from the harness-controlled `Media.id` — no authority, fixed
  phrasing, outside the untrusted envelope. OpenAI is the reference implementation (WebLLM
  inherits); Ollama emits the same shape on its text channel.
- **Gate seam retrofit for SearXNG and Scrapper.** Both factory batteries now accept the same
  optional `gate?: ToolGateFn`, run before the HTTP request — network side effects deserve the
  approval seam too. Additive and backward-compatible.
- New optional peer dependencies (pulled only by the engine/parser that needs them): `moo`,
  `pdf-lib`, `pdf-parse`, `mammoth`, `exceljs`, `jszip`, `jimp`, `sharp`, `audio-decode`,
  `@huggingface/transformers`, `tesseract.js`, `execa`.

### Fixed

- **API documentation gaps closed.** Several types referenced by public API surfaces were not
  themselves exported, so their doc pages didn't exist and links to them dangled:
  `EngineSummary` (referenced by the media lint plugin's `BUNDLED_SUMMARIES`), `ChainExecutor`
  (the media chain's executor seam), and `AudioDecodeFn`/`AudioBufferLike` (the audio-decode
  engine's override surface) are now exported and documented. The web-retrieval docs' links to
  `RawRetrievable` now point at `@nhtio/adk/common`, where the type actually lives, and
  `ScrapperBaseConfig` is re-exported from the scrapper barrel. Cosmetic prose fixes in the
  media docs ride along. No runtime behavior changes.

## 2026-06-09

### Fixed

- **OpenAI Chat Completions battery now accepts `reasoning_effort: 'none'`.** The request
  validator constrained `reasoning_effort` to `['minimal', 'low', 'medium', 'high']` and rejects
  unknown top-level keys (`.unknown(false)`), so there was no way to send `none` — the documented
  value Ollama's OpenAI-compatible `/v1/chat/completions` needs to turn a thinking model's (e.g.
  Gemma's) reasoning **off**. `'none'` is now in the enum (and the `reasoning_effort` type union);
  it flows to the wire through the existing body-assembly passthrough, and the strict-unknown-key
  protection is unchanged. The WebLLM battery is unaffected — upstream WebLLM has no
  `reasoning_effort` field and disables thinking via `extra_body.enable_thinking`, already an open
  passthrough there.

- **OpenAI Chat Completions battery now retries transport failures (HTTP status 0).** When `fetch`
  rejected before any HTTP response arrived (DNS failure, connection refused, TLS error, socket
  drop), the adapter immediately `nack`'d with status 0 **without consulting `retry.maxAttempts`** —
  so a single transient network blip killed the turn even when retries were configured. The
  transport-failure branch now retries with backoff up to `maxAttempts` before surfacing the error,
  matching the request-timeout branch beside it and the sibling embeddings adapter. Governed by the
  existing `retry.maxAttempts` knob; `retriableStatuses` is untouched (it gates HTTP responses,
  which transport errors never produce).

- **Bundled deterministic tools now do exactly what their descriptions say.** A correctness audit
  of the 17 deterministic tool batteries (`src/batteries/tools/*`) — driven by a schema-fuzzing
  invariant harness and two independent model reviews, with every finding verified against the
  running tool — surfaced a class of defects where a tool would throw an unexpected runtime error,
  refuse work it advertised, or silently return a wrong value. All are fixed; each tool was changed
  to meet its label (no description or test was weakened to match broken behaviour):
  - **`json_transform`** — `top_n` returned the wrong end of the range (comparator inverted; `desc`
    now returns the largest *n*, `asc` the smallest); `unique_by` never deduplicated object/array
    key values (reference-identity `Set` → now value-serialised); `sum` over a non-numeric array
    silently returned `0` (now a clear error); a `null` operation entry crashed the dispatch (now a
    clean schema rejection).
  - **`compare_records`** — a nested array and an integer-keyed object (`[1,2]` vs `{"0":1,"1":2}`)
    were reported equal; they are now distinct.
  - **`color_contrast` / `color_scheme` / `color_adjust`** — `hexToRgb` accepted hex strings with
    trailing non-hex characters (`#1Z2Z3Z` → silent `rgb(1,2,3)`); invalid hex is now rejected.
  - **`string_transform`** — `reverse` split astral characters/emoji into broken surrogate halves
    (`A💥B` now reverses to `B💥A`); `slug` destroyed non-decomposing Latin-1 letters (`føtex` →
    `f-tex`), now transliterated (`fotex`).
  - **`parse_yaml`** — an empty/whitespace/BOM-only document returned a non-string (`undefined`),
    now `null`; `.NaN` / `.inf` / `-.inf` were silently corrupted to `null`, now preserved.
  - **`format_table`** — null/primitive rows threw; they now render empty cells or return a clear
    "provide columns" error.
  - **`format_list`** — an unbounded `indent` threw `RangeError`; it is now clamped to 100.
  - **`evaluate_katex`** — scientific notation (`2e3`) misparsed, and `\log_b(x)` change-of-base
    produced malformed output; both now evaluate correctly.
  - **`encode_text`** — HTML-entity decoding of astral code points used `String.fromCharCode`
    (truncating to 16 bits); `&#127881;` / `&#x1F389;` now decode to 🎉 via `String.fromCodePoint`.
  - **`date_period`** — fiscal-quarter boundaries spanning the calendar-year boundary were computed
    in the wrong year (e.g. FY-Feb, `2024-01-15` → now correctly `2023-11-01`).
  - **`convert_unit`** — temperatures below absolute zero are now rejected instead of silently
    returned.
  - **`calculate`** — a non-finite scalar result (`1/0`, `2^5000`) now returns a clear error rather
    than printing `Result: Infinity`.

- **Updated three stale functional tests to the corrected `stats_describe` contract.** The
  `statistics`/`flydrive` through-runner tests still passed `stats_describe`'s `numbers` as a JSON
  **string** and asserted numeric `mean`/`sum` — both invalidated by the tool-correctness pass above,
  which retyped `numbers` to a real array (restoring NaN/∞/`>2^53` rejection) and emits computed
  aggregates as precision-formatted BigNumber **strings**. The tests now pass actual arrays and
  assert the string-valued aggregates; no production behaviour changed.

### Added

- **Scrapper web-extraction tool battery (`@nhtio/adk/batteries/tools/scrapper`).** Tools for any
  [Scrapper](https://github.com/amerkurev/scrapper) instance — a headless-browser service that gives
  an agent browser-grade page reading (JS-rendered pages a plain fetch can't see) as a **stateless**
  HTTP call: fresh incognito context per request, no stored session/cookies/credentials. Two verbs,
  each with an async factory (accepts a dynamic-import `artifact` resolver) and a sync variant:
  `createScrapperArticleTool`/`…Sync` (`/api/article`) and `createScrapperLinksTool`/`…Sync`
  (`/api/links`). Like the SearXNG battery these are factories (not constants) and must not be
  bulk-registered via `Object.values(batteries)`.
  - **Per-parameter disposition** — for every modeled knob the factory chooses: `fixed` (pinned;
    sent always, removed from the model schema), `defaults` (model-overridable), or open
    (model-settable). `url` is always required; `fixedQuery` is a raw kebab passthrough for
    un-modeled params, keeping the battery generic across instances/versions.
  - **Two distinct header channels** — `config.headers` (static or sync/async resolver) authenticates
    to the Scrapper *instance*; the `extra_http_headers` *param* (`'K:v;K2:v2'`) is what the scraper's
    browser sends to the *target site*.
  - Same SearXNG-style two-level output (`resultFormat` normalized/raw/either), `artifact` resolver,
    and input/output middleware pipelines (`shortCircuit`, fresh runner per call). Errors degrade to
    `Error:` strings (parses Scrapper's `{detail:[{msg}]}`; missing `url` → HTTP 422); bad config →
    `E_INVALID_SCRAPPER_CONFIG`. Documented as a featured-battery page with TSDoc `@warning`s for the
    `scroll_down`-needs-`sleep` and instance-relative-URI gotchas. Cross-env unit spec (stubbed
    `fetch`, disposition, resolver, all-three-artifact round-trips) + env-gated live integration spec
    (`TEST_SCRAPPER_URL` / `TEST_SCRAPPER_HEADERS`).

- **Web-retrieval RAG glue (`@nhtio/adk/batteries/tools/web_retrieval`).** The shared seam from
  search/scrape results to turn `Retrievable`s, used by both the Scrapper and SearXNG batteries.
  Pure converters — `searxngResultsToRetrievables`, `scrapperArticleToRetrievable`,
  `scrapperLinksToRetrievables` — return plain `RawRetrievable[]` (zero core-class instantiation;
  core referenced as `import type` only). `storeRetrievables(ctx, raws, { retrievable })` constructs
  and stores records via a **resolver-injected** `Retrievable` constructor (ctor / sync / async /
  dynamic-import), so the module never value-imports core. Long page text becomes a reader-backed
  `SpooledArtifact` via a caller `spool` hook (the converter recommends an open
  `ArtifactConstructorResolver` for the content — markdown/json/text — so a consumer's own subclass
  works unchanged; no chunker). Web content defaults to `trustTier: 'third-party-public'` (a
  constant, not URL inference — CONTRIBUTING DD#12).

- **Shared tool-battery helpers (`@nhtio/adk/batteries/tools/_shared`).** Internal building blocks
  for the configured-HTTP tool batteries: `resolveArtifact`/`resolveArtifactSync` (resolver → sync
  `() => Ctor`), the onion middleware-pipeline runners (fresh runner per call, short-circuit +
  non-terminal detection), header resolution, and the `ArtifactResolver`/`SyncArtifactResolver`
  types. SearXNG and Scrapper both build on it instead of carrying copies.

- **SearXNG search tool battery (`@nhtio/adk/batteries/tools/searxng`).** A web-search tool for any
  [SearXNG](https://docs.searxng.org/dev/search_api.html) instance, exposed via **factories** —
  async `createSearxngSearchTool(config)` and sync `createSearxngSearchToolSync(config)` — rather
  than a ready-made constant. It is the first factory-style tool battery: a search tool has to know
  *which* instance to query and is usually behind custom authentication, so it needs per-deployment
  config that cannot be baked in at module load. Because it exports factories (not a `Tool`), they
  must not be bulk-registered via `Object.values(batteries)` — call a factory first, then register
  the returned tool.
  - **Custom-header auth** — `config.headers` accepts a static `Record<string,string>` or a
    sync/async resolver (`() => headers | Promise<headers>`); the resolver runs on every search, so
    refreshable bearer tokens work. Caller headers override the default `Accept`/`User-Agent`.
  - **Two-level output-format control** — `config.resultFormat: 'normalized' | 'raw' | 'either'`
    (default `'either'`). Pinning it forces the shape AND removes the model-facing `format` arg from
    the schema; leaving it neutral lets the model choose per call. `normalized` trims each result to
    `{title,url,content,engine,score,publishedDate}` plus non-empty `answers`/`infoboxes`/
    `suggestions`/`corrections`; `raw` returns the full SearXNG JSON.
  - **Input/output middleware pipelines** — `config.inputPipeline` / `config.outputPipeline` are
    onion middleware `(ctx, next)` built on `@nhtio/middleware`. Input stages mutate the
    query/params/headers before the request or `ctx.shortCircuit(string)` to skip the fetch (cache
    hit); output stages filter/re-rank `ctx.results`, mutate `ctx.raw`, or set `ctx.output` verbatim
    (e.g. rendered markdown). A `ctx.stash` Map carries across both; a fresh runner is minted per
    invocation (middleware runners are single-use).
  - **Configurable spool artifact (resolver)** — `config.artifact` (default `() => SpooledJsonArtifact`)
    is an open `ArtifactConstructorResolver`: a ctor, a sync resolver, or — via the async factory —
    an async/dynamic-import resolver (`() => import('@nhtio/adk/spooled_artifact').then(m => m.SpooledMarkdownArtifact)`),
    so a consumer's own `SpooledArtifact` subclass works with no battery change. The async factory
    resolves it before building the `Tool` (whose `artifactConstructor` must be sync); the sync
    factory accepts only the sync subset.
  - **Graceful failures** — a disabled-JSON instance (SearXNG disables JSON by default → HTTP 403),
    network errors, timeouts, and thrown pipeline stages all return `Error:` strings the model can
    react to; only malformed args throw (`E_INVALID_TOOL_ARGS`). Invalid config throws the
    battery-scoped `E_INVALID_SEARXNG_CONFIG` at factory-call time.
  - Documented as a featured-battery page, with a TypeDoc `@warning` recording the upstream quirk
    that SearXNG's `number_of_results` is frequently `0` even when results exist
    ([searxng#2987](https://github.com/searxng/searxng/issues/2987),
    [searxng#2457](https://github.com/searxng/searxng/issues/2457)) — the tool passes it through
    verbatim; use `results.length`. Covered by a cross-env unit spec (stubbed `fetch`, all three
    artifact types round-tripped) and an env-gated live integration spec
    (`TEST_SEARXNG_URL` / `TEST_SEARXNG_HEADERS`).

- **Documentation-coverage gate (`bin/doc_coverage.ts`, `pnpm run doc:coverage`).** A standalone
  helper that bootstraps TypeDoc read-only over the same entrypoints the published docs use
  (`bin/utils/index.ts` `getEntries`) and reports every public API symbol missing a TSDoc comment,
  grouped by its deepest `@module` submodule. Modes: a human report (default), `--json`, `--ci`
  (non-zero exit when any non-allowlisted symbol is undocumented — wired into CI as a job, currently
  `allow_failure: true`), `--hook` (emits a Claude Code `additionalContext` envelope and always exits
  0), and `--primary` (audits `@primaryExport` placement). The shared `blockTags` list moved to an
  exported `BLOCK_TAGS` const so the helper and `makeApiDocs` never drift. **The entire public API
  surface is now documented — the gate reports zero undocumented symbols.** Every interface,
  type, class member, options field, wire shape, and exported function across the LLM, vector,
  embeddings, storage, and ESLint-rule batteries carries an accurate TSDoc comment.

  The API-doc build is also link-clean: every TypeDoc cross-reference now resolves. Types that
  documented symbols referenced but that were not themselves exported are now public —
  `ArtifactConstructorResolver` (`@nhtio/adk/forge`), the four `DispatchRetrievable*Fn` callback
  types (`@nhtio/adk/types`), and the pgvector / sqlite-vec adapter options interfaces, renamed for
  consistency with the other 24 adapters to `PgVectorStoreOptions` and
  `SqliteVecVectorStoreOptions`. Vendor types referenced in comments (`BigNumber`, `Set`, `Disk`)
  now link to their upstream docs via `externalSymbolLinkMappings`, and broken `{@link}` targets
  (wrong or non-exported names) were corrected. The internal, sentinel-gated `DispatchRunner`
  constructor is marked `@internal` (construct via the static `DispatchRunner.dispatch`).

- **Native Ollama LLM battery (`@nhtio/adk/batteries/llm/ollama`).** Ships `OllamaAdapter`, an
  executor targeting Ollama's **native `/api/chat`** endpoint — distinct from pointing the OpenAI
  Chat Completions battery at `/v1`, which it complements rather than replaces. Works with both
  local Ollama (`http://localhost:11434`, no auth — the default `baseURL`) and cloud Ollama
  (`https://ollama.com`, `apiKey` → `Authorization: Bearer`); only `baseURL` plus the auth header
  differ. Native-only capabilities the `/v1` compat layer cannot express are first-class: per-request
  context size via the nested `options.num_ctx`, native reasoning via `think`
  (`boolean | 'low' | 'medium' | 'high'`) surfaced as `message.thinking`, structured output via
  `format` (`'json'` or a JSON schema), and model lifecycle via `keep_alive`. Generation params live
  in a nested `options` block (not at the top level, unlike the OpenAI wire). The adapter parses
  NDJSON streaming (terminated by `done: true`, no `[DONE]` sentinel), takes tool-call `arguments` as
  a JSON object (no `JSON.parse`), labels tool-result history messages with `tool_name` (not
  `tool_call_id`), and follows every cross-battery design rule (trust-framed envelopes, per-tool
  trust, swappable helpers, `ctx.stash.ollama` per-iteration overrides, `ToolCall.inline` handling,
  trust-tier-distinct buckets). Native `/api/chat` carries images only; other modalities route
  through `unsupportedMediaPolicy`. `tool_choice` is intentionally unsupported (native `/api/chat`
  has no such field). Ollama is HTTP-only — Unix-socket deployments are reached via a bridge or a
  custom `fetch`.

- **Dedicated generation-stats observability channel on `DispatchRunner`.** Executors can emit
  provider-agnostic generation accounting (token counts, nanosecond durations, finish reason, model,
  provider, plus the raw provider object) via a new `helpers.reportGenerationStats(stats)` method;
  the runner enriches each record with `dispatchId` / `iteration` / `emittedAt` and fires it on a new
  `generationStats` observability hook (subscribe through `observers.generationStats`). This is
  additive and non-breaking — `DispatchExecutorHelpers` is runner-produced, so existing executors
  gain the method without change. The native Ollama battery emits its terminal-chunk stats through
  this channel; the new `GenerationStats` / `GenerationStatsEvent` types are exported from
  `@nhtio/adk/dispatch_runner`.

- **Shared Chat-family helper submodule.** The wire-shape-agnostic translation helpers (trust
  envelopes, memory/retrievable/standing-instruction rendering, system-prompt assembly, JSON-schema
  and function-tool conversion, thought filtering) were extracted to an internal
  `src/batteries/llm/chat_common` module shared by the OpenAI Chat Completions and native Ollama
  batteries. Behaviour-preserving: every existing `@nhtio/adk/batteries/llm/openai_chat_completions`
  helper export keeps its name and value identity (the battery re-exports the shared names), and the
  WebLLM battery is untouched. The shared module is internal — not a public package subpath.

- **NDJSON cassette support in the cross-env test harness.** `tests/_fixtures/cassette.ts` gained an
  `ndjson` response mode (parallel to the existing SSE `sse` mode) plus Ollama-native programmatic
  builders (`buildOllamaChatResponse`, `buildOllamaStreamFrames`, `singleOllamaResponseCassette`,
  `singleOllamaStreamCassette`) for deterministic native-wire replay.

- **Arbitrary-precision numeric handling across the math tools.** A shared
  `src/lib/helpers/bignum.ts` (a BigNumber-configured `mathjs` instance) backs the numeric
  batteries so float64 limitations no longer corrupt results: large in-range sums stay exact
  instead of overflowing to `Infinity`, tiny ratios don't underflow to `0`, and precision is
  preserved end-to-end (`sum([0.1, 0.2]) → 0.3`). `statistics`, `data_structure`, and
  `unit_conversion` now compute aggregates/conversions through it. The `statistics` tools take
  typed number arrays (`validator.array().items(validator.number())`) instead of JSON strings —
  restoring schema rejection of `NaN`/`Infinity`/`> 2^53` at the boundary and removing the prior
  silent-drop behaviour. Tools that format numeric output gained an optional `precision` argument
  (significant digits, default 8). **This changes those tool signatures and some output shapes**
  (computed aggregates may be precision-formatted strings).

- **Tool correctness test infrastructure.** A `callTool` helper in
  `tests/_fixtures/tool_ctx_stub.ts` captures a tool invocation's resolve-vs-throw outcome as a
  value (making the no-crash contract directly assertable), and a new
  `tests/unit/batteries/tools/fuzz.node.spec.ts` invariant harness introspects every bundled tool's
  schema, feeds adversarial input, and asserts each call either resolves to a string/`Uint8Array`
  or rejects with `E_INVALID_TOOL_ARGS` — never any other throw.

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
