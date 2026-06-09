import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import {
  SpooledArtifact,
  SpooledJsonArtifact,
  SpooledMarkdownArtifact,
} from '../../../../../src/spooled_artifact'
import {
  createScrapperArticleTool,
  createScrapperArticleToolSync,
  createScrapperLinksTool,
  createScrapperLinksToolSync,
  E_INVALID_SCRAPPER_CONFIG,
} from '../../../../../src/batteries/tools/scrapper'
import type { Tool } from '../../../../../src/forge'

const ARTICLE_BODY = {
  url: 'https://example.com',
  domain: 'example.com',
  title: 'Example Domain',
  byline: null,
  excerpt: 'This domain is for use in documentation examples.',
  siteName: null,
  lang: 'en',
  length: 111,
  publishedTime: null,
  date: '2026-06-09',
  textContent: 'This domain is for use in documentation examples. Learn more',
  content: '<div>This domain is for use in documentation examples.</div>',
  meta: { og: 'x' },
  resultUri: 'http://fetchops.example/result/abc',
  screenshotUri: null,
}

const LINKS_BODY = {
  url: 'https://news.example.com',
  domain: 'news.example.com',
  title: 'News',
  date: '2026-06-09',
  resultUri: 'http://fetchops.example/result/def',
  links: [
    { url: 'https://news.example.com/a', text: 'Story A' },
    { url: 'https://news.example.com/b', text: 'Story B' },
  ],
}

const stubFetch = (
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {}
): ReturnType<typeof vi.fn> => {
  const fn = vi.fn(async (_url: unknown, _opts: unknown) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const exec = async (tool: Tool, args: Record<string, unknown>): Promise<string> =>
  (await tool.executor(makeToolCtxStub())(args)) as string

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createScrapperArticleTool — factory validation', () => {
  it('rejects missing instanceUrl (async)', async () => {
    await expect(createScrapperArticleTool({} as never)).rejects.toBeInstanceOf(
      E_INVALID_SCRAPPER_CONFIG
    )
  })

  it('throws on unparseable instanceUrl (sync)', () => {
    expect(() => createScrapperArticleToolSync({ instanceUrl: 'not a url' })).toThrow(
      E_INVALID_SCRAPPER_CONFIG
    )
  })

  it('names tools scrapper_article / scrapper_links by default', async () => {
    const article = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    const links = await createScrapperLinksTool({ instanceUrl: 'https://s.example' })
    expect(article.name).toBe('scrapper_article')
    expect(links.name).toBe('scrapper_links')
  })
})

describe('createScrapperArticleTool — request building', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchFn = stubFetch(ARTICLE_BODY)
  })

  it('hits /api/article with url + only supplied params, snake→kebab mapped', async () => {
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example/' })
    await exec(tool, { url: 'https://example.com', wait_until: 'networkidle', full_content: true })
    const u = new URL(fetchFn.mock.calls[0][0] as URL)
    expect(u.pathname).toBe('/api/article')
    expect(u.searchParams.get('url')).toBe('https://example.com')
    expect(u.searchParams.get('wait-until')).toBe('networkidle')
    expect(u.searchParams.get('full-content')).toBe('true')
    expect(u.searchParams.get('cache')).toBeNull()
  })

  it('merges static instance-auth headers; extra_http_headers is a PARAM, not a header', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      headers: { 'X-API-Key': 'secret' },
    })
    await exec(tool, { url: 'https://example.com', extra_http_headers: 'X-Target:1;X-Two:2' })
    const [u, opts] = fetchFn.mock.calls[0] as [URL, { headers: Record<string, string> }]
    // instance auth lands in request headers
    expect(opts.headers['X-API-Key']).toBe('secret')
    expect(opts.headers.Accept).toBe('application/json')
    // extra_http_headers lands in the query string, NOT the request headers
    expect(new URL(u).searchParams.get('extra-http-headers')).toBe('X-Target:1;X-Two:2')
    expect(opts.headers['extra-http-headers']).toBeUndefined()
  })

  it('awaits an async instance-auth header resolver', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      headers: async () => ({ Authorization: 'Bearer t' }),
    })
    await exec(tool, { url: 'https://example.com' })
    const opts = fetchFn.mock.calls[0][1] as { headers: Record<string, string> }
    expect(opts.headers.Authorization).toBe('Bearer t')
  })
})

