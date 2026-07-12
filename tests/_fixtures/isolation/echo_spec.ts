import { event, method, resolveIsolatedServiceSpec, stream } from '@nhtio/adk/batteries/isolation'

/**
 * Shared isolated-service spec for the child_process transport's test suite. A single module used by
 * BOTH the host-side specs (`*.node.spec.ts`, importing this to type the facade / assert on method
 * names) AND the guest fixture (`echo_child.ts`, importing this to type its implementation) — so the
 * two sides can never drift out of sync with each other. Deliberately bypasses the validating
 * `defineIsolatedService` (via the pure `resolveIsolatedServiceSpec` primitive) since this is a fixed,
 * hand-checked literal with no untrusted input to validate.
 */
export const echoSpec = resolveIsolatedServiceSpec({
  name: 'echo-child-process-fixture',
  methods: {
    /** Returns `v` unchanged — used to assert round-trip fidelity of exotic values (Float32Array, Map,
     *  a function-carrying options bag) across the real child_process IPC channel. */
    echo: method<[unknown], unknown>(),
    /** Always throws `new Error(msg)` — used to assert error round-trip across the wire. */
    fail: method<[string], never>(),
    /** Calls `process.exit(code)` inside the guest — used to assert crash containment. Never resolves
     *  (the guest exits before it can reply). */
    die: method<[number], never>(),
    /** Never resolves/rejects — used to assert abort-signal plumbing on an in-flight call. */
    hang: method<[], never>({ signal: true }),
  },
  streams: {
    /** Yields `0..n-1`, emitting a `progress` event after each delta. */
    counter: stream<[number], number>(),
  },
  events: {
    /** Emitted once per delta produced by `counter`, carrying the delta's value. */
    progress: event<number>(),
  },
})
