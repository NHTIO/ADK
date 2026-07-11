import { resolve } from 'path'
import { defineConfig } from 'vite'
import type { UserConfig } from 'vite'

// STEP-0 probe bundle (throwaway). Clones webllm-worker.vite.config.mts: vite LIB mode, single ES
// entry, self-hosted (engine bundled in, externalise nothing), output to docs/public/repl so the
// running preview server serves it. emptyOutDir:false — that dir holds adk-repl.es.js etc.

const BASE_DIR = resolve(__dirname, '..', '..')
const DOCS_DIR = resolve(BASE_DIR, 'docs')

export default defineConfig((): UserConfig => {
  return {
    build: {
      outDir: resolve(DOCS_DIR, 'public', 'repl'),
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: { 'litert-probe-worker-iife': resolve(__dirname, 'litert_probe_worker.ts') },
        name: 'litertProbeWorker',
        // IIFE output → no ES import statements in the emitted file → loadable by a CLASSIC worker
        // (new Worker(url) WITHOUT {type:'module'}), which supports importScripts() — the API the
        // LiteRT Emscripten glue (litertlm_wasm_internal.js) calls. A module worker forbids it.
        formats: ['iife'],
        fileName: (_format: string, entry: string) => `${entry}.js`,
      },
    },
  }
})
