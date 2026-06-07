/**
 * @module @nhtio/adk/eslint/rules/artifact_tool_forbids_artifact_constructor
 *
 * Flags `new ArtifactTool({ … })` whose options literal sets an `artifactConstructor`.
 *
 * Why: an `ArtifactTool` is the tool that answers queries AGAINST a spooled artifact — it must not
 * itself return a `SpooledArtifact`, or the result would be re-wrapped into another artifact whose
 * query tools are themselves `ArtifactTool`s, and so on without end. The base `RawTool` accepts an
 * `artifactConstructor` (the subclass used to wrap a tool's bytes), but `ArtifactTool` explicitly
 * FORBIDS it (`artifactConstructor: validator.any().forbidden()` in its schema). Supplying one is a
 * recursion footgun the constructor rejects at runtime; this rule surfaces it at the construction
 * site so it fails lint.
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/artifact-tool-forbids-artifact-constructor -- <reason>
 */

import { createRule } from './common'

import type { TSESTree } from '@typescript-eslint/utils'

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

const isUndefinedValue = (node: TSESTree.Node): boolean =>
  node.type === 'Identifier' && node.name === 'undefined'

const artifactToolForbidsArtifactConstructorRule = createRule({
  name: 'artifact-tool-forbids-artifact-constructor',
  meta: {
    type: 'problem',
    docs: {
      description:
        'An `ArtifactTool` must not declare `artifactConstructor` — it answers queries against an artifact and cannot itself return one (infinite re-wrapping). The ArtifactTool schema forbids the field at runtime; this surfaces it at the construction site.',
    },
    schema: [],
    messages: {
      forbidArtifactConstructor:
        '`new ArtifactTool` must not set `artifactConstructor` — an artifact-query tool cannot itself return a SpooledArtifact (it would re-wrap forever). The ArtifactTool schema forbids this field. Remove it. Opt out with an eslint-disable-next-line adk/artifact-tool-forbids-artifact-constructor comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'ArtifactTool') return
        const arg = node.arguments[0]
        if (!arg || arg.type !== 'ObjectExpression') return

        for (const p of arg.properties) {
          if (p.type === 'SpreadElement') continue
          if (literalKey(p) === 'artifactConstructor' && !isUndefinedValue(p.value)) {
            context.report({ node: p, messageId: 'forbidArtifactConstructor' })
          }
        }
      },
    }
  },
})

export default artifactToolForbidsArtifactConstructorRule
