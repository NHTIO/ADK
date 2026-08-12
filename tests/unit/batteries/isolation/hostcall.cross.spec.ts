import { describe, expect, it } from 'vitest'
import {
  GuestEndpoint,
  HostEndpoint,
  measureHostcallBytes,
} from '../../../../src/batteries/isolation/protocol'
import type { PortLike } from '../../../../src/batteries/isolation/types'

const pair = (): [PortLike, PortLike] => {
  const a = new Set<(m: unknown) => void>()
  const b = new Set<(m: unknown) => void>()
  return [
    {
      post: (m) => queueMicrotask(() => b.forEach((f) => f(m))),
      onMessage: (f) => (a.add(f), () => a.delete(f)),
    },
    {
      post: (m) => queueMicrotask(() => a.forEach((f) => f(m))),
      onMessage: (f) => (b.add(f), () => b.delete(f)),
    },
  ]
}
const raw = (v: unknown) => ({ enc: 'raw' as const, v })
const flush = () => new Promise<void>((r) => setTimeout(r, 5))

describe('isolation hostcall RPC (B0)', () => {
  it('leaves a guest that never hostcalls byte-identical', async () => {
    const [hostPort, guestPort] = pair()
    const sent: unknown[] = []
    const original = guestPort.post
    guestPort.post = (m: unknown) => {
      sent.push(m)
      original(m)
    }
    const host = new HostEndpoint(hostPort)
    const guest = new GuestEndpoint(guestPort)
    guest.ready(false)
    await flush()
    expect(sent).toEqual([{ t: 'ready', encoderAvailable: false }])
    host.terminate('done')
    guest.terminate('done')
  })

  it('refuses unknown methods and does not charge them', async () => {
    const [hp, gp] = pair()
    let calls = 0
    const host = new HostEndpoint(
      hp,
      {},
      {
        handlers: new Map([
          [
            'known',
            () => {
              calls++
              return raw('ok')
            },
          ],
        ]),
        quotas: { hostcallTimeoutMs: 20, maxHostcallsPerEvaluation: 1, maxConcurrentHostcalls: 1 },
      }
    )
    const guest = new GuestEndpoint(gp)
    await expect(guest.hostcall('unknown', [], 4096).promise).rejects.toThrow('Unknown host method')
    await expect(guest.hostcall('known', [], 4096).promise).resolves.toEqual(raw('ok'))
    expect(calls).toBe(1)
    host.terminate('done')
    guest.terminate('done')
  })

  it('fails quota exhaustion rather than queueing', async () => {
    const [hp, gp] = pair()
    let release!: () => void
    const host = new HostEndpoint(
      hp,
      {},
      {
        handlers: new Map([
          [
            'hold',
            () =>
              new Promise((r) => {
                release = () => r(raw('done'))
              }),
          ],
        ]),
        quotas: { hostcallTimeoutMs: 100, maxHostcallsPerEvaluation: 1, maxConcurrentHostcalls: 1 },
      }
    )
    const guest = new GuestEndpoint(gp)
    const first = guest.hostcall('hold', [], 4096).promise
    await flush()
    await expect(guest.hostcall('hold', [], 4096).promise).rejects.toThrow('quota')
    release()
    await expect(first).resolves.toEqual(raw('done'))
    host.terminate('done')
    guest.terminate('done')
  })

  it('rejects an over-cap argument before posting it', async () => {
    const [hp, gp] = pair()
    const received: unknown[] = []
    hp.onMessage((m) => received.push(m))
    const guest = new GuestEndpoint(gp)
    await expect(guest.hostcall('x', [raw('x'.repeat(100))], 10).promise).rejects.toThrow(
      'byte limit'
    )
    await flush()
    expect(received).toEqual([])
    guest.terminate('done')
  })

  it('returns exactly too-many-bytes for an over-cap host result', async () => {
    const [hp, gp] = pair()
    const host = new HostEndpoint(
      hp,
      {},
      { handlers: new Map([['big', () => raw('x'.repeat(100))]]), maxHostcallBytes: 20 }
    )
    const guest = new GuestEndpoint(gp)
    await expect(guest.hostcall('big', [], 1000).promise).rejects.toThrow('too-many-bytes')
    host.terminate('done')
    guest.terminate('done')
  })

  it('drops a late result after termination', async () => {
    const [hp, gp] = pair()
    const host = new HostEndpoint(hp)
    const guest = new GuestEndpoint(gp)
    const pending = guest.hostcall('late', [], 4096).promise
    guest.terminate('terminated')
    hp.post({ t: 'hostresult', id: 'hlate', ok: true, value: raw('late') })
    await expect(pending).rejects.toThrow('terminated')
    await flush()
    host.terminate('done')
  })

  it('uses independent deadlines and does not abort capability work', async () => {
    const [hp, gp] = pair()
    let signalAborted = false
    let capabilitySignal!: AbortSignal
    let release!: () => void
    const host = new HostEndpoint(
      hp,
      {},
      {
        handlers: new Map([
          [
            'slow',
            (_args, signal) => {
              capabilitySignal = signal
              signal.addEventListener('abort', () => {
                signalAborted = true
              })
              return new Promise((r) => {
                release = () => r(raw('late'))
              })
            },
          ],
        ]),
        quotas: { hostcallTimeoutMs: 10, maxHostcallsPerEvaluation: 2, maxConcurrentHostcalls: 1 },
      }
    )
    const guest = new GuestEndpoint(gp)
    const p = guest.hostcall('slow', [], 4096).promise
    await expect(p).rejects.toThrow('timed out')
    expect(capabilitySignal.aborted).toBe(false)
    expect(signalAborted).toBe(false)
    release()
    await flush()
    host.terminate('done')
    guest.terminate('done')
  })

  it('measures UTF-8 bytes, not character count', () => {
    expect(measureHostcallBytes('😀')).toBeGreaterThan(measureHostcallBytes('a'))
  })
})
