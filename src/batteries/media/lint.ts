/**
 * @module @nhtio/adk/batteries/media/lint
 *
 * ESLint rules for consumers of the media pipeline battery: machine-checkable enforcement of
 * the engine-composition contracts implementors are most likely to get wrong.
 *
 * @remarks
 * Battery-scoped rules ship with the battery, not with the core `@nhtio/adk/eslint` plugin —
 * they only matter to deployments that compose this battery, and they version with the
 * battery's own API. The rules are report-only (no autofix); carve out a deliberate exception
 * with an inline `// eslint-disable-next-line adk-media/{rule} -- {reason}` comment.
 *
 * `@typescript-eslint/utils` and `eslint` are OPTIONAL peer dependencies of `@nhtio/adk` —
 * installed only by consumers who lint with this plugin. The battery never imports this
 * module at runtime.
 *
 * @example Flat config
 * ```ts
 * import adkMedia from '@nhtio/adk/batteries/media/lint'
 *
 * export default [
 *   { plugins: { 'adk-media': adkMedia.plugin }, rules: adkMedia.configs.recommended.rules },
 * ]
 * ```
 */

import { createRequire } from 'node:module'
import { ESLintUtils } from '@typescript-eslint/utils'
import type { TSESTree } from '@typescript-eslint/utils'
import type { FlatConfig } from '@typescript-eslint/utils/ts-eslint'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://adk.nht.io/batteries/media/lint#${name}`
)

// ── prefer-engine-resolver ───────────────────────────────────────────────────

const ENGINE_SUBPATH = /^@nhtio\/adk\/batteries\/media\/engines\//

/**
 * Flags a static value import of a bundled engine subpath. The documented canonical supply
 * form is the dynamic-import resolver, which keeps the engine wrapper module out of every
 * bundle that merely might use it. Type-only imports are fine.
 */
const preferEngineResolver = createRule({
  name: 'prefer-engine-resolver',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Supply bundled media engines as dynamic-import resolvers, not static imports — a static import puts the engine wrapper in every bundle, even when the engine is conditional.',
    },
    schema: [],
    messages: {
      preferResolver:
        "Import bundled engines lazily: supply `() => import('{{source}}').then((m) => m.{{hint}}(…))` in the engines array instead of a static import. Static imports put the engine wrapper module in every bundle. Opt out with an eslint-disable-next-line adk-media/prefer-engine-resolver comment + reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (typeof node.source.value !== 'string') return
        if (!ENGINE_SUBPATH.test(node.source.value)) return
        if (node.importKind === 'type') return
        const valueSpecifiers = node.specifiers.filter(
          (s) => !(s.type === 'ImportSpecifier' && s.importKind === 'type')
        )
        if (valueSpecifiers.length === 0) return
        const first = valueSpecifiers[0]
        const hint =
          first.type === 'ImportSpecifier' && first.imported.type === 'Identifier'
            ? first.imported.name
            : 'engineFactory'
        context.report({
          node,
          messageId: 'preferResolver',
          data: { source: node.source.value, hint },
        })
      },
    }
  },
})

// ── no-shadowed-engine ───────────────────────────────────────────────────────

/** A statically-derived capability summary for one engines-array element. */
export interface EngineSummary {
  /** Display label for the diagnostic. */
  label: string
  /** Mutate groups: input patterns, ops, encodes. */
  mutates: Array<{ over: string[]; ops: string[]; encodes: string[] }>
  /** Convert groups: input patterns, target tokens. */
  converts: Array<{ from: string[]; to: string[] }>
  /** Edit groups: input patterns, ops. */
  edits: Array<{ over: string[]; ops: string[] }>
}

const SHEET_OPS = [
  'sheet.add_rows',
  'sheet.add_columns',
  'sheet.update_cells',
  'sheet.delete_rows',
  'sheet.delete_columns',
  'sheet.rename_sheet',
  'sheet.add_sheet',
  'sheet.remove_sheet',
  'sheet.reorder_sheets',
  'sheet.transform_table',
]

const SHEET_WRITE_TARGETS = [
  'xlsx',
  'xlsm',
  'xlsb',
  'xls',
  'ods',
  'fods',
  'csv',
  'txt',
  'html',
  'rtf',
  'sylk',
  'dif',
  'dbf',
  'numbers',
  'json',
]

