/**
 * Build-guard #1 (GitLab issue #29, item 8): no orphaned battery modules.
 *
 * Every `.ts` file under `src/batteries/**` must be REACHABLE: it either carries an `@module` tag
 * (the tag IS the published subpath — see CONTRIBUTING, "The build: `@module` tags become the
 * package exports") or is imported, transitively, by a file that does. A file that is neither is
 * source nobody can import from the package and nobody can review as an entry.
 *
 * The graph is a static parse (TypeScript's `preProcessFile`) of `import … from` / `export … from`
 * specifiers, resolved relative and through the `@nhtio/adk/*` tsconfig alias. The `@module` scan is
 * cross-checked against `bin/utils/index.ts:getEntries` — the exact function the build uses — so the
 * two mappings cannot drift. Test files and `.d.ts` are out of scope.
 *
 * Current orphans are an explicit, commented ALLOW-LIST, each with a TODO. Any NEW orphan fails the
 * guard; the list is pinned exactly, so it can only shrink by wiring a module up or growing by a
 * deliberate, justified edit.
 */
import { default as ts } from 'typescript'
import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { getEntries } from '../../../bin/utils/index'
import { relative, resolve, dirname, join } from 'node:path'

const BASE_DIR = resolve(__dirname, '../../..')
const SRC_DIR = resolve(BASE_DIR, 'src')
const BATTERIES_DIR = resolve(SRC_DIR, 'batteries')
const PKG_NAME = '@nhtio/adk'

/**
 * Orphans audited against `origin/master` at guard-creation time (74266e6). Every entry states WHY
 * it is unreachable today and carries a TODO. Do not add a line here without one.
 *
 * TODO(batteries/llm/claude_code_cli): the wrapper cluster ships as a STANDALONE spawned
 * executable. `wrapper.ts` is added to `vite.config.mts`'s `build.lib.entry` by explicit path
 * (`claude-code-cli-wrapper`) — its own header says it is "never imported as a library, only ever
 * spawned by file path" — and its four siblings are imported by nothing but it and each other. The
 * build reaches them through that hand-written entry, which the `@module` graph this guard walks
 * cannot see. Teach the guard the explicit vite entries, or fold the cluster into a tagged module.
 * TODO(batteries/media/steps/patch.ts): a deprecated re-export shim of the moved `lib/patch` module
 * (`@deprecated Shared structured-patch primitives now live in lib/patch`), imported by nothing.
 */
const KNOWN_ORPHANS: readonly string[] = [
  'batteries/llm/claude_code_cli/cli_protocol.ts', // TODO: wrapper-cluster module, reached only by the spawned wrapper
  'batteries/llm/claude_code_cli/line_queue.ts', // TODO: wrapper-cluster module, reached only by the spawned wrapper
  'batteries/llm/claude_code_cli/mcp_bridge.ts', // TODO: wrapper-cluster module, reached only by the spawned wrapper
  'batteries/llm/claude_code_cli/message_id_state.ts', // TODO: wrapper-cluster module, reached only by the spawned wrapper
  'batteries/llm/claude_code_cli/wrapper.ts', // TODO: standalone executable, entered via vite build.lib.entry
  'batteries/media/steps/patch.ts', // TODO: deprecated re-export shim, imported by nothing
]

/** A virtual source tree, so the reachability logic is testable on a fixture. */
export interface VirtualTree {
  /** Absolute path → source text. */
  readonly contents: ReadonlyMap<string, string>
}

const MODULE_TAG = /@module\s+(@?[\w/.\-]+)/g

const resolveSpecifier = (
  specifier: string,
  fromFile: string,
  files: ReadonlySet<string>
): string | undefined => {
  let base: string | undefined
  if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier)
  else if (specifier === PKG_NAME || specifier.startsWith(`${PKG_NAME}/`)) {
    base = join(SRC_DIR, specifier.slice(PKG_NAME.length))
  } else return undefined
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (files.has(candidate)) return candidate
  }
  return undefined
}

/** Tagged files, the import graph, and every file unreachable from a tag. */
export const analyze = (
  tree: VirtualTree
): {
  tagged: Set<string>
  graph: Map<string, Set<string>>
  orphans: string[]
} => {
  const files = new Set(tree.contents.keys())
  const tagged = new Set<string>()
  const graph = new Map<string, Set<string>>()
  for (const [file, content] of tree.contents) {
    if ([...content.matchAll(MODULE_TAG)].length > 0) tagged.add(file)
    const info = ts.preProcessFile(content, true, true)
    const deps = new Set<string>()
    for (const imported of info.importedFiles) {
      const resolved = resolveSpecifier(imported.fileName, file, files)
      if (resolved) deps.add(resolved)
    }
    graph.set(file, deps)
  }
  const seen = new Set(tagged)
  const stack = [...seen]
  while (stack.length) {
    for (const dep of graph.get(stack.pop()!) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  return { tagged, graph, orphans: [...files].filter((f) => !seen.has(f)).sort() }
}

const collectBatteryFiles = async (): Promise<string[]> => {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
    }
  }
  await walk(BATTERIES_DIR)
  return out
}

