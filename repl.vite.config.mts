import { resolve } from 'path'
import { defineConfig } from 'vite'
import { readFile } from 'fs/promises'
import type { UserConfig } from 'vite'

// Standalone build of @nhtio/adk for the docs playground (REPL).
//
// This produces a single self-contained ESM bundle at docs/public/repl/adk-repl.es.js
// that the docs site serves as a static asset and the QuickstartDemo loads at
// runtime by URL. Compiling the library SEPARATELY (rather than aliasing
// @nhtio/adk -> src/ inside the docs app) keeps the entire ADK source graph out
// of the docs app's own module graph — that eager-evaluation is what overflowed
// the JS call stack on iOS WebKit pre-hydration. See docs/.vitepress/repl/index.ts.

const BASE_DIR = resolve(__dirname)
const SRC_DIR = resolve(BASE_DIR, 'src')
const DOCS_DIR = resolve(BASE_DIR, 'docs')

export default defineConfig(async (): Promise<UserConfig> => {
  const rawPackageJson = await readFile(resolve(BASE_DIR, 'package.json'), 'utf-8')
  const packageJson = JSON.parse(rawPackageJson)

  return {
    define: {
      // src references __VERSION__; without this define the build fails.
      __VERSION__: JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        // Resolve @nhtio/adk to local source so the bundle compiles THIS repo's
        // library (cycles resolved by Rollup, exactly as a published build).
        '@nhtio/adk/': `${SRC_DIR}/`,
        '@nhtio/adk': resolve(SRC_DIR, 'index.ts'),
        // @nhtio/validation carries an optional knex path; stub it like the docs app.
        'knex': resolve(DOCS_DIR, '.vitepress', 'stubs', 'knex.ts'),
      },
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    build: {
      outDir: resolve(DOCS_DIR, 'public', 'repl'),
      emptyOutDir: true,
      sourcemap: true,
      lib: {
        entry: { 'adk-repl': resolve(DOCS_DIR, '.vitepress', 'repl', 'index.ts') },
        name: 'adk-repl',
        formats: ['es'],
        fileName: (_format: string, entry: string) => `${entry}.es.js`,
      },
      rollupOptions: {
        // INVERTED externals vs vite.config.mts: bundle @nhtio/adk + @nhtio/validation
        // IN (that's the whole point). Externalize ONLY vue. Do NOT externalize
        // @mlc-ai/web-llm — the bundle is loaded by URL with no Vite/import-map
        // resolution, so a bare `import('@mlc-ai/web-llm')` would be unresolvable at
        // runtime. Bundling it lets Rollup emit a RELATIVE lazy chunk in public/repl/
        // that resolves relative to the bundle URL (base-agnostic). It only loads if
        // the adapter's fallback CreateMLCEngine path runs (the playground supplies
        // its own createEngine, so it's effectively a dead lazy chunk).
        external: ['vue'],
        output: {
          exports: 'named',
        },
        // Conservative treeshake so validator / adapter module side effects survive.
        treeshake: {
          moduleSideEffects: true,
          propertyReadSideEffects: true,
        },
      },
    },
  }
})
