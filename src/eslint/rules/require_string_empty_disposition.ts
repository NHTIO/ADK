/**
 * @module @nhtio/adk/eslint/rules/require_string_empty_disposition
 *
 * Flags a `validator.string()` chain — written literally inside an `inputSchema` value passed to
 * `new Tool({...})` or `new ArtifactTool({...})` — that is `.optional()`/`.default(…)`-shaped but has
 * no explicit empty-string disposition.
 *
 * Why: confirmed empirically against the actual installed `@nhtio/validation` package (Joi under the
 * hood), `validator.string()` rejects `""` with `"{{#label}} is not allowed to be empty"` regardless
 * of whether the chain is bare, `.optional()`, `.default(x)`, or even `.required()` — including the
 * absurd case where `""` is the schema's own configured default (`validator.string().default('')`
 * still rejects an explicit `''`). A model filling in a tool call will often send `""` instead of
 * omitting an unwanted optional parameter; without an explicit disposition, that fails schema
 * validation instead of degrading gracefully. This is the same category of footgun
 * `adk/require-validator-any-required` polices for `.any()` — a silent, non-obvious default that only
 * bites at the worst time.
 *
 * Scope, deliberately narrow (read this before assuming the rule catches more than it does): this
 * rule only flags a `.string()` chain that is *(1)* rooted directly in `validator.string()`, *(2)*
 * `.optional()`/`.default(…)`-shaped (a bare `.required()`-only or fully bare chain is out of scope —
 * demanding `''`-handling there would mostly add noise around ids/expressions/JSON payloads that
 * should keep rejecting empty input), and *(3)* written literally inside the `inputSchema` value of a
 * `new Tool({...})`/`new ArtifactTool({...})` call — including nested inside a `validator.object(
 * {...})` that is itself the `inputSchema` value. It does **not** trace a schema assembled in a
 * helper function and handed in via a variable, it does **not** track cross-branch/conditional
 * reassignment of a schema-holding variable, and it does **not** recognize any project-specific
 * "param spec" object-literal pattern. A `validator.string()` chain anywhere else — a battery's own
 * construction-options `validation.ts`, an embeddings/generation/TTS config schema, etc. — is out of
 * scope entirely, on purpose: a plugin shipped to arbitrary consumers cannot assume any particular
 * file layout or authoring convention, so it reasons only from the `new Tool(...)`/`new
 * ArtifactTool(...)` call shape itself, the one thing it can see without executing code. A
 * file-glob-scoped, pattern-aware sibling rule with a broader detection surface exists for this
 * repository's own internal use (not part of what ships to external consumers).
 *
 * Clearing methods (an unambiguous empty-string disposition — any one of these clears the rule):
 *   - `.allow('')`  — only when a `''` string literal is among the call's arguments; `.allow(null)`
 *     alone does NOT clear it (confirmed empirically: `.allow(null)` still rejects `''`).
 *   - `.empty('')`  — same argument-literal check.
 *   - `.valid(...)` — ANY `.valid(...)` call clears the rule, regardless of whether `''` is among its
 *     arguments. An explicit closed enum is sufficient, intentional disposition on its own — a model
 *     sending `''` against a `.valid('a', 'b')` enum gets Joi's normal enum-rejection message, which
 *     is exactly the tool author's intent by writing a closed enum.
 *   - `.forbidden()` — the value must be absent entirely; trivially clears.
 *
 * Opt-out (e.g. a deliberately strict optional/default string that should keep rejecting `''`):
 *   // eslint-disable-next-line adk/require-string-empty-disposition -- <reason>
 */

import { createRule } from './common'

import type { TSESTree } from '@typescript-eslint/utils'

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

// The base identifier a member/call chain roots at, e.g. `validator` in `validator.string()`.
// Returns undefined if the chain doesn't root at a plain name.
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

// `validator.string()` — the root call a tracked chain must start from, directly (not several
// calls deep — `foo.bar().string()` does not qualify, only a direct `validator.string()`).
const isValidatorStringRootCall = (node: TSESTree.CallExpression): boolean =>
  node.callee.type === 'MemberExpression' &&
  node.callee.property.type === 'Identifier' &&
  node.callee.property.name === 'string' &&
  baseIdentifierName(node.callee.object) === 'validator'

