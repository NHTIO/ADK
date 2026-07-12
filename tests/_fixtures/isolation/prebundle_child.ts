import { join } from 'node:path'
import * as esbuild from 'esbuild-wasm'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'

/**
 * Prebundle a TypeScript guest fixture (importing `@nhtio/adk` `src/` paths) into a runnable CJS
 * file `node:child_process.fork()` can load directly.
 *
 * @remarks
 * `fork()` needs a runnable JS module; the isolation battery's test fixtures are TypeScript importing
 * `src/` paths (via the `@nhtio/adk` alias), which node cannot load un-transpiled. This harness
 * resolves that with `esbuild-wasm` (already a devDependency): `bundle: true` inlines every `src/`
 * import into one self-contained file, so `fork()` gets a plain script with no further module
 * resolution to do.
 *
 * Two format/target decisions were verified empirically rather than assumed:
 *
 * - **`format: 'cjs'`, not `'esm'`.** An ESM bundle of this dependency graph crashes at runtime with
 *   `Error: Dynamic require of "crypto" is not supported` — `js-sha256` (pulled in transitively via
 *   `@nhtio/encoder`/the codec's hashing) has a CJS-style `require('crypto')` fallback that esbuild's
 *   ESM output wraps in a shim node's ESM loader rejects. Bundling as CJS avoids that shim entirely and
 *   was confirmed to run correctly end-to-end (the bundled fixture emits the real `{"t":"ready",...}`
 *   envelope over `process.send`).
 * - **`external: ['knex', ...]`.** `@nhtio/validation` has an unreached `await import('knex')` branch
 *   (a DB-validator path never exercised by this fixture) that esbuild still needs to resolve at
 *   bundle time even though the code path never runs; `@nhtio/encoder`/its `type_guards` submodule ARE
 *   exercised (the "function-carrying options bag" spec forces the codec's tier-1 escalation, which
 *   dynamically `import()`s the encoder at runtime), but are still external'd rather than bundled — an
 *   optional peer dependency should be resolved by node's own module resolution, not inlined.
 *
 * That last point drove the temp-directory choice below: the bundle is written under this repo's own
 * `tmp/` (gitignored, see `.gitignore`), NOT `os.tmpdir()`. Node's `import()`/`require()` resolves a
 * bare specifier by walking up `node_modules` directories starting from the importing file's location;
 * a file under `/var/folders/...` (or equivalent OS temp root) has no `node_modules` anywhere in its
 * ancestry, so the externalized `@nhtio/encoder` import fails at runtime with `MODULE_NOT_FOUND` inside
 * the forked child even though `pnpm install` put it right there in the repo (empirically confirmed:
 * moving the bundle under the repo root, where the walk reaches `<repo>/node_modules`, fixes it).
 *
 * The esbuild-wasm service is started once (module-level) and reused across every `prebundleChild`
 * call; callers are expected to `beforeAll`-cache the bundle path itself per entry point (bundling is
 * not free) and `afterAll`-delete the temp file.
 */

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'stream/web',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]

const EXTERNAL = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((m) => `node:${m}`),
  'knex',
  '@nhtio/encoder',
  '@nhtio/encoder/type_guards',
]

/** Repo root, resolved relative to this fixture file (`tests/_fixtures/isolation/`). */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const SRC_DIR = join(REPO_ROOT, 'src')
/** Repo-local scratch root for bundled children — see this module's remarks for why this must live
 *  under the repo (where `node_modules` is reachable) rather than the OS temp directory. */
const SCRATCH_ROOT = join(REPO_ROOT, 'tmp', 'isolation-child-process-specs')

/** A prebundled guest entry point ready for `child_process.fork()`. */
export interface PrebundledChild {
  /** Absolute path to the bundled `.cjs` file — pass this to `fork()`. */
  readonly modulePath: string
  /** Delete the temp directory holding the bundle. Safe to call multiple times. */
  dispose(): Promise<void>
}

/**
 * Bundle `entryPath` (an absolute path to a `.ts` guest entry module, e.g. `echo_child.ts`) into a
 * runnable CJS file under a fresh temp directory. See this module's remarks for the format/external
 * decisions. Callers should cache the result across a test file's specs (bundling on every test is
 * needlessly slow) and `dispose()` it in `afterAll`.
 */
export const prebundleChild = async (entryPath: string): Promise<PrebundledChild> => {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, 'child-'))
  const outfile = join(dir, 'child.cjs')
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    alias: {
      '@nhtio/adk': SRC_DIR,
    },
    external: EXTERNAL,
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (!output) {
    throw new Error(`esbuild produced no output bundling ${entryPath}`)
  }
  await writeFile(outfile, output.contents)
  return {
    modulePath: outfile,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
