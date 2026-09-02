import { describe, expect, it } from 'vitest'
import { ALLOWED_RIPGREP_FLAGS } from '../../../../src/batteries/sandbox/escape'
import { createRipgrepSearch } from '../../../../src/batteries/sandbox/node/search_ripgrep'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

/**
 * The searcher must not reject its OWN argv.
 *
 * @remarks
 * `searchContent` validates the flags it emits against `ALLOWED_RIPGREP_FLAGS` as defence in depth. That
 * check is only sound if every flag the adapter emits is actually on the list — otherwise the capability
 * throws for every invocation, which is what `--json` did.
 *
 * WHY NO EXISTING TEST CAUGHT IT: every unit spec injects a FAKE `SandboxSearch`, so the real argv is
 * never built, and the one spec that drives the real searcher is `TEST_SANDBOX_LIVE`-gated *and* wrapped
 * in `platform !== 'linux'` — so on macOS it reports passing while executing nothing. These tests use a
 * fake ENFORCER instead of a fake searcher: the real `createRipgrepSearch` builds and validates a real
 * argv, and nothing spawns.
 */
const policy: SandboxPolicy = { filesystem: {}, network: {} }

const empty = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

/** Records the argv the searcher built, and reports a clean no-match run. */
const recordingEnforcer = (
  stdout = empty(),
  hasResults = false
): { enforcer: SandboxPolicyEnforcer; argvs: string[][] } => {
  const argvs: string[][] = []
  const enforcer = {
    isSupported: () => true,
    checkDependencies: async () => ({ errors: [], warnings: [] }),
    run: async (op: { argv: string[] }) => {
      argvs.push([...op.argv])
      return {
        stdout,
        stderr: empty(),
        // Exit 1 is ripgrep's "ran fine, matched nothing" — a RESULT, so the searcher yields `done`
        // rather than throwing, and the test observes argv construction without needing real hits.
        completed: Promise.resolve({ exitCode: hasResults ? 0 : 1, failed: !hasResults }),
      }
    },
    effectivePolicy: () => undefined,
    diagnosticsFor: () => [],
    dispose: async () => {},
  } as unknown as SandboxPolicyEnforcer
  return { enforcer, argvs }
}

