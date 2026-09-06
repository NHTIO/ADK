import { describe, it, expect } from 'vitest'
import { branchKey } from '../../../../src/batteries/orchestration/ops'
import type { BranchId, RouteSegment } from '../../../../src/batteries/orchestration/types'

/**
 * `branchKey` renders a route to the string that keys `OutputTable` and `ArtifactTable`,
 * identifies `NodeRef.branchId`, orders join contributors and makes duplicate join arrivals
 * idempotent. A collision therefore does not degrade gracefully — it overwrites one node's output
 * with another's, or merges two unrelated join barriers.
 *
 * So the property under test is INJECTIVITY, and it is asserted against inputs chosen to break a
 * delimiter-joining implementation specifically: an id carrying the delimiter, an id shaped like
 * the join rendering, and an id equal to two others concatenated. Length-prefixing survives all
 * three regardless of content, which is why the freeze-time charset rule is defence in depth
 * rather than the guarantee.
 */
describe('branchKey is injective', () => {
  const route = (...segments: RouteSegment[]): BranchId => ({ segments })

  it('separates an id containing the old `>` delimiter from two plain segments', () => {
    // Under `segments.map(id).join('>')` both render `a>b`.
    const carriesDelimiter = branchKey(route({ edge: 'a>b' }))
    const twoSegments = branchKey(route({ edge: 'a' }, { edge: 'b' }))

    expect(carriesDelimiter).not.toBe(twoSegments)
  })

  it('separates an id shaped like a join rendering from a real join segment', () => {
    const looksLikeAJoin = branchKey(route({ edge: 'j1:x(e1:y)' }))
    const realJoin = branchKey(route({ join: 'x', of: ['y'] }))

    expect(looksLikeAJoin).not.toBe(realJoin)
  })

  it('separates an id equal to two others concatenated from those two segments', () => {
    // The classic non-injectivity: 'ab' vs ('a','b') collide under bare concatenation.
    const concatenated = branchKey(route({ edge: 'ab' }))
    const separate = branchKey(route({ edge: 'a' }, { edge: 'b' }))

    expect(concatenated).not.toBe(separate)
  })

  it('keeps all such near-collisions mutually distinct in one set', () => {
    const keys = [
      route({ edge: 'a>b' }),
      route({ edge: 'a' }, { edge: 'b' }),
      route({ edge: 'ab' }),
      route({ edge: 'j1:x(e1:y)' }),
      route({ join: 'x', of: ['y'] }),
      route({ edge: 'a' }),
      route({ edge: 'b' }),
      route({ edge: 'b' }, { edge: 'a' }),
    ].map(branchKey)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('distinguishes a join whose `of` ids concatenate identically', () => {
    // `of: ['ab','c']` vs `of: ['a','bc']` collide if the ids are joined without length prefixes.
    const left = branchKey(route({ join: 'j', of: ['ab', 'c'] }))
    const right = branchKey(route({ join: 'j', of: ['a', 'bc'] }))

    expect(left).not.toBe(right)
  })

  it('is order-sensitive, because a route is a sequence and not a set', () => {
    expect(branchKey(route({ edge: 'a' }, { edge: 'b' }))).not.toBe(
      branchKey(route({ edge: 'b' }, { edge: 'a' }))
    )
  })

  it('is deterministic and total: the empty route is the empty key', () => {
    expect(branchKey(route())).toBe('')
    expect(branchKey(route({ edge: 'a' }))).toBe(branchKey(route({ edge: 'a' })))
  })

  it('renders segments length-prefixed, so a reader can parse back what it read', () => {
    // Pinning the encoding itself: injectivity is a consequence of this shape, and a rewrite that
    // silently dropped the prefixes would still pass a purely behavioural collision check on
    // whatever inputs happened to be listed above.
    expect(branchKey(route({ edge: 'ab' }))).toBe('e2:ab')
    expect(branchKey(route({ join: 'j', of: ['ab', 'c'] }))).toBe('j1:j(e2:abe1:c)')
  })
})
