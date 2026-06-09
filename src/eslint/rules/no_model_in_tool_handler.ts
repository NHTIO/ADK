/**
 * @module @nhtio/adk/eslint/rules/no_model_in_tool_handler
 *
 * Flags an LLM/model call inside a `Tool` / `ArtifactTool` `handler`.
 *
 * Why: the executor owns the dispatch loop. A tool handler runs as one step the model proposed; it
 * must do work and return a result, not start its own reasoning loop. Calling a model from inside a
 * handler hides a nested, unmanaged dispatch from the harness — no token accounting, no event
 * surfacing, no abort propagation. The one legitimate exception is a tool that is explicitly a
 * sub-agent running its own scoped dispatch; this rule allows a handler that constructs a
 * `new TurnRunner(...)` or calls the lower-level `DispatchRunner.dispatch(...)`.
 *
 * Detects provider SDK constructors (`new OpenAI()`, `new Anthropic()`) and chat/completion calls
 * (a `.create()` whose receiver chain passes through `messages`/`completions`/`responses`, or a
 * `generateContent()` call) within the `handler` function passed to `new Tool({ handler })` /
 * `new ArtifactTool({ handler })`, ignoring inner closures (so a sub-agent's own callbacks don't
 * false-positive).
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/no-model-in-tool-handler -- <reason>
 */

import {
  createRule,
  isFunctionNode,
  isLlmCall,
  runsSubAgent,
  walkBodySkippingNestedFunctions,
} from './common'

import type { TSESTree } from '@typescript-eslint/utils'

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

/** ESLint rule: flags referencing the model or LLM adapter inside a tool handler. */
const noModelInToolHandlerRule = createRule({
  name: 'no-model-in-tool-handler',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Tool/ArtifactTool handler must not invoke a model — the executor owns the dispatch loop. The only exception is a sub-agent tool that runs its own scoped dispatch via `new TurnRunner(...)` or `DispatchRunner.dispatch(...)`.',
    },
    schema: [],
    messages: {
      noModelInHandler:
        'Do not call a model inside a tool handler — the executor owns the dispatch loop, and a model call here hides an unmanaged nested dispatch (no token accounting, events, or abort). If this tool is a sub-agent, run a scoped `new TurnRunner(...)` or `DispatchRunner.dispatch(...)` instead. Opt out with an eslint-disable-next-line adk/no-model-in-tool-handler comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (
          node.callee.type !== 'Identifier' ||
          (node.callee.name !== 'Tool' && node.callee.name !== 'ArtifactTool')
        ) {
          return
        }
        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return

        const handlerProp = arg.properties.find(
          (p): p is TSESTree.Property => p.type === 'Property' && literalKey(p) === 'handler'
        )
        if (!handlerProp || !isFunctionNode(handlerProp.value)) return
        const handler = handlerProp.value

        // A sub-agent tool legitimately runs a scoped dispatch (new TurnRunner / DispatchRunner.dispatch)
        // — that's the documented exception.
        if (runsSubAgent(handler.body)) return

        walkBodySkippingNestedFunctions(handler.body, (n) => {
          if (isLlmCall(n)) {
            context.report({ node: n, messageId: 'noModelInHandler' })
          }
        })
      },
    }
  },
})

export default noModelInToolHandlerRule
