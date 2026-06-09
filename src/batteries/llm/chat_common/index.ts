/**
 * Internal barrel for the wire-shape-agnostic Chat-family shared submodule.
 *
 * @remarks
 * INTENTIONALLY **not** `@module`-tagged — this submodule is private to the bundled LLM batteries
 * and must not become a public package subpath (see `./types`). It is imported by relative path
 * from `openai_chat_completions` and `ollama`, which re-export the names under their own public
 * surfaces. Consumers should import from those battery subpaths, never from here.
 */

export * from './types'
export * from './helpers'
