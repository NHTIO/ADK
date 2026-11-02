/**
 * @module @nhtio/adk/batteries/skills/lint
 *
 * ESLint rules for consumers of the skills battery: machine-checkable enforcement of the
 * skill-manager contracts that look safe and are not.
 *
 * @remarks
 * Battery-scoped rules ship with the battery, not with the core `@nhtio/adk/eslint` plugin — they
 * only matter to deployments that compose this battery, and they version with the battery's own
 * API. The rules are report-only (no autofix); carve out a deliberate exception with an inline
 * `// eslint-disable-next-line adk-skills/{rule} -- {reason}` comment.
 *
 * `@typescript-eslint/utils` and `eslint` are OPTIONAL peer dependencies of `@nhtio/adk` —
 * installed only by consumers who lint with this plugin. The skills runtime never imports this
 * module, and the `batteries/skills` barrel does not re-export it.
 *
 * @example Flat config
 * ```ts
 * import adkSkills from '@nhtio/adk/batteries/skills/lint'
 *
 * export default [
 *   { plugins: { 'adk-skills': adkSkills.plugin }, rules: adkSkills.configs.recommended.rules },
 * ]
 * ```
 */

import { ESLintUtils } from '@typescript-eslint/utils'
import { collectImportBindings, resolveCalleeName } from '../../eslint/rules'
import type { TSESTree } from '@typescript-eslint/utils'
import type { ImportBindings } from '../../eslint/rules'
import type { FlatConfig } from '@typescript-eslint/utils/ts-eslint'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://adk.nht.io/batteries/skills/lint#${name}`
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

/**
 * Node types that wrap an expression without changing the value it denotes.
 *
 * @remarks
 * Kept identical to `unwrapExpression` in `src/eslint/rules/common.ts`. This battery's lint module
 * cannot import that module (it is untagged, and CONTRIBUTING's barrel rule forbids a battery
 * reaching past a public subpath), so the two copies must be edited together.
 */
const TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'ChainExpression',
  'ParenthesizedExpression',
])

/**
 * Strips every transparent expression wrapper (`as X`, `satisfies X`, `<X>`, `!`, `?.`, parens)
 * from `node` and returns the node that actually carries the value.
 */
const unwrapExpression = (node: TSESTree.Node): TSESTree.Node => {
  let current = node
  while (TRANSPARENT_WRAPPER_TYPES.has(current.type)) {
    current = (current as unknown as { expression: TSESTree.Node }).expression
  }
  return current
}

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

// ── require-gate ─────────────────────────────────────────────────────────────

/**
 * Flags `createSkillManager({...})` with an object-literal argument and no `gate` key. The factory
 * throws `E_INVALID_SKILLS_CONFIG` at runtime for the same omission; this catches it at lint time.
 * A spread element means the gate may come from `...opts`, which the rule cannot see: it stays
 * silent rather than guess.
 *
 * The callee is matched by its EXPORTED name, resolved through the file's import bindings: an
 * aliased `createSkillManager as csm`, a namespace `skills.createSkillManager`, and the
 * optional-chain spelling of either all name the same battery export. A same-named import from a
 * foreign module is out of scope; a name the file never imports at all still matches.
 */
const requireGate = createRule({
  name: 'require-gate',
  meta: {
    type: 'problem',
    docs: {
      description:
        '`createSkillManager` requires a `gate` — skill lifecycle and every skill-supplied tool execute through it, and construction throws `E_INVALID_SKILLS_CONFIG` without one. A spread argument is not inspected.',
    },
    schema: [],
    messages: {
      requireGate:
        '`createSkillManager` requires a `gate` — skill lifecycle and every skill-supplied tool funnel through it, and construction throws `E_INVALID_SKILLS_CONFIG` when it is missing. Pass a gate, or opt out with an eslint-disable-next-line adk-skills/require-gate comment + reason.',
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
        // The binding policy: the callee names the `createSkillManager` export — by its plain
        // import, by a local alias, through a namespace module, or when the file never binds the
        // name at all (an unimported callee is still matched). A same-named import from another
        // module is not the battery factory.
        if (!resolved || resolved.name !== 'createSkillManager') return
        if (resolved.imported && !resolved.fromAdk) return
        const arg = node.arguments[0]
        // `{…} as X` / `satisfies X` / `<X>{…}` / `x!` are transparent: the argument is still an
        // object literal with no gate.
        if (!arg || unwrapExpression(arg).type !== 'ObjectExpression') return
        const literal = unwrapExpression(arg) as TSESTree.ObjectExpression
        if (literal.properties.some((p) => p.type === 'SpreadElement')) return
        const gate = propertyNamed(literal, 'gate')
        if (gate && !isNotCallableValue(gate.value)) return
        context.report({ node: arg, messageId: 'requireGate' })
      },
    }
  },
})

// ── no-unsafe-opt-in ─────────────────────────────────────────────────────────

/**
 * The `unsafe` containment controls, one message each, naming the safety boundary the opt-in
 * removes. The wording follows the TSDoc on `unsafe` in `types.ts`; a drift test pins this table to
 * the declared shape of both configs.
 */
