/**
 * @module @nhtio/adk/batteries/sandbox/lint
 *
 * ESLint rules for consumers of the sandbox battery: machine-checkable enforcement of the policy
 * shapes that look confined and are not.
 *
 * @remarks
 * Battery-scoped rules ship with the battery, not with the core `@nhtio/adk/eslint` plugin — they
 * only matter to deployments that compose this battery, and they version with the battery's own
 * API. The rules are report-only (no autofix); carve out a deliberate exception with an inline
 * `// eslint-disable-next-line adk-sandbox/{rule} -- {reason}` comment.
 *
 * `@typescript-eslint/utils` and `eslint` are OPTIONAL peer dependencies of `@nhtio/adk` —
 * installed only by consumers who lint with this plugin. The sandbox runtime never imports this
 * module, and the `batteries/sandbox` barrel does not re-export it.
 *
 * @example Flat config
 * ```ts
 * import adkSandbox from '@nhtio/adk/batteries/sandbox/lint'
 *
 * export default [
 *   { plugins: { 'adk-sandbox': adkSandbox.plugin }, rules: adkSandbox.configs.recommended.rules },
 * ]
 * ```
 */

import { ESLintUtils } from '@typescript-eslint/utils'
import {
  ImportBindings,
  collectImportBindings,
  resolveCalleeName,
  unwrapExpression,
} from '@nhtio/adk/eslint'
import type { TSESTree } from '@typescript-eslint/utils'
import type { FlatConfig } from '@typescript-eslint/utils/ts-eslint'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://adk.nht.io/batteries/sandbox/lint#${name}`
)

const literalKey = (prop: TSESTree.Property): string | undefined => {
  if (prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

const propertyNamed = (
  obj: TSESTree.ObjectExpression,
  name: string
): TSESTree.Property | undefined =>
  obj.properties.find(
    (p): p is TSESTree.Property => p.type === 'Property' && literalKey(p) === name
  )

const isTrueLiteral = (node: TSESTree.Node): boolean =>
  node.type === 'Literal' && node.value === true

const isNotCallableValue = (node: TSESTree.Node): boolean => {
  const bare = unwrapExpression(node)
  if (bare.type === 'Identifier') return bare.name === 'undefined'
  if (bare.type === 'UnaryExpression' && bare.operator === 'void') return true
  return (
    bare.type === 'Literal' ||
    bare.type === 'TemplateLiteral' ||
    bare.type === 'ObjectExpression' ||
    bare.type === 'ArrayExpression'
  )
}

/**
 * Node types that wrap an expression without changing the value it denotes.
 *
 * @remarks
 * `unwrapExpression` itself now comes from `@nhtio/adk/eslint` (one shared walk, no private
 * duplicate); this module still needs the set to walk OUT through wrappers when reading a type
 * annotation, which `unwrapExpression` does not cover.
 */
const TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'ChainExpression',
  'ParenthesizedExpression',
])

/** Whether an object literal is annotated as (or satisfies) `SandboxPolicy`. */
const annotatedSandboxPolicy = (node: TSESTree.ObjectExpression): boolean => {
  const isPolicyType = (typeNode: TSESTree.Node | undefined): boolean => {
    if (!typeNode) return false
    if (typeNode.type === 'TSTypeReference' && typeNode.typeName.type === 'Identifier') {
      return typeNode.typeName.name === 'SandboxPolicy'
    }
    return false
  }
  // Walk OUT through transparent wrappers first: `{…} as const satisfies SandboxPolicy` nests the
  // annotation one (or more) wrappers above the literal itself.
  let current: TSESTree.Node = node
  while (current.parent && TRANSPARENT_WRAPPER_TYPES.has(current.parent.type)) {
    const wrapper = current.parent as unknown as { typeAnnotation?: TSESTree.Node }
    if (isPolicyType(wrapper.typeAnnotation)) return true
    current = current.parent
  }
  const parent = current.parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return isPolicyType(parent.id.typeAnnotation?.typeAnnotation)
  }
  return false
}

