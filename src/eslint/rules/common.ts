/**
 * Shared `createRule` factory for the published `@nhtio/adk` ESLint rules.
 *
 * @remarks
 * Wraps `ESLintUtils.RuleCreator` so every rule gets a consistent `meta.docs.url` pointing at the
 * published rule reference. Each rule module imports this and default-exports `createRule({...})`.
 *
 * `@typescript-eslint/utils` is an OPTIONAL peer dependency of `@nhtio/adk` — it is only needed by
 * consumers who import `@nhtio/adk/eslint`. The main library never imports this module.
 */

import { ESLintUtils } from '@typescript-eslint/utils'

import type { TSESTree } from '@typescript-eslint/utils'

/**
 * Rule factory for `@nhtio/adk` ESLint rules. The `name` passed to each rule becomes the slug in the
 * generated documentation URL.
 */
export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://adk.nht.io/eslint/rules/${name}`
)

/** Any function-like AST node (arrow, function expression, or declaration). */
export type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression

export const isFunctionNode = (node: TSESTree.Node): node is FunctionNode =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression'

// Provider SDK constructor names whose presence inside a handler/middleware indicates a primary
// model call. Conservative, well-known set — keeps false positives low.
const LLM_CTOR_NAMES = new Set([
  'OpenAI',
  'AzureOpenAI',
  'Anthropic',
  'AnthropicBedrock',
  'AnthropicVertex',
  'GoogleGenerativeAI',
  'GoogleGenAI',
  'Mistral',
  'CohereClient',
  'CohereClientV2',
  'Groq',
])

// Method-name tails that indicate a chat/completion/generation call on a provider client, e.g.
// `client.chat.completions.create(...)`, `client.messages.create(...)`, `model.generateContent(...)`.
const LLM_METHOD_NAMES = new Set(['generateContent', 'generateContentStream', 'generateMessage'])

const memberPropertyName = (node: TSESTree.MemberExpression): string | undefined =>
  node.property.type === 'Identifier' ? node.property.name : undefined

/**
 * Heuristic: does this call/new expression look like a primary LLM invocation? Detects known
 * provider SDK constructors and `…create()` calls whose receiver chain passes through
 * `chat`/`completions`/`messages`/`responses`, plus a small set of generate* methods. Deliberately
 * conservative — the goal is to catch the obvious footgun, not to be exhaustive.
 */
export const isLlmCall = (node: TSESTree.Node): boolean => {
  if (node.type === 'NewExpression') {
    return node.callee.type === 'Identifier' && LLM_CTOR_NAMES.has(node.callee.name)
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
    const method = memberPropertyName(node.callee)
    if (method && LLM_METHOD_NAMES.has(method)) return true
    // `<chain>.create()` where the chain passes through a provider sub-resource.
    if (method === 'create') {
      let cur: TSESTree.Node = node.callee.object
      while (cur.type === 'MemberExpression') {
        const seg = memberPropertyName(cur)
        if (seg === 'completions' || seg === 'messages' || seg === 'responses') return true
        cur = cur.object
      }
    }
  }
  return false
}

/**
 * Walks the descendants of a function body (NOT crossing into nested function scopes) and invokes
 * `visit` for every node, so a rule can scan a handler/middleware body for a pattern while ignoring
 * inner closures (e.g. a `new TurnRunner` sub-agent's own callbacks).
 */
export const walkBodySkippingNestedFunctions = (
  body: TSESTree.Node,
  visit: (node: TSESTree.Node) => void
): void => {
  const recurse = (node: TSESTree.Node): void => {
    visit(node)
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const value = (node as unknown as Record<string, unknown>)[key]
      const children = Array.isArray(value) ? value : [value]
      for (const child of children) {
        if (!child || typeof child !== 'object') continue
        const childNode = child as TSESTree.Node
        if (typeof childNode.type !== 'string') continue
        // Do not descend into nested function scopes — their calls belong to a different context.
        if (isFunctionNode(childNode)) continue
        recurse(childNode)
      }
    }
  }
  recurse(body)
}

// A sub-agent is run through one of two blessed entry points: constructing a scoped
// `new TurnRunner(...)`, or the lower-level static `DispatchRunner.dispatch(...)` (its constructor
// is token-gated private, so `dispatch()` is the real entry point). Either one inside a tool handler
// means "this tool is deliberately a sub-agent," which is the documented exception to
// no-model-in-tool-handler.
const isSubAgentEntry = (node: TSESTree.Node): boolean => {
  // new TurnRunner(...)
  if (
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'TurnRunner'
  ) {
    return true
  }
  // DispatchRunner.dispatch(...)
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'dispatch' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'DispatchRunner'
  ) {
    return true
  }
  return false
}

/**
 * True when the function body runs a scoped sub-agent — either `new TurnRunner(...)` or
 * `DispatchRunner.dispatch(...)` — the documented escape hatch that exempts a tool handler from
 * {@link isLlmCall} flagging.
 */
export const runsSubAgent = (body: TSESTree.Node): boolean => {
  let found = false
  const recurse = (node: TSESTree.Node): void => {
    if (found) return
    if (isSubAgentEntry(node)) {
      found = true
      return
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const value = (node as unknown as Record<string, unknown>)[key]
      const children = Array.isArray(value) ? value : [value]
      for (const child of children) {
        if (!child || typeof child !== 'object') continue
        const childNode = child as TSESTree.Node
        if (typeof childNode.type !== 'string') continue
        recurse(childNode)
      }
    }
  }
  recurse(body)
  return found
}
