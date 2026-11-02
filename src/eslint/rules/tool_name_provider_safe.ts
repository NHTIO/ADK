/**
 * @module @nhtio/adk/eslint/rules/tool_name_provider_safe
 *
 * Flags a static `name` in `new Tool({ name: '…' })` that providers reject on the wire.
 *
 * Why: a tool name travels into every provider request verbatim — Chat Completions'
 * `tools[].function.name`, Anthropic's `tools[].name`, Gemini's `functionDeclarations[].name` — and
 * every one of those wires constrains it (OpenAI documents `[A-Za-z0-9_-]{1,64}`; Gemini rejects a
 * name that starts with a digit). The ADK does not sanitise the name: a tool called `2fa_check` or
 * `vault.read` constructs and registers perfectly, then every dispatch fails at the wire, at the
 * provider, with an error the model cannot act on and the operator has to trace back to a
 * `new Tool` line. This rule surfaces it at that line instead.
 *
 * Scope: what matches is a construction of THIS package's `Tool` — imported from `@nhtio/adk` or a
 * `@nhtio/adk/…` subpath that publishes the class (`common`, `forge`), under whatever local name the
 * file imported it as, or referenced through a namespace import of one of those subpaths
 * (`import * as adk from '@nhtio/adk'; new adk.Tool(…)`). A `Tool` the file never imports at all is
 * ALSO matched, conservatively: the same convention every other rule in this plugin uses, so a
 * snippet, a re-export shim, or a global `Tool` keeps working. What is never matched is a `Tool`
 * imported from some other module — `import { Tool } from 'some-other-lib'` is another library's
 * class, and its wire contract is not this one.
 *
 * The name is checked only when *statically known*: a template literal with no expressions counts as
 * static; any interpolation or any other expression is dynamic and ignored.
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/tool-name-provider-safe -- <reason>
 */

import { collectImportBindings, createRule, resolveCalleeName, unwrapExpression } from './common'

import type { ImportBindings } from './common'
import type { TSESTree } from '@typescript-eslint/utils'

// The intersection every bundled LLM battery's wire accepts: OpenAI's documented
// `[A-Za-z0-9_-]{1,64}` plus a leading-letter-or-underscore rule, which is stricter than OpenAI but
// is what Gemini's `functionDeclarations[].name` enforces.
const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

/** The statically-known string value of a node, or `undefined` when it is dynamic. */
const staticString = (node: TSESTree.Node): string | undefined => {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

/** ESLint rule: flags a `new Tool({ name })` whose literal name no provider would accept. */
const toolNameProviderSafeRule = createRule({
  name: 'tool-name-provider-safe',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A `Tool` name must match `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/` — provider wires reject a leading digit or a dot, so an out-of-shape name fails every dispatch instead of failing lint. Only statically-known names are checked; dynamic names are ignored.',
    },
    schema: [],
    messages: {
      unsafeName:
        'The tool name "{{name}}" is not provider-safe. Provider wires constrain names to /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/ — for example Gemini rejects a name that starts with a digit, and a dot satisfies no wire at all; either way the whole dispatch fails at the wire with an error neither the model nor the operator can act on. Rename it (e.g. "{{suggestion}}"). Opt out with an eslint-disable-next-line adk/tool-name-provider-safe comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    let bindings: ImportBindings = new Map()
    return {
      Program(node: TSESTree.Program): void {
        bindings = collectImportBindings(node)
      },
      NewExpression(node: TSESTree.NewExpression) {
        const resolved = resolveCalleeName(bindings, node.callee)
        if (!resolved || resolved.name !== 'Tool') return
        // The binding policy (see the module header): the export is `Tool`; the binding is either an
        // import from this package's `Tool`-publishing subpaths under any local spelling, or no
        // import of that name at all (the snippet / re-export / global case). A `Tool` imported from
        // another module is a different class and stays unflagged.
        if (resolved.imported && !resolved.fromAdk) return
        const arg = node.arguments[0]
        // `as X` / `satisfies X` / `<X>` / `x!` are transparent: look through them to the literal so
        // an assertion cannot silence the rule.
        if (!arg) return
        const literal = unwrapExpression(arg)
        if (literal.type !== 'ObjectExpression') return

        for (const p of literal.properties) {
          if (p.type === 'SpreadElement') continue
          if (literalKey(p) !== 'name') continue
          const name = staticString(unwrapExpression(p.value))
          // Dynamic names (identifiers, interpolated templates, calls) are deliberately ignored: the
          // rule cannot know the value, and guessing produces false positives on generated names.
          if (name === undefined) continue
          if (PROVIDER_SAFE_TOOL_NAME.test(name)) continue
          const suggestion = name
            .replace(/[^A-Za-z0-9_-]+/g, '_')
            .replace(/^[^A-Za-z_]+/, '')
            .slice(0, 64)
          context.report({
            node: unwrapExpression(p.value),
            messageId: 'unsafeName',
            data: { name, suggestion: suggestion || 'tool' },
          })
        }
      },
    }
  },
})

export default toolNameProviderSafeRule
