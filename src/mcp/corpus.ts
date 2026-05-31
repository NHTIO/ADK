import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface McpCorpusDocument {
  id: string
  title: string
  kind: 'skill' | 'skill-reference' | 'doc' | 'api' | 'changelog'
  path: string
  uri: string
  content: string
}

export interface McpCorpus {
  packageName: string
  packageVersion: string
  docsUrl: string
  generatedAt: string
  documents: McpCorpusDocument[]
}

export interface SearchResult {
  document: McpCorpusDocument
  score: number
  excerpt: string
}

const tokenPattern = /[\p{L}\p{N}_.$/-]+/gu

export const tokenize = (input: string) => input.toLowerCase().match(tokenPattern) ?? []

const executableDir = () => dirname(fileURLToPath(import.meta.url))

export const loadCorpus = () => {
  const path = join(executableDir(), 'mcp', 'adk-docs-corpus.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as McpCorpus
}

export const findDocument = (corpus: McpCorpus, idOrUriOrPath: string) => {
  const normalized = idOrUriOrPath.replace(/^\/+|\/+$/gu, '')
  return corpus.documents.find(
    (document) =>
      document.id === idOrUriOrPath ||
      document.uri === idOrUriOrPath ||
      document.path === idOrUriOrPath ||
      document.path === normalized ||
      document.path.replace(/\.md$/u, '') === normalized ||
      document.uri.replace(/^adk:\/\//u, '') === normalized
  )
}

const excerptFor = (content: string, queryTokens: string[], maxLength = 900) => {
  const lower = content.toLowerCase()
  const firstHit = queryTokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  const start = Math.max(0, (firstHit ?? 0) - 180)
  const excerpt = content
    .slice(start, start + maxLength)
    .replace(/\s+/gu, ' ')
    .trim()
  return `${start > 0 ? '…' : ''}${excerpt}${start + maxLength < content.length ? '…' : ''}`
}

export const searchCorpus = (
  corpus: McpCorpus,
  query: string,
  limit = 8,
  kind?: McpCorpusDocument['kind'] | 'all'
): SearchResult[] => {
  const queryTokens = Array.from(new Set(tokenize(query))).filter((token) => token.length > 1)
  if (!queryTokens.length) return []
  return corpus.documents
    .filter((document) => !kind || kind === 'all' || document.kind === kind)
    .map((document) => {
      const haystack =
        `${document.title}\n${document.kind}\n${document.path}\n${document.content}`.toLowerCase()
      const title = document.title.toLowerCase()
      const path = document.path.toLowerCase()
      const score = queryTokens.reduce((sum, token) => {
        const occurrences = haystack.split(token).length - 1
        const titleBonus = title.includes(token) ? 8 : 0
        const pathBonus = path.includes(token) ? 4 : 0
        return sum + occurrences + titleBonus + pathBonus
      }, 0)
      return {
        document,
        score,
        excerpt: excerptFor(document.content, queryTokens),
      }
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path))
    .slice(0, Math.max(1, Math.min(limit, 25)))
}

export const assemblyGuidance = (corpus: McpCorpus, topic?: string) => {
  const skill = corpus.documents.find((document) => document.kind === 'skill')
  if (!topic) {
    return [skill, ...corpus.documents.filter((document) => document.kind === 'skill-reference')]
      .filter((document): document is McpCorpusDocument => Boolean(document))
      .map((document) => `# ${document.title}\n\n${document.content}`)
      .join('\n\n---\n\n')
  }
  const results = searchCorpus(corpus, topic, 4).filter((result) =>
    ['skill', 'skill-reference'].includes(result.document.kind)
  )
  return results.length
    ? results
        .map((result) => `# ${result.document.title}\n\n${result.document.content}`)
        .join('\n\n---\n\n')
    : skill?.content || ''
}
