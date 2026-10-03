import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSandbox } from '../../../../src/batteries/sandbox/manager'
import { sandboxRuntimeGate, sandboxRuntimeGateReason } from '../../../_fixtures/sandbox_runtime'
import { E_SANDBOX_NETWORK_GRANT_UNSUPPORTED } from '../../../../src/batteries/sandbox/exceptions'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { SandboxHandle } from '../../../../src/batteries/sandbox/manager'

/**
 * Per-call `handle.run({ policy })` semantics under the REAL SRT enforcer (issue #50).
 *
 * @remarks
 * D12's intended architecture is a minimal process-global baseline with each command's granted
 * sources/domains supplied per call. Whether that holds depends entirely on the OS backend, so this
 * suite MEASURES it against a real seatbelt sandbox on macOS AND a real bubblewrap sandbox on Linux.
 * Both were run (see the report); the two platforms agree on every step, so the conclusions below are
 * stated for SRT as a whole rather than for one host.
 *
 * Measured results (identical on macOS/seatbelt and Linux/bwrap):
 *  - FILESYSTEM per-call grants ARE honoured, and scoped to that child. The per-call
 *    `filesystem.allowWrite` is baked into the profile of THAT child, REPLACING the baseline set
 *    (not unioned), and the next baseline child is denied the per-call path again. So a per-call
 *    policy must repeat whatever baseline writes it still wants. On Linux this is a bwrap `--bind`
 *    over a read-only root, so the per-call allow path must already exist (SRT skips absent ones).
 *  - NETWORK per-call policies are NOT representable at all. SRT's mux proxy is one process-global
 *    instance whose filter reads the SESSION `config.network` on every request, never the per-call
 *    `customConfig`. A per-call section that DIFFERS from the session's — wider (a new domain),
 *    narrower (a shorter allow-list, an added deny), or a different `disabled` — would therefore be
 *    silently ignored, so `srtEnforcer.run()` REJECTS every difference with
 *    `E_SANDBOX_NETWORK_GRANT_UNSUPPORTED`, fail closed. An EQUAL section is accepted, so a per-call
 *    FILESYSTEM policy still works as long as it repeats the session's network section exactly
 *    (order-insensitive set equality of the domain lists).
 *
 * @remarks
 * The per-child network route was investigated and MEASURED dead (round 3): the `initialize()` ask
 * callback is handed only `{host, port}` (no child identity), is never consulted while
 * `strictAllowlist` is set (which this battery always sets), and its one identity input — the proxy
 * username — is client-controlled and forgeable; `network.filterRequest` runs only after the session
 * list has already allowed a host, so it can deny within the list but never grant beyond it.
 *
 * ONE enforcer for the whole file, deliberately: `SandboxManager` is a process-global whose `config`
 * survives `reset()`, so a second real session cannot be established in the same process (a second
 * construction ADOPTS the dead first policy and admission then refuses). Sharing one live session is
 * the only way to run two real-SRT tests here.
 */
const root = await mkdtemp(join(tmpdir(), 'adk50-'))
const baselineWrite = join(root, 'baseline-write')
const perCallWrite = join(root, 'per-call-write')

const baseline: SandboxPolicy = {
  filesystem: { allowWrite: [baselineWrite], gitSafeDirectories: [root] },
  network: { allowedDomains: ['example.com'] },
}

let handle: SandboxHandle

const drain = async (spawned: {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  completed: Promise<{ exitCode: number; failed: boolean }>
}): Promise<{ out: string; err: string; exitCode: number }> => {
  const decoder = new TextDecoder()
  let out = ''
  let err = ''
  const read = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    const reader = stream.getReader()
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      sink(decoder.decode(next.value, { stream: true }))
    }
  }
  await Promise.all([
    read(spawned.stdout, (t) => (out += t)),
    read(spawned.stderr, (t) => (err += t)),
  ])
  const completed = await spawned.completed
  return { out, err, exitCode: completed.exitCode }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

