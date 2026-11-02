/**
 * Build-guard #2 (GitLab issue #29, item 9): `@module` leaf-basename collisions.
 *
 * CONTRIBUTING's "Subpath collision rule (`vite-plugin-dts`)" says the rollup-types step writes each
 * entry's rolled-up `.d.ts` to `dist/<basename(key)>.d.ts`, so two entries sharing a leaf basename
 * collide and "the second writer wins". 17 such duplicates existed when the issue was filed
 * (exceptions, types, forge, conformance, in_memory, …); this branch's plugin subpaths add an 18th
 * (`lint`).
 *
 * THAT IS NOT HOW THE CURRENT BUILD EMITS TYPES. `bin/package.ts` computes each export's `types`
 * condition from the entry's SOURCE path (`typesPathFor`: `src/batteries/context/exceptions.ts` →
 * `./batteries/context/exceptions.d.ts`), because `dtsComplex` emits `.d.ts` mirroring the full
 * source tree rather than flattening to `basename(key)`. Verified against a real `pnpm generate`:
 * every member of every duplicate leaf has its own complete `.d.ts` in `dist`, and every export's
 * `types` condition points at its own file. So the 17 duplicates are HARMLESS today and this guard
 * does not fail on them.
 *
 * The HARMFUL case is precisely "two entries whose computed `types` path is the same file" — one
 * rolled-up declaration would be written twice and one export would silently describe another
 * module. That is what this guard asserts, in four parts:
 *
 *   1. `getEntries`' own duplicate-KEY throw still works (pinned on a fixture, so this guard is
 *      never mistaken for its replacement).
 *   2. Every entry's computed `types` path is unique — nothing can be overwritten.
 *   3. When `dist/` is present, every entry's `types` path resolves to a file that exists and is
 *      non-empty, and each duplicate-leaf group's members land in DIFFERENT files — the empirical
 *      proof that the benign duplicates really are benign.
 *   4. The tree-mirrored layout itself is pinned, in two halves: the build config text always
 *      (`dtsComplex(`, no `rollupTypes: true`), and the resulting on-disk layout when `dist/` is
 *      present. If the pipeline ever changes to a flat-basename emit, leaf basenames become
 *      load-bearing, CONTRIBUTING's collision rule revives, and this file must be replaced by a
 *      leaf-basename conflict check — not left asserting a dead invariant.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { relative, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { getEntries } from '../../../bin/utils/index'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'

const BASE_DIR = resolve(__dirname, '../../..')
const SRC_DIR = resolve(BASE_DIR, 'src')
const DIST_DIR = resolve(BASE_DIR, 'dist')
const PKG_NAME = '@nhtio/adk'

/**
 * The `types` condition of a published export, exactly as `bin/package.ts`'s `typesPathFor`
 * computes it from an entry's source path.
 */
const typesPathFor = (sourceAbsPath: string): string => {
  const rel = relative(SRC_DIR, sourceAbsPath).replace(/\\/g, '/')
  return `./${rel.replace(/\.ts$/, '.d.ts')}`
}

const leafOf = (key: string): string => key.split('/').pop() ?? key

/**
 * Whether `dist/` was built AFTER this branch's plugin subpaths existed.
 *
 * A bare `existsSync(dist)` is not enough: a stale `dist/` from before the branch would make the
 * on-disk assertions below fail on missing files rather than skip. The package manifest is written
 * last by `bin/package.ts`, so its exports map is the cheapest proof that a full `pnpm generate`
 * completed against the current source.
 */
const distIsFresh = (): boolean => {
  const manifest = resolve(DIST_DIR, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      exports?: Record<string, unknown>
    }
    return ['./batteries/media/lint', './batteries/sandbox/lint', './batteries/skills/lint'].every(
      (key) => key in (parsed.exports ?? {})
    )
  } catch {
    return false
  }
}

// Same convention as `cjs_entries_load.node.spec.ts`: `dist/`-backed assertions run only once a
// build has happened. `pnpm run test:node` runs BEFORE any build exists, so locally they skip;
// `Publishable Import Boundary Enforcement` sets TEST_REQUIRE_DIST=1 right after `pnpm generate`,
// where a skip would be a silent no-op — so there it is a hard failure instead.
const distBuilt = distIsFresh()
if (process.env.TEST_REQUIRE_DIST === '1' && !distBuilt) {
  throw new Error(
    `TEST_REQUIRE_DIST=1 but ${resolve(DIST_DIR, 'package.json')} does not export the branch's ` +
      'lint subpaths — run `pnpm generate` first.'
  )
}