// ── no-network-disabled ──────────────────────────────────────────────────────

/**
 * Flags `network: { disabled: true }` inside an ADK sandbox policy.
 *
 * `disabled` is not "network off" — it is SRT's network *configuration key omitted*, which means no
 * network namespace restriction at all: UNRESTRICTED network. Deny-all is `network: {}` (an empty
 * allow-list). The field name reads as the opposite of what it does, so this rule says it out loud.
 *
 * Conservative: only an object literal that carries the sibling `filesystem` key (the ADK policy
 * shape) or is annotated `SandboxPolicy` is inspected, so an unrelated `{ network: { disabled: true } }`
 * in some other API is never flagged.
 *
 * It ALSO fires on a `SandboxPolicy`-shaped literal nested inside a skills config — the policy a
 * deployment supplies through `unsafe.scriptsPermissivePolicy`, for instance. That overlap is
 * intended: the nested section is a real sandbox policy at runtime, and the same
 * "disabled-means-unrestricted" misread must not be able to hide one level down inside an object
 * that `adk-skills/no-unsafe-opt-in` is already reporting as unsafe.
 */
const noNetworkDisabled = createRule({
  name: 'no-network-disabled',
  meta: {
    type: 'problem',
    docs: {
      description:
        'In a SandboxPolicy, `network: { disabled: true }` does NOT disable network — it omits SRT network configuration, which leaves network access UNRESTRICTED. Deny-all is `network: {}`.',
    },
    schema: [],
    messages: {
      disabledMeansUnrestricted:
        '`network: { disabled: true }` does not turn the network off — it removes the network restriction entirely, so the sandbox gets UNRESTRICTED network access. Deny-all is `network: {}` (an empty allow-list); name the domains you permit with `allowedDomains` instead. Opt out with an eslint-disable-next-line adk-sandbox/no-network-disabled comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ObjectExpression(node: TSESTree.ObjectExpression) {
        const network = propertyNamed(node, 'network')
        // `network: { disabled: true } as const` is the same network section as a bare literal.
        if (!network) return
        const networkObject = unwrapExpression(network.value)
        if (networkObject.type !== 'ObjectExpression') return
        const disabled = propertyNamed(networkObject, 'disabled')
        if (!disabled || !isTrueLiteral(unwrapExpression(disabled.value))) return
        // Conservative scope: require the sibling `filesystem` key or an explicit SandboxPolicy
        // annotation, so unrelated `{ network: { disabled: true } }` objects stay unflagged.
        if (!propertyNamed(node, 'filesystem') && !annotatedSandboxPolicy(node)) return
        context.report({ node: disabled, messageId: 'disabledMeansUnrestricted' })
      },
    }
  },
})

// ── filesystem-read-default-allow ────────────────────────────────────────────

/**
 * The read axis's canonical broad deny: the filesystem root.
 *
 * Reads are deny-then-allow, and the battery's own matcher treats a `'/'` rule as covering every
 * absolute path (`under()` in `node/fs_node.ts` special-cases it). A deny of any other subtree
 * leaves the rest of the host readable, so `allowRead` entries alongside it re-permit nothing that
 * was ever denied. `'~'` is NOT a broad deny here: nothing in the battery expands a tilde — the
 * model-path layer classifies a leading `~` as a host-escape rejection, and policy rules are passed
 * through to SRT verbatim.
 */
const BROAD_READ_DENY = '/'

const isBroadReadDeny = (node: TSESTree.Node): boolean => {
  const bare = unwrapExpression(node)
  return bare.type === 'Literal' && bare.value === BROAD_READ_DENY
}

const hasBroadReadDeny = (node: TSESTree.Node | undefined): boolean => {
  if (!node) return false
  const bare = unwrapExpression(node)
  if (bare.type !== 'ArrayExpression') return false
  return bare.elements.some((element) => element !== null && isBroadReadDeny(element))
}

