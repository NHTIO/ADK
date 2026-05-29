import { Disk } from 'flydrive'
import { resolve } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { FSDriver } from 'flydrive/drivers/fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { implementsSpoolReader } from '../../../../../src/lib/contracts/spool_reader'
import {
  FlydriveSpoolReader,
  FlydriveSpoolStore,
} from '../../../../../src/batteries/storage/flydrive'

// Each test suite gets its own subdirectory under tmp/ so parallel-running specs cannot
// collide. The FSDriver writes here; the directory is wiped before and after the suite.
const TMP_ROOT = resolve(__dirname, '../../../../../../tmp/test-flydrive-battery')

const SAMPLE = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n')

const makeDisk = (subdir: string): Disk => {
  return new Disk(
    new FSDriver({
      location: resolve(TMP_ROOT, subdir),
      visibility: 'public',
    })
  )
}

beforeAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
  await mkdir(TMP_ROOT, { recursive: true })
})

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

describe('FlydriveSpoolReader: eager mode', () => {
  const disk = makeDisk('reader-eager')

  it('reads lines from a flydrive-backed file', async () => {
    await disk.put('sample.txt', SAMPLE)
    // Force eager mode by setting the threshold above the sample size.
    const r = new FlydriveSpoolReader(disk, 'sample.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.line(0)).toBe('alpha')
    expect(await r.line(2)).toBe('gamma')
    expect(await r.line(4)).toBe('epsilon')
  })

  it('reports lineCount() and byteLength() from cached state', async () => {
    await disk.put('sample.txt', SAMPLE)
    const r = new FlydriveSpoolReader(disk, 'sample.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.lineCount()).toBe(5)
    expect(await r.byteLength()).toBe(SAMPLE.length)
  })

  it('returns undefined for out-of-range indices', async () => {
    await disk.put('sample.txt', SAMPLE)
    const r = new FlydriveSpoolReader(disk, 'sample.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.line(-1)).toBeUndefined()
    expect(await r.line(100)).toBeUndefined()
  })

  it('preserves a trailing empty line when content ends with \\n', async () => {
    await disk.put('trailing.txt', 'a\nb\n')
    const r = new FlydriveSpoolReader(disk, 'trailing.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.lineCount()).toBe(3)
    expect(await r.line(0)).toBe('a')
    expect(await r.line(1)).toBe('b')
    expect(await r.line(2)).toBe('')
  })

  it('handles an empty file', async () => {
    await disk.put('empty.txt', '')
    const r = new FlydriveSpoolReader(disk, 'empty.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.lineCount()).toBe(0)
    expect(await r.byteLength()).toBe(0)
    expect(await r.line(0)).toBeUndefined()
  })

  it('reports UTF-8 byte length, not character count', async () => {
    await disk.put('unicode.txt', 'héllo')
    const r = new FlydriveSpoolReader(disk, 'unicode.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(await r.byteLength()).toBe(6)
    expect(await r.line(0)).toBe('héllo')
  })

  it('implements the SpoolReader interface', () => {
    const r = new FlydriveSpoolReader(disk, 'sample.txt')
    expect(implementsSpoolReader(r)).toBe(true)
  })

  describe('readAll', () => {
    it('returns the underlying content verbatim in eager mode', async () => {
      await disk.put('sample.txt', SAMPLE)
      const r = new FlydriveSpoolReader(disk, 'sample.txt', {
        streamThresholdBytes: Number.POSITIVE_INFINITY,
      })
      expect(await r.readAll()).toBe(SAMPLE)
    })

    it('preserves trailing newline in eager mode', async () => {
      const body = 'a\nb\nc\n'
      await disk.put('trailing.txt', body)
      const r = new FlydriveSpoolReader(disk, 'trailing.txt', {
        streamThresholdBytes: Number.POSITIVE_INFINITY,
      })
      expect(await r.readAll()).toBe(body)
    })

    it('preserves CRLF line terminators in eager mode', async () => {
      const body = 'one\r\ntwo\r\nthree'
      await disk.put('crlf.txt', body)
      const r = new FlydriveSpoolReader(disk, 'crlf.txt', {
        streamThresholdBytes: Number.POSITIVE_INFINITY,
      })
      expect(await r.readAll()).toBe(body)
    })

    it('returns an empty string for an empty file in eager mode', async () => {
      await disk.put('empty.txt', '')
      const r = new FlydriveSpoolReader(disk, 'empty.txt', {
        streamThresholdBytes: Number.POSITIVE_INFINITY,
      })
      expect(await r.readAll()).toBe('')
    })
  })
})

describe('FlydriveSpoolReader: streaming mode', () => {
  const disk = makeDisk('reader-streaming')

  it('reads lines via the streaming line-offset index', async () => {
    await disk.put('sample.txt', SAMPLE)
    // Force streaming mode by setting the threshold to 0.
    const r = new FlydriveSpoolReader(disk, 'sample.txt', { streamThresholdBytes: 0 })
    expect(await r.line(0)).toBe('alpha')
    expect(await r.line(2)).toBe('gamma')
    expect(await r.line(4)).toBe('epsilon')
  })

  it('reports lineCount() / byteLength() correctly in streaming mode', async () => {
    await disk.put('sample.txt', SAMPLE)
    const r = new FlydriveSpoolReader(disk, 'sample.txt', { streamThresholdBytes: 0 })
    expect(await r.lineCount()).toBe(5)
    expect(await r.byteLength()).toBe(SAMPLE.length)
  })

  it('streaming mode returns undefined for out-of-range indices', async () => {
    await disk.put('sample.txt', SAMPLE)
    const r = new FlydriveSpoolReader(disk, 'sample.txt', { streamThresholdBytes: 0 })
    expect(await r.line(-1)).toBeUndefined()
    expect(await r.line(5)).toBeUndefined()
  })

  it('streaming mode handles an empty file', async () => {
    await disk.put('empty.txt', '')
    const r = new FlydriveSpoolReader(disk, 'empty.txt', { streamThresholdBytes: 0 })
    expect(await r.lineCount()).toBe(0)
    expect(await r.byteLength()).toBe(0)
    expect(await r.line(0)).toBeUndefined()
  })

  it('streaming mode preserves trailing empty line semantics', async () => {
    await disk.put('trailing.txt', 'a\nb\n')
    const r = new FlydriveSpoolReader(disk, 'trailing.txt', { streamThresholdBytes: 0 })
    expect(await r.lineCount()).toBe(3)
    expect(await r.line(0)).toBe('a')
    expect(await r.line(1)).toBe('b')
    expect(await r.line(2)).toBe('')
  })

  it('streaming mode handles a file larger than the default threshold (eager would still work but uses different path)', async () => {
    // Generate a deterministic ~50 KB file. We then force streaming mode by setting a low
    // threshold; the test verifies that random-access line() calls still return the right
    // content.
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) lines.push(`line-${i.toString().padStart(5, '0')}`)
    const content = lines.join('\n')
    await disk.put('large.txt', content)

    const r = new FlydriveSpoolReader(disk, 'large.txt', { streamThresholdBytes: 0 })
    expect(await r.lineCount()).toBe(5000)
    expect(await r.line(0)).toBe('line-00000')
    expect(await r.line(2500)).toBe('line-02500')
    expect(await r.line(4999)).toBe('line-04999')
  })

  describe('readAll', () => {
    it('streams and concatenates the file in streaming mode', async () => {
      await disk.put('sample.txt', SAMPLE)
      const r = new FlydriveSpoolReader(disk, 'sample.txt', { streamThresholdBytes: 0 })
      expect(await r.readAll()).toBe(SAMPLE)
    })

    it('preserves trailing newline in streaming mode', async () => {
      const body = 'a\nb\nc\n'
      await disk.put('trailing-stream.txt', body)
      const r = new FlydriveSpoolReader(disk, 'trailing-stream.txt', { streamThresholdBytes: 0 })
      expect(await r.readAll()).toBe(body)
    })

    it('preserves CRLF in streaming mode', async () => {
      const body = 'one\r\ntwo\r\nthree'
      await disk.put('crlf-stream.txt', body)
      const r = new FlydriveSpoolReader(disk, 'crlf-stream.txt', { streamThresholdBytes: 0 })
      expect(await r.readAll()).toBe(body)
    })

    it('returns an empty string for an empty file in streaming mode', async () => {
      await disk.put('empty-stream.txt', '')
      const r = new FlydriveSpoolReader(disk, 'empty-stream.txt', { streamThresholdBytes: 0 })
      expect(await r.readAll()).toBe('')
    })

    it('round-trips multibyte UTF-8 in streaming mode', async () => {
      const body = 'héllo\nwörld'
      await disk.put('utf8-stream.txt', body)
      const r = new FlydriveSpoolReader(disk, 'utf8-stream.txt', { streamThresholdBytes: 0 })
      expect(await r.readAll()).toBe(body)
    })
  })

  it('streaming and eager modes return identical content for the same file', async () => {
    await disk.put('same.txt', SAMPLE)
    const eager = new FlydriveSpoolReader(disk, 'same.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    const streaming = new FlydriveSpoolReader(disk, 'same.txt', { streamThresholdBytes: 0 })
    expect(await streaming.lineCount()).toBe(await eager.lineCount())
    expect(await streaming.byteLength()).toBe(await eager.byteLength())
    for (let i = 0; i < 5; i++) {
      expect(await streaming.line(i)).toBe(await eager.line(i))
    }
  })
})

describe('FlydriveSpoolReader: threshold knob', () => {
  const disk = makeDisk('reader-threshold')

  it('files below the default threshold go through eager mode', async () => {
    const small = 'abc\ndef'
    await disk.put('small.txt', small)
    const r = new FlydriveSpoolReader(disk, 'small.txt') // default 10 MiB threshold
    expect(await r.line(0)).toBe('abc')
    expect(await r.byteLength()).toBe(small.length)
  })

  it('rejects a non-finite-negative streamThresholdBytes at construction', () => {
    expect(() => new FlydriveSpoolReader(disk, 'x', { streamThresholdBytes: -1 })).toThrow(
      TypeError
    )
    expect(() => new FlydriveSpoolReader(disk, 'x', { streamThresholdBytes: Number.NaN })).toThrow(
      TypeError
    )
  })

  it('accepts Infinity (forces eager) and 0 (forces streaming)', async () => {
    await disk.put('any.txt', 'hello')
    const eagerForced = new FlydriveSpoolReader(disk, 'any.txt', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    const streamForced = new FlydriveSpoolReader(disk, 'any.txt', {
      streamThresholdBytes: 0,
    })
    expect(await eagerForced.line(0)).toBe('hello')
    expect(await streamForced.line(0)).toBe('hello')
  })
})

describe('FlydriveSpoolStore', () => {
  const disk = makeDisk('store')

  it('write() persists bytes and returns a reader bound to the same key', async () => {
    const store = new FlydriveSpoolStore(disk)
    const reader = await store.write('call-1', 'hello\nworld')
    expect(await reader.line(0)).toBe('hello')
    expect(await reader.line(1)).toBe('world')
  })

  it('read() returns a fresh reader over the previously-written bytes', async () => {
    const store = new FlydriveSpoolStore(disk)
    await store.write('call-2', 'persisted')
    const reader = await store.read('call-2')
    expect(reader).toBeDefined()
    expect(await reader!.line(0)).toBe('persisted')
  })

  it('read() returns undefined for an unknown callId', async () => {
    const store = new FlydriveSpoolStore(disk)
    expect(await store.read('never-written')).toBeUndefined()
  })

  it('delete() removes the underlying object and returns true', async () => {
    const store = new FlydriveSpoolStore(disk)
    await store.write('call-3', 'transient')
    expect(await store.delete('call-3')).toBe(true)
    expect(await store.read('call-3')).toBeUndefined()
  })

  it('delete() returns false for a never-written key', async () => {
    const store = new FlydriveSpoolStore(disk)
    expect(await store.delete('never-written')).toBe(false)
  })

  it('keyFor() composes the prefix and callId', () => {
    const store = new FlydriveSpoolStore(disk, { keyPrefix: 'agent-runs/' })
    expect(store.keyFor('abc-123')).toBe('agent-runs/abc-123')
  })

  it('honours a keyPrefix when writing and reading', async () => {
    const prefixed = new FlydriveSpoolStore(disk, { keyPrefix: 'prefix-test/' })
    await prefixed.write('call-4', 'isolated')
    const reader = await prefixed.read('call-4')
    expect(reader).toBeDefined()
    expect(await reader!.line(0)).toBe('isolated')
    // The underlying disk key has the prefix
    expect(await disk.exists('prefix-test/call-4')).toBe(true)
    // A non-prefixed store cannot see it
    const noPrefix = new FlydriveSpoolStore(disk)
    expect(await noPrefix.read('call-4')).toBeUndefined()
  })

  it('decodes Uint8Array inputs through flydrive', async () => {
    const store = new FlydriveSpoolStore(disk)
    const bytes = new TextEncoder().encode('héllo')
    const reader = await store.write('call-utf8', bytes)
    expect(await reader.line(0)).toBe('héllo')
    expect(await reader.byteLength()).toBe(6)
  })

  it('store default streamThresholdBytes propagates to readers', async () => {
    const streaming = new FlydriveSpoolStore(disk, { streamThresholdBytes: 0 })
    const reader = await streaming.write('call-stream', SAMPLE)
    // We can't directly observe the mode, but lineCount/line should still work correctly.
    expect(await reader.lineCount()).toBe(5)
    expect(await reader.line(2)).toBe('gamma')
  })

  it('per-call streamThresholdBytes overrides the store default', async () => {
    const store = new FlydriveSpoolStore(disk, { streamThresholdBytes: 0 }) // default: streaming
    await store.write('call-override', SAMPLE)
    const eagerOverride = await store.read('call-override', {
      streamThresholdBytes: Number.POSITIVE_INFINITY,
    })
    expect(eagerOverride).toBeDefined()
    expect(await eagerOverride!.line(0)).toBe('alpha')
  })
})
