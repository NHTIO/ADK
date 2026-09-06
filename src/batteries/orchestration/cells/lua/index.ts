/**
 * The Lua predicate cell — an untrusted-script evaluator for `branch` and `select` nodes.
 *
 * @module @nhtio/adk/batteries/orchestration/cells/lua
 *
 * **Node-only.** This subpath imports `node:worker_threads` and `node:process` directly and will
 * not load in a browser or Web Worker bundle — deliberately, unlike the environment-neutral
 * orchestration barrel, which carries zero `node:*` imports anywhere in its module graph so it
 * can be imported from isomorphic code. Never re-export it from that barrel.
 *
 * The predicate for this cell is a SOURCE STRING (a Lua expression or statement list) read from
 * the node's `predicate` field. `validate()` refuses a non-string and loads the chunk so a syntax
 * error surfaces at freeze rather than at run time. `evaluate()` compiles the chunk in text mode
 * only (precompiled bytecode is refused — the Lua bytecode verifier is not a security boundary),
 * injects the marshalled context, and interprets the result as a branch verdict
 * (`{kind:'branch', matched}`) or a select verdict (`{kind:'select', caseLabel}`).
 *
 * ## Three enforcement layers
 *
 * 1. **Instruction-count hook.** A Lua count hook is installed via `lua_sethook` and fires every
 *    `instructionLimit` VM instructions (default 1,000,000). On each firing it raises a Lua error,
 *    which the VM turns into an interrupted `pcall` — this stops `while true do end` from *inside*
 *    the VM, which no host-side timer can do. The hook is the only thing that can break a tight
 *    Lua loop because Lua runs synchronously on the host thread.
 * 2. **Allocator cap (enforced by wasmoon).** `engine.global.setMemoryMax(memoryCeilingBytes)` is
 *    a REAL allocator cap: wasmoon installs a custom `lua_Alloc` when the engine is built with
 *    `traceAllocations: true`, and that allocator REFUSES any growing realloc whose end size would
 *    exceed `memoryMax`, returning `NULL` so the VM raises `LUA_ERRMEM` ("not enough memory").
 *    `traceAllocations: true` is REQUIRED for the cap to exist — without it `setMemoryMax`/
 *    `getMemoryUsed` throw "Memory allocations is not being traced" — so the engine is always
 *    built with that flag. `getMemoryUsed()` (typed surface: `getMemoryUsed`; there is no
 *    `getMemoryUse`) reports bytes allocated under the same flag, and is kept as a SECONDARY
 *    signal: the count hook polls it and raises a clean, named, model-addressed
 *    `MEMORY_CEILING_EXCEEDED` error naming the ceiling BEFORE the allocator's hard failure can
 *    fire, so the common case produces a friendly named abort rather than a raw "not enough
 *    memory". The poll is secondary, NOT the enforcement: the cap is what actually refuses
 *    allocation; the poll only wins the race when it gets a firing between the overshoot start
 *    and the cap's refusal. An overshoot that beats the poll still hits the hard cap, and the
 *    host catches that too and converts it to the same named failure (see layer 3 of the abort
 *    handling in `evaluate`), so a raw "not enough memory" never propagates.
 * 3. **Worker-thread watchdog.** The outer bound. A main-thread timer cannot do this job, because
 *    a tight Lua loop starves `setTimeout`, `nextTick`, `queueMicrotask` and `setImmediate` alike
 *    — only a separate event loop keeps time. The watchdog runs in a `worker_threads` Worker and,
 *    on expiry, `process.kill(pid, 'SIGKILL')`s the SHARED process (not `process.exit()`, which
 *    ends only the worker). Five load-bearing details, all required:
 *      - a main-thread timer cannot keep time during a tight loop (above);
 *      - the worker kills the SHARED process via `process.kill(pid, 'SIGKILL')`, never
 *        `worker.terminate()`-or-`process.exit()` semantics, because only killing the host
 *        process actually breaks a synchronous VM loop that owns the main thread;
 *      - `worker.unref()` is called or a successful run keeps the worker alive and the process
 *        never exits;
 *      - the expired-deadline check is SYNCHRONOUS and runs BEFORE the first `await import()` of
 *        wasmoon, so a process that started past its deadline refuses before doing any work;
 *      - one absolute deadline epoch (`Date.now() + timeoutMs`) is shared between the host and the
 *        watchdog so the two cannot disagree about when "expired" is.
 *
 * ## Reduced guarantee
 *
 * At construction the hook and the allocator cap are probed against a canary. The cap probe is
 * POSITIVE: it builds a throwaway engine, calls `setMemoryMax` with a DELIBERATELY TINY ceiling,
 * runs a bounded chunk that allocates a lot, and confirms the allocator actually REFUSES the
 * allocation (throws). Only when that refusal is observed is layer 2 claimed. If the probe fails
 * (the WASM module refused `addFunction`, `setMemoryMax` did not gate allocation, `traceAllocations`
 * produced no stats, etc.), the cell falls back to watchdog-only enforcement and REPORTS the
 * reduced guarantee through the `guarantee` field rather than claiming a hook/memory bound it
 * cannot deliver. A successful run under a reduced guarantee is still correct; it is merely less
 * protected against a runaway script.
 *
 * ## Sandbox surface
 *
 * The engine is built by ALLOWLIST with `openStandardLibs: false`, so no standard library is
 * present until explicitly injected. The following are NEVER injected and are absent by
 * construction: `_G`, `getfenv`, `getmetatable`, `load`, `dofile`, `io`, `os`. No clock and no
 * randomness are injected unless a future caller extends this cell. A predicate that reaches for
 * any of these fails at runtime with an "unknown global" error, which the cell surfaces as a
 * `{kind:'select', caseLabel: null}` (default) or `{kind:'branch', matched: false}` verdict
 * rather than as a thrown host exception — a predicate is never allowed to crash the run.
 *
 * The test that confirms the watchdog actually kills the process on a `while true do end` loop is
 * NOT run here: it would SIGKILL this process. It is described in the module-level TSDoc on
 * `createLuaCell` and lives in a separate, opt-in test harness that spawns a child process.
 */