const SHEET_READ_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet-flat-xml',
  'text/csv',
  'application/x-iwork-numbers-sffnumbers',
  'application/x-sylk',
  'application/x-dif',
  'application/x-dbf',
]

/**
 * Known declarations of the bundled engine factories, for shadow analysis. An ESLint rule
 * cannot execute the factories it lints, so this table mirrors their declarations by hand —
 * and is pinned against the live factories by a drift test (`lint_drift.node.spec.ts`).
 * Exported for that test only.
 */
export const BUNDLED_SUMMARIES: Record<string, EngineSummary> = {
  dataEngine: {
    label: 'dataEngine',
    mutates: [],
    converts: [
      { from: ['application/x-adk-empty'], to: ['txt', 'md', 'json', 'yaml', 'csv', 'html'] },
      { from: ['application/json'], to: ['yaml', 'txt', 'csv'] },
      { from: ['application/yaml'], to: ['json'] },
      { from: ['text/csv'], to: ['json'] },
    ],
    edits: [],
  },
  exceljsEngine: {
    label: 'exceljsEngine',
    mutates: [],
    converts: [{ from: ['application/x-adk-empty'], to: ['xlsx'] }],
    edits: [
      {
        over: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ops: SHEET_OPS,
      },
    ],
  },
  jimpEngine: {
    label: 'jimpEngine',
    mutates: [
      {
        over: ['image/png', 'image/jpeg', 'image/bmp', 'image/gif', 'image/tiff'],
        ops: ['resize', 'rotate', 'flip', 'strip_metadata'],
        encodes: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff'],
      },
    ],
    converts: [
      { from: ['application/x-adk-empty'], to: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff'] },
    ],
    edits: [],
  },
  sharpEngine: {
    label: 'sharpEngine',
    mutates: [
      {
        over: ['image/*'],
        ops: ['resize', 'rotate', 'flip', 'strip_metadata'],
        encodes: ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'avif', 'gif'],
      },
    ],
    converts: [
      {
        from: ['application/x-adk-empty'],
        to: ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'avif', 'gif'],
      },
    ],
    edits: [],
  },
  sheetjsEngine: {
    label: 'sheetjsEngine',
    mutates: [],
    converts: [
      { from: ['application/x-adk-empty'], to: SHEET_WRITE_TARGETS },
      { from: SHEET_READ_MIMES, to: SHEET_WRITE_TARGETS },
    ],
    edits: [{ over: SHEET_READ_MIMES, ops: SHEET_OPS }],
  },
}

const literalStrings = (node: TSESTree.Node | undefined): string[] | undefined => {
  if (!node || node.type !== 'ArrayExpression') return undefined
  const out: string[] = []
  for (const el of node.elements) {
    if (!el || el.type !== 'Literal' || typeof el.value !== 'string') return undefined
    out.push(el.value)
  }
  return out
}

const propOf = (obj: TSESTree.ObjectExpression, name: string): TSESTree.Node | undefined =>
  obj.properties.find(
    (p): p is TSESTree.Property =>
      p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.key.name === name
  )?.value

/** Find the bundled factory name referenced by an element (direct call or resolver arrow). */
const bundledFactoryName = (node: TSESTree.Node): string | undefined => {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name in BUNDLED_SUMMARIES
  ) {
    return node.callee.name
  }
  // Resolver forms: () => …; scan the body for m.jimpEngine(…) / jimpEngine(…).
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    let found: string | undefined
    const visit = (n: TSESTree.Node): void => {
      if (found) return
      if (n.type === 'CallExpression') {
        if (n.callee.type === 'Identifier' && n.callee.name in BUNDLED_SUMMARIES) {
          found = n.callee.name
        } else if (
          n.callee.type === 'MemberExpression' &&
          n.callee.property.type === 'Identifier' &&
          n.callee.property.name in BUNDLED_SUMMARIES
        ) {
          found = n.callee.property.name
        }
      }
      for (const key of Object.keys(n)) {
        if (key === 'parent') continue
        const value = (n as unknown as Record<string, unknown>)[key]
        const children = Array.isArray(value) ? value : [value]
        for (const child of children) {
          if (!child || typeof child !== 'object') continue
          const childNode = child as TSESTree.Node
          if (typeof childNode.type !== 'string') continue
          visit(childNode)
        }
      }
    }
    visit(node.body)
    return found
  }
  return undefined
}