describe('createScrapperArticleTool — per-parameter disposition', () => {
  beforeEach(() => stubFetch(ARTICLE_BODY))
  const keys = (tool: Tool) =>
    Object.keys((tool.describe().inputSchema as { keys: Record<string, unknown> }).keys)

  it('a fixed param is absent from the schema and always sent', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      fixed: { device: 'iPhone 15' },
    })
    expect(keys(tool)).not.toContain('device')
    expect(keys(tool)).toContain('url')
    await exec(tool, { url: 'https://example.com' })
    expect(new URL(fetchFn.mock.calls[0][0] as URL).searchParams.get('device')).toBe('iPhone 15')
  })

  it('a defaults param appears with its default and is model-overridable', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      defaults: { wait_until: 'load' },
    })
    expect(keys(tool)).toContain('wait_until')
    // default applied when the model omits it
    await exec(tool, { url: 'https://example.com' })
    expect(new URL(fetchFn.mock.calls[0][0] as URL).searchParams.get('wait-until')).toBe('load')
    // model override wins
    await exec(tool, { url: 'https://example.com', wait_until: 'commit' })
    expect(new URL(fetchFn.mock.calls[1][0] as URL).searchParams.get('wait-until')).toBe('commit')
  })

  it('fixedQuery is always sent and never in the schema', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      fixedQuery: { 'some-future-flag': 'on' },
    })
    expect(keys(tool)).not.toContain('some-future-flag')
    await exec(tool, { url: 'https://example.com' })
    expect(new URL(fetchFn.mock.calls[0][0] as URL).searchParams.get('some-future-flag')).toBe('on')
  })

  it('url is always required', async () => {
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    await expect(exec(tool, {})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('createScrapperArticleTool — output shapes', () => {
  beforeEach(() => stubFetch(ARTICLE_BODY))

  it('normalized trims to the known article fields', async () => {
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    const out = JSON.parse(await exec(tool, { url: 'https://example.com', format: 'normalized' }))
    expect(out.title).toBe('Example Domain')
    expect(out.lang).toBe('en')
    expect(out.textContent).toContain('documentation examples')
    // noise dropped
    expect('meta' in out).toBe(false)
    expect('resultUri' in out).toBe(false)
  })

  it('raw returns the full Scrapper body', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      resultFormat: 'raw',
    })
    expect(JSON.parse(await exec(tool, { url: 'https://example.com' }))).toEqual(ARTICLE_BODY)
  })

  it('pinned resultFormat removes the model-facing format field', async () => {
    const neutral = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    const pinned = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      resultFormat: 'normalized',
    })
    const keys = (t: Tool) =>
      Object.keys((t.describe().inputSchema as { keys: Record<string, unknown> }).keys)
    expect(keys(neutral)).toContain('format')
    expect(keys(pinned)).not.toContain('format')
  })
})

describe('createScrapperLinksTool — links shape', () => {
  it('normalized links are { url, text } items', async () => {
    stubFetch(LINKS_BODY)
    const tool = await createScrapperLinksTool({ instanceUrl: 'https://s.example' })
    const out = JSON.parse(await exec(tool, { url: 'https://news.example.com' }))
    expect(out.title).toBe('News')
    expect(out.links).toEqual([
      { url: 'https://news.example.com/a', text: 'Story A' },
      { url: 'https://news.example.com/b', text: 'Story B' },
    ])
  })

  it('sync links factory produces the same normalized shape', async () => {
    stubFetch(LINKS_BODY)
    const tool = createScrapperLinksToolSync({ instanceUrl: 'https://s.example' })
    const out = JSON.parse(await exec(tool, { url: 'https://news.example.com' }))
    expect(out.links).toHaveLength(2)
    expect(out.links[0]).toEqual({ url: 'https://news.example.com/a', text: 'Story A' })
  })
})

describe('createScrapperArticleTool — error handling', () => {
  it('surfaces a {detail:[{msg}]} body as an Error string', async () => {
    stubFetch(
      { detail: [{ type: 'missing', loc: ['query', 'url'], msg: 'Field required' }] },
      { ok: false, status: 422, statusText: 'Unprocessable Entity' }
    )
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    const out = await exec(tool, { url: 'https://example.com' })
    expect(out).toMatch(/^Error:/)
    expect(out).toContain('Field required')
  })

  it('returns an Error string (not a throw) on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    expect(await exec(tool, { url: 'https://example.com' })).toMatch(/^Error:.*ECONNREFUSED/)
  })
})

