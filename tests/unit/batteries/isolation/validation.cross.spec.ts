import { describe, expect, it } from 'vitest'
import {
  createIsolatedService,
  defineIsolatedService,
  E_INVALID_ISOLATION_OPTIONS,
  method,
  serveIsolatedOverPort,
  stream,
  type IsolationTransport,
  type PortLike,
} from '@nhtio/adk/batteries/isolation'

/** A transport whose methods must never actually be invoked in these tests — validation of a bad
 *  options bag always throws BEFORE `createIsolatedService` ever touches the transport. */
const uncalledTransport = (): IsolationTransport => ({
  connect: () => {
    throw new Error('transport.connect() should never be called — validation must throw first')
  },
  terminate: () => {
    throw new Error('transport.terminate() should never be called')
  },
  onCrash: () => {
    throw new Error('transport.onCrash() should never be called')
  },
})

/** A port whose methods must never actually be invoked — same reasoning as `uncalledTransport`, for
 *  `serveIsolatedOverPort`'s options validation. */
const uncalledPort = (): PortLike => ({
  post: () => {
    throw new Error('port.post() should never be called — validation must throw first')
  },
  onMessage: () => {
    throw new Error('port.onMessage() should never be called — validation must throw first')
  },
})

describe('defineIsolatedService() — spec input validation', () => {
  it('accepts a minimal valid spec ({ name } only)', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(spec.name).toBe('svc')
    expect(spec.methods).toEqual({})
    expect(spec.streams).toEqual({})
    expect(spec.events).toEqual({})
  })

  it('accepts a fully-populated spec and resolves it', () => {
    const spec = defineIsolatedService({
      name: 'svc',
      methods: { add: method<[number, number], number>() },
      streams: { ticks: stream<[], number>() },
    })
    expect(Object.keys(spec.methods)).toEqual(['add'])
    expect(Object.keys(spec.streams)).toEqual(['ticks'])
  })

  it('throws E_INVALID_ISOLATION_OPTIONS on an empty name', () => {
    expect(() => defineIsolatedService({ name: '' })).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when `name` is missing', () => {
    expect(() => defineIsolatedService({} as unknown as { name: string })).toThrow(
      E_INVALID_ISOLATION_OPTIONS
    )
  })

  it('throws E_INVALID_ISOLATION_OPTIONS on an unknown top-level key', () => {
    expect(() => defineIsolatedService({ name: 'svc', bogus: true } as never)).toThrow(
      E_INVALID_ISOLATION_OPTIONS
    )
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when a name collides across methods/streams', () => {
    expect(() =>
      defineIsolatedService({
        name: 'svc',
        methods: { dup: method<[], void>() },
        streams: { dup: stream<[], void>() },
      })
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when a name collides across methods/events', () => {
    expect(() =>
      defineIsolatedService({
        name: 'svc',
        methods: { dup: method<[], void>() },
        events: { dup: { kind: 'event' } as never },
      })
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })
})

describe('createIsolatedService() — host options validation', () => {
  it('throws E_INVALID_ISOLATION_OPTIONS on an unknown option key', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() =>
      createIsolatedService(spec, uncalledTransport(), { bogus: true } as never)
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })

  it('throws E_INVALID_ISOLATION_OPTIONS on a non-positive readyTimeoutMs', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() => createIsolatedService(spec, uncalledTransport(), { readyTimeoutMs: -1 })).toThrow(
      E_INVALID_ISOLATION_OPTIONS
    )
  })

  it('throws E_INVALID_ISOLATION_OPTIONS on a non-positive disposeGraceMs', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() => createIsolatedService(spec, uncalledTransport(), { disposeGraceMs: 0 })).toThrow(
      E_INVALID_ISOLATION_OPTIONS
    )
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when autoRespawn.policy is not a policy-shaped object', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() =>
      createIsolatedService(spec, uncalledTransport(), {
        autoRespawn: { policy: {} as never },
      })
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })
})

describe('serveIsolatedOverPort() — serve options validation', () => {
  it('throws E_INVALID_ISOLATION_OPTIONS on an unknown option key', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() =>
      serveIsolatedOverPort(spec, () => ({}) as never, uncalledPort(), { bogus: true } as never)
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when `encodables` is not an array of functions', () => {
    const spec = defineIsolatedService({ name: 'svc' })
    expect(() =>
      serveIsolatedOverPort(spec, () => ({}) as never, uncalledPort(), {
        encodables: ['not-a-class'] as never,
      })
    ).toThrow(E_INVALID_ISOLATION_OPTIONS)
  })
})
