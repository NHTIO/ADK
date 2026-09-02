import { describe, expect, it, vi } from 'vitest'
import { SpooledJsonArtifact } from '../../../../src/common'
import { forgeDevTools } from '../../../../src/batteries/dev_tools/forge'
import { createDevPipeline, E_DEV_STEP_FAILED } from '../../../../src/batteries/dev_tools'
import { assembleChanges, makeDevFileAccess } from '../../../../src/batteries/dev_tools/runtime'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
const translator = {
  toRelative: async (path: string) => path.replace(/^\//, ''),
  toBackendPath: (path: string) => `/root${path ? `/${path}` : ''}`,
  redact: (path: string) => path,
  assertNoSymlinkComponents: async () => {},
}
const rules: any = {
  matcher: {
    platform: 'darwin',
    caseInsensitive: false,
    readGlobs: 'native',
    writeGlobs: 'native',
  },
  read: { denyOnly: [], allowWithinDeny: [] },
  write: { allowOnly: [], denyWithinAllow: [] },
  mandatoryDeny: { form: 'glob', entries: [], allowGitConfig: false, searchDepth: 3 },
  filesystemDisabled: true,
  network: { disabled: false, allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  unknownKeys: [],
  undecidableGlobs: [],
}
const disk = (initial: Record<string, string>) => {
  const entries = new Map(Object.entries(initial).map(([path, text]) => [`/root/${path}`, text]))
  const fs: any = {
    stat: async (path: string) => {
      if (!entries.has(path)) throw new Error('ENOENT')
      return { size: entries.get(path)!.length, version: '1', kind: 'file' as const }
    },
    read: async (path: string) => {
      const text = entries.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return stream(text)
    },
    write: async (path: string, bytes: Uint8Array) => {
      entries.set(path, decoder.decode(bytes))
    },
    delete: async (path: string) => {
      entries.delete(path)
    },
    rename: async (from: string, to: string) => {
      const text = entries.get(from)
      if (text === undefined) throw new Error('ENOENT')
      entries.delete(from)
      entries.set(to, text)
    },
    mkdir: async () => {},
    async *list() {
      for (const path of entries.keys())
        yield { kind: 'item' as const, path, entryKind: 'file' as const }
      yield { kind: 'done' as const, complete: true as const }
    },
  }
  return { entries, fs }
}
const pipeline = async (
  fs: any,
  engines: any[] = [],
  gate: any = async () => ({ approved: true }),
  bounds?: Record<string, number>
) =>
  createDevPipeline({
    handle: { effectivePolicy: () => rules },
    fileSystem: fs,
    pathTranslator: translator,
    gate,
    root: '/root',
    engines,
    bounds,
  } as any)
const invocation: any = {
  engineId: 'fixer',
  scope: ['src/**'],
  selector: null,
  needs: [],
  paths: ['src/a.ts'],
}

// These deliberately exercise the public pipeline where the behaviour is observable by engines.
describe('WP5-2 DevFileAccess', () => {
  it('requires read and write policy axes, confines creates by absence, and distinguishes exists refusal from stat failure', async () => {
    const store = disk({ 'src/a.ts': 'a', 'src/unacquired.ts': 'u' })
    const access = makeDevFileAccess({
      invocation: { ...invocation, needs: ['mkdir'] },
      allowlist: ['src/a.ts'],
      fileSystem: store.fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(access.read('src/a.ts')).resolves.toBe('a')
    await access.write('src/new.ts', 'new')
    await expect(access.write('src/unacquired.ts', 'no')).rejects.toThrow(E_DEV_STEP_FAILED)
    await expect(access.write('other/no.ts', 'no')).rejects.toThrow(E_DEV_STEP_FAILED)
    await expect(access.exists('src/missing.ts')).resolves.toBe(false)
    await expect(access.exists('/src/a.ts')).rejects.toThrow(E_DEV_STEP_FAILED)
    const noMkdir = makeDevFileAccess({
      invocation,
      allowlist: ['src/a.ts'],
      fileSystem: disk({ 'src/a.ts': 'a' }).fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(noMkdir.write('src/new.ts', 'new')).rejects.toThrow(/mkdir.*needs/)
    const deniedRead = makeDevFileAccess({
      invocation: { ...invocation, needs: ['mkdir'] },
      allowlist: ['src/a.ts'],
      fileSystem: store.fs,
      pathTranslator: translator as any,
      policy: { canRead: () => false, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    const deniedWrite = makeDevFileAccess({
      invocation: { ...invocation, needs: ['mkdir'] },
      allowlist: ['src/a.ts'],
      fileSystem: store.fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => false },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(deniedRead.read('src/a.ts')).rejects.toThrow(E_DEV_STEP_FAILED)
    await expect(deniedWrite.read('src/a.ts')).rejects.toThrow(E_DEV_STEP_FAILED)
  })

  it('refuses a parent that becomes a symlink immediately before creating it', async () => {
    let srcStats = 0
    const mkdir = vi.fn(async () => {})
    const fs: any = {
      stat: async (path: string) => {
        if (path === '/root') return { size: 0, version: '1', kind: 'dir' }
        if (path === '/root/src' && ++srcStats > 2)
          return { size: 0, version: '1', kind: 'symlink' }
        throw new Error('ENOENT')
      },
      mkdir,
      write: vi.fn(async () => {}),
    }
    const access = makeDevFileAccess({
      invocation: { ...invocation, needs: ['mkdir'] },
      allowlist: [],
      fileSystem: fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(access.write('src/new.ts', 'new')).rejects.toThrow()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('requires declared destructive needs and checks both rename endpoints', async () => {
    const store = disk({ 'src/a.ts': 'a', 'src/taken.ts': 'taken' })
    const noNeeds = makeDevFileAccess({
      invocation,
      allowlist: ['src/a.ts'],
      fileSystem: store.fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(noNeeds.delete('src/a.ts')).rejects.toThrow(/delete.*needs/)
    await expect(noNeeds.rename('src/a.ts', 'src/b.ts')).rejects.toThrow(/rename.*needs/)
    await expect(noNeeds.mkdir('src/dir')).rejects.toThrow(/mkdir.*needs/)
    const access = makeDevFileAccess({
      invocation: { ...invocation, needs: ['delete', 'rename', 'mkdir'] },
      allowlist: ['src/a.ts', 'src/b.ts'],
      fileSystem: store.fs,
      pathTranslator: translator as any,
      policy: { canRead: () => true, canWrite: () => true },
      selector: null,
      renameDestinations: new Set(),
    })
    await expect(access.rename('src/a.ts', 'src/taken.ts')).rejects.toThrow(/already exists/)
    await access.rename('src/a.ts', 'src/b.ts')
    await access.delete('src/b.ts')
    await access.mkdir('src/dir')
  })
})

describe('WP5-2 dirty-path withholding', () => {
  it('withholds an earlier in-memory edit from an in-place formatter access allowlist and scope', async () => {
    const store = disk({ 'src/a.ts': 'old' })
    const seen = vi.fn()
    const engine = {
      id: 'fixer',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          format: async (request: any) => {
            seen(request.paths, request.access.scope)
            await expect(request.access.read('src/a.ts')).rejects.toThrow(E_DEV_STEP_FAILED)
            return {}
          },
        },
      ],
    }
    const pipelineResult1 = await pipeline(store.fs, [engine])
    await pipelineResult1.ops(
      ['src/a.ts'],
      [
        { step: 'edit', args: { path: 'src/a.ts', edits: [{ find: 'old', replace: 'memory' }] } },
        { step: 'format', args: {} },
      ]
    )
    expect(seen).toHaveBeenCalledWith([], [])
  })

  it('keeps paths available to a second in-place fixer after the first re-read reconciles them', async () => {
    const store = disk({ 'src/a.ts': 'old' })
    const second = vi.fn()
    const engine = {
      id: 'fixers',
      lints: [
        {
          extensions: ['ts'],
          fixable: true,
          inPlace: true,
          scope: ['src/**'],
          needs: ['mkdir'],
          lint: async (request: any) => {
            await request.access.write('src/a.ts', 'first')
            return {}
          },
        },
        {
          extensions: ['ts'],
          fixable: true,
          inPlace: true,
          scope: ['src/**'],
          needs: ['mkdir'],
          lint: async (request: any) => {
            second(request.paths, request.access.scope)
            await request.access.write('src/a.ts', 'second')
            return {}
          },
        },
      ],
    }
    const fixerPipeline = await pipeline(store.fs, [engine])
    const result = await fixerPipeline.ops(['src/a.ts'], [{ step: 'lint', args: { fix: true } }])
    expect(second).toHaveBeenCalledWith(['src/a.ts'], ['src/a.ts'])
    expect(store.entries.get('/root/src/a.ts')).toBe('second')
    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'modified' }),
    ])
  })

  it('does not withhold a predecessor edit that leaves identical text', async () => {
    const store = disk({ 'src/a.ts': 'same' })
    const seen = vi.fn()
    const engine = {
      id: 'fixer',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          format: async (request: any) => {
            seen(request.paths, request.access.scope)
            return {}
          },
        },
      ],
    }
    const pipelineResult2 = await pipeline(store.fs, [engine])
    await pipelineResult2.ops(
      ['src/a.ts'],
      [
        { step: 'edit', args: { path: 'src/a.ts', edits: [{ find: 'same', replace: 'same' }] } },
        { step: 'format', args: {} },
      ]
    )
    expect(seen).toHaveBeenCalledWith(['src/a.ts'], ['src/a.ts'])
  })
})

describe('WP5-2 façade scope allowlist', () => {
  it('allows a selected TypeScript formatter to access scoped JSON configuration outside its extension-narrowed paths', async () => {
    const store = disk({ 'src/a.ts': 'source', 'src/config.json': 'old-config' })
    const seen = vi.fn()
    const engine = {
      id: 'formatter',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          needs: ['mkdir'],
          format: async (request: any) => {
            seen(request.paths, request.access.scope)
            expect(await request.access.read('src/config.json')).toBe('old-config')
            await request.access.write('src/config.json', 'new-config')
            return {}
          },
        },
      ],
    }
    const pipelineResult3 = await pipeline(store.fs, [engine])
    await pipelineResult3.ops(['src/a.ts', 'src/config.json'], [{ step: 'format', args: {} }])
    expect(seen).toHaveBeenCalledWith(['src/a.ts'], ['src/a.ts', 'src/config.json'])
    expect(store.entries.get('/root/src/config.json')).toBe('new-config')
  })

  it('recomputes the scope allowlist after an earlier persisted step adds a non-selected file', async () => {
    const store = disk({ 'src/a.ts': 'source' })
    const engine = {
      id: 'formatter',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          format: async (request: any) => {
            expect(request.paths).toEqual(['src/a.ts'])
            expect(request.access.scope).toEqual(['src/a.ts', 'src/config.json'])
            expect(await request.access.read('src/config.json')).toBe('created')
            return {}
          },
        },
      ],
    }
    const pipelineResult4 = await pipeline(store.fs, [engine])
    await pipelineResult4.ops(
      ['src/a.ts'],
      [
        {
          step: 'apply_patch',
          args: {
            patch: '*** Begin Patch\n*** Add File: src/config.json\n+created\n*** End Patch',
          },
        },
        { step: 'write', args: {} },
        { step: 'format', args: {} },
      ]
    )
  })

  it('narrows the façade allowlist to an explicit step selector', async () => {
    const store = disk({ 'src/a.ts': 'a', 'src/b.ts': 'b' })
    const engine = {
      id: 'formatter',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          format: async (request: any) => {
            expect(request.paths).toEqual(['src/a.ts'])
            expect(request.access.scope).toEqual(['src/a.ts'])
            await expect(request.access.read('src/b.ts')).rejects.toThrow(E_DEV_STEP_FAILED)
            return {}
          },
        },
      ],
    }
    const pipelineResult5 = await pipeline(store.fs, [engine])
    await pipelineResult5.ops(
      ['src/a.ts', 'src/b.ts'],
      [{ step: 'format', args: { paths: ['src/a.ts'] } }]
    )
  })
})

describe('WP5-2 post-write re-read', () => {
  it('refreshes changed files and never admits a pre-existing unacquired file outside the selector', async () => {
    const store = disk({ 'src/a.ts': 'old', 'src/gap.ts': 'pre-existing' })
    const engine = {
      id: 'fixer',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          needs: ['mkdir'],
          format: async (request: any) => {
            await request.access.write('src/a.ts', 'fixed')
            return { diagnostics: [] }
          },
        },
      ],
    }
    const rereadPipeline = await pipeline(store.fs, [engine])
    const result = await rereadPipeline.ops(
      ['src/a.ts'],
      [
        { step: 'write', args: {} },
        { step: 'format', args: { paths: ['src/a.ts'] } },
      ]
    )
    expect(result.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'src/a.ts', kind: 'modified' })])
    )
    expect(result.changes.find((row) => row.path === 'src/gap.ts')).toBeUndefined()
    // The deleted branch has no pending deletion: a later write must not re-delete it.
    const deleting = disk({ 'src/a.ts': 'old' })
    const deleteEngine = {
      id: 'delete',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          needs: ['delete'],
          format: async (request: any) => {
            await request.access.delete('src/a.ts')
            return {}
          },
        },
      ],
    }
    const deletingPipeline = await pipeline(deleting.fs, [deleteEngine])
    const deleted = await deletingPipeline.ops(
      ['src/a.ts'],
      [
        { step: 'write', args: {} },
        { step: 'format', args: {} },
        { step: 'write', args: {} },
      ]
    )
    expect(deleted.changes).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'deleted' }),
    ])
  })

  it('recovers unreadable paths and reports failed re-read admissions plus advisory discrepancies', async () => {
    const store = disk({ 'src/a.ts': 'old', 'src/b.ts': 'steady' })
    let pass = 0
    const engine = {
      id: 'fixer',
      formats: [
        {
          extensions: ['ts'],
          inPlace: true,
          scope: ['src/**'],
          needs: ['mkdir'],
          format: async (request: any) => {
            pass++
            if (pass === 1) await request.access.write('src/a.ts', 'x'.repeat(1_000_001))
            else await store.fs.write('/root/src/a.ts', encoder.encode('recovered'))
            return pass === 1 ? { changed: new Map([['src/claimed.ts', 'x']]) } : {}
          },
        },
      ],
    }
    const recoveryPipeline = await pipeline(store.fs, [engine], undefined, { maxBytesPerFile: 100 })
    const result = await recoveryPipeline.ops(
      ['src/a.ts', 'src/b.ts'],
      [
        { step: 'write', args: {} },
        { step: 'format', args: {} },
        { step: 'format', args: {} },
      ]
    )
    expect(result.unreadable).toEqual([])
    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'modified' }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        // Re-read admission is runtime-produced; the advisory discrepancy is about fixer.
        expect.objectContaining({ severity: 'error', path: 'src/a.ts', engineId: null }),
        expect.objectContaining({
          message: expect.stringContaining('unclaimed: src/a.ts'),
          engineId: 'fixer',
        }),
      ])
    )
  })
})

