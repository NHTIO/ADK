/**
 * @module @nhtio/adk/batteries/orchestration/cells/jexl
 *
 * The `jexl` predicate cell.
 *
 * This cell lets a branch or select node express its predicate as a JEXL expression SOURCE
 * STRING, evaluated against a plain-data snapshot of the run's outputs. It is the alternative to
 * the declarative {@link import('./structured') structured} cell for authors who want the express
 * power of a real expression grammar.
 *
 * Why it is safe without a watchdog
 * ---------------------------------
 * RESOURCE BOUND — stated because the absence of a watchdog is easy to over-read. Expression-only
 * rules out non-termination, not slowness: a collection filter is LINEAR in the collection, so
 * evaluation cost scales with whatever a `call` node returned. `PlanBounds.maxEncodedBytes` caps
 * the PLAN, not a tool's runtime output, and the predicate reads the output. Measured: a filter
 * over 200,000 elements evaluates in roughly 100ms, so ordinary data is not a concern — but a consumer
 * whose tool can return unbounded data should cap it in `CallInvokerFn`, because this cell will
 * not.
 *
 * JEXL is a custom lexer/parser/AST interpreter, **not** `eval()`. It is expression-only by
 * design: there are no statements, no assignment, no loops, no function definitions. It is
 * therefore structurally non-Turing-complete and cannot fail to terminate on anything but
 * pathological data size. The grammar deliberately exposes only the safe surface —
 * comparisons, ternary/elvis, collection filtering (`employees[.age >= retireAge].first`, which
 * JEXL translates to a `filter` + `map` + projection), and the `|` transform pipe.
 *
 * The security boundary is the transform pipe. Every transform is host-registered through
 * `addTransform`, so the host decides the entire callable surface. This cell ships a CLOSED
 * ALLOWLIST: accept an optional `transforms` option, register exactly those, and make sure a
 * predicate cannot reach anything unregistered. If no `transforms` are supplied the pipe
 * resolves nothing, and any predicate that reaches for a transform fails closed at evaluation.
 *
 * Two cross-cutting properties hold by construction and are worth carrying into any caller:
 *
 * 1. The context is PRE-MARSHALLED PLAIN DATA. The evaluator builds a fresh plain record from
 *    `ctx.outputs` and never hands JEXL a live object whose methods are reachable, so a
 *    predicate can read values but cannot invoke arbitrary code through object identity.
 * 2. There is no clock and no randomness unless deliberately injected through a transform. A
 *    branch or select node is therefore safe to re-enter unconditionally when a run resumes:
 *    re-evaluating the same source string against the same snapshot always yields the same
 *    verdict. Evaluation stays synchronous via `evalSync` — reproducible even though the cell's
 *    seam is async.
 *
 * Honest dependency note
 * ----------------------
 * JEXL was last published 2022-06-19. It is a stable-but-frozen dependency rather than an
 * actively maintained one. That is acceptable here because the grammar this cell exposes is
 * closed and the transform surface is host-owned, so there is nothing upstream can change that
 * this cell depends on; but it should be read plainly: do not assume ongoing upstream work.
 * Unlike the Lua cell, this cell is browser-safe.
 */

import { loadOnce } from '../predicates'
import { isObject, isError } from '../../../lib/utils/guards'
import type {
  EncodableValue,
  PredicateEvaluator,
  PredicateContext,
  PredicateVerdict,
  PlanNode,
} from './../types'

// ── the jexl surface this cell admits ────────────────────────────────────────
// Declared structurally rather than imported: `jexl` is an optional peer that ships no usable
// types here, so we describe just the subset this cell calls. The runtime module is cast to this
// shape after the lazy import.
interface JexlExpression {
  /** Synchronously evaluate the compiled expression against a plain-data context. */
  evalSync(context: unknown): unknown
  /** Parse the expression immediately, throwing a JEXL error on a syntax problem without evaluating. */
  compile(): unknown
}

