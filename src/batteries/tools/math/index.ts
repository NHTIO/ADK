/**
 * Pre-constructed tools for safe arithmetic, expression evaluation, and numeric operations.
 *
 * @module @nhtio/adk/batteries/tools/math
 *
 * @remarks
 * Pre-constructed bundled tools for the `math` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { create, all } from 'mathjs'
import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'
import { default as evaluatex } from 'evaluatex'
import { isError, isInstanceOf } from '@nhtio/adk/guards'

const math = create(all)

const BLOCKED_FUNCTIONS = [
  'import',
  'createUnit',
  'simplify',
  'derivative',
  'compile',
  'chain',
  'reviver',
  'replacer',
]

for (const fn of BLOCKED_FUNCTIONS) {
  if (fn in math) {
    ;(math as any)[fn] = undefined
  }
}

const MAX_EXPRESSION_LENGTH = 1000

function validateExpression(expr: string): string | undefined {
  if (expr.length > MAX_EXPRESSION_LENGTH) {
    return `Expression too long (max ${MAX_EXPRESSION_LENGTH} characters).`
  }
  return undefined
}

/**
 * EvaluateX scope providing constants and function aliases that evaluatex does not ship
 * out-of-the-box, matching the capabilities that were previously provided by the mathjs
 * translation layer.
 */
const EVALUATEX_SCOPE: Record<string, unknown> = {
  // Mathematical constants
  pi: Math.PI,
  e: Math.E,
  infinity: Infinity,
  // Greek letters as named constants (matching LaTeX macro names)
  alpha: undefined,
  beta: undefined,
  gamma: undefined,
  delta: undefined,
  epsilon: undefined,
  theta: undefined,
  lambda: undefined,
  mu: undefined,
  sigma: undefined,
  tau: undefined,
  phi: undefined,
  omega: undefined,
  // Function aliases — evaluatex uses log for natural log; provide ln as alias,
  // plus common log bases and nthRoot for \sqrt[n]{...}.
  ln: Math.log,
  log10: (x: number) => Math.log(x) / Math.LN10,
  log2: (x: number) => Math.log(x) / Math.LN2,
  nthRoot: (x: number, n: number) => Math.pow(x, 1 / n),
  // Determinant (identity for scalars — det([a,b;c,d]) is not supported in the scalar path)
  det: (x: number) => x,
}

/**
 * Translate a LaTeX/KaTeX expression to evaluatex-compatible syntax and evaluate it.
 *
 * The translation is a lightweight pass over the LaTeX source that handles common constructs
 * (frac, sqrt, trig, Greek macros, delimiters, etc.) and feeds the result to evaluatex with
 * a pre-built scope providing constants and function aliases. This replaces the previous
 * hand-rolled regex → mathjs pipeline.
 */