describe('WP5-2 changes assembly', () => {
  const file = (text: string) => ({ text, mimeType: 'text/plain' })
  it('reports net state, recreation identity, cumulative rename counts, and deletion counts', async () => {
    await expect(
      assembleChanges(
        new Map([['a.ts', file('a\n')]]),
        new Map([['a.ts', file('a\n')]]),
        new Map(),
        new Set(),
        new Set()
      )
    ).resolves.toMatchObject({ changes: [] })
    const recreated = await assembleChanges(
      new Map([['a.ts', file('old\n')]]),
      new Map([['a.ts', file('new\n')]]),
      new Map(),
      new Set(['a.ts']),
      new Set()
    )
    expect(recreated.changes).toEqual([expect.objectContaining({ path: 'a.ts', kind: 'added' })])
    const renamed = await assembleChanges(
      new Map([['a.ts', file('a\n')]]),
      new Map([['b.ts', file('b\nc\n')]]),
      new Map([['b.ts', 'a.ts']]),
      new Set(),
      new Set()
    )
    expect(renamed.changes).toEqual([
      expect.objectContaining({
        path: 'b.ts',
        kind: 'renamed',
        from: 'a.ts',
        added: expect.any(Number),
        removed: expect.any(Number),
      }),
    ])
    const deleted = await assembleChanges(
      new Map([['a.ts', file('one\ntwo\n')]]),
      new Map(),
      new Map(),
      new Set(),
      new Set()
    )
    expect(deleted.changes[0]).toMatchObject({
      path: 'a.ts',
      kind: 'deleted',
      added: 0,
      removed: 2,
    })
    expect(deleted.lineCountsAvailable).toBe(true)
  })
})