describe('createScrapperArticleTool — pipelines', () => {
  it('input mutation reaches the wire; shortCircuit skips fetch', async () => {
    const fetchFn = stubFetch(ARTICLE_BODY)
    const mutated = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      inputPipeline: [
        async (ctx, next) => {
          ctx.params['device'] = 'Pixel 8'
          ctx.url = 'https://changed.example'
          await next()
        },
      ],
    })
    await exec(mutated, { url: 'https://example.com' })
    const u = new URL(fetchFn.mock.calls[0][0] as URL)
    expect(u.searchParams.get('device')).toBe('Pixel 8')
    expect(u.searchParams.get('url')).toBe('https://changed.example')

    const cached = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      inputPipeline: [async (ctx) => ctx.shortCircuit('from-cache')],
    })
    const before = fetchFn.mock.calls.length
    expect(await exec(cached, { url: 'https://example.com' })).toBe('from-cache')
    expect(fetchFn.mock.calls.length).toBe(before)
  })

  it('output pipeline can reshape result and set ctx.output; stash carries across', async () => {
    stubFetch(ARTICLE_BODY)
    let seen: unknown
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      inputPipeline: [
        async (ctx, next) => {
          ctx.stash.set('m', 7)
          await next()
        },
      ],
      outputPipeline: [
        async (ctx, next) => {
          seen = ctx.stash.get('m')
          ctx.output = `TITLE: ${ctx.result.title}`
          await next()
        },
      ],
    })
    expect(await exec(tool, { url: 'https://example.com' })).toBe('TITLE: Example Domain')
    expect(seen).toBe(7)
  })
})

describe('createScrapperArticleTool — artifact resolver', () => {
  it('defaults to SpooledJsonArtifact (async + sync)', async () => {
    const asyncTool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    expect(asyncTool.artifactConstructor!()).toBe(SpooledJsonArtifact)
    expect(
      createScrapperArticleToolSync({ instanceUrl: 'https://s.example' }).artifactConstructor!()
    ).toBe(SpooledJsonArtifact)
  })

  it('accepts ctor, sync resolver, and async/dynamic-import resolver', async () => {
    const a = createScrapperArticleToolSync({
      instanceUrl: 'https://s.example',
      artifact: SpooledMarkdownArtifact,
    })
    const b = createScrapperArticleToolSync({
      instanceUrl: 'https://s.example',
      artifact: () => SpooledArtifact,
    })
    const c = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      artifact: async () => ({ default: SpooledMarkdownArtifact }),
    })
    expect(a.artifactConstructor!()).toBe(SpooledMarkdownArtifact)
    expect(b.artifactConstructor!()).toBe(SpooledArtifact)
    expect(c.artifactConstructor!()).toBe(SpooledMarkdownArtifact)
  })

  it('sync factory rejects an async resolver', () => {
    expect(() =>
      createScrapperArticleToolSync({
        instanceUrl: 'https://s.example',
        // @ts-expect-error async resolver not assignable to the sync subset
        artifact: async () => SpooledMarkdownArtifact,
      })
    ).toThrow(E_INVALID_SCRAPPER_CONFIG)
  })
})

describe('createScrapperArticleTool — artifact round-trip (end-to-end)', () => {
  beforeEach(() => stubFetch(ARTICLE_BODY))

  it('JSON: normalized output parses through SpooledJsonArtifact', async () => {
    const tool = await createScrapperArticleTool({ instanceUrl: 'https://s.example' })
    const out = await exec(tool, { url: 'https://example.com' })
    const Ctor = tool.artifactConstructor!()
    const artifact = new Ctor(new InMemorySpoolReader(out)) as SpooledJsonArtifact
    expect(await artifact.json_get('$.title')).toEqual(['Example Domain'])
  })

  it('Markdown: rendered output parses through SpooledMarkdownArtifact', async () => {
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      artifact: () => SpooledMarkdownArtifact,
      outputPipeline: [
        async (ctx, next) => {
          ctx.output = `# ${ctx.result.title}\n\n[src](${ctx.result.url})`
          await next()
        },
      ],
    })
    const out = await exec(tool, { url: 'https://example.com' })
    const Ctor = tool.artifactConstructor!()
    const md = new Ctor(new InMemorySpoolReader(out)) as SpooledMarkdownArtifact
    const headings = await md.md_headings()
    const links = await md.md_links()
    expect(headings.map((h) => h.text)).toContain('Example Domain')
    expect(links.map((l) => l.url)).toContain('https://example.com')
  })
})

describe('createScrapperArticleTool — fresh runner per invocation', () => {
  it('runs both pipelines on every call', async () => {
    stubFetch(ARTICLE_BODY)
    let inN = 0
    let outN = 0
    const tool = await createScrapperArticleTool({
      instanceUrl: 'https://s.example',
      inputPipeline: [
        async (_c, next) => {
          inN += 1
          await next()
        },
      ],
      outputPipeline: [
        async (_c, next) => {
          outN += 1
          await next()
        },
      ],
    })
    await exec(tool, { url: 'https://example.com' })
    await exec(tool, { url: 'https://example.org' })
    expect(inN).toBe(2)
    expect(outN).toBe(2)
  })
})
