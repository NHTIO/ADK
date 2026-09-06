import { describe, it, expect } from 'vitest'
import { SpooledArtifact } from '../../../../src/lib/classes/spooled_artifact'
import { SpooledJsonArtifact } from '../../../../src/lib/classes/spooled_json_artifact'
import { effectiveToolMethods } from '../../../../src/batteries/orchestration/artifact_methods'
import { SpooledMarkdownArtifact } from '../../../../src/lib/classes/spooled_markdown_artifact'
import type { ArtifactClassLike } from '../../../../src/batteries/orchestration/types'

/**
 * `effectiveToolMethods` exists because core's `static toolMethods` SHADOWS rather than
 * concatenates: `SpooledJsonArtifact.toolMethods` is its seven JSON descriptors and nothing else,
 * while the base seven live on `SpooledArtifact` and are composed at a different layer entirely
 * (`forgeTools` merging registries). A consumer trusting the leaf static would advertise a
 * vocabulary missing `artifact_head`/`_tail`/`_grep`/`_cat` on every JSON or Markdown artifact,
 * and freeze would refuse a `transform` step naming one.
 *
 * These cases are therefore asserted against the REAL core classes rather than fixtures. That is
 * deliberate and is the point of the suite: a fixture would pin this battery's belief about core,
 * whereas the real classes make a core shadowing change fail HERE, which is where the union is
 * computed. The counts are measured, not asserted from the design document.
 */
describe('effectiveToolMethods unions the static chain of the real core classes', () => {
  const namesOf = (ctor: unknown) =>
    effectiveToolMethods(ctor as ArtifactClassLike).map((d) => d.name)

  /** What the class itself declares — the value a naive `ctor.toolMethods` read would return. */
  const ownNames = (ctor: unknown): string[] => {
    const own = Object.getOwnPropertyDescriptor(ctor as object, 'toolMethods')
    const value: unknown = own && 'value' in own ? own.value : []
    return Array.isArray(value) ? (value as { name: string }[]).map((d) => d.name) : []
  }

  const BASE_SEVEN = [
    'artifact_head',
    'artifact_tail',
    'artifact_grep',
    'artifact_cat',
    'artifact_byte_length',
    'artifact_line_count',
    'artifact_estimate_tokens',
  ]

  it('returns exactly its own seven for the base class', () => {
    expect(namesOf(SpooledArtifact)).toEqual(BASE_SEVEN)
  })

  it('unions base and leaf for SpooledJsonArtifact — 14, where its own static has 7', () => {
    const effective = namesOf(SpooledJsonArtifact)

    // The shadowing itself, asserted rather than assumed: the leaf static does NOT carry the base
    // methods, so the difference between these two numbers IS the reason this function exists.
    expect(ownNames(SpooledJsonArtifact)).toHaveLength(7)
    expect(ownNames(SpooledJsonArtifact)).not.toContain('artifact_head')

    expect(effective).toHaveLength(14)
    expect(effective).toContain('artifact_head')
    for (const name of BASE_SEVEN) expect(effective).toContain(name)
    expect(effective).toContain('artifact_json_get')
  })

  it('unions base and leaf for SpooledMarkdownArtifact — 15, where its own static has 8', () => {
    const effective = namesOf(SpooledMarkdownArtifact)

    expect(ownNames(SpooledMarkdownArtifact)).toHaveLength(8)
    expect(ownNames(SpooledMarkdownArtifact)).not.toContain('artifact_head')

    expect(effective).toHaveLength(15)
    for (const name of BASE_SEVEN) expect(effective).toContain(name)
    expect(effective).toContain('artifact_md_headings')
  })

  it('orders leaf-first, so the nearest class is the one a dedupe keeps', () => {
    const effective = namesOf(SpooledJsonArtifact)
    expect(effective.indexOf('artifact_json_type')).toBeLessThan(effective.indexOf('artifact_head'))
  })

  it('never yields a duplicate name, across every real class', () => {
    for (const ctor of [SpooledArtifact, SpooledJsonArtifact, SpooledMarkdownArtifact]) {
      const names = namesOf(ctor)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('carries the descriptor through intact, since `name` and `method` differ', () => {
    // A step names the `name` (`artifact_json_get`); the runtime invokes the `method`
    // (`json_get`). Collapsing them would break every transform step.
    const get = effectiveToolMethods(SpooledJsonArtifact as unknown as ArtifactClassLike).find(
      (d) => d.name === 'artifact_json_get'
    )!
    expect(get.method).toBe('json_get')
    expect(get.name).not.toBe(get.method)
    expect(typeof get.description).toBe('string')
  })

  describe('the walk is total and defensive on hand-built classes', () => {
    it('dedupes by name with NEAREST CLASS WINNING', () => {
      class Base {
        static toolMethods = [{ name: 'dup', method: 'fromBase', description: 'base' }]
      }
      class Leaf extends Base {
        static override toolMethods = [{ name: 'dup', method: 'fromLeaf', description: 'leaf' }]
      }

      const found = effectiveToolMethods(Leaf as unknown as ArtifactClassLike)
      expect(found).toHaveLength(1)
      expect(found[0]!.method).toBe('fromLeaf')
    })

    it('counts only OWN toolMethods, so an inherited static is not collected twice', () => {
      class Base {
        static toolMethods = [{ name: 'a', method: 'a', description: '' }]
      }
      // Declares nothing of its own; `Sub.toolMethods` still RESOLVES to Base's via inheritance.
      class Sub extends Base {}

      expect(effectiveToolMethods(Sub as unknown as ArtifactClassLike)).toHaveLength(1)
    })

    it('returns empty rather than throwing when no class in the chain declares any', () => {
      class Bare {}
      expect(effectiveToolMethods(Bare as unknown as ArtifactClassLike)).toEqual([])
    })

    it('ignores a non-array toolMethods rather than throwing', () => {
      class Broken {
        static toolMethods = 'not an array'
      }
      expect(effectiveToolMethods(Broken as unknown as ArtifactClassLike)).toEqual([])
    })

    it('skips a malformed descriptor without dropping its well-formed siblings', () => {
      class Mixed {
        static toolMethods = [
          null,
          { method: 'no-name', description: '' },
          { name: 'good', method: 'good', description: '' },
        ]
      }
      expect(
        effectiveToolMethods(Mixed as unknown as ArtifactClassLike).map((d) => d.name)
      ).toEqual(['good'])
    })

    it('returns a frozen array, so a caller cannot corrupt a shared vocabulary', () => {
      expect(
        Object.isFrozen(effectiveToolMethods(SpooledArtifact as unknown as ArtifactClassLike))
      ).toBe(true)
    })
  })
})
