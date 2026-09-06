/**
 * Ambient type declaration for `jexl` (v2.3.0), which ships no types of its own.
 *
 * Mirrors the surface the orchestration battery's jexl predicate cell actually uses, and no more:
 *
 *   const engine = new Jexl.Jexl()
 *   engine.addTransform(name, fn)       // the cell's closed allowlist — the security boundary
 *   engine.compile(expression)          // PARSES; this is the freeze-time gate
 *   engine.createExpression(src).evalSync(context)
 *
 * `compile()` is the call that actually parses, and that distinction is load-bearing:
 * `createExpression()` alone builds an expression object lazily without parsing, so a statement
 * form (`count = 5`, `while(true){}`) passes it and is only refused once `compile()` runs.
 *
 * Note also that a transform name is resolved at EVALUATION, not at parse — `compile('a|missing')`
 * succeeds and only `evalSync` throws `Transform missing is not defined`. The cell therefore
 * checks its allowlist itself rather than relying on the parse to do it.
 *
 * Declared as ambient types rather than a runtime dependency: `jexl` is an OPTIONAL peer, lazily
 * imported inside the cell's `load()`, so a consumer who never wires that cell never installs it.
 * Same pattern and same reason as `src/types/evaluatex.d.ts`.
 */
declare module 'jexl' {
  /** A transform registered on an engine: receives the piped value plus any pipe arguments. */
  export type JexlTransform = (value: unknown, ...args: unknown[]) => unknown

  /** A compiled or lazily-built expression. */
  export interface JexlExpression {
    /** Parse the expression, throwing on invalid syntax. Returns itself for chaining. */
    compile(): JexlExpression
    /** Evaluate synchronously against a context object. */
    evalSync(context?: Record<string, unknown>): unknown
    /** Evaluate asynchronously against a context object. */
    eval(context?: Record<string, unknown>): Promise<unknown>
  }

  /** A jexl engine instance: the unit that owns a transform registry. */
  export class Jexl {
    /** Register a transform, making it reachable through the `|` pipe. */
    addTransform(name: string, fn: JexlTransform): void
    /** Register a binary operator. */
    addBinaryOp(operator: string, precedence: number, fn: JexlTransform): void
    /** Build an expression object WITHOUT parsing it — call `.compile()` to parse. */
    createExpression(expression: string): JexlExpression
    /** Parse an expression, throwing on invalid syntax. */
    compile(expression: string): JexlExpression
    /** Evaluate an expression synchronously against a context object. */
    evalSync(expression: string, context?: Record<string, unknown>): unknown
    /** Evaluate an expression asynchronously against a context object. */
    eval(expression: string, context?: Record<string, unknown>): Promise<unknown>
  }

  /**
   * The module's default export: a ready-made engine that also exposes the `Jexl` class.
   *
   * `Jexl` is reachable BOTH as the named export declared above and on this default — verified
   * against the installed package, whose top-level keys are `Jexl`, `default` and
   * `module.exports` — so either access path type-checks without a cast.
   */
  const jexl: Jexl & { Jexl: typeof Jexl }
  export default jexl
}
