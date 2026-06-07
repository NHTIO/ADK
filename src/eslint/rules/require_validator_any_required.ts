/**
 * @module @nhtio/adk/eslint/rules/require_validator_any_required
 *
 * Flags every `validator.any()` schema chain that does not declare intent with `.required()`
 * or `.optional()`.
 *
 * Why: in `@nhtio/validation`, `.any()` ADMITS `null`/`undefined` unless you make it `.required()`.
 * That default is silent and easy to miss — a schema you believe rejects missing values quietly
 * accepts them, and any `.custom()` refinement is skipped for an absent value (a `.custom()` guard
 * is the usual way this surfaces, e.g. `implementsX(undefined) === true`). The fix is to make the
 * disposition an EXPLICIT declaration with no ambiguity — every `.any()` must say which it is:
 *   - `.required()`  → reject null/undefined
 *   - `.optional()`  → deliberately allow null/undefined
 *   - `.default(x)`  → allow absence, substituting a fallback value
 *   - `.forbidden()` → the value must be absent
 * This applies whether the `.any()` is top-level or nested inside `items(...)` / `alternatives(...)`:
 * the enclosing schema being `.required()` does NOT govern an inner `.any()`'s null/undefined handling.
 *
 * The sharpest illustration is `.valid(null)`: an author writing `validator.any().valid(null)`
 * means "must be exactly null" — but because `.any()` admits `undefined`, that schema actually
 * accepts BOTH `null` and `undefined` (and `undefined !== null`). The fix is
 * `validator.any().required().valid(null)`.
 *
 * Opt-out (e.g. a bare `.any()` used purely as a type argument like `items(validator.any())`):
 *   // eslint-disable-next-line adk/require-validator-any-required -- <reason>
 */

import { createRule } from './common'

import type { TSESTree } from '@typescript-eslint/utils'

// The base identifier a member/call chain roots at, e.g. `validator` in `validator.any()` or
// `validator.alternatives(...).any()`. Returns undefined if the chain doesn't root at a plain name.
const baseIdentifierName = (node: TSESTree.Node | undefined): string | undefined => {
  let cur: TSESTree.Node | undefined = node
  while (cur) {
    if (cur.type === 'Identifier') return cur.name
    if (cur.type === 'MemberExpression') {
      cur = cur.object
      continue
    }
    if (cur.type === 'CallExpression') {
      cur = cur.callee
      continue
    }
    return undefined
  }
  return undefined
}

// `validator.any()` (or a `validator.…().any()` chain) — NOT `expect.any()`, `_.any()`, etc.
const isAnyCall = (node: TSESTree.CallExpression): boolean =>
  node.callee.type === 'MemberExpression' &&
  node.callee.property.type === 'Identifier' &&
  node.callee.property.name === 'any' &&
  baseIdentifierName(node.callee.object) === 'validator'

// Collect every CallExpression in the method chain `anyCall` belongs to — inward through the
// callee object (`a.b().c()` -> `a.b()`) and outward through `.parent` links
// (`x.any()` -> `x.any().required` -> `x.any().required()`).
const collectChainCalls = (anyCall: TSESTree.CallExpression): TSESTree.CallExpression[] => {
  const calls: TSESTree.CallExpression[] = []

  let cur: TSESTree.Node | null = anyCall
  while (cur && cur.type === 'CallExpression') {
    calls.push(cur)
    cur = cur.callee.type === 'MemberExpression' ? cur.callee.object : null
  }

  cur = anyCall
  while (cur) {
    const p: TSESTree.Node | undefined = cur.parent
    if (!p) break
    if (p.type === 'MemberExpression' && p.object === cur) {
      cur = p
      continue
    }
    if (p.type === 'CallExpression' && p.callee === cur) {
      calls.push(p)
      cur = p
      continue
    }
    break
  }

  return calls
}

const chainCalls = (calls: TSESTree.CallExpression[], name: string): boolean =>
  calls.some(
    (c) =>
      c.callee.type === 'MemberExpression' &&
      c.callee.property.type === 'Identifier' &&
      c.callee.property.name === name
  )

const requireValidatorAnyRequiredRule = createRule({
  name: 'require-validator-any-required',
  meta: {
    type: 'problem',
    docs: {
      description:
        '`validator.any()` admits null/undefined unless `.required()`; make the disposition explicit by ending every `.any()` in `.required()`, `.optional()`, or `.default(…)`. Opt out with a tactical disable comment + reason.',
    },
    schema: [],
    messages: {
      declareIntent:
        '`validator.any()` admits null/undefined unless made `.required()`. Make the disposition explicit: end this `.any()` in `.required()` (reject null/undefined), `.optional()` (deliberately allow it), or `.default(…)` (allow it with a fallback) — applies even when nested in items()/alternatives(). Or add an eslint-disable-next-line adk/require-validator-any-required comment with a reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isAnyCall(node)) return
        const calls = collectChainCalls(node)
        // An unambiguous disposition declaration clears the rule:
        //   .required()  — reject null/undefined
        //   .optional()  — deliberately allow null/undefined
        //   .default(x)  — allow absence, substituting a fallback
        //   .forbidden() — the value must be absent
        if (
          chainCalls(calls, 'required') ||
          chainCalls(calls, 'optional') ||
          chainCalls(calls, 'default') ||
          chainCalls(calls, 'forbidden')
        ) {
          return
        }
        const reportNode = node.callee.type === 'MemberExpression' ? node.callee.property : node
        context.report({ node: reportNode, messageId: 'declareIntent' })
      },
    }
  },
})

export default requireValidatorAnyRequiredRule
