import { resolve } from 'path'
import { cpSync } from 'node:fs'
import { defineConfig } from 'vite'
import type { UserConfig, Plugin } from 'vite'

// Standalone build of the LiteRT-LM disposable-Worker engine handler for the docs site.
//
// WHY A SEPARATE BUNDLE (same rationale as webllm-worker.vite.config.mts): spawning the worker inline via
// `new Worker(new URL('./litert_lm_worker.ts', import.meta.url))` makes vite's worker plugin bundle +
// stripLiteral the multi-MB LiteRT lib into the docs app graph (overflows js-tokens, kills docs:build).
// Building it separately keeps @litert-lm/core self-hosted but out of the docs app graph.
//
// CRITICAL — IIFE, NOT ES (diverges from webllm-worker's 'es'). LiteRT's Emscripten glue
// (litertlm_wasm_internal.js) calls importScripts(), which is illegal in a {type:'module'} worker. An IIFE
// bundle has no top-level ES import statements, so it loads in a CLASSIC worker (new Worker(url) WITHOUT
// {type:'module'}) where importScripts() is legal. Proven in bin/_probe (Step-0 GO gate); see
// litert_lm_worker.ts + litert_lm_worker_proxy.ts.
//
// WASM CO-LOCATION — the glue resolves its .wasm via `new URL(".", self.location).href`, RELATIVE to the
// worker's own URL. So the 4 assets at @litert-lm/core/wasm/ (litertlm_wasm_internal.{js,wasm},
// litertlm_wasm_compat_internal.{js,wasm}) MUST sit next to litert-lm-worker.js. A post-build plugin copies
// them into docs/public/repl/ so bin/document.ts's build step (and `vitepress preview`) serves all 5 files.

const BASE_DIR = resolve(__dirname)
const DOCS_DIR = resolve(BASE_DIR, 'docs')
const OUT_DIR = resolve(DOCS_DIR, 'public', 'repl')
const WASM_SRC_DIR = resolve(BASE_DIR, 'node_modules', '@litert-lm', 'core', 'wasm')

// The 4 Emscripten glue + wasm assets the worker's runtime loads by relative URL.
const WASM_ASSETS = [
  'litertlm_wasm_internal.js',
  'litertlm_wasm_internal.wasm',
  'litertlm_wasm_compat_internal.js',
  'litertlm_wasm_compat_internal.wasm',
]

/** Copy the 4 LiteRT wasm assets next to the emitted worker bundle after the build closes. */
function copyLitertWasmPlugin(): Plugin {
  return {
    name: 'copy-litert-wasm',
    apply: 'build',
    closeBundle(): void {
      for (const asset of WASM_ASSETS) {
        cpSync(resolve(WASM_SRC_DIR, asset), resolve(OUT_DIR, asset))
      }
    },
  }
}

export default defineConfig((): UserConfig => {
  return {
    plugins: [copyLitertWasmPlugin()],
    build: {
      // Co-locate with the REPL + WebLLM bundles under public/repl/ (served + gitignored).
      // Do NOT emptyOutDir: that directory also holds adk-repl.es.js, webllm-worker.js, etc.
      outDir: OUT_DIR,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: {
          'litert-lm-worker': resolve(
            DOCS_DIR,
            '.vitepress',
            'theme',
            'components',
            'agent',
            'litert_lm_worker.ts'
          ),
        },
        name: 'litertLmWorker',
        // IIFE → no ES import statements in the emitted file → loadable by a CLASSIC worker (see doc above).
        formats: ['iife'],
        fileName: (_format: string, entry: string) => `${entry}.js`,
      },
      // NB: NO rollupOptions.output.exports (unlike webllm-worker's 'named'). The worker entry has no
      // exports (it only wires self.onmessage), so forcing `exports:'named'` emits an `exports` reference
      // that throws "exports is not defined" the instant the classic worker loads. @litert-lm/core is
      // bundled IN by default (self-hosted, no CDN) — nothing is externalised. Matches the Step-0 probe.
    },
  }
})