export const UNSAFE_CONTROLS: Record<string, string> = {
  isolatedToolsInProcess:
    'tier-2 skill code runs in the default in-process guest, whose kill is a no-op',
  scriptsPermissivePolicy:
    'the derived narrow script policy is replaced with a caller-supplied permissive policy',
  ungatedSkillTools: 'the mandatory gate around skill-supplied tools is skipped',
}

/** Sibling keys that mark an object literal as a skill-manager or skill-isolation config. */
const CONFIG_KEYS = [
  // SkillManagerConfig
  'sources',
  'gate',
  'defaultChannel',
  'artifactKinds',
  'artifactBindings',
  'scripts',
  'isolation',
  'autoRefresh',
  // SkillIsolationConfig
  'resolveGuest',
  'globals',
  'modules',
  'limits',
  'maxTimeoutSeconds',
  'defaultTimeoutSeconds',
]

/**
 * Whether the `unsafe` property's value enables its control.
 *
 * Only statically-legible values count: `true`, a string, or an object literal (the shape
 * `scriptsPermissivePolicy` takes). An identifier or call is ignored — a variable holding `true` is
 * as likely to hold the narrow default the battery already ships, and a rule that guesses at values
 * it cannot see is a rule people learn to scroll past.
 */
const isEnabled = (node: TSESTree.Node): boolean => {
  const bare = unwrapExpression(node)
  if (bare.type === 'ObjectExpression') return true
  if (bare.type === 'Literal') {
    return bare.value === true || (typeof bare.value === 'string' && bare.value !== '')
  }
  return false
}

/**
 * Flags every enabled entry in the `unsafe` object literal of a skill-manager (or skill-isolation)
 * config. At `warn` this is a diff-visible review signal rather than a ban: a deployment that means
 * it adds `// eslint-disable-next-line adk-skills/no-unsafe-opt-in -- <reason>` on the line.
 */
const noUnsafeOptIn = createRule({
  name: 'no-unsafe-opt-in',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every enabled `unsafe` control removes a named safety boundary — an unkillable in-process guest, the derived narrow script policy, or the mandatory tool gate. One warning per enabled key keeps the decision visible in the diff.',
    },
    schema: [],
    messages: {
      unsafeOptIn:
        '`unsafe.{{key}}` removes a safety boundary: {{boundary}}. If this deployment means it, opt out with an eslint-disable-next-line adk-skills/no-unsafe-opt-in comment + reason on this line.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ObjectExpression(node: TSESTree.ObjectExpression) {
        const unsafe = propertyNamed(node, 'unsafe')
        // `unsafe: {…} as X` is the same unsafe section as a bare literal.
        if (!unsafe) return
        const unsafeObject = unwrapExpression(unsafe.value)
        if (unsafeObject.type !== 'ObjectExpression') return
        // Conservative scope: only a literal that also carries another config key (or names the
        // config type it satisfies) is a skill config, so unrelated `unsafe` objects are ignored.
        const isConfig =
          node.properties.some(
            (p) => p.type === 'Property' && CONFIG_KEYS.includes(literalKey(p) ?? '')
          ) ||
          (node.parent?.type === 'TSSatisfiesExpression' &&
            node.parent.typeAnnotation.type === 'TSTypeReference' &&
            node.parent.typeAnnotation.typeName.type === 'Identifier' &&
            /^Skill(Manager|Isolation)Config$/.test(node.parent.typeAnnotation.typeName.name))
        if (!isConfig) return
        for (const prop of unsafeObject.properties) {
          if (prop.type === 'SpreadElement') continue
          const key = literalKey(prop)
          if (!key || !(key in UNSAFE_CONTROLS)) continue
          if (!isEnabled(prop.value)) continue
          context.report({
            node: prop,
            messageId: 'unsafeOptIn',
            data: { key, boundary: UNSAFE_CONTROLS[key] },
          })
        }
      },
    }
  },
})

// ── plugin assembly ──────────────────────────────────────────────────────────

/**
 * Map of rule id (without the `adk-skills/` plugin prefix) to its rule object. Registered on the
 * plugin as `rules`, so configs reference them as `adk-skills/{id}`.
 */
export const rules = {
  'require-gate': requireGate,
  'no-unsafe-opt-in': noUnsafeOptIn,
} satisfies FlatConfig.Plugin['rules']

/**
 * The skills battery's ESLint plugin object. Register under the `adk-skills` namespace:
 * `plugins: { 'adk-skills': plugin }`.
 */
export const plugin: FlatConfig.Plugin = {
  meta: { name: '@nhtio/adk/batteries/skills/lint', version: __VERSION__ },
  rules,
}

/**
 * Named config presets. `recommended` registers the plugin under the `adk-skills` namespace and
 * enables every rule: `require-gate` at `error` (construction throws without it), and
 * `no-unsafe-opt-in` at `warn` (a review signal, silenced per line with a reason when meant).
 */
export const configs = {
  recommended: {
    name: '@nhtio/adk/batteries/skills/lint/recommended',
    plugins: { 'adk-skills': plugin },
    rules: {
      'adk-skills/require-gate': 'error',
      'adk-skills/no-unsafe-opt-in': 'warn',
    },
  } satisfies FlatConfig.Config,
}

/**
 * Default export bundles the plugin and its config presets, mirroring the shape ESLint flat
 * configs expect from a plugin module.
 */
export default { plugin, rules, configs }
