import { default as path } from 'node:path'

/**
 * Batteries — barrel imports only (CONTRIBUTING §1).
 *
 * A file under `src/batteries/<battery>/` may reach its own neighbours with a relative specifier,
 * but anything OUTSIDE that battery directory must go through a published barrel
 * (`@nhtio/adk/...`, or `@nhtio/adk/batteries/<name>[/<sub>]`) exactly as an external consumer
 * would. A relative escape path either deep-imports another battery's internals or the private
 * `src/lib/` tree, and neither is a supported import surface.
 *
 * `src/batteries/index.ts` is the aggregator barrel itself: it sits above every battery and is
 * exempt (it re-exports each battery by its public subpath).
 *
 * Report-only: the fix is a judgement call (pick the fitting barrel, or add the re-export to the
 * target battery's barrel), so there is no autofix.
 */

const BATTERY_DIR_PREFIX = 'src/batteries/'

/** Normalise Windows separators so the path arithmetic is platform-independent. */
const toPosix = (value) => value.split(path.sep).join('/').split('\\').join('/')

/**
 * Resolve the absolute directory of the battery that owns `posix`, an absolute POSIX path.
 *
 * @param {string} posix - The linted file as an absolute POSIX path.
 * @returns {{ root: string, name: string, dir: string } | null} `root` is the absolute
 *   `.../src/batteries/<name>` directory, `name` its basename, `dir` its repo-relative path
 *   (sub-directory included); `null` when the file is not inside a battery.
 */
const batteryOf = (posix) => {
  const index = posix.lastIndexOf(BATTERY_DIR_PREFIX)
  if (index === -1) return null
  const name = posix.slice(index + BATTERY_DIR_PREFIX.length).split('/')[0]
  if (!name) return null
  const root = posix.slice(0, index + BATTERY_DIR_PREFIX.length) + name
  const rest = posix.slice(index + BATTERY_DIR_PREFIX.length + name.length + 1)
  return { root, name, dir: rest.split('/').slice(0, -1).join('/') }
}

const staticString = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('')
  }
  return null
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Batteries must import across battery / src boundaries through public barrels (@nhtio/adk/...), never a relative path.',
    },
    schema: [],
    messages: {
      publicBarrelOnly:
        "Batteries must import across their own directory boundary through a public barrel, not a relative path ('{{source}}' escapes src/batteries/{{battery}}/). Use '@nhtio/adk/<subpath>' or '@nhtio/adk/batteries/<name>' — and if the symbol is missing from that barrel, add the re-export there.",
    },
  },
  create(context) {
    const rawFilename = context.filename || context.physicalFilename || ''
    if (!rawFilename || rawFilename === '<input>' || rawFilename === '<text>') return {}
    const filename = path.resolve(rawFilename)
    const posix = toPosix(filename)

    // The aggregator barrel re-exports every battery by its public subpath; it is not inside a
    // single battery, so the rule does not apply to it.
    if (posix.endsWith(`${BATTERY_DIR_PREFIX}index.ts`)) return {}

    const battery = batteryOf(posix)
    if (!battery) return {}

    const report = (node) => {
      const source = staticString(node.source)
      if (source === null) return
      if (!source.startsWith('./') && !source.startsWith('../')) return

      // Resolve the specifier against the importing file's directory, both lexically (the
      // resolution never needs the filesystem: a directory escape is a prefix relation) — this
      // keeps the rule fast and independent of tsconfig path mapping.
      const baseDir = path.posix.dirname(posix)
      let target
      try {
        target = path.posix.normalize(path.posix.join(baseDir, source))
      } catch {
        return
      }
      if (target === battery.root || target.startsWith(`${battery.root}/`)) return

      context.report({
        node: node.source,
        messageId: 'publicBarrelOnly',
        data: { source, battery: battery.name },
      })
    }

    return {
      ImportDeclaration: report,
      ExportNamedDeclaration: report,
      ExportAllDeclaration: report,
      // Dynamic `import('…')` and `require('…')` are the same boundary crossing.
      ImportExpression: report,
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
        const [argument] = node.arguments
        if (staticString(argument) === null) return
        report({ source: argument })
      },
    }
  },
}

export default rule
