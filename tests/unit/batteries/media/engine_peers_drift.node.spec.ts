import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { ENGINE_PEERS } from '../../../../src/batteries/media/lint'

/**
 * The `require-engine-peers` ESLint rule reports a missing peer from a hand-maintained
 * `ENGINE_PEERS` table — and that table is a lie the moment an engine adds, drops, or renames
 * a peer import. This spec is the pin: it scans each engine's source for the external modules
 * it actually imports (static `from '…'` and dynamic `import('…')`), and asserts the table
 * matches reality exactly. If you changed an engine's dependencies, update ENGINE_PEERS.
 */

const ENGINES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src/batteries/media/engines'
)

/** Internal (relative / @nhtio / node:) specifiers an engine may import without it being a peer. */
const isExternal = (spec: string): boolean =>
  !spec.startsWith('.') && !spec.startsWith('@nhtio/') && !spec.startsWith('node:')

/** The bare package name of an import specifier (drops subpaths: `xlsx/dist/x` → `xlsx`). */
const packageOf = (spec: string): string => {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/')
    return `${scope}/${name}`
  }
  return spec.split('/')[0]
}

/** Every external package an engine source file imports (static or dynamic), deduped + sorted. */
const externalImportsOf = (source: string): string[] => {
  const specs = new Set<string>()
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import … from '…'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('…')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s+as\s+string\s*\)/g, // import('…' as string) — zahl payload
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source))) {
      if (isExternal(m[1])) specs.add(packageOf(m[1]))
    }
  }
  return [...specs].sort()
}

describe('require-engine-peers ENGINE_PEERS drift pin', () => {
  const engineFiles = readdirSync(ENGINES_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')
  )

  it('covers every engine subpath that imports an external peer', () => {
    const withPeers = new Set<string>()
    for (const file of engineFiles) {
      const subpath = file.replace(/\.ts$/, '')
      const imports = externalImportsOf(readFileSync(join(ENGINES_DIR, file), 'utf8'))
      if (imports.length > 0) withPeers.add(subpath)
    }
    // Every engine with an external import must appear in ENGINE_PEERS, and vice versa.
    expect(Object.keys(ENGINE_PEERS).sort()).toEqual([...withPeers].sort())
  })

  it.each(Object.keys(ENGINE_PEERS))('%s peers match its actual imports', (subpath) => {
    const source = readFileSync(join(ENGINES_DIR, `${subpath}.ts`), 'utf8')
    expect([...ENGINE_PEERS[subpath]].sort()).toEqual(externalImportsOf(source))
  })
})
