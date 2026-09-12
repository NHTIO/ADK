import { Media } from '@nhtio/adk/common'
import { describe, expect, it } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { inMemoryMediaReader } from '../../../../src/lib/helpers/media_readers'
import { InMemorySpoolStore } from '../../../../src/batteries/storage/in_memory'
import { floorOutputTier, resolveSkillToolOutput } from '../../../../src/batteries/skills/output'
import type { MediaTrustTier } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'

const mediaWithTier = (trustTier: MediaTrustTier): Media =>
  new Media({
    kind: 'image',
    mimeType: 'image/png',
    filename: 'x.png',
    reader: inMemoryMediaReader(new Uint8Array([1])),
    trustTier,
    modalityHazard: 'opaque-perceptual',
  })

const resolve = (raw: unknown, extra: Partial<Parameters<typeof resolveSkillToolOutput>[0]> = {}) =>
  resolveSkillToolOutput({
    raw,
    ctx: makeDispatchContext() as DispatchContext,
    toolName: 'demo_tool',
    trustTier: 'third-party-public',
    ...extra,
  })

/** The battery's exceptions render a template message; identity lives on `.name`. */
const rejectsBadResponse = async (p: Promise<unknown>): Promise<void> => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeDefined()
  expect((error as { name?: string }).name).toBe('E_SKILL_TOOL_BAD_RESPONSE')
}

