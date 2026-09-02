import { describe, expect, it, vi } from 'vitest'
import { parseStructuredPatch } from '../../../../src/lib/patch'
import { E_LLM_EXECUTION_GATE_NOT_SUPPORTED } from '../../../../src/exceptions'
import {
  acquireWorkspace,
  applyDelta,
  derivePatchOutcome,
  stampDiagnostics,
} from '../../../../src/batteries/dev_tools/runtime'
import {
  createDevPipeline,
  E_DEV_BAD_ARG,
  E_DEV_GATE_DECLINED,
  E_DEV_STEP_FAILED,
  E_DEV_WORKSPACE_BOUNDS,
  E_INVALID_DEV_PIPELINE_CONFIG,
} from '../../../../src/batteries/dev_tools'

const bounds = { maxFiles: 10, maxBytesPerFile: 100, maxTotalBytes: 1_000 }
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
const translator = {
  toRelative: async (path: string) => path.replace(/^\//, ''),
  toBackendPath: (path: string) => `/root${path ? `/${path}` : ''}`,
  redact: (path: string) => `[redacted:${path}]`,
  assertNoSymlinkComponents: async () => {},
}
const fsFor = (entries: Record<string, { text: string; kind?: 'file' | 'dir' }>) => ({
  stat: async (path: string) => {
    const entry = entries[path]
    if (!entry) throw new Error('ENOENT')
    return { size: entry.text.length, version: '1', kind: entry.kind ?? 'file' } as const
  },
  read: async (path: string) => {
    const entry = entries[path]
    if (!entry) throw new Error('ENOENT')
    return stream(entry.text)
  },
  write: async () => {},
  async *list(_root: string) {
    for (const [path, entry] of Object.entries(entries))
      if ((entry.kind ?? 'file') === 'file')
        yield { kind: 'item' as const, path, entryKind: 'file' as const }
    yield { kind: 'done' as const, complete: true as const }
  },
})
const stamped = (delta: Record<string, unknown>) => ({ diagnostics: [], ...delta }) as any
const state = () => ({
  acquisitionBaseline: new Map(),
  persistedBaseline: new Map(),
  addedBy: new Map(),
})
const files = (...paths: string[]) =>
  new Map(paths.map((path) => [path, { text: 'old', mimeType: 'text/plain' }]))
const config = (overrides: Record<string, unknown> = {}) =>
  ({
    handle: { effectivePolicy: () => ({ filesystemDisabled: true }) },
    fileSystem: fsFor({ '/root/a.ts': { text: 'a' } }),
    pathTranslator: translator,
    gate: async () => ({ approved: true }),
    root: '/root',
    ...overrides,
  }) as any
const apply = (delta: Record<string, unknown>, current = files('a.ts')) =>
  applyDelta({
    delta: stamped(delta),
    files: current,
    state: state(),
    bounds,
    fileSystem: fsFor({}),
    pathTranslator: translator,
  })

describe('dev-tools runtime construction and acquisition', () => {
  it('rejects every invalid supplied bound and defaults absent bounds', async () => {
    for (const [field, value] of [
      ['maxFiles', 0.5],
      ['maxBytesPerFile', 0],
      ['maxTotalBytes', -1],
      ['maxFiles', Number.NaN],
      ['maxBytesPerFile', Infinity],
      ['maxTotalBytes', 'many'],
    ] as const)
      await expect(createDevPipeline(config({ bounds: { [field]: value } }))).rejects.toThrow(
        new RegExp(field)
      )
    await expect(createDevPipeline(config())).resolves.toBeTypeOf('function')
  })

  it('validates root before resolver work and rejects a translator rooted elsewhere', async () => {
    let resolved = false
    await expect(
      createDevPipeline(
        config({
          root: 'relative',
          engines: [
            async () => {
              resolved = true
              throw new Error('translator mismatch')
            },
          ],
        })
      )
    ).rejects.toThrow(E_INVALID_DEV_PIPELINE_CONFIG)
    expect(resolved).toBe(false)
    await expect(
      createDevPipeline(
        config({ pathTranslator: { ...translator, toBackendPath: () => '/wrong-root' } })
      )
    ).rejects.toThrow(/configured root/)
  })

  it('rejects unknown configuration keys at construction', async () => {
    await expect(createDevPipeline(config({ fileSytem: {} }))).rejects.toThrow(/fileSytem/)
  })

  it('omits only capabilities whose optional filesystem need is unavailable', async () => {
    const pipeline = await createDevPipeline(
      config({
        engines: [
          {
            id: 'engine',
            formats: [
              { extensions: ['ts'], format: async () => ({}) },
              { extensions: ['js'], needs: ['rename'], format: async () => ({}) },
            ],
          },
        ],
      })
    )
    expect(pipeline.capabilities.hasFormat('ts')).toBe(true)
    expect(pipeline.capabilities.hasFormat('js')).toBe(false)
    expect(pipeline.engines[0].formats).toHaveLength(2)
    expect(pipeline.engines[0].formats?.[0]).toBeDefined()
    expect(pipeline.engines[0].formats?.[1]).toBeUndefined()
  })

  it('preserves declared capability indices when an unavailable middle capability is omitted', async () => {
    const pipeline = await createDevPipeline(
      config({
        engines: [
          {
            id: 'engine',
            formats: [
              { extensions: ['ts'], format: async () => ({}) },
              { extensions: ['js'], needs: ['rename'], format: async () => ({}) },
              { extensions: ['tsx'], format: async () => ({}) },
            ],
          },
        ],
      })
    )
    const planned = await pipeline.capabilities.plan({
      kind: 'format',
      paths: ['a.tsx'],
      extensions: ['tsx'],
      selector: null,
      fix: false,
    })
    expect(planned.invocations).toMatchObject([{ engineId: 'engine', capabilityIndex: 2 }])
  })

  it('uses extensionOf through the public front-end for case and extensionless names', async () => {
    const called: string[] = []
    const pipeline = await createDevPipeline(
      config({
        fileSystem: fsFor({ '/root/A.TS': { text: 'a' }, '/root/Makefile': { text: 'make' } }),
        engines: [
          {
            id: 'engine',
            checks: [
              {
                extensions: ['ts'],
                check: async () => {
                  called.push('ts')
                  return {}
                },
              },
              {
                extensions: [''],
                check: async () => {
                  called.push('none')
                  return {}
                },
              },
            ],
          },
        ],
      })
    )
    await pipeline.ops(['A.TS', 'Makefile'], [{ step: 'check', args: {} }])
    expect(called.sort()).toEqual(['none', 'ts'])
  })

  it('uses exact literals and enumerates only star patterns', async () => {
    const fs = fsFor({ '/root/src/a.ts': { text: 'a' }, '/root/src/b.ts': { text: 'b' } })
    const probingTranslator = {
      ...translator,
      toRelative: async (path: string) => {
        if (path.includes('*')) throw new Error('pattern was translated')
        return path
      },
    }
    await expect(
      acquireWorkspace({
        paths: [' src/a.ts '],
        fileSystem: fs,
        pathTranslator: probingTranslator,
        bounds,
      })
    ).resolves.toEqual(new Map([['src/a.ts', { text: 'a', mimeType: 'text/plain' }]]))
    await expect(
      acquireWorkspace({
        paths: ['src/*.ts'],
        fileSystem: fs,
        pathTranslator: probingTranslator,
        bounds,
      })
    ).resolves.toHaveLength(2)
  })

  it('runs generators for a zero-match selector only when one is eligible', async () => {
    const scopedCalls = vi.fn(async () => ({}))
    const scopeLessCalls = vi.fn(async () => ({}))
    const scoped = await createDevPipeline(
      config({
        fileSystem: fsFor({}),
        engines: [
          {
            id: 'generator',
            formats: [
              { extensions: ['ts'], generates: true, scope: ['generated/**'], format: scopedCalls },
            ],
          },
        ],
      })
    )
    await scoped.ops([], [{ step: 'format', args: { paths: ['generated/*.ts'] } }])
    expect(scopedCalls).toHaveBeenCalledWith(
      expect.objectContaining({ paths: [], selector: ['generated/*.ts'] })
    )

    const scopeLess = await createDevPipeline(
      config({
        fileSystem: fsFor({}),
        engines: [
          {
            id: 'generator',
            formats: [{ extensions: ['ts'], generates: true, format: scopeLessCalls }],
          },
        ],
      })
    )
    await scopeLess.ops([], [{ step: 'format', args: { paths: ['generated/*.ts'] } }])
    expect(scopeLessCalls).toHaveBeenCalledOnce()

    const ordinary = await createDevPipeline(
      config({
        fileSystem: fsFor({}),
        engines: [{ id: 'ordinary', formats: [{ extensions: ['ts'], format: async () => ({}) }] }],
      })
    )
    await expect(
      ordinary.ops([], [{ step: 'format', args: { paths: ['generated/*.ts'] } }])
    ).rejects.toThrow(/matches no workspace file/)
  })

  it('validates complete argument specifications, including deletion edits', async () => {
    const pipeline = await createDevPipeline(config())
    for (const op of [
      { step: 'read_lines', args: { path: 'a.ts', start: 0 } },
      { step: 'read_lines', args: { path: 'a.ts', start: 1.5 } },
      { step: 'edit', args: { path: 'a.ts', edits: [{}] } },
      { step: 'edit', args: { path: 'a.ts', edits: [{ find: '', replace: 'x' }] } },
    ] as any[])
      expect(() => pipeline.compile([op])).toThrow()
    expect(() =>
      pipeline.compile([
        { step: 'edit', args: { path: 'a.ts', edits: [{ find: 'x', replace: '' }] } },
      ])
    ).not.toThrow()
  })

  it('normalizes, validates, and deduplicates step selectors', async () => {
    let request: any
    const pipeline = await createDevPipeline(
      config({
        fileSystem: fsFor({ '/root/src/a.ts': { text: 'a' }, '/root/src/b.ts': { text: 'b' } }),
        engines: [
          {
            id: 'formatter',
            formats: [
              {
                extensions: ['ts'],
                format: async (input: any) => {
                  request = input
                  return {}
                },
              },
            ],
          },
        ],
      })
    )
    await pipeline.ops(
      ['src/a.ts', 'src/b.ts'],
      [{ step: 'format', args: { paths: [' src//a.ts ', 'src/a.ts', 'src/*.ts', 'src/*.ts'] } }]
    )
    expect(request.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(request.selector).toEqual(['src/a.ts', 'src/*.ts'])
    await expect(
      pipeline.ops(['src/a.ts'], [{ step: 'format', args: { paths: ['src/**.ts'] } }])
    ).rejects.toThrow(/invalid step selector.*\*\*\.ts/)
  })

  it('rejects a later unmatched glob even after an earlier pattern matched', async () => {
    await expect(
      acquireWorkspace({
        paths: ['*.ts', 'missing/*.ts'],
        fileSystem: fsFor({ '/root/a.ts': { text: 'a' } }),
        pathTranslator: translator,
        bounds,
      })
    ).rejects.toThrow(/missing\/\*\.ts.*matched no files/)
  })

  it('distinguishes literal directory, absent literal, and unmatched pattern failures', async () => {
    const fs = fsFor({ '/root/dir': { text: '', kind: 'dir' } })
    const probingTranslator = {
      ...translator,
      toRelative: async (path: string) => {
        if (path === 'missing.ts') throw new Error('symlink stat ENOENT')
        return path
      },
    }
    await expect(
      acquireWorkspace({ paths: ['dir'], fileSystem: fs, pathTranslator: translator, bounds })
    ).rejects.toThrow(/not a file/)
    await expect(
      acquireWorkspace({
        paths: ['missing.ts'],
        fileSystem: fs,
        pathTranslator: probingTranslator,
        bounds,
      })
    ).rejects.toThrow(/does not exist/)
    await expect(
      acquireWorkspace({ paths: ['none/*.ts'], fileSystem: fs, pathTranslator: translator, bounds })
    ).rejects.toThrow(/matched no files/)
  })

  it('refuses binary and unmappable files but admits filename MIME exceptions', async () => {
    await expect(
      acquireWorkspace({
        paths: ['a.bin'],
        fileSystem: fsFor({ '/root/a.bin': { text: 'x' } }),
        pathTranslator: translator,
        bounds,
        mimeResolver: async () => 'application/octet-stream',
      })
    ).rejects.toThrow(/textual MIME/)
    await expect(
      acquireWorkspace({
        paths: ['a.unknown'],
        fileSystem: fsFor({ '/root/a.unknown': { text: 'x' } }),
        pathTranslator: translator,
        bounds,
        mimeResolver: async () => undefined,
      })
    ).rejects.toThrow(/textual MIME/)
    await expect(
      acquireWorkspace({
        paths: ['Makefile', '.eslintrc'],
        fileSystem: fsFor({ '/root/Makefile': { text: 'x' }, '/root/.eslintrc': { text: 'x' } }),
        pathTranslator: translator,
        bounds,
        mimeResolver: async () => undefined,
      })
    ).resolves.toHaveLength(2)
  })

  it('enforces bounds while files are admitted', async () => {
    await expect(
      acquireWorkspace({
        paths: ['*.ts'],
        fileSystem: fsFor({ '/root/a.ts': { text: 'a' }, '/root/b.ts': { text: 'b' } }),
        pathTranslator: translator,
        bounds: { ...bounds, maxFiles: 1 },
      })
    ).rejects.toThrow(E_DEV_WORKSPACE_BOUNDS)
  })

  it('gates resolved acquisition targets before every file read and a decline prevents reads', async () => {
    const calls: string[] = []
    const fs = fsFor({ '/root/a.ts': { text: 'a' } })
    const pipeline = await createDevPipeline(
      config({
        fileSystem: {
          ...fs,
          read: async (path: string) => {
            calls.push(`read:${path}`)
            return fs.read(path)
          },
        },
        engines: [{ id: 'checker', checks: [{ extensions: ['ts'], check: async () => ({}) }] }],
        gate: async (_ctx: unknown, call: any) => {
          calls.push(`gate:${call.step}`)
          expect(call).toEqual({ step: 'acquire', args: { paths: ['*.ts'] }, targets: ['a.ts'] })
          return { approved: false, note: 'no disclosure' }
        },
      })
    )
    await expect(pipeline.ops(['*.ts'], [{ step: 'check', args: {} }])).rejects.toThrow(
      E_DEV_GATE_DECLINED
    )
    expect(calls).toEqual(['gate:acquire'])
  })

  it('deduplicates normalized literal targets before gating and reading', async () => {
    const fs = fsFor({ '/root/src/a.ts': { text: 'a' } })
    const read = vi.fn(fs.read)
    const gate = vi.fn(async (_ctx: unknown, _call: any) => ({ approved: true }))
    const normalizingTranslator = {
      ...translator,
      toRelative: async (path: string) => path.replace(/^\//, '').replace(/\/+/g, '/'),
    }
    const pipeline = await createDevPipeline(
      config({
        fileSystem: { ...fs, read },
        pathTranslator: normalizingTranslator,
        gate,
        engines: [{ id: 'checker', checks: [{ extensions: ['ts'], check: async () => ({}) }] }],
      })
    )
    await pipeline.ops(['src/a.ts', 'src//a.ts'], [{ step: 'check', args: {} }])
    expect(gate.mock.calls[0][1].targets).toEqual(['src/a.ts'])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('relativizes enumerated entries when the translated root has a trailing slash', async () => {
    const trailingRootTranslator = {
      ...translator,
      toBackendPath: (path: string) => (path ? `/root/${path}` : '/root/'),
    }
    await expect(
      acquireWorkspace({
        paths: ['*.ts'],
        fileSystem: fsFor({ '/root/a.ts': { text: 'a' } }),
        pathTranslator: trailingRootTranslator,
        bounds,
      })
    ).resolves.toEqual(new Map([['a.ts', { text: 'a', mimeType: 'text/plain' }]]))
  })

  it('synthesizes a rejecting waitFor for omitted and incomplete gate contexts at both gates', async () => {
    for (const gateContext of [undefined, {}]) {
      const contexts: any[] = []
      const pipeline = await createDevPipeline(
        config({
          engines: [{ id: 'checker', checks: [{ extensions: ['ts'], check: async () => ({}) }] }],
          gate: async (ctx: any) => {
            contexts.push(ctx)
            return { approved: true }
          },
        })
      )
      await pipeline.ops(['a.ts'], [{ step: 'check', args: {} }], { gateContext })
      expect(contexts).toHaveLength(2)
      await expect(contexts[0].waitFor({})).rejects.toThrow(E_LLM_EXECUTION_GATE_NOT_SUPPORTED)
      await expect(contexts[1].waitFor({})).rejects.toThrow(E_LLM_EXECUTION_GATE_NOT_SUPPORTED)
    }
  })

  it('gates checks with an explicit empty creation envelope', async () => {
    const gate = vi.fn(async (_context: unknown, _call: unknown) => ({ approved: true }))
    const pipeline = await createDevPipeline(
      config({
        gate,
        engines: [{ id: 'checker', checks: [{ extensions: ['ts'], check: async () => ({}) }] }],
      })
    )
    await pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])
    expect(gate.mock.calls[1]?.[1]).toMatchObject({ step: 'check', mayCreate: [] })
  })

  it('emits selection and scope diagnostics through the public pipeline', async () => {
    const pipeline = await createDevPipeline(
      config({
        fileSystem: fsFor({ '/root/test/a.ts': { text: 'a' }, '/root/test/a.js': { text: 'a' } }),
        engines: [
          { id: 'first', formats: [{ extensions: ['ts'], format: async () => ({}) }] },
          { id: 'second', formats: [{ extensions: ['ts'], format: async () => ({}) }] },
          {
            id: 'scoped',
            formats: [{ extensions: ['js'], scope: ['src/**'], format: async () => ({}) }],
          },
        ],
        selection: [
          async (ctx: any) => {
            if (ctx.group === 'ts') ctx.candidates = []
          },
        ],
      })
    )
    const result = await pipeline.ops(['test/a.ts', 'test/a.js'], [{ step: 'format', args: {} }])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: null,
          outOfScope: false,
          message: expect.stringContaining('selection suppressed'),
        }),
        expect.objectContaining({
          path: null,
          outOfScope: false,
          message: expect.stringContaining('excluded by scope'),
        }),
      ])
    )
  })

  it('rejects a checker returning mutations and names its engine', async () => {
    const pipeline = await createDevPipeline(
      config({
        engines: [
          {
            id: 'mutating-checker',
            checks: [
              {
                extensions: ['ts'],
                check: async () => ({ changed: new Map([['a.ts', 'changed']]) }),
              },
            ],
          },
        ],
      })
    )
    await expect(pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])).rejects.toThrow(
      /mutating-checker/
    )
  })

  it('rejects unavailable capabilities through the public compile front-end', async () => {
    const pipeline = await createDevPipeline(config())
    expect(() => pipeline.compile([{ step: 'format', args: {} }])).toThrow(/no format capability/)
  })
})

