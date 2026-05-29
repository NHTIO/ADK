import { describe, expect, it } from 'vitest'
import { implementsMediaReader, mediaReaderSchema } from '../../../src/lib/contracts/media_reader'

const validReader = () => ({
  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
  },
  byteLength(): number {
    return 3
  },
})

describe('mediaReaderSchema', () => {
  it('accepts a minimal MediaReader-shaped object', () => {
    const { error } = mediaReaderSchema.validate(validReader())
    expect(error).toBeUndefined()
  })

  it('rejects a value missing stream', () => {
    const { error } = mediaReaderSchema.validate({ byteLength: () => 0 })
    expect(error).toBeDefined()
  })

  it('rejects a value missing byteLength', () => {
    const { error } = mediaReaderSchema.validate({ stream: () => null })
    expect(error).toBeDefined()
  })

  it('rejects values where stream is not callable', () => {
    const { error } = mediaReaderSchema.validate({ stream: 1, byteLength: () => 0 })
    expect(error).toBeDefined()
  })

  it('rejects values where byteLength is not callable', () => {
    const { error } = mediaReaderSchema.validate({ stream: () => null, byteLength: 0 })
    expect(error).toBeDefined()
  })

  it('rejects null and undefined', () => {
    expect(mediaReaderSchema.validate(null).error).toBeDefined()
    expect(mediaReaderSchema.validate(undefined).error).toBeDefined()
  })
})

describe('implementsMediaReader', () => {
  it('returns true for a duck-typed plain object', () => {
    expect(implementsMediaReader(validReader())).toBe(true)
  })

  it('returns true for a class instance with stream and byteLength', () => {
    class Reader {
      stream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        })
      }
      byteLength(): number {
        return 0
      }
    }
    expect(implementsMediaReader(new Reader())).toBe(true)
  })

  it('returns false for plain objects missing methods', () => {
    expect(implementsMediaReader({})).toBe(false)
    expect(implementsMediaReader({ stream: () => null })).toBe(false)
    expect(implementsMediaReader({ byteLength: () => 0 })).toBe(false)
  })

  it('returns false for null and undefined', () => {
    expect(implementsMediaReader(null)).toBe(false)
    expect(implementsMediaReader(undefined)).toBe(false)
  })

  it('accepts a byteLength that returns undefined (unknown length)', () => {
    const r = {
      stream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        })
      },
      byteLength(): undefined {
        return undefined
      },
    }
    expect(implementsMediaReader(r)).toBe(true)
  })
})
