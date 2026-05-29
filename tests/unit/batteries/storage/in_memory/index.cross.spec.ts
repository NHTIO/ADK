import { describe, expect, it } from 'vitest'
import { implementsSpoolReader } from '../../../../../src/lib/contracts/spool_reader'
import {
  InMemorySpoolReader,
  InMemorySpoolStore,
} from '../../../../../src/batteries/storage/in_memory'

describe('InMemorySpoolReader', () => {
  it('returns each line by 0-based index', () => {
    const r = new InMemorySpoolReader('alpha\nbeta\ngamma')
    expect(r.line(0)).toBe('alpha')
    expect(r.line(1)).toBe('beta')
    expect(r.line(2)).toBe('gamma')
  })

  it('returns undefined for out-of-range indices', () => {
    const r = new InMemorySpoolReader('only')
    expect(r.line(-1)).toBeUndefined()
    expect(r.line(1)).toBeUndefined()
    expect(r.line(100)).toBeUndefined()
  })

  it('reports lineCount() = 0 for an empty string', () => {
    const r = new InMemorySpoolReader('')
    expect(r.lineCount()).toBe(0)
  })

  it('reports lineCount() = 1 for a string with no newlines', () => {
    const r = new InMemorySpoolReader('single')
    expect(r.lineCount()).toBe(1)
  })

  it('preserves trailing empty line when input ends with \\n', () => {
    const r = new InMemorySpoolReader('a\nb\n')
    expect(r.lineCount()).toBe(3)
    expect(r.line(0)).toBe('a')
    expect(r.line(1)).toBe('b')
    expect(r.line(2)).toBe('')
  })

  it('reports byteLength() in UTF-8 bytes, not character count', () => {
    // "héllo" is 5 chars but 6 bytes in UTF-8 (é is two bytes)
    const r = new InMemorySpoolReader('héllo')
    expect(r.byteLength()).toBe(6)
  })

  it('reports byteLength() = 0 for an empty string', () => {
    expect(new InMemorySpoolReader('').byteLength()).toBe(0)
  })

  it('preserves \\r when input uses CRLF line endings', () => {
    // Split only happens on \n, so \r stays attached to the line preceding it
    const r = new InMemorySpoolReader('a\r\nb\r\nc')
    expect(r.line(0)).toBe('a\r')
    expect(r.line(1)).toBe('b\r')
    expect(r.line(2)).toBe('c')
  })

  it('implements the SpoolReader interface', () => {
    expect(implementsSpoolReader(new InMemorySpoolReader('x'))).toBe(true)
  })

  describe('readAll', () => {
    it('returns the original constructor argument verbatim', () => {
      const r = new InMemorySpoolReader('alpha\nbeta\ngamma')
      expect(r.readAll()).toBe('alpha\nbeta\ngamma')
    })

    it('preserves a trailing newline (which cat-style line join would discard)', () => {
      const body = 'a\nb\nc\n'
      expect(new InMemorySpoolReader(body).readAll()).toBe(body)
    })

    it('preserves CRLF line terminators', () => {
      const body = 'one\r\ntwo\r\nthree'
      expect(new InMemorySpoolReader(body).readAll()).toBe(body)
    })

    it('returns an empty string for empty content', () => {
      expect(new InMemorySpoolReader('').readAll()).toBe('')
    })

    it('round-trips multibyte UTF-8 content', () => {
      const body = 'héllo\nwörld'
      expect(new InMemorySpoolReader(body).readAll()).toBe(body)
    })
  })
})

describe('InMemorySpoolStore', () => {
  it('starts empty', () => {
    const store = new InMemorySpoolStore()
    expect(store.size).toBe(0)
  })

  it('write() returns a reader bound to the stored bytes', () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('call-1', 'hello\nworld')
    expect(reader.line(0)).toBe('hello')
    expect(reader.line(1)).toBe('world')
  })

  it('write() increments the store size', () => {
    const store = new InMemorySpoolStore()
    store.write('call-1', 'a')
    store.write('call-2', 'b')
    expect(store.size).toBe(2)
  })

  it('decodes Uint8Array inputs as UTF-8', () => {
    const store = new InMemorySpoolStore()
    const bytes = new TextEncoder().encode('héllo')
    const reader = store.write('call-1', bytes)
    expect(reader.line(0)).toBe('héllo')
    expect(reader.byteLength()).toBe(6)
  })

  it('read() returns a reader over the stored bytes', () => {
    const store = new InMemorySpoolStore()
    store.write('call-1', 'persisted')
    const reader = store.read('call-1')
    expect(reader).toBeDefined()
    expect(reader!.line(0)).toBe('persisted')
  })

  it('read() returns undefined for unknown callIds', () => {
    const store = new InMemorySpoolStore()
    expect(store.read('never-written')).toBeUndefined()
  })

  it('write() and read() return fresh reader instances', () => {
    const store = new InMemorySpoolStore()
    const writeReader = store.write('call-1', 'shared')
    const readReader = store.read('call-1')
    expect(readReader).not.toBe(writeReader)
    expect(readReader!.line(0)).toBe(writeReader.line(0))
  })

  it('rewriting the same callId replaces the prior entry', () => {
    const store = new InMemorySpoolStore()
    store.write('call-1', 'first')
    store.write('call-1', 'second')
    expect(store.size).toBe(1)
    expect(store.read('call-1')!.line(0)).toBe('second')
  })

  it('rewriting does NOT invalidate readers handed out before the rewrite', () => {
    const store = new InMemorySpoolStore()
    const firstReader = store.write('call-1', 'first')
    store.write('call-1', 'second')
    // The first reader has its own snapshot of 'first'
    expect(firstReader.line(0)).toBe('first')
  })

  it('delete() removes the entry and returns true', () => {
    const store = new InMemorySpoolStore()
    store.write('call-1', 'x')
    expect(store.delete('call-1')).toBe(true)
    expect(store.size).toBe(0)
    expect(store.read('call-1')).toBeUndefined()
  })

  it('delete() returns false when the entry was never written', () => {
    const store = new InMemorySpoolStore()
    expect(store.delete('never-written')).toBe(false)
  })

  it('clear() empties the store', () => {
    const store = new InMemorySpoolStore()
    store.write('call-1', 'a')
    store.write('call-2', 'b')
    store.clear()
    expect(store.size).toBe(0)
    expect(store.read('call-1')).toBeUndefined()
  })

  it('clear() does NOT invalidate readers handed out earlier', () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('call-1', 'live')
    store.clear()
    expect(reader.line(0)).toBe('live')
  })

  it('handles empty bytes correctly', () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('call-empty', '')
    expect(reader.lineCount()).toBe(0)
    expect(reader.byteLength()).toBe(0)
  })

  it('handles empty Uint8Array correctly', () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('call-empty', new Uint8Array(0))
    expect(reader.lineCount()).toBe(0)
    expect(reader.byteLength()).toBe(0)
  })
})