describe('dev-tools delta application', () => {
  it('confines existing-file delta fields to invocation paths while allowing rename destinations outside a selector', async () => {
    await expect(
      applyDelta({
        delta: stamped({ changed: new Map([['b.ts', 'new']]) }),
        files: files('a.ts', 'b.ts'),
        state: state(),
        bounds,
        fileSystem: fsFor({}),
        pathTranslator: translator,
        engineId: 'formatter',
        invocationPaths: ['a.ts'],
        selector: ['a.ts'],
      })
    ).rejects.toThrow(/b\.ts.*selector/)
    const current = files('a.ts')
    await expect(
      applyDelta({
        delta: stamped({ renamed: new Map([['a.ts', 'renamed.ts']]) }),
        files: current,
        state: state(),
        bounds,
        fileSystem: fsFor({}),
        pathTranslator: translator,
        engineId: 'formatter',
        invocationPaths: ['a.ts'],
        selector: ['a.ts'],
      })
    ).resolves.toBeDefined()
    expect(current.has('renamed.ts')).toBe(true)
  })

  it.each([
    [
      'added/deleted',
      {
        added: new Map([['a.ts', { text: 'new', mimeType: 'text/plain' }]]),
        deleted: new Set(['a.ts']),
      },
      'a.ts',
    ],
    [
      'changed rename source',
      { changed: new Map([['a.ts', 'new']]), renamed: new Map([['a.ts', 'b.ts']]) },
      'a.ts',
    ],
    ['destination exists', { renamed: new Map([['a.ts', 'b.ts']]) }, 'b.ts', files('a.ts', 'b.ts')],
    [
      'rename chain',
      {
        renamed: new Map([
          ['a.ts', 'b.ts'],
          ['b.ts', 'c.ts'],
        ]),
      },
      'b.ts',
      files('a.ts', 'b.ts'),
    ],
    [
      'destination deleted',
      { renamed: new Map([['a.ts', 'b.ts']]), deleted: new Set(['b.ts']) },
      'b.ts',
    ],
    [
      'source deleted',
      { renamed: new Map([['a.ts', 'b.ts']]), deleted: new Set(['a.ts']) },
      'a.ts',
    ],
    ['source absent', { renamed: new Map([['gone.ts', 'b.ts']]) }, 'gone.ts'],
    [
      'changed deleted',
      { changed: new Map([['a.ts', 'new']]), deleted: new Set(['a.ts']) },
      'a.ts',
    ],
    ['changed absent', { changed: new Map([['gone.ts', 'new']]) }, 'gone.ts'],
    [
      'added exists',
      { added: new Map([['a.ts', { text: 'new', mimeType: 'text/plain' }]]) },
      'a.ts',
    ],
  ])('rejects %s collision naming the path', async (_name, delta, path, current?) => {
    await expect(apply(delta as any, current as any)).rejects.toThrow(new RegExp(path as string))
  })

  it('drops no-op changes before collision validation, warns, and applies rename-delete-add-change order', async () => {
    const current = new Map([
      ['a.ts', { text: 'old', mimeType: 'text/plain' }],
      ['c.ts', { text: 'old', mimeType: 'text/plain' }],
    ])
    const result = await apply(
      {
        changed: new Map([
          ['a.ts', 'old'],
          ['d.ts', 'changed'],
        ]),
        renamed: new Map([['a.ts', 'b.ts']]),
        deleted: new Set(['c.ts']),
        added: new Map([['d.ts', { text: 'new', mimeType: 'text/plain' }]]),
      },
      current
    )
    expect(result.changed).toEqual(new Map([['d.ts', 'changed']]))
    expect(result.diagnostics).toMatchObject([{ severity: 'warning' }])
    expect(current).toEqual(
      new Map([
        ['b.ts', { text: 'old', mimeType: 'text/plain' }],
        ['d.ts', { text: 'changed', mimeType: 'text/plain' }],
      ])
    )
  })

  it('infers recreation and maintains persisted on-disk identity across rename and delete', async () => {
    const current = files('a.ts')
    const bookkeeping = {
      persistedPaths: new Map([['a.ts', 'a.ts']]),
      pendingDeletions: new Map<string, string>(),
      recreated: new Set<string>(),
      renames: new Map<string, string>(),
    }
    const execution = {
      acquisitionBaseline: new Map(current),
      persistedBaseline: new Map(current),
      addedBy: new Map<string, string>(),
    }
    await applyDelta({
      delta: stamped({
        renamed: new Map([['a.ts', 'b.ts']]),
        added: new Map([['a.ts', { text: 'new', mimeType: 'text/plain' }]]),
      }),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    expect(bookkeeping.recreated).toEqual(new Set(['a.ts']))
    expect(bookkeeping.persistedPaths).toEqual(new Map([['b.ts', 'a.ts']]))
    await applyDelta({
      delta: stamped({ deleted: new Set(['b.ts']) }),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    expect(bookkeeping.pendingDeletions).toEqual(new Map([['b.ts', 'a.ts']]))
  })

  it('marks an acquisition path recreated when an earlier delta renamed it away before a later add', async () => {
    const current = files('a.ts')
    const bookkeeping = {
      persistedPaths: new Map([['a.ts', 'a.ts']]),
      pendingDeletions: new Map<string, string>(),
      recreated: new Set<string>(),
      renames: new Map<string, string>(),
      vacated: new Set<string>(),
    }
    const execution = {
      acquisitionBaseline: new Map(current),
      persistedBaseline: new Map(current),
      addedBy: new Map<string, string>(),
    }
    await applyDelta({
      delta: stamped({ renamed: new Map([['a.ts', 'b.ts']]) }),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    await applyDelta({
      delta: stamped({ added: new Map([['a.ts', { text: 'new', mimeType: 'text/plain' }]]) }),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    expect(bookkeeping.recreated).toEqual(new Set(['a.ts']))
  })

  it('preserves the acquired origin when renames occur in separate apply_patch steps', async () => {
    const current = files('a.ts')
    const bookkeeping = {
      persistedPaths: new Map([['a.ts', 'a.ts']]),
      pendingDeletions: new Map<string, string>(),
      recreated: new Set<string>(),
      renames: new Map<string, string>(),
      vacated: new Set<string>(),
    }
    const execution = {
      acquisitionBaseline: new Map(current),
      persistedBaseline: new Map(current),
      addedBy: new Map<string, string>(),
    }
    const move = (from: string, to: string) =>
      parseStructuredPatch(
        `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-old\n+old\n*** End Patch`
      )
    await applyDelta({
      delta: stamped(derivePatchOutcome(current, move('a.ts', 'b.ts')).delta),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    await applyDelta({
      delta: stamped(derivePatchOutcome(current, move('b.ts', 'c.ts')).delta),
      files: current,
      state: execution,
      bounds,
      fileSystem: fsFor({}),
      pathTranslator: translator,
      ...bookkeeping,
    })
    expect(bookkeeping.renames).toEqual(new Map([['c.ts', 'a.ts']]))
  })

  it('allows additions already on disk only for persisted, recreated, or unreadable paths', async () => {
    for (const option of [
      { persistedPaths: new Map([['new.ts', 'new.ts']]) },
      { recreated: new Set(['new.ts']) },
      { unreadable: new Set(['new.ts']) },
    ])
      await expect(
        applyDelta({
          delta: stamped({ added: new Map([['new.ts', { text: 'new', mimeType: 'text/plain' }]]) }),
          files: new Map(),
          state: state(),
          bounds,
          fileSystem: fsFor({ '/root/new.ts': { text: 'old' } }),
          pathTranslator: translator,
          ...option,
        })
      ).resolves.toBeDefined()
  })
})

describe('dev-tools step behaviours (WP5-1)', () => {
  const mutableFs = (
    initial: Record<string, string>,
    fail?: (operation: string, path: string) => boolean
  ) => {
    const disk = new Map(Object.entries(initial).map(([path, text]) => [`/root/${path}`, text]))
    const operations: string[] = []
    const reject = (operation: string, path: string): void => {
      operations.push(`${operation}:${path.replace('/root/', '')}`)
      if (fail?.(operation, path.replace('/root/', '')))
        throw new Error(`failed ${operation} ${path}`)
    }
    const fs: any = {
      stat: async (path: string) => {
        if (!disk.has(path)) throw new Error('ENOENT')
        return { size: disk.get(path)!.length, version: '1', kind: 'file' as const }
      },
      read: async (path: string) => {
        const text = disk.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return stream(text)
      },
      write: async (path: string, bytes: Uint8Array) => {
        reject('write', path)
        disk.set(path, new TextDecoder().decode(bytes))
      },
      delete: async (path: string) => {
        reject('delete', path)
        disk.delete(path)
      },
      rename: async (from: string, to: string) => {
        reject('rename', `${from}->${to}`)
        const text = disk.get(from)
        if (text === undefined) throw new Error('ENOENT')
        disk.delete(from)
        disk.set(to, text)
      },
      async *list() {
        for (const path of disk.keys())
          yield { kind: 'item' as const, path, entryKind: 'file' as const }
        yield { kind: 'done' as const, complete: true as const }
      },
    }
    return { fs, disk, operations }
  }

  it('runs a void core when middleware correctly calls next', async () => {
    const use = vi.fn(async (_ctx: unknown, next: () => Promise<void>) => next())
    const pipeline = await createDevPipeline(
      config({
        use: [use],
        engines: [{ id: 'checker', checks: [{ extensions: ['ts'], check: async () => ({}) }] }],
      })
    )
    await expect(pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])).resolves.toBeDefined()
    expect(use).toHaveBeenCalledOnce()
  })

  it('read_lines enforces inclusive line ranges, EOF rules, labels, and the workspace universe', async () => {
    const pipeline = await createDevPipeline(
      config({
        fileSystem: fsFor({ '/root/a.ts': { text: 'a\nb\n' }, '/root/empty.ts': { text: '' } }),
      })
    )
    await expect(
      pipeline.ops(
        ['a.ts'],
        [
          { step: 'read_lines', args: { path: 'a.ts', start: 2, end: 99 }, label: 'tail' },
          { step: 'read_lines', args: { path: 'a.ts', start: 1, end: 1 } },
        ]
      )
    ).resolves.toMatchObject({ reads: { 'tail': 'b', 'a.ts': 'a' } })
    for (const [paths, args, message] of [
      [['a.ts'], { path: 'a.ts', start: 3 }, /2 lines/],
      [['a.ts'], { path: 'a.ts', start: 2, end: 1 }, /before start/],
      [['empty.ts'], { path: 'empty.ts', start: 1 }, /0 lines/],
      [['a.ts'], { path: 'missing.ts', start: 1 }, /missing.ts/],
    ] as const)
      await expect(pipeline.ops(paths, [{ step: 'read_lines', args } as any])).rejects.toThrow(
        message
      )
    for (const args of [
      { path: 'a.ts', start: 1.1 },
      { path: 'a.ts', start: 1, end: 1.1 },
    ])
      expect(() => pipeline.compile([{ step: 'read_lines', args }])).toThrow(/positive integer/)
  })

  it('edit uses whole-line shared hunks, is transactional, supports deletion, and validates inputs', async () => {
    const disk = mutableFs({ 'a.ts': 'one\ntwo\none' })
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    await expect(
      pipeline.ops(
        ['a.ts'],
        [{ step: 'edit', args: { path: 'a.ts', edits: [{ find: 'one', replace: '1' }] } }]
      )
    ).rejects.toThrow(/ambiguous/i)
    await expect(
      pipeline.ops(
        ['a.ts'],
        [{ step: 'edit', args: { path: 'a.ts', edits: [{ find: 'on', replace: '1' }] } }]
      )
    ).rejects.toThrow(/could not be applied/i)
    await expect(
      pipeline.ops(
        ['a.ts'],
        [{ step: 'edit', args: { path: 'missing.ts', edits: [{ find: 'one', replace: '1' }] } }]
      )
    ).rejects.toThrow(/not in the current workspace/)
    await expect(
      pipeline.ops(
        ['a.ts'],
        [
          {
            step: 'edit',
            args: {
              path: 'a.ts',
              edits: [
                { find: 'two\none', replace: '1' },
                { find: 'one', replace: '1' },
              ],
            },
          },
          { step: 'read_lines', args: { path: 'a.ts', start: 1 } },
        ]
      )
    ).resolves.toMatchObject({ reads: { 'a.ts': '1\n1' } })
    for (const edits of [[], [{ find: '', replace: 'x' }]])
      expect(() => pipeline.compile([{ step: 'edit', args: { path: 'a.ts', edits } }])).toThrow()
  })

  it('apply_patch rejects unified diffs, is transactional, and derives canonical structured deltas', async () => {
    const run = async (patch: string, initial: Record<string, string>) => {
      const disk = mutableFs(initial)
      const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
      const result = await pipeline.ops(Object.keys(initial), [
        { step: 'apply_patch', args: { patch } },
        { step: 'write', args: {} },
      ])
      return { disk, result }
    }
    const structured = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
    const transaction = mutableFs({ 'a.ts': 'a' })
    const transactionPipeline = await createDevPipeline(config({ fileSystem: transaction.fs }))
    await expect(
      transactionPipeline.ops(
        ['a.ts'],
        [
          {
            step: 'apply_patch',
            args: {
              patch: structured('*** Update File: a.ts\n@@\n-a\n+b\n*** Add File: a.ts\n+x'),
            },
          },
        ]
      )
    ).rejects.toThrow(E_DEV_STEP_FAILED)
    expect(transaction.disk.get('/root/a.ts')).toBe('a')
    await expect(
      transactionPipeline.ops(
        ['a.ts'],
        [{ step: 'apply_patch', args: { patch: '@@ -1 +1 @@\n-a\n+b' } }]
      )
    ).rejects.toThrow(/structured.*envelope.*edit/i)
    const derive = (patch: string, initial: Record<string, string>) =>
      derivePatchOutcome(
        new Map(
          Object.entries(initial).map(([path, text]) => [path, { text, mimeType: 'text/plain' }])
        ),
        parseStructuredPatch(patch)
      ).delta
    const moved = structured('*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b')
    expect(derive(moved, { 'a.ts': 'a' })).toMatchObject({
      renamed: new Map([['a.ts', 'b.ts']]),
      changed: new Map([['b.ts', 'b']]),
      added: new Map(),
      deleted: new Set(),
    })
    const movedResult = await run(moved, { 'a.ts': 'a' })
    expect(movedResult.disk.disk).toEqual(new Map([['/root/b.ts', 'b']]))

    const chained = structured(
      '*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+a\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-a\n+a'
    )
    expect(derive(chained, { 'a.ts': 'a' })).toMatchObject({
      renamed: new Map([['a.ts', 'c.ts']]),
      changed: new Map(),
      added: new Map(),
      deleted: new Set(),
    })
    const chainedResult = await run(chained, { 'a.ts': 'a' })
    expect(chainedResult.disk.disk).toEqual(new Map([['/root/c.ts', 'a']]))

    const deleted = structured(
      '*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+a\n*** Delete File: b.ts'
    )
    expect(derive(deleted, { 'a.ts': 'a' })).toMatchObject({
      renamed: new Map(),
      changed: new Map(),
      added: new Map(),
      deleted: new Set(['a.ts']),
    })
    const deletedResult = await run(deleted, { 'a.ts': 'a' })
    expect(deletedResult.disk.disk.size).toBe(0)

    const split = structured(
      '*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+a\n*** Add File: a.ts\n+new'
    )
    expect(derive(split, { 'a.ts': 'a' })).toMatchObject({
      renamed: new Map([['a.ts', 'b.ts']]),
      changed: new Map(),
      added: new Map([['a.ts', { text: 'new', mimeType: 'text/plain' }]]),
      deleted: new Set(),
    })
    const splitResult = await run(split, { 'a.ts': 'a' })
    expect(splitResult.disk.disk).toEqual(
      new Map([
        ['/root/a.ts', 'new'],
        ['/root/b.ts', 'a'],
      ])
    )

    const recreatedPatch = structured('*** Delete File: a.ts\n*** Add File: a.ts\n+new')
    expect(derive(recreatedPatch, { 'a.ts': 'old' })).toMatchObject({
      renamed: new Map(),
      changed: new Map([['a.ts', 'new']]),
      added: new Map(),
      deleted: new Set(),
    })
    const recreated = await run(recreatedPatch, { 'a.ts': 'old' })
    expect(recreated.disk.disk.get('/root/a.ts')).toBe('new')
  })

  it('fails closed when the effective policy is unavailable for a write', async () => {
    const store = mutableFs({ 'a.ts': 'a' })
    const pipeline = await createDevPipeline(
      config({ fileSystem: store.fs, handle: { effectivePolicy: () => undefined } })
    )
    await expect(
      pipeline.ops(
        ['a.ts'],
        [
          { step: 'edit', args: { path: 'a.ts', edits: [{ find: 'a', replace: 'b' }] } },
          { step: 'write', args: {} },
        ]
      )
    ).rejects.toThrow(/effective sandbox write policy is unavailable/)
    expect(store.disk.get('/root/a.ts')).toBe('a')
  })

  it('gates edit and apply_patch before mutation, while malformed patches do not prompt', async () => {
    const editDisk = mutableFs({ 'a.ts': 'a' })
    const editGate = vi.fn(async (_context: unknown, call: any) =>
      call.step === 'edit' ? { approved: false } : { approved: true }
    )
    const editPipeline = await createDevPipeline(
      config({ fileSystem: editDisk.fs, gate: editGate })
    )
    await expect(
      editPipeline.ops(
        ['a.ts'],
        [{ step: 'edit', args: { path: 'a.ts', edits: [{ find: 'a', replace: 'b' }] } }]
      )
    ).rejects.toThrow(E_DEV_GATE_DECLINED)
    expect(editGate.mock.calls.map(([, call]) => call)).toEqual([
      { step: 'acquire', args: { paths: ['a.ts'] }, targets: ['a.ts'] },
      {
        step: 'edit',
        args: { path: 'a.ts', edits: [{ find: 'a', replace: 'b' }] },
        targets: ['a.ts'],
      },
    ])

    const patchDisk = mutableFs({ 'a.ts': 'a' })
    const patchGate = vi.fn(async (_context: unknown, call: any) =>
      call.step === 'apply_patch' ? { approved: false } : { approved: true }
    )
    const patchPipeline = await createDevPipeline(
      config({ fileSystem: patchDisk.fs, gate: patchGate })
    )
    const patch =
      '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b\n*** Add File: c.ts\n+c\n*** End Patch'
    await expect(
      patchPipeline.ops(['a.ts'], [{ step: 'apply_patch', args: { patch } }])
    ).rejects.toThrow(E_DEV_GATE_DECLINED)
    expect(patchGate.mock.calls[1]?.[1]).toEqual({
      step: 'apply_patch',
      args: { patch },
      targets: ['a.ts', 'b.ts', 'c.ts'],
      mayCreate: ['b.ts', 'c.ts'],
    })
    expect(patchDisk.disk).toEqual(new Map([['/root/a.ts', 'a']]))

    const malformedGate = vi.fn(async () => ({ approved: true }))
    const malformedPipeline = await createDevPipeline(
      config({ fileSystem: mutableFs({ 'a.ts': 'a' }).fs, gate: malformedGate })
    )
    await expect(
      malformedPipeline.ops(
        ['a.ts'],
        [{ step: 'apply_patch', args: { patch: '*** Begin Patch\n*** End Patch' } }]
      )
    ).rejects.toThrow(E_DEV_BAD_ARG)
    expect((malformedGate.mock.calls as any[]).map(([, call]) => call.step)).toEqual(['acquire'])
  })

  it('writes narrowed pending deletions and renames selected by either collapsed endpoint', async () => {
    const renameDisk = mutableFs({ 'a.ts': 'a' })
    const renamePipeline = await createDevPipeline(config({ fileSystem: renameDisk.fs }))
    const move =
      '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b\n*** End Patch'
    await renamePipeline.ops(
      ['a.ts'],
      [
        { step: 'apply_patch', args: { patch: move } },
        { step: 'write', args: { paths: ['a.ts'] } },
      ]
    )
    expect(renameDisk.disk).toEqual(new Map([['/root/b.ts', 'b']]))

    const deleteDisk = mutableFs({ 'gone.ts': 'gone' })
    const deletePipeline = await createDevPipeline(config({ fileSystem: deleteDisk.fs }))
    await deletePipeline.ops(
      ['gone.ts'],
      [
        {
          step: 'apply_patch',
          args: { patch: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch' },
        },
        { step: 'write', args: { paths: ['*.ts'] } },
      ]
    )
    expect(deleteDisk.disk).toEqual(new Map())
  })

  it('orders dependent renames before their destination can overwrite a source', async () => {
    const disk = mutableFs({ 'a.ts': 'a', 'c.ts': 'c' })
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    const move = (from: string, to: string, text: string) =>
      `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-${text}\n+${text}\n*** End Patch`
    await pipeline.ops(
      ['a.ts', 'c.ts'],
      [
        { step: 'apply_patch', args: { patch: move('a.ts', 'b.ts', 'a') } },
        { step: 'apply_patch', args: { patch: move('c.ts', 'a.ts', 'c') } },
        { step: 'write', args: {} },
      ]
    )
    expect(disk.operations).toEqual(['rename:a.ts->/root/b.ts', 'rename:c.ts->/root/a.ts'])
    expect(disk.disk).toEqual(
      new Map([
        ['/root/a.ts', 'c'],
        ['/root/b.ts', 'a'],
      ])
    )
  })

  it('breaks a genuine rename swap with a stat-checked sibling temporary, without exposing it', async () => {
    const disk = mutableFs({ 'a.ts': 'a', 'b.ts': 'b' })
    const stat = vi.fn(disk.fs.stat)
    const pipeline = await createDevPipeline(config({ fileSystem: { ...disk.fs, stat } }))
    const move = (from: string, to: string, text: string) =>
      `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-${text}\n+${text}\n*** End Patch`
    const result = await pipeline.ops(
      ['a.ts', 'b.ts'],
      [
        { step: 'apply_patch', args: { patch: move('a.ts', 'tmp.ts', 'a') } },
        { step: 'apply_patch', args: { patch: move('b.ts', 'a.ts', 'b') } },
        { step: 'apply_patch', args: { patch: move('tmp.ts', 'b.ts', 'a') } },
        { step: 'write', args: {} },
      ]
    )
    const renames = disk.operations.filter((operation) => operation.startsWith('rename:'))
    expect(renames).toHaveLength(3)
    const temporary = renames[0]!.match(/^rename:b\.ts->\/root\/(\.dev-tools-rename-[^/]+)$/)?.[1]
    expect(temporary).toMatch(/^\.dev-tools-rename-/)
    expect(stat).toHaveBeenCalledWith(`/root/${temporary}`)
    expect([...disk.disk.keys()]).not.toContain(`/root/${temporary}`)
    const deltaPaths = (delta: ReturnType<typeof derivePatchOutcome>['delta']) => [
      ...delta.changed!.keys(),
      ...delta.added!.keys(),
      ...delta.deleted!,
      ...delta.renamed!.keys(),
      ...delta.renamed!.values(),
    ]
    const stepDeltas = [
      derivePatchOutcome(
        new Map([
          ['a.ts', { text: 'a', mimeType: 'text/plain' }],
          ['b.ts', { text: 'b', mimeType: 'text/plain' }],
        ]),
        parseStructuredPatch(move('a.ts', 'tmp.ts', 'a'))
      ).delta,
      derivePatchOutcome(
        new Map([
          ['tmp.ts', { text: 'a', mimeType: 'text/plain' }],
          ['b.ts', { text: 'b', mimeType: 'text/plain' }],
        ]),
        parseStructuredPatch(move('b.ts', 'a.ts', 'b'))
      ).delta,
      derivePatchOutcome(
        new Map([
          ['tmp.ts', { text: 'a', mimeType: 'text/plain' }],
          ['a.ts', { text: 'b', mimeType: 'text/plain' }],
        ]),
        parseStructuredPatch(move('tmp.ts', 'b.ts', 'a'))
      ).delta,
    ]
    expect(stepDeltas.flatMap(deltaPaths)).not.toContain(temporary)
    expect(result.written).not.toContain(temporary)
    expect(disk.disk).toEqual(
      new Map([
        ['/root/a.ts', 'b'],
        ['/root/b.ts', 'a'],
      ])
    )
  })

  it('does not mistake a net-zero rename chain for a cycle', async () => {
    const disk = mutableFs({ 'a.ts': 'a' })
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    const move = (from: string, to: string) =>
      `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-a\n+a\n*** End Patch`
    const result = await pipeline.ops(
      ['a.ts'],
      [
        { step: 'apply_patch', args: { patch: move('a.ts', 'b.ts') } },
        { step: 'apply_patch', args: { patch: move('b.ts', 'a.ts') } },
        { step: 'write', args: {} },
      ]
    )
    expect(disk.operations).toEqual([])
    expect(result.written).toEqual([])
  })

  it('records the true written prefix when a content write fails mid-sequence', async () => {
    let writes = 0
    const disk = mutableFs(
      { 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd', 'e.ts': 'e' },
      (operation) => operation === 'write' && ++writes === 3
    )
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    const edits = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) => ({
      step: 'edit' as const,
      args: { path, edits: [{ find: path[0]!, replace: path[0]!.toUpperCase() }] },
    }))
    let error: unknown
    try {
      await pipeline.ops(
        ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        [...edits, { step: 'write', args: {} }]
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(E_DEV_STEP_FAILED)
    expect(error).toMatchObject({ written: ['a.ts', 'b.ts'] })
    expect(disk.disk.get('/root/a.ts')).toBe('A')
    expect(disk.disk.get('/root/b.ts')).toBe('B')
    expect(disk.disk.get('/root/c.ts')).toBe('c')
  })

  it('gates a multi-file write once with every target and declines before any mutation', async () => {
    const disk = mutableFs({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd', 'e.ts': 'e' })
    const gate = vi.fn(async (_context: unknown, call: any) =>
      call.step === 'write' ? { approved: false } : { approved: true }
    )
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs, gate }))
    const edits = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) => ({
      step: 'edit' as const,
      args: { path, edits: [{ find: path[0]!, replace: path[0]!.toUpperCase() }] },
    }))
    await expect(
      pipeline.ops(
        ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        [...edits, { step: 'write', args: {} }]
      )
    ).rejects.toThrow(E_DEV_GATE_DECLINED)
    const writeCalls = gate.mock.calls
      .map(([, call]) => call)
      .filter((call) => call.step === 'write')
    expect(writeCalls).toEqual([
      {
        step: 'write',
        args: {},
        targets: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        mayCreate: [],
      },
    ])
    expect(disk.operations).toEqual([])
  })

  it('persists an unchanged path-only move with rename and never writes its content', async () => {
    const disk = mutableFs({ 'a.ts': 'a' })
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    const patch =
      '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+a\n*** End Patch'
    await pipeline.ops(
      ['a.ts'],
      [
        { step: 'apply_patch', args: { patch } },
        { step: 'write', args: {} },
      ]
    )
    expect(disk.operations).toEqual(['rename:a.ts->/root/b.ts'])
  })

  it('write persists rename, deletion, and content phases in order and reports only destinations', async () => {
    const disk = mutableFs({ 'a.ts': 'a', 'c.ts': 'c', 'gone.ts': 'gone' })
    const pipeline = await createDevPipeline(config({ fileSystem: disk.fs }))
    const patch = `*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+changed\n*** Delete File: gone.ts\n*** Add File: new.ts\n+new\n*** End Patch`
    const second = `*** Begin Patch\n*** Update File: c.ts\n*** Move to: a.ts\n@@\n-c\n+c\n*** End Patch`
    const result = await pipeline.ops(
      ['a.ts', 'c.ts', 'gone.ts'],
      [
        { step: 'apply_patch', args: { patch } },
        { step: 'apply_patch', args: { patch: second } },
        { step: 'write', args: {} },
      ]
    )
    expect(disk.operations).toEqual([
      'rename:a.ts->/root/b.ts',
      'rename:c.ts->/root/a.ts',
      'delete:gone.ts',
      'write:b.ts',
      'write:new.ts',
    ])
    expect(result.written).toEqual(['b.ts', 'a.ts', 'new.ts'])
    expect([...disk.disk].sort()).toEqual([
      ['/root/a.ts', 'c'],
      ['/root/b.ts', 'changed'],
      ['/root/new.ts', 'new'],
    ])
  })
})

describe('dev-tools diagnostic stamping', () => {
  it('stamps scope after added files exist and retains the registry engine identity', async () => {
    const current = new Map<string, any>()
    const delta = await apply(
      {
        added: new Map([['new.ts', { text: 'new', mimeType: 'text/plain' }]]),
        diagnostics: [{ path: 'new.ts', severity: 'info', message: 'added', engineId: 'engine' }],
      },
      current
    )
    expect(stampDiagnostics(delta.diagnostics, current, '/root', translator)).toMatchObject([
      { path: 'new.ts', engineId: 'engine', outOfScope: false },
    ])
  })

  it('trims invalid coordinate dependencies and warns once for the engine', () => {
    expect(
      stampDiagnostics(
        [
          {
            path: 'a.ts',
            severity: 'warning',
            message: 'bad',
            engineId: 'different-engine',
            line: 2,
            column: 0,
            endLine: 1,
            endColumn: 1,
          },
        ],
        files('a.ts'),
        '/root',
        translator,
        'engine'
      )
    ).toMatchObject([
      { line: 2, engineId: 'different-engine' },
      { severity: 'warning', engineId: 'engine' },
    ])
  })

  it('normalizes rooted diagnostics, redacts external paths, and makes runtime null paths in scope', () => {
    const current = files('src/a.ts')
    expect(
      stampDiagnostics(
        [
          { path: '/root/src/a.ts', severity: 'info', message: 'in', engineId: 'e' },
          { path: '/other/secret.ts', severity: 'warning', message: 'out', engineId: 'e' },
          { path: null, severity: 'info', message: 'group', engineId: null },
        ],
        current,
        '/root',
        translator
      )
    ).toMatchObject([
      { path: 'src/a.ts', outOfScope: false },
      { path: '[redacted:/other/secret.ts]', outOfScope: true },
      { path: null, outOfScope: false },
    ])
  })

  it('uses the configured trailing-slash root to stamp engine diagnostics', async () => {
    const pipeline = await createDevPipeline(
      config({
        root: '/root/',
        engines: [
          {
            id: 'rooted',
            checks: [
              {
                extensions: ['ts'],
                check: async () => ({
                  diagnostics: [{ path: '/root/a.ts', severity: 'info', message: 'located' }],
                }),
              },
            ],
          },
        ],
      })
    )
    await expect(pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ path: 'a.ts', outOfScope: false })],
    })
  })

  it('rejects an engine diagnostic without a path', async () => {
    const pipeline = await createDevPipeline(
      config({
        engines: [
          {
            id: 'lost',
            checks: [
              {
                extensions: ['ts'],
                check: async () => ({
                  diagnostics: [{ path: null, severity: 'error', message: 'unlocatable' }],
                }),
              },
            ],
          },
        ],
      })
    )
    await expect(pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])).rejects.toThrow(
      E_DEV_STEP_FAILED
    )
    await expect(pipeline.ops(['a.ts'], [{ step: 'check', args: {} }])).rejects.toThrow(/lost/)
  })
})
