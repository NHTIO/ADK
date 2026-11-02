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

/**
 * Node types that wrap another expression without changing the value it denotes.
 *
 * @remarks
 * A rule that reads an argument (or a property value) expecting an object literal must look
 * THROUGH one of these first. `createSkillManager({ sources } as SkillManagerConfig)` is the same
 * object literal as `createSkillManager({ sources })`, and a rule that tests only for a bare
 * `ObjectExpression` is silenced by the assertion — a TypeScript expression is not a semantic
 * change, so it must not be a lint bypass.
 *
 * `ParenthesizedExpression` is listed defensively: TypeScript-ESTree erases parentheses while
 * converting, so it never reaches a rule today — but a parser that preserves them must not be able
 * to defeat a rule either.
 */
const TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'TSAsExpression', // value as Type
  'TSSatisfiesExpression', // value satisfies Type
  'TSTypeAssertion', // <Type>value
  'TSNonNullExpression', // value!
  'ChainExpression', // value?.prop
  'ParenthesizedExpression', // (value)
])

/**
 * Strips every transparent expression wrapper (`as X`, `satisfies X`, `<X>`, `!`, `?.`, parens)
 * from `node` and returns the node that actually carries the value.
 *
 * @remarks
 * Every rule in this plugin (and the identical copies carried by the sandbox and skills battery
 * lint modules — a battery may not import this untagged module, see CONTRIBUTING's barrel rule)
 * unwraps an argument or property value with this before testing its node type, so a wrapped
 * literal is inspected exactly like a bare one.
 */
export const unwrapExpression = (node: TSESTree.Node): TSESTree.Node => {
  let current = node
  while (TRANSPARENT_WRAPPER_TYPES.has(current.type)) {
    // Membership in the set guarantees this node shape carries the wrapped value on `expression`.
    current = (current as unknown as { expression: TSESTree.Node }).expression
  }
  return current
}

export const isFunctionNode = (node: TSESTree.Node): node is FunctionNode =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression'

/** This package: the specifier root the factory/class-name rule imports come from. */
const ADK_PACKAGE = '@nhtio/adk'

/** One import statement binding: what a local callee identifier denotes. */
interface NameBinding {
  /** The local identifier the file references the value through (an alias when aliased). */
  local: string
  /** The exported name the binding denotes (`'default'` for a default import). */
  exported: string
  /** True when the specifier is `import * as X` — the local names the module, not a member. */
  namespace: boolean
  /** True when the statement's module specifier is `@nhtio/adk` or a `@nhtio/adk/…` subpath. */
  fromAdk: boolean
}

/** The import bindings of one file, keyed by local identifier. See {@link collectImportBindings}. */
export type ImportBindings = ReadonlyMap<string, NameBinding>

/**
 * Collects the file's import bindings, so {@link resolveCalleeName} can map a local callee name to
 * the export it denotes.
 *
 * @remarks
 * Call once at the top of a rule's `Program()` visitor and keep the result in the rule's closure —
 * ESLint walks the AST depth-first, so a call can lexically precede its own import statement. A
 * later import of the same local name overwrites the earlier one; imports in one scope cannot
 * legally collide, so this only ever resolves a genuine redeclaration.
 */
export const collectImportBindings = (ast: TSESTree.Program): ImportBindings => {
  const bindings = new Map<string, NameBinding>()
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') continue
    const source = typeof statement.source.value === 'string' ? statement.source.value : ''
    const fromAdk = source === ADK_PACKAGE || source.startsWith(`${ADK_PACKAGE}/`)
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier') {
        bindings.set(specifier.local.name, {
          local: specifier.local.name,
          exported: specifier.imported.name,
          namespace: false,
          fromAdk,
        })
      } else if (specifier.type === 'ImportDefaultSpecifier') {
        bindings.set(specifier.local.name, {
          local: specifier.local.name,
          exported: 'default',
          namespace: false,
          fromAdk,
        })
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        bindings.set(specifier.local.name, {
          local: specifier.local.name,
          exported: '*',
          namespace: true,
          fromAdk,
        })
      }
    }
  }
  return bindings
}

