import { describe, expect, it, vi, afterEach } from 'vitest'
import { makeToolCtxStub } from '../../../_fixtures/tool_ctx_stub'
import { createSearxngSearchToolSync } from '../../../../src/batteries/tools/searxng'
import { createScrapperArticleToolSync } from '../../../../src/batteries/tools/scrapper'
import type { Tool } from '../../../../src/lib/classes/tool'

const ARTICLE_BODY = { url: 'https://example.com', title: 'T', byline: null, textContent: 'x' }
const SEARCH_BODY = { query: 'q', results: [] }

const stubFetch = (body: unknown): ReturnType<typeof vi.fn> => {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const exec = async (tool: Tool, args: Record<string, unknown>): Promise<string> =>
  (await tool.executor(makeToolCtxStub())(args)) as string

describe('gate retrofit — scrapper', () => {
  it('the gate runs before the HTTP request with the call payload', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const calls: Array<{ tool: string; args: unknown }> = []
    const tool = createScrapperArticleToolSync({
      instanceUrl: 'https://s.example',
      gate: (_ctx, call) => {
        expect(fetchFn).not.toHaveBeenCalled()
        calls.push(call)
      },
    })
    await exec(tool, { url: 'https://example.com' })
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('scrapper_article')
    expect((calls[0].args as { url: string }).url).toBe('https://example.com')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a gate denial prevents the request and surfaces as the tool error', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const tool = createScrapperArticleToolSync({
      instanceUrl: 'https://s.example',
      gate: () => {
        throw new Error('denied by operator')
      },
    })
    await expect(exec(tool, { url: 'https://example.com' })).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no gate configured behaves exactly as before', async () => {
    stubFetch(ARTICLE_BODY)
    const tool = createScrapperArticleToolSync({ instanceUrl: 'https://s.example' })
    const out = await exec(tool, { url: 'https://example.com' })
    expect(out).toContain('T')
  })
})

describe('gate retrofit — searxng', () => {
  it('the gate runs before the HTTP request', async () => {
    const fetchFn = stubFetch(SEARCH_BODY)
    const calls: Array<{ tool: string }> = []
    const tool = createSearxngSearchToolSync({
      instanceUrl: 'https://sx.example',
      gate: (_ctx, call) => {
        expect(fetchFn).not.toHaveBeenCalled()
        calls.push(call)
      },
    })
    await exec(tool, { query: 'adk' })
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('searxng_search')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('a gate denial prevents the request', async () => {
    const fetchFn = stubFetch(SEARCH_BODY)
    const tool = createSearxngSearchToolSync({
      instanceUrl: 'https://sx.example',
      gate: () => {
        throw new Error('denied')
      },
    })
    await expect(exec(tool, { query: 'adk' })).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
