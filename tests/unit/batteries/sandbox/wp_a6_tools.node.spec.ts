import { describe, expect, it, vi } from 'vitest'
import { isInstanceOf } from '../../../../src/lib/utils/guards'
import { createSandboxTools } from '../../../../src/batteries/sandbox/tools'
import { createSandboxEpoch } from '../../../../src/batteries/sandbox/types'
import { SpooledArtifact, SpooledJsonArtifact } from '../../../../src/common'
import { isRejectedSandboxPath } from '../../../../src/batteries/sandbox/paths'
import { E_SANDBOX_FAILED } from '../../../../src/batteries/sandbox/exceptions'
import { InMemorySpoolReader } from '../../../../src/batteries/storage/in_memory'
import type { SandboxHandle } from '../../../../src/batteries/sandbox/manager'
import type { DispatchContext } from '../../../../src/lib/contracts/dispatch_context'
import type { SandboxFileSystem } from '../../../../src/batteries/sandbox/contracts/file_system'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'

const enc = new TextEncoder()
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text))
      c.close()
    },
  })
const policy = undefined
const handle = {
  epoch: createSandboxEpoch(),
  effectivePolicy: () => policy,
  isEpochLive: () => true,
} as unknown as SandboxHandle
const translator: PathTranslator = {
  toRelative: async (p) => {
    if (p === '../escape') throw new Error('escape')
    return p.replace(/^\/+/, '')
  },
  toBackendPath: (p) => `/${p}`,
  redact: (s) => s,
  assertNoSymlinkComponents: async () => undefined,
}
const makeFs = (
  files: Record<string, string>,
  kinds: Record<string, 'file' | 'dir' | 'other'> = {}
) => {
  const written: Record<string, string> = {}
  const fs: SandboxFileSystem = {
    stat: async (p) => {
      if (kinds[p] === 'dir') return { size: 0, version: '1', kind: 'dir' }
      if (kinds[p] === 'other') return { size: 0, version: '1', kind: 'other' }
      if (!(p in files)) throw new Error('missing')
      return { size: enc.encode(files[p]).byteLength, version: '1', kind: 'file' }
    },
    read: vi.fn(async (p) => stream(files[p] ?? '')),
    write: vi.fn(async (p, b) => {
      const r = isInstanceOf(b, 'Uint8Array', Uint8Array) ? b : b.getReader()
      const parts: Uint8Array[] = []
      for (;;) {
        const x = await r.read()
        if (x.done) break
        parts.push(x.value)
      }
      written[p] = new TextDecoder().decode(Buffer.concat(parts.map((x) => Buffer.from(x))))
    }),
    list: async function* () {
      yield { kind: 'done', complete: true }
    },
  }
  return { fs, written }
}
const ctx = (writes: { n: number }, results: unknown[] = []) =>
  ({
    id: 'turn',
    abortSignal: new AbortController().signal,
    turnToolCalls: new Set(results.map((result) => ({ results: result }))),
    emitToolExecutionStart: () => undefined,
    emitToolExecutionEnd: () => undefined,
    storeRetrievableBytes: async (_id: string, bytes: string | ReadableStream<Uint8Array>) => {
      writes.n++
      if (typeof bytes === 'string') return new InMemorySpoolReader(bytes)
      const reader = bytes.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const x = await reader.read()
        if (x.done) break
        chunks.push(x.value)
      }
      return new InMemorySpoolReader(Buffer.concat(chunks.map((x) => Buffer.from(x))))
    },
  }) as unknown as DispatchContext
const options = (
  gate: (ctx: DispatchContext, call: { tool: string; args: unknown }) => unknown,
  fs: SandboxFileSystem
) => ({
  handle,
  fileSystem: fs,
  pathTranslator: translator,
  gate: gate as any,
  writeRoot: '/',
  trustTier: 'first-party' as const,
})

async function tools(gate: any, fs: SandboxFileSystem) {
  return createSandboxTools(options(gate, fs))
}

