/**
 * Ambient type declaration for `evaluatex` (v2.2.0), which ships no types of its own.
 *
 * Signature mirrors the library's documented API:
 *   const fn = evaluatex(expression, constants = {}, options = {})
 *   const result = fn(variables = {})   // → number
 *
 * `evaluatex()` compiles an ASCII or LaTeX math expression into a function. The returned
 * function is invoked (optionally with runtime variables) to produce the numeric result.
 * `constants` are baked in at compile time; `options` controls the compiler (e.g. `latex`).
 */
declare module 'evaluatex' {
  /** A compiled expression: call it (optionally with runtime variables) to get the number. */
  export interface EvaluatexFn {
    (variables?: Record<string, unknown>): number
  }

  /** Compiler options for evaluatex. */
  export interface EvaluatexOptions {
    /** Force LaTeX parsing mode. */
    latex?: boolean
    [key: string]: unknown
  }

  /**
   * Compile a text/LaTeX math expression into a callable that returns a number.
   * @param expression ASCII or LaTeX expression to parse and evaluate.
   * @param constants Values baked in at compile time (constants, function aliases).
   * @param options Compiler options.
   */
  function evaluatex(
    expression: string,
    constants?: Record<string, unknown>,
    options?: EvaluatexOptions
  ): EvaluatexFn

  export default evaluatex
}
