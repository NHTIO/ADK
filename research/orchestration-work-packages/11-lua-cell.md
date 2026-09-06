# WP 11 — the Lua predicate cell (NODE-ONLY) and the runaway-CPU watchdog

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — the *Lua cell* paragraph,
**"Why not JavaScript"**, and **"The runaway-CPU solution already exists — CCRA's worker-thread
watchdog"**. That last section is the design; follow it rather than inventing one.

Depends on WP 03 (implement the `PredicateEvaluator` seam; do not redefine it).

**The `wasmoon` and `fengari` optional peers are already in `package.json`** (WP 01 landed every
peer entry up front so you and WP 10 never edit that file concurrently). **Do not touch
`package.json`, `pnpm-lock.yaml`, or `vite.config.mts`.**

This cell ships only when its isolation suite passes — that is the entry criterion, not a nicety.

## Owns

- `src/batteries/orchestration/cells/lua/**` — `@module .../orchestration/cells/lua`
- the watchdog
- `tests/unit/batteries/orchestration/cells_lua.node.spec.ts`

## NODE-ONLY, and it must be structural

The watchdog needs `node:worker_threads`, `node:process` and `SIGKILL`. Follow the repo's existing
convention exactly — read `src/batteries/isolation/index.ts:22-28` and
`src/batteries/isolation/child_process/index.ts:8-13`:

- the cell lives at its own subpath and is **never** re-exported from the orchestration barrel, so
  the barrel stays environment-neutral with **zero `node:*` anywhere in its module graph** and
  isomorphic code can import it
- its module doc carries the same **Node-only** warning, in the same words
- its tests are `*.node.spec.ts` only

## Contract

`createLuaCell(options?): PredicateEvaluator`, `id: 'lua'`. `load()` lazily imports `wasmoon` and
throws `E_ORCH_CELL_UNAVAILABLE` naming the package; idempotent.

## Three enforcement layers — this is the cell for genuinely untrusted predicates

1. **The count hook** (`debug.sethook` / `lua_sethook`) fires every N VM instructions and can
   raise, interrupting a bare `while true do end` **from inside the VM** before the budget is
   spent. Mozilla's `lua_sandbox` ships this as `instruction_limit`, default 1,000,000.
2. **The allocator cap** (`lua_Alloc`) bounds memory that no timer can bound.
3. **The watchdog SIGKILLs** whatever the first two cannot reach.

Environment is built by **allowlist, never blacklist**: `load(chunk, name, 't', env)` with mode
`'t'` to reject precompiled bytecode (the bytecode verifier is **not** a security boundary), and no
`_G`, `getfenv`, `getmetatable`, `load`, `dofile`, `io`, `os`.

**Probe the hook and allocator before trusting them.** They are documented at the Lua C API level
and wasmoon's README documents neither, so its TypeScript surface may not expose them — verify
against wasmoon's `.d.ts` before committing to a reach-through to raw WASM exports. At construction,
probe the entry points and verify each against a **known-good canary** (a script that must be
interrupted; an allocation that must be refused) before trusting it, and **fall back to
watchdog-only if either probe fails** — reporting the reduced guarantee rather than claiming it.
A wasmoon update that changes that undocumented surface must degrade the cell, never break it.

## The watchdog — CCRA MR !27, adopted verbatim

Five details, each load-bearing and each cost a failed design to find:

1. **A main-thread timer cannot do this job.** Measured: a tight `while(true){}` starves
   `setTimeout`, `process.nextTick`, `queueMicrotask` **and** `setImmediate` alike. Only a separate
   event loop keeps time.
2. **The worker must `SIGKILL` the shared process**, not call `process.exit()` — a worker-local exit
   ends only the worker.
3. **`worker.unref()` is load-bearing** — without it the watchdog keeps a *successful* run alive.
4. **The expired-deadline check must be synchronous and before the first import.** Arming a zero-ms
   worker does not stop the main thread reaching `await import()` before that worker is scheduled.
5. **An absolute deadline epoch, one shared origin** for the guest watchdog and any host backstop,
   so ordering holds however long wrapping takes. Also: an undrained pipe wedges a child, so merge
   stdout/stderr into one synchronous `writeSync`-loop sink — `process.exit()` cannot truncate it.

Residual to state honestly: the sandbox battery's `run()` exposes no kill handle (ADK issue #17),
so the guest's own watchdog **is** the bound. That is exactly why the watchdog belongs inside this
cell rather than deferred to the sandbox battery. The four open sandbox issues (#17–#20) are **not**
in scope — consume what exists, route around what does not.

`fengari` is the fallback if WASM is unavailable (pure JS, smaller, ~25× slower) — but it **shares
the host heap**, so document it as the weaker boundary rather than offering it as an equal.

Cross-cutting (WP 03): plain-data context, no clock, no randomness unless injected.

## Done when

**Run ALL THREE gates before reporting done** — behaviour and `tsc` alone are not enough (WP 01
was committed twice on that mistake, and lint then reported 112 errors):

```bash
npx eslint src/batteries/orchestration --ext .ts     # 0 errors, incl. the repo's own adk/* rules
npx tsc --noEmit -p tsconfig.json | grep orchestration
pnpm doc:coverage                                     # 0 undocumented public symbols, MEMBERS included
```

`doc:coverage` counts public CLASS FIELDS, CONSTRUCTORS and INTERFACE MEMBERS, not just the
declaration — document those too. And prefer `npx eslint`/`npx tsc` over the `pnpm` scripts while a
worktree is installing; the pnpm wrappers can take many minutes.

- `pnpm type-check`, `pnpm lint`, `pnpm doc:coverage:ci` clean for your files
- **`cells_lua.node.spec.ts` fails when isolation breaks** — the entry criterion. It must cover:
  `while true do end` interrupted by the count hook; allocation bounded by the allocator cap; the
  watchdog SIGKILLing a CPU-bound guest with the child gone (CCRA's own assertion —
  `expect(result.signal).toBe('SIGKILL')`, with a **2s test-level guard so a broken watchdog fails
  loudly instead of hanging the suite**); each of `_G`, `getfenv`, `getmetatable`, `load`, `dofile`,
  `io`, `os` absent; precompiled bytecode rejected because mode is `'t'`; no clock or randomness
  unless injected; the construction-time probes and the watchdog-only fallback path
- Include CCRA's **sabotage test** — move the watchdog to the main thread and assert the suite
  fails — so the mechanism's own necessity is covered

## Out of scope

The jexl cell (WP 10). The seam (WP 03). Fixing sandbox issues #17–#20. Any barrel re-export of
this cell — that would break the barrel's environment neutrality.