describe('@module leaf-basename collisions', () => {
  it('fixture: getEntries still throws when two files claim the same module key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-entries-'))
    const tag = `/** @module ${PKG_NAME}/same */`
    await writeFile(join(dir, 'a.ts'), `${tag}\nexport const a = 1`, 'utf8')
    await writeFile(join(dir, 'b.ts'), `${tag}\nexport const b = 2`, 'utf8')
    await expect(getEntries(dir, PKG_NAME)).rejects.toThrow('Duplicate entry: same')
  })

  it('two entries never compute the same `types` output path', async () => {
    const entries = await getEntries(SRC_DIR, PKG_NAME)
    expect(Object.keys(entries).length).toBeGreaterThan(100)
    const byTypesPath = new Map<string, string[]>()
    for (const [key, file] of Object.entries(entries)) {
      const typesPath = typesPathFor(file)
      byTypesPath.set(typesPath, [...(byTypesPath.get(typesPath) ?? []), key])
    }
    const conflicts = [...byTypesPath].filter(([, keys]) => keys.length > 1)
    expect(
      conflicts,
      'Two or more @module entries resolve to the SAME `types` path in the published exports map, ' +
        'so one rolled-up .d.ts would be written twice and one export would silently describe ' +
        'another module (the "second writer wins" collision CONTRIBUTING warns about). Rename one ' +
        'subpath so every entry emits a distinct .d.ts:\n\n' +
        conflicts.map(([t, keys]) => `  - ${t} ← ${keys.join(', ')}`).join('\n')
    ).toEqual([])
  })

  it('the build is still configured to emit tree-mirrored .d.ts (the layout this guard assumes)', async () => {
    // Guard 3 above is only sound while types are emitted at the full source-tree path. A switch
    // back to a flat-basename emit would make leaf basenames load-bearing again. The flat
    // basename-only layout is detectable: under it, `dist/exceptions.d.ts` would be the ONLY
    // exceptions declaration. Assert the mirror layout instead, on the build config text, so this
    // fails at the moment somebody swaps the pipeline rather than months later.
    //
    // This half is a pure text check on the checked-in config, so it runs everywhere, including
    // `pnpm run test:node` in `Core Node.JS Functionality Check`, which never builds `dist/`. The
    // on-disk half of the same invariant lives in the `distBuilt`-gated test below.
    const config = await readFile(resolve(BASE_DIR, 'vite.config.mts'), 'utf8')
    expect(config).toContain('dtsComplex(')
    expect(config).not.toMatch(/rollupTypes:\s*true/)
  })

  it.skipIf(!distBuilt)('the emitted build really mirrors the source tree', async () => {
    // The config-text assertion above proves intent; this proves the OUTPUT. A stale `dist/` from
    // before the mirror layout, or a pipeline change that flattens declarations without touching
    // the config text, is only visible on disk — so it is gated on a fresh build, exactly like the
    // duplicate-leaf test below (and like `cjs_entries_load.node.spec.ts`).
    const mirrored = resolve(DIST_DIR, 'batteries/context/exceptions.d.ts')
    expect(
      existsSync(mirrored),
      `${mirrored} is missing: types no longer mirror the source tree`
    ).toBe(true)
  })

  it.skipIf(!distBuilt)(
    'duplicate leaf basenames exist but each lands in its own declaration file',
    async () => {
      const entries = await getEntries(SRC_DIR, PKG_NAME)
      const groups = new Map<string, string[]>()
      for (const key of Object.keys(entries)) {
        const leaf = leafOf(key)
        groups.set(leaf, [...(groups.get(leaf) ?? []), key])
      }
      const duplicates = [...groups].filter(([, keys]) => keys.length > 1)
      // 17 groups predate this branch (issue #29's count); the 18th is `lint`, added by it (the
      // media/sandbox/skills plugin subpaths). All are harmless under the tree-mirrored dts layout
      // proven above. If this count changes, a subpath was added or renamed — re-audit rather than
      // silently accepting a new collision candidate.
      expect(duplicates.length).toBe(18)

      for (const [leaf, keys] of duplicates) {
        const typesPaths = keys.map((key) => typesPathFor(entries[key]!))
        expect(new Set(typesPaths).size, `${leaf}: ${typesPaths.join(', ')}`).toBe(keys.length)
        for (const typesPath of typesPaths) {
          const abs = resolve(DIST_DIR, typesPath.replace(/^\.\//, ''))
          expect(existsSync(abs), `${abs} missing after pnpm generate`).toBe(true)
          const { size } = await stat(abs)
          expect(size, `${abs} is empty`).toBeGreaterThan(0)
        }
      }
    }
  )
})