/** Derive a capability summary from an element, or undefined when not statically known. */
const summarize = (node: TSESTree.Node): EngineSummary | undefined => {
  const factory = bundledFactoryName(node)
  if (factory) return BUNDLED_SUMMARIES[factory]
  if (node.type !== 'ObjectExpression') return undefined
  const idNode = propOf(node, 'id')
  const label =
    idNode?.type === 'Literal' && typeof idNode.value === 'string' ? idNode.value : 'engine'
  const summary: EngineSummary = { label, mutates: [], converts: [], edits: [] }
  const mutates = propOf(node, 'mutates')
  if (mutates) {
    if (mutates.type !== 'ArrayExpression') return undefined
    for (const el of mutates.elements) {
      if (!el || el.type !== 'ObjectExpression') return undefined
      const over = literalStrings(propOf(el, 'over'))
      const ops = literalStrings(propOf(el, 'ops'))
      const encodes = literalStrings(propOf(el, 'encodes'))
      if (!over || !ops || !encodes) return undefined
      summary.mutates.push({ over, ops, encodes })
    }
  }
  const converts = propOf(node, 'converts')
  if (converts) {
    if (converts.type !== 'ArrayExpression') return undefined
    for (const el of converts.elements) {
      if (!el || el.type !== 'ObjectExpression') return undefined
      const from = literalStrings(propOf(el, 'from'))
      const to = literalStrings(propOf(el, 'to'))
      if (!from || !to) return undefined
      summary.converts.push({ from, to })
    }
  }
  const edits = propOf(node, 'edits')
  if (edits) {
    if (edits.type !== 'ArrayExpression') return undefined
    for (const el of edits.elements) {
      if (!el || el.type !== 'ObjectExpression') return undefined
      const over = literalStrings(propOf(el, 'over'))
      const ops = literalStrings(propOf(el, 'ops'))
      if (!over || !ops) return undefined
      summary.edits.push({ over, ops })
    }
  }
  if (summary.mutates.length + summary.converts.length + summary.edits.length === 0) {
    return undefined
  }
  return summary
}

const patternCovers = (broad: string, narrow: string): boolean => {
  if (broad === narrow) return true
  if (broad.endsWith('/*')) return narrow.startsWith(broad.slice(0, -1))
  return false
}

const patternsCover = (broad: string[], narrow: string[]): boolean =>
  narrow.every((n) => broad.some((b) => patternCovers(b, n)))

const subset = (sup: string[], sub: string[]): boolean => sub.every((s) => sup.includes(s))

/** `true` when EVERY capability of `later` is subsumed by some capability of `earlier`. */
const shadows = (earlier: EngineSummary, later: EngineSummary): boolean => {
  if (later.mutates.length + later.converts.length + later.edits.length === 0) return false
  const mutatesCovered = later.mutates.every((lm) =>
    earlier.mutates.some(
      (em) =>
        patternsCover(em.over, lm.over) && subset(em.ops, lm.ops) && subset(em.encodes, lm.encodes)
    )
  )
  const convertsCovered = later.converts.every((lc) =>
    earlier.converts.some((ec) => patternsCover(ec.from, lc.from) && subset(ec.to, lc.to))
  )
  const editsCovered = later.edits.every((le) =>
    earlier.edits.some((ee) => patternsCover(ee.over, le.over) && subset(ee.ops, le.ops))
  )
  return mutatesCovered && convertsCovered && editsCovered
}

/**
 * Flags an engines-array element whose statically-known capabilities are entirely covered by
 * an EARLIER element — dispatch is first-capable-wins, so the later engine is dead code.
 */
const noShadowedEngine = createRule({
  name: 'no-shadowed-engine',
  meta: {
    type: 'problem',
    docs: {
      description:
        'An engine whose declared capabilities are a subset of an earlier engine in the array can never be selected — first-capable-wins dispatch makes it dead code. Reorder (narrow before broad) or remove it.',
    },
    schema: [],
    messages: {
      shadowed:
        'Engine "{{later}}" can never be selected: "{{earlier}}" appears earlier in the array and declares a superset of its capabilities (dispatch is first-capable-wins). Put the narrower engine first, or remove it. Opt out with an eslint-disable-next-line adk-media/no-shadowed-engine comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'createMediaPipeline') {
          return
        }
        const config = node.arguments[0]
        if (!config || config.type !== 'ObjectExpression') return
        const engines = propOf(config, 'engines')
        if (!engines || engines.type !== 'ArrayExpression') return
        const summaries = engines.elements.map((el) => (el ? summarize(el) : undefined))
        for (let i = 1; i < summaries.length; i++) {
          const later = summaries[i]
          if (!later) continue
          for (let j = 0; j < i; j++) {
            const earlier = summaries[j]
            if (!earlier) continue
            if (shadows(earlier, later)) {
              context.report({
                node: engines.elements[i]!,
                messageId: 'shadowed',
                data: { earlier: earlier.label, later: later.label },
              })
              break
            }
          }
        }
      },
    }
  },
})