import { loadOnce } from '../../predicates'
import { isInstanceOf, isObject } from '../../../../lib/utils/guards'
import type {
  BranchNodeDefinition,
  NodeOutput,
  OutputItem,
  PlanNode,
  PredicateContext,
  PredicateEvaluator,
  PredicateVerdict,
  SelectNodeDefinition,
} from '../../types'

// ── wasmoon surface (typed; loaded lazily) ───────────────────────────────────
//
// These are declared locally rather than imported at top level because wasmoon is an OPTIONAL
// peer and must not be required to resolve when this module is merely imported by the
// environment-neutral barrel's type checker. `load()` is the only place `await import('wasmoon')`
// runs, and `loadOnce` maps a failure there to `E_ORCH_CELL_UNAVAILABLE`.
//
// The shapes below are checked against the installed `node_modules/wasmoon/dist/*.d.ts`:
//   · `LuaFactory().createEngine(options)` → `LuaEngine`
//   · `engine.global` : `Global` (extends `Thread`), exposing `getMemoryUsed()`, `setMemoryMax()`,
//     `loadString`, `run`, `runSync`, `getTop`, `pop`, `pushValue`, `getValue`, `setField`,
//     `createtable`-via-`lua_createtable`, and (through `Thread`) `readonly address: LuaState`
//     and `readonly lua: LuaWasm`.
//   · `LuaWasm` exposes `lua_sethook(L, func, mask, count)` and `module.addFunction(fn, sig)` /
//     `module.removeFunction(ptr)` — the count-hook primitive the enforcement layers depend on.
//   · `LuaEventMasks.Count === 8`.
//
// Layer 2 needs `traceAllocations: true`: wasmoon installs its custom `lua_Alloc` (the cap) ONLY
// under that flag, and both `getMemoryUsed()` and `setMemoryMax()` THROW "Memory allocations is
// not being traced" without it. So the engine is ALWAYS built with `traceAllocations: true`, the
// cap is set via `setMemoryMax(memoryCeilingBytes)`, and the canary probe positively confirms the
// cap refuses a large allocation under a tiny ceiling before layer 2 is claimed.
interface WasmoonLuaWasmModule {
  addFunction(fn: (...args: number[]) => void, signature: string): number
  removeFunction(ptr: number): void
}
interface WasmoonLuaWasm {
  lua_sethook: (L: number, func: number | null, mask: number, count: number) => void
  lua_error: (L: number) => number
  readonly module: WasmoonLuaWasmModule
}
interface WasmoonThread {
  readonly address: number
  readonly lua: WasmoonLuaWasm
  loadString(luaCode: string, name?: string): void
  run(argCount?: number): Promise<unknown[]>
  runSync(argCount?: number): unknown[]
  getTop(): number
  pop(count?: number): void
  pushValue(value: unknown): void
  getValue(index: number): unknown
  setField(index: number, name: string, value: unknown): void
  close(): void
}
interface WasmoonGlobal extends WasmoonThread {
  get(name: string): unknown
  set(name: string, value: unknown): void
  getMemoryUsed(): number
  setMemoryMax(max: number | undefined): void
}
interface WasmoonLuaEngine {
  global: WasmoonGlobal
  close(): void
}
interface WasmoonLuaFactory {
  createEngine(options?: {
    openStandardLibs?: boolean
    injectObjects?: boolean
    enableProxy?: boolean
    traceAllocations?: boolean
    functionTimeout?: number
  }): Promise<WasmoonLuaEngine>
}
type WasmoonModule = {
  LuaFactory: new (customWasmUri?: string) => WasmoonLuaFactory
  LuaEventMasks: { Count: number }
}

const LUA_EVENT_MASK_COUNT = 8 // LuaEventMasks.Count in wasmoon; verified against dist/index.js

// ── defaults ────────────────────────────────────────────────────────────────
/** Default instruction budget before the count hook raises. */
const DEFAULT_INSTRUCTION_LIMIT = 1_000_000
/** Default memory ceiling in bytes for the allocator cap (and the secondary poll). */
const DEFAULT_MEMORY_CEILING_BYTES = 64 * 1024 * 1024 // 64 MiB
/** Default wall-clock timeout before the watchdog SIGKILLs the shared process. */
const DEFAULT_TIMEOUT_MS = 5_000

// ── errors ──────────────────────────────────────────────────────────────────
/**
 * The stable code prefix for an out-of-memory abort. The full model-addressed message is built by
 * {@link memoryCeilingMessage} and names the ceiling in bytes, e.g.
 * `"lua-cell: memory ceiling exceeded (65536 bytes)"`. The count hook raises this as a Lua error
 * (via the secondary `getMemoryUsed` poll) BEFORE the allocator's hard `LUA_ERRMEM` ("not enough
 * memory") fires whenever the poll wins the race; if the allocator wins instead, the host catch
 * converts the raw error into this same named failure so a raw "not enough memory" never
 * propagates out of the cell. Surfaced to the model as a clean, named abort (via the executor's
 * `node_failed`/handled-error edge), NOT as a raw wasmoon error.
 */
const MEMORY_CEILING_EXCEEDED = 'lua-cell: memory ceiling exceeded'
/**
 * Build the full model-addressed out-of-memory message naming the ceiling in bytes.
 */
const memoryCeilingMessage = (ceilingBytes: number): string =>
  `${MEMORY_CEILING_EXCEEDED} (${ceilingBytes} bytes)`
/**
 * Raised inside the VM (by the count hook) when the instruction budget or the wall-clock deadline
 * is exceeded. It crosses the `pcall` boundary as a Lua error and is caught by the host, which
 * converts it to a safe verdict.
 */
const INSTRUCTION_BUDGET_EXCEEDED = 'lua-cell: instruction budget exceeded'
const DEADLINE_EXCEEDED = 'lua-cell: wall-clock deadline exceeded'

/**
 * The enforcement guarantee a cell instance is actually delivering, probed at construction.
 *
 * `full` means the count hook and the allocator cap both work. `watchdog-only` means one or both
 * probes failed and only the worker-thread watchdog remains. This is REPORTED, never claimed: a
 * cell that cannot install a hook or whose `setMemoryMax` does not gate allocation does not
 * pretend it did.
 */
export type LuaCellGuarantee = 'full' | 'watchdog-only'

/**
 * The options accepted by {@link createLuaCell}. All optional; every field has a safe default.
 */
