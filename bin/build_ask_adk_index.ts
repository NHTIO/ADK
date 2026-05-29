import { remark } from 'remark'
import { gzipSync } from 'node:zlib'
import { promises as fs } from 'node:fs'
import { Tokenizable } from '@nhtio/adk'
import { default as path } from 'node:path'
import { toString } from 'mdast-util-to-string'
import { routeFromPath } from '../docs/.vitepress/utils/route_from_path'
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
const outDir = path.join(docsRoot, '.vitepress', 'dist')
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
  const pageSlug = slugify(pageUrl) || 'home'
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
      const id = `chunk-${pageSlug}-${chunks.length + 1}`
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

async function embed(contents: string[]): Promise<Float32Array> {
  console.log(`loading @xenova/transformers (Xenova/all-MiniLM-L6-v2)...`)
  const transformers = await import('@xenova/transformers')
  const extractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  console.log(`extractor loaded; embedding ${contents.length} chunks at batch 32...`)
  const vectors = new Float32Array(contents.length * 384)
  for (let i = 0; i < contents.length; i += 32) {
    const batch = contents.slice(i, i + 32)
    const output: any = await extractor(batch, { pooling: 'mean', normalize: true })
    const data = Array.from(output.data ?? output.tolist().flat()) as number[]
    vectors.set(data, i * 384)
    console.log(`embedded ${Math.min(i + 32, contents.length)}/${contents.length}`)
  }
  return vectors
}

async function main() {
  const start = Date.now()
  console.log(`scanning ${docsRoot}...`)
  const walked = await walk(docsRoot)
  const mdFiles = walked
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !shouldExclude(toPosix(path.relative(docsRoot, f))))
  console.log(`found ${mdFiles.length} markdown files; chunking...`)
  const chunks: ChunkRecord[] = []
  for (const file of mdFiles) {
    const raw = await fs.readFile(file, 'utf-8')
    if (frontmatterDraft(raw)) continue
    const before = chunks.length
    chunks.push(...(await buildChunks(file, raw)))
    const added = chunks.length - before
    if (added > 50) console.log(`  ${path.relative(docsRoot, file)}: ${added} chunks`)
  }
  console.log(`chunked ${chunks.length} total in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  await fs.mkdir(outDir, { recursive: true })
  const vectors = await embed(chunks.map((c) => c.content))
  const json = JSON.stringify(chunks)
  await fs.writeFile(path.join(outDir, 'ask-adk-index.json'), json)
  await fs.writeFile(path.join(outDir, 'ask-adk-vectors.bin'), Buffer.from(vectors.buffer))
  const jsonBytes = Buffer.byteLength(json)
  const binBytes = vectors.byteLength
  console.log(
    `Ask ADK index: ${chunks.length} chunks in ${((Date.now() - start) / 1000).toFixed(1)}s`
  )
  console.log(`ask-adk-index.json: ${jsonBytes} bytes (${gzipSync(json).byteLength} gz)`)
  console.log(
    `ask-adk-vectors.bin: ${binBytes} bytes (${gzipSync(Buffer.from(vectors.buffer)).byteLength} gz)`
  )
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
