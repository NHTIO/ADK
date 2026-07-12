import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  event,
  method,
  resolveIsolatedServiceSpec,
  stream,
  type IsolatedFacade,
  type IsolatedImplementation,
  type IsolationCallContext,
  type IsolatedServiceSpec,
  type StreamHandle,
} from '@nhtio/adk/batteries/isolation'

describe('method()', () => {
  it('returns a method descriptor stamped with kind: "method"', () => {
    const d = method<[string], number>()
    expect(d.kind).toBe('method')
  })

  it('passes through `signal` and `codec` runtime options', () => {
    const d = method<[string], number>({ signal: true, codec: 'raw' })
    expect(d.signal).toBe(true)
    expect(d.codec).toBe('raw')
  })

  it('defaults `signal`/`codec` to undefined when omitted', () => {
    const d = method<[string], number>()
    expect(d.signal).toBeUndefined()
    expect(d.codec).toBeUndefined()
  })

  it('never assigns the phantom __args/__result fields at runtime', () => {
    const d = method<[string], number>()
    expect(d.__args).toBeUndefined()
    expect(d.__result).toBeUndefined()
  })
})

describe('stream()', () => {
  it('returns a stream descriptor stamped with kind: "stream"', () => {
    const d = stream<[string], number>()
    expect(d.kind).toBe('stream')
  })

  it('passes through the `codec` runtime option', () => {
    const d = stream<[string], number>({ codec: 'encoded' })
    expect(d.codec).toBe('encoded')
  })

  it('never assigns the phantom __args/__delta fields at runtime', () => {
    const d = stream<[string], number>()
    expect(d.__args).toBeUndefined()
    expect(d.__delta).toBeUndefined()
  })
})

describe('event()', () => {
  it('returns an event descriptor stamped with kind: "event"', () => {
    const d = event<{ progress: number }>()
    expect(d.kind).toBe('event')
  })

  it('never assigns the phantom __payload field at runtime', () => {
    const d = event<{ progress: number }>()
    expect(d.__payload).toBeUndefined()
  })
})

describe('resolveIsolatedServiceSpec()', () => {
  it('fills in {} defaults for omitted methods/streams/events', () => {
    const spec = resolveIsolatedServiceSpec({ name: 'svc' })
    expect(spec.name).toBe('svc')
    expect(spec.methods).toEqual({})
    expect(spec.streams).toEqual({})
    expect(spec.events).toEqual({})
  })

  it('is pure: passes declared methods/streams/events through untouched', () => {
    const methods = { add: method<[number, number], number>() }
    const streams = { ticks: stream<[], number>() }
    const events = { progress: event<number>() }
    const spec = resolveIsolatedServiceSpec({ name: 'svc', methods, streams, events })
    expect(spec.methods).toBe(methods)
    expect(spec.streams).toBe(streams)
    expect(spec.events).toBe(events)
  })

  it('performs NO validation — an empty name is passed through as-is', () => {
    const spec = resolveIsolatedServiceSpec({ name: '' })
    expect(spec.name).toBe('')
  })

  it('performs NO validation — a name colliding across methods/streams is passed through as-is', () => {
    const spec = resolveIsolatedServiceSpec({
      name: 'svc',
      methods: { dup: method<[], void>() },
      streams: { dup: stream<[], void>() },
    })
    expect(spec.methods.dup.kind).toBe('method')
    expect(spec.streams.dup.kind).toBe('stream')
  })
})

// ── Mapped facade / implementation types (type-level only — no runtime assertions) ────────────────────

const exampleSpec = resolveIsolatedServiceSpec({
  name: 'example',
  methods: {
    add: method<[number, number], number>(),
    cancellable: method<[string], string>({ signal: true }),
  },
  streams: {
    ticks: stream<[intervalMs: number], number>(),
  },
  events: {
    progress: event<{ pct: number }>(),
  },
})
type ExampleSpec = IsolatedServiceSpec<
  (typeof exampleSpec)['methods'],
  (typeof exampleSpec)['streams'],
  (typeof exampleSpec)['events']
>

describe('IsolatedFacade<S> (type-level)', () => {
  it("recovers a method's argument tuple + Promise<result> return type", () => {
    expectTypeOf<IsolatedFacade<ExampleSpec>['add']>().toEqualTypeOf<
      (a: number, b: number, signal?: AbortSignal) => Promise<number>
    >()
  })

  it('accepts an optional trailing AbortSignal uniformly regardless of `signal` opt-in', () => {
    expectTypeOf<IsolatedFacade<ExampleSpec>['add']>()
      .parameter(2)
      .toEqualTypeOf<AbortSignal | undefined>()
    expectTypeOf<IsolatedFacade<ExampleSpec>['cancellable']>()
      .parameter(1)
      .toEqualTypeOf<AbortSignal | undefined>()
  })

  it("recovers a stream's argument tuple + synchronous ReadableStream<delta> return type", () => {
    expectTypeOf<IsolatedFacade<ExampleSpec>['ticks']>().toEqualTypeOf<
      (intervalMs: number) => ReadableStream<number>
    >()
  })
})

describe('IsolatedImplementation<S> (type-level)', () => {
  it('every method implementation accepts an optional trailing IsolationCallContext uniformly, regardless of whether the descriptor declared { signal: true } (a deliberate typing simplification — see IsolatedImplementation remarks in types.ts; at runtime the context is only ever constructed/forwarded for methods declaring { signal: true })', () => {
    expectTypeOf<IsolatedImplementation<ExampleSpec>['add']>().parameters.toEqualTypeOf<
      [number, number, IsolationCallContext?]
    >()
    expectTypeOf<IsolatedImplementation<ExampleSpec>['cancellable']>().parameters.toEqualTypeOf<
      [string, IsolationCallContext?]
    >()
  })

  it('a stream implementation always takes a trailing StreamHandle', () => {
    expectTypeOf<IsolatedImplementation<ExampleSpec>['ticks']>().parameters.toEqualTypeOf<
      [number, StreamHandle]
    >()
  })

  it('a stream implementation may return a ReadableStream<D> or AsyncIterable<D>', () => {
    expectTypeOf<ReturnType<IsolatedImplementation<ExampleSpec>['ticks']>>().toEqualTypeOf<
      ReadableStream<number> | AsyncIterable<number>
    >()
  })
})