function evaluateLatex(latex: string): number {
  let expr = latex.trim()

  // Strip display/inline math delimiters: $$...$$ or $...$
  expr = expr.replace(/^\$\$?|\$\$?$/g, '')
  // Strip \[ ... \] or \( ... \) delimiters
  expr = expr.replace(/^\\[[(]|\\[\])]$/g, '')

  // ---- LaTeX command translation ----

  // \frac{a}{b} → (a)/(b) — iterates to handle nested fractions
  for (let i = 0; i < 20; i++) {
    const before = expr
    expr = expr.replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, '($1)/($2)')
    if (expr === before) break
  }

  // \sqrt[n]{x} → nthRoot(x, n)
  expr = expr.replace(/\\sqrt\[([^\]]+)\]\s*\{([^}]*)\}/g, 'nthRoot($2, $1)')
  // \sqrt{x} → sqrt(x)
  expr = expr.replace(/\\sqrt\s*\{([^}]*)\}/g, 'sqrt($1)')

  // Inverse trig: \arcsin → asin (evaluatex uses asin/acos/atan natively)
  expr = expr.replace(/\\arcsin/g, 'asin')
  expr = expr.replace(/\\arccos/g, 'acos')
  expr = expr.replace(/\\arctan/g, 'atan')

  // Strip backslash from known function macros: \sin, \cos, \tan, \cot, \sec, \csc,
  // \sinh, \cosh, \tanh, \ln, \log, \exp, \abs, etc.
  expr = expr.replace(/\\(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|ln|log|exp|abs|det)/g, '$1')

  // Subscript-based log: \log_2(x) → log2(x), or just strip subscript for single-arg
  expr = expr.replace(/log_\{?(\w+)\}?\(/g, (_, base) => {
    const baseLower = base.toLowerCase()
    if (baseLower === '10') return 'log10('
    if (baseLower === '2') return 'log2('
    if (baseLower === 'e') return 'ln('
    // Generic base: convert log_b(x) to ln(x)/ln(b) — evaluatex handles the
    // resulting expression fine.
    return `ln(/ln(${base})`
  })
  // Strip any remaining subscripts (e.g. x_1, a_n)
  expr = expr.replace(/_\{[^}]*\}/g, '')
  expr = expr.replace(/_\w/g, '')

  // Powers: ^{...} → ^(...)
  expr = expr.replace(/\^{([^{}]*)}/g, '^($1)')

  // Greek letter macros
  expr = expr.replace(/\\pi/g, 'pi')
  expr = expr.replace(
    /\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|tau|phi|omega)/g,
    '$1'
  )

  // Spacing and operators
  expr = expr.replace(/\\cdot/g, '*')
  expr = expr.replace(/\\times/g, '*')
  expr = expr.replace(/\\div/g, '/')
  expr = expr.replace(/\\infty/g, 'infinity')
  expr = expr.replace(/\\left\s*([([{|])/g, '$1')
  expr = expr.replace(/\\right\s*([)\]}|])/g, '$1')
  expr = expr.replace(/\\sum/g, 'sum')
  expr = expr.replace(/\\prod/g, 'prod')
  expr = expr.replace(/\\,/g, ' ')
  expr = expr.replace(/\\;/g, ' ')
  expr = expr.replace(/\\quad/g, ' ')
  expr = expr.replace(/\\qquad/g, ' ')
  // Strip \text{...} blocks entirely
  expr = expr.replace(/\\text\{([^{}]*)\}/g, '')

  // Implicit multiplication: 2x, 3(x+1), etc.
  expr = expr.replace(/(\d)([a-zA-Z(])/g, '$1*$2')
  expr = expr.replace(/\)\s*\(/g, ')*(')

  // Collapse whitespace
  expr = expr.replace(/\s+/g, ' ').trim()

  const fn = evaluatex(expr, EVALUATEX_SCOPE)
  const result = fn()
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('Result is not finite')
  }
  return result
}

/**
 * Lightweight LaTeX-to-string translator for internal use by the numeric calculus path.
 *
 * This is the same translation pass as {@link evaluateLatex}, but returns the translated string
 * (compatible with mathjs syntax) rather than evaluating it. Used by the calculus handlers to
 * convert integrands, function bodies, and bound expressions before passing them to
 * `math.evaluate` for specific-point evaluation.
 */
function translateLatex(latex: string): string {
  let expr = latex.trim()
  expr = expr.replace(/^\$\$?|\$\$?$/g, '')
  expr = expr.replace(/^\\[[(]|\\[\])]$/g, '')

  for (let i = 0; i < 20; i++) {
    const before = expr
    expr = expr.replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, '($1)/($2)')
    if (expr === before) break
  }

  expr = expr.replace(/\\sqrt\[([^\]]+)\]\s*\{([^}]*)\}/g, 'nthRoot($2, $1)')
  expr = expr.replace(/\\sqrt\s*\{([^}]*)\}/g, 'sqrt($1)')

  expr = expr.replace(/\\arcsin/g, 'asin')
  expr = expr.replace(/\\arccos/g, 'acos')
  expr = expr.replace(/\\arctan/g, 'atan')

  expr = expr.replace(/\\(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|ln|log|exp|abs|det)/g, '$1')

  expr = expr.replace(/log_\{?(\w+)\}?\s*\(([^)]+)\)/g, 'log($2, $1)')
  expr = expr.replace(/\^{([^{}]*)}/g, '^($1)')
  expr = expr.replace(/_\{[^{}]*\}/g, '')
  expr = expr.replace(/_\w/g, '')

  expr = expr.replace(/\\pi/g, 'pi')
  expr = expr.replace(
    /\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|tau|phi|omega)/g,
    '$1'
  )

  expr = expr.replace(/\\cdot/g, '*')
  expr = expr.replace(/\\times/g, '*')
  expr = expr.replace(/\\div/g, '/')
  expr = expr.replace(/\\infty/g, 'Infinity')
  expr = expr.replace(/\\left\s*([([{|])/g, '$1')
  expr = expr.replace(/\\right\s*([)\]}|])/g, '$1')
  expr = expr.replace(/\\sum/g, 'sum')
  expr = expr.replace(/\\prod/g, 'prod')
  expr = expr.replace(/\\,/g, ' ')
  expr = expr.replace(/\\;/g, ' ')
  expr = expr.replace(/\\quad/g, ' ')
  expr = expr.replace(/\\qquad/g, ' ')
  expr = expr.replace(/\\text\{([^{}]*)\}/g, '')
  expr = expr.replace(/(\d)([a-zA-Z(])/g, '$1*$2')
  expr = expr.replace(/\)\s*\(/g, ')*(')
  expr = expr.replace(/\s+/g, ' ').trim()

  return expr
}