interface JexlEngine {
  /** Register a named transform; the only way a predicate reaches host code. Returns nothing. */
  addTransform(name: string, fn: (value: unknown, ...args: unknown[]) => unknown): void
  /**
   * Build an expression object WITHOUT parsing it. `compile()` is what parses — a statement form
   * such as `count = 5` survives this call and is only refused once compiled.
   */
  createExpression(source: string): JexlExpression
  /** Parse source, throwing a JEXL error on a syntax problem without evaluating. */
  compile(source: string): JexlExpression
  /** Parse and synchronously evaluate source against a plain-data context. */
  evalSync(source: string, context?: Record<string, unknown>): unknown
}

/** The module shape a dynamic `import('jexl')` resolves to. */
interface JexlModule {
  /** The JEXL engine constructor; instantiate one per cell so transforms stay closed. */
  Jexl: new () => JexlEngine
}

/**
 * A host-registered transform, keyed by the name a predicate uses on the `|` pipe.
 *
 * The first argument is the piped value; the rest are the arguments given in the predicate. The
 * value is whatever the preceding expression produced (never a live object with reachable
 * methods — the context is marshalled plain data), so a transform should treat its input as a
 * value and return a value.
 */
export type JexlTransform = (value: unknown, ...args: unknown[]) => unknown

/**
 * Options for {@link createJexlCell}.
 */
export interface JexlCellOptions {
  /**
   * The CLOSED transform allowlist to register on the engine, keyed by pipe name.
   *
   * Registering nothing (the default) means the `|` pipe resolves no transform at all. This is
   * the cell's security boundary: a predicate can never reach a transform that was not listed
   * here.
   */
  transforms?: Record<string, JexlTransform>
}

/** Describe a non-string predicate so a validation error can name what was actually given. */
const describeValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `a string`
  if (Array.isArray(value)) return 'an array'
  if (isObject(value)) return 'an object'
  return `a ${typeof value} value`
}

/**
 * Build the plain-data snapshot a branch/select predicate reads.
 *
 * The readable context is assembled purely from `ctx.outputs` into a fresh plain record: each
 * output key maps to the merged `json` of that output's items. Nothing in the result inherits
 * reachable methods and nothing is mutated — jexl gets a value snapshot, never live objects.
 *
 * @param outputs - the run's output table to marshal.
 * @returns a plain record keyed identically to the table, holding the merged item payloads.
 */
const snapshotOf = (
  outputs: ReadonlyMap<string, { items: { json: Record<string, EncodableValue> }[] }>
): Record<string, unknown> => {
  const byKey: Record<string, unknown> = {}
  const snapshot: Record<string, unknown> = {}

  for (const [key, output] of outputs) {
    const merged: Record<string, EncodableValue> = {}
    for (const item of output.items) {
      for (const [k, v] of Object.entries(item.json)) {
        merged[k] = v
      }
    }

    // The exact table key, addressable through the `outputs` wrapper.
    byKey[key] = merged

    // ALSO a bare node id, which is the form the dialect actually admits. A table key is
    // `${nodeId}:${branchKey}` and JEXL's grammar cannot reach a bare identifier containing a
    // colon by ANY syntax — `n1:.status` is a parse error, and an unwrapped `this["n1:"]` throws
    // because `this` is not bound. Measured against real jexl 2.3.0, not assumed. So a flat
    // snapshot keyed by table key was addressable by nothing at all, and every predicate silently
    // evaluated `undefined`.
    //
    // Where one node ran on ONE branch the bare id is unambiguous and is what an author writes.
    // Where a node ran on several, the bare id is ambiguous, so it is deliberately NOT set to an
    // arbitrary winner — the author uses `outputs['nodeId:branchKey']` to say which, exactly as
    // the Lua cell requires.
    const nodeId = key.slice(0, key.indexOf(':'))
    if (nodeId !== '' && IDENTIFIER.test(nodeId)) {
      snapshot[nodeId] = nodeId in snapshot ? AMBIGUOUS : merged
    }
  }

  for (const [nodeId, value] of Object.entries(snapshot)) {
    if (value === AMBIGUOUS) delete snapshot[nodeId]
  }

  // `outputs` is the escape hatch for an exact key, and the only way to disambiguate a node that
  // ran on more than one branch. Set last so a node genuinely named `outputs` cannot shadow it.
  snapshot.outputs = byKey
  return snapshot
}

