/**
 * EXECUTABLE PACKAGING INVARIANT: every `@nhtio/adk/...` subpath a test imports must actually be
 * exported by the published package.
 *
 * Why this exists — a real, 19-day-latent failure this test would have caught immediately:
 * `tests/_fixtures/scripted_executor.ts` imported `@nhtio/adk/batteries/llm/chat_common/helpers`.
 * That module is deliberately NOT `@module`-tagged (its own docblock says so: "INTERNAL to the
 * bundled LLM batteries ... so it stays a private, inlined module"), and `getEntries` derives the
 * published `exports` map purely from `@module` tags — so the subpath has never existed in the
 * package. Every unit/functional run still passed, because vitest resolves `@nhtio/adk/*` through
 * source aliases rather than through `dist/package.json`.
 *
 * Only the SMOKE jobs install the built package, and they run on master, not on MRs. So the bad
 * import survived every MR pipeline and only surfaced after a merge, taking all four smoke checks
 * and 19 functional suites down at import time with
 * `Missing "./batteries/llm/chat_common/helpers" specifier in "@nhtio/adk" package`.
 *
 * The invariant was documented in prose (in `chat_common/helpers.ts`'s own header) and ignored
 * anyway, because the person adding the import was reading their own file — not that one. This
 * test enforces it at the moment of the mistake instead, in a job that runs on every MR.
 */
import { describe, expect, it } from 'vitest'
import { join, relative, resolve } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { getEntries } from '../../../bin/utils/index'

const BASE_DIR = resolve(__dirname, '../../..')
const SRC_DIR = resolve(BASE_DIR, 'src')
const TESTS_DIR = resolve(BASE_DIR, 'tests')
const PKG_NAME = '@nhtio/adk'

/**
 * Every `from '@nhtio/adk/<subpath>'` / `from '@nhtio/adk'` specifier in a source string.
 *
 * Anchored on a real `import`/`export` statement rather than a bare `from '...'`, so prose in a
 * docblock that merely quotes a specifier is not mistaken for an import (this file's own header
 * would otherwise flag itself).
 */
const IMPORT_RE = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"](@nhtio\/adk(?:\/[^'"]+)?)['"]/gm

const collectTsFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mts')) continue
    out.push(join(entry.parentPath, entry.name))
  }
  return out
}

describe('published subpath imports', () => {
  it('exports every `@nhtio/adk/...` subpath that the test suite imports', async () => {
    // The exact function `bin/package.ts` uses to build the published `exports` map, so this test
    // cannot drift from the real generator.
    const entries = await getEntries(SRC_DIR, PKG_NAME)
    const exported = new Set(
      Object.keys(entries).map((k) => (k === 'index' ? PKG_NAME : `${PKG_NAME}/${k}`))
    )

    const files = await collectTsFiles(TESTS_DIR)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      for (const match of content.matchAll(IMPORT_RE)) {
        const specifier = match[1]!
        if (exported.has(specifier)) continue
        offenders.push(`${relative(BASE_DIR, file)} imports "${specifier}"`)
      }
    }

    expect(
      offenders,
      `These specifiers are NOT in the published package's exports map, so they resolve under ` +
        `vitest (source aliases) but throw "Missing ... specifier" once the built package is ` +
        `installed — which is exactly what the smoke jobs do.\n\n` +
        `Fix by importing the symbol from a subpath whose module IS \`@module\`-tagged (check for a ` +
        `battery barrel that re-exports it), NOT by adding an \`@module\` tag to a module that is ` +
        `deliberately private.\n\n` +
        offenders.map((o) => `  - ${o}`).join('\n')
    ).toEqual([])
  })

  it('treats a deliberately-private module as absent from the exports map', async () => {
    // Pins the mechanism itself, so the test above cannot silently start passing because
    // `getEntries` changed shape or stopped finding anything.
    const entries = await getEntries(SRC_DIR, PKG_NAME)
    const keys = Object.keys(entries)
    expect(keys.length).toBeGreaterThan(100)
    // `chat_common/helpers` is the canonical deliberately-private module: no `@module` tag, so no
    // export. Note the whole `chat_common` BARREL is private too — only `exceptions` is tagged.
    expect(keys).not.toContain('batteries/llm/chat_common/helpers')
    expect(keys).not.toContain('batteries/llm/chat_common')
    // A tagged sibling in the same directory IS exported, proving the absence above is the
    // `@module` rule at work rather than the whole directory being skipped.
    expect(keys).toContain('batteries/llm/chat_common/exceptions')
  })
})
