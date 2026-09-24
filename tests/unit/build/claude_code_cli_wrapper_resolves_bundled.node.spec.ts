import { execa } from 'execa'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import * as esbuild from 'esbuild-wasm'
import { join, relative, resolve } from 'node:path'
import { getEntries } from '../../../bin/utils/index'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'

/**
 * Issue #40, defect 2 — the real-world main scenario: a consumer BUNDLES the adapter (Electron
 * Forge / esbuild `--platform=node` bundling an Electron main process is the reported shape).
 * `tests/unit/batteries/llm/claude_code_cli/wrapper_path_resolution.node.spec.ts` exercises the
 * fallback resolver's LOGIC through injectable seams (no real bundler involved); this file proves
 * the logic actually works against a REAL esbuild bundle of a REAL, published-shape package built
 * from this repo's own `dist/` — the only way to catch a class of bug like the one that shipped in
 * `b3cd2e5` (`createRequire(import.meta.url)` throwing when `import.meta.url` is `undefined`, which
 * is exactly what esbuild's CJS output produces, and which no seam-level test could have caught
 * since the seams never exercise a real bundler's actual `import.meta`/`require` shims).
 *
 * Pipeline (all inside a single `beforeAll`, cached across this file's tests):
 *
 * 1. Copy the already-built `dist/` (gated on `distBuilt`, same convention as the sibling
 *    `claude_code_cli_wrapper_resolves.node.spec.ts`) into an isolated temp directory — never
 *    mutates the shared `dist/` the rest of the suite relies on.
 * 2. Rewrite the copy's `package.json` with the real PUBLISHED shape: `type: 'module'` plus the
 *    full subpath `exports` map `bin/package.ts` generates from `@module` JSDoc tags. Reuses
 *    `getEntries` (the exact function `bin/package.ts` itself calls, and the same one
 *    `published_subpath_imports.node.spec.ts` already imports directly for the same reason) rather
 *    than re-deriving the map, and rather than invoking the whole `bin/package.ts` script — that
 *    script also copies skills, builds an MCP corpus, and requires `DOCS_SITE_URL`, none of which
 *    this test needs or should depend on.
 * 3. Place that published-shape directory directly at `consumer/node_modules/@nhtio/adk` via a
 *    plain recursive filesystem copy — deliberately NOT `npm pack` + `npm install`. This is the
 *    only test in the repo that used to install a real tarball at test time, which hits the real
 *    npm registry (this test runs inside the MR-gated `TEST_REQUIRE_DIST=1` "Publishable Import
 *    Boundary Enforcement" CI job — see `.gitlab-ci.yml` — where a registry dependency at test time
 *    is exactly the kind of external flakiness/latency that job should not have). A recursive copy
 *    reproduces the same real, on-disk `consumer/node_modules/@nhtio/adk` directory layout an
 *    `npm install` would leave — which is all the resolver-under-test's own `require.resolve('@nhtio/adk')`
 *    / `createRequire(...).resolve('@nhtio/adk')` calls ever actually check (a real package at that
 *    path from the bundle's location) — without touching the network. `@nhtio/adk`'s own production
 *    dependencies (`js-sha256`, `uuid`, `dlv`, `dset`, `@nhtio/validation`, etc.) are never installed
 *    under `consumerDir` either; see step 4 below for how the bundler still resolves them.
 * 4. Bundle a minimal consumer entry — importing `__resolveWrapperPathWithFallback` directly from
 *    `@nhtio/adk/batteries/llm/claude_code_cli/adapter` (skipping the top-level barrel, which pulls
 *    in many more optional peers this test has no reason to install) — with `esbuild-wasm` (already
 *    a real, directly resolvable devDependency; used the same way in this repo's own
 *    `vite.config.mts` and `tests/_fixtures/isolation/prebundle_child.ts`) in BOTH
 *    `--format=esm` and `--format=cjs`, `--platform=node`. Passes esbuild's `nodePaths` option (the
 *    `NODE_PATH`-equivalent search path for its OWN bare-specifier module resolution during
 *    bundling — see `esbuild-wasm`'s `BuildOptions.nodePaths` typing) pointed at THIS REPO's own
 *    already-installed `node_modules`, so `@nhtio/adk`'s production dependencies resolve and get
 *    inlined into the bundle at build time without ever needing to exist under `consumerDir` at
 *    all. `execa`/`knex` are deliberately kept external and genuinely unresolvable here (neither is
 *    installed under `consumerDir` nor exposed via `nodePaths` as a consumer-visible dependency —
 *    only used to satisfy the BUNDLER's own resolution of `@nhtio/adk`'s internals), which is what
 *    makes `--external:execa --external:knex` a realistic simulation of both being optional peers
 *    rather than an artificial one.
 * 5. Run each bundle in a real, separate `node` process via `execa` (never vitest's own SSR
 *    `import()`, which does not reproduce a real bundle's `import.meta.url`/`require` shims — the
 *    same reason the sibling `claude_code_cli_wrapper_resolves.node.spec.ts` insists on a real
 *    child process) and assert the resolved path is the real, copied-in wrapper asset.
 *
 * Coverage note — deployment shapes (see also the `@remarks` on `resolveWrapperPathWithFallback`
 * in `adapter.ts`, which this section restates from the test side): this file proves bundled ESM
 * and bundled CJS resolution against a real, published-shape package directory. It does NOT cover:
 * unbundled ESM/CJS consumption (covered by `claude_code_cli_wrapper_resolves.node.spec.ts` and
 * `published_subpath_imports.node.spec.ts`), an Electron app that asar-packs or prunes `@nhtio/adk`
 * out of its final bundle entirely (not automatable here — see the adapter's own Electron/asar
 * remark), Windows path semantics (this battery is POSIX-only in v1, validated elsewhere), or any
 * bundler other than esbuild (webpack/rollup/parcel are not exercised), or an actual `npm
 * pack`/`npm install` round-trip. That last one is intentional: this file's concern is the resolver,
 * not packaging, and a real install would need the registry. No automated test here exercises the
 * packed tarball's shape; copying `dist/` is faithful for this resolver's purposes because
 * `bin/package.ts` drops the source `files` restriction, so the published tarball ships the same
 * wrapper assets (`claude-code-cli-wrapper.{mjs,cjs}`) that the copy contains.
 *
 * The CJS case's expectations are unconditional and structurally identical to the ESM case. It
 * depends on the CJS chunk-extension build fix (CJS-format chunks emitted as `.cjs`, so a published
 * CJS entry can `require()` them under `dist/package.json`'s `type: 'module'`); without that fix the
 * package fails to even LOAD in CJS before wrapper resolution is ever reached.
 *
 * Gated with the same compound condition requested in review: skipped unless a real `dist/` build
 * already exists (`distBuilt`, mirroring the sibling file's convention) OR the run explicitly opts
 * in via `TEST_REQUIRE_DIST=1`. Not part of `pnpm run test:node`'s CI gate either way — that job
 * runs before `Build Library` in the pipeline (see the sibling file's own docblock), so `distBuilt`
 * is always false there; this is a local/late-stage check.
 */
