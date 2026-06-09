import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { SpooledArtifact, SpooledMarkdownArtifact } from '@nhtio/adk'
import { scriptedExecutor } from '../../../_fixtures/scripted_executor'
import {
  createScrapperArticleTool,
  createScrapperLinksTool,
} from '@nhtio/adk/batteries/tools/scrapper'
import type { Tool } from '@nhtio/adk'
import type { ToolHeaders } from '@nhtio/adk/batteries/tools/_shared'

/**
 * Live integration test against a real Scrapper instance. Env-gated like the vector + SearXNG
 * integration specs: provide a real instance URL (and optionally a JSON object of custom auth
 * headers). Without them the suite skips, so CI stays green with no committed credentials.
 *
 *   TEST_SCRAPPER_URL=https://scrapper.example.org \
 *   TEST_SCRAPPER_HEADERS='{"x-api-key":"…"}' \
 *   pnpm test:node tests/functional/batteries/tools/scrapper
 */
const url = process.env.TEST_SCRAPPER_URL
const rawHeaders = process.env.TEST_SCRAPPER_HEADERS

const headers: ToolHeaders | undefined = rawHeaders
  ? (JSON.parse(rawHeaders) as ToolHeaders)
  : undefined

const d = url ? describe : describe.skip

/** Run a one-shot scripted tool call and read the produced artifact's lines. */
const runTool = async (
  Ctor: typeof SpooledArtifact,
  tool: Tool,
  args: Record<string, unknown>
): Promise<string[]> => {
  const exec = scriptedExecutor([{ toolCalls: [{ tool: tool.name, args }] }, { ack: true }])
  const { run, store } = makeFixtureRunner({ executorCallback: exec, tools: [tool] })
  await run()
  const reader = store.read('tc-i0-1')
  expect(reader).toBeDefined()
  return new Ctor(reader!).cat()
}

d('Scrapper tools (integration)', () => {
  it('article: authenticates with custom headers and returns the EXPECTED content', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: url!,
      // Resolver form, to exercise async header resolution against the live server.
      headers: headers ? async () => headers : undefined,
      resultFormat: 'normalized',
    })
    const lines = await runTool(SpooledArtifact, tool, { url: 'https://example.com' })
    const article = JSON.parse(lines.join('\n')) as { title?: string; textContent?: string }
    // A 401/403 (bad/absent auth) would NOT yield this. Content-bearing: exact known page.
    expect(article.title).toBe('Example Domain')
    expect(article.textContent ?? '').toMatch(/documentation examples/i)
  })

  it('article: raw returns the full Scrapper body', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: url!,
      headers,
      resultFormat: 'raw',
    })
    const lines = await runTool(SpooledArtifact, tool, { url: 'https://example.com' })
    const body = JSON.parse(lines.join('\n')) as Record<string, unknown>
    expect(body).toHaveProperty('textContent')
    expect(body).toHaveProperty('url')
  })

  it('article: a fixed param round-trips and a markdown output pipeline renders', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: url!,
      headers,
      resultFormat: 'normalized',
      fixed: { wait_until: 'domcontentloaded' },
      artifact: () => SpooledMarkdownArtifact,
      outputPipeline: [
        async (ctx, next) => {
          ctx.output = `# ${ctx.result.title ?? 'Untitled'}\n\n${ctx.result.textContent ?? ''}`
          await next()
        },
      ],
    })
    const lines = await runTool(SpooledMarkdownArtifact, tool, { url: 'https://example.com' })
    expect(lines.join('\n')).toMatch(/^# /m)
  })

  it('links: returns { url, text } items for a link-rich page', async () => {
    const tool = await createScrapperLinksTool({
      instanceUrl: url!,
      headers,
      resultFormat: 'normalized',
    })
    const lines = await runTool(SpooledArtifact, tool, { url: 'https://news.ycombinator.com' })
    const payload = JSON.parse(lines.join('\n')) as {
      links: Array<{ url?: string; text?: string }>
    }
    expect(Array.isArray(payload.links)).toBe(true)
    expect(payload.links.length).toBeGreaterThan(0)
    const first = payload.links.find((l) => l.url && l.text)
    expect(first).toBeDefined()
    expect(typeof first!.url).toBe('string')
    expect(typeof first!.text).toBe('string')
  })
})
