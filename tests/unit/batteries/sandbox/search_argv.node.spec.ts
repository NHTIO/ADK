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
const recordingEnforcer = (): { enforcer: SandboxPolicyEnforcer; argvs: string[][] } => {
  const argvs: string[][] = []
  const enforcer = {
    isSupported: () => true,
    checkDependencies: async () => ({ errors: [], warnings: [] }),
    run: async (op: { argv: string[] }) => {
      argvs.push([...op.argv])
      return {
        stdout: empty(),
        stderr: empty(),
        // Exit 1 is ripgrep's "ran fine, matched nothing" — a RESULT, so the searcher yields `done`
        // rather than throwing, and the test observes argv construction without needing real hits.
        completed: Promise.resolve({ exitCode: 1, failed: true }),
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
      search.searchContent({ root: 'src', pattern: 'timeout', maxDepth: 5 })
    )

    // Reaching a terminal frame at all proves the argv passed its own validation.
    expect(frames).toEqual([{ kind: 'done', complete: true }])
    expect(argvs).toHaveLength(1)
    expect(argvs[0]).toContain('--json')
  })

  it('declares every flag it emits, on both search surfaces', async () => {
    const { enforcer, argvs } = recordingEnforcer()
    const search = createRipgrepSearch(enforcer, policy)

    await drain(search.searchContent({ root: 'src', pattern: 'x', maxDepth: 3 }))
    await drain(search.findPaths({ root: 'src', glob: '*.ts', maxDepth: 3 }))

    expect(argvs).toHaveLength(2)
    for (const argv of argvs) {
      // Everything before `--` that looks like a flag must be declared. Past the terminator the values
      // are model-supplied and deliberately unchecked against this list.
      const terminator = argv.indexOf('--')
      const scanned = terminator === -1 ? argv.slice(1) : argv.slice(1, terminator)
      for (const arg of scanned.filter((x) => x.startsWith('--')))
        expect(ALLOWED_RIPGREP_FLAGS as readonly string[]).toContain(arg)
    }
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
      drain(search.searchContent({ root: 'src', pattern: '--pre=/bin/sh', maxDepth: 2 }))
    ).rejects.toThrow(/must not begin with '-'/)
    expect(argvs).toHaveLength(0)

    // An ordinary pattern containing a dash elsewhere is fine, and lands after the terminator.
    const frames = await drain(
      search.searchContent({ root: 'src', pattern: 'well-formed', maxDepth: 2 })
    )
    expect(frames).toEqual([{ kind: 'done', complete: true }])
    const argv = argvs[0]!
    expect(argv.indexOf('--')).toBeGreaterThan(0)
    expect(argv.indexOf('well-formed')).toBeGreaterThan(argv.indexOf('--'))
  })
})