const BASE_DIR = resolve(__dirname, '../../..')
const SRC_DIR = resolve(BASE_DIR, 'src')
const distDir = resolve(BASE_DIR, 'dist')
const adapterMjsPath = resolve(distDir, 'batteries/llm/claude_code_cli/adapter.mjs')
const wrapperMjsPath = resolve(distDir, 'claude-code-cli-wrapper.mjs')
const distBuilt = existsSync(adapterMjsPath) && existsSync(wrapperMjsPath)

/** Mirrors `bin/package.ts`'s `exports` map derivation exactly (same `getEntries` call), without
 *  running the rest of that script (skills copying / MCP corpus / `DOCS_SITE_URL` requirement). */
const buildPublishedPackageJson = async (): Promise<Record<string, unknown>> => {
  const sourcePkg = JSON.parse(
    await readFile(resolve(BASE_DIR, 'package.json'), 'utf-8')
  ) as Record<string, unknown>
  const entries = await getEntries(SRC_DIR, sourcePkg.name as string)
  if (!('index' in entries)) {
    throw new Error('You cannot package a library without an index entry')
  }
  const typesPathFor = (sourceAbsPath: string) => {
    const rel = relative(SRC_DIR, sourceAbsPath).replace(/\\/g, '/')
    return `./${rel.replace(/\.ts$/, '.d.ts')}`
  }
  const exportsMap: Record<string, { import: string; require: string; types: string }> = {
    '.': {
      import: './index.mjs',
      require: './index.cjs',
      types: typesPathFor(entries.index!),
    },
  }
  for (const key of Object.keys(entries)) {
    if (key === 'index') continue
    exportsMap[`./${key}`] = {
      import: `./${key}.mjs`,
      require: `./${key}.cjs`,
      types: typesPathFor(entries[key]!),
    }
  }
  const published = {
    ...sourcePkg,
    type: 'module',
    main: './index.cjs',
    module: './index.mjs',
    exports: exportsMap,
  } as Record<string, unknown>
  // Mirror `bin/package.ts`'s cleanup exactly: `files` (source restricts to `["src","dist",
  // "CHANGELOG.md"]`, which would make a naive tarball-shape check against a `dist/`-rooted
  // packedDir a no-op — this was caught empirically, not assumed) and
  // `devDependencies`/`scripts`/`resolutions`/`nonExternal` are all deliberately absent from the
  // published shape.
  delete published.files
  delete published.devDependencies
  delete published.scripts
  delete published.resolutions
  delete published.nonExternal
  return published
}