/**
 * Flags a sandbox policy `filesystem` literal that sets `allowRead` with no broad
 * `denyRead: ['/']` before it, because reads still default to ALLOW across the whole host.
 */
const filesystemReadDefaultAllow = createRule({
  name: 'filesystem-read-default-allow',
  meta: {
    type: 'problem',
    docs: {
      description:
        "Reads are deny-then-allow: without a broad `denyRead: ['/']`, an `allowRead` list re-permits paths that were never refused and the entire host stays readable. The rule flags only the `allowRead` claim (an `allowRead`-less `denyRead` hides paths and makes no confinement promise).",
    },
    schema: [],
    messages: {
      readDefaultsToAllow:
        "`allowRead` is deny-then-allow: with no broad `denyRead` entry of '/' BEFORE it, the read axis still allows the WHOLE host, and this list re-permits nothing that was ever denied (only the mandatory sensitive-file set and your `denyRead` subtrees are refused). Add `denyRead: ['/']` ahead of the paths you re-permit, or drop the read lists if unrestricted reads are intended. Opt out with an eslint-disable-next-line adk-sandbox/filesystem-read-default-allow comment + reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ObjectExpression(node: TSESTree.ObjectExpression) {
        // The rule reads the READ SECTION: the value of a `filesystem` property when the literal has
        // one, or the literal itself when it is annotated `SandboxPolicy` (so the section may be the
        // whole annotation target).
        const filesystem = propertyNamed(node, 'filesystem')
        const isAnnotated = annotatedSandboxPolicy(node)
        const section = filesystem
          ? unwrapExpression(filesystem.value)
          : isAnnotated
            ? node
            : undefined
        if (!section || section.type !== 'ObjectExpression') return
        // A spread at the LITERAL'S top level could carry the sibling keys and the read lists;
        // stay conservative.
        if (node.properties.some((p) => p.type === 'SpreadElement')) return
        // EXACT SEMANTICS: the rule reports an `allowRead` list that no broad `denyRead: ['/']`
        // precedes. `allowRead` is the property that reads as "only these paths are readable", and
        // it is only true *inside* a deny: reads are deny-then-allow, so an allow list with no broad
        // deny re-permits paths that were never refused and leaves the whole host readable.
        //
        // A `denyRead` list on its own is NOT reported: that is the battery's documented way to hide
        // specific paths (a credential file, a hooks directory) from a host you accept is otherwise
        // readable, and it makes no confinement claim that could be false.
        const allowRead = propertyNamed(section, 'allowRead')
        if (!allowRead) return
        // Kill switch: with filesystem rules off there is no read axis to reason about.
        const disabled = propertyNamed(section, 'disabled')
        if (disabled && isTrueLiteral(unwrapExpression(disabled.value))) return
        const denyRead = propertyNamed(section, 'denyRead')
        if (hasBroadReadDeny(denyRead?.value)) return
        // A spread INSIDE the section could carry the broad deny; stay conservative.
        if (section.properties.some((p) => p.type === 'SpreadElement')) return
        // A deny list the rule cannot read may carry the broad deny; stay conservative.
        if (denyRead && unwrapExpression(denyRead.value).type !== 'ArrayExpression') return
        context.report({ node: allowRead, messageId: 'readDefaultsToAllow' })
      },
    }
  },
})

// ── require-gate ─────────────────────────────────────────────────────────────

/** The sandbox factories whose construction rejects a missing gate with `E_SANDBOX_GATE_REQUIRED`. */
const GATED_FACTORIES = new Set(['createRunShellCommandTool', 'createEvaluateJavascriptTool'])

