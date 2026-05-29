import { existsSync } from 'node:fs'
import { getEntries } from './utils'
import { extname, relative, resolve } from 'node:path'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'

const BASE_DIR = resolve(__dirname, '..')
const SRC_DIR = resolve(BASE_DIR, 'src')
const skillsDir = resolve(BASE_DIR, 'skills')
const destSkillsDir = resolve(BASE_DIR, 'dist/skills')
const packageJsonPath = resolve(BASE_DIR, 'package.json')
const destPackageJsonPath = resolve(BASE_DIR, 'dist/package.json')

const srcReadmePath = resolve(BASE_DIR, 'README.md')
const destReadmePath = resolve(BASE_DIR, 'dist/README.md')
const srcLicensePath = resolve(BASE_DIR, 'LICENSE.md')
const destLicensePath = resolve(BASE_DIR, 'dist/LICENSE.md')

const doCopyFile = async (src: string, dest: string) => {
  if (!existsSync(src)) return
  return await copyFile(src, dest)
}

const docsUrl = () => (process.env.CI_PAGES_URL || '').replace(/\/+$/, '')

const githubMirrorRepositoryUrls = () => {
  const repository = process.env.GITHUB_MIRROR_REPOSITORY?.replace(/^\/+|\/+$/g, '')
  if (!repository) return undefined
  const publicRepositoryUrl = `https://github.com/${repository}`
  return {
    homepage: `${publicRepositoryUrl}#readme`,
    repository: {
      type: 'git',
      url: `git+${publicRepositoryUrl}.git`,
    },
    bugs: {
      url: `${publicRepositoryUrl}/issues`,
    },
  }
}

const textSkillExtensions = new Set(['.md', '.txt', '.json', '.jsonc', '.yaml', '.yml'])

const rewriteSkillContent = (content: string, packageVersion: string, resolvedDocsUrl: string) => {
  if (content.includes('$CI_PAGES_URL') && !resolvedDocsUrl) {
    throw new Error('Set CI_PAGES_URL before packaging skills.')
  }

  return content
    .replace(/\$CI_PAGES_URL/g, resolvedDocsUrl)
    .replace(/^(\s*version:\s*)['"][^'"]+['"]\s*$/mu, `$1"${packageVersion}"`)
    .replace(/^(-\s+Version:\s+`)[^`]+(`\s*)$/mu, `$1${packageVersion}$2`)
}

const copySkills = async (
  src: string,
  dest: string,
  packageVersion: string,
  resolvedDocsUrl: string
) => {
  if (!existsSync(src)) return
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = resolve(src, entry.name)
      const destPath = resolve(dest, entry.name)
      if (entry.isDirectory()) {
        await copySkills(srcPath, destPath, packageVersion, resolvedDocsUrl)
        return
      }
      if (!entry.isFile()) return
      if (!textSkillExtensions.has(extname(entry.name))) {
        await copyFile(srcPath, destPath)
        return
      }
      const content = await readFile(srcPath, 'utf-8')
      await writeFile(destPath, rewriteSkillContent(content, packageVersion, resolvedDocsUrl))
    })
  )
}

readFile(packageJsonPath, 'utf-8').then(async (packageJson) => {
  const parsedPackageJson = JSON.parse(packageJson)
  parsedPackageJson.type = 'module'
  if (!parsedPackageJson.dependencies) {
    parsedPackageJson.dependencies = {}
  }
  if (parsedPackageJson.nonExternal) {
    parsedPackageJson.nonExternal.forEach((mod: string) => {
      delete parsedPackageJson.dependencies[mod]
      // Also strip from peer maps so a bundled-into-dist module never reappears as a peer
      // requirement on the consumer side.
      if (parsedPackageJson.peerDependencies) {
        delete parsedPackageJson.peerDependencies[mod]
      }
      if (parsedPackageJson.peerDependenciesMeta) {
        delete parsedPackageJson.peerDependenciesMeta[mod]
      }
    })
  }
  delete parsedPackageJson.devDependencies
  delete parsedPackageJson.scripts
  const entries = await getEntries(SRC_DIR, parsedPackageJson.name)
  if (!('index' in entries)) {
    throw new Error('You cannot package a library without an index entry')
  }
  // dts_complex emits .d.ts files mirroring the source tree (so `src/batteries/tools/index.ts`
  // becomes `dist/batteries/tools/index.d.ts`), while the JS bundles emit at the entry-key path
  // (`dist/batteries/tools.{mjs,cjs}`). Compute the types path from the source location so the
  // exports map stays correct regardless of whether the source is a flat file or an `index.ts`.
  const typesPathFor = (sourceAbsPath: string) => {
    const rel = relative(SRC_DIR, sourceAbsPath).replace(/\\/g, '/')
    return `./${rel.replace(/\.ts$/, '.d.ts')}`
  }
  const exportKeys = Object.keys(entries)
  parsedPackageJson.module = './index.mjs'
  parsedPackageJson.main = './index.cjs'
  Object.assign(parsedPackageJson, githubMirrorRepositoryUrls())
  const exports: Record<string, { import: string; require: string; types: string }> = {
    '.': {
      import: './index.mjs',
      require: './index.cjs',
      types: typesPathFor(entries.index),
    },
  }
  exportKeys.forEach((key) => {
    if (key === 'index') return
    const exportKey = `./${key}`
    exports[exportKey] = {
      import: `./${key}.mjs`,
      require: `./${key}.cjs`,
      types: typesPathFor(entries[key]),
    }
  })
  parsedPackageJson.exports = exports
  delete parsedPackageJson.files
  delete parsedPackageJson.resolutions
  delete parsedPackageJson.nonExternal
  await Promise.all([
    writeFile(destPackageJsonPath, JSON.stringify(parsedPackageJson, null, 2)),
    doCopyFile(srcReadmePath, destReadmePath),
    doCopyFile(srcLicensePath, destLicensePath),
    copySkills(skillsDir, destSkillsDir, parsedPackageJson.version, docsUrl()),
  ])
})