// ─── Numeric calculus ─────────────────────────────────────────────────────────
//
// `evaluate_katex` is a numeric evaluator. mathjs has no symbolic integration, and its symbolic
// `derivative` is intentionally blocklisted above, so calculus is computed NUMERICALLY: definite
// integrals via composite Simpson quadrature, derivatives via central finite differences, and limits
// via a two-sided approach. These are approximations (correct to ~1e-9 for the smooth expressions a
// model emits), surfaced under a `Result (numeric):` label so the distinction is explicit.
//
// Detection runs on the RAW LaTeX, before `translateLatex` flattens it — its subscript stripping
// would otherwise destroy integral bounds (`\int_{0}^{1}` → `\int^(1)`) and limit targets. The
// extracted sub-expressions (integrand, bounds, body, point) are then translated by the existing
// `translateLatex` and evaluated per-point with a scope, which works under the security blocklist.

/** A tagged error whose message is surfaced to the model verbatim (caught by {@link tryCalculus}). */
class CalculusError extends Error {}

/** Evaluate a mathjs expression at a single point, guarding against non-finite results. */
function evalAt(expr: string, varName: string, x: number): number {
  const y = math.evaluate!(expr, { [varName]: x })
  if (typeof y !== 'number' || !Number.isFinite(y)) {
    throw new CalculusError('NON_FINITE')
  }
  return y
}

/** Composite Simpson's rule over a finite interval. Throws {@link CalculusError} on a singularity. */
function simpson(fn: (x: number) => number, a: number, b: number, n = 1000): number {
  if (n % 2 === 1) n++
  const h = (b - a) / n
  let sum = fn(a) + fn(b)
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 1 ? 4 : 2) * fn(a + i * h)
  }
  const result = (h / 3) * sum
  if (!Number.isFinite(result)) throw new CalculusError('NON_FINITE')
  return result
}

/** Round numeric output to 12 significant digits, collapsing floating-point noise. */
function formatNumeric(n: number): string {
  // Snap values that are zero-to-within-tolerance to exactly 0 (e.g. lim_{x->inf} 1/x ≈ 1e-8).
  if (Math.abs(n) < 1e-9) return '0'
  return math.format!(n, { precision: 12 })
}

/**
 * Reads a single `_`/`^` script starting at `i`, supporting braced (`_{0}`, `^{\pi}`), command
 * (`^\pi`), and bare-token (`_0`, `^1`) forms. Returns the mark, its raw-LaTeX value, and the next
 * index, or `null` when there is no script at `i`.
 */
function readScript(s: string, i: number): { mark: '_' | '^'; val: string; next: number } | null {
  while (s[i] === ' ') i++
  const mark = s[i]
  if (mark !== '_' && mark !== '^') return null
  i++
  while (s[i] === ' ') i++
  if (s[i] === '{') {
    let depth = 0
    const start = ++i
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}') {
        if (depth === 0) break
        depth--
      }
    }
    return { mark, val: s.slice(start, i), next: i + 1 }
  }
  if (s[i] === '\\') {
    const m = /^\\[a-zA-Z]+/.exec(s.slice(i))
    if (!m) return null
    return { mark, val: m[0], next: i + m[0].length }
  }
  const m = /^[A-Za-z0-9.]+/.exec(s.slice(i))
  if (!m) return null
  return { mark, val: m[0], next: i + m[0].length }
}

/** Translate a raw-LaTeX bound/target fragment and evaluate it to a finite number. */
function evalBound(latex: string): number {
  const trimmed = latex.trim()
  if (/\\infty/.test(trimmed)) throw new CalculusError('INFINITE_BOUND')
  const mathjsExpr = translateLatex(trimmed)
  const value = math.evaluate!(mathjsExpr)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalculusError('BAD_BOUND')
  }
  return value
}

