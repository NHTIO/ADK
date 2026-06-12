import { resolve } from 'path'
import { readFile } from 'fs/promises'
import { getEntries } from './bin/utils'
import { defineConfig, loadEnv } from 'vite'
import { playwright } from '@vitest/browser-playwright'
import { dtsComplex } from '@nhtio/vite-plugins/dts_complex'
import type { UserConfig } from 'vite'

const LIB_NAME = '@nhtio/adk'
const BASE_DIR = resolve(__dirname)
const SRC_DIR = resolve(BASE_DIR, 'src')
const externals = new Set<string>([
  'node:util',
  'node:path',
  'node:process',
  'node:url',
  'node:fs',
  'node:fs/promises',
  'knex',
  'stream',
  'buffer',
  'crypto',
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
              exceljs: resolve(BASE_DIR, 'node_modules/exceljs/dist/exceljs.min.js'),
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
      ],
    },
  } as UserConfig
})