export interface CreateLuaCellOptions {
  /**
   * The number of VM instructions between count-hook firings. Default 1,000,000. Lowering this
   * tightens the instruction budget AND the secondary memory poll's latency (the poll runs inside
   * the hook and raises the named abort before the allocator's hard failure), at the cost of more
   * hook overhead. The hook is what stops `while true do end` from inside the VM.
   */
  readonly instructionLimit?: number
  /**
   * The memory ceiling in bytes, ENFORCED by wasmoon's allocator cap (`setMemoryMax`). Default
   * 64 MiB. The allocator refuses any growing realloc whose end size would exceed this. A
   * secondary `getMemoryUsed` poll inside the count hook raises a clean named abort before the
   * hard failure when it gets a firing first; an overshoot that beats the poll still hits the
   * hard cap, and the host converts that to the same named failure.
   */
  readonly memoryCeilingBytes?: number
  /**
   * The wall-clock timeout in milliseconds before the worker-thread watchdog SIGKILLs the shared
   * process. Default 5,000. This is the OUTER bound; the count hook is the inner one.
   */
  readonly timeoutMs?: number
}

/**
 * Inspectable runtime status of a Lua cell instance: which enforcement layers are live and which
 * were probed away at construction. Exposed for diagnostics and for tests that need to assert the
 * guarantee without triggering a runaway script.
 */
export interface LuaCellStatus {
  /** The enforcement guarantee actually being delivered. */
  readonly guarantee: LuaCellGuarantee
  /** The instruction budget the count hook enforces, if the hook is live; else `null`. */
  readonly instructionLimit: number | null
  /** The memory ceiling the allocator cap enforces, if the cap is live; else `null`. */
  readonly memoryCeilingBytes: number | null
  /** The wall-clock timeout the watchdog enforces. Always live. */
  readonly timeoutMs: number
}

/**
 * The type of the cell returned by {@link createLuaCell}. It is a {@link PredicateEvaluator} with
 * one extra field, `status()`, for inspecting the enforcement guarantee.
 */
export interface LuaCell extends PredicateEvaluator {
  /**
   * Returns the enforcement guarantee this instance is delivering. See {@link LuaCellGuarantee}.
   * A cell that could not install a count hook or whose allocator cap probe failed reports
   * `watchdog-only` here rather than claiming a `full` guarantee.
   */
  status(): LuaCellStatus
}

// ── context marshalling ─────────────────────────────────────────────────────
//
// `ctx.outputs` is a `ReadonlyMap<string, NodeOutput>` keyed `${nodeId}:${branchKey}`. Each
// `NodeOutput.items[i].json` is a `Record<string, EncodableValue>` whose values may include
// `Date`, `RegExp`, `bigint`, `Map`, `Set`, typed arrays, etc. — none of which round-trip through
// Lua's value model. We marshal the whole table to a plain-data tree (arrays, plain objects,
// strings, numbers, booleans, null) before pushing it into the VM, so a predicate's `ctx` global
// is always a Lua table of plain data.

/**
 * Marshal an `EncodableValue` (or any value that survived `OutputItem.json`) to plain data
 * suitable for pushing into the Lua VM. Cycles are not expected (outputs are freeze-checked for
 * encodability), but this guards against them anyway by returning a placeholder rather than
 * recursing forever.
 */
const marshalValue = (value: unknown, seen: Set<unknown>): unknown => {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return value.toString() + 'n' // Lua has no bignum; carry a tagged string
  if (t === 'function') return null // predicates never see live functions
  if (isInstanceOf(value, 'Date', Date)) {
    return (value as Date).toISOString()
  }
  if (isInstanceOf(value, 'RegExp', RegExp)) {
    return (value as RegExp).toString()
  }
  if (isInstanceOf(value, 'ArrayBuffer', ArrayBuffer)) {
    return Array.from(new Uint8Array(value))
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    return value.map((v) => marshalValue(v, seen))
  }
  // Typed arrays: present as plain arrays of numbers.
  if (ArrayBuffer.isView(value) && !isInstanceOf(value, 'DataView', DataView)) {
    const view = value as unknown as { length: number; [i: number]: number }
    const out: number[] = []
    for (let i = 0; i < view.length; i++) out.push(view[i])
    return out
  }
  if (isInstanceOf(value, 'DataView', DataView)) {
    return Array.from(new Uint8Array((value as DataView).buffer))
  }
  if (isInstanceOf(value, 'Map', Map)) {
    if (seen.has(value)) return null
    seen.add(value)
    const obj: Record<string, unknown> = {}
    for (const [k, v] of value as Map<unknown, unknown>) {
      obj[String(k)] = marshalValue(v, seen)
    }
    return obj
  }
  if (isInstanceOf(value, 'Set', Set)) {
    if (seen.has(value)) return null
    seen.add(value)
    return Array.from(value as Set<unknown>).map((v) => marshalValue(v, seen))
  }
  if (isObject(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      obj[k] = marshalValue(v, seen)
    }
    return obj
  }
  return null
}

/**
 * Marshal the whole `OutputTable` to a plain Lua-friendly object keyed `${nodeId}:${branchKey}`.
 * Each entry is an array of `{json: {...}}` items, mirroring `NodeOutput.items` so a predicate can
 * index `ctx[nodeId .. ':' .. branchKey][i].json.field`.
 */
const marshalOutputs = (outputs: ReadonlyMap<string, NodeOutput>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, nodeOutput] of outputs) {
    out[key] = (nodeOutput.items as OutputItem[]).map((item) => ({
      json: marshalValue(item.json, new Set<unknown>()),
    }))
  }
  return out
}

// ── text-mode-only loading ──────────────────────────────────────────────────
//
// Lua chunks may be either text source or precompiled bytecode. wasmoon's `loadString` uses
// `luaL_loadbufferx` with a `null` mode, which accepts BOTH. The bytecode verifier is NOT a
// security boundary (it has been bypassed repeatedly across Lua versions), so we refuse bytecode
// BEFORE calling the VM loader by detecting its signature: every Lua 5.x bytecode chunk begins
// with the magic bytes `\x1bLua` (0x1b, 'L', 'u', 'a'). A source string can never start with
// these because they include a non-printable ESC, and a leading `\x1b` in source would be a
// string literal — but the chunk as a whole would not match because `load`-time source is
// parsed, not matched byte-for-byte. We check the raw string's first four bytes.