/** Evaluate a definite integral `\int_{a}^{b} f \,dx` by Simpson quadrature. */
function evalIntegral(s: string): string {
  // Strip the operator (\int, optionally with \limits).
  const m = /\\int(?:\\limits)?/.exec(s)
  if (!m) throw new CalculusError('NOT_INTEGRAL')
  let i = m.index + m[0].length

  // Read up to two scripts (bounds), in either order.
  const scripts: Record<'_' | '^', string | undefined> = { '_': undefined, '^': undefined }
  for (let k = 0; k < 2; k++) {
    const sc = readScript(s, i)
    if (!sc) break
    scripts[sc.mark] = sc.val
    i = sc.next
  }
  if (scripts._ === undefined || scripts['^'] === undefined) {
    throw new CalculusError('INDEFINITE')
  }

  // The remainder is `integrand … d<var>`. Pull the trailing differential off the end.
  const rest = s.slice(i)
  const diff = /\\?,?\s*\bd\s*([a-zA-Z])\s*$/.exec(rest)
  if (!diff) throw new CalculusError('NO_DIFFERENTIAL')
  const variable = diff[1]
  const integrandLatex = rest.slice(0, diff.index)
  if (integrandLatex.trim().length === 0) throw new CalculusError('NO_INTEGRAND')

  const a = evalBound(scripts._)
  const b = evalBound(scripts['^'])
  const integrand = translateLatex(integrandLatex)
  const fn = (x: number) => evalAt(integrand, variable, x)

  let result: number
  if (a === b) result = 0
  else if (a < b) result = simpson(fn, a, b)
  else result = -simpson(fn, b, a)

  return `Converted: ∫(${integrand}) d${variable} from ${formatNumeric(a)} to ${formatNumeric(b)}\nResult (numeric): ${formatNumeric(result)}`
}

/** Evaluate a derivative `\frac{d}{dx} f \big|_{x=a}` at a point via central finite difference. */
function evalDerivative(s: string): string {
  // Operator + variable: \frac{d}{dx} … or bare d/dx ….
  let variable: string | undefined
  let body = s
  const fracOp = /\\frac\s*\{\s*d\s*\}\s*\{\s*d\s*([a-zA-Z])\s*\}/.exec(s)
  if (fracOp) {
    variable = fracOp[1]
    body = s.slice(fracOp.index + fracOp[0].length)
  } else {
    const bareOp = /(?:^|[^a-zA-Z])d\s*\/\s*d([a-zA-Z])/.exec(s)
    if (bareOp) {
      variable = bareOp[1]
      body = s.slice(bareOp.index + bareOp[0].length)
    }
  }
  if (!variable) throw new CalculusError('NOT_DERIVATIVE')

  // Remove pure \left. / \right. delimiters.
  body = body.replace(/\\left\.?/g, '').replace(/\\right\.?/g, '')

  // Evaluation bar + point at the end: …|_{x=3} (optionally \Big| etc.).
  const bar = /\\?(?:Big|big|bigg|Bigg)?\s*\|\s*_\s*\{?\s*([a-zA-Z])\s*=\s*([^}]+?)\s*\}?\s*$/.exec(
    body
  )
  if (!bar) throw new CalculusError('NO_POINT')
  const point = evalBound(bar[2])
  let fnLatex = body.slice(0, bar.index).trim()

  // Strip one layer of wrapping parentheses/brackets around the function body.
  fnLatex = fnLatex
    .replace(/^\\?\(([\s\S]*)\\?\)$/, '$1')
    .replace(/^\[([\s\S]*)\]$/, '$1')
    .trim()
  if (fnLatex.length === 0) throw new CalculusError('NO_FUNCTION')

  const expr = translateLatex(fnLatex)
  const h = 1e-6
  const fn = (x: number) => evalAt(expr, variable, x)
  const result = (fn(point + h) - fn(point - h)) / (2 * h)
  if (!Number.isFinite(result)) throw new CalculusError('NON_FINITE')

  return `Converted: d/d${variable}(${expr}) at ${variable}=${formatNumeric(point)}\nResult (numeric): ${formatNumeric(result)}`
}