describe.skipIf(!distBuilt && process.env.TEST_REQUIRE_DIST !== '1')(
  'resolveWrapperPathWithFallback() against a real esbuild-bundled, published-shape consumer (issue #40, defect 2)',
  () => {
    let workDir: string
    let consumerDir: string
    let adkDir: string
    let esmOutPath: string
    let cjsOutPath: string

    beforeAll(async () => {
      // `realpath` immediately: on macOS, `os.tmpdir()` is under `/tmp`, itself a symlink to
      // `/private/tmp` — the resolver-under-test reports the REAL (symlink-resolved) path (via
      // `require.resolve`/`createRequire(...).resolve`, both of which realpath internally), so
      // comparing against the un-resolved `mkdtemp` path would spuriously fail on macOS only.
      workDir = await realpath(await mkdtemp(join(tmpdir(), 'adk-bundled-wrapper-')))

      // 1-2: copy dist/, rewrite package.json to the real published shape. This copy IS the
      // package directory placed at `consumer/node_modules/@nhtio/adk` below — no `npm pack`
      // tarball round-trip is needed since nothing downstream inspects a real tarball's contents,
      // only the resulting on-disk directory layout, which a plain recursive copy reproduces
      // exactly.
      const packedDir = join(workDir, 'packed')
      await cp(distDir, packedDir, { recursive: true })
      const publishedPkg = await buildPublishedPackageJson()
      await writeFile(join(packedDir, 'package.json'), JSON.stringify(publishedPkg, null, 2))

      // 3: place that published-shape directory directly at `consumer/node_modules/@nhtio/adk` —
      // a REAL, filesystem-copied package directory (never installed from the registry, never
      // touching npm), so the resolver's own `require.resolve('@nhtio/adk')` /
      // `createRequire(...).resolve('@nhtio/adk')` finds a genuine package at that path exactly as
      // a real `npm install` would leave one.
      consumerDir = join(workDir, 'consumer')
      adkDir = join(consumerDir, 'node_modules', '@nhtio', 'adk')
      await mkdir(join(consumerDir, 'node_modules', '@nhtio'), { recursive: true })
      await cp(packedDir, adkDir, { recursive: true })
      await writeFile(
        join(consumerDir, 'package.json'),
        JSON.stringify({
          name: 'adk-bundled-wrapper-consumer',
          version: '1.0.0',
          private: true,
          type: 'module',
        })
      )
      expect(existsSync(adkDir)).toBe(true)

      // 4: bundle a minimal consumer entry in both formats.
      const entryMjsPath = join(consumerDir, 'entry.mjs')
      await writeFile(
        entryMjsPath,
        [
          "import { __resolveWrapperPathWithFallback } from '@nhtio/adk/batteries/llm/claude_code_cli/adapter'",
          '',
          'const resolved = await __resolveWrapperPathWithFallback()',
          'process.stdout.write(JSON.stringify({ resolved }))',
          '',
        ].join('\n')
      )
      const entryCjsPath = join(consumerDir, 'entry.cjs')
      await writeFile(
        entryCjsPath,
        [
          "const { __resolveWrapperPathWithFallback } = require('@nhtio/adk/batteries/llm/claude_code_cli/adapter')",
          '',
          '__resolveWrapperPathWithFallback().then((resolved) => {',
          '  process.stdout.write(JSON.stringify({ resolved }))',
          '}).catch((err) => {',
          "  process.stderr.write('REJECTED: ' + (err && err.message ? err.message : String(err)) + '\\n')",
          '  process.exit(1)',
          '})',
          '',
        ].join('\n')
      )

      const external = ['execa', 'knex']
      // Points esbuild's OWN bare-specifier module resolution (during bundling, not at runtime) at
      // this repo's own already-installed `node_modules`, so `@nhtio/adk`'s production
      // dependencies resolve and get inlined into the bundle without ever needing to exist under
      // `consumerDir` — see this file's docblock, step 4, for why this is what makes the whole
      // pipeline registry-independent.
      const nodePaths = [resolve(BASE_DIR, 'node_modules')]

      const esmResult = await esbuild.build({
        entryPoints: [entryMjsPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        external,
        nodePaths,
        logLevel: 'silent',
        // `js-sha256`'s internal `require('crypto')` falls through esbuild's injected `__require`
        // shim in plain ESM output (no ambient `require` exists there) and throws "Dynamic require
        // of 'crypto' is not supported" at runtime. A real, functional `require` from
        // `createRequire(import.meta.url)` makes that shim's `typeof require !== "undefined"`
        // branch succeed. Verified empirically; see `tests/_fixtures/isolation/prebundle_child.ts`
        // for the sibling CJS-only workaround to the same underlying issue.
        banner: {
          js: "import { createRequire as __adkCreateRequire } from 'node:module'; const require = __adkCreateRequire(import.meta.url);",
        },
      })
      esmOutPath = join(consumerDir, 'out.esm.mjs')
      await writeFile(esmOutPath, esmResult.outputFiles![0]!.text)

      const cjsResult = await esbuild.build({
        entryPoints: [entryCjsPath],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        external,
        nodePaths,
        logLevel: 'silent',
      })
      // Node treats a bare `.js` output as ESM once the NEAREST package.json (the consumer's own,
      // here) sets `type: 'module'` — the CJS `exports` reference esbuild emits then throws
      // "exports is not defined in ES module scope". `.cjs` is unambiguous regardless of `type`.
      cjsOutPath = join(consumerDir, 'out.cjs')
      await writeFile(cjsOutPath, cjsResult.outputFiles![0]!.text)
    }, 60_000)

    afterAll(async () => {
      if (workDir) await rm(workDir, { recursive: true, force: true })
    })

    it('bundled ESM (esbuild --platform=node --format=esm) resolves the wrapper asset to the real copied-in sibling path', async () => {
      const result = await execa(process.execPath, [esmOutPath], { cwd: consumerDir })
      const parsed = JSON.parse(result.stdout) as { resolved: string }
      const expected = join(adkDir, 'claude-code-cli-wrapper.mjs')
      expect(parsed.resolved).toBe(expected)
      expect(existsSync(parsed.resolved)).toBe(true)
    })

    it('bundled CJS (esbuild --platform=node --format=cjs) resolves the wrapper asset to the real copied-in sibling path', async () => {
      // Unconditional success, structurally identical to the ESM case above. EXPECTED TO FAIL on
      // this branch alone (chunk-extension bug on `fix/cjs-build-output`, not fixed here — see
      // this file's docblock) and expected to PASS once that branch is merged alongside this one.
      const result = await execa(process.execPath, [cjsOutPath], { cwd: consumerDir })
      const parsed = JSON.parse(result.stdout) as { resolved: string }
      const expected = join(adkDir, 'claude-code-cli-wrapper.mjs')
      expect(parsed.resolved).toBe(expected)
      expect(existsSync(parsed.resolved)).toBe(true)
    })
  }
)