const LUA_BYTECODE_MAGIC = 0x1b // ESC

/**
 * Returns `true` if `source` looks like precompiled Lua bytecode. Refuses bytecode so the cell
 * never relies on the bytecode verifier as a security boundary.
 */
const looksLikeBytecode = (source: string): boolean => {
  if (source.length < 4) return false
  return (
    source.charCodeAt(0) === LUA_BYTECODE_MAGIC &&
    source.charCodeAt(1) === 0x4c && // 'L'
    source.charCodeAt(2) === 0x75 && // 'u'
    source.charCodeAt(3) === 0x61 // 'a'
  )
}

// ── a per-evaluate VM instance ──────────────────────────────────────────────
//
// A fresh engine is built for each `evaluate()` call. This is deliberate: it gives every
// predicate a clean global table (no state leaks between branches), and it makes the instruction
// budget and memory ceiling per-evaluation rather than per-cell. Building a WASM engine per call
// is not free, but predicates are short and run at most once per node, so the cost is acceptable
// for the isolation it buys.

interface VmHandle {
  readonly engine: WasmoonLuaEngine
  readonly global: WasmoonGlobal
  /** The count-hook function pointer, to remove on teardown. `null` if no hook was installed. */
  readonly hookPointer: number | null
  /** True if the allocator cap is live (`setMemoryMax` gates allocation, confirmed by probe). */
  readonly memoryCapLive: boolean
}

/**
 * Build a fresh, sandboxed engine and install the count hook. Returns a handle that must be
 * closed via `closeVm` in a `finally`. The hook enforces the instruction budget and runs the
 * secondary memory poll (which raises a clean named abort before the allocator's hard failure);
 * the allocator cap (`setMemoryMax`) is set on the engine itself; the wall-clock deadline is
 * checked in the hook too so a script that runs many short instructions without hitting the
 * instruction count is still bounded by time.
 */
const buildVm = async (
  wasmoon: WasmoonModule,
  opts: {
    instructionLimit: number
    memoryCeilingBytes: number
    deadline: number
    /** True if the allocator cap probe passed; the engine sets `setMemoryMax` and runs the poll. */
    memoryCapLive: boolean
  }
): Promise<VmHandle> => {
  const factory = new wasmoon.LuaFactory()
  // ALLOWLIST build: no standard libs, no injected objects, no proxy. `traceAllocations: true`
  // is REQUIRED for layer 2 — wasmoon installs its custom `lua_Alloc` (the cap) ONLY under that
  // flag, and both `setMemoryMax` and `getMemoryUsed` throw without it — so the engine is ALWAYS
  // built with tracing on, even when the cap probe failed (tracing is harmless and keeps
  // `getMemoryUsed` available for the secondary poll). `enableProxy: false` keeps the global
  // table a plain Lua table and prevents the proxy layer from synthesising globals on read
  // (which would defeat the sandbox).
  const engine = await factory.createEngine({
    openStandardLibs: false,
    injectObjects: false,
    enableProxy: false,
    traceAllocations: true,
    functionTimeout: undefined, // we own the hook; do not also wire wasmoon's
  })
  const global = engine.global

  // Layer 2: the REAL allocator cap. `setMemoryMax` makes wasmoon's custom `lua_Alloc` REFUSE any
  // growing realloc whose end size would exceed the ceiling, returning NULL so the VM raises
  // `LUA_ERRMEM` ("not enough memory"). This is the enforcement; the poll below is secondary.
  if (opts.memoryCapLive) {
    global.setMemoryMax(opts.memoryCeilingBytes)
  }

  // A hard total on hook firings. wasmoon's count hook `count` parameter is a per-firing
  // INTERVAL, and wasmoon exposes no running total, so `instructionLimit` is the interval
  // between checks (a script that runs forever fires the hook forever, and each firing
  // re-checks the deadline and memory). The firings counter below turns "interval" into a
  // hard total: after MAX_HOOK_FIRINGS firings the budget is exhausted and the hook raises.
  // 10 firings means ~10x the per-check budget — generous for a legitimate predicate, fatal
  // for an infinite loop. The wall-clock watchdog is the real backstop.
  const MAX_HOOK_FIRINGS = 10
  let instructionBudgetHookFirings = 0

  // Install our own count hook with OUR instruction count (wasmoon's setTimeout hardcodes 1000).
  // The hook fires every `opts.instructionLimit` VM instructions and checks all three bounds.
  let hookPointer: number | null = null
  try {
    const module = global.lua.module
    hookPointer = module.addFunction((_L: number): void => {
      // Wall-clock deadline: checked on every hook firing so a long run of cheap instructions
      // is still bounded. This is the in-VM early-out; the worker watchdog is the outer bound.
      if (Date.now() > opts.deadline) {
        global.pushValue(new Error(DEADLINE_EXCEEDED))
        global.lua.lua_error(global.address)
        return
      }
      // Secondary memory poll (only when the cap is live, since both need `traceAllocations`).
      // This is NOT the enforcement — `setMemoryMax` is. The poll's job is to raise a clean,
      // named, model-addressed `MEMORY_CEILING_EXCEEDED` error naming the ceiling BEFORE the
      // allocator's hard `LUA_ERRMEM` ("not enough memory") fires, so the common case produces a
      // friendly named abort rather than a raw wasmoon error. A single large allocation between
      // firings can still beat the poll to the hard cap; the host catch in `evaluate` converts
      // that raw failure into the same named failure, so a raw "not enough memory" never escapes.
      if (opts.memoryCapLive) {
        let used = 0
        try {
          used = global.getMemoryUsed()
        } catch {
          // If tracing silently failed at runtime, treat the poll as unavailable — the allocator
          // cap and the watchdog still bound us. Do not abort from the poll.
          used = 0
        }
        if (used > opts.memoryCeilingBytes) {
          global.pushValue(new Error(memoryCeilingMessage(opts.memoryCeilingBytes)))
          global.lua.lua_error(global.address)
          return
        }
      }
      // Instruction budget: each firing consumes one interval. After MAX_HOOK_FIRINGS the
      // total budget is exhausted and the hook raises (see the interpretation note above).
      instructionBudgetHookFirings++
      if (instructionBudgetHookFirings > MAX_HOOK_FIRINGS) {
        global.pushValue(new Error(INSTRUCTION_BUDGET_EXCEEDED))
        global.lua.lua_error(global.address)
      }
    }, 'vii')
    global.lua.lua_sethook(global.address, hookPointer, LUA_EVENT_MASK_COUNT, opts.instructionLimit)
  } catch {
    // Could not install the hook. The canary should have caught this at construction; if we reach
    // here at evaluate time, remove a partial pointer and fall back to watchdog-only for this
    // evaluation. The run is still correct, merely less protected.
    if (hookPointer !== null) {
      try {
        global.lua.module.removeFunction(hookPointer)
      } catch {
        /* best effort */
      }
      hookPointer = null
    }
  }

  return { engine, global, hookPointer, memoryCapLive: opts.memoryCapLive }
}

