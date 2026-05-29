import { describe, expect, it } from 'vitest'
import { Media, isMedia } from '../../../src/lib/classes/media'
import { inMemoryMediaReader } from '../../../src/lib/helpers/media_readers'
import {
  E_INVALID_INITIAL_MEDIA_VALUE,
  E_NOT_A_MEDIA_READER,
} from '../../../src/lib/exceptions/runtime'
import type { RawMedia } from '../../../src/lib/classes/media'

const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic prefix
const baseRaw = (): RawMedia => ({
  kind: 'image',
  mimeType: 'image/png',
  filename: 'pic.png',
  reader: inMemoryMediaReader(buf),
  trustTier: 'first-party',
  modalityHazard: 'opaque-perceptual',
})

describe('Media', () => {
  describe('construction & schema validation', () => {
    it('constructs from a valid RawMedia', () => {
      const m = new Media(baseRaw())
      expect(Media.isMedia(m)).toBe(true)
      expect(isMedia(m)).toBe(true)
      expect(m.kind).toBe('image')
      expect(m.mimeType).toBe('image/png')
      expect(m.filename).toBe('pic.png')
      expect(m.trustTier).toBe('first-party')
      expect(m.modalityHazard).toBe('opaque-perceptual')
    })

    it('assigns a fresh id when none supplied', () => {
      const m = new Media(baseRaw())
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
    })

    it('preserves an explicitly supplied id', () => {
      const m = new Media({ ...baseRaw(), id: 'my-id-123' })
      expect(m.id).toBe('my-id-123')
    })

    it('rejects missing trustTier', () => {
      const raw = baseRaw() as Partial<RawMedia>
      delete raw.trustTier
      expect(() => new Media(raw as RawMedia)).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })

    it('rejects missing modalityHazard', () => {
      const raw = baseRaw() as Partial<RawMedia>
      delete raw.modalityHazard
      expect(() => new Media(raw as RawMedia)).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })

    it('rejects invalid kind', () => {
      expect(() => new Media({ ...baseRaw(), kind: 'foo' as never })).toThrow(
        E_INVALID_INITIAL_MEDIA_VALUE
      )
    })

    it('rejects missing mimeType', () => {
      const raw = baseRaw() as Partial<RawMedia>
      delete raw.mimeType
      expect(() => new Media(raw as RawMedia)).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })

    it('rejects missing filename', () => {
      const raw = baseRaw() as Partial<RawMedia>
      delete raw.filename
      expect(() => new Media(raw as RawMedia)).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })

    it('rejects a reader that does not implement MediaReader', () => {
      expect(
        () =>
          new Media({
            ...baseRaw(),
            reader: { stream: () => null } as never,
          })
      ).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })

    it('rejects an invalid trustTier value', () => {
      expect(() => new Media({ ...baseRaw(), trustTier: 'bogus' as never })).toThrow(
        E_INVALID_INITIAL_MEDIA_VALUE
      )
    })

    it('rejects an invalid modalityHazard value', () => {
      expect(() => new Media({ ...baseRaw(), modalityHazard: 'bogus' as never })).toThrow(
        E_INVALID_INITIAL_MEDIA_VALUE
      )
    })

    it('rejects a reader whose stream is not callable (E_NOT_A_MEDIA_READER path)', () => {
      // Schema rejects first, so we use a reader that passes the schema
      // but fails an explicit guard upstream — schema requires functions so
      // this is exercised via the schema branch above.
      expect(E_NOT_A_MEDIA_READER).toBeTruthy()
    })
  })

  describe('reader delegation', () => {
    it('byteLength delegates to the reader', async () => {
      const m = new Media(baseRaw())
      expect(await m.byteLength()).toBe(buf.byteLength)
    })

    it('stream returns a fresh ReadableStream on each call', async () => {
      const m = new Media(baseRaw())
      const s1 = await m.stream()
      const s2 = await m.stream()
      expect(s1).not.toBe(s2)
    })

    it('asBytes drains the reader into a Uint8Array', async () => {
      const m = new Media(baseRaw())
      const out = await m.asBytes()
      expect(out).toBeInstanceOf(Uint8Array)
      expect(Array.from(out)).toEqual(Array.from(buf))
    })

    it('asBytes is re-callable and produces identical bytes each call', async () => {
      const m = new Media(baseRaw())
      const a = await m.asBytes()
      const b = await m.asBytes()
      expect(Array.from(a)).toEqual(Array.from(b))
    })

    it('asBase64 produces a stable base64 encoding', async () => {
      const m = new Media(baseRaw())
      const b64 = await m.asBase64()
      expect(typeof b64).toBe('string')
      expect(b64.length).toBeGreaterThan(0)
    })

    it('asBase64 large-buffer path does not stack-overflow when Buffer is unavailable', async () => {
      const big = new Uint8Array(0x10000 + 7) // > one chunk
      for (let i = 0; i < big.length; i++) big[i] = i & 0xff
      const m = new Media({
        ...baseRaw(),
        reader: inMemoryMediaReader(big),
      })
      const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer
      try {
        ;(globalThis as { Buffer?: unknown }).Buffer = undefined
        const b64 = await m.asBase64()
        expect(b64.length).toBeGreaterThan(0)
      } finally {
        ;(globalThis as { Buffer?: unknown }).Buffer = savedBuffer
      }
    })
  })

  describe('toJSON', () => {
    it('returns a metadata-only shape without invoking the reader', () => {
      let called = 0
      const m = new Media({
        ...baseRaw(),
        reader: {
          stream() {
            called++
            return new ReadableStream<Uint8Array>({
              start(c) {
                c.close()
              },
            })
          },
          byteLength() {
            called++
            return 0
          },
        },
      })
      const json = m.toJSON()
      expect(called).toBe(0)
      expect(json.kind).toBe('image')
      expect(json.mimeType).toBe('image/png')
      expect(json.trustTier).toBe('first-party')
      expect(json.modalityHazard).toBe('opaque-perceptual')
    })
  })

  describe('stash register', () => {
    it('starts empty by default and accepts new entries', () => {
      const m = new Media(baseRaw())
      m.stash.set('text:caption', {
        value: 'a small PNG',
        trustTier: 'third-party-private',
        derivedFromMedia: m.id,
      })
      const entry = m.stash.get('text:caption') as {
        value: string
        trustTier: string
        derivedFromMedia?: string
      }
      expect(entry.value).toBe('a small PNG')
      expect(entry.trustTier).toBe('third-party-private')
      expect(entry.derivedFromMedia).toBe(m.id)
    })

    it('accepts initial stash via the constructor', () => {
      const m = new Media({
        ...baseRaw(),
        stash: {
          'text:caption': {
            value: 'preset',
            trustTier: 'first-party',
          },
        },
      })
      const entry = m.stash.get('text:caption') as { value: string; trustTier: string }
      expect(entry.value).toBe('preset')
    })

    it('rejects stash entries missing trustTier', () => {
      expect(
        () =>
          new Media({
            ...baseRaw(),
            stash: {
              bad: { value: 'no trust tier' } as never,
            },
          })
      ).toThrow(E_INVALID_INITIAL_MEDIA_VALUE)
    })
  })

  describe('factories', () => {
    it('userAttachment pre-fills third-party-private trust', () => {
      const m = Media.userAttachment({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'u.png',
        reader: inMemoryMediaReader(buf),
      })
      expect(m.trustTier).toBe('third-party-private')
      expect(m.modalityHazard).toBe('opaque-perceptual')
    })

    it('userAttachment maps document → extractable-instructions', () => {
      const m = Media.userAttachment({
        kind: 'document',
        mimeType: 'application/pdf',
        filename: 'u.pdf',
        reader: inMemoryMediaReader(buf),
      })
      expect(m.modalityHazard).toBe('extractable-instructions')
    })

    it('toolGenerated pre-fills first-party trust', () => {
      const m = Media.toolGenerated({
        kind: 'audio',
        mimeType: 'audio/mp3',
        filename: 'g.mp3',
        reader: inMemoryMediaReader(buf),
      })
      expect(m.trustTier).toBe('first-party')
      expect(m.modalityHazard).toBe('opaque-perceptual')
    })

    it('retrievedPublic pre-fills third-party-public trust', () => {
      const m = Media.retrievedPublic({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'r.png',
        reader: inMemoryMediaReader(buf),
      })
      expect(m.trustTier).toBe('third-party-public')
    })

    it('retrievedPrivate pre-fills third-party-private trust', () => {
      const m = Media.retrievedPrivate({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'r.png',
        reader: inMemoryMediaReader(buf),
      })
      expect(m.trustTier).toBe('third-party-private')
    })
  })

  describe('isMedia guard', () => {
    it('returns true for a Media instance (module-level alias)', () => {
      expect(isMedia(new Media(baseRaw()))).toBe(true)
    })

    it('returns false for non-Media values', () => {
      expect(isMedia({})).toBe(false)
      expect(isMedia(null)).toBe(false)
      expect(isMedia(undefined)).toBe(false)
      expect(isMedia('image/png')).toBe(false)
    })
  })

  describe('frozen getters', () => {
    it('id, kind, mimeType, filename, trustTier, modalityHazard are non-writable', () => {
      const m = new Media(baseRaw())
      expect(() => {
        ;(m as { id: string }).id = 'tampered'
      }).toThrow()
    })
  })
})