/** A bare identifier JEXL can actually address, so a key it cannot reach is never advertised. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Marks a node id reached on more than one branch, so it is dropped rather than guessed. */
const AMBIGUOUS = Symbol('ambiguous')

/**
 * Create the `jexl` predicate cell.
 *
 * The cell treats a branch/select node's `predicate` as a JEXL expression source string. `load`
 * lazily resolves the optional `jexl` peer and registers the closed transform allowlist; `load`
 * and `validate` run the dialect lint and a parse attempt so a syntax error surfaces at freeze
 * rather than mid-run; `evaluate` synchronously evaluates the source against a marshalled
 * snapshot of the outputs.
 *
 * @param options - optional cell configuration (the closed transform allowlist).
 * @returns a {@link PredicateEvaluator} whose `id` is `'jexl'`.
 */
export const createJexlCell = (options?: JexlCellOptions): PredicateEvaluator => {
  // The shared engine, instantiated exactly once by load and reused for parse and evaluation so
  // the transform allowlist stays closed across the cell's lifetime.
  let engine: JexlEngine | undefined

  // Idempotent lazy load: resolves 'jexl' once and maps a missing peer to
  // E_ORCH_CELL_UNAVAILABLE. The engine is created here so addTransform — the security
  // boundary — runs exactly once.
  const load = loadOnce('jexl', async () => {
    const mod = (await import('jexl')) as JexlModule
    const instance = new mod.Jexl()
    const transforms = options?.transforms
    if (transforms) {
      for (const [name, fn] of Object.entries(transforms)) {
        instance.addTransform(name, fn)
      }
    }
    engine = instance
  })

  return {
    id: 'jexl',

    /**
     * Resolve the optional `jexl` peer and close the transform allowlist.
     *
     * Idempotent; a subsequent call resolves immediately with the same outcome. A missing
     * peer becomes {@link './../exceptions'.E_ORCH_CELL_UNAVAILABLE} naming the install command.
     */
    async load(): Promise<void> {
      await load()
    },

    /**
     * Validate that the node's predicate is well-formed JEXL.
     *
     * First the predicate must be a source string (this cell reads strings, not the structured
     * tree), then the dialect lint rejects two model mistakes BY NAME rather than leaving them
     * to the parser, then a parse attempt confirms the grammar compiles. Each rejection names
     * the specific correction.
     *
     * @param node - the plan node to validate.
     */
    async validate(node: PlanNode): Promise<void> {
      await load()
      const definition = node.definition as { predicate?: unknown }
      const source = definition?.predicate

      // This cell's contract: the predicate is a JEXL expression SOURCE STRING, not the
      // structured tree the structured cell reads.
      if (typeof source !== 'string') {
        throw new Error(
          `jexl cell: node '${node.id}' must carry a JEXL expression SOURCE STRING as its ` +
            `predicate, but got ${describeValue(source)}. Write the predicate as a string, ` +
            `e.g. "order.total > 100", or use the 'structured' cell for the declarative tree.`
        )
      }

      // Dialect lint, part of per-cell validate because this cell owns the dialect.
      if (source.includes('===')) {
        throw new Error(
          `jexl cell: node '${node.id}' uses '===' which JEXL does not support. ` +
            `JEXL's equality operator is '=='. Replace '===' with '=='.`
        )
      }
      if (/\bctx\s*\./.test(source)) {
        throw new Error(
          `jexl cell: node '${node.id}' prefixes an identifier with 'ctx.'. JEXL reads bare ` +
            `identifiers against the readable context — there is no 'ctx' object. ` +
            `Reference the value directly, e.g. 'order.total == 100'.`
        )
      }

      // Parse attempt: fail at freeze on a syntax error rather than mid-run. createExpression only
      // BUILDS the expression object; the actual parse happens on .compile(). So invoke compile()
      // to force the parse. The expression is never evaluated, so no identifier is resolved here.
      try {
        if (!engine) throw new Error('jexl engine not loaded')
        engine.createExpression(source).compile()
      } catch (err) {
        const hint = isError(err) ? err.message : String(err)
        throw new Error(`jexl cell: node '${node.id}' predicate is not valid JEXL: ${hint}`)
      }

      // Transform allowlist check. The pipe is the cell's security boundary, but jexl resolves a
      // transform NAME at EVALUATION, not at parse: compile('name|evil') succeeds and only
      // evalSync throws 'Transform evil is not defined'. Deferring that refusal to run time would
      // let an approved plan reach an unregistered transform for the first time AFTER side effects
      // have already landed. So extract the transform names at parse level and refuse any that is
      // not in the registered allowlist, naming the unknown transform AND the registered set so an
      // authoring model can correct it in one pass. Nothing is evaluated here.
      const registered = options?.transforms ?? {}
      const registeredNames = Object.keys(registered)
      const transformUse = /\|\s*([a-zA-Z_][a-zA-Z0-9_]*)/g
      let transformMatch: RegExpExecArray | null
      while ((transformMatch = transformUse.exec(source)) !== null) {
        const transformName = transformMatch[1]
        if (!registeredNames.includes(transformName)) {
          const listed = registeredNames.length ? `: ${registeredNames.join(', ')}` : ' is empty'
          throw new Error(
            `jexl cell: node '${node.id}' predicate calls transform '${transformName}', which is ` +
              `not in this cell's registered allowlist${listed}. Register '${transformName}' via ` +
              `createJexlCell({ transforms }) or change the predicate to use a registered transform.`
          )
        }
      }
    },

    /**
     * Evaluate the node's predicate against the run's outputs.
     *
     * Builds a plain-data snapshot, then synchronously evaluates the predicate source string.
     * For a `branch` node the result is truthiness → `{kind:'branch', matched}`. For a `select`
     * node the evaluated value is compared to each case label in declared order and the first
     * equal label is returned; `null` routes to the `default` handle.
     *
     * @param node - the plan node to evaluate.
     * @param ctx - the context carrying the run's outputs.
     * @returns the branch or select verdict.
     */
    async evaluate(node: PlanNode, ctx: PredicateContext): Promise<PredicateVerdict> {
      await load()
      const definition = node.definition as { predicate?: unknown; cases?: string[] }
      const source = definition?.predicate
      if (typeof source !== 'string' || !engine) {
        return { kind: 'branch', matched: false }
      }

      const snapshot = snapshotOf(ctx.outputs)

      // A PREDICATE IS NEVER ALLOWED TO CRASH THE RUN. jexl's `evalSync` throws on a runtime
      // fault the parse could not have caught — reaching into an undefined intermediate
      // (`missing.deep.thing`) is the ordinary case, and it is exactly what an author writing
      // against a branch that has not produced output yet will hit. Unguarded, that TypeError
      // propagates out of `evaluate`, is caught by the executor as a node failure, and halts the
      // whole run on a plan the operator approved.
      //
      // The safe verdict is the negative one: `no_match` for a branch and the `default` handle
      // for a select, which is what the Lua cell already documents for an equivalent fault. A
      // predicate that cannot be answered has not selected anything.
      let value: unknown
      try {
        value = engine.evalSync(source, snapshot)
      } catch {
        return node.kind === 'select'
          ? { kind: 'select', caseLabel: null }
          : { kind: 'branch', matched: false }
      }

      if (node.kind === 'select') {
        const cases = definition.cases ?? []
        for (const label of cases) {
          if (String(value) === String(label)) {
            return { kind: 'select', caseLabel: label }
          }
        }
        return { kind: 'select', caseLabel: null }
      }

      return { kind: 'branch', matched: Boolean(value) }
    },
  }
}