// Collect every CallExpression in the method chain `rootCall` belongs to — inward through the
// callee object (unused here since `rootCall` is already the innermost call) and outward through
// `.parent` links (`v.string()` -> `v.string().optional` -> `v.string().optional()`).
const collectChainCalls = (rootCall: TSESTree.CallExpression): TSESTree.CallExpression[] => {
  const calls: TSESTree.CallExpression[] = [rootCall]

  let cur: TSESTree.Node = rootCall
  for (;;) {
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

const callMethodName = (call: TSESTree.CallExpression): string | undefined =>
  call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier'
    ? call.callee.property.name
    : undefined

const chainHasMethod = (calls: TSESTree.CallExpression[], name: string): boolean =>
  calls.some((c) => callMethodName(c) === name)

// `.allow('')` / `.empty('')` only clear the rule when a bare `''` literal is among the arguments —
// `.allow(null)` alone does not (confirmed empirically it still rejects `''`).
const isEmptyLiteralArg = (node: TSESTree.CallExpressionArgument): boolean =>
  node.type === 'Literal' && node.value === ''

const chainHasEmptyStringClear = (calls: TSESTree.CallExpression[]): boolean =>
  calls.some((c) => {
    const name = callMethodName(c)
    return (name === 'allow' || name === 'empty') && c.arguments.some(isEmptyLiteralArg)
  })

// Generic AST walk over a schema literal's subtree — does not skip nested function scopes, since a
// schema literal itself is not expected to contain unrelated closures worth excluding, and the
// simpler, uniform walk keeps this rule's detection surface exactly what it claims: "anything written
// literally inside this value."
const walkTree = (node: TSESTree.Node, visit: (node: TSESTree.Node) => void): void => {
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = (node as unknown as Record<string, unknown>)[key]
    const children = Array.isArray(value) ? value : [value]
    for (const child of children) {
      if (!child || typeof child !== 'object') continue
      const childNode = child as TSESTree.Node
      if (typeof childNode.type !== 'string') continue
      walkTree(childNode, visit)
    }
  }
}

/**
 * ESLint rule: flags a `validator.string()` chain inside a `new Tool`/`new ArtifactTool`
 * `inputSchema` value that is `.optional()`/`.default(…)`-shaped with no empty-string disposition.
 */
const requireStringEmptyDispositionRule = createRule({
  name: 'require-string-empty-disposition',
  meta: {
    type: 'problem',
    docs: {
      description:
        "A `validator.string()` chain inside a Tool/ArtifactTool `inputSchema` that is `.optional()`/`.default(…)`-shaped still rejects an empty string unless `.allow('')`, `.empty('')`, or a `.valid(...)` enum is also present.",
    },
    schema: [],
    messages: {
      requireEmptyDisposition:
        "`validator.string()` combined with `.optional()`/`.default(...)` still rejects an empty string unless you also add `.allow('')` (or `.empty('')`, or a `.valid(...)` enum). A model filling in a tool call will often send `\"\"` instead of omitting an unwanted optional parameter — without an explicit disposition, that fails schema validation instead of degrading gracefully. If empty input should genuinely be rejected here, add `// eslint-disable-next-line adk/require-string-empty-disposition -- <reason>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const handleInputSchemaValue = (value: TSESTree.Node): void => {
      walkTree(value, (node) => {
        if (node.type !== 'CallExpression' || !isValidatorStringRootCall(node)) return
        const calls = collectChainCalls(node)

        // Out of scope entirely unless the chain is .optional()/.default(...)-shaped — a bare or
        // .required()-only string is a different contract ("you must give me a real value") that
        // this rule does not police.
        if (!chainHasMethod(calls, 'optional') && !chainHasMethod(calls, 'default')) return

        // Clearing methods, in the order documented above.
        if (chainHasMethod(calls, 'forbidden')) return
        if (chainHasMethod(calls, 'valid')) return // Policy A: any .valid(...) is sufficient on its own
        if (chainHasEmptyStringClear(calls)) return

        const reportNode = node.callee.type === 'MemberExpression' ? node.callee.property : node
        context.report({ node: reportNode, messageId: 'requireEmptyDisposition' })
      })
    }

    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (node.callee.type !== 'Identifier') return
        if (node.callee.name !== 'Tool' && node.callee.name !== 'ArtifactTool') return
        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return

        for (const p of arg.properties) {
          if (p.type === 'SpreadElement') continue
          if (literalKey(p) !== 'inputSchema') continue
          handleInputSchemaValue(p.value)
        }
      },
    }
  },
})

export default requireStringEmptyDispositionRule
