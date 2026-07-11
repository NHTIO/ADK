import { resolve } from 'path'
import { defineConfig } from 'vite'
import type { UserConfig } from 'vite'

// Standalone build of the WebLLM web-worker handler for the docs site.
//
// WHY A SEPARATE BUNDLE: the worker statically imports `@mlc-ai/web-llm`, whose
// published `lib/index.js` is a single ~6.4MB file. When the docs app spawned the
// worker via `new Worker(new URL('./browser_agent_webllm_worker.ts', import.meta.url))`,
// vite's `vite:worker-import-meta-url` plugin bundled the worker inline AND ran
// `stripLiteral` over those 6.4MB — vite's bundled js-tokens tokenizer overflows the
// call stack on inputs that large (vitejs/vite#15703, the documented >4M-char
// stripLiteral failure), killing `pnpm docs:build`.
//
// Compiling the worker SEPARATELY here — exactly like repl.vite.config.mts does for the
// ADK REPL bundle — keeps web-llm out of the docs app's module graph entirely. The
// output is a self-contained ESM worker at docs/public/repl/webllm-worker.js that the
// docs site serves as a static asset; the app spawns it by URL (no import.meta.url
// rewrite, so the worker plugin never sees it). web-llm stays self-hosted (bundled IN
// here, not externalised) so there is no CDN/runtime-resolution dependency.

const BASE_DIR = resolve(__dirname)
const DOCS_DIR = resolve(BASE_DIR, 'docs')

export default defineConfig((): UserConfig => {
  return {
    build: {
      // Co-locate with the REPL bundle under public/repl/ (already served + gitignored).
      // Do NOT emptyOutDir: that directory also holds adk-repl.es.js from build:repl.
      outDir: resolve(DOCS_DIR, 'public', 'repl'),
      emptyOutDir: false,
      sourcemap: true,
      lib: {
        entry: {
          'webllm-worker': resolve(
            DOCS_DIR,
            '.vitepress',
            'theme',
            'components',
            'dev',
            'browser_agent_webllm_worker.ts'
          ),
        },
        name: 'webllm-worker',
        formats: ['es'],
        fileName: (_format: string, entry: string) => `${entry}.js`,
      },
      rollupOptions: {
        // Bundle web-llm IN (the whole point — self-hosted, no CDN). Externalise nothing.
        output: { exports: 'named' },
      },
    },
  }
})