/**
 * Tear down a VM built by `buildVm`. Safe to call on a partially-built handle. Removes the count
 * hook pointer and closes the engine, releasing the WASM allocation.
 */
const closeVm = (handle: VmHandle | null): void => {
  if (!handle) return
  const { engine, global, hookPointer } = handle
  if (hookPointer !== null) {
    try {
      global.lua.lua_sethook(global.address, null, 0, 0)
    } catch {
      /* best effort */
    }
    try {
      global.lua.module.removeFunction(hookPointer)
    } catch {
      /* best effort */
    }
  }
  try {
    engine.close()
  } catch {
    /* best effort */
  }
}

// ── the worker-thread watchdog ──────────────────────────────────────────────
//
// THE OUTER BOUND. A main-thread timer cannot do this job: a tight Lua loop owns the main thread
// synchronously and starves setTimeout/nextTick/queueMicrotask/setImmediate alike, so no
// main-thread timer ever fires. Only a separate event loop (a worker_thread) keeps time. On
// expiry the worker SIGKILLs the SHARED process (not process.exit, which ends only the worker).
//
// The watchdog is authored as a Worker created from a source string, so this file stays a single
// module with no second file to ship. The worker body is intentionally tiny: it arms a timer for
// `timeoutMs`, then `process.kill(pid, 'SIGKILL')`s the host. `worker.unref()` is called so a
// successful run does not keep the process alive.

/**
 * The source of the watchdog worker. It receives `{ pid, deadline }` via `workerData`, arms a
 * timer to the absolute deadline epoch, and on expiry `process.kill(pid, 'SIGKILL')`s the shared
 * process. Using an absolute deadline (not a relative timeout) means the host and worker never
 * disagree about when "expired" is, and a deadline that was already in the past when the worker
 * started fires immediately.
 */
const WATCHDOG_SOURCE = `
const { workerData } = require('node:worker_threads')
const process = require('node:process')
const { pid, deadline } = workerData
const now = Date.now()
if (now >= deadline) {
  // Already expired BEFORE the worker started its timer. Kill synchronously so no host work that
  // started past the deadline can complete. The host also checks this before its first import.
  try { process.kill(pid, 'SIGKILL') } catch (_) {}
} else {
  const timer = setTimeout(() => {
    try { process.kill(pid, 'SIGKILL') } catch (_) {}
  }, deadline - now)
  if (typeof timer.unref === 'function') timer.unref()
}
`

/**
 * The Node-only worker_threads import, isolated so static analyzers can see exactly which
 * `node:*` modules this subpath pulls in. This is the load-bearing `node:*` import that makes the
 * module browser-incompatible by design.
 */
type WorkerLike = {
  unref(): void
  terminate(): Promise<number>
}

type WorkerConstructor = new (
  filename: string | URL,
  options?: {
    eval?: boolean
    workerData?: unknown
  }
) => WorkerLike

// `require('node:worker_threads')` is deferred to `armWatchdog` so that merely importing this
// module (e.g. for types) does not pull `node:worker_threads` into a browser bundle. The dynamic
// require is the boundary.
let WorkerCtor: WorkerConstructor | null = null
const getWorkerCtor = (): WorkerConstructor => {
  if (WorkerCtor) return WorkerCtor

  const wt = require('node:worker_threads') as {
    Worker: WorkerConstructor
  }
  WorkerCtor = wt.Worker
  return WorkerCtor
}

/**
 * Arm the worker-thread watchdog. Returns a disarm function that terminates the worker. The
 * watchdog SIGKILLs the shared process at `deadline`. `worker.unref()` is called so a successful
 * run does not keep the process alive.
 *
 * The expired-deadline check is synchronous and before the first wasmoon import on the host side
 * as well (see `evaluate`); the worker independently checks the same absolute epoch before arming
 * its timer, so a process that started past its deadline is killed from either side.
 */
const armWatchdog = (deadline: number): (() => void) => {
  const Worker = getWorkerCtor()
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { pid: getPid(), deadline },
  })
  worker.unref()
  return () => {
    try {
      void worker.terminate()
    } catch {
      /* best effort */
    }
  }
}

// `process` is read only for `process.pid` inside `armWatchdog`, via a lazy `require` so the
// static `node:*` import surface stays at exactly what the watchdog needs. The host side uses
// `Date.now()` against the same `deadline` epoch inside the count hook, so host and worker share
// one definition of "expired".
const getPid = (): number => {
  const p = require('node:process') as { pid: number }
  return p.pid
}

// ── the cell ────────────────────────────────────────────────────────────────

