/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { isObject, implementsSpoolReader } from '@nhtio/adk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OpfsSpoolReader, OpfsSpoolStore } from '@nhtio/adk/batteries/storage/opfs'
import type { OpfsDirectoryHandle, OpfsFileHandle } from '@nhtio/adk/batteries/storage/opfs'

// OPFS is not exposed to scripts in the playwright-bundled WebKit build that this repo's
// browser-project matrix targets — `navigator.storage.getDirectory()` throws `UnknownError`
// immediately. Probe once and skip the entire suite on engines that cannot host OPFS so the
// chromium/firefox runs still cover the implementation while webkit reports a clean skip.
const opfsAvailable: boolean = await (async () => {
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
})()

const describeOpfs = opfsAvailable ? describe : describe.skip

// Per-suite OPFS subdirectory. Constructed in beforeAll, torn down in afterAll. Each test
// asks the store to use this directory via the `directory` thunk option so we never leak
// state into the OPFS origin root or across runs.
const SUITE_DIR = 'test-opfs-spool-store'
let suiteRoot: OpfsDirectoryHandle

const directoryThunk = async (): Promise<OpfsDirectoryHandle> => suiteRoot

const isNotFoundError = (err: unknown): boolean =>
  isObject(err) && (err as { name?: unknown }).name === 'NotFoundError'

// WebKit's OPFS surface (in the playwright-bundled WebKit) does not reliably support
// `removeEntry({ recursive: true })` — it throws `UnknownError`. Try the recursive form
// first (fast path used by chromium/firefox); on failure, walk the directory and drop child
// entries individually before removing the now-empty directory itself.
const removeEntryRecursively = async (parent: OpfsDirectoryHandle, name: string): Promise<void> => {
  try {
    await parent.removeEntry(name, { recursive: true })
    return
  } catch (err) {
    if (isNotFoundError(err)) return
    // Fall through to manual walk.
  }
  let dir: OpfsDirectoryHandle
  try {
    dir = await parent.getDirectoryHandle(name)
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }
  const iterable = dir as unknown as AsyncIterable<{ kind: string; name: string }>
  const entries: { kind: string; name: string }[] = []
  for await (const entry of iterable) {
    entries.push({ kind: entry.kind, name: entry.name })
  }
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      await removeEntryRecursively(dir, entry.name)
    } else {
      try {
        await dir.removeEntry(entry.name)
      } catch (err) {
        if (!isNotFoundError(err)) throw err
      }
    }
  }
  try {
    await parent.removeEntry(name)
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }
}

const clearSuiteRoot = async (): Promise<void> => {
  const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle
  await removeEntryRecursively(root, SUITE_DIR)
  suiteRoot = await root.getDirectoryHandle(SUITE_DIR, { create: true })
}