/**
 * A resolved callee name: the EXPORTED symbol a rule should match on, plus the binding shape it
 * arrived through.
 *
 * @remarks
 * A local identifier is not the match: `import { createSkillManager as csm }` means the file's
 * `csm(…)` call names the export `createSkillManager`, and `import * as ns from '@nhtio/adk/…'`
 * makes `ns.createSkillManager(…)` name it too. Rules that gate on a factory/class name resolve the
 * callee through this record BEFORE matching on any name.
 */
export interface ResolvedCalleeName {
  /** The exported name to match on (the `imported` specifier, or the last member segment). */
  name: string
  /** How the callee is bound in this file. */
  kind: 'plain' | 'aliased' | 'namespace'
  /** The local identifier the file references the export through. */
  local: string
  /** True when the value binding came from an import statement in this file (any module). */
  imported: boolean
  /** True when that import is from this package's public subpaths (`@nhtio/adk` or `@nhtio/adk/…`). */
  fromAdk: boolean
}

/**
 * Resolves a callee expression to the exported name it denotes, through the file's import bindings.
 *
 * @remarks
 * Three shapes resolve: a bare identifier (`createSkillManager(…)` — `plain` or `aliased` depending
 * on the specifier), a member expression off a namespace import (`ns.createSkillManager(…)`), and
 * the optional-chain spellings of either (the value is the same call). A local object the file built
 * itself (`const ns = { createSkillManager }`) is deliberately NOT resolved — the name does not come
 * from an import binding — and neither is a computed or two-level member chain. Those return `null`.
 *
 * `fromAdk` is true only for a real import from `@nhtio/adk` or a `@nhtio/adk/…` subpath. A bare
 * identifier the file never imports at all resolves with `imported: false, fromAdk: false` — the
 * "snippet, re-export, or global" case, which the adk rules treat conservatively as a match per their
 * own binding policies. An import of the name from a foreign module resolves with `imported: true,
 * fromAdk: false` — "provably not ours", a different answer from "unknown", and the policies keep
 * the two apart.
 */
export const resolveCalleeName = (
  bindings: ImportBindings,
  callee: TSESTree.Node
): ResolvedCalleeName | null => {
  // Strip wrappers so `ns.createSkillManager(…)` and the optional-chain spellings resolve like the
  // bare forms — a TS wrapper on the callee changes no binding.
  const bare = unwrapExpression(callee)
  if (bare.type === 'MemberExpression') {
    const object = unwrapExpression(bare.object)
    const prop = unwrapExpression(bare.property)
    if (bare.computed || object.type !== 'Identifier' || prop.type !== 'Identifier') return null
    const nsBinding = bindings.get(object.name)
    // The namespace object must be a namespace import: a local `const ns = {...}` may carry the name
    // by coincidence and does not inherit the export's contract, and a member off a plain import
    // (`createException.call(…)`) is not the export either.
    if (!nsBinding || !nsBinding.namespace) return null
    return {
      name: prop.name,
      kind: 'namespace',
      local: prop.name,
      imported: true,
      fromAdk: nsBinding.fromAdk,
    }
  }
  if (bare.type !== 'Identifier') return null
  const binding = bindings.get(bare.name)
  if (!binding || binding.namespace) {
    // An identifier the file never binds by import — or one that names a namespace module, which can
    // only ever resolve through a member arm: the "snippet / global / not resolved" case.
    return { name: bare.name, kind: 'plain', local: bare.name, imported: false, fromAdk: false }
  }
  return {
    name: binding.exported,
    kind: binding.local === binding.exported ? 'plain' : 'aliased',
    local: binding.local,
    imported: true,
    fromAdk: binding.fromAdk,
  }
}

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
