import { RuleTester } from 'eslint'
import { describe, test } from 'vitest'
// @ts-expect-error — untyped .mjs rule module; it's a plain ESLint rule object ({ meta, create }),
// not TS-compiled, so there's no declaration file (mirrors the existing untyped-.mjs-import
// pattern in tests/agent/stress_corpus.node.spec.ts).
import { default as requireStringEmptyDisposition } from '../../../eslint-rules/rules/require-string-empty-disposition.mjs'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals; unlike
// `@typescript-eslint/rule-tester`, the plain `eslint` package's RuleTester only exposes
// `describe`/`it`/`itOnly`, no `afterAll`).
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('require-string-empty-disposition', requireStringEmptyDisposition, {
  valid: [
    // ── Simple chain — valid shapes ──────────────────────────────────────────────────────
    { code: "const s = validator.string().optional().allow('')" },
    { code: "const s = validator.string().default('x').allow('')" },
    { code: "const s = validator.string().default('').empty('')" },
    { code: "const s = validator.string().optional().valid('a', '')" },
    // Policy A: enum alone is sufficient, no '' needed.
    { code: "const s = validator.string().optional().valid('a', 'b')" },
    // required, no optional/default -> out of scope entirely.
    { code: 'const s = validator.string().required()' },
    { code: 'const s = validator.string().optional().forbidden()' },

    // ── if/else where BOTH branches reassign — outside Shape A/B's scope, so the rule
    // reports nothing here; a deliberate non-finding, not proof the else branch was reasoned
    // about specifically.
    {
      code: `
        function f(required) {
          let schema = validator.string().optional()
          if (required) schema = schema.required()
          else schema = schema.optional().allow('')
          return schema
        }
      `,
    },

    // ── The Shape-B test-expression-write counterexample (sixth adversarial review round):
    // the if TEST ITSELF writes a disposition via a comma expression, before branch selection
    // happens, so every path already has one. Shape B's test-expression restriction disqualifies
    // this from being analyzed as Shape B at all, so the rule reports nothing.
    {
      code: `
        function f(required) {
          let schema = validator.string().optional()
          if ((schema = schema.allow(''), required)) {
            schema = schema.required()
          }
          return schema
        }
      `,
    },

    // ── The two-sequential-ifs counterexample (eighth adversarial review round): TWO separate
    // qualifying-looking if statements make the final state depend on which of two independent
    // conditions is true. Shape B requires the WHOLE function to contain only one such
    // conditional write, so a second one anywhere disqualifies the variable entirely.
    {
      code: `
        function f(feature, required) {
          let schema = validator.string().optional()
          if (feature) schema = schema.allow('')
          if (required) schema = schema.required()
          return schema
        }
      `,
    },

    // ── switch statements are never analyzed, in any form — including media's own
    // granularSchemaFor shape, which the rule does NOT report on.
    {
      code: `
        function f(arg) {
          let schema
          switch (arg.type) {
            case 'number':
              schema = validator.number()
              break
            case 'enum':
              schema = validator.string().valid('a', 'b')
              break
            default:
              schema = validator.string()
              break
          }
          if (arg.required) schema = schema.required()
          return schema
        }
      `,
    },

    // ── Scope isolation — two functions, same local variable name, independent dispositions.
    {
      code: `
        function a() {
          let schema = validator.string()
          schema = schema.optional().allow('')
          return schema
        }
        function b() {
          let schema = validator.string()
          schema = schema.required()
          return schema
        }
      `,
    },

    // ── Straight-line chain SPLIT ACROSS reassignments — every modifier applied along the same
    // chain counts, no matter which assignment applied it. `buildShapeAStraightLineChain` used to
    // OVERWRITE its accumulated call list on each reassignment instead of appending, so the
    // clearing method from an earlier assignment became invisible and this reported a false
    // positive. (The scope-isolation case above does not catch this: it applies both modifiers in
    // a single reassignment.)
    {
      code: `
        function a() {
          let schema = validator.string().allow('')
          schema = schema.optional()
          return schema
        }
      `,
    },
    // Same, with the clearing method in the LAST assignment rather than the first — the union must
    // be order-independent.
    {
      code: `
        function a() {
          let schema = validator.string().optional()
          schema = schema.allow('')
          return schema
        }
      `,
    },
    // Three-hop chain: the disposition sits in the middle assignment.
    {
      code: `
        function a() {
          let schema = validator.string()
          schema = schema.empty('')
          schema = schema.optional()
          return schema
        }
      `,
    },

    // ── `var` is FUNCTION-scoped, not block-scoped: a `var` declared inside a block and reassigned
    // outside it (or vice versa) is ONE binding, and its modifiers must union across blocks. The
    // binding key must therefore hoist a `var` to its function scope — keying it to the block it
    // literally appears in would split one binding in two, losing the clearing method.
    {
      code: `
        function f(cond) {
          if (cond) {
            var schema = validator.string().allow('')
          }
          schema = schema.optional()
          return schema
        }
      `,
    },
    {
      code: `
        function f(cond) {
          var schema = validator.string().optional()
          if (cond) {
            var schema2 = validator.string().allow('')
            use(schema2)
          }
          schema = schema.allow('')
          return schema
        }
      `,
    },
    // The shape where `var` and `let` genuinely diverge: a SECOND `var` of the same name inside a
    // nested block is the SAME hoisted binding (not a shadow), so its modifiers union with the
    // outer chain. Were `var` keyed to its literal block — as `let` correctly is — this would
    // split into two bindings and the outer one would report a false positive.
    {
      code: `
        function f() {
          var schema = validator.string().optional()
          {
            var schema = schema.allow('')
          }
          return schema
        }
      `,
    },

    // ── Param-spec object-literal pattern — valid (has a clearing method).
    {
      code: "const specs = [{ key: 'x', wire: 'x', type: 'string', schema: validator.string().allow(''), description: 'd' }]",
    },
  ],

  invalid: [
    // ── Simple chain — invalid shapes ────────────────────────────────────────────────────
    {
      code: 'const s = validator.string().optional()',
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    {
      code: "const s = validator.string().default('x')",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    {
      // .allow() present but NOT with '' literal.
      code: 'const s = validator.string().optional().allow(null)',
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    {
      // '' is the default, STILL rejected without .allow('').
      code: "const s = validator.string().default('')",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    {
      // nested inside object() — must still catch.
      code: 'const s = validator.object({ foo: validator.string().optional() })',
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },

    // ── Shape B's minimal shape — no else branch, pre-if assignment IS .optional()-shaped.
    {
      code: `
        function f(required) {
          let schema = validator.string().optional()
          if (required) schema = schema.required()
          return schema
        }
      `,
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },

    // ── The union-vs-per-branch counterexample (fourth adversarial review round): a naive
    // flat-union algorithm would WRONGLY clear this, because .allow('') appears somewhere in the
    // source, but never on the optional (falsy) path.
    {
      code: `
        function f(required) {
          let schema = validator.string().optional()
          if (required) schema = schema.required().allow('')
          return schema
        }
      `,
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },

    // ── Param-spec object-literal pattern — Scrapper's ACTUAL shape.
    {
      code: "const specs = [{ key: 'x', wire: 'x', type: 'string', schema: validator.string(), description: 'd' }]",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },

    // ── Shadowed bindings must be analyzed INDEPENDENTLY, not merged by identifier.
    // Events used to be grouped by variable NAME alone, so a nested block's own `schema` binding
    // joined the outer one's event list. The inner declaration then disqualified the outer chain
    // (it re-roots at `validator.string()`, which the Shape-A grammar treats as a disqualifying
    // re-root), silently suppressing a real finding on the OUTER schema.
    {
      code: `
        function f() {
          let schema = validator.string().optional()
          {
            let schema = validator.string().allow('')
            use(schema)
          }
          return schema
        }
      `,
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    // Both bindings undisposed → both reported, proving each is analyzed on its own.
    {
      code: `
        function f() {
          let schema = validator.string().optional()
          {
            let schema = validator.string().default('x')
            use(schema)
          }
          return schema
        }
      `,
      errors: [{ messageId: 'requireEmptyDisposition' }, { messageId: 'requireEmptyDisposition' }],
    },
  ],
})
