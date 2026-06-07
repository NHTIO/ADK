/**
 * Opt-in aggregate barrel for bundled ADK batteries across LLMs, tools, and storage.
 *
 * @module @nhtio/adk/batteries
 *
 * @remarks
 * Opt-in bundled tools that ship with the ADK. This barrel is **not** re-exported from the
 * root entry — consumers must explicitly `import { ... } from '@nhtio/adk/batteries'` to use
 * these tools, and consumers who do not import this barrel pay nothing in their bundle.
 *
 * The barrel is a plain re-export of every category. Finer-grained subpaths exist for
 * tree-shaking:
 *
 * - `@nhtio/adk/batteries/tools` — every tool, identical to this barrel
 * - `@nhtio/adk/batteries/tools/<category>` — just one category (e.g. `math`, `color`,
 *   `datetime_math`)
 *
 * Each export is a pre-constructed {@link @nhtio/adk!Tool} instance ready to be registered with a
 * `ToolRegistry`. The ADK has no opinion on storage — the consumer's executor middleware is
 * responsible for persisting tool output and assembling the `ToolCall.results` field using each
 * tool's `artifactConstructor`.
 *
 * Need every bundled tool? `import * as batteries from '@nhtio/adk/batteries'` then
 * `Object.values(batteries)`. Need just one category? Deep-import the subpath and pay only for
 * that bundle.
 */

export * from './llm'
export * from './tools'
export * from './embeddings'
export * from './vector'