describe('WP5-2 forge', () => {
  it('offers only granular useful steps, spools forged output, and persists every mutating step only', async () => {
    const store = disk({ 'a.ts': 'a' })
    const gate = vi.fn<any>(async () => ({ approved: true }))
    const writes = vi.spyOn(store.fs, 'write')
    const engine = {
      id: 'delta-engine',
      formats: [
        { extensions: ['ts'], format: async () => ({ changed: new Map([['a.ts', 'formatted']]) }) },
      ],
      lints: [
        {
          extensions: ['ts'],
          fixable: true,
          lint: async () => ({ changed: new Map([['a.ts', 'linted']]) }),
        },
      ],
      checks: [{ extensions: ['ts'], check: async () => ({ diagnostics: [] }) }],
    }
    const dp = await pipeline(store.fs, [engine], gate)
    const tools = forgeDevTools(dp, { surface: 'granular' })
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['edit', 'apply_patch', 'format', 'lint', 'read_lines', 'check'])
    )
    expect(tools.write).toBeUndefined()
    expect(tools.edit.artifactConstructor?.()).toBe(SpooledJsonArtifact)
    const context: any = {
      id: 'test',
      abortSignal: new AbortController().signal,
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
    }

    await tools.edit.executor(context)({
      paths: ['a.ts'],
      path: 'a.ts',
      edits: [{ find: 'a', replace: 'edited' }],
    })
    expect(store.entries.get('/root/a.ts')).toBe('edited')
    await tools.apply_patch.executor(context)({
      paths: ['a.ts'],
      patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-edited\n+patched\n*** End Patch',
    })
    expect(store.entries.get('/root/a.ts')).toBe('patched')
    await tools.format.executor(context)({ paths: ['a.ts'] })
    expect(store.entries.get('/root/a.ts')).toBe('formatted')
    await tools.lint.executor(context)({ paths: ['a.ts'], fix: true })
    expect(store.entries.get('/root/a.ts')).toBe('linted')

    const writesBeforeRead = writes.mock.calls.length
    await tools.read_lines.executor(context)({ paths: ['a.ts'], path: 'a.ts', start: 1 })
    expect(writes).toHaveBeenCalledTimes(writesBeforeRead)
    const writesBeforeCheck = writes.mock.calls.length
    await tools.check.executor(context)({ paths: ['a.ts'] })
    expect(writes).toHaveBeenCalledTimes(writesBeforeCheck)
    expect(gate.mock.calls.map(([, call]) => call)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: 'edit',
          args: expect.objectContaining({ persists: true }),
        }),
        expect.objectContaining({
          step: 'apply_patch',
          args: expect.objectContaining({ persists: true }),
        }),
        expect.objectContaining({
          step: 'format',
          args: expect.objectContaining({ persists: true }),
        }),
        expect.objectContaining({
          step: 'lint',
          args: expect.objectContaining({ persists: true }),
        }),
      ])
    )
    const direct = await dp.ops(
      ['a.ts'],
      [{ step: 'read_lines', args: { path: 'a.ts', start: 1 } }]
    )
    expect(direct).toHaveProperty('changes')
    await expect(dp(['a.ts']).readLines({ path: 'a.ts', start: 1 }).run()).resolves.toHaveProperty(
      'reads'
    )
  })
})
