/**
 * Conformance suite for {@link SkillSource} implementations.
 *
 * This is a deep-import-only entrypoint. It has no test-framework dependency and is not
 * re-exported by the skills barrel.
 *
 * @module @nhtio/adk/batteries/skills/conformance
 */

import type { SkillDescriptor } from '../types'
import type { DiscoveredSkill, SkillSource } from '../contracts'

const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** Run the common SkillSource contract checks against a fresh source. */
export const runSkillSourceConformance = async (
  label: string,
  makeSource: () => SkillSource | Promise<SkillSource>
): Promise<void> => {
  const expectedDescriptor: SkillDescriptor = {
    id: 'demo',
    name: 'Demo',
    description: 'A conformance skill',
    version: '1.0.0',
  }

  const discoverOne = async (source: SkillSource, caseName: string): Promise<DiscoveredSkill> => {
    const discovered: DiscoveredSkill[] = []
    for await (const value of source.discover()) discovered.push(value)
    assert(
      discovered.length === 1,
      `SkillSource conformance [${label}] ${caseName}: discover() must yield exactly one skill`
    )
    return discovered[0]
  }

  {
    const caseName = 'discovery'
    const source = await makeSource()
    const iterable = source.discover()
    assert(
      typeof iterable?.[Symbol.asyncIterator] === 'function',
      `SkillSource conformance [${label}] ${caseName}: discover() must yield an async iterable`
    )
    const ref = await discoverOne(source, caseName)
    assert(
      ref.id === 'demo' &&
        ref.version === '1.0.0' &&
        ref.name === 'Demo' &&
        ref.description === 'A conformance skill',
      `SkillSource conformance [${label}] ${caseName}: discover() must preserve the expected skill reference`
    )
  }

  {
    const caseName = 'descriptor'
    const source = await makeSource()
    const ref = await discoverOne(source, caseName)
    const descriptor = await source.descriptor({ ...ref, sourceId: source.id })
    assert(
      JSON.stringify(descriptor) === JSON.stringify(expectedDescriptor),
      `SkillSource conformance [${label}] ${caseName}: descriptor() must match the discovered id, name, description, and version`
    )
  }

  {
    const caseName = 'body and stat'
    const source = await makeSource()
    const ref = await discoverOne(source, caseName)
    const skillRef = { ...ref, sourceId: source.id }
    const bytes = await new Response(await source.read(skillRef)).arrayBuffer()
    assert(
      new TextDecoder().decode(bytes) === '\nBody\n',
      `SkillSource conformance [${label}] ${caseName}: read() must return the expected body as bytes`
    )
    const stat = await source.stat(skillRef)
    assert(
      stat.size === bytes.byteLength,
      `SkillSource conformance [${label}] ${caseName}: stat().size must equal the body byte length`
    )
    assert(
      stat.version === '1.0.0',
      `SkillSource conformance [${label}] ${caseName}: stat().version must match the discovered version`
    )
  }
}
