/**
 * @module @nhtio/adk/batteries/sandbox/js
 *
 * The JS-level boundary: a hardened SES `Compartment` for evaluating UNTRUSTED, model-generated code.
 *
 * @remarks
 * This is a different boundary from Part A, not a weaker one. Part A asks *what can this PROCESS
 * reach?* and answers it with OS policy; this asks *what can this CODE reach?* and answers it with
 * enumerated capabilities. Both are required and neither substitutes for the other; compose them for
 * the full stack (SES for reach, a killable guest for duration, SRT for OS authority).
 *
 * `lockdown()` runs IN THE GUEST, always, before any `Compartment` — that is the whole guarantee. A
 * guest has its own intrinsics, so hardening the host does nothing for it, and a `Compartment` in an
 * un-hardened realm is not a boundary at all. Evaluation refuses outright if lockdown did not take.
 *
 * Capabilities are ENUMERATED, never inherited: no ambient `fetch`/`process`/`require`, and
 * deliberately no `Date.now`/`Math.random` unless injected (they are covert channels). Host functions
 * cross as declarations, never by reference — a function cannot survive structured clone — so each
 * becomes an in-guest stub that posts a `hostcall`. Every such call is therefore asynchronous even
 * when the host function is not, and the model must be told so or it writes synchronous code.
 *
 * Availability is only PARTLY closable, and the docs say which half: a deadline plus a real kill
 * handles a hang, but a timer cannot preempt an allocation that exhausts the heap first. On Node an
 * OOM is a contained child crash; the browser has no equivalent and its contract is weaker.
 *
 * Unlike `../node`, this subpath is environment-neutral — `ses` and its `@endo/*` dependencies are
 * zero-dependency ESM — so Part B is the cross-environment layer where Part A cannot go.
 *
 * Attribution: SES is Agoric/Endo's `ses` (Apache-2.0), consumed as an optional peer. See `xsnap`
 * and LavaMoat as production references for the full stack.
 */
export * from './exceptions'
export * from './ses_contracts'
export * from './validation'
export * from './compartment'
export * from './service'
export * from './runner'
export * from './tool'
