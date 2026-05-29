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
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'

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
 * Convert common LaTeX/KaTeX notation to a mathjs-evaluable expression.
 */
function latexToMathjs(latex: string): string {
  let expr = latex.trim()

  expr = expr.replace(/^\$\$?|\$\$?$/g, '')
  expr = expr.replace(/^\\[[(]|\\[\])]$/g, '')

  for (let i = 0; i < 10; i++) {
    const before = expr
    expr = expr.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
    if (expr === before) break
  }

  expr = expr.replace(/\\sqrt\[([^\]]+)\]\s*\{([^{}]*)\}/g, 'nthRoot($2, $1)')
  expr = expr.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)')

  expr = expr.replace(
    /\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|abs|det)/g,
    '$1'
  )

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
 * Translates a LaTeX/KaTeX expression into mathjs syntax, evaluates it, and returns the result.
 *
 * @remarks
 * Translates common LaTeX constructs (`\frac{a}{b}`, `\sqrt{...}`, `\cdot`, `\times`, Greek
 * macros like `\pi`, `\left`/`\right` delimiters, `\text{...}`, subscripts, etc.) into their
 * mathjs equivalents before evaluation. Both the source and the translated mathjs expression
 * are subject to the 1000-character length cap.
 *
 * Parse and evaluation errors are returned as error strings rather than thrown.
 */
export const evaluateKatexTool = new Tool({
  name: 'evaluate_katex',
  description: 'Evaluate a KaTeX/LaTeX math expression and return the numeric result.',
  inputSchema: validator.object({
    katex: validator
      .string()
      .required()
      .description('LaTeX expression, e.g. "\\frac{1}{2} + \\sqrt{9}"'),
  }),
  handler: async (args) => {
    const { katex } = args as { katex: string }

    const lengthError = validateExpression(katex)
    if (lengthError) return lengthError

    try {
      const mathjsExpr = latexToMathjs(katex)

      const translatedLengthError = validateExpression(mathjsExpr)
      if (translatedLengthError) return translatedLengthError

      const result = math.evaluate!(mathjsExpr)
      return `Converted: ${mathjsExpr}\nResult: ${result}`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})