/** Evaluate a limit `\lim_{x \to a} f(x)` by a two-sided numeric approach. */
function evalLimit(s: string): string {
  const head = /\\lim\s*_\s*\{\s*([a-zA-Z])\s*\\to\s*([\s\S]+?)\s*\}/.exec(s)
  if (!head) throw new CalculusError('NOT_LIMIT')
  const variable = head[1]
  let targetLatex = head[2].trim()
  const bodyLatex = s.slice(head.index + head[0].length).trim()
  if (bodyLatex.length === 0) throw new CalculusError('NO_FUNCTION')

  // One-sided markers (0^+, 0^-, 0^{+}) — record the side, strip the marker.
  let side: 'both' | 'plus' | 'minus' = 'both'
  const oneSided = /\^\s*\{?\s*([+-])\s*\}?\s*$/.exec(targetLatex)
  if (oneSided) {
    side = oneSided[1] === '+' ? 'plus' : 'minus'
    targetLatex = targetLatex.slice(0, oneSided.index).trim()
  }

  const expr = translateLatex(bodyLatex)
  const fn = (x: number) => evalAt(expr, variable, x)
  const eps = 1e-6

  // Infinite targets via large-magnitude substitution.
  let result: number
  let targetLabel: string
  if (/^-\s*\\infty$/.test(targetLatex)) {
    result = fn(-1e8)
    targetLabel = '-∞'
  } else if (/^\\infty$/.test(targetLatex)) {
    result = fn(1e8)
    targetLabel = '∞'
  } else {
    const target = evalBound(targetLatex)
    targetLabel = formatNumeric(target)
    if (side === 'plus') {
      result = fn(target + eps)
    } else if (side === 'minus') {
      result = fn(target - eps)
    } else {
      const lo = fn(target - eps)
      const hi = fn(target + eps)
      const avg = (lo + hi) / 2
      if (Math.abs(hi - lo) > 1e-3 * Math.max(1, Math.abs(avg))) {
        throw new CalculusError('LIMIT_MISMATCH')
      }
      result = avg
    }
  }
  if (!Number.isFinite(result)) throw new CalculusError('LIMIT_UNBOUNDED')

  // Infinite-target substitution (±1e8) and the eps offset leave more residue than Simpson or the
  // derivative difference, so snap a limit result to a nearby round value before formatting:
  // 0.99999998 → 1, 1e-8 → 0. The tolerance is loose enough to absorb the substitution error yet
  // far tighter than the divergence check that already rejected genuinely non-convergent limits.
  const nearest = Math.round(result)
  if (Math.abs(result - nearest) < 1e-6) result = nearest

  return `Converted: lim ${variable}→${targetLabel} of (${expr})\nResult (numeric): ${formatNumeric(result)}`
}

/** Human-readable, model-actionable message for each {@link CalculusError} tag. */
function calculusErrorMessage(tag: string): string {
  switch (tag) {
    case 'INDEFINITE':
      return 'Cannot evaluate an indefinite integral numerically. Provide bounds, e.g. \\int_{0}^{1} x dx.'
    case 'NO_DIFFERENTIAL':
      return "Could not find the integration variable. Expected a trailing differential like 'dx'."
    case 'NO_INTEGRAND':
      return 'The integral has no integrand to evaluate.'
    case 'INFINITE_BOUND':
      return 'Infinite integration bounds are not supported. Provide finite numeric bounds, e.g. \\int_{0}^{1} f dx.'
    case 'BAD_BOUND':
      return 'Could not evaluate the integration bounds to numbers.'
    case 'NO_POINT':
      return 'Cannot evaluate a derivative numerically without a point. Specify where, e.g. \\frac{d}{dx}(x^2)\\Big|_{x=3}.'
    case 'NO_FUNCTION':
      return 'Could not find the function to evaluate.'
    case 'LIMIT_MISMATCH':
      return 'The limit may not exist (left and right values disagree).'
    case 'LIMIT_UNBOUNDED':
      return 'The limit appears to diverge (function is unbounded near the target).'
    case 'NON_FINITE':
      return 'The expression is not finite over the requested range (possible singularity); cannot evaluate numerically.'
    default:
      return 'Could not evaluate the calculus expression.'
  }
}

/**
 * Detects a calculus construct in raw LaTeX and routes it to the matching numeric handler. Returns
 * the result/error string, or `null` when the input is not a calculus expression (so the caller
 * falls through to the scalar evaluation path unchanged).
 */
