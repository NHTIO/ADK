// A tiny NODE_OPTIONS=--require preload used by wrapper.node.spec.ts to reproduce a
// non-draining event loop in an otherwise plain Node host (issue #42, part A) — the same
// symptom an Electron main process exhibits (an open BrowserWindow, a live timer, an open
// server socket the HOST itself owns, all outside this wrapper's own control) without actually
// needing a real Electron binary in CI. A bare `setInterval` that never fires a callback which
// clears it keeps Node's event loop alive forever on its own, exactly modelling "something else
// is keeping the loop alive that this wrapper does not own" — the condition `shutdownNormally`'s
// own explicit `process.exit(0)` (not a bare fall-off-the-end-of-main) exists to survive.
setInterval(() => {}, 1_000)