// ── augment-contracts-module ─────────────────────────────────────────────────

const CONTRACTS_SUBPATH = '@nhtio/adk/batteries/media/contracts'

/**
 * Flags a `ConvertOptions` declaration-merging block whose module specifier is not the
 * contracts subpath. Augmenting the barrel (or any other module) silently does nothing —
 * the keys never merge, and the typo costs hours.
 */
const augmentContractsModule = createRule({
  name: 'augment-contracts-module',
  meta: {
    type: 'problem',
    docs: {
      description:
        'ConvertOptions augmentation must target the contracts subpath — declaration merging against any other module specifier silently fails to merge.',
    },
    schema: [],
    messages: {
      wrongModule:
        'This ConvertOptions augmentation targets "{{actual}}", so it will silently never merge. Declaration merging must target the module that declares the interface: declare module \'{{expected}}\'.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TSModuleDeclaration(node: TSESTree.TSModuleDeclaration) {
        if (node.global) return
        if (node.id.type !== 'Literal' || typeof node.id.value !== 'string') return
        const specifier = node.id.value
        if (specifier === CONTRACTS_SUBPATH || specifier.endsWith('/media/contracts')) return
        // Only flag specifiers that are plausibly aimed at this battery.
        if (!specifier.includes('media') && !specifier.includes('@nhtio/adk')) return
        const body = node.body
        if (!body || body.type !== 'TSModuleBlock') return
        const declaresConvertOptions = body.body.some(
          (stmt) => stmt.type === 'TSInterfaceDeclaration' && stmt.id.name === 'ConvertOptions'
        )
        if (!declaresConvertOptions) return
        context.report({
          node: node.id,
          messageId: 'wrongModule',
          data: { actual: specifier, expected: CONTRACTS_SUBPATH },
        })
      },
    }
  },
})

// ── require-engine-peers ─────────────────────────────────────────────────────

/**
 * The optional peer dependencies each bundled engine subpath lazily imports at runtime.
 * Keyed by the engine's subpath suffix (after `engines/`). An engine with no external peer
 * (soffice, fs_workspace) is absent — there's nothing to install. Kept in lockstep with the
 * engines' actual `import(...)` calls by `engine_peers_drift.node.spec.ts`.
 */
export const ENGINE_PEERS: Record<string, readonly string[]> = {
  jimp: ['jimp'],
  sharp: ['sharp'],
  sheetjs: ['xlsx'],
  exceljs: ['exceljs'],
  data: ['js-yaml', 'papaparse'],
  tesseract_js: ['tesseract.js'],
  audio_decode: ['audio-decode'],
  transformers_asr: ['@huggingface/transformers'],
  execa_executor: ['execa'],
}

/** Map a bundled engine subpath to its peer list, or undefined when it isn't a known engine. */
const peersForSubpath = (source: string): readonly string[] | undefined => {
  const m = /^@nhtio\/adk\/batteries\/media\/engines\/([a-z_]+)$/.exec(source)
  if (!m) return undefined
  return ENGINE_PEERS[m[1]]
}

/**
 * Flags an import of a bundled engine subpath whose optional peer dependency cannot be
 * resolved from the linting file — the "I composed `sheetjsEngine()` but never installed
 * `xlsx`, and now my pipeline throws `E_INVALID_MEDIA_PIPELINE_CONFIG` at the first sheet
 * op" footgun, caught at lint time instead of runtime. Resolution uses Node's resolver from
 * the file's own directory, so it honors the consumer's real `node_modules` layout.
 *
 * Reports once per missing peer per engine import (whether the import is a static value
 * import or a dynamic-import resolver — both reference the engine and both need the peer).
 */