describe('reachability logic (fixture)', () => {
  const virtual = (entries: Record<string, string>): VirtualTree => {
    const contents = new Map<string, string>()
    for (const [path, text] of Object.entries(entries)) {
      // Fixture keys are resolved against SRC_DIR so `@nhtio/adk/*` aliases resolve the same way
      // they do for the real tree.
      contents.set(resolve(SRC_DIR, path), text)
    }
    return { contents }
  }

  it('follows relative imports through an index.ts barrel', () => {
    const tree = virtual({
      'batteries/x/index.ts': '/** @module @nhtio/adk/batteries/x */\nexport * from "./inner"',
      'batteries/x/inner/index.ts': 'export const a = 1',
    })
    expect(analyze(tree).orphans).toEqual([])
  })

  it('follows the @nhtio/adk/* tsconfig alias', () => {
    const tree = virtual({
      'batteries/x/index.ts':
        '/** @module @nhtio/adk/batteries/x */\nexport * from "@nhtio/adk/batteries/x/deep"',
      'batteries/x/deep.ts': 'export const a = 1',
    })
    expect(analyze(tree).orphans).toEqual([])
  })

  it('follows `export … from` as well as `import … from`', () => {
    const tree = virtual({
      'batteries/x/index.ts':
        '/** @module @nhtio/adk/batteries/x */\nexport { a } from "./a"\nimport { b } from "./b"',
      'batteries/x/a.ts': 'export const a = 1',
      'batteries/x/b.ts': 'export const b = 2',
    })
    expect(analyze(tree).orphans).toEqual([])
  })

  it('reports an untagged module nothing reaches', () => {
    const tree = virtual({
      'batteries/x/index.ts': '/** @module @nhtio/adk/batteries/x */\nexport const a = 1',
      'batteries/x/orphan.ts': 'export const dead = 1',
    })
    expect(analyze(tree).orphans).toEqual([resolve(SRC_DIR, 'batteries/x/orphan.ts')])
  })

  it('does not invent an edge for an unresolvable package specifier', () => {
    const tree = virtual({
      'batteries/x/index.ts': '/** @module @nhtio/adk/batteries/x */\nimport "react"',
      'batteries/x/deep.ts': 'export const a = 1',
    })
    expect(analyze(tree).orphans).toEqual([resolve(SRC_DIR, 'batteries/x/deep.ts')])
  })
})

describe('battery module reachability (no orphaned modules)', () => {
  it('every battery .ts file is @module-tagged or reachable from a tagged file', async () => {
    const contents = new Map<string, string>()
    for (const file of await collectBatteryFiles()) {
      contents.set(file, await readFile(file, 'utf8'))
    }
    expect(contents.size).toBeGreaterThan(100)
    const { orphans } = analyze({ contents })
    const relativeOrphans = orphans.map((f) => relative(SRC_DIR, f))
    const unlisted = relativeOrphans.filter((o) => !KNOWN_ORPHANS.includes(o))
    expect(
      unlisted,
      'These battery modules are neither @module-tagged nor imported (transitively) by a tagged ' +
        'file — unreachable from the published package and invisible to review. Wire them into an ' +
        "entry's import graph, tag them if they are meant to be published, or add them to " +
        'KNOWN_ORPHANS with a TODO and the reason:\n\n' +
        unlisted.map((o) => `  - ${o}`).join('\n')
    ).toEqual([])
  })

  it('the allow-list matches exactly: no stale entries, no missing entries', () => {
    // Pinned both ways. A stale entry means the module got wired up (drop the line); a missing
    // entry means a NEW orphan appeared (the test above names it too). Both are edits someone must
    // make on purpose, so the list cannot rot in either direction.
    expect([...KNOWN_ORPHANS].sort()).toEqual(
      [
        'batteries/llm/claude_code_cli/cli_protocol.ts',
        'batteries/llm/claude_code_cli/line_queue.ts',
        'batteries/llm/claude_code_cli/mcp_bridge.ts',
        'batteries/llm/claude_code_cli/message_id_state.ts',
        'batteries/llm/claude_code_cli/wrapper.ts',
        'batteries/media/steps/patch.ts',
      ].sort()
    )
  })

  it('the @module scan agrees with the build getEntries keys', async () => {
    // `getEntries` is the canonical tag scanner; if this ever disagrees with the regex above, one of
    // the two has changed shape and the guard is reasoning about a different set of entries.
    const entries = await getEntries(SRC_DIR, PKG_NAME)
    const batteryEntryFiles = new Set(
      Object.values(entries).filter((file) => file.startsWith(BATTERIES_DIR))
    )
    const contents = new Map<string, string>()
    for (const file of await collectBatteryFiles()) {
      contents.set(file, await readFile(file, 'utf8'))
    }
    const { tagged } = analyze({ contents })
    expect([...tagged].sort()).toEqual([...batteryEntryFiles].sort())
  })
})
