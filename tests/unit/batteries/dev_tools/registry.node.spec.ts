import { describe, expect, it } from 'vitest'
import { buildDevRegistry } from '../../../../src/batteries/dev_tools/registry'
import { E_INVALID_DEV_PIPELINE_CONFIG } from '../../../../src/batteries/dev_tools'

const format = (extra: Record<string, unknown> = {}) =>
  ({
    extensions: ['ts'],
    format: async () => ({}),
    ...extra,
  }) as any
const lint = (extra: Record<string, unknown> = {}) =>
  ({
    extensions: ['ts'],
    fixable: true,
    lint: async () => ({}),
    ...extra,
  }) as any

describe('dev-tools registry planning and dispatch', () => {
  const request = (kind: 'format' | 'lint' | 'check', paths: string[], extensions?: string[]) =>
    ({
      kind,
      paths,
      extensions: extensions ?? [...new Set(paths.map((path) => path.split('.').pop() ?? ''))],
      selector: null,
      fix: false,
    }) as any

  it('selects both matching capabilities declared by one engine for lint', async () => {
    const registry = buildDevRegistry([
      {
        id: 'one',
        lints: [lint(), lint({ extensions: ['ts'] })],
      },
    ])
    const result = await registry.plan(request('lint', ['a.ts']))
    expect(result.invocations.map((invocation) => invocation.capabilityIndex)).toEqual([0, 1])
  })

  it('does not run selection middleware for a single candidate', async () => {
    let ran = false
    const registry = buildDevRegistry(
      [{ id: 'one', formats: [format()] }],
      [
        async () => {
          ran = true
        },
      ]
    )
    await registry.plan(request('format', ['a.ts']))
    expect(ran).toBe(false)
  })

  it('honours selection middleware reordering', async () => {
    const registry = buildDevRegistry(
      [
        { id: 'first', formats: [format()] },
        { id: 'second', formats: [format()] },
      ],
      [
        async (ctx: any) => {
          ctx.candidates.reverse()
        },
      ]
    )
    const result = await registry.plan(request('format', ['a.ts']))
    expect(result.invocations[0].engineId).toBe('second')
  })

  it('re-filters middleware output and deduplicates candidate identities', async () => {
    const registry = buildDevRegistry(
      [
        { id: 'one', lints: [lint()] },
        { id: 'two', lints: [lint()] },
      ],
      [
        async (ctx: any) => {
          ctx.candidates = [
            ctx.candidates[1],
            ctx.candidates[1],
            ctx.candidates[0],
            { engineId: 'fake', capabilityIndex: 0 },
          ]
        },
      ]
    )
    const result = await registry.plan(request('lint', ['a.ts']))
    expect(
      result.invocations.map((invocation) => `${invocation.engineId}:${invocation.capabilityIndex}`)
    ).toEqual(['two:0', 'one:0'])
  })

  it('runs every lint survivor but only one formatter per extension group', async () => {
    const registry = buildDevRegistry([
      { id: 'a', formats: [format()], lints: [lint()] },
      { id: 'b', formats: [format()], lints: [lint()] },
    ])
    const formatResult = await registry.plan(request('format', ['a.ts']))
    const lintResult = await registry.plan(request('lint', ['a.ts']))
    expect(formatResult.invocations).toHaveLength(1)
    expect(lintResult.invocations).toHaveLength(2)
  })

  it('runs generators after extension-matched capabilities with resolved paths', async () => {
    const registry = buildDevRegistry([
      { id: 'normal', formats: [format()] },
      { id: 'generator', formats: [format({ generates: true, scope: ['src/**'] })] },
    ])
    const result = await registry.plan(request('format', ['src/a.ts', 'test/b.ts']))
    expect(result.invocations.map((invocation) => invocation.engineId)).toEqual([
      'normal',
      'generator',
    ])
    expect(result.invocations[1].paths).toEqual(['src/a.ts'])
  })

  it('distinguishes missing capabilities, suppression, and scope exclusion', async () => {
    const noCapability = await buildDevRegistry([
      { id: 'e', formats: [format({ extensions: ['js'] })] },
    ]).plan(request('format', ['a.ts']))
    expect(noCapability.skipped).toEqual([
      { group: 'ts', reason: 'no-capability', extensions: ['ts'] },
    ])

    const suppressed = await buildDevRegistry(
      [
        { id: 'a', formats: [format()] },
        { id: 'b', formats: [format()] },
      ],
      [
        async (ctx: any) => {
          ctx.candidates = []
        },
      ]
    ).plan(request('format', ['a.ts']))
    expect(suppressed.skipped[0]).toMatchObject({ group: 'ts', reason: 'suppressed-by-selection' })

    const excluded = await buildDevRegistry([
      { id: 'e', formats: [format({ scope: ['src/**'] })] },
    ]).plan(request('format', ['test/a.ts']))
    expect(excluded.invocations[0].paths).toEqual([])
    expect(excluded.scopeExcluded).toEqual([{ engineId: 'e', capabilityIndex: 0, count: 1 }])
  })

  it('arbitrates check once over the whole workspace, rethrows selection errors, and stamps dispatches', async () => {
    const seen: any[] = []
    const registry = buildDevRegistry(
      [
        { id: 'a', checks: [{ extensions: ['ts'], check: async () => ({ diagnostics: [] }) }] },
        { id: 'b', checks: [{ extensions: ['js'], check: async () => ({ diagnostics: [] }) }] },
      ],
      [
        async (ctx: any) => {
          seen.push(ctx)
          ctx.candidates.reverse()
        },
      ]
    )
    const result = await registry.plan(request('check', ['a.ts', 'b.js'], ['ts', 'js']))
    expect(seen).toHaveLength(1)
    expect(seen[0].group).toBeNull()
    expect(seen[0].request).toEqual({ paths: [], extensions: ['js', 'ts'] })
    expect(result.invocations.map((invocation) => invocation.engineId)).toEqual(['b', 'a'])
    expect(result.invocations.every((invocation) => invocation.groups.length === 0)).toBe(true)

    const throwing = buildDevRegistry(
      [
        { id: 'a', formats: [format()] },
        { id: 'b', formats: [format()] },
      ],
      [
        async () => {
          throw new Error('selection boom')
        },
      ]
    )
    await expect(throwing.plan(request('format', ['a.ts']))).rejects.toThrow('selection boom')

    // `throw undefined` is legal JS, so a sentinel testing the captured VALUE reads it as "no
    // error" and lets planning continue as though the stage had passed. The capture is flagged.
    // TWO engines: the onion only runs when candidates > 1 (arbitration, not a veto hook).
    const nihilist = buildDevRegistry(
      [
        { id: 'a', formats: [format()] },
        { id: 'b', formats: [format()] },
      ],
      [
        async () => {
          throw undefined
        },
      ]
    )
    let settled: 'resolved' | 'rejected' = 'resolved'
    await nihilist.plan(request('format', ['a.ts'])).catch(() => {
      settled = 'rejected'
    })
    expect(settled).toBe('rejected')

    const dispatched = buildDevRegistry([
      {
        id: 'e',
        formats: [
          {
            extensions: ['ts'],
            format: async () => ({
              diagnostics: [{ path: 'new.ts', severity: 'info', message: 'x', outOfScope: true }],
            }),
          },
        ] as any,
      },
    ])
    const plan = await dispatched.plan(request('format', ['a.ts']))
    const invocation = plan.invocations[0]
    const delta = await dispatched.dispatch(invocation, {
      files: new Map(),
      root: '/tmp',
      makeAccess: () => {
        throw new Error('unused')
      },
    })
    expect(delta.diagnostics[0]).toMatchObject({ engineId: 'e', outOfScope: true })
  })

  // A capability receives a shallow-cloned map of shallow-cloned entries, so neither the map nor
  // an entry object it is handed is the runtime's own. Without both clones an engine could edit
  // the live workspace directly, and the delta would stop being the only channel for a mutation.
  it('hands a capability a clone, so it cannot mutate the live workspace', async () => {
    const registry = buildDevRegistry([
      {
        id: 'vandal',
        formats: [
          {
            extensions: ['ts'],
            format: async (req: any) => {
              req.files.set('added-behind-your-back.ts', { text: 'x', mimeType: 'text/plain' })
              req.files.delete('b.ts')
              const entry = req.files.get('a.ts')
              if (entry) entry.text = 'vandalized'
              return {}
            },
          },
        ] as any,
      },
    ])
    const live = new Map([
      ['a.ts', { text: 'original', mimeType: 'text/plain' }],
      ['b.ts', { text: 'keep', mimeType: 'text/plain' }],
    ])
    const plan = await registry.plan(request('format', ['a.ts']))
    await registry.dispatch(plan.invocations[0], {
      files: live,
      root: '/tmp',
      makeAccess: () => {
        throw new Error('unused')
      },
    })
    expect(live.get('a.ts')!.text).toBe('original')
    expect(live.has('b.ts')).toBe(true)
    expect(live.has('added-behind-your-back.ts')).toBe(false)
  })
})

