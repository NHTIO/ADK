import { remark } from 'remark'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { Tokenizable } from '@nhtio/adk'
import { default as path } from 'node:path'
import { toString } from 'mdast-util-to-string'
import { routeFromPath } from '../docs/.vitepress/utils/route_from_path'
import { rewriteAdkVersionTokens } from '../docs/.vitepress/utils/adk_version_tokens'
import type { Heading, Root, RootContent } from 'mdast'

interface ChunkRecord {
  id: string
  pageUrl: string
  anchor: string
  title: string
  headingPath: string[]
  content: string
  bm25Tokens: string[]
}

const repoRoot = path.resolve(__dirname, '..')
const docsRoot = path.join(repoRoot, 'docs')
// Emit into docs/public/ (gitignored), NOT .vitepress/dist directly. VitePress copies public/ verbatim
// into the build output and — crucially — its static server serves public/ files in EVERY mode (dev,
// `vitepress preview`, and production Pages). A file dropped straight into dist/ after the build is only
// served by the dev-only indexer plugin (apply:'serve'); under `vitepress preview` it 404s, which left
// the agent's semantic search returning [] for every doc question. public/ fixes that and also survives a
// bare `docs:build` rerun (it's a source asset, copied on each build).
const outDir = path.join(docsRoot, 'public')
const packageJsonPath = path.join(repoRoot, 'package.json')
const maxTokens = 400
const overlapTokens = 40
const stopwords = new Set(
  'a an and are as at be but by for from has have if in into is it its of on or that the their then there these this to was were with you your we our us can do does did how what when where why which who whom will would should could not no yes via than about above after again against all am any because been before being below between both down during each few further he her here hers herself him himself his i me my myself once only other ours ourselves out over own same she so some such they them themselves through too under until up very'.split(
    ' '
  )
)

const toPosix = (value: string) => value.replace(/\\/g, '/')
const shouldExclude = (rel: string) =>
  /^(api|public|\.vitepress|snippets|node_modules)\//u.test(rel)
const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\s*/u, '')
const frontmatterDraft = (s: string) =>
  s.startsWith('---') && /^draft:\s*true\s*$/mu.test(s.slice(0, s.indexOf('\n---', 3)))
const cleanMarkdown = (s: string) =>
  stripFrontmatter(s)
    .replace(/<llm-only>[\s\S]*?<\/llm-only>/gu, '')
    .replace(/<!--\s*markdownlint-(?:dis|en)able[^>]*-->/gu, '')
const estimate = (s: string) => Tokenizable.estimateTokens(s, 'cl100k_base')

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\//gu, '-')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
const headingSlug = (s: string) => slugify(s)
const tokenize = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter((t) => !stopwords.has(t))

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? walk(full) : [full]
    })
  )
  return files.flat()
}

function sectionText(nodes: RootContent[]) {
  return nodes
    .map((n) => toString(n))
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function splitOversize(text: string): string[] {
  const total = estimate(text)
  if (total <= maxTokens) return [text]
  const words = text.split(/\s+/u).filter(Boolean)
  if (words.length === 0) return []
  const tokensPerWord = total / words.length
  const wordsPerChunk = Math.max(1, Math.floor(maxTokens / tokensPerWord))
  const overlapWords = Math.max(1, Math.floor(overlapTokens / tokensPerWord))
  const stride = Math.max(1, wordsPerChunk - overlapWords)
  const chunks: string[] = []
  for (let start = 0; start < words.length; start += stride) {
    const slice = words.slice(start, start + wordsPerChunk).join(' ')
    if (slice) chunks.push(slice)
    if (start + wordsPerChunk >= words.length) break
  }
  return chunks
}

async function buildChunks(file: string, raw: string): Promise<ChunkRecord[]> {
  const rel = toPosix(path.relative(docsRoot, file))
  const pageUrl = routeFromPath(rel)
  const tree = remark().parse(cleanMarkdown(raw)) as Root
  const chunks: ChunkRecord[] = []
  let title = path.basename(rel, '.md')
  let h2 = ''
  let h3 = ''
  let current: RootContent[] = []
  let currentHeading = ''
  const flush = () => {
    const text = sectionText(current)
    if (!text) return
    const headingPath = [title, h2, h3].filter(Boolean)
    const anchor = headingSlug(currentHeading || h3 || h2 || title)
    for (const part of splitOversize(text)) {
      // Chunk ids become the fence-envelope NONCE (tag name) when rendered to the model. They MUST be
      // unguessable AND non-path-shaped: a path-shaped id like `chunk-<page>-<n>` gets copied by small models
      // as a citation (e.g. `/assembly/events-9`), which the doc-path validator rejects → re-cite loop. Use a
      // random UUID; page provenance lives in the retrievable's `source` (the pageUrl). See the fence-nonce
      // footgun note in docs/the-loop/trust-tiers/envelopes.md.
      const id = randomUUID()
      chunks.push({
        id,
        pageUrl,
        anchor,
        title,
        headingPath,
        content: part,
        bm25Tokens: tokenize(part),
      })
    }
  }
  for (const node of tree.children) {
    if (node.type === 'heading') {
      const heading = toString(node).trim()
      const depth = (node as Heading).depth
      if (depth === 1 && heading) title = heading
      if (depth === 2 || depth === 3) {
        flush()
        current = [node]
        currentHeading = heading
        if (depth === 2) {
          h2 = heading
          h3 = ''
        } else {
          h3 = heading
        }
        continue
      }
    }
    current.push(node)
  }
  flush()
  return chunks
}

// NOTE: this builder is CHUNK-ONLY. It emits the seed documents (ask-adk-index.json) so the
// flagship agent's RAG stays in sync with the real docs, but it no longer embeds them — the
// agent computes vectors ON-DEVICE at boot (see agent_rag.ts). This keeps the docs build fast
// and free of a model dependency; the old `embed()` step + `ask-adk-vectors.bin` are gone.

async function main() {
  const start = Date.now()
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
  const packageVersion = String(packageJson.version)
  console.log(`scanning ${docsRoot}...`)
  const walked = await walk(docsRoot)
  const mdFiles = walked
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !shouldExclude(toPosix(path.relative(docsRoot, f))))
  console.log(`found ${mdFiles.length} markdown files; chunking...`)
  const chunks: ChunkRecord[] = []
  for (const file of mdFiles) {
    const raw = rewriteAdkVersionTokens(await fs.readFile(file, 'utf-8'), packageVersion)
    if (frontmatterDraft(raw)) continue
    const before = chunks.length
    chunks.push(...(await buildChunks(file, raw)))
    const added = chunks.length - before
    if (added > 50) console.log(`  ${path.relative(docsRoot, file)}: ${added} chunks`)
  }
  console.log(`chunked ${chunks.length} total in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  await fs.mkdir(outDir, { recursive: true })
  const json = JSON.stringify(chunks)
  await fs.writeFile(path.join(outDir, 'ask-adk-index.json'), json)
  const jsonBytes = Buffer.byteLength(json)
  console.log(
    `Ask ADK index (chunks only): ${chunks.length} chunks in ${((Date.now() - start) / 1000).toFixed(1)}s`
  )
  console.log(`ask-adk-index.json: ${jsonBytes} bytes (${gzipSync(json).byteLength} gz)`)
  console.log(
    'sample chunks:',
    chunks
      .slice(0, 3)
      .map(({ id, pageUrl, anchor, headingPath }) => ({ id, pageUrl, anchor, headingPath }))
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