/**
 * Construct a Lua predicate evaluator cell.
 *
 * @remarks
 * **THE WATCHDOG'S LAST RESORT IS `SIGKILL` ON THE HOST PROCESS — read this before wiring the
 * cell.** wasmoon is WebAssembly, so the Lua VM runs IN-PROCESS on the main thread. The watchdog
 * is a worker thread, but what it kills is `process.pid`: your process, not an isolated
 * evaluator.
 *
 * That is deliberate and there is no lighter option. A synchronous WASM loop owns the main
 * thread, so `worker.terminate()` has nothing to terminate and `process.exit()` never runs; only
 * the OS killing the process breaks it. A timeout that cannot be enforced is not a timeout, and
 * this cell would rather enforce one violently than advertise one it cannot deliver.
 *
 * Be clear about the trade: **a non-terminating Lua predicate takes the whole process down with
 * it.** The instruction-count hook and the allocator cap normally stop a runaway long before the
 * deadline — the watchdog is the last resort, not the first — but if the construction canaries
 * fail those probes, {@link LuaCell.status} reports the reduced guarantee and the watchdog is all
 * that remains.
 *
 * If a process-wide kill is unacceptable in your deployment, do not wire this cell for untrusted
 * predicates. `createStructuredCell` cannot loop at all.
 *
 * @param options - Optional enforcement tuning: instruction budget, memory ceiling, timeout.
 * @returns A {@link LuaCell} with `id: 'lua'`, ready to be wired into an orchestration battery's
 *   `evaluators`. The cell's `load()` lazily imports `wasmoon` (an optional peer) and maps a
 *   missing peer to `E_ORCH_CELL_UNAVAILABLE`. `validate()` refuses a non-string predicate and
 *   loads the chunk so a syntax error surfaces at freeze. `evaluate()` builds a fresh sandboxed
 *   VM per call, injects the marshalled `ctx.outputs` as a `ctx` global, and interprets the
 *   result as a branch or select verdict.
 *
 *   The cell probes the count hook and the allocator cap against a canary at construction (the
 *   cap probe positively confirms `setMemoryMax` plus a tiny ceiling actually REFUSES a large
 *   allocation) and reports the actual enforcement guarantee via `status()`. If either probe
 *   fails it falls back to watchdog-only enforcement and REPORTS the reduced guarantee rather
 *   than claiming it.
 *
 *   **Do not run the runaway-script test in-process.** A test that confirms the watchdog
 *   actually SIGKILLs the process on `while true do end` must spawn a CHILD process and observe
 *   its exit signal; running it inside this process would kill the test runner. That test lives
 *   in a separate, opt-in harness and is never invoked by `evaluate` itself.
 */
