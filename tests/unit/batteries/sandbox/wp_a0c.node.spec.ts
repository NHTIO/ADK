import { describe, expect, it, vi } from 'vitest'
import { SpooledArtifact, SpooledJsonArtifact } from '../../../../src/common'
import { DefaultArtifactMinter } from '../../../../src/batteries/sandbox/defaults/default_minter'
import {
  DEFAULT_MIME_PEEK_BYTES,
  resolveMime,
} from '../../../../src/batteries/sandbox/defaults/extension_mime'

class ThirdPartyArtifact extends SpooledArtifact {}

describe('sandbox defaults (WP-A0c)', () => {
  it('lets a resolver override detection and falls back when it declines', async () => {
    const override = vi.fn(() => 'application/x-custom')
    await expect(resolveMime('file.json', override, { declared: 'text/plain' })).resolves.toBe(
      'application/x-custom'
    )
    await expect(resolveMime('file.json', () => undefined)).resolves.toBe('application/json')
  })

  it('clamps resolver peek requests to the default bound', async () => {
    const underlyingPeek = vi.fn(async (count: number) => new Uint8Array(count))
    await resolveMime(
      'file.bin',
      async ({ peek }) => {
        await peek(99999)
        return undefined
      },
      { peek: underlyingPeek }
    )
    expect(underlyingPeek).toHaveBeenCalledWith(DEFAULT_MIME_PEEK_BYTES)
  })

  it('keeps third-party constructors lazy until the selected format is resolved', async () => {
    let calls = 0
    const minter = new DefaultArtifactMinter([
      {
        id: 'third-party',
        mime: ['application/x-third-party'],
        extensions: ['third'],
        ctor: async () => {
          calls += 1
          return ThirdPartyArtifact
        },
      },
    ])
    await minter.formats()
    expect(calls).toBe(0)
    await minter.constructorForPath('unrelated.txt')
    expect(calls).toBe(0)
    const selected = await minter.constructorForMime('application/x-third-party')
    expect(calls).toBeGreaterThan(0)
    expect(selected).toBe(ThirdPartyArtifact)
  })

  it('uses the base class for unmapped and malformed extensions without throwing', async () => {
    const minter = new DefaultArtifactMinter()
    for (const path of ['file.unknown', 'no-extension', '.json', 'a.b.c', '', '....']) {
      await expect(minter.constructorForPath(path)).resolves.toBe(SpooledArtifact)
    }
  })

  it('maps invalid JSON content by static extension, without inspecting content', async () => {
    const minter = new DefaultArtifactMinter()
    const constructor = await minter.constructorForPath('broken.json')
    expect(constructor).toBe(SpooledJsonArtifact)
  })
})