describeOpfs('OPFS battery (browser)', () => {
  beforeAll(async () => {
    await clearSuiteRoot()
  })

  afterAll(async () => {
    const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle
    await removeEntryRecursively(root, SUITE_DIR)
  })

  // Wipe the OPFS suite directory between tests so files written by one test do not bleed into
  // another. Each test then re-resolves its own files via the per-test store.
  beforeEach(async () => {
    await clearSuiteRoot()
  })

  describe('OpfsSpoolReader: eager mode', () => {
    it('reads each line by 0-based index', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('sample', 'alpha\nbeta\ngamma')
      expect(await reader.line(0)).toBe('alpha')
      expect(await reader.line(1)).toBe('beta')
      expect(await reader.line(2)).toBe('gamma')
    })

    it('returns undefined for out-of-range indices', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('one', 'only')
      expect(await reader.line(-1)).toBeUndefined()
      expect(await reader.line(1)).toBeUndefined()
      expect(await reader.line(100)).toBeUndefined()
    })

    it('reports lineCount() = 0 for an empty file', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('empty', '')
      expect(await reader.lineCount()).toBe(0)
      expect(await reader.byteLength()).toBe(0)
    })

    it('preserves a trailing empty line when content ends in \\n', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('trailing', 'a\nb\n')
      expect(await reader.lineCount()).toBe(3)
      expect(await reader.line(0)).toBe('a')
      expect(await reader.line(1)).toBe('b')
      expect(await reader.line(2)).toBe('')
    })

    it('reports byteLength() in UTF-8 bytes', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('uni', 'héllo')
      expect(await reader.byteLength()).toBe(6)
    })

    it('implements the SpoolReader interface', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('iface', 'x')
      expect(implementsSpoolReader(reader)).toBe(true)
    })

    describe('readAll', () => {
      it('returns the original content verbatim', async () => {
        const store = new OpfsSpoolStore({ directory: directoryThunk })
        const reader = await store.write('round', 'alpha\nbeta\ngamma')
        expect(await reader.readAll()).toBe('alpha\nbeta\ngamma')
      })

      it('preserves a trailing newline', async () => {
        const store = new OpfsSpoolStore({ directory: directoryThunk })
        const reader = await store.write('tr', 'a\nb\nc\n')
        expect(await reader.readAll()).toBe('a\nb\nc\n')
      })

      it('preserves CRLF line terminators', async () => {
        const store = new OpfsSpoolStore({ directory: directoryThunk })
        const reader = await store.write('crlf', 'one\r\ntwo\r\nthree')
        expect(await reader.readAll()).toBe('one\r\ntwo\r\nthree')
      })
    })
  })

  describe('OpfsSpoolReader: streaming mode', () => {
    // streamThresholdBytes: 0 forces streaming mode even for tiny payloads — perfect for
    // exercising the line-offset index without writing megabytes of fixture.
    const streamOpts = { streamThresholdBytes: 0 }

    it('reads each line by 0-based index in streaming mode', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const reader = await store.write('s', 'alpha\nbeta\ngamma')
      expect(await reader.line(0)).toBe('alpha')
      expect(await reader.line(1)).toBe('beta')
      expect(await reader.line(2)).toBe('gamma')
    })

    it('reports byteLength() and lineCount() correctly in streaming mode', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const reader = await store.write('s2', 'alpha\nbeta\ngamma')
      expect(await reader.lineCount()).toBe(3)
      expect(await reader.byteLength()).toBe('alpha\nbeta\ngamma'.length)
    })

    it('preserves a trailing empty line when content ends in \\n (streaming)', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const reader = await store.write('s3', 'a\nb\n')
      expect(await reader.lineCount()).toBe(3)
      expect(await reader.line(0)).toBe('a')
      expect(await reader.line(1)).toBe('b')
      expect(await reader.line(2)).toBe('')
    })

    it('handles an empty file in streaming mode (lineCount 0, byteLength 0)', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const reader = await store.write('s4', '')
      expect(await reader.lineCount()).toBe(0)
      expect(await reader.byteLength()).toBe(0)
      expect(await reader.line(0)).toBeUndefined()
    })

    it('eager and streaming agree on the same content', async () => {
      const body = 'one\ntwo\nthree\nfour'
      const eagerStore = new OpfsSpoolStore({ directory: directoryThunk })
      const streamStore = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const eager = await eagerStore.write('eq-eager', body)
      const stream = await streamStore.write('eq-stream', body)
      expect(await stream.lineCount()).toBe(await eager.lineCount())
      expect(await stream.byteLength()).toBe(await eager.byteLength())
      for (let i = 0; i < (await eager.lineCount()); i++) {
        expect(await stream.line(i)).toBe(await eager.line(i))
      }
    })

    it('readAll() reproduces the underlying bytes in streaming mode', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk, ...streamOpts })
      const reader = await store.write('all', 'a\nb\nc\n')
      expect(await reader.readAll()).toBe('a\nb\nc\n')
    })
  })

  describe('OpfsSpoolReader: threshold knob', () => {
    it('rejects negative and NaN thresholds', () => {
      const dummy = { getFile: async () => new File([], 'x') } as unknown as OpfsFileHandle
      expect(() => new OpfsSpoolReader(dummy, { streamThresholdBytes: -1 })).toThrow(TypeError)
      expect(() => new OpfsSpoolReader(dummy, { streamThresholdBytes: Number.NaN })).toThrow(
        TypeError
      )
    })

    it('honours streamThresholdBytes: Infinity → eager regardless of size', async () => {
      const store = new OpfsSpoolStore({
        directory: directoryThunk,
        streamThresholdBytes: Number.POSITIVE_INFINITY,
      })
      const reader = await store.write('big', 'a\nb\nc')
      // Eager mode is observable indirectly: readAll() on streaming-mode never sees a cache,
      // but for our purposes the public API is the contract; just verify it works.
      expect(await reader.line(0)).toBe('a')
      expect(await reader.line(2)).toBe('c')
    })
  })

  describe('OpfsSpoolStore', () => {
    it('write() returns a reader bound to the stored bytes', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('w1', 'hello\nworld')
      expect(OpfsSpoolReader.isOpfsSpoolReader(reader)).toBe(true)
      expect(await reader.line(0)).toBe('hello')
      expect(await reader.line(1)).toBe('world')
    })

    it('decodes Uint8Array inputs as UTF-8', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const bytes = new TextEncoder().encode('héllo')
      const reader = await store.write('u8', bytes)
      expect(await reader.line(0)).toBe('héllo')
      expect(await reader.byteLength()).toBe(6)
    })

    it('read() returns a reader over the stored bytes', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      await store.write('persist', 'persisted')
      const reader = await store.read('persist')
      expect(reader).toBeDefined()
      expect(await reader!.line(0)).toBe('persisted')
    })

    it('read() returns undefined for unknown callIds', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      expect(await store.read('never')).toBeUndefined()
    })

    it('rewriting the same callId replaces the prior entry', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      await store.write('over', 'first')
      await store.write('over', 'second')
      const reader = await store.read('over')
      expect(await reader!.line(0)).toBe('second')
    })

    it('has() reports existence and non-existence correctly', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      expect(await store.has('miss')).toBe(false)
      await store.write('hit', 'present')
      expect(await store.has('hit')).toBe(true)
    })

    it('delete() removes the entry and returns true', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      await store.write('del', 'x')
      expect(await store.delete('del')).toBe(true)
      expect(await store.has('del')).toBe(false)
    })

    it('delete() returns false when the entry was never written (idempotent)', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      expect(await store.delete('never-written')).toBe(false)
    })

    it('keyFor() prepends the keyPrefix to the callId', () => {
      const store = new OpfsSpoolStore({ keyPrefix: 'agent-runs-' })
      expect(store.keyFor('abc')).toBe('agent-runs-abc')
    })

    it('rejects a keyPrefix containing a path separator (it is a filename prefix, not a dir)', () => {
      // REGRESSION: a trailing-slash prefix (e.g. 'agent-spool/') used as if it were a subdirectory
      // produced `getFileHandle('agent-spool/…')` → "Name is not allowed" on EVERY write — a silent
      // runtime footgun. The constructor must reject '/' and '\\' up front with an actionable message.
      expect(() => new OpfsSpoolStore({ keyPrefix: 'agent-spool/' })).toThrow(/filename prefix/)
      expect(() => new OpfsSpoolStore({ keyPrefix: 'a\\b' })).toThrow(/must not contain/)
      // The error suggests a flat alternative.
      expect(() => new OpfsSpoolStore({ keyPrefix: 'agent-spool/' })).toThrow(/agent-spool-/)
    })

    it('keyPrefix applied to writes — files land at the prefixed name on the underlying dir', async () => {
      const prefixed = new OpfsSpoolStore({ directory: directoryThunk, keyPrefix: 'pfx-' })
      await prefixed.write('only', 'value')
      // The raw OPFS handle should expose a file at the prefixed name, and not at the bare name.
      await expect(suiteRoot.getFileHandle('pfx-only')).resolves.toBeDefined()
      await expect(suiteRoot.getFileHandle('only')).rejects.toMatchObject({ name: 'NotFoundError' })

      // A different store with no prefix should not find the prefixed file under the bare name.
      const noPrefix = new OpfsSpoolStore({ directory: directoryThunk })
      expect(await noPrefix.has('only')).toBe(false)
      expect(await noPrefix.has('pfx-only')).toBe(true)
    })

    it('isOpfsSpoolStore guards correctly', () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      expect(OpfsSpoolStore.isOpfsSpoolStore(store)).toBe(true)
      expect(OpfsSpoolStore.isOpfsSpoolStore({})).toBe(false)
      expect(OpfsSpoolStore.isOpfsSpoolStore(null)).toBe(false)
      expect(OpfsSpoolStore.isOpfsSpoolStore(undefined)).toBe(false)
    })

    it('isOpfsSpoolReader guards correctly', async () => {
      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.write('guard', 'x')
      expect(OpfsSpoolReader.isOpfsSpoolReader(reader)).toBe(true)
      expect(OpfsSpoolReader.isOpfsSpoolReader({})).toBe(false)
      expect(OpfsSpoolReader.isOpfsSpoolReader(null)).toBe(false)
    })

    it('lazily resolves the root directory — constructor does not touch OPFS', () => {
      let invoked = false
      const lazy = new OpfsSpoolStore({
        directory: async () => {
          invoked = true
          return suiteRoot
        },
      })
      expect(invoked).toBe(false)
      // Sanity: still a usable instance.
      expect(OpfsSpoolStore.isOpfsSpoolStore(lazy)).toBe(true)
    })
  })

  describe('OpfsSpoolStore + worker write path (sync access handle)', () => {
    // Verifies that data written from a worker context (via `FileSystemSyncAccessHandle`) is
    // readable from the main thread via the same `OpfsSpoolStore`. The worker runs inline via a
    // Blob URL so this test stays self-contained. The worker writes the file under the suite
    // directory using the raw OPFS API — which is exactly what `OpfsSpoolStore.write()` does on
    // the worker side of the auto-select.
    it('reads bytes written by a worker using FileSystemSyncAccessHandle', async () => {
      const workerSource = `
      self.addEventListener('message', async (e) => {
        const { suiteDirName, fileName, text } = e.data
        try {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle(suiteDirName, { create: true })
          const fileHandle = await dir.getFileHandle(fileName, { create: true })
          const sync = await fileHandle.createSyncAccessHandle()
          try {
            const bytes = new TextEncoder().encode(text)
            sync.truncate(0)
            sync.write(bytes, { at: 0 })
            sync.flush()
          } finally {
            sync.close()
          }
          self.postMessage({ ok: true })
        } catch (err) {
          self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) })
        }
      })
    `
      const blobUrl = URL.createObjectURL(
        new Blob([workerSource], { type: 'application/javascript' })
      )
      const worker = new Worker(blobUrl)
      try {
        const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
          worker.addEventListener('message', (e) => resolve(e.data), { once: true })
        })
        worker.postMessage({
          suiteDirName: SUITE_DIR,
          fileName: 'worker-written',
          text: 'from-worker\nsecond-line',
        })
        const result = await done
        expect(result.ok).toBe(true)
      } finally {
        worker.terminate()
        URL.revokeObjectURL(blobUrl)
      }

      const store = new OpfsSpoolStore({ directory: directoryThunk })
      const reader = await store.read('worker-written')
      expect(reader).toBeDefined()
      expect(await reader!.line(0)).toBe('from-worker')
      expect(await reader!.line(1)).toBe('second-line')
    })
  })
})
