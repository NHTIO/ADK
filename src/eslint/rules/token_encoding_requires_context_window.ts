/**
 * @module @nhtio/adk/eslint/rules/token_encoding_requires_context_window
 *
 * Flags a Chat Completions adapter options literal that sets a non-null `tokenEncoding` but omits
 * `contextWindow`.
 *
 * Why: the OpenAI / WebLLM Chat Completions batteries only perform local token counting + overflow
 * protection when BOTH `tokenEncoding` (how to count) and `contextWindow` (the budget to count
 * against) are provided. Setting `tokenEncoding` alone is a footgun — the encoding is configured but
 * there is no ceiling to enforce, so the overflow guard silently never runs. The adapters throw on
 * this cross-field mismatch at iteration time; this rule surfaces it at the construction site.
 *
 * Detects `new OpenAIChatCompletionsAdapter({ … })` / `new WebLLMChatCompletionsAdapter({ … })`
 * (and any `*ChatCompletionsAdapter`) where `tokenEncoding` is present and not `null`/`undefined`
 * while `contextWindow` is absent.
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/token-encoding-requires-context-window -- <reason>
 */

import { createRule } from './common'

import type { TSESTree } from '@typescript-eslint/utils'

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

const isNullOrUndefined = (node: TSESTree.Node): boolean =>
  (node.type === 'Literal' && node.value === null) ||
  (node.type === 'Identifier' && node.name === 'undefined')

/** ESLint rule: flags setting a tokenEncoding without also setting a contextWindow. */
const tokenEncodingRequiresContextWindowRule = createRule({
  name: 'token-encoding-requires-context-window',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Chat Completions adapter configured with a non-null `tokenEncoding` must also set `contextWindow`; otherwise token counting is configured but the overflow guard has no budget and never runs. The adapters enforce this at runtime; this surfaces it at the construction site.',
    },
    schema: [],
    messages: {
      requireContextWindow:
        '`tokenEncoding` is set but `contextWindow` is missing — the adapter counts tokens with no budget to enforce, so the context-overflow guard never runs. Add `contextWindow`, or drop `tokenEncoding`. Opt out with an eslint-disable-next-line adk/token-encoding-requires-context-window comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (node.callee.type !== 'Identifier') return
        if (!/ChatCompletionsAdapter$/.test(node.callee.name)) return
        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return

        let tokenEncodingProp: TSESTree.Property | undefined
        let hasContextWindow = false
        let hasSpread = false
        for (const p of arg.properties) {
          if (p.type === 'SpreadElement') {
            hasSpread = true
            continue
          }
          const key = literalKey(p)
          if (key === 'tokenEncoding' && !isNullOrUndefined(p.value)) tokenEncodingProp = p
          else if (key === 'contextWindow' && !isNullOrUndefined(p.value)) hasContextWindow = true
        }

        // A spread could supply contextWindow we can't see — stay conservative, don't flag.
        if (tokenEncodingProp && !hasContextWindow && !hasSpread) {
          context.report({ node: tokenEncodingProp, messageId: 'requireContextWindow' })
        }
      },
    }
  },
})

export default tokenEncodingRequiresContextWindowRule