const drain = async (source: AsyncIterable<unknown>): Promise<unknown[]> => {
  const frames: unknown[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}

describe('ripgrep searcher argv', () => {
  it('does not reject its own `searchContent` flags', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)

    const frames = await drain(
      search.searchContent({ root: 'src', pattern: 'timeout', maxDepth: 5, limit: 100 })
    )

    // Reaching a terminal frame at all proves the argv passed its own validation.
    expect(frames).toEqual([{ kind: 'done', complete: true }])
    expect(argvs).toHaveLength(1)
    expect(argvs[0]).toContain('--json')
  })

  it('emits every adapter option in its long spelling and never a short alias', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)

    await drain(
      search.searchContent({
        root: 'src',
        pattern: 'x',
        maxDepth: 3,
        limit: 100,
        ignoreCase: true,
        literal: true,
        glob: '*.ts',
        iglob: '*.TS',
        hidden: true,
        noIgnore: true,
      })
    )

    const argv = argvs[0]!
    for (const flag of [
      '--ignore-case',
      '--fixed-strings',
      '--glob',
      '--iglob',
      '--hidden',
      '--no-ignore',
    ])
      expect(argv).toContain(flag)
    expect(argv).not.toContain('-i')
    expect(argv).not.toContain('-F')
    for (const arg of argv.filter((x) => x.startsWith('--') && x !== '--'))
      expect(ALLOWED_RIPGREP_FLAGS as readonly string[]).toContain(arg)
  })

  it('requires a find-paths terminator before the root and refuses an option-shaped root', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)
    await drain(search.findPaths({ root: 'src', glob: '*.ts', maxDepth: 3, limit: 100 }))
    const argv = argvs[0]!
    expect(argv.indexOf('--')).toBeGreaterThan(0)
    expect(argv.indexOf('src')).toBeGreaterThan(argv.indexOf('--'))

    await expect(
      drain(search.findPaths({ root: '--danger', glob: '*.ts', maxDepth: 3, limit: 100 }))
    ).rejects.toThrow(/must not begin with '-'/)
    expect(argvs).toHaveLength(1)
  })

  // The contract states limit is an integer >= 1 and names the ADAPTER as the enforcement point.
  // Unenforced, limit: 0 makes the first result trip the over-limit branch, so a caller gets an
  // empty incomplete result that looks like "no matches" rather than an error about their bound.
  it('refuses a nonpositive or fractional limit before spawning', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        drain(search.searchContent({ root: 'src', pattern: 'x', maxDepth: 2, limit }))
      ).rejects.toThrow(/limit must be a positive integer/)
      await expect(
        drain(search.findPaths({ root: 'src', glob: '*.ts', maxDepth: 2, limit }))
      ).rejects.toThrow(/limit must be a positive integer/)
    }
    expect(argvs).toHaveLength(0)
  })

  it('refuses follow before spawning', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)
    await expect(
      drain(
        search.searchContent({ root: 'src', pattern: 'x', maxDepth: 3, limit: 100, follow: true })
      )
    ).rejects.toThrow(/follow.*refused/i)
    await expect(
      drain(search.findPaths({ root: 'src', glob: '*.ts', maxDepth: 3, limit: 100, follow: true }))
    ).rejects.toThrow(/follow.*refused/i)
    expect(argvs).toHaveLength(0)
  })

  it('truncates find paths at limit and emits the exact over-limit frame', async () => {
    const { enforcer } = recordingEnforcer(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('one.ts\ntwo.ts\nthree.ts\n'))
          c.close()
        },
      }),
      true
    )
    const search = createRipgrepSearch(enforcer, policy)
    const frames = await drain(
      search.findPaths({ root: 'src', glob: '*.ts', maxDepth: 3, limit: 2 })
    )
    expect(frames).toEqual([
      { kind: 'item', path: 'one.ts' },
      { kind: 'item', path: 'two.ts' },
      { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown: 2 },
    ])
  })

  it('truncates content at limit and emits the exact over-limit frame', async () => {
    const output = [1, 2, 3]
      .map((n) =>
        JSON.stringify({
          type: 'match',
          data: { path: { text: `f${n}.ts` }, line_number: n, lines: { text: `hit${n}` } },
        })
      )
      .join('\n')
    const { enforcer } = recordingEnforcer(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(output))
          c.close()
        },
      }),
      true
    )
    const search = createRipgrepSearch(enforcer, policy)
    const frames = await drain(
      search.searchContent({ root: 'src', pattern: 'x', maxDepth: 3, limit: 2 })
    )
    expect(frames).toHaveLength(3)
    expect(frames.slice(0, 2)).toHaveLength(2)
    expect(frames[2]).toEqual({
      kind: 'done',
      complete: false,
      omitted: 'over-limit',
      bound: 'limit',
      shown: 2,
    })
  })

  it('stays complete when exactly limit results are available', async () => {
    const output = [1, 2]
      .map((n) =>
        JSON.stringify({
          type: 'match',
          data: { path: { text: `f${n}.ts` }, line_number: n, lines: { text: `hit${n}` } },
        })
      )
      .join('\n')
    const { enforcer } = recordingEnforcer(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(output))
          c.close()
        },
      }),
      true
    )
    const search = createRipgrepSearch(enforcer, policy)
    const frames = await drain(
      search.searchContent({ root: 'src', pattern: 'x', maxDepth: 3, limit: 2 })
    )
    expect(frames.filter((x: any) => x.kind === 'item')).toHaveLength(2)
    expect(frames.at(-1)).toEqual({ kind: 'done', complete: true })
  })

  it('refuses an option-shaped pattern at the VALUE guard, not the flag allow-list', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)

    // A leading `-` in a model-supplied value is refused outright by `assertArgvValue` — the
    // option-injection guard, which exists because a correctly-quoted `--pre=/bin/sh` is still an
    // OPTION. So an option-shaped pattern is rejected, and the important part is WHICH check rejects
    // it and that nothing spawned: the flag allow-list must not be the thing policing model input,
    // or the two concerns drift.
    await expect(
      drain(
        search.searchContent({ root: 'src', pattern: '--pre=/bin/sh', maxDepth: 2, limit: 100 })
      )
    ).rejects.toThrow(/must not begin with '-'/)
    expect(argvs).toHaveLength(0)

    // An ordinary pattern containing a dash elsewhere is fine, and lands after the terminator.
    const frames = await drain(
      search.searchContent({ root: 'src', pattern: 'well-formed', maxDepth: 2, limit: 100 })
    )
    expect(frames).toEqual([{ kind: 'done', complete: true }])
    const argv = argvs[0]!
    expect(argv.indexOf('--')).toBeGreaterThan(0)
    expect(argv.indexOf('well-formed')).toBeGreaterThan(argv.indexOf('--'))
  })
})
