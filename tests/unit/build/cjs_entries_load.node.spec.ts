import { execa } from 'execa'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'

/**
 * Regression for a real, long-standing published-package defect: EVERY `.cjs` entry in
 * `@nhtio/adk` failed to `require()`, in every recent release (verified back through
 * 1.20260901.0). `require('@nhtio/adk')` threw `Cannot find module './exceptions-HASH.js'`
 * (subpaths like `./batteries/llm/claude_code_cli` threw the same shape with a different hash),
 * and a local `pnpm generate` build failed differently — `require_exceptions.createException is
 * not a function` — because the missing chunk loaded as an empty ESM module instead of throwing.
 *
 * Root cause: `build.lib.fileName` in `vite.config.mts` only names ENTRY files (`.mjs`/`.cjs`).
 * Vite/rolldown's lib-mode pipeline picks the extension for shared CHUNKS separately, via
 * `resolveOutputJsExtension(format, sourcePackageJson.type)`, and this repo's SOURCE
 * `package.json` has no `"type"` field — so that function's `type = "commonjs"` default kicks in,
 * which maps the "cjs" format to a plain `.js` extension. But the PUBLISHED `dist/package.json`
 * (written by `bin/package.ts`) sets `"type": "module"` on purpose, so the `.mjs` entries resolve
 * as ESM. That combination means every CJS-format chunk in `dist/` was written with a `.js`
 * extension yet loaded by Node as ESM — exactly backwards for a file a `.cjs` entry `require()`s.
 *
 * The fix (`vite.config.mts`'s `rolldownOptions.output`, now an explicit array of per-format
 * configs) forces `chunkFileNames: '[name]-[hash].cjs'` on the "cjs" format output so every
 * CJS-format chunk gets an unambiguous `.cjs` extension regardless of the package-level `"type"`
 * field, matching what `lib.fileName` already does for entries.
 *
 * Gated to only run once a real build has produced `dist/` — `pnpm run test:node` executes
 * before `Build Library` in CI, so this is normally a local/late-stage check, not part of the gate
 * that runs before a build exists (same convention as `claude_code_cli_wrapper_resolves.node.spec.ts`
 * and `externals_builtins_drift.node.spec.ts`).
 *
 * BUT a silent skip is exactly how this bug went unnoticed for multiple releases: no MR job ever both
 * built `dist/` AND ran these specs against it, so the regression test that would have caught it
 * never actually executed at MR time. `Publishable Import Boundary Enforcement` now runs `pnpm
 * generate` followed by this spec file (see `.gitlab-ci.yml`) and sets `TEST_REQUIRE_DIST: "1"` so
 * that in THAT job a missing `dist/` is a hard failure, not a quiet skip — while local runs without
 * the var still skip harmlessly when `dist/` hasn't been built yet.
 */
const distDir = resolve(__dirname, '../../../dist')
const indexCjsPath = resolve(distDir, 'index.cjs')
const distBuilt = existsSync(indexCjsPath)
// Skip quietly when nothing has built `dist/` yet (local dev, or any job that doesn't build). But
// when `TEST_REQUIRE_DIST=1` (set by `Publishable Import Boundary Enforcement` in .gitlab-ci.yml,
// which runs `pnpm generate` immediately before this spec file), a missing `dist/` must NOT skip —
// it must fail the suite, or this regression test is a no-op in the one job meant to enforce it.
const shouldSkip = !distBuilt && process.env.TEST_REQUIRE_DIST !== '1'

/** Every `.cjs` file under `dist/`, found by walking the tree (not a hand-maintained list). */
const collectCjsFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.cjs')) continue
    out.push(resolve(entry.parentPath, entry.name))
  }
  return out
}

/** Matches a `require("...")` / `require('...')` call's specifier argument. */
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g

// With TEST_REQUIRE_DIST=1 and no dist/, `shouldSkip` is false so the suite below still runs, and
// its first read of `distDir` throws ENOENT — a hard FAIL rather than a pass, which is the point:
// that combination means the CI job's `pnpm generate` step didn't run or didn't produce the
// expected output, and the gate must not silently succeed instead.
describe.skipIf(shouldSkip)('dist/ CJS entries actually load under a plain Node require()', () => {
  it('every relative require() inside a .cjs file targets another .cjs file, never a bare .js chunk', async () => {
    // Static proof that the chunk-naming fix covers ALL emitted chunks, not just the ones the
    // dynamic-require tests below happen to touch transitively. A bare `.js` relative require
    // here would resolve, under `dist/package.json`'s `"type": "module"`, to an ES module with no
    // CJS `exports` binding — the exact defect this test guards against.
    const cjsFiles = await collectCjsFiles(distDir)
    expect(cjsFiles.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const file of cjsFiles) {
      const content = await readFile(file, 'utf-8')
      for (const match of content.matchAll(REQUIRE_RE)) {
        const specifier = match[1]!
        if (!specifier.startsWith('.')) continue // bare specifier: external package or builtin
        if (specifier.endsWith('.cjs')) continue
        offenders.push(`${file} requires "${specifier}"`)
      }
    }

    expect(
      offenders,
      `These .cjs files require a relative specifier that is NOT itself a .cjs file, so it ` +
        `resolves as ESM under "type": "module" and require() either throws or silently returns ` +
        `an empty module object.\n\n${offenders.map((o) => `  - ${o}`).join('\n')}`
    ).toEqual([])
  })

  /**
   * Actually `require()`s each entry in a genuinely separate, plain Node CJS process — not
   * vitest's own transformed loader, which does not reproduce Node's real extension-based module
   * resolution (see the precedent `claude_code_cli_wrapper_resolves.node.spec.ts` for the same
   * reasoning applied to the ESM side).
   */
  const requireInRealNodeProcess = async (specifier: string): Promise<number> => {
    const script = `
      const m = require(${JSON.stringify(specifier)})
      process.stdout.write(String(Object.keys(m).length))
    `
    const result = await execa(process.execPath, ['--eval', script], { cwd: distDir })
    return Number(result.stdout.trim())
  }

  it.each([
    'index.cjs',
    'common.cjs',
    'batteries/validation.cjs',
    'batteries/llm/claude_code_cli.cjs',
    'batteries/llm/claude_code_cli/adapter.cjs',
  ])('require("./%s") resolves to a populated module, not an empty/missing one', async (rel) => {
    const keyCount = await requireInRealNodeProcess(`./${rel}`)
    expect(keyCount).toBeGreaterThan(0)
  })

  it('the .cjs wrapper prints a ready event on stdout, matching the .mjs wrapper', async () => {
    const wrapperCjsPath = resolve(distDir, 'claude-code-cli-wrapper.cjs')
    const child = execa(process.execPath, [wrapperCjsPath], {
      cleanup: true,
      reject: false,
      input: '',
    })

    const ready = await new Promise<boolean>((resolvePromise) => {
      let buffer = ''
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf-8')
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.trim().length === 0) continue
          try {
            const parsed = JSON.parse(line) as { type?: string }
            if (parsed.type === 'ready') {
              resolvePromise(true)
              return
            }
          } catch {
            // not yet a complete line — keep buffering
          }
        }
      }
      child.stdout?.on('data', onData)
      setTimeout(() => resolvePromise(false), 10_000)
    })

    expect(ready).toBe(true)

    child.kill('SIGKILL')
    await child.catch(() => undefined)
  }, 15_000)
})
