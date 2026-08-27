import { resolve } from 'path'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { readFile } from 'fs/promises'
import { getEntries } from './bin/utils'
import { builtinModules } from 'node:module'
import { defineConfig, loadEnv } from 'vite'
import { playwright } from '@vitest/browser-playwright'
import { dtsComplex } from '@nhtio/vite-plugins/dts_complex'
import type { Plugin, UserConfig } from 'vite'

const LIB_NAME = '@nhtio/adk'
const BASE_DIR = resolve(__dirname)
const SRC_DIR = resolve(BASE_DIR, 'src')

// remark's transitive dep resolves to `index.dom.js` under the `browser` export condition, which
// calls `document.createElement()` at import time — fatal inside a real Web Worker (the isolation
// battery specs load `@nhtio/adk` source in a module Worker; workers have no `document`). Pin the
// worker-safe non-DOM build (the package's own `worker`/`default` condition) — it works identically
// on the page. Resolved through remark's own dependency chain because pnpm does not hoist
// transitive deps to the root node_modules.
const decodeNamedCharacterReferencePath = createRequire(
  createRequire(createRequire(resolve(BASE_DIR, 'package.json')).resolve('remark')).resolve(
    'remark-parse'
  )
).resolve('decode-named-character-reference')

/**
 * Dev-server middleware that serves PREBUNDLED isolation-battery worker fixtures at
 * `/@isolation-worker/<fixture>.js`.
 *
 * Why not let the Vite dev server's native module-Worker support serve them? WebKit. Its worker
 * module loader recurses per import edge and stack-overflows (`RangeError: Maximum call stack size
 * exceeded`) on the deep un-bundled ESM graph the dev server serves for `@nhtio/adk` source
 * (empirically: a worker importing `@nhtio/adk/guards` alone loads fine, `@nhtio/validation` alone
 * loads fine, both together crash before a single line of fixture code runs — chromium and firefox
 * handle the identical graph fine). Bundling to a single flat file sidesteps the recursion
 * entirely; this is the browser analogue of WP3's esbuild-wasm prebundle for `child_process.fork()`
 * (`tests/_fixtures/isolation/prebundle_child.ts`).
 */
const isolationWorkerPrebundle = (): Plugin => {
  const PREFIX = '/@isolation-worker/'
  const fixtureDir = resolve(BASE_DIR, 'tests/_fixtures/isolation')
  const cache = new Map<string, Promise<string>>()
  const bundle = async (name: string): Promise<string> => {
    const esbuild = await import('esbuild-wasm')
    const entry = resolve(fixtureDir, `${name}.ts`)
    if (!existsSync(entry)) throw new Error(`unknown isolation worker fixture: ${name}`)
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      alias: {
        // The wide `guards`/`factories` barrels re-export from modules with top-level side effects
        // (tokenizer instantiation and friends), so esbuild cannot tree-shake them — bundling them
        // drags in ~19MB of tokenizer tables the isolation battery never touches. Alias the two
        // barrels straight to the concrete implementation modules that define everything isolation
        // actually imports (isInstanceOf/isError/isObject and createException, respectively).
        '@nhtio/adk/guards': resolve(SRC_DIR, 'lib/utils/guards.ts'),
        '@nhtio/adk/factories': resolve(SRC_DIR, 'lib/utils/exceptions.ts'),
        '@nhtio/adk': SRC_DIR,
        'knex': resolve(BASE_DIR, 'tests/_fixtures/knex_browser_stub.ts'),
        'decode-named-character-reference': decodeNamedCharacterReferencePath,
      },
      // The codec's `@nhtio/encoder` peer is a LAZY dynamic import that only runs when a value
      // escalates past the raw tier — the specs never do, so leave it external rather than inflate
      // the bundle (the guest's availability probe handles the unresolvable bare specifier).
      external: ['@nhtio/encoder', '@nhtio/encoder/type_guards'],
      logLevel: 'silent',
    })
    const out = result.outputFiles?.[0]
    if (!out) throw new Error(`esbuild produced no output for ${entry}`)
    return out.text
  }
  return {
    name: 'adk:isolation-worker-prebundle',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Vite's `new URL('/...', import.meta.url)` asset transform re-roots the absolute path under
        // `/@fs/` in the served module, so accept the prefix at either position.
        const url = (req.url ?? '').replace(/^\/@fs/, '')
        if (!url.startsWith(PREFIX)) return next()
        const name = url.slice(PREFIX.length).replace(/\.js(\?.*)?$/, '')
        if (!/^[a-z0-9_]+$/.test(name)) {
          res.statusCode = 400
          res.end('bad isolation worker fixture name')
          return
        }
        let job = cache.get(name)
        if (!job) {
          job = bundle(name)
          cache.set(name, job)
        }
        job.then(
          (code) => {
            res.setHeader('content-type', 'text/javascript')
            res.end(code)
          },
          (err) => {
            cache.delete(name)
            res.statusCode = 500
            res.end(String(err))
          }
        )
      })
    },
  }
}
// Every node: builtin (and its bare-specifier alias, e.g. `crypto` as well as `node:crypto`) must
// be external — never bundled, never left for rolldown/Vite to fall through to the browser-external
// stub (`module.exports = {}`), which silently turns `os.tmpdir` etc. into `undefined` instead of
// failing to resolve. Hand-maintaining this list previously missed `node:os`/`node:crypto` (issue
// #12: NativeTtsAdapter's `synthesize()` always threw `os.tmpdir is not a function` in the published
// bundle) — generate it exhaustively from `node:module`'s own builtin list instead of enumerating by
// hand, so no builtin subpath can silently fall through again.
// Exported (not just module-local) so tests/unit/build/externals_builtins_drift.node.spec.ts can
// assert every node: builtin is actually present, rather than re-deriving the same expression and
// only proving it agrees with itself.
export const externals = new Set<string>([
  ...builtinModules.flatMap((name) => [name, `node:${name}`]),
  'knex',
])
const nonExternal = new Set<string>([])