describe('skills tool output — framework-agnostic typed results', () => {
  it('passes a string through unchanged', async () => {
    expect(await resolve('hello')).toBe('hello')
  })

  it('passes raw Uint8Array bytes through unchanged (anonymous binary still works)', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(await resolve(bytes)).toBe(bytes)
  })

  it('constructs a typed Media from a { bytes, mimeType, filename } descriptor', async () => {
    const result = await resolve({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    })
    expect(result).toBeInstanceOf(Media)
    const media = result as Media
    expect(media.kind).toBe('document')
    expect(media.mimeType).toBe('application/pdf')
    expect(media.filename).toBe('report.pdf')
    // A document can carry hidden instructions.
    expect(media.modalityHazard).toBe('extractable-instructions')
    expect(await media.asBytes()).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
  })

  it('infers image kind and opaque-perceptual hazard from the mime type', async () => {
    const media = (await resolve({ bytes: new Uint8Array([1]), mimeType: 'image/png' })) as Media
    expect(media.kind).toBe('image')
    expect(media.modalityHazard).toBe('opaque-perceptual')
    // No filename supplied → a stable default derived from the tool name is used.
    expect(media.filename).toContain('demo_tool')
  })

  it('floors a first-party skill Media output to third-party-private', async () => {
    const media = (await resolve(
      { bytes: new Uint8Array([1]), mimeType: 'image/png' },
      { trustTier: 'first-party' }
    )) as Media
    // A skill can never label its own output first-party.
    expect(media.trustTier).toBe('third-party-private')
  })

  it('passes third-party tiers through unchanged on Media output', async () => {
    const pub = (await resolve(
      { bytes: new Uint8Array([1]), mimeType: 'image/png' },
      { trustTier: 'third-party-public' }
    )) as Media
    expect(pub.trustTier).toBe('third-party-public')
  })

  it('persists the Retrievable durably, adds it to turnRetrievables, and returns an acknowledgement', async () => {
    // A skill tool's explicit `{ retrievable }` is durable WORK PRODUCT: it must travel the
    // consumer's persistence callback (via ctx.storeRetrievable), not merely a transient
    // turnRetrievables.add. Capture the persisted records to prove the durable path is taken.
    const persisted: Array<{ kind?: string; source?: string; id: string }> = []
    const ctx = makeDispatchContext({
      storeRetrievable: async (_c, record) => {
        persisted.push({ kind: record.kind, source: record.source, id: record.id })
      },
    }) as DispatchContext
    const result = await resolveSkillToolOutput({
      raw: { retrievable: { content: 'a cited fact', source: 'kb://x', kind: 'reference' } },
      ctx,
      toolName: 'demo_tool',
      trustTier: 'third-party-public',
    })
    expect(typeof result).toBe('string')
    expect(String(result)).toMatch(/^Retrievable .+ added \(\d+ bytes\)$/)
    // Durable persistence fired exactly once with the constructed record.
    expect(persisted).toHaveLength(1)
    expect(persisted[0].kind).toBe('reference')
    expect(persisted[0].source).toBe('kb://x')
    // …and it is also live in this turn's context.
    const added = [...ctx.turnRetrievables]
    expect(added).toHaveLength(1)
    expect(added[0].id).toBe(persisted[0].id)
    // The acknowledgement's id names the added retrievable.
    expect(String(result)).toContain(added[0].id)
  })

  it('floors a first-party skill Retrievable output to third-party-private', async () => {
    const ctx = makeDispatchContext() as DispatchContext
    await resolveSkillToolOutput({
      raw: { retrievable: { content: 'x' } },
      ctx,
      toolName: 'demo_tool',
      trustTier: 'first-party',
    })
    expect([...ctx.turnRetrievables][0].trustTier).toBe('third-party-private')
  })

  it('refuses a prebuilt SpooledArtifact', async () => {
    const { SpooledArtifact } = await import('@nhtio/adk/common')
    const reader = await new InMemorySpoolStore().write('id', 'bytes')
    const artifact = new SpooledArtifact(reader)
    await rejectsBadResponse(resolve(artifact))
  })

  it('refuses an unrecognised shape', async () => {
    await rejectsBadResponse(resolve({ foo: 'bar' }))
    await rejectsBadResponse(resolve(undefined))
    await rejectsBadResponse(resolve(() => {}))
  })

  it('refuses a binary descriptor with no mimeType', async () => {
    await rejectsBadResponse(resolve({ bytes: new Uint8Array([1]) }))
  })

  it('enforces a declared output kind against the runtime shape', async () => {
    // Declared retrievable, returned binary → detectable mismatch.
    await rejectsBadResponse(
      resolve({ bytes: new Uint8Array([1]), mimeType: 'image/png' }, { declared: 'retrievable' })
    )
    // Declared media, returned a matching media descriptor → passes.
    const ok = await resolve(
      { bytes: new Uint8Array([1]), mimeType: 'image/png' },
      { declared: 'media' }
    )
    expect(ok).toBeInstanceOf(Media)
    // A raw Uint8Array satisfies a 'binary' declaration.
    const bytes = new Uint8Array([9])
    expect(await resolve(bytes, { declared: 'binary' })).toBe(bytes)
  })

  it('accepts a prebuilt Media at or below the skill output tier', async () => {
    // third-party-public skill; a third-party-private Media is STRICTER than the floor → allowed.
    const stricter = mediaWithTier('third-party-private')
    expect(await resolve(stricter, { trustTier: 'third-party-public' })).toBe(stricter)
    // A Media exactly at the floor is allowed.
    const atFloor = mediaWithTier('third-party-public')
    expect(await resolve(atFloor, { trustTier: 'third-party-public' })).toBe(atFloor)
  })

  it('rejects a prebuilt Media more privileged than the skill output tier', async () => {
    // A skill returning a first-party Media would render third-party content as first-party.
    await rejectsBadResponse(
      resolve(mediaWithTier('first-party'), { trustTier: 'third-party-public' })
    )
    // Same for a first-party skill: its floor is third-party-private, so a first-party Media exceeds it.
    await rejectsBadResponse(resolve(mediaWithTier('first-party'), { trustTier: 'first-party' }))
  })

  it('rejects a Media array containing one over-privileged element', async () => {
    const arr = [mediaWithTier('third-party-private'), mediaWithTier('first-party')]
    await rejectsBadResponse(resolve(arr, { trustTier: 'third-party-public' }))
  })

  it('accepts an empty Media array as a valid no-media result', async () => {
    expect(await resolve([])).toEqual([])
  })

  it('propagates a rejecting consumer storeRetrievable as-is (host failure, not a bad response)', async () => {
    // Matching the canonical retrievables-battery pattern: a consumer persistence callback that
    // rejects is a HOST infrastructure failure, not a bad skill response. It propagates unchanged
    // rather than being recharacterized as the skill's fault. And because core collision-checks and
    // spools inside storeRetrievable (string content), a failure here writes no orphaned bytes.
    const ctx = makeDispatchContext({
      storeRetrievable: async () => {
        throw new Error('consumer store rejected')
      },
    }) as DispatchContext
    const error = await resolveSkillToolOutput({
      raw: { retrievable: { content: 'x' } },
      ctx,
      toolName: 'demo_tool',
      trustTier: 'third-party-public',
    }).then(
      () => undefined,
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('consumer store rejected')
  })

  it('rejects a NaN retrievable score before storing', async () => {
    let stored = 0
    const ctx = makeDispatchContext({
      storeRetrievableBytes: (_c, id, bytes) => {
        stored++
        return new InMemorySpoolStore().write(id, bytes)
      },
    }) as DispatchContext
    // NaN slips past `score < 0 || score > 1` (all NaN comparisons are false); it must be caught.
    await rejectsBadResponse(
      resolveSkillToolOutput({
        raw: { retrievable: { content: 'x', score: Number.NaN } },
        ctx,
        toolName: 'demo_tool',
        trustTier: 'third-party-public',
      })
    )
    expect(stored).toBe(0)
    expect([...ctx.turnRetrievables]).toHaveLength(0)
  })

  it('does not store retrievable bytes when an optional field is invalid', async () => {
    let stored = 0
    const ctx = makeDispatchContext({
      storeRetrievableBytes: (_c, id, bytes) => {
        stored++
        return new InMemorySpoolStore().write(id, bytes)
      },
    }) as DispatchContext
    await rejectsBadResponse(
      resolveSkillToolOutput({
        raw: { retrievable: { content: 'x', score: 5 } }, // score out of [0,1]
        ctx,
        toolName: 'demo_tool',
        trustTier: 'third-party-public',
      })
    )
    expect(stored).toBe(0)
    expect([...ctx.turnRetrievables]).toHaveLength(0)
  })

  it('does not store media bytes when the filename is invalid', async () => {
    let stored = 0
    const ctx = makeDispatchContext({
      storeMediaBytes: async () => {
        stored++
        return inMemoryMediaReader(new Uint8Array([1]))
      },
    }) as DispatchContext
    await rejectsBadResponse(
      resolveSkillToolOutput({
        raw: {
          bytes: new Uint8Array([1]),
          mimeType: 'image/png',
          filename: 123 as unknown as string,
        },
        ctx,
        toolName: 'demo_tool',
        trustTier: 'third-party-public',
      })
    )
    expect(stored).toBe(0)
  })

  it('exposes the trust floor as a pure function', () => {
    expect(floorOutputTier('first-party')).toBe('third-party-private')
    expect(floorOutputTier('third-party-public')).toBe('third-party-public')
    expect(floorOutputTier('third-party-private')).toBe('third-party-private')
    expect(floorOutputTier(undefined)).toBe('third-party-public')
  })
})
