// A tiny NODE_OPTIONS=--require preload used by wrapper.node.spec.ts to reproduce a stuck
// `waitForPendingWrites()` flush barrier (issue #42 round-2 defect #2) without any test-only env
// hook in the published wrapper source (the removed `ADK_CLAUDE_CODE_CLI_TEST_HOLD_PENDING_WRITE`).
//
// It monkey-patches `process.stdout.write` in the spawned wrapper process ONLY. The wrapper's own
// `pendingWriteCount` bookkeeping (see `writeEvent`/`trackPendingWrite` in wrapper.ts) tracks a
// write as pending until the CALLBACK it itself passed to `process.stdout.write` fires — so an
// extra, wrapper-uninvolved write this preload might otherwise make on its own would never be
// tracked at all and would not stall `waitForPendingWrites()`. Instead, this preload waits for the
// FIRST write whose payload is a wrapper-emitted `log` event — which the test below reliably
// triggers on demand by sending one malformed (non-JSON) line over the wrapper's stdin, causing its
// NDJSON command reader to call the fire-and-forget `log('trace', 'malformed-command', ...)` in
// wrapper.ts (itself a tracked `writeEvent(...)` call, exactly like every other wrapper write) —
// and passes those same bytes through to the real, unpatched `write` so the line still reaches the
// test harness, but WITHOUT the wrapper's own callback, which is captured and never invoked. Node
// only decrements `pendingWriteCount` once that callback fires, so this single write stays
// genuinely, deterministically outstanding forever: `waitForPendingWrites()` (called later, from
// `shutdownNormally`, after a real `shutdown` command arrives and `runShutdownSequence` completes)
// can never resolve on its own. That is what makes this reproducible in CI without racing real OS
// pipe backpressure — an earlier draft that tried to induce the same hang by flooding the pipe
// until the OS itself backed up was confirmed unreliable (see the in-test comment for wrapper.ts's
// own `shutdown_complete` write racing an unrelated, earlier line).
//
// A ref'd `setInterval` keeps this process's event loop alive independently, so it cannot exit for
// an unrelated reason (loop drain) before the backstop (or a bug in its ordering) decides the
// outcome.
const originalWrite = process.stdout.write.bind(process.stdout)
let armed = false
process.stdout.write = function stuckFlushPreloadWrite(chunk, encoding, callback) {
  if (typeof encoding === 'function') {
    callback = encoding
    encoding = undefined
  }
  const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  if (!armed && str.includes('"type":"log"')) {
    armed = true
    // Pass the bytes through for real (so the test harness still observes the `log` event on its
    // own stdout stream) but withhold the callback the wrapper is waiting on, forever.
    return originalWrite(chunk, encoding)
  }
  return originalWrite(chunk, encoding, callback)
}

setInterval(() => {}, 1_000)