type BuildStartHook = (...args: never[]) => unknown
type BuildStartObjectHook = { handler: BuildStartHook }
type BuildStartPlugin = { buildStart?: BuildStartHook | BuildStartObjectHook }

const oncePerBuild = <T extends unknown>(plugin: T): T => {
  let hasStarted = false
  const plugins = (Array.isArray(plugin) ? plugin : [plugin]) as BuildStartPlugin[]
  plugins.forEach((entry) => {
    const buildStart = entry.buildStart
    if (!buildStart) return
    entry.buildStart = async function (this: unknown, ...args: never[]) {
      if (hasStarted) return
      hasStarted = true
      if (typeof buildStart === 'function') {
        return await buildStart.apply(this, args)
      }
      return await buildStart.handler.apply(this, args)
    }
  })
  return plugin
}

export default defineConfig(async ({ mode }) => {
  // Load app-level env vars to node-level env vars.
  process.env = {
    ...process.env,
    ...loadEnv(mode, process.cwd(), ['VITE_', 'CI', 'CI_', 'GITLAB_', 'TEST_']),
  }

  const entries = await getEntries(SRC_DIR, LIB_NAME)
  const rawPackageJson = await readFile(resolve(BASE_DIR, 'package.json'), 'utf-8')
  const packageJson = JSON.parse(rawPackageJson.toString())
  if (packageJson.dependencies) {
    Object.keys(packageJson.dependencies).forEach((dep) => {
      externals.add(dep)
    })
  }
  // Peer dependencies (battery-only deps marked as `optional: true` in peerDependenciesMeta)
  // must also be externalised so the build never inlines them into dist/. Consumers who
  // deep-import a battery install the matching peer themselves; if they didn't, we want the
  // runtime resolver to fail clean with `Cannot find module 'mathjs'` rather than us shipping
  // a copy of mathjs in the bundle.
  if (packageJson.peerDependencies) {
    Object.keys(packageJson.peerDependencies).forEach((dep) => {
      externals.add(dep)
    })
  }
  if (packageJson.nonExternal) {
    packageJson.nonExternal.forEach((mod: string) => {
      nonExternal.add(mod)
    })
  }
  const external = Array.from(externals).filter((ext) => !nonExternal.has(ext))
  const declarationExternal = [...external, '@types/luxon']
  // `dtsComplex` takes `bundledDependencies` directly rather than computing it from
  // `devDependencies` minus externals the way the legacy `dts` wrapper did. Compute the same set
  // here so the two pipelines produce the same vendor-bundling decisions.
  const declarationExternalSet = new Set(declarationExternal)
  const bundledDependencies = Object.keys(packageJson.devDependencies ?? {}).filter(
    (dep) => !declarationExternalSet.has(dep)
  )
  return {
    plugins: [
      isolationWorkerPrebundle(),
      oncePerBuild(
        dtsComplex({
          bundledDependencies,
          packageJsonPath: resolve(BASE_DIR, 'package.json'),
          tsConfigJsonPath: resolve(BASE_DIR, 'tsconfig.build.json'),
        })
      ),
    ],
    build: {
      sourcemap: true,
      minify: false,
      lib: {
        entry: {
          ...entries,
          'adk-mcp': resolve(SRC_DIR, 'mcp/server.ts'),
          'claude-code-cli-wrapper': resolve(SRC_DIR, 'batteries/llm/claude_code_cli/wrapper.ts'),
        },
        name: LIB_NAME,
        formats: ['es', 'cjs'],
        fileName: (format: string, entry: string) => {
          switch (format) {
            case 'es':
              return `${entry}.mjs`
            case 'cjs':
              return `${entry}.cjs`
            default:
              return `${entry}.${format}.js`
          }
        },
      },
      rolldownOptions: {
        external,
        output: {
          exports: 'named',
        },
        treeshake: {
          annotations: true,
          moduleSideEffects: true,
          propertyReadSideEffects: 'always',
          propertyWriteSideEffects: 'always',
          unknownGlobalSideEffects: true,
        },
      },
      emptyOutDir: false,
    },
    resolve: {
      alias: {
        [LIB_NAME]: resolve(BASE_DIR, 'src'),
        '@': resolve(BASE_DIR, 'src'),
        // See the comment on optimizeDeps.exclude below for why `knex` is stubbed.
        'knex': resolve(BASE_DIR, 'tests/_fixtures/knex_browser_stub.ts'),
      },
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    define: {
      __VERSION__: JSON.stringify(packageJson.version),
      // The flagship agent modules (docs/.vitepress/theme/components/agent/*) reference the wiretap
      // build-define with bare `if (__ADK_WIRETAP__)`. It is normally injected by the docs vite config;
      // under vitest (the portable Node agent harness spec) it is otherwise undefined and throws. Pin it
      // OFF for tests — matches the released docs build (ADK_DOCS_RELEASE=1).
      __ADK_WIRETAP__: false,
      // TEST_*-prefixed env vars are loaded from .env.test by `loadEnv` above and inlined here
      // as a single object so browser-project tests can read them (browsers have no
      // `process.env`). Node-project tests can still use `process.env.TEST_*` directly. Empty
      // object when no TEST_* vars are present.
      __TEST_ENV__: JSON.stringify(
        Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TEST_')))
      ),
    },
    // `@nhtio/validation` declares an `await import('knex')` for a database-validator path
    // that's never reached by our test code. vite still needs to resolve the bare specifier
    // at module-graph time, so we alias it to an empty stub in the test environments only.
    // The stub throws on call (which never happens, because the validator is never used).
    optimizeDeps: {
      exclude: ['knex'],
    },
    test: {
      // Settings here apply to every project unless explicitly overridden.
      dangerouslyIgnoreUnhandledErrors: true,
      reporters: process.env.CI ? ['default', 'junit'] : ['default'],
      outputFile: {
        junit: resolve(BASE_DIR, 'junit.xml'),
      },
      typecheck: {
        enabled: true,
      },
      testTimeout: 60_000,
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
        '**/.gitlab-ci-local/**',
      ],
      // ── Multi-environment test layout ──────────────────────────────────────
      //
      // File-name suffix is the env tag:
      //   *.cross.spec.ts  — cross-env; collected by BOTH the node and browser projects
      //   *.node.spec.ts   — node-only; collected only by the node project
      //   *.browser.spec.ts — browser-only; collected only by the browser project
      //
      // The harness core and every bundled tool battery are cross-env by design — they ship
      // to consumers in either runtime. Storage drivers are env-specific (flydrive uses
      // `node:stream`; an IndexedDB driver would be browser-only).
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['tests/**/*.cross.spec.ts', 'tests/**/*.node.spec.ts'],
          },
        },
        {
          extends: true,
          resolve: {
            alias: {
              // The root mainFields override skips package `browser` fields; exceljs needs
              // its browser bundle in this project (the Node entry touches `process`).
              'exceljs': resolve(BASE_DIR, 'node_modules/exceljs/dist/exceljs.min.js'),
              // See the const's doc comment near the top of this file — worker-safe non-DOM build.
              'decode-named-character-reference': decodeNamedCharacterReferencePath,
            },
          },
          test: {
            name: { label: 'browser', color: 'green' },
            include: ['tests/**/*.cross.spec.ts', 'tests/**/*.browser.spec.ts'],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
            },
          },
        },
        // ── browser-webgpu: HEADED real-GPU project for the on-device model matrix ──
        // Only instantiated when TEST_MATRIX_BROWSER is set (via `pnpm run test:matrix:browser`), so it
        // NEVER runs in normal CI/`test:browser` — shared runners have no GPU, and a headed Chromium
        // can't launch there. Headed + `--enable-unsafe-webgpu` is what gives `navigator.gpu` a real
        // adapter so LiteRT-LM / transformers.js-webgpu actually execute. Collects only `*.webgpu.spec.ts`.
        ...(process.env.TEST_MATRIX_BROWSER
          ? [
              {
                extends: true as const,
                test: {
                  name: { label: 'browser-webgpu', color: 'magenta' as const },
                  include: ['tests/**/*.webgpu.spec.ts'],
                  testTimeout: 900_000,
                  browser: {
                    enabled: true,
                    provider: playwright({
                      launchOptions: {
                        args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
                      },
                    }),
                    headless: false,
                    instances: [{ browser: 'chromium' }],
                  },
                },
              },
            ]
          : []),
      ],
    },
  } as UserConfig
})
