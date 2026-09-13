import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const dist = resolve(root, 'dist')
const packagePath = resolve(dist, 'package.json')

const frameworkImport =
  /(?:from\s+|import\s+|require\s*\(|import\s*\(|export\s+[^;]*?from\s+)[^;\n]{0,80}['"](?:vitest|@vitest|jest|@jest|mocha|node:test)/u
const importSpecifier =
  /(?:from\s+|require\s*\(|import\s*\(|export\s+[^;]*?from\s+)\s*['"]([^'"]+)['"]/gu
const emittedExtensions = ['.mjs', '.cjs', '.js']

const resolveImport = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  const candidates = [base, ...emittedExtensions.map((extension) => `${base}${extension}`)]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

if (!existsSync(packagePath)) {
  throw new Error(`Missing ${relative(root, packagePath)}; run pnpm generate first.`)
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
  exports?: Record<string, { import?: string; require?: string }>
}
const publishableEntries = Object.values(packageJson.exports ?? {}).flatMap((entry) =>
  [entry.import, entry.require]
    .filter((path): path is string => typeof path === 'string')
    .map((path) => resolve(dist, path.replace(/^\.\//u, '')))
)
if (publishableEntries.length === 0) {
  throw new Error('The generated package has no publishable JavaScript entry points.')
}

const visited = new Set<string>()
const violations = new Set<string>()
const missingImports = new Set<string>()
const visit = async (file: string): Promise<void> => {
  if (visited.has(file)) return
  visited.add(file)
  const source = await readFile(file, 'utf8')
  if (frameworkImport.test(source)) violations.add(relative(root, file))

  importSpecifier.lastIndex = 0
  for (const match of source.matchAll(importSpecifier)) {
    const dependency = resolveImport(file, match[1])
    if (!dependency) {
      if (match[1].startsWith('.')) missingImports.add(`${relative(root, file)} -> ${match[1]}`)
      continue
    }
    await visit(dependency)
  }
}

for (const entry of publishableEntries) {
  if (!existsSync(entry)) {
    missingImports.add(`missing entry ${relative(root, entry)}`)
    continue
  }
  await visit(entry)
}

if (missingImports.size > 0) {
  throw new Error(
    `Could not resolve publishable output imports:\n${[...missingImports].map((item) => `  - ${item}`).join('\n')}`
  )
}
if (violations.size > 0) {
  throw new Error(
    `Publishable output imports a test framework:\n${[...violations].map((file) => `  - ${file}`).join('\n')}`
  )
}

console.log(
  `Test-framework import gate passed: scanned ${visited.size} files across ${publishableEntries.length} declared publishable entry points.`
)
