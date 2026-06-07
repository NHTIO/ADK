import { describe, expect, it } from 'vitest'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { calculateTool, evaluateKatexTool } from '../../../../../src/batteries/tools/math'
import type { DispatchContext } from '../../../../../src/lib/contracts/dispatch_context'

/** Minimal duck-typed DispatchContext stub for unit-testing tool executors. */
const makeCtxStub = () =>
  ({
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
  }) as unknown as DispatchContext

const runCalculate = async (expression: string): Promise<string> => {
  const ctx = makeCtxStub()
  const result = await calculateTool.executor(ctx)({ expression })
  return result as string
}

const runEvaluateKatex = async (katex: string): Promise<string> => {
  const ctx = makeCtxStub()
  const result = await evaluateKatexTool.executor(ctx)({ katex })
  return result as string
}

describe('calculateTool', () => {
  describe('basic arithmetic', () => {
    it('evaluates `2 + 2` to 4', async () => {
      const out = await runCalculate('2 + 2')
      expect(out).toContain('Result: 4')
    })

    it('evaluates `10 - 3` to 7', async () => {
      const out = await runCalculate('10 - 3')
      expect(out).toContain('Result: 7')
    })

    it('evaluates `6 * 7` to 42', async () => {
      const out = await runCalculate('6 * 7')
      expect(out).toContain('Result: 42')
    })

    it('evaluates `100 / 4` to 25', async () => {
      const out = await runCalculate('100 / 4')
      expect(out).toContain('Result: 25')
    })

    it('respects operator precedence: `2 + 3 * 4` evaluates to 14', async () => {
      const out = await runCalculate('2 + 3 * 4')
      expect(out).toContain('Result: 14')
    })
  })

  describe('trigonometric functions', () => {
    it('evaluates `sin(pi/4)` to approximately 0.7071', async () => {
      const out = await runCalculate('sin(pi/4)')
      expect(out).toMatch(/Result: 0\.707/)
    })

    it('evaluates `cos(0)` to 1', async () => {
      const out = await runCalculate('cos(0)')
      expect(out).toContain('Result: 1')
    })

    it('evaluates `tan(pi/4)` to approximately 1', async () => {
      const out = await runCalculate('tan(pi/4)')
      // tan(pi/4) is theoretically 1 but typically returns 0.9999... due to floating-point
      expect(out).toMatch(/Result: (1|0\.999)/)
    })
  })

  describe('logarithms and powers', () => {
    it('evaluates `log(100, 10)` to 2', async () => {
      const out = await runCalculate('log(100, 10)')
      expect(out).toContain('Result: 2')
    })

    it('evaluates `sqrt(9)` to 3', async () => {
      const out = await runCalculate('sqrt(9)')
      expect(out).toContain('Result: 3')
    })

    it('evaluates `2^10` to 1024', async () => {
      const out = await runCalculate('2^10')
      expect(out).toContain('Result: 1024')
    })

    it('evaluates `exp(0)` to 1', async () => {
      const out = await runCalculate('exp(0)')
      expect(out).toContain('Result: 1')
    })
  })

  describe('factorials', () => {
    it('evaluates `5!` to 120', async () => {
      const out = await runCalculate('5!')
      expect(out).toContain('Result: 120')
    })

    it('evaluates `0!` to 1', async () => {
      const out = await runCalculate('0!')
      expect(out).toContain('Result: 1')
    })
  })

  describe('matrices', () => {
    it('evaluates `[1, 2; 3, 4]` to a 2x2 matrix', async () => {
      const out = await runCalculate('[1, 2; 3, 4]')
      expect(out).toContain('Result:')
      expect(out).toMatch(/\[\[1,\s*2\],\s*\[3,\s*4\]\]/)
    })
  })

  describe('KaTeX output', () => {
    it('includes a KaTeX line in the result', async () => {
      const out = await runCalculate('2 + 2')
      expect(out).toContain('KaTeX:')
      expect(out).toContain('$')
    })
  })

  describe('safety: blocked mathjs functions', () => {
    const blocked = [
      'import',
      'createUnit',
      'simplify',
      'derivative',
      'compile',
      'chain',
      'reviver',
      'replacer',
    ]
    for (const fn of blocked) {
      it(`does not allow calling \`${fn}(...)\` from within an expression`, async () => {
        const out = await runCalculate(`${fn}(1)`)
        // The expression must NOT succeed and return a successful "Result:" line — calling
        // a disabled function should either error or yield something non-functional.
        // mathjs typically raises an "undefined function" or similar.
        expect(out).toMatch(/Error:/)
      })
    }
  })

  describe('length cap', () => {
    it('rejects expressions exceeding 1000 characters with a documented error string', async () => {
      const longExpr = '1+'.repeat(501) + '1' // 1003 chars
      const out = await runCalculate(longExpr)
      expect(out).toContain('Expression too long')
      expect(out).toContain('1000')
    })
  })

  describe('invalid expressions', () => {
    it('returns an error string (not throw) for malformed input', async () => {
      const out = await runCalculate('2 + ')
      expect(out).toMatch(/Error:/)
    })

    it('returns an error string when referencing an unknown symbol', async () => {
      const out = await runCalculate('totallyUnknownFunction(5)')
      expect(out).toMatch(/Error:/)
    })
  })

  describe('schema rejection', () => {
    it('throws E_INVALID_TOOL_ARGS when no expression argument is provided', async () => {
      const ctx = makeCtxStub()
      await expect(calculateTool.executor(ctx)({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('throws E_INVALID_TOOL_ARGS when expression is not a string', async () => {
      const ctx = makeCtxStub()
      await expect(calculateTool.executor(ctx)({ expression: 42 })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })

  describe('tool surface', () => {
    it('has name `calculate`', () => {
      expect(calculateTool.name).toBe('calculate')
    })

    it('has a description that mentions math', () => {
      expect(calculateTool.description.toLowerCase()).toContain('math')
    })
  })
})

describe('evaluateKatexTool', () => {
  describe('basic LaTeX evaluation', () => {
    it('evaluates `\\frac{1}{2} + \\sqrt{9}` to 3.5', async () => {
      const out = await runEvaluateKatex('\\frac{1}{2} + \\sqrt{9}')
      expect(out).toContain('Result: 3.5')
    })

    it('evaluates `\\sin(\\pi/4)` and matches pi/4 value', async () => {
      const out = await runEvaluateKatex('\\sin(\\pi/4)')
      expect(out).toMatch(/Result: 0\.7071/)
    })

    it('translates `\\cdot` to multiplication', async () => {
      const out = await runEvaluateKatex('3 \\cdot 4')
      expect(out).toContain('Result: 12')
    })

    it('translates `\\times` to multiplication', async () => {
      const out = await runEvaluateKatex('3 \\times 4')
      expect(out).toContain('Result: 12')
    })

    it('translates `\\div` to division', async () => {
      const out = await runEvaluateKatex('12 \\div 3')
      expect(out).toContain('Result: 4')
    })

    it('strips `\\left` and `\\right` delimiters', async () => {
      const out = await runEvaluateKatex('\\left( 2 + 3 \\right) * 4')
      expect(out).toContain('Result: 20')
    })

    it('strips `\\text{...}` blocks', async () => {
      const out = await runEvaluateKatex('2 + 3 \\text{hello}')
      expect(out).toMatch(/Result: 5/)
    })

    it('maps inverse trig: `\\arctan(1)` ~ 0.7854', async () => {
      const out = await runEvaluateKatex('\\arctan(1)')
      expect(out).toMatch(/Result: 0\.78539/)
    })
  })

  describe('Greek letter macros', () => {
    it('maps `\\pi` to pi', async () => {
      const out = await runEvaluateKatex('\\pi')
      expect(out).toMatch(/Result: 3\.14/)
    })

    it('Greek macros (e.g. `\\alpha`) are stripped of the backslash — undefined Greek letters become unknown-variable errors', async () => {
      // \alpha gets translated to bare `alpha`. From our evaluatex scope, `alpha` is defined
      // as undefined, so the expression `undefined + 1` yields NaN which gets caught as an error.
      const out = await runEvaluateKatex('\\alpha + 1')
      expect(out).toMatch(/Error:/)
    })
  })

  describe('Result format', () => {
    it('exposes the numeric result', async () => {
      const out = await runEvaluateKatex('\\frac{6}{2}')
      expect(out).toContain('Result: 3')
    })
  })

  describe('length cap', () => {
    it('rejects KaTeX exceeding 1000 characters with the documented error string', async () => {
      const longKatex = '\\frac{1}{2} + '.repeat(80) + '0' // > 1000 chars
      const out = await runEvaluateKatex(longKatex)
      expect(out).toContain('Expression too long')
    })
  })

  describe('schema rejection', () => {
    it('throws E_INVALID_TOOL_ARGS when no katex argument is provided', async () => {
      const ctx = makeCtxStub()
      await expect(evaluateKatexTool.executor(ctx)({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('throws E_INVALID_TOOL_ARGS when katex is not a string', async () => {
      const ctx = makeCtxStub()
      await expect(evaluateKatexTool.executor(ctx)({ katex: 42 })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })

  describe('tool surface', () => {
    it('has name `evaluate_katex`', () => {
      expect(evaluateKatexTool.name).toBe('evaluate_katex')
    })

    it('has a description that mentions KaTeX or LaTeX', () => {
      expect(evaluateKatexTool.description.toLowerCase()).toMatch(/katex|latex/)
    })
  })

  // ── Numeric calculus ────────────────────────────────────────────────────────
  //
  // Calculus is computed numerically (Simpson quadrature, central finite difference, two-sided
  // limits), so results are approximations surfaced under a `Result (numeric):` label. Detection
  // runs on the raw LaTeX before the scalar flattener strips subscripts, which would otherwise
  // mangle bounds (`\int_{0}^{1}` -> `\int^(1)`).

  describe('definite integrals', () => {
    it('evaluates `\\int_{0}^{1} x dx` to 0.5', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{1} x dx')
      expect(out).toMatch(/Result \(numeric\): 0\.5\b/)
    })

    it('evaluates `\\int_{0}^{1} x^2 dx` to ~0.3333', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{1} x^2 dx')
      expect(out).toMatch(/Result \(numeric\): 0\.3333/)
    })

    it('evaluates `\\int_{0}^{\\pi} \\sin(x) dx` to 2', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{\\pi} \\sin(x) dx')
      expect(out).toMatch(/Result \(numeric\): 2\b/)
    })

    it('handles bare bounds and a nested fraction integrand: `\\int_0^1 \\frac{1}{x+1} dx` ~ ln2', async () => {
      const out = await runEvaluateKatex('\\int_0^1 \\frac{1}{x+1} dx')
      expect(out).toMatch(/Result \(numeric\): 0\.69314/)
    })

    it('evaluates `\\int_{0}^{1} e^x dx` to ~1.71828', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{1} e^x dx')
      expect(out).toMatch(/Result \(numeric\): 1\.71828/)
    })

    it('accepts swapped script order `\\int^{1}_{0} x dx`', async () => {
      const out = await runEvaluateKatex('\\int^{1}_{0} x dx')
      expect(out).toMatch(/Result \(numeric\): 0\.5\b/)
    })

    it('uses the integration variable from the differential: `\\int_{0}^{2} t dt` = 2', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{2} t dt')
      expect(out).toMatch(/Result \(numeric\): 2\b/)
    })

    it('rejects an indefinite integral with guidance', async () => {
      const out = await runEvaluateKatex('\\int x dx')
      expect(out).toMatch(/indefinite integral/i)
      expect(out).toContain('\\int_{0}^{1} x dx')
    })

    it('reports a singular integrand rather than NaN: `\\int_{0}^{1} \\frac{1}{x} dx`', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{1} \\frac{1}{x} dx')
      expect(out).toMatch(/singularity|not finite/i)
    })

    it('rejects infinite bounds: `\\int_{0}^{\\infty} x dx`', async () => {
      const out = await runEvaluateKatex('\\int_{0}^{\\infty} x dx')
      expect(out).toMatch(/Infinite integration bounds/i)
    })
  })

  describe('derivatives at a point', () => {
    it('evaluates `\\frac{d}{dx} (x^2) \\Big|_{x=3}` to 6', async () => {
      const out = await runEvaluateKatex('\\frac{d}{dx} (x^2) \\Big|_{x=3}')
      expect(out).toMatch(/Result \(numeric\): 6\b/)
    })

    it('supports the `\\left. … \\right|_{x=3}` evaluation-bar form', async () => {
      const out = await runEvaluateKatex('\\left. \\frac{d}{dx} x^2 \\right|_{x=3}')
      expect(out).toMatch(/Result \(numeric\): 6\b/)
    })

    it('evaluates `\\frac{d}{dx} \\sin(x) \\Big|_{x=0}` to 1', async () => {
      const out = await runEvaluateKatex('\\frac{d}{dx} \\sin(x) \\Big|_{x=0}')
      expect(out).toMatch(/Result \(numeric\): 1\b/)
    })

    it('uses the operator variable: `\\frac{d}{dt} t^3 \\Big|_{t=2}` = 12', async () => {
      const out = await runEvaluateKatex('\\frac{d}{dt} t^3 \\Big|_{t=2}')
      expect(out).toMatch(/Result \(numeric\): 12\b/)
    })

    it('rejects a derivative with no point and guides the user', async () => {
      const out = await runEvaluateKatex('\\frac{d}{dx} x^2')
      expect(out).toMatch(/without a point/i)
      expect(out).toContain('\\frac{d}{dx}')
    })
  })

  describe('limits', () => {
    it('evaluates `\\lim_{x \\to 0} \\frac{\\sin(x)}{x}` to 1', async () => {
      const out = await runEvaluateKatex('\\lim_{x \\to 0} \\frac{\\sin(x)}{x}')
      expect(out).toMatch(/Result \(numeric\): 1\b/)
    })

    it('evaluates `\\lim_{x \\to 2} x^2` to 4', async () => {
      const out = await runEvaluateKatex('\\lim_{x \\to 2} x^2')
      expect(out).toMatch(/Result \(numeric\): 4\b/)
    })

    it('evaluates `\\lim_{x \\to \\infty} \\frac{1}{x}` to 0', async () => {
      const out = await runEvaluateKatex('\\lim_{x \\to \\infty} \\frac{1}{x}')
      expect(out).toMatch(/Result \(numeric\): 0\b/)
    })

    it('evaluates `\\lim_{x \\to \\infty} \\arctan(x)` to ~1.5707', async () => {
      const out = await runEvaluateKatex('\\lim_{x \\to \\infty} \\arctan(x)')
      expect(out).toMatch(/Result \(numeric\): 1\.5707/)
    })

    it('reports divergence for `\\lim_{x \\to 0} \\frac{1}{x}`', async () => {
      const out = await runEvaluateKatex('\\lim_{x \\to 0} \\frac{1}{x}')
      expect(out).toMatch(/may not exist|diverge|unbounded/i)
    })
  })

  describe('non-calculus regression', () => {
    it('leaves the scalar path untouched: `\\frac{1}{2} + \\sqrt{9}` keeps the plain `Result:` label', async () => {
      const out = await runEvaluateKatex('\\frac{1}{2} + \\sqrt{9}')
      expect(out).toContain('Result: 3.5')
      expect(out).not.toContain('(numeric)')
    })
  })
})
