import { describe, expect, it } from 'vitest'
import { defaultSandboxNarrator } from '../../../../src/batteries/sandbox/narrator'
import { runSandboxConformance } from '../../../../src/batteries/sandbox/conformance'
import { implementsSandboxSearch } from '../../../../src/batteries/sandbox/contracts/search'
import { implementsGuestRuntime } from '../../../../src/batteries/sandbox/contracts/guest_runtime'
import { implementsMimeResolver } from '../../../../src/batteries/sandbox/contracts/mime_resolver'
import { implementsSandboxFileSystem } from '../../../../src/batteries/sandbox/contracts/file_system'
import { implementsPathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'
import { implementsArtifactMinter } from '../../../../src/batteries/sandbox/contracts/artifact_minter'
import { implementsSandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'
import {
  createPathTranslator,
  isRejectedSandboxPath,
  normalizeSandboxPath,
} from '../../../../src/batteries/sandbox/paths'
import {
  guestLimitFloors,
  guestLimitsDefaults,
  hostcallQuotasDefaults,
  implementsGuestLimits,
  implementsHostcallQuotas,
  createModelPath,
  createModelWriteRoot,
  createSandboxEpoch,
} from '../../../../src/batteries/sandbox/types'
import type { SandboxEpoch } from '../../../../src/batteries/sandbox/types'
import type { SandboxOutcome } from '../../../../src/batteries/sandbox/narrator'
import type { SandboxFileSystem } from '../../../../src/batteries/sandbox/contracts/file_system'

describe('sandbox WP0 contracts', () => {
  it('guards reject wrong shapes and accept conforming shapes', () => {
    expect(implementsSandboxFileSystem({})).toBe(false)
    expect(implementsSandboxSearch({})).toBe(false)
    expect(implementsGuestRuntime({})).toBe(false)
    expect(implementsSandboxPolicyEnforcer({})).toBe(false)
    expect(implementsMimeResolver(null)).toBe(false)
    expect(implementsArtifactMinter({})).toBe(false)
    const fs: SandboxFileSystem = {
      stat: async () => ({ size: 0, version: 'v', kind: 'file' as const }),
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      read: async () => new ReadableStream(),
      write: async () => {},
    }
    expect(implementsPathTranslator(createPathTranslator('/tmp/root', fs))).toBe(true)
    expect(
      implementsPathTranslator({
        toRelative: async () => '',
        toBackendPath: () => '',
        redact: (value: string) => value,
      })
    ).toBe(false)
  })
  it('applies the ordered path rejection set', async () => {
    const fs: SandboxFileSystem = {
      stat: async () => ({ size: 0, version: 'v', kind: 'file' as const }),
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      read: async () => new ReadableStream(),
      write: async () => {},
    }
    const translator = createPathTranslator('/Users/alice/deep/workspace/sandbox', fs)
    const sharedPaths = ['/src/index.ts', '/generated', '/', '~', 'C:/x', '//server/share', 'a\0b']
    for (const value of sharedPaths) {
      const rejected = isRejectedSandboxPath(value)
      if (rejected) expect(() => createModelPath(value)).toThrow(/path is not a model path/)
      else expect(createModelPath(value)).toBe(normalizeSandboxPath(value))
      await translator.toRelative(value).then(
        (result) => {
          expect(rejected).toBe(false)
          expect(result).toBe(normalizeSandboxPath(value))
        },
        () => expect(rejected).toBe(true)
      )
    }
    await expect(translator.toRelative('/src/index.ts')).resolves.toBe('src/index.ts')
    await expect(translator.toRelative('/src')).resolves.toBe('src')
    await expect(translator.toRelative('/')).resolves.toBe('')
    await expect(translator.toRelative('//')).resolves.toBe('')
    await expect(translator.toRelative('///')).resolves.toBe('')
    await expect(translator.toRelative('/./src')).resolves.toBe('src')
    await expect(translator.toRelative('/a/./b')).resolves.toBe('a/b')
    await expect(translator.toRelative('%2e%2e')).resolves.toBe('%2e%2e')
    for (const value of [
      '../x',
      '~',
      '\\\\server\\share',
      '//server/share',
      '/\\server\\share',
      '\\\\/server\\share',
      '\\\\?\\C:\\x',
      '\\\\.\\dev',
      'C:\\x',
      'C:x',
      'C:/x',
      'a\0b',
    ])
      await expect(translator.toRelative(value)).rejects.toThrow()
    expect(() => createPathTranslator('relative', fs)).toThrow(
      /E_INVALID_SANDBOX_CONFIG|root must be absolute/
    )
    expect(() => createPathTranslator('/tmp/\0root', fs)).toThrow(
      /E_INVALID_SANDBOX_CONFIG|root contains NUL/
    )
    expect(translator.redact('/Users/alice/deep/workspace/sandbox/src')).toBe('<sandbox-root>/src')
    const relativeSource = await translator.toRelative('/src')
    expect(relativeSource.includes('/Users/alice')).toBe(false)
    const symlinkFs = {
      stat: async () => ({ size: 0, version: 'v', kind: 'symlink' as const }),
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      read: async () => new ReadableStream(),
      write: async () => {},
    }
    const checked = createPathTranslator('/tmp/sandbox', symlinkFs)
    await expect(checked.toRelative('src/file')).rejects.toThrow()
  })
  it('keeps root-mounted and nested-root translation equivalent', async () => {
    // `/tmp/sandbox/` is not decoration: a trailing slash must canonicalise to the same root, or the
    // join helper emits `//` for every path under it.
    const roots = ['/', '/tmp/sandbox', '/tmp/sandbox/']
    const fileSystem: SandboxFileSystem = {
      stat: async () => ({ size: 0, version: 'v', kind: 'file' as const }),
      list: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      read: async () => new ReadableStream(),
      write: async () => {},
    }
    for (const root of roots) {
      const probes: string[] = []
      const probingFileSystem: SandboxFileSystem = {
        ...fileSystem,
        stat: async (path) => {
          probes.push(path)
          return { size: 0, version: 'v', kind: 'file' as const }
        },
      }
      const translator = createPathTranslator(root, probingFileSystem)
      await expect(translator.toRelative('src/index.ts')).resolves.toBe('src/index.ts')
      await expect(translator.toRelative('/src/index.ts')).resolves.toBe('src/index.ts')
      await expect(translator.toRelative('../outside')).rejects.toThrow()
      // Compare against the CANONICAL root, not the raw one: a trailing-slash root must collapse, so
      // interpolating `${root}/src` here would demand `/tmp/sandbox//src` — the very double separator
      // the shared join exists to prevent.
      const canonicalRoot = root.replace(/\/$/, '') || '/'
      expect(translator.toBackendPath('src')).toBe(
        canonicalRoot === '/' ? '/src' : `${canonicalRoot}/src`
      )
      if (root === '/') expect(probes.slice(0, 3)).toEqual(['/', '/src', '/src/index.ts'])
      // The shared root-aware join, pinned across its whole boundary table. A join helper is exactly
      // the code that ships with an off-by-one separator, and root `/` is the case where a naive
      // `${root}/${rel}` yields `//src` — implementation-defined in POSIX, so a backend that treats
      // `//` as a distinct namespace would silently probe the wrong path.
      expect(translator.toBackendPath('')).toBe(canonicalRoot)
      expect(translator.toBackendPath('nested/child')).toBe(
        canonicalRoot === '/' ? '/nested/child' : `${canonicalRoot}/nested/child`
      )
      expect(translator.toBackendPath('src')).not.toContain('//')
    }

    for (const root of roots) {
      const symlinkFileSystem: SandboxFileSystem = {
        ...fileSystem,
        stat: async () => ({ size: 0, version: 'v', kind: 'symlink' as const }),
      }
      const translator = createPathTranslator(root, symlinkFileSystem)
      await expect(translator.toRelative('src/index.ts')).rejects.toThrow()
    }
  })
  it('rejects malformed policy members and extra limit fields', async () => {
    const { passesSchema } = await import('../../../../src/batteries/sandbox/validation')
    const { sandboxPolicySchema, guestLimitsSchema, hostcallQuotasSchema } =
      await import('../../../../src/batteries/sandbox/types')
    expect(
      passesSchema(sandboxPolicySchema, {
        filesystem: { denyRead: 'bad' },
        network: { disabled: 'yes' },
      })
    ).toBe(false)
    expect(
      passesSchema(sandboxPolicySchema, {
        filesystem: {},
        network: { deniedDomainReasons: { x: 1 } },
      })
    ).toBe(false)
    expect(passesSchema(sandboxPolicySchema, { filesystem: {}, network: {} })).toBe(true)
    expect(passesSchema(guestLimitsSchema, { ...guestLimitsDefaults, extra: 1 })).toBe(false)
    expect(
      passesSchema(hostcallQuotasSchema, {
        ...hostcallQuotasDefaults,
        extra: 1,
      })
    ).toBe(false)
  })
  it('validates each limit floor and accepts zero drain', () => {
    expect(implementsGuestLimits(guestLimitsDefaults)).toBe(true)
    expect(implementsHostcallQuotas(hostcallQuotasDefaults)).toBe(true)
    for (const key of Object.keys(guestLimitFloors)) {
      const value = {
        ...guestLimitsDefaults,
        [key]: (guestLimitFloors as unknown as Record<string, number>)[key] - 1,
      }
      expect(implementsGuestLimits(value)).toBe(false)
    }
    expect(implementsGuestLimits({ ...guestLimitsDefaults, logDrainMs: 0 })).toBe(true)
    expect(implementsGuestLimits({ ...guestLimitsDefaults, logDrainMs: -1 })).toBe(false)
  })
  it('rejects every malformed or incomplete conformance stream', async () => {
    const valid = { kind: 'done', complete: true } as const
    // `frames` is `unknown[]` on purpose: every fixture below is a MALFORMED frame the union no
    // longer admits, and the suite's job is to prove the conformance runner rejects them. The
    // generator is therefore cast to the contract's shape at the seam rather than each fixture
    // being individually cast — the runner receives exactly what a non-conformant adapter emits.
    const source = (frames: unknown[]) =>
      async function* (_signal?: AbortSignal, onStart?: () => void) {
        onStart?.()
        yield* frames
      } as unknown as (signal?: AbortSignal, onStart?: () => void) => AsyncIterable<never>
    const base = (list: (signal?: AbortSignal, onStart?: () => void) => AsyncIterable<never>) => ({
      list,
      findPaths: list,
      searchContent: list,
      read: async () => new ReadableStream<Uint8Array>(),
      stat: async () => ({ size: 0, version: 'v' }),
    })
    const rejected = [
      [{ kind: 'done', complete: false, omitted: 'unexplored' }],
      [{ kind: 'item', path: 'x' }, valid],
      [valid, { kind: 'item', path: 'x' }],
      [{ kind: 'done', complete: true, bound: 'maxDepth' }],
      [
        { kind: 'item', path: 'x' },
        {
          kind: 'done',
          complete: true,
          omitted: 'unexplored',
          bound: 'maxDepth',
          atDepth: 1,
        },
      ],
      // The deleted count-cap arms. An adapter still emitting either is non-conformant rather
      // than conservative, so the suite must REJECT them — that is the property under test.
      [{ kind: 'done', complete: false, omitted: 'proven' }],
      [{ kind: 'done', complete: false, bound: 'maxResults' }],
      // The over-limit arm is exact-key validated: these near misses must not be accepted.
      [{ kind: 'done', complete: false, omitted: 'over-limit', bound: 'maxDepth', shown: 1 }],
      [{ kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit' }],
      [
        {
          kind: 'done',
          complete: false,
          omitted: 'over-limit',
          bound: 'limit',
          shown: 1,
          extra: true,
        },
      ],
      [{ kind: 'item', path: 'x' }],
    ]
    for (const frames of rejected) {
      await expect(runSandboxConformance(base(source(frames)))).rejects.toThrow()
    }
    await expect(runSandboxConformance(base(source([valid])))).resolves.toBeUndefined()
    await expect(
      runSandboxConformance(
        base(
          source([
            { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown: 1 },
          ])
        )
      )
    ).resolves.toBeUndefined()
  })
  it('narrates every outcome and hides existence', () => {
    const outcomes: SandboxOutcome[] = [
      { kind: 'not-found', path: 'x' },
      { kind: 'denied-by-policy', path: 'x', axis: 'read' },
      { kind: 'gate-declined' },
      { kind: 'gate-unavailable', reason: 'error' },
      {
        kind: 'over-budget',
        bound: 'maxTerminalPayloadBytes',
        observedAtLeast: 1,
        limit: 2,
      },
      { kind: 'scope-limited', shown: 1, atDepth: 2, bound: 'maxDepth' },
      { kind: 'result-limited', shown: 2, limit: 3, bound: 'limit' },
      { kind: 'not-a-regular-file', path: 'x', kind_: 'other' },
      { kind: 'is-a-directory', path: 'x' },
      { kind: 'path-rejected', input: 'x', reason: 'escape' },
      {
        kind: 'outside-write-root',
        path: createModelPath('x'),
        writeRoot: createModelWriteRoot('/'),
      },
      { kind: 'sandbox-violation', violations: ['x'], exitCode: 1 },
      { kind: 'nonzero-exit', exitCode: 1 },
      { kind: 'no-matches', pattern: 'x', scope: '/' },
      { kind: 'unknown-media', mediaId: 'x' },
      { kind: 'invalid-pattern', pattern: 'x', detail: 'bad' },
      { kind: 'not-a-directory', path: 'x' },
      { kind: 'io-failure', detail: 'bad' },
      { kind: 'aborted' },
      { kind: 'timed-out', bound: 'timeout_seconds', limitSeconds: 1 },
    ]
    expect(defaultSandboxNarrator(outcomes[0])).toBe(defaultSandboxNarrator(outcomes[1]))
    const registeredToolNames = [
      'list_directory',
      'list_media',
      'open_file',
      'save_media',
      'stage_file',
      'search_files',
      'find_files',
      'run_shell_command',
      'evaluate_javascript',
      'artifact_head',
      'artifact_cat',
      'artifact_grep',
    ]
    for (const outcome of outcomes) {
      const narration = defaultSandboxNarrator(outcome)
      expect(narration).toMatch(/\S/)
      for (const toolName of registeredToolNames) expect(narration).not.toContain(toolName)
      switch (outcome.kind) {
        case 'not-found':
        case 'denied-by-policy':
        case 'not-a-regular-file':
        case 'is-a-directory':
        case 'not-a-directory':
          expect(narration).toContain(outcome.path)
          break
        case 'gate-declined':
          expect(narration).toContain('Approval')
          expect(narration).toContain('try again')
          break
        case 'gate-unavailable':
          expect(narration).toContain(outcome.reason)
          expect(narration).toContain('retry')
          break
        case 'over-budget':
          expect(narration).toContain(outcome.bound)
          expect(narration).toContain(String(outcome.limit))
          break
        case 'scope-limited':
          expect(narration).toContain(String(outcome.atDepth))
          expect(narration).toContain('max_depth')
          break
        case 'result-limited':
          expect(narration).toContain(String(outcome.shown))
          expect(narration).toContain(String(outcome.limit))
          expect(narration).not.toContain('max_depth')
          break
        case 'path-rejected':
          expect(narration).toContain(outcome.input)
          // Each REASON now carries its own remedy (a NUL byte and a `../` escape need different
          // advice), so this asserts the invariant true of all of them rather than one arm's wording:
          // the message names the rejection and tells the model what to do next.
          expect(narration).toMatch(/Path rejected/)
          expect(narration.length).toBeGreaterThan(`Path rejected (${outcome.input}).`.length)
          break
        case 'outside-write-root':
          expect(narration).toContain(outcome.path)
          // NOT `toContain(outcome.writeRoot)` — `createModelWriteRoot('/')` normalises to `''`, so
          // that assertion is vacuously true and would not catch a reversion to `outside <>`. The
          // sandbox root is the one value whose STORED form (`''`) differs from its DISPLAY form
          // (`/`), so the rendered text is what has to be pinned.
          expect(narration).toContain(
            outcome.writeRoot === '' ? 'outside </>' : `outside <${outcome.writeRoot}>`
          )
          expect(narration).not.toContain('outside <>')
          break
        case 'sandbox-violation':
          expect(narration).toContain(outcome.violations[0])
          expect(narration).toContain(String(outcome.exitCode))
          break
        case 'nonzero-exit':
          expect(narration).toContain(String(outcome.exitCode))
          expect(narration).toContain('retry')
          break
        case 'no-matches':
          expect(narration).toContain(outcome.pattern)
          expect(narration).toContain(outcome.scope)
          break
        case 'unknown-media':
          expect(narration).toContain(outcome.mediaId)
          expect(narration).toContain('valid media handle')
          break
        case 'invalid-pattern':
          expect(narration).toContain(outcome.pattern)
          expect(narration).toContain(outcome.detail)
          break
        case 'io-failure':
          expect(narration).toContain(outcome.detail)
          expect(narration).toContain('retry')
          break
        case 'aborted':
          expect(narration).toContain('aborted')
          expect(narration).toContain('try again')
          break
        case 'timed-out':
          expect(narration).toContain(String(outcome.limitSeconds))
          expect(narration).toContain('timeout_seconds')
          break
      }
    }
  })
  it('issues identity-safe sandbox epochs', () => {
    const first = createSandboxEpoch()
    const second = createSandboxEpoch()
    expect(first).not.toBe(second)
    expect(first).toBe(first)
    expect(typeof first).toBe('object')
    // @ts-expect-error Raw objects cannot mint an epoch token.
    const rawObject: SandboxEpoch = {}
    // @ts-expect-error Primitive values cannot mint an epoch token.
    const rawPrimitive: SandboxEpoch = 'epoch'
    expect(rawObject).toBeDefined()
    expect(rawPrimitive).toBeDefined()
  })
  it('keeps host paths out of model write-root outcomes', () => {
    expect(createModelWriteRoot('/Users/alice/deep/workspace')).toBe('Users/alice/deep/workspace')
    const outcome: SandboxOutcome = {
      kind: 'outside-write-root',
      path: createModelPath('src/file'),
      writeRoot: createModelWriteRoot('/'),
    }
    expect(outcome.writeRoot).not.toContain('/Users/alice')
    const narration = defaultSandboxNarrator(outcome)
    expect(narration).toContain('src/file')
    expect(narration).not.toContain('/Users/alice')
  })
})
