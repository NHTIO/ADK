import { describe, expect, it } from 'vitest'
import { InMemorySkillSource } from '@nhtio/adk/batteries/skills/in_memory'
import { runSkillSourceConformance } from '@nhtio/adk/batteries/skills/conformance'
import type { SkillDescriptor, SkillSource } from '@nhtio/adk/batteries/skills'

const descriptor: SkillDescriptor = {
  id: 'demo',
  name: 'Demo',
  description: 'A conformance skill',
  version: '1.0.0',
}

const makeSource = () =>
  new InMemorySkillSource('memory', [
    {
      id: 'demo',
      version: '1.0.0',
      manifest: '---\nname: Demo\ndescription: A conformance skill\n---\n\nBody\n',
      descriptor,
    },
  ])

describe('skills conformance fixture', () => {
  it('resolves for a conforming source and throws for a broken source', async () => {
    await expect(
      runSkillSourceConformance('InMemorySkillSource', makeSource)
    ).resolves.toBeUndefined()

    const brokenSource: SkillSource = {
      id: 'broken',
      discover: () => [] as unknown as AsyncIterable<never>,
      descriptor: async () => descriptor,
      read: async () => new ReadableStream<Uint8Array>(),
      stat: async () => ({ size: 0, version: '1.0.0' }),
    }

    await expect(
      runSkillSourceConformance('BrokenSkillSource', () => brokenSource)
    ).rejects.toThrow('SkillSource conformance [BrokenSkillSource] discovery')
  })
})