/**
 * The peer-resolution probe: returns `true` when `peer` resolves from `fromFile`. Defaults to
 * Node's resolver anchored at the linted file (so it sees the consumer's `node_modules`).
 * Exposed as a settable seam so the rule's spec can simulate installed/missing peers without
 * depending on the test runner's own `node_modules` layout — production never sets it.
 */
export type PeerResolver = (peer: string, fromFile: string) => boolean

const defaultPeerResolver: PeerResolver = (peer, fromFile) => {
  try {
    createRequire(fromFile).resolve(peer)
    return true
  } catch {
    return false
  }
}

let activePeerResolver: PeerResolver = defaultPeerResolver

/** Override the peer resolver (spec-only seam). Pass nothing to restore the Node default. */
export const setPeerResolverForTesting = (resolver?: PeerResolver): void => {
  activePeerResolver = resolver ?? defaultPeerResolver
}

const requireEnginePeers = createRule<[{ ignore?: readonly string[] }], 'missingPeer'>({
  name: 'require-engine-peers',
  meta: {
    type: 'problem',
    docs: {
      description:
        "A bundled media engine's optional peer dependency must be installed where it's composed — otherwise the pipeline throws at first use, not at construction.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Peer package names to skip (e.g. one resolved via a custom loader the linter cannot see).',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingPeer:
        'The "{{engine}}" media engine requires the optional peer "{{peer}}", which cannot be resolved from this file. Install it ({{install}}) or the pipeline will throw E_INVALID_MEDIA_PIPELINE_CONFIG the first time this engine runs. Opt out with an eslint-disable-next-line adk-media/require-engine-peers comment + reason.',
    },
  },
  defaultOptions: [{ ignore: [] }],
  create(context, [options]) {
    const ignore = new Set(options?.ignore ?? [])

    /** SheetJS ships only from its CDN tarball, so the install hint must not say the registry. */
    const installHint = (peer: string): string =>
      peer === 'xlsx'
        ? 'pnpm add xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'
        : `pnpm add ${peer}`

    const checkSource = (source: string, reportNode: TSESTree.Node): void => {
      const peers = peersForSubpath(source)
      if (!peers) return
      const engine = source.slice(source.lastIndexOf('/') + 1)
      for (const peer of peers) {
        if (ignore.has(peer)) continue
        if (!activePeerResolver(peer, context.filename)) {
          context.report({
            node: reportNode,
            messageId: 'missingPeer',
            data: { engine, peer, install: installHint(peer) },
          })
        }
      }
    }

    return {
      // Static value/type import of an engine subpath.
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (typeof node.source.value === 'string') checkSource(node.source.value, node.source)
      },
      // The canonical resolver form: import('@nhtio/adk/batteries/media/engines/…').
      ImportExpression(node: TSESTree.ImportExpression) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          checkSource(node.source.value, node.source)
        }
      },
    }
  },
})

// ── plugin assembly ──────────────────────────────────────────────────────────

/**
 * Map of rule id (without the `adk-media/` plugin prefix) to its rule object. Registered on
 * the plugin as `rules`, so configs reference them as `adk-media/{id}`.
 */
export const rules = {
  'prefer-engine-resolver': preferEngineResolver,
  'no-shadowed-engine': noShadowedEngine,
  'augment-contracts-module': augmentContractsModule,
  'require-engine-peers': requireEnginePeers,
} satisfies FlatConfig.Plugin['rules']

/**
 * The media battery's ESLint plugin object. Register under the `adk-media` namespace:
 * `plugins: { 'adk-media': plugin }`.
 */
export const plugin: FlatConfig.Plugin = {
  meta: { name: '@nhtio/adk/batteries/media/lint', version: __VERSION__ },
  rules,
}

const recommendedRules: NonNullable<FlatConfig.Config['rules']> = Object.fromEntries(
  Object.keys(rules).map((id) => [`adk-media/${id}`, 'error'])
)

/**
 * Named config presets. `recommended` enables every rule at `error` and registers the plugin
 * under the `adk-media` namespace — spread it into a flat config to adopt the full set.
 */
export const configs = {
  recommended: {
    name: '@nhtio/adk/batteries/media/lint/recommended',
    plugins: { 'adk-media': plugin },
    rules: recommendedRules,
  } satisfies FlatConfig.Config,
}

/**
 * Default export bundles the plugin and its config presets, mirroring the shape ESLint flat
 * configs expect from a plugin module.
 */
export default { plugin, rules, configs }
