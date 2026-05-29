import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Message } from '../../../src/lib/classes/message'
import { Identity } from '../../../src/lib/classes/identity'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { E_INVALID_INITIAL_MESSAGE_VALUE } from '../../../src/lib/exceptions/runtime'
import type { Media } from '../../../src/lib/classes/media'

const validRaw = () => ({
  id: 'msg-1',
  role: 'user' as const,
  content: 'hello, world',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
})

describe('Message', () => {
  describe('construction', () => {
    it('accepts valid raw input with user role', () => {
      const m = new Message(validRaw())
      expect(m.id).toBe('msg-1')
      expect(m.role).toBe('user')
    })

    it('accepts assistant role', () => {
      const m = new Message({ ...validRaw(), role: 'assistant' })
      expect(m.role).toBe('assistant')
    })

    it('normalises temporal fields to DateTime instances', () => {
      const m = new Message(validRaw())
      expect(DateTime.isDateTime(m.createdAt)).toBe(true)
      expect(DateTime.isDateTime(m.updatedAt)).toBe(true)
    })

    it('wraps a plain string content into a Tokenizable', () => {
      const m = new Message(validRaw())
      expect(Tokenizable.isTokenizable(m.content)).toBe(true)
      expect(m.content?.toString()).toBe('hello, world')
    })

    it('passes through an existing Tokenizable content unchanged', () => {
      const t = new Tokenizable('pre-wrapped')
      const m = new Message({ ...validRaw(), content: t })
      expect(m.content).toBe(t)
    })

    it('defaults the identity to the role string when omitted', () => {
      const m = new Message(validRaw())
      expect(Identity.isIdentity(m.identity)).toBe(true)
      expect(m.identity.identifier).toBe('user')
      expect(m.identity.representation.toString()).toBe('user')
    })

    it('accepts a string identity (mapped to identifier and representation)', () => {
      const m = new Message({ ...validRaw(), identity: 'alice' })
      expect(m.identity.identifier).toBe('alice')
      expect(m.identity.representation.toString()).toBe('alice')
    })

    it('accepts a RawIdentity object identity', () => {
      const m = new Message({
        ...validRaw(),
        identity: { identifier: 'alice-id', representation: 'Alice' },
      })
      expect(m.identity.identifier).toBe('alice-id')
      expect(m.identity.representation.toString()).toBe('Alice')
    })

    it('accepts an existing Identity instance and preserves its values', () => {
      const idObj = new Identity({ identifier: 'alice-id', representation: 'Alice' })
      const m = new Message({ ...validRaw(), identity: idObj })
      expect(Identity.isIdentity(m.identity)).toBe(true)
      expect(m.identity.identifier).toBe('alice-id')
      expect(m.identity.representation.toString()).toBe('Alice')
    })
  })

  describe('validation', () => {
    it('throws when id is missing', () => {
      expect(
        () =>
          new Message({
            role: 'user' as const,
            content: 'x',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          } as unknown as ReturnType<typeof validRaw>)
      ).toThrow(E_INVALID_INITIAL_MESSAGE_VALUE)
    })

    it('throws when role is not user or assistant', () => {
      expect(
        () =>
          new Message({
            ...validRaw(),
            role: 'system' as unknown as 'user',
          })
      ).toThrow(E_INVALID_INITIAL_MESSAGE_VALUE)
    })

    it('throws when both content and attachments are missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.content
      expect(() => new Message(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_MESSAGE_VALUE
      )
    })

    it('throws when createdAt is unparseable', () => {
      expect(() => new Message({ ...validRaw(), createdAt: 'not a date' })).toThrow(
        E_INVALID_INITIAL_MESSAGE_VALUE
      )
    })
  })

  describe('attachments', () => {
    const makeImage = async () => {
      const { Media } = await import('../../../src/lib/classes/media')
      const { inMemoryMediaReader } = await import('../../../src/lib/helpers/media_readers')
      return new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'x.png',
        reader: inMemoryMediaReader(new Uint8Array([1, 2, 3])),
        trustTier: 'third-party-private',
        modalityHazard: 'opaque-perceptual',
      })
    }

    it('accepts content + attachments together', async () => {
      const img = await makeImage()
      const m = new Message({ ...validRaw(), attachments: [img] })
      expect(m.attachments).toHaveLength(1)
      expect(m.content?.toString()).toBe('hello, world')
    })

    it('accepts attachments only with no content', async () => {
      const img = await makeImage()
      const raw = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete raw.content
      const m = new Message({
        ...(raw as ReturnType<typeof validRaw>),
        attachments: [img],
      })
      expect(m.content).toBeUndefined()
      expect(m.attachments).toHaveLength(1)
    })

    it('throws when attachments is empty and content is missing', async () => {
      const raw = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete raw.content
      expect(
        () =>
          new Message({
            ...(raw as ReturnType<typeof validRaw>),
            attachments: [],
          })
      ).toThrow(E_INVALID_INITIAL_MESSAGE_VALUE)
    })

    it('defaults attachments to an empty array when omitted', () => {
      const m = new Message(validRaw())
      expect(m.attachments).toEqual([])
    })

    it('rejects non-Media entries in attachments', () => {
      expect(
        () =>
          new Message({
            ...validRaw(),
            attachments: [{ foo: 'bar' } as never],
          })
      ).toThrow(E_INVALID_INITIAL_MESSAGE_VALUE)
    })

    it('exposes attachments as a frozen array', async () => {
      const img = await makeImage()
      const m = new Message({ ...validRaw(), attachments: [img] })
      expect(() => {
        ;(m.attachments as unknown as Media[]).push(img)
      }).toThrow()
    })
  })

  describe('Message.isMessage', () => {
    it('returns true for Message instances', () => {
      expect(Message.isMessage(new Message(validRaw()))).toBe(true)
    })

    it('returns false for plain objects of the same shape', () => {
      expect(Message.isMessage(validRaw())).toBe(false)
    })
  })
})
