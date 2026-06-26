/**
 * Custom model-source resolver for transformers.js — the dual-environment seam that lets a consumer
 * serve a model's files (each submodule ONNX, the tokenizer, the config) from anywhere: OPFS, a
 * different repo per modality, bundled bytes, an in-memory map.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/model_source
 *
 * @remarks
 * **Mechanism (verified against the installed `@huggingface/transformers` build, NODE + WEB, 8 refs
 * each — ungated by `IS_NODE_ENV`):** transformers.js routes every model file through
 * `env.customCache.match(key)` when `env.useCustomCache === true`. `match` may return a `Response`
 * (bytes), a `string` (a path/URL the loader then fetches), or `undefined` (fall through to the normal
 * HF download). This module installs a `customCache` whose `match` parses the loader's key back into
 * `{repo, filename}` and delegates to the user's {@link TransformersJsModelSource} hook.
 *
 * **The cache key is the REMOTE URL, not `${repo}/${filename}` (corrected at impl from the plan's
 * assumption).** `buildResourcePaths` computes `remoteURL = pathJoin(env.remoteHost,
 * env.remotePathTemplate.replace('{model}', repo).replace('{revision}', rev), filename)` →
 * `https://huggingface.co/<repo>/resolve/<rev>/<path/to/file>`. `tryCache` first probes the *local*
 * path (no `/resolve/` segment — our parser returns `undefined`, so it correctly falls through) and
 * then this remote URL. {@link parseResourceKey} reverses exactly that template.
 *
 * **`env` is a process-global singleton.** {@link withModelSource} sets `useCustomCache`/`customCache`
 * for the duration of one load and restores the previous values after — behind a module-level async
 * mutex so concurrent loads across adapters never observe each other's hook. {@link installModelSource}
 * is the lower-level set-and-return-a-restore-fn primitive for callers that manage their own scope.
 *
 * The resolver does NOT implement OPFS/bundled reading — it is the plug; the consumer's hook is the
 * implementation. Reused verbatim by the embeddings battery (same `env` mechanism).
 */

import { isInstanceOf } from '@nhtio/adk/guards'
import type { TransformersJsModelSource } from './types'

/** The cache shape transformers.js requires (`match` + `put`, Web Cache API subset). */
interface TransformersCacheLike {
  match: (request: string) => Promise<Response | string | undefined>
  put: (request: string, response: Response) => Promise<void>
}

/** The mutable `env` surface we touch — kept minimal + structurally typed (no peer import here). */
interface TransformersEnvLike {
  useCustomCache: boolean
  customCache: TransformersCacheLike | null
  remoteHost?: string
  remotePathTemplate?: string
}

const DEFAULT_REMOTE_HOST = 'https://huggingface.co/'
const DEFAULT_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/'

/**
 * Reverse `buildResourcePaths`' remote-URL key back into `{repo, filename}`.
 *
 * Handles the canonical `{host}{model}/resolve/{revision}/{filename}` template. Returns `undefined`
 * for any key that is not a remote-host URL (e.g. the local-path probe `tryCache` issues first), so the
 * caller falls through to the default loader instead of mis-routing.
 *
 * @param key - The string transformers.js passes to `cache.match` (the remote URL).
 * @param env - The (possibly customized) host/template; defaults match the library's own defaults.
 */
export const parseResourceKey = (
  key: string,
  env: { remoteHost?: string; remotePathTemplate?: string } = {}
): { repo: string; filename: string } | undefined => {
  const host = env.remoteHost ?? DEFAULT_REMOTE_HOST
  const template = env.remotePathTemplate ?? DEFAULT_REMOTE_PATH_TEMPLATE
  if (!key.startsWith(host)) return undefined
  const rest = key.slice(host.length)
  // template is `{model}/resolve/{revision}/` → the literal middle segment is `/resolve/`.
  const literal = template.replace('{model}', '').replace('{revision}', '')
  // literal is `/resolve//` collapse the doubled slash to the real delimiter `/resolve/`.
  const delimiter = literal.replace(/\/+/g, '/')
  const idx = rest.indexOf(delimiter)
  if (idx === -1) return undefined
  const repo = rest.slice(0, idx)
  const afterDelim = rest.slice(idx + delimiter.length)
  // afterDelim is `{revision}/{filename}` — strip the first path segment (the revision).
  const slash = afterDelim.indexOf('/')
  if (slash === -1) return undefined
  const filename = afterDelim.slice(slash + 1)
  if (!repo || !filename) return undefined
  return { repo, filename }
}

