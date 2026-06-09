import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { SpooledArtifact, SpooledMarkdownArtifact } from '@nhtio/adk'
import { scriptedExecutor } from '../../../_fixtures/scripted_executor'
import { createSearxngSearchTool } from '@nhtio/adk/batteries/tools/searxng'
import type { SearxngHeaders } from '@nhtio/adk/batteries/tools/searxng'

/**
 * Live integration test against a real SearXNG instance. Env-gated like the vector integration
 * specs: provide a real instance URL (and optionally a JSON object of custom auth headers) and the
 * suite runs; without them it is skipped, so CI stays green with no committed credentials.
 *
 *   TEST_SEARXNG_URL=https://searx.example.org \
 *   TEST_SEARXNG_HEADERS='{"Authorization":"Bearer …"}' \
 *   pnpm test:node tests/functional/batteries/tools/searxng
 */
const url = process.env.TEST_SEARXNG_URL
const rawHeaders = process.env.TEST_SEARXNG_HEADERS

const headers: SearxngHeaders | undefined = rawHeaders
  ? (JSON.parse(rawHeaders) as SearxngHeaders)
  : undefined

const d = url ? describe : describe.skip

/** Read the single tool-call artifact a one-shot scripted run produces. */
const readArtifact = async (
  Ctor: typeof SpooledArtifact,
  args: Record<string, unknown>,
  config: Parameters<typeof createSearxngSearchTool>[0]
): Promise<string[]> => {
  const tool = await createSearxngSearchTool(config)
  const exec = scriptedExecutor([{ toolCalls: [{ tool: tool.name, args }] }, { ack: true }])
  const { run, store } = makeFixtureRunner({ executorCallback: exec, tools: [tool] })
  await run()
  const reader = store.read('tc-i0-1')
  expect(reader).toBeDefined()
  return new Ctor(reader!).cat()
}

interface NormalizedResult {
  title?: string
  url?: string
  content?: string
  engine?: string
  score?: number
}
interface NormalizedPayload {
  query: string
  results: NormalizedResult[]
  number_of_results?: number
  answers?: unknown[]
  suggestions?: unknown[]
}

d('SearXNG search tool (integration)', () => {
  it('authenticates with custom headers and returns the EXPECTED results for the query', async () => {
    const lines = await readArtifact(
      SpooledArtifact,
      { query: 'searxng' },
      {
        instanceUrl: url!,
        // Resolver form, to exercise async header resolution against the live server.
        headers: headers ? async () => headers : undefined,
        resultFormat: 'normalized',
      }
    )
    const parsed = JSON.parse(lines.join('\n')) as NormalizedPayload
    // A 401/403 (bad/absent auth) or a disabled-json instance would NOT yield results here.
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(parsed.results.length).toBeGreaterThan(0)

    // Content-bearing assertion: a search for "searxng" MUST surface the project's own
    // canonical pages. A regression that returned plausible-but-wrong data (e.g. a stale
    // cache, the wrong query echoed, a different instance) would fail here, where a bare
    // length>0 check would not.
    const urls = parsed.results.map((r) => r.url ?? '')
    expect(
      urls.some((u) => /github\.com\/searxng|searxng\.org|searx\.space/i.test(u)),
      `expected a canonical SearXNG URL among results, got:\n${urls.slice(0, 10).join('\n')}`
    ).toBe(true)

    // Every normalized result must carry the fields the model relies on.
    const top = parsed.results[0]
    expect(typeof top.title).toBe('string')
    expect(typeof top.url).toBe('string')
    expect(top.url).toMatch(/^https?:\/\//)

    // The instance echoes the query back verbatim.
    expect(parsed.query).toBe('searxng')
  })

  it('routes a categories=news query to news engines', async () => {
    const lines = await readArtifact(
      SpooledArtifact,
      { query: 'climate', categories: 'news' },
      { instanceUrl: url!, headers, resultFormat: 'raw' }
    )
    const parsed = JSON.parse(lines.join('\n')) as {
      results: Array<{ engine?: string; category?: string }>
    }
    expect(parsed.results.length).toBeGreaterThan(0)
    // The categories param must reach the server and actually re-route engine selection:
    // at least one result should come from a news-category engine (engine names contain
    // "news" across bing news / qwant news / duckduckgo news / google news, etc.).
    const engines = parsed.results.map((r) => r.engine ?? '')
    expect(
      engines.some((e) => /news/i.test(e)),
      `expected a news engine among results, got engines:\n${[...new Set(engines)].join(', ')}`
    ).toBe(true)
  })

  it('returns the raw SearXNG body when resultFormat is raw', async () => {
    const lines = await readArtifact(
      SpooledArtifact,
      { query: 'searxng' },
      { instanceUrl: url!, headers, resultFormat: 'raw' }
    )
    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>
    expect(parsed).toHaveProperty('results')
    expect(parsed).toHaveProperty('query')
  })

  it('renders markdown via an output pipeline + markdown artifact', async () => {
    const lines = await readArtifact(
      SpooledMarkdownArtifact,
      { query: 'searxng' },
      {
        instanceUrl: url!,
        headers,
        resultFormat: 'normalized',
        artifact: () => SpooledMarkdownArtifact,
        outputPipeline: [
          async (ctx, next) => {
            ctx.output = ctx.results
              .slice(0, 5)
              .map((r) => `- [${r.title ?? r.url}](${r.url})`)
              .join('\n')
            await next()
          },
        ],
      }
    )
    expect(lines.join('\n')).toMatch(/^- \[/m)
  })

  it('reflects an input-pipeline param mutation and an output-pipeline transform', async () => {
    const lines = await readArtifact(
      SpooledArtifact,
      { query: 'searxng' },
      {
        instanceUrl: url!,
        headers,
        resultFormat: 'normalized',
        inputPipeline: [
          async (ctx, next) => {
            ctx.params.language = 'en'
            await next()
          },
        ],
        outputPipeline: [
          async (ctx, next) => {
            ctx.results = ctx.results.slice(0, 3)
            await next()
          },
        ],
      }
    )
    const parsed = JSON.parse(lines.join('\n')) as { results: unknown[] }
    expect(parsed.results.length).toBeLessThanOrEqual(3)
  })
})