export const createLuaCell = (options?: CreateLuaCellOptions): LuaCell => {
  const instructionLimit = options?.instructionLimit ?? DEFAULT_INSTRUCTION_LIMIT
  const memoryCeilingBytes = options?.memoryCeilingBytes ?? DEFAULT_MEMORY_CEILING_BYTES
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Probed at load() time. The canary determines whether the count hook and the allocator cap
  // are actually available on this platform; the results are stored here and reported via
  // status(). `memoryCapLive` is set ONLY by a POSITIVE probe — `setMemoryMax` plus a tiny
  // ceiling actually REFUSING a large allocation — never by a negative grep or an absence of a
  // throw on mere construction.
  let hookLive = false
  let memoryCapLive = false

  const load = loadOnce('lua', async () => {
    // The first import of wasmoon is the point where an optional-peer failure surfaces as
    // E_ORCH_CELL_UNAVAILABLE (loadOnce maps it). After a successful import we probe.
    const wasmoon = (await import('wasmoon')) as unknown as WasmoonModule
    if (typeof wasmoon.LuaEventMasks?.Count !== 'number') {
      throw new TypeError('wasmoon: LuaEventMasks.Count missing — unsupported wasmoon version')
    }

    // Canary probe, in two parts.
    //
    // (1) Count hook: build a throwaway engine with `memoryCapLive: false` (no cap set yet), try
    //     to `addFunction` + `lua_sethook`, and confirm the pointer is non-null. We do NOT fire
    //     the hook — firing would require running a script, which we refuse without a watchdog.
    //
    // (2) Allocator cap: a POSITIVE probe. Build a SECOND throwaway engine, call `setMemoryMax`
    //     with a DELIBERATELY TINY ceiling, and run a BOUNDED chunk that allocates a lot
    //     (`for i = 1, 200000 do t[i] = i end` — a fixed 200k iterations, NOT `while true do`,
    //     so it cannot loop forever). Layer 2 is claimed ONLY if that run THROWS — i.e. the
    //     allocator actually REFUSED the allocation. A `setMemoryMax` that silently fails to gate
    //     allocation (the failure mode the earlier negative grep hid) is caught here: the run
    //     would succeed and the probe would report the reduced guarantee. The watchdog is armed
    //     around the run for defence in depth, even though the chunk is bounded.
    let hookCanary: VmHandle | null = null
    try {
      hookCanary = await buildVm(wasmoon, {
        instructionLimit,
        memoryCeilingBytes,
        deadline: Date.now() + timeoutMs,
        memoryCapLive: false,
      })
      hookLive = hookCanary.hookPointer !== null
    } finally {
      closeVm(hookCanary)
    }

    if (hookLive) {
      // (2) Positive allocator-cap probe. The tiny ceiling must be SMALLER than what the bounded
      // chunk allocates, or the refusal would not fire. 64 KiB is far below the ~3 MB the chunk
      // needs, and is independent of the user's `memoryCeilingBytes` so the probe is stable.
      const PROBE_CEILING = 64 * 1024
      const PROBE_CHUNK = 'local t = {} for i = 1, 200000 do t[i] = i end'
      let capCanary: VmHandle | null = null
      const disarmProbe = armWatchdog(Date.now() + timeoutMs)
      try {
        capCanary = await buildVm(wasmoon, {
          instructionLimit,
          memoryCeilingBytes: PROBE_CEILING,
          deadline: Date.now() + timeoutMs,
          memoryCapLive: true,
        })
        capCanary.global.loadString(PROBE_CHUNK, 'lua-cell: cap probe')
        try {
          // `runSync` runs the chunk synchronously on the host thread; the allocator refuses the
          // oversized realloc and `assertOk` throws. We do NOT `await run` here because the
          // probe must be synchronous so the watchdog deadline is the only async boundary.
          capCanary.global.runSync(0)
          // No throw → the cap did NOT gate allocation. Do not claim layer 2.
          memoryCapLive = false
        } catch (err) {
          // A throw is the EXPECTED outcome. Accept it as proof the cap is real only when the
          // error is the OOM one (raw "not enough memory" or our named `MEMORY_CEILING_EXCEEDED`);
          // any other error (a hook install failure, a syntax error in the probe chunk) is not
          // proof of the cap and must not claim it.
          memoryCapLive = isOutOfMemoryError(err)
        }
      } finally {
        closeVm(capCanary)
        disarmProbe()
      }
    } else {
      memoryCapLive = false
    }
  })

  const validate = async (node: PlanNode): Promise<void> => {
    await load()
    const def = node.definition as BranchNodeDefinition | SelectNodeDefinition
    if (node.kind !== 'branch' && node.kind !== 'select') {
      throw new TypeError(
        `lua cell: node kind '${node.kind}' is not evaluable — only 'branch' and 'select' carry a Lua predicate`
      )
    }
    const predicate = def.predicate
    if (typeof predicate !== 'string') {
      throw new TypeError(
        `lua cell: predicate must be a SOURCE STRING for the lua cell (node '${node.id}'). Got ${typeof predicate}.`
      )
    }
    if (predicate.length === 0) {
      throw new TypeError(`lua cell: predicate is an empty string (node '${node.id}').`)
    }
    if (looksLikeBytecode(predicate)) {
      throw new TypeError(
        `lua cell: predicate looks like precompiled Lua bytecode, which is refused (node '${node.id}'). The bytecode verifier is not a security boundary; supply source text.`
      )
    }
    if (node.kind === 'select') {
      const cases = (def as SelectNodeDefinition).cases
      if (!Array.isArray(cases) || cases.length === 0) {
        throw new TypeError(
          `lua cell: select node '${node.id}' must declare a non-empty 'cases' array.`
        )
      }
      for (const c of cases) {
        if (typeof c !== 'string') {
          throw new TypeError(
            `lua cell: select node '${node.id}' has a non-string case label: ${typeof c}.`
          )
        }
      }
    }
    // Load the chunk so a syntax error surfaces at FREEZE rather than at run time. We build a
    // throwaway engine for this: `loadString` parses but does not run, so no watchdog is needed.
    const wasmoon = (await import('wasmoon')) as unknown as WasmoonModule
    let canary: VmHandle | null = null
    try {
      canary = await buildVm(wasmoon, {
        instructionLimit,
        memoryCeilingBytes,
        deadline: Date.now() + timeoutMs,
        memoryCapLive: memoryCapLive,
      })
      // `loadString` throws on a syntax error (it asserts the luaL_loadbufferx result).
      canary.global.loadString(predicate, `node:${node.id}`)
    } finally {
      closeVm(canary)
    }
  }

  const evaluate = async (node: PlanNode, ctx: PredicateContext): Promise<PredicateVerdict> => {
    await load()
    // Expired-deadline check: SYNCHRONOUS and BEFORE the first wasmoon import on this call path.
    // (wasmoon was already imported by load(), but we re-check the deadline here so a long gap
    // between load and evaluate is also caught.) The worker checks the same epoch independently.
    const deadline = Date.now() + timeoutMs
    if (Date.now() > deadline) {
      return safeFallbackVerdict(node)
    }

    const def = node.definition as BranchNodeDefinition | SelectNodeDefinition
    if (typeof def.predicate !== 'string') {
      // validate() should have caught this; a non-string here is a freeze-time bug. Never throw
      // out of a predicate — return the safe fallback.
      return safeFallbackVerdict(node)
    }

    const wasmoon = (await import('wasmoon')) as unknown as WasmoonModule
    // Arm the watchdog FIRST, before any VM work, so the outer bound is in place.
    const disarm = armWatchdog(deadline)
    let handle: VmHandle | null = null
    try {
      handle = await buildVm(wasmoon, {
        instructionLimit,
        memoryCeilingBytes,
        deadline,
        memoryCapLive,
      })
      const { global } = handle

      // Inject the marshalled context as a `ctx` global. A predicate reads
      // `ctx['nodeId:branchKey'][i].json.field`.
      global.set('ctx', marshalOutputs(ctx.outputs))

      // Load the chunk in text mode. `loadString` uses luaL_loadbufferx with a null mode, which
      // accepts both text and bytecode; we already refused bytecode in validate(), and we refuse
      // it again here for defence in depth.
      if (looksLikeBytecode(def.predicate)) {
        return safeFallbackVerdict(node)
      }
      global.loadString(def.predicate, `node:${node.id}`)

      // Run the chunk. The count hook interrupts a runaway loop by raising a Lua error, which
      // `run` surfaces as a rejected promise. An out-of-memory abort is surfaced as a CLEAN,
      // NAMED, model-addressed failure (via the secondary poll's `MEMORY_CEILING_EXCEEDED`, or —
      // if the allocator's hard cap beat the poll — by converting the raw "not enough memory" to
      // the same named failure here), so a raw wasmoon error never propagates. Other runtime
      // errors (unknown global, type errors) are converted to the safe fallback — a predicate is
      // never allowed to crash the run.
      let result: unknown
      try {
        result = await global.run(0)
      } catch (err) {
        if (isOutOfMemoryError(err)) {
          // Out of memory: surface as a clean, named, model-addressed failure naming the
          // ceiling. This is NOT the safe fallback — resource exhaustion is a runtime condition
          // the model/operator should SEE, not a predicate logic result to be silently defaulted.
          // The executor's existing error handling turns this thrown Error into a `node_failed`
          // (or handled `error` edge) whose `message` is the named, ceiling-naming string below.
          throw new Error(memoryCeilingMessage(memoryCeilingBytes))
        }
        // A hook-induced instruction/deadline interruption or a non-OOM runtime error. A
        // predicate is never allowed to crash the run, so this is the safe fallback — NOT a
        // rethrow.
        return safeFallbackVerdict(node, err)
      }

      // wasmoon's `run(0)` returns a `MultiReturn` (an Array subclass) carrying ALL of the
      // chunk's return values, NOT a single value. Passing the `MultiReturn` itself to
      // `toBoolean`/`toCaseLabel` would see a non-empty array object — truthy — for EVERY
      // successful evaluation regardless of what the predicate actually returned, so `false`,
      // `nil` and `true` all collapsed to `matched: true`. Take the FIRST returned value out of
      // the `MultiReturn` before interpreting it; an empty `MultiReturn` (a chunk with no
      // `return` statement) is Lua `nil` (JavaScript `undefined`), so a no-return branch is
      // `matched: false`, not `true`.
      const first = firstReturnValue(result)

      // Interpret the result by node kind.
      if (node.kind === 'branch') {
        const matched = toBoolean(first)
        return { kind: 'branch', matched }
      }
      // select: evaluate each declared case in order, return the first whose predicate matches.
      const selectDef = def as SelectNodeDefinition
      // The predicate string is the SELECT DISPATCHER: it is expected to RETURN a case label
      // (a string) or nil. We honour that contract: the first returned string that is a member
      // of `cases` is the verdict; nil or a non-member yields the default (null).
      const label = toCaseLabel(first, selectDef.cases)
      return { kind: 'select', caseLabel: label }
    } catch (err) {
      // An out-of-memory abort propagates as the clean named failure (it was either raised by
      // the secondary poll or converted from the allocator's raw "not enough memory" above). Do
      // NOT swallow it into the safe fallback — the model/operator must see resource exhaustion.
      if (isOutOfMemoryError(err)) {
        throw new Error(memoryCeilingMessage(memoryCeilingBytes))
      }
      // Any other host-side failure (engine build, setglobal, etc.) is converted to the safe
      // fallback — a predicate is never allowed to crash the run for non-resource errors.
      return safeFallbackVerdict(node, err)
    } finally {
      closeVm(handle)
      disarm()
    }
  }

  const status = (): LuaCellStatus => ({
    guarantee: hookLive && memoryCapLive ? 'full' : 'watchdog-only',
    instructionLimit: hookLive ? instructionLimit : null,
    memoryCeilingBytes: memoryCapLive ? memoryCeilingBytes : null,
    timeoutMs,
  })

  return {
    id: 'lua',
    load,
    validate,
    evaluate,
    status,
  }
}