describe('WP-A6 workspace tools', () => {
  it('requires a gate and declares unique, untrusted tools', async () => {
    const { fs } = makeFs({ '/x': 'x' })
    await expect(
      createSandboxTools({ ...options(undefined as any, fs), gate: undefined as any })
    ).rejects.toMatchObject({ code: 'E_SANDBOX_GATE_REQUIRED' })
    const all = await tools(() => ({ approved: true }), fs)
    expect(new Set(all.map((x) => x.name)).size).toBe(8)
    expect(all.every((x) => x.trusted === false)).toBe(true)
  })

  it('runs approved openings through the store and uses distinct artifact classes', async () => {
    const { fs } = makeFs({ '/x.txt': 'hello', '/x.json': '{bad' })
    const all = await tools(() => ({ approved: true }), fs)
    const writes = { n: 0 }
    const c = ctx(writes)
    const plain = await all[0].executor(c)({ path: '/x.txt' })
    const invalid = await all[1].executor(c)({ path: '/x.json' })
    expect(plain).toBeInstanceOf(SpooledArtifact)
    expect(invalid).toBeInstanceOf(SpooledJsonArtifact)
    expect(writes.n).toBe(2)
    expect(fs.read).toHaveBeenCalledWith('/x.txt', expect.any(Object))
  })

  it('denial is narrated, thrown, and prevents reads and writes', async () => {
    const { fs, written } = makeFs({ '/x': 'secret' })
    const gate = () => ({ approved: false, note: 'no' })
    const all = await tools(gate, fs)
    const c = ctx({ n: 0 })
    await expect(all[0].executor(c)({ path: 'x' })).rejects.toMatchObject({
      code: 'E_TOOL_DOWNSTREAM_ERROR',
    })
    await expect(all[0].executor(c)({ path: 'x' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'E_SANDBOX_REFUSED' }),
    })
    await expect(all[0].executor(c)({ path: 'x' })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/declined/i) }),
    })
    expect(fs.read).not.toHaveBeenCalled()
    expect(written).toEqual({})
  })

  it.each(['open_file', 'stage_file'] as const)(
    'refuses non-regular files before read (%s)',
    async (name) => {
      const { fs } = makeFs({}, { '/fifo': 'other' })
      const all = await tools(() => ({ approved: true }), fs)
      const tool = all.find((x) => x.name === name)!
      await expect(tool.executor(ctx({ n: 0 }))({ path: 'fifo' })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringMatching(/regular file/i) }),
      })
      expect(fs.read).not.toHaveBeenCalled()
    }
  )

  it('narrates path rejection from list and stage read failures', async () => {
    const { fs } = makeFs({ '/x': 'x' })
    const all = await tools(() => ({ approved: true }), fs)
    await expect(all[5].executor(ctx({ n: 0 }))({ path: '../escape' })).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: 'E_SANDBOX_REFUSED',
        message: expect.stringMatching(/Path rejected/),
      }),
    })
    const failing = options(() => ({ approved: true }), fs) as any
    failing.mimeResolver = async () => {
      throw new Error('peek broke')
    }
    const failingTools = await createSandboxTools(failing)
    await expect(failingTools[3].executor(ctx({ n: 0 }))({ path: 'x' })).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: 'E_SANDBOX_FAILED',
        message: expect.stringMatching(/I.O.? failure|peek broke/),
      }),
    })
  })

  it('returns save_media confirmation with relative path and byte count', async () => {
    const { fs } = makeFs({ '/x': 'hello' })
    const all = await tools(() => ({ approved: true }), fs)
    const staged = (await all[3].executor(ctx({ n: 0 }))({ path: 'x' })) as any
    const result = await all[4].executor(ctx({ n: 0 }, [staged]))({
      media_id: staged.id,
      path: 'x',
    })
    expect(result).toContain('x')
    // `'hello'` is FIVE bytes. The count comes from `stat()` after the streaming write, so it
    // reports what actually landed on disk rather than a buffered length — asserting 6 here was
    // simply wrong about the fixture, not a defect in the receipt.
    expect(result).toContain('5 bytes')
  })

  it('rejects omitted, zero, and non-integer search limits', async () => {
    const { fs } = makeFs({})
    const all = await tools(() => ({ approved: true }), fs)
    const search = all.find((x) => x.name === 'search_files')!
    await expect(search.executor(ctx({ n: 0 }))({ pattern: 'x' })).rejects.toThrow()
    await expect(search.executor(ctx({ n: 0 }))({ pattern: 'x', limit: 0 })).rejects.toThrow()
    await expect(search.executor(ctx({ n: 0 }))({ pattern: 'x', limit: 1.5 })).rejects.toThrow()
  })

  it('uses max_depth defaults and overrides, and announces scope without phantom counts', async () => {
    const { fs } = makeFs({})
    fs.list = async function* (_p, o) {
      expect(o.maxDepth).toBe(20)
      yield {
        kind: 'done',
        complete: false,
        omitted: 'unexplored',
        bound: 'maxDepth',
        atDepth: o.maxDepth,
      }
    }
    const all = await tools(() => ({ approved: true }), fs)
    const writes = { n: 0 }
    await all[5].executor(ctx(writes))({ path: 'root' })
    fs.list = async function* (_p, o) {
      expect(o.maxDepth).toBe(3)
      yield { kind: 'done', complete: false, omitted: 'unexplored', bound: 'maxDepth', atDepth: 3 }
    }
    const a = await all[5].executor(ctx(writes))({ path: 'root', max_depth: 3 })
    expect(a).toBeInstanceOf(SpooledJsonArtifact)
    expect((a as object).constructor).toBe(SpooledJsonArtifact)
  })

  it('omits denied directory entries rather than marking them', async () => {
    const { fs } = makeFs({})
    fs.list = async function* () {
      yield { kind: 'item', path: '/root/allowed', entryKind: 'file' }
      yield { kind: 'item', path: '/root/secret', entryKind: 'file' }
      yield { kind: 'done', complete: true }
    }
    const original = handle.effectivePolicy
    ;(handle as any).effectivePolicy = () => ({
      filesystemDisabled: false,
      read: { denyOnly: ['/secret'], allowWithinDeny: [] },
      write: { allowOnly: ['/'], denyWithinAllow: [] },
    })
    const all = await tools(() => ({ approved: true }), fs)
    const result = await all[5].executor(ctx({ n: 0 }))({ path: 'root' })
    const text = await (result as SpooledJsonArtifact).asString()
    expect(text).toContain('allowed')
    expect(text).not.toContain('secret')
    ;(handle as any).effectivePolicy = original
  })

  it('treats no matches as a successful first-line result and missing done as io-failure', async () => {
    const { fs } = makeFs({})
    const all = await tools(() => ({ approved: true }), fs)
    const writes = { n: 0 }
    const searchTools = await tools(() => ({ approved: true }), fs)
    const search = searchTools[6]
    const opts = options(() => ({ approved: true }), fs) as any
    opts.search = {
      searchContent: async function* () {
        yield { kind: 'done', complete: true }
      },
      findPaths: async function* () {
        yield { kind: 'done', complete: true }
      },
    }
    const ss = await createSandboxTools(opts)
    const result = await ss[6].executor(ctx(writes))({ pattern: 'none', path: '', limit: 100 })
    const text = await (result as SpooledJsonArtifact).asString()
    expect(text).toMatch(/^No matches/)
    fs.list = async function* () {
      yield { kind: 'item', path: '/x', entryKind: 'file' }
    }
    await expect(all[5].executor(ctx(writes))({ path: 'root' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'E_SANDBOX_FAILED' }),
    })
    expect(search.name).toBe('search_files')
  })

  // The BYO half of the follow rule: an adapter that HAS verified containment declares it and
  // gets the full option back. Without this, narrowing the shared schema would silently disable
  // the flag for every deployment, which is what makes the narrowing safe rather than blunt.
  it('accepts follow when the adapter declares it contains symlinked descendants', async () => {
    const { fs } = makeFs({})
    const opts = options(() => ({ approved: true }), fs) as any
    const seen: any[] = []
    opts.search = {
      supportsFollow: true,
      searchContent: async function* () {
        yield { kind: 'done', complete: true }
      },
      findPaths: async function* (a: any) {
        seen.push(a)
        yield { kind: 'done', complete: true }
      },
    }
    const all = await createSandboxTools(opts)
    const find = all.find((x) => x.name === 'find_files')!
    await find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1, follow: true })
    expect(seen[0]).toMatchObject({ follow: true })
  })

  it('forwards content-only search fields, truncates over-limit finds, and rejects over-limit list frames', async () => {
    const { fs } = makeFs({})
    const opts = options(() => ({ approved: true }), fs) as any
    const calls: any[] = []
    const findCalls: any[] = []
    opts.search = {
      searchContent: async function* (a: any) {
        calls.push(a)
        yield { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown: 1 }
      },
      findPaths: async function* (a: any) {
        findCalls.push(a)
        yield { kind: 'item', path: '/one.ts' }
        yield { kind: 'done', complete: true }
      },
    }
    const all = await createSandboxTools(opts)
    const content = all.find((x) => x.name === 'search_files')!
    const result = await content.executor(ctx({ n: 0 }))({
      pattern: 'x',
      limit: 1,
      ignore_case: true,
      literal: true,
      glob: '*.ts',
      iglob: '*.TS',
      hidden: true,
      no_ignore: true,
    })
    expect(calls[0]).toMatchObject({
      ignoreCase: true,
      literal: true,
      glob: '*.ts',
      iglob: '*.TS',
      hidden: true,
      noIgnore: true,
    })
    expect(await (result as SpooledJsonArtifact).asString()).toMatch(/1.*1/)
    const find = all.find((x) => x.name === 'find_files')!
    await find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1 })
    expect(findCalls).toHaveLength(1)
    expect(findCalls[0]).not.toHaveProperty('ignoreCase')
    expect(findCalls[0]).not.toHaveProperty('literal')
    opts.search.findPaths = async function* (a: any) {
      findCalls.push(a)
      yield { kind: 'item', path: '/one.ts' }
      yield { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown: 1 }
    }
    // find_files takes a required `limit`, so an over-limit frame is its ORDINARY truncation
    // outcome, not a protocol violation: it returns the matched paths plus a result-limited
    // note. Only `list_directory`, which has no limit, treats such a frame as a backend fault.
    const truncated = await find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1 })
    const truncatedText = await (truncated as SpooledJsonArtifact).asString()
    expect(truncatedText).toContain('one.ts')
    expect(truncatedText).toMatch(/limit/i)
    expect(truncatedText).not.toMatch(/I\/O failure/i)
    // `follow` is rejected at VALIDATION, not at execution, when the adapter has not declared
    // containment of symlinked descendants — no option is advertised that always fails. The rule
    // is a narrowed copy, so an adapter that declares `supportsFollow` still gets the full option.
    await expect(
      find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1, follow: true })
    ).rejects.toThrow()
    await expect(
      content.executor(ctx({ n: 0 }))({ pattern: 'x', limit: 1, follow: true })
    ).rejects.toThrow()
    await expect(
      find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1, ignore_case: true })
    ).rejects.toThrow()
    await expect(
      find.executor(ctx({ n: 0 }))({ glob: '*.ts', limit: 1, literal: true })
    ).rejects.toThrow()
    fs.list = async function* () {
      yield { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown: 1 }
    } as never
    const list = all.find((x) => x.name === 'list_directory')!
    let listError: unknown
    try {
      await list.executor(ctx({ n: 0 }))({ path: 'root' })
    } catch (error) {
      listError = error
    }
    const listMessage = ((listError as { cause?: Error }).cause ?? (listError as Error)).message
    expect(listMessage).toMatch(/I\/O failure/i)
    expect(listMessage).toMatch(/backend/i)
  })

  it('narrates a symlinked-component refusal from save_media rather than leaking the translator error', async () => {
    const { fs } = makeFs({ '/x': 'hello' })
    // A translator that ACCEPTS the path but refuses it as symlinked. This is the security control:
    // an unguarded `assertNoSymlinkComponents` escapes as its native error, so the model receives an
    // unactionable message for the one failure class it could correct.
    const symlinking: PathTranslator = {
      ...translator,
      assertNoSymlinkComponents: async () => {
        throw new Error('symlinked component: x')
      },
    }
    const all = await createSandboxTools({
      ...options(() => ({ approved: true }), fs),
      pathTranslator: symlinking,
    })
    const byName = (name: string) => all.find((t) => t.name === name)!
    const staged = (await byName('stage_file').executor(ctx({ n: 0 }))({ path: 'x' })) as never
    let thrown: unknown
    try {
      await byName('save_media').executor(ctx({ n: 0 }, [staged]))({
        media_id: (staged as { id: string }).id,
        path: 'x',
      })
    } catch (error) {
      thrown = error
    }
    // `Tool.executor()` wraps a handler throw in `E_TOOL_DOWNSTREAM_ERROR` and the adapter appends
    // the IMMEDIATE cause's message — so the narrated exception must be the DIRECT cause, or the
    // narration is one level too deep to reach the model at all.
    expect(thrown).toBeDefined()
    const cause = (thrown as { cause?: unknown }).cause
    expect(cause).toBeInstanceOf(E_SANDBOX_FAILED)
    // Narrator text, NOT the translator's raw message leaking through.
    const narrated = (cause as Error).message
    expect(narrated).not.toContain('symlinked component')
    expect(narrated.toLowerCase()).toContain('path')
  })

  it('narrates a DISTINCT reason per path-rejection class, not a blanket escape', async () => {
    const { fs } = makeFs({ '/x': 'hello' })
    // A translator that refuses whatever the real path layer refuses, so the tool sees the same
    // rejection shape production would.
    const strict: PathTranslator = {
      ...translator,
      toRelative: async (p) => {
        if (isRejectedSandboxPath(p)) throw new Error('rejected')
        return p.replace(/^\/+/, '')
      },
    }
    const all = await createSandboxTools({
      ...options(() => ({ approved: true }), fs),
      pathTranslator: strict,
    })
    const open = all.find((t) => t.name === 'open_file')!
    // Each input is a DIFFERENT mistake and must produce a different remedy. A blanket `escape`
    // tells a model that sent a NUL byte to "use a workspace-relative path", which it cannot act on.
    const cases: Array<[string, string]> = [
      ['a\0b', 'nul'],
      ['~/secrets', 'home'],
      ['C:/Windows', 'absolute-host'],
      ['//server/share', 'unc'],
    ]
    // Assert the REASON-SPECIFIC text. A set of whole messages is NOT discriminating: each message
    // echoes the offending input, so four inputs yield four distinct strings even when every reason
    // collapses to the same remedy — the exact vacuity this test exists to avoid.
    const expected: Record<string, RegExp> = {
      'nul': /NUL byte/i,
      'home': /'~' is not expanded/i,
      'absolute-host': /drive letter/i,
      'unc': /network share/i,
    }
    for (const [input, reason] of cases) {
      let thrown: unknown
      try {
        await open.executor(ctx({ n: 0 }))({ path: input })
      } catch (error) {
        thrown = error
      }
      const cause = (thrown as { cause?: Error }).cause
      expect(cause, `${reason}: expected a narrated cause`).toBeDefined()
      expect(cause!.message, `${reason} must name its own remedy`).toMatch(expected[reason])
    }
  })

  it('does not re-label an already-narrated per-child refusal as an io-failure', async () => {
    // The traversal's catch used to wrap unconditionally, so a per-child `path-rejected` reached the
    // model as "the listing broke" — the classification the seam had just made, discarded.
    const { fs } = makeFs({ '/d': 'x' }, { '/d': 'dir' })
    // The listing yields one entry whose CHILD translation will be refused.
    fs.list = async function* () {
      yield { kind: 'item', path: '/d/child-secret', entryKind: 'file' }
      yield { kind: 'done', complete: true }
    } as never
    const refusing: PathTranslator = {
      ...translator,
      // The ROOT must translate cleanly so the traversal actually starts; only a CHILD is refused.
      // Refusing the root exits before the per-child path ever runs, which is why an earlier version
      // of this test passed even with the fix reverted.
      toBackendPath: (p) => {
        if (p.includes('child-secret')) throw new Error('translator refused')
        return `/${p}`
      },
    }
    const all = await createSandboxTools({
      ...options(() => ({ approved: true }), fs),
      pathTranslator: refusing,
    })
    const list = all.find((t) => t.name === 'list_directory')!
    let thrown: unknown
    try {
      await list.executor(ctx({ n: 0 }))({ path: 'd', max_depth: 2 })
    } catch (error) {
      thrown = error
    }
    const message = ((thrown as { cause?: Error }).cause ?? (thrown as Error)).message
    // It must be the PATH narration, not the I/O catch-all.
    expect(message).toMatch(/Path rejected/)
    expect(message).not.toMatch(/I\/O failure/)
  })
})