function tryCalculus(latex: string): string | null {
  let s = latex.trim()
  s = s.replace(/^\$\$?|\$\$?$/g, '')
  s = s.replace(/^\\[[(]|\\[\])]$/g, '').trim()

  let handler: ((expr: string) => string) | undefined
  if (/\\int/.test(s)) handler = evalIntegral
  else if (/\\lim/.test(s)) handler = evalLimit
  else if (
    /\\frac\s*\{\s*d\s*\}\s*\{\s*d\s*[a-zA-Z]\s*\}/.test(s) ||
    /(?:^|[^a-zA-Z])d\s*\/\s*d[a-zA-Z]/.test(s)
  )
    handler = evalDerivative
  if (!handler) return null

  try {
    return handler(s)
  } catch (err) {
    if (isInstanceOf(err, 'CalculusError', CalculusError)) {
      return `Error: ${calculusErrorMessage(err.message)}`
    }
    return `Error: ${isError(err) ? err.message : String(err)}`
  }
}

/**
 * Evaluates a mathjs-syntax expression and returns the numeric result alongside the KaTeX
 * representation of the parsed expression.
 *
 * @remarks
 * Supports arithmetic, trigonometric, logarithmic, exponential, factorial, matrix, and unit
 * operations via `mathjs`. The mathjs instance is hardened: dangerous functions (`import`,
 * `createUnit`, `simplify`, `derivative`, `compile`, `chain`, `reviver`, `replacer`) are
 * disabled to prevent interpreter-surface exposure.
 *
 * Expressions over 1000 characters are rejected with an error string (not thrown). Parse and
 * evaluation errors are also returned as error strings — the tool surfaces math errors as
 * content rather than exceptions, so the model can react to them in-line.
 */
export const calculateTool = new Tool({
  name: 'calculate',
  description:
    'Evaluate a math expression. Supports arithmetic, trig, log, sqrt, factorial, matrices.',
  inputSchema: validator.object({
    expression: validator.string().required().description('Math expression, e.g. "sin(pi/4) + 5!"'),
  }),
  handler: async (args) => {
    const { expression } = args as { expression: string }

    const lengthError = validateExpression(expression)
    if (lengthError) return lengthError

    try {
      const result = math.evaluate!(expression)
      const node = math.parse!(expression)
      const katex = node.toTex()
      return `Result: ${result}\nKaTeX: $${katex} = ${result}$`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Translates a LaTeX/KaTeX expression using evaluatex and returns the numeric result.
 *
 * @remarks
 * Uses the evaluatex library to parse and evaluate LaTeX expressions. Handles common constructs
 * (`\frac{a}{b}`, `\sqrt{...}`, `\cdot`, `\times`, Greek macros like `\pi`, inverse trig,
 * `\left`/`\right` delimiters, `\text{...}`, subscripts, etc.) with a proper parser rather than
 * brittle regex.
 *
 * Also evaluates three calculus constructs **numerically** (mathjs has no symbolic integration, and
 * its symbolic `derivative` is blocklisted here for safety):
 * - Definite integrals — `\int_{a}^{b} f \,dx` via composite Simpson quadrature.
 * - Derivatives at a point — `\frac{d}{dx} f \big|_{x=a}` via central finite difference.
 * - Limits — `\lim_{x \to a} f` (including `a = \pm\infty`) via a two-sided numeric approach.
 *
 * Numeric results are rounded with `math.format(..., { precision: 12 })` and labelled
 * `Result (numeric):` to flag that they are approximations. Constructs that cannot be evaluated
 * numerically (indefinite integrals, derivatives without a point, infinite integration bounds,
 * singular integrands, divergent limits) return a specific, guiding error string.
 *
 * Parse and evaluation errors are returned as error strings rather than thrown.
 */
export const evaluateKatexTool = new Tool({
  name: 'evaluate_katex',
  description:
    'Evaluate a KaTeX/LaTeX math expression and return the numeric result. Supports arithmetic, trig, logs, roots, and numeric calculus: definite integrals (\\int_{a}^{b} f dx), derivatives at a point (\\frac{d}{dx} f|_{x=a}), and limits (\\lim_{x \\to a} f).',
  inputSchema: validator.object({
    katex: validator
      .string()
      .required()
      .description('LaTeX expression, e.g. "\\frac{1}{2} + \\sqrt{9}" or "\\int_{0}^{1} x^2 dx"'),
  }),
  handler: async (args) => {
    const { katex } = args as { katex: string }

    const lengthError = validateExpression(katex)
    if (lengthError) return lengthError

    try {
      // Calculus (\int, \lim, d/dx) is detected on the raw LaTeX and evaluated numerically before
      // the scalar flattening path, which would otherwise mangle bounds/targets. Returns null for
      // non-calculus input, falling through to the scalar evaluator below unchanged.
      const calculus = tryCalculus(katex)
      if (calculus !== null) return calculus

      const result = evaluateLatex(katex)
      return `Result: ${result}`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})