// ── verdict helpers ─────────────────────────────────────────────────────────

/**
 * Whether an error is the Lua/wasmoon out-of-memory signal: either wasmoon's raw
 * `LUA_ERRMEM` message ("not enough memory", surfaced verbatim by `assertOk` for `ErrorMem`),
 * or this cell's own named `MEMORY_CEILING_EXCEEDED` abort (raised by the secondary poll or
 * re-thrown by the host catch). Used to single out an OOM from other runtime errors: an OOM is
 * surfaced as a clean, named, model-addressed failure (naming the ceiling), while other runtime
 * errors are converted to the safe fallback verdict. Never throws.
 */
const isOutOfMemoryError = (err: unknown): boolean => {
  if (!isInstanceOf(err, 'Error', Error)) return false
  const msg = err.message
  if (typeof msg !== 'string') return false
  if (msg.startsWith(MEMORY_CEILING_EXCEEDED)) return true
  return /not enough memory/i.test(msg)
}

/**
 * Extract the single value a predicate returned from a wasmoon call result.
 *
 * wasmoon's `Thread.run(argCount)` / `runSync(argCount)` return a `MultiReturn` — an `Array`
 * subclass (`wasmoon/dist/multireturn.d.ts`) carrying ALL of the chunk's return values, built by
 * `getStackValues` as `new MultiReturn(returns)` with `returnValues[i] = getValue(start + i + 1)`
 * for every value left on the Lua stack. So `result` is an array-like, and handing it straight to
 * {@link toBoolean} / {@link toCaseLabel} would see a non-empty array object — truthy in both JS
 * and the old `toBoolean` — for EVERY successful evaluation, whatever the predicate returned:
 * `return 1 > 2`, `return false`, `return nil` all became `matched: true`. That is the defect
 * this helper closes.
 *
 * We take the FIRST returned value (a predicate is a single-value expression; extra returns are
 * ignored by contract). A chunk that returns nothing leaves the stack empty, so `MultiReturn` is
 * length 0; that is Lua `nil`, surfaced here as JavaScript `undefined`, so a no-return branch is
 * `matched: false` rather than `true`.
 *
 * Defensive against a non-`MultiReturn` result (a future wasmoon surface, or a mock): a non-array
 * is passed through unchanged so interpretation still works.
 */
const firstReturnValue = (result: unknown): unknown => {
  if (Array.isArray(result)) {
    return result.length === 0 ? undefined : (result as unknown[])[0]
  }
  return result
}

/**
 * Convert a Lua return value to a boolean for a `branch` verdict using **Lua truthiness**, NOT
 * JS truthiness. In Lua only `false` and `nil` are falsy; EVERYTHING else is truthy — including
 * `0` and `''`, which are falsy in JS. So this does NOT apply `!!value` (that would make `0` and
 * `''` falsy and break a predicate author's Lua expectations); it returns `false` only for Lua
 * `nil` (surfaced by wasmoon as JavaScript `null`/`undefined`) and Lua `false` (surfaced as JS
 * `false`), and `true` for any other value — number (incl. `0`), string (incl. `''`), table,
 * function, etc. Author receives the value the predicate returned, interpreted the way Lua
 * itself would interpret it.
 */
const toBoolean = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (value === false) return false
  // wasmoon surfaces Lua `nil` as JavaScript `null`/`undefined`; a Lua `false` as JS `false`.
  // Everything else is truthy in Lua — including `0` and `''` (which are falsy in JS but TRUTHY
  // in Lua). We deliberately do NOT use JS `!!value` here.
  return true
}

/**
 * Convert a Lua return value to a select case label. Returns the label if it is a string and a
 * member of `cases`; otherwise `null` (the `default` handle). A non-string return (number,
 * boolean, table) is NOT coerced — the select contract is "return the label string or nil", and
 * coercing would let a predicate accidentally match by numeric index.
 */
const toCaseLabel = (value: unknown, cases: readonly string[]): string | null => {
  if (typeof value !== 'string') return null
  return cases.includes(value) ? value : null
}

/**
 * The safe fallback verdict for a node when a predicate cannot be evaluated — a runtime error, a
 * hook interruption, an expired deadline, a host-side failure, or a non-string predicate reaching
 * evaluate. For a `branch` this is `{kind:'branch', matched:false}` (the `no_match`/`default`
 * path); for a `select` this is `{kind:'select', caseLabel:null}` (the `default` handle). A
 * predicate is never allowed to crash the run, so this NEVER throws.
 */
const safeFallbackVerdict = (node: PlanNode, _err?: unknown): PredicateVerdict => {
  if (node.kind === 'branch') return { kind: 'branch', matched: false }
  return { kind: 'select', caseLabel: null }
}
