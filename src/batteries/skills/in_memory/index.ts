/**
 * Reference in-memory SkillSource for tests and small deployments.
 *
 * @module @nhtio/adk/batteries/skills/in_memory
 */

import { parseSkillMd } from '../manifest'
import type { SkillDescriptor } from '../types'
import type { DiscoveredSkill, SkillRef, SkillSource } from '../contracts'

type Entry = {
  readonly ref: DiscoveredSkill
  readonly manifest: string
  readonly descriptor: SkillDescriptor
  readonly files?: Readonly<Record<string, string | Uint8Array>>
}

const stream = (value: string | Uint8Array): ReadableStream<Uint8Array> => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** A mutable, deterministic SkillSource backed by SKILL.md strings. */
export class InMemorySkillSource implements SkillSource {
  /** Source provenance stamped onto every discovered reference. */
  readonly id: string
  readonly #entries = new Map<string, Entry>()

  constructor(
    id: string,
    entries: ReadonlyArray<{
      readonly id: string
      readonly version: string
      readonly manifest: string
      readonly descriptor: SkillDescriptor
      readonly files?: Readonly<Record<string, string | Uint8Array>>
    }>
  ) {
    this.id = id
    for (const entry of entries) {
      const parsed = parseSkillMd(entry.manifest)
      const frontmatter = parsed.frontmatter
      const ref: DiscoveredSkill = {
        id: entry.id,
        version: entry.version,
        name: frontmatter.name as string,
        description: frontmatter.description as string,
        ...(typeof frontmatter.license === 'string' ? { license: frontmatter.license } : {}),
        ...(frontmatter.metadata && typeof frontmatter.metadata === 'object'
          ? { metadata: frontmatter.metadata as Record<string, string> }
          : {}),
        ...(typeof frontmatter.compatibility === 'string'
          ? { compatibility: frontmatter.compatibility }
          : {}),
      }
      this.#entries.set(entry.id, {
        ref,
        manifest: entry.manifest,
        descriptor: entry.descriptor,
        files: entry.files,
      })
    }
  }

  /** Yields the precomputed routing metadata without loading descriptors. */
  async *discover(): AsyncIterable<DiscoveredSkill> {
    for (const entry of this.#entries.values()) yield entry.ref
  }

  /** Returns the live descriptor for a discovered id. */
  async descriptor(ref: SkillRef): Promise<SkillDescriptor> {
    const entry = this.#entries.get(ref.id)
    if (!entry) throw new Error(`unknown skill: ${ref.id}`)
    return entry.descriptor
  }

  async read(ref: SkillRef, path?: string): Promise<ReadableStream<Uint8Array>> {
    const entry = this.#entries.get(ref.id)
    if (!entry) throw new Error(`unknown skill: ${ref.id}`)
    if (path === undefined) return stream(parseSkillMd(entry.manifest).body)
    const value = entry.files?.[path]
    if (value === undefined) throw new Error(`unknown file: ${path}`)
    return stream(value)
  }

  /** Reports byte size and current entry version for the body or a bundled file. */
  async stat(ref: SkillRef, path?: string): Promise<{ size: number; version: string }> {
    const bytes = await new Response(await this.read(ref, path)).arrayBuffer()
    return {
      size: bytes.byteLength,
      version: this.#entries.get(ref.id)?.ref.version ?? ref.version,
    }
  }

  async list(ref: SkillRef): Promise<readonly string[]> {
    return Object.keys(this.#entries.get(ref.id)?.files ?? {})
  }
}