describe('dev-tools declaration validation', () => {
  it('rejects an empty extension declaration, uppercase, and dotted members', () => {
    for (const extensions of [[], ['TS'], ['t.s']]) {
      expect(() => buildDevRegistry([{ id: 'e', formats: [format({ extensions })] }])).toThrow(
        E_INVALID_DEV_PIPELINE_CONFIG
      )
    }
    expect(() =>
      buildDevRegistry([{ id: 'e', formats: [format({ extensions: [''] })] }])
    ).not.toThrow()
  })

  it('requires scope for in-place capabilities, including generators', () => {
    expect(() => buildDevRegistry([{ id: 'e', formats: [format({ inPlace: true })] }])).toThrow(
      E_INVALID_DEV_PIPELINE_CONFIG
    )
    expect(() =>
      buildDevRegistry([{ id: 'e', formats: [format({ inPlace: true, generates: true })] }])
    ).toThrow(E_INVALID_DEV_PIPELINE_CONFIG)
    expect(() =>
      buildDevRegistry([{ id: 'e', formats: [format({ inPlace: true, scope: ['src/**'] })] }])
    ).not.toThrow()
    expect(() =>
      buildDevRegistry([
        { id: 'e', formats: [format({ inPlace: true, generates: true, scope: ['generated/**'] })] },
      ])
    ).not.toThrow()
    expect(() =>
      buildDevRegistry([{ id: 'e', formats: [format({ generates: true })] }])
    ).not.toThrow()
  })

  it('requires generating linters to be fixable and accepts a fixable generator', () => {
    expect(() =>
      buildDevRegistry([{ id: 'e', lints: [lint({ fixable: false, generates: true })] }])
    ).toThrow(E_INVALID_DEV_PIPELINE_CONFIG)
    expect(() =>
      buildDevRegistry([
        { id: 'e', lints: [lint({ generates: true, inPlace: true, scope: ['generated/**'] })] },
      ])
    ).not.toThrow()
  })

  it('rejects a linter declaration that omits required fixable', () => {
    expect(() =>
      buildDevRegistry([
        { id: 'tool', lints: [{ extensions: ['ts'], lint: async () => ({}) } as any] },
      ])
    ).toThrow(/tool.*capability index 0.*fixable/)
  })

  it('validates capability field types', () => {
    expect(() => buildDevRegistry([{ id: 'tool', formats: [format({ inPlace: 'yes' })] }])).toThrow(
      /tool.*capability index 0/
    )
    expect(() =>
      buildDevRegistry([{ id: 'tool', formats: [format({ scope: ['src/**', 123] })] }])
    ).toThrow(/tool.*capability index 0/)
  })

  it('normalizes, deduplicates, and sorts declared scope globs', () => {
    const registry = buildDevRegistry([
      {
        id: 'e',
        formats: [format({ inPlace: true, scope: [' z/** ', 'a/**', 'z/**', ' a/** '] })],
      },
    ])
    expect(registry.engines[0].formats?.[0].scope).toEqual(['a/**', 'z/**'])
  })

  it('accepts literal scope metacharacters but rejects them in patterns', () => {
    const literals = ['src/a[b].ts', 'src/a{b}.ts', 'src/a?.ts', 'src/a!.ts']
    const registry = buildDevRegistry([
      { id: 'e', formats: [format({ scope: literals.map((value) => ` ${value} `) })] },
    ])
    expect(registry.engines[0].formats?.[0].scope).toEqual([...literals].sort())

    for (const literal of literals)
      expect(() =>
        buildDevRegistry([{ id: 'e', formats: [format({ scope: [`${literal}*`] })] }])
      ).toThrow(E_INVALID_DEV_PIPELINE_CONFIG)
  })

  it('names both the engine and declared capability index in rejection messages', () => {
    expect(() =>
      buildDevRegistry([{ id: 'tool', formats: [format(), format({ extensions: [] })] }])
    ).toThrow(/tool.*capability index 1/)
    expect(() => buildDevRegistry([{ id: 'tool', formats: [{ extensions: {} } as any] }])).toThrow(
      /tool.*capability index 0/
    )
  })

  it('rejects malformed capability containers with a configuration error', () => {
    expect(() => buildDevRegistry([{ id: 'tool', formats: { extensions: {} } as any }])).toThrow(
      E_INVALID_DEV_PIPELINE_CONFIG
    )
    expect(() =>
      buildDevRegistry([{ id: 'tool', formats: { extensions: {} } as any }])
    ).not.toThrow(TypeError)
  })

  it('deduplicates known needs and accepts needs on non-in-place capabilities', () => {
    const registry = buildDevRegistry([
      {
        id: 'e',
        formats: [format({ needs: ['rename', 'rename'] })],
        lints: [lint({ needs: ['mkdir'] })],
      },
    ])
    expect(registry.engines[0].formats?.[0].needs).toEqual(['rename'])
    expect(() => buildDevRegistry([{ id: 'e', formats: [format({ needs: ['move'] })] }])).toThrow(
      E_INVALID_DEV_PIPELINE_CONFIG
    )
  })
})
