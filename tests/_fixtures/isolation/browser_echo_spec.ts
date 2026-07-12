import { event, method, resolveIsolatedServiceSpec, stream } from '@nhtio/adk/batteries/isolation'

/**
 * Shared isolated-service spec for the browser Worker transport's test suite (WP2). A single module
 * used by BOTH the host-side specs (`*.browser.spec.ts`, importing this to type the facade) AND the
 * guest fixture (`browser_echo_worker.ts`, importing this to type its implementation) — so the two
 * sides can never drift out of sync. Deliberately its own module (not WP3's `echo_spec.ts`) to avoid
 * coupling WP2's browser tests to WP3's node-only fixture. Bypasses the validating
 * `defineIsolatedService` (via the pure `resolveIsolatedServiceSpec` primitive) since this is a fixed,
 * hand-checked literal with no untrusted input to validate.
 */
export const browserEchoSpec = resolveIsolatedServiceSpec({
  name: 'browser-echo-worker-fixture',
  methods: {
    /** Returns `v` unchanged — used to assert round-trip fidelity across a real `postMessage` boundary. */
    echo: method<[unknown], unknown>(),
    /** Always throws `new Error(msg)` — used to assert error round-trip across the wire. */
    fail: method<[string], never>(),
    /** Never resolves/rejects on its own; rejects once the host's abort signal fires — used to assert
     *  abort-signal plumbing over a real Worker. */
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