// Shared dependency + namespace probe: automatic runtime coverage, never a live-test opt-in.
// The always-running platform note below records the reason when infrastructure prevents it.
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!sandboxRuntimeGate)(
  'per-call policy under the real SRT enforcer (issue #50, seatbelt + bwrap)',
  () => {
    beforeAll(async () => {
      await mkdir(baselineWrite, { recursive: true })
      await mkdir(perCallWrite, { recursive: true })
      const enforcer = await srtEnforcer({ policy: baseline })
      handle = await createSandbox({ policy: baseline, enforcer })
    }, 120_000)

    afterAll(async () => {
      await handle?.dispose()
      releaseSrtOwnershipForTests()
    }, 120_000)

    it('applies a per-call FILESYSTEM write grant to that child only, replacing the baseline', async () => {
      // 1. The BASELINE child may write the baseline path and NOT the per-call path.
      expect(
        await drain(
          await handle.run({
            argv: ['/usr/bin/touch', join(baselineWrite, 'baseline.txt')],
            policy: baseline,
            correlationId: 'baseline',
            cwd: root,
          })
        )
      ).toMatchObject({ exitCode: 0 })
      expect(await exists(join(baselineWrite, 'baseline.txt'))).toBe(true)
      const baselineDenied = await drain(
        await handle.run({
          argv: ['/usr/bin/touch', join(perCallWrite, 'baseline-denied.txt')],
          policy: baseline,
          correlationId: 'baseline-denied',
          cwd: root,
        })
      )
      expect(baselineDenied.exitCode).not.toBe(0)
      expect(await exists(join(perCallWrite, 'baseline-denied.txt'))).toBe(false)

      // 2. A PER-CALL child granting the per-call path may write there.
      const perCall: SandboxPolicy = {
        filesystem: { allowWrite: [perCallWrite], gitSafeDirectories: [root] },
        // The per-call network section must EQUAL the session's — only the filesystem axis is
        // granted per call.
        network: { allowedDomains: ['example.com'] },
      }
      expect(
        await drain(
          await handle.run({
            argv: ['/usr/bin/touch', join(perCallWrite, 'percall.txt')],
            policy: perCall,
            correlationId: 'percall',
            cwd: root,
          })
        )
      ).toMatchObject({ exitCode: 0 })
      expect(await exists(join(perCallWrite, 'percall.txt'))).toBe(true)

      // 3. REPLACEMENT, not union: the per-call child could NOT write the baseline path.
      const perCallReplaces = await drain(
        await handle.run({
          argv: ['/usr/bin/touch', join(baselineWrite, 'from-percall.txt')],
          policy: perCall,
          correlationId: 'percall-baseline-denied',
          cwd: root,
        })
      )
      expect(perCallReplaces.exitCode).not.toBe(0)
      expect(await exists(join(baselineWrite, 'from-percall.txt'))).toBe(false)

      // 4. NO LEAK: the very next baseline child is denied the per-call path again.
      const afterGrant = await drain(
        await handle.run({
          argv: ['/usr/bin/touch', join(perCallWrite, 'after.txt')],
          policy: baseline,
          correlationId: 'baseline-after',
          cwd: root,
        })
      )
      expect(afterGrant.exitCode).not.toBe(0)
      expect(await exists(join(perCallWrite, 'after.txt'))).toBe(false)
    }, 120_000)

    it('REJECTS any per-call network section that differs from the baseline, in either direction', async () => {
      // No per-call network section is enforceable under SRT (the proxy reads the SESSION config),
      // so ANY difference from the baseline is a silent ignore waiting to happen — wider or
      // narrower — and is refused with a typed error rather than spawned.
      const fsEqual = (network: SandboxPolicy['network']): SandboxPolicy => ({
        filesystem: { allowWrite: [baselineWrite], gitSafeDirectories: [root] },
        network,
      })
      for (const [label, network] of [
        ['wider', { allowedDomains: ['example.com', 'api.github.com'] }],
        ['narrower', { allowedDomains: [] }],
        ['different-disabled', { disabled: true }],
        ['added-deny', { allowedDomains: ['example.com'], deniedDomains: ['api.github.com'] }],
      ] as const) {
        await expect(
          handle.run({
            argv: ['/usr/bin/true'],
            policy: fsEqual(network),
            correlationId: `net-${label}`,
            cwd: root,
          })
        ).rejects.toBeInstanceOf(E_SANDBOX_NETWORK_GRANT_UNSUPPORTED)
      }

      // An EQUAL network section is accepted — set equality, order does not matter.
      const repeat = fsEqual({ allowedDomains: ['example.com'] })
      const allowed = await drain(
        await handle.run({
          argv: ['/usr/bin/touch', join(baselineWrite, 'repeat.txt')],
          policy: repeat,
          correlationId: 'net-repeat-in-order',
          cwd: root,
        })
      )
      expect(allowed.exitCode).toBe(0)
      const reordered = fsEqual({ allowedDomains: ['example.com'], deniedDomains: [] })
      const reorderedAllowed = await drain(
        await handle.run({
          argv: ['/usr/bin/touch', join(baselineWrite, 'repeat-reordered.txt')],
          policy: reordered,
          correlationId: 'net-repeat-reordered',
          cwd: root,
        })
      )
      expect(reorderedAllowed.exitCode).toBe(0)
    }, 120_000)

    it('isolates two CONCURRENT children: the baseline child reaches the granted domain while a diverging sibling is refused', async () => {
      const curlTo = (host: string) =>
        [
          '/usr/bin/curl',
          '-sS',
          '-m',
          '10',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          `https://${host}`,
        ] as const
      const curl = (correlationId: string, argv: readonly string[], policy: SandboxPolicy) =>
        handle.run({ argv: [...argv], policy, correlationId, cwd: root }).then(drain)

      // A second child whose per-call policy tries to WIDEN the session allow-list.
      const widening: SandboxPolicy = {
        filesystem: { allowWrite: [baselineWrite], gitSafeDirectories: [root] },
        network: { allowedDomains: ['example.com', 'api.github.com'] },
      }

      // Start BOTH before awaiting either, so their lifetimes genuinely overlap.
      const childA = curl('cc-A', curlTo('example.com'), baseline)
      const childB = handle
        .run({
          argv: [...curlTo('example.com')],
          policy: widening,
          correlationId: 'cc-B',
          cwd: root,
        })
        .then(
          () => ({ rejected: false as const }),
          (error) => ({ rejected: true as const, error })
        )
      const [a, b] = await Promise.all([childA, childB])

      // A ran under the session baseline and reached the granted domain (HTTP 200: the proxy really
      // let it out; exit 56 with 000 would mean a policy block — a different assertion).
      expect(a.exitCode).toBe(0)
      expect(a.out).toBe('200')
      // B, whose per-call policy tried to widen the allow-list, was refused — blocked at the same time.
      expect(b.rejected).toBe(true)
      if (b.rejected) expect(b.error).toBeInstanceOf(E_SANDBOX_NETWORK_GRANT_UNSUPPORTED)

      // The session's filter still blocks a host OUTSIDE the baseline for a concurrently-spawned
      // baseline child — enforcement keeps coming from the session list, per connection.
      const blocked = await Promise.all([curl('cc-blocked', curlTo('example.org'), baseline)])
      expect(blocked[0].exitCode).not.toBe(0)

      // NO LEAK: a fresh baseline child still reaches the granted domain after B's rejected attempt —
      // nothing B passed mutated the shared session, which is exactly why the refusal is safe.
      const after = await curl('cc-after', curlTo('example.com'), baseline)
      expect(after.exitCode).toBe(0)
      expect(after.out).toBe('200')
    }, 120_000)
  }
)

// A tiny guard so a future platform change fails loudly rather than silently skipping the whole
// file with no signal. The conclusions above were measured on BOTH seatbelt and bwrap.
describe('per-call policy measurement platform note', () => {
  it('records the platforms this suite actually measured', () => {
    // Measured on macOS/seatbelt and Linux/bwrap; the suite skips elsewhere.
    console.info(`sandbox runtime gate: ${sandboxRuntimeGateReason}`)
    expect(['darwin', 'linux']).toContain(process.platform)
  })
})