/**
 * Flags a gated sandbox factory called with an object literal that has no `gate` key.
 *
 * Both factories throw `E_SANDBOX_GATE_REQUIRED` at construction — a read of `.env` is an
 * exfiltration event and `run_shell_command` is a shell — so the failure belongs at lint time, not
 * at the first construction in production. A spread element means the gate may come from `...opts`,
 * which the rule cannot see: it stays silent rather than guess.
 */
const requireGate = createRule({
  name: 'require-gate',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A gated sandbox factory (`createRunShellCommandTool`, `createEvaluateJavascriptTool`) called without a `gate` throws `E_SANDBOX_GATE_REQUIRED` at construction. Supply the approval callback explicitly. A spread argument is not inspected.',
    },
    schema: [],
    messages: {
      requireGate:
        '`{{factory}}` requires a `gate` — sandbox tools have no reference gate and refuse to construct without one (`E_SANDBOX_GATE_REQUIRED`), because a gate-free shell or read is an unbounded capability. Pass a gate, or opt out with an eslint-disable-next-line adk-sandbox/require-gate comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    let bindings: ImportBindings = new Map()
    return {
      Program(node: TSESTree.Program): void {
        bindings = collectImportBindings(node)
      },
      CallExpression(node: TSESTree.CallExpression) {
        const resolved = resolveCalleeName(bindings, node.callee)
        // The binding policy: the callee names a gated factory export — by its plain import, by a
        // local alias, through a namespace module, or when the file never binds the name at all (an
        // unimported callee is still matched). A same-named import from another module is not the
        // battery factory and must not inherit its contract.
        if (!resolved || !GATED_FACTORIES.has(resolved.name)) return
        if (resolved.imported && !resolved.fromAdk) return
        const factory = resolved.name
        const arg = node.arguments[0]
        // `{…} as X` / `satisfies X` / `<X>{…}` / `x!` are transparent: the argument is still an
        // object literal with no gate.
        if (!arg || unwrapExpression(arg).type !== 'ObjectExpression') return
        const literal = unwrapExpression(arg) as TSESTree.ObjectExpression
        if (literal.properties.some((p) => p.type === 'SpreadElement')) return
        const gate = propertyNamed(literal, 'gate')
        if (gate && !isNotCallableValue(gate.value)) return
        context.report({ node: arg, messageId: 'requireGate', data: { factory } })
      },
    }
  },
})

// ── plugin assembly ──────────────────────────────────────────────────────────

/**
 * Map of rule id (without the `adk-sandbox/` plugin prefix) to its rule object. Registered on the
 * plugin as `rules`, so configs reference them as `adk-sandbox/{id}`.
 */
export const rules = {
  'no-network-disabled': noNetworkDisabled,
  'filesystem-read-default-allow': filesystemReadDefaultAllow,
  'require-gate': requireGate,
} satisfies FlatConfig.Plugin['rules']

/**
 * The sandbox battery's ESLint plugin object. Register under the `adk-sandbox` namespace:
 * `plugins: { 'adk-sandbox': plugin }`.
 */
export const plugin: FlatConfig.Plugin = {
  meta: { name: '@nhtio/adk/batteries/sandbox/lint', version: __VERSION__ },
  rules,
}

/**
 * Named config presets. `recommended` registers the plugin under the `adk-sandbox` namespace and
 * enables every rule: the two policy-shape rules at `warn` (a deployment may mean them, and the
 * warning is a review signal), and `require-gate` at `error` (construction throws without it).
 */
export const configs = {
  recommended: {
    name: '@nhtio/adk/batteries/sandbox/lint/recommended',
    plugins: { 'adk-sandbox': plugin },
    rules: {
      'adk-sandbox/no-network-disabled': 'warn',
      'adk-sandbox/filesystem-read-default-allow': 'warn',
      'adk-sandbox/require-gate': 'error',
    },
  } satisfies FlatConfig.Config,
}

/**
 * Default export bundles the plugin and its config presets, mirroring the shape ESLint flat
 * configs expect from a plugin module.
 */
export default { plugin, rules, configs }
