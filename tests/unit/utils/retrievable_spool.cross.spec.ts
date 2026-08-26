import { describe, expect, it } from 'vitest'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { E_INVALID_INITIAL_RETRIEVABLE_VALUE } from '../../../src/lib/exceptions/runtime'
import {
  autoSpoolRetrievable,
  assertUniqueRetrievableIds,
  computeTextHints,
  normalizeRetrievables,
} from '../../../src/lib/utils/retrievable_spool'

const raw = (content: string | Tokenizable | SpooledArtifact, id = 'r') =>
  new Retrievable({
    id,
    content,
    trustTier: 'first-party',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  })

describe('retrievable_spool utilities', () => {
  it('computes UTF-8 byte and line hints', () =>
    expect(computeTextHints('é\na')).toEqual({ byteLength: 4, lineCount: 2 }))
  it('rejects duplicate ids clearly', () =>
    expect(() => assertUniqueRetrievableIds([{ id: 'x' }, { id: 'x' }])).toThrow(
      'Duplicate retrievable id: x'
    ))
  it('normalizes a set in place', async () => {
    const set = new Set([raw('hello', 'x')])
    await normalizeRetrievables({
      turnRetrievables: set,
      storeRetrievableBytes: (_id, bytes) => new InMemorySpoolReader(String(bytes)),
    })
    expect([...set][0].content).toBeInstanceOf(SpooledArtifact)
  })
  it('leaves spooled and dynamic content untouched', async () => {
    const artifact = new SpooledArtifact(new InMemorySpoolReader('body'))
    const dynamic = new Tokenizable(() => 'body')
    const store = {
      storeRetrievableBytes: async () => {
        throw new Error('must not store')
      },
    }
    expect(await autoSpoolRetrievable(store, raw(artifact, 'a'))).toBeInstanceOf(Retrievable)
    const d = await autoSpoolRetrievable(store, raw(dynamic, 'd'))
    expect(d.content).toBe(dynamic)
  })
  it('leaves inline content untouched — spooling it would only degrade its estimateTokens from sync to async for no rendering benefit', async () => {
    const tk = new Tokenizable('body')
    const store = {
      storeRetrievableBytes: async () => {
        throw new Error('must not store')
      },
    }
    const input = new Retrievable({
      id: 'inline-1',
      content: tk,
      trustTier: 'first-party',
      inline: true,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    })
    const result = await autoSpoolRetrievable(store, input)
    expect(result.content).toBe(tk)
  })
  it('spools plain text and caches hints', async () => {
    const result = await autoSpoolRetrievable(
      { storeRetrievableBytes: (_id, bytes) => new InMemorySpoolReader(String(bytes)) },
      raw('one\ntwo', 'x')
    )
    expect(result.content).toBeInstanceOf(SpooledArtifact)
    const artifact = result.content as SpooledArtifact
    expect(artifact.hasSizeHints()).toBe(true)
    expect(await artifact.byteLength()).toBe(7)
    expect(await artifact.lineCount()).toBe(2)
  })
  it('guards a duck-typed artifact that lacks _setSizeHints', async () => {
    class Fake {
      head() {}
      tail() {}
      grep() {}
      cat() {}
      byteLength() {}
      lineCount() {}
      estimateTokens() {}
    }
    const fakeArtifact = new Fake()
    expect(typeof (fakeArtifact as unknown as { _setSizeHints?: unknown })._setSizeHints).toBe(
      'undefined'
    )
    const input = new Retrievable({
      id: 'f',
      content: 'x',
      trustTier: 'first-party',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      artifactConstructor: () => Fake as never,
    })
    // With the guard, construction proceeds to the deliberate Retrievable validation error.
    // An unconditional artifact._setSizeHints(...) would instead throw TypeError here.
    await expect(
      autoSpoolRetrievable(
        { storeRetrievableBytes: (_id, bytes) => new InMemorySpoolReader(String(bytes)) },
        input
      )
    ).rejects.toBeInstanceOf(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
  })
})