/**
 * Wrap a {@link TransformersJsModelSource} hook into a Web-Cache-API-compatible object suitable for
 * `env.customCache`. `match` parses the key, calls the hook, and normalizes the result:
 * `Uint8Array` → `new Response(bytes)`; `string`/`Response` pass through; `undefined`/throw → fall
 * through. `put` is a no-op (served files are never re-cached — `toCacheResponse` is false for them).
 *
 * @param hook - The consumer's resolver.
 * @param env - Host/template for key parsing (defaults to the library defaults).
 */
export const modelSourceToCache = (
  hook: TransformersJsModelSource,
  env: { remoteHost?: string; remotePathTemplate?: string } = {}
): TransformersCacheLike => ({
  match: async (request: string): Promise<Response | string | undefined> => {
    const parsed = parseResourceKey(request, env)
    if (!parsed) return undefined
    let result: Uint8Array | string | Response | undefined
    try {
      result = await hook(parsed)
    } catch {
      // A throwing hook must not abort the load — fall through to the normal HF fetch.
      return undefined
    }
    if (result === undefined) return undefined
    if (typeof result === 'string') return result
    if (isInstanceOf(result, 'Response', Response)) return result
    // Uint8Array → Response. Cast keeps us off a hard DOM/Node BodyInit lib dependency.
    return new Response(result as unknown as BodyInit)
  },
  // No-op: served resources are not re-stored (the loader only caches its own remote downloads).
  put: async (): Promise<void> => undefined,
})

// ── Module-level async mutex (env is a global singleton) ───────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve()

/**
 * Install a model-source hook on `env` and return a restore function. Sets `useCustomCache = true` +
 * `customCache`, capturing the previous values. The returned `restore()` puts them back. NOT mutex-
 * guarded on its own — use {@link withModelSource} for the scoped, serialized form.
 *
 * @param env - The transformers.js `env` object (from `await import('@huggingface/transformers')`).
 * @param hook - The resolver to install.
 * @returns A function that restores `env`'s prior cache configuration.
 */
export const installModelSource = (
  env: TransformersEnvLike,
  hook: TransformersJsModelSource
): (() => void) => {
  const prevUse = env.useCustomCache
  const prevCache = env.customCache
  env.customCache = modelSourceToCache(hook, {
    remoteHost: env.remoteHost,
    remotePathTemplate: env.remotePathTemplate,
  })
  env.useCustomCache = true
  return () => {
    env.useCustomCache = prevUse
    env.customCache = prevCache
  }
}

/**
 * Run `load()` with `hook` installed on `env`, then restore — serialized against every other
 * `withModelSource` call so concurrent adapter loads never clobber the global `env`. The hook is only
 * active for the duration of `load()`; after it resolves (or rejects) the prior `env` cache config is
 * restored even on error.
 *
 * @param env - The transformers.js `env` object.
 * @param hook - The resolver to install for this load.
 * @param load - The async load operation (e.g. `pipeline(...)` / `from_pretrained(...)`).
 */
export const withModelSource = async <T>(
  env: TransformersEnvLike,
  hook: TransformersJsModelSource,
  load: () => Promise<T>
): Promise<T> => {
  const run = chain.then(async () => {
    const restore = installModelSource(env, hook)
    try {
      return await load()
    } finally {
      restore()
    }
  })
  // Keep the chain alive regardless of this run's outcome (swallow here; caller still sees the result).
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
