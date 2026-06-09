/**
 * @module @nhtio/adk/eslint/rules/thought_payload_requires_replay_tag
 *
 * Flags `new Thought({ … })` whose options literal sets a `payload` but omits a
 * `replayCompatibility` tag.
 *
 * Why: a `Thought` may carry a vendor-opaque `payload` that the harness cannot interpret, to be
 * replayed back to a matching model wire. The ADK can only route that payload if the thought also
 * declares which adapter wire-shape it is replayable into, via `replayCompatibility`. A `payload`
 * with no `replayCompatibility` is a footgun: the harness has no way to know which adapter can
 * consume it, so it is dropped silently. The `Thought` constructor enforces this cross-field
 * invariant at runtime (`payload` present ⇒ `replayCompatibility` required); this rule surfaces it
 * statically at the construction site so it fails lint, not just at runtime.
 *
 * Detects the common literal form: a `new Thought({ … })` options object that has a `payload`
 * property but no `replayCompatibility` property. Spreads or computed keys are not analyzable here —
 * those fall back to the runtime check.
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/thought-payload-requires-replay-tag -- <reason>
 */

import { createRule } from './common'

import type { TSESTree } from '@typescript-eslint/utils'

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

// True when the property value is statically `undefined` (the absent case) — `payload: undefined`
// is equivalent to omitting it, so it should not trigger the rule.
const isUndefinedValue = (node: TSESTree.Node): boolean =>
  node.type === 'Identifier' && node.name === 'undefined'

/** ESLint rule: flags a Thought constructed with a payload but no replayCompatibility tag. */
const thoughtPayloadRequiresReplayTagRule = createRule({
  name: 'thought-payload-requires-replay-tag',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A `Thought` carrying a `payload` must declare `replayCompatibility`; otherwise the harness cannot route the opaque payload to a matching adapter and drops it. Enforced at runtime by the Thought constructor; this surfaces it at the construction site.',
    },
    schema: [],
    messages: {
      requireReplayTag:
        '`new Thought({ payload })` requires a `replayCompatibility` tag — without it the harness cannot route the opaque payload to an adapter and silently drops it. Add `replayCompatibility: "<wire-shape-id>"`, or remove the payload. Opt out with an eslint-disable-next-line adk/thought-payload-requires-replay-tag comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'Thought') return
        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return

        let payloadProp: TSESTree.Property | undefined
        let hasReplayTag = false
        let hasSpread = false
        for (const p of arg.properties) {
          if (p.type === 'SpreadElement') {
            hasSpread = true
            continue
          }
          const key = literalKey(p)
          if (key === 'payload' && !isUndefinedValue(p.value)) payloadProp = p
          else if (key === 'replayCompatibility' && !isUndefinedValue(p.value)) hasReplayTag = true
        }

        // A spread could supply replayCompatibility we can't see — stay conservative, don't flag.
        if (payloadProp && !hasReplayTag && !hasSpread) {
          context.report({ node: payloadProp, messageId: 'requireReplayTag' })
        }
      },
    }
  },
})

export default thoughtPayloadRequiresReplayTagRule
