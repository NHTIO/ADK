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
  createSearxngSearchTool,
  createSearxngSearchToolSync,
  E_INVALID_SEARXNG_CONFIG,
  type SearxngToolConfig,
} from '../../../../../src/batteries/tools/searxng'

const SAMPLE_BODY = {
  query: 'adk',
  number_of_results: 2,
  results: [
    {
      title: 'First',
      url: 'https://a.example/1',
      content: 'one',
      engine: 'duckduckgo',
      score: 0.9,
    },
    { title: 'Second', url: 'https://b.example/2', content: 'two', engine: 'google', score: 0.05 },
  ],
  answers: ['the answer'],
  infoboxes: [],
  suggestions: ['adk docs'],
}

/** Build a fetch stub that records calls and returns a JSON body (or a custom Response). */
const stubFetch = (
  body: unknown = SAMPLE_BODY,
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

const run = async (config: SearxngToolConfig, args: Record<string, unknown>): Promise<string> => {
  const tool = await createSearxngSearchTool(config)
  return (await tool.executor(makeToolCtxStub())(args)) as string
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createSearxngSearchTool — factory validation', () => {
  it('rejects E_INVALID_SEARXNG_CONFIG on missing instanceUrl (async)', async () => {
    await expect(createSearxngSearchTool({} as SearxngToolConfig)).rejects.toBeInstanceOf(
      E_INVALID_SEARXNG_CONFIG
    )
  })

  it('throws E_INVALID_SEARXNG_CONFIG on unparseable instanceUrl (sync)', () => {
    expect(() => createSearxngSearchToolSync({ instanceUrl: 'not a url' })).toThrow(
      E_INVALID_SEARXNG_CONFIG
    )
  })

  it('names the tool searxng_search by default and honours an override', async () => {
    const def = await createSearxngSearchTool({ instanceUrl: 'https://x.example' })
    expect(def.name).toBe('searxng_search')
    expect(
      createSearxngSearchToolSync({ instanceUrl: 'https://x.example', name: 'web_search' }).name
    ).toBe('web_search')
  })
})

describe('createSearxngSearchTool — request building', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchFn = stubFetch()
  })

  it('builds the /search URL with q, format=json, and only supplied params', async () => {
    await run(
      { instanceUrl: 'https://searx.example.org/' },
      {
        query: 'hello world',
        categories: 'news',
        pageno: 2,
      }
    )
    const url = new URL(fetchFn.mock.calls[0][0] as URL)
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('categories')).toBe('news')
    expect(url.searchParams.get('pageno')).toBe('2')
    // Unsupplied optional params are absent.
    expect(url.searchParams.get('engines')).toBeNull()
    expect(url.searchParams.get('language')).toBeNull()
  })

  it('merges static headers and lets the caller override the default User-Agent', async () => {
    await run(
      {
        instanceUrl: 'https://searx.example.org',
        headers: { 'User-Agent': 'mine', 'X-Auth': 'k' },
      },
      { query: 'q' }
    )
    const opts = fetchFn.mock.calls[0][1] as { headers: Record<string, string> }
    expect(opts.headers['User-Agent']).toBe('mine')
    expect(opts.headers['X-Auth']).toBe('k')
    expect(opts.headers.Accept).toBe('application/json')
  })

  it('awaits an async header resolver (refreshable auth)', async () => {
    let calls = 0
    await run(
      {
        instanceUrl: 'https://searx.example.org',
        headers: async () => {
          calls += 1
          return { Authorization: `Bearer token-${calls}` }
        },
      },
      { query: 'q' }
    )
    const opts = fetchFn.mock.calls[0][1] as { headers: Record<string, string> }
    expect(opts.headers.Authorization).toBe('Bearer token-1')
  })
})

describe('createSearxngSearchTool — empty-string optional params', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchFn = stubFetch()
  })

  it('accepts categories/engines/language as "" and omits them from the built query params', async () => {
    await run(
      { instanceUrl: 'https://searx.example.org' },
      {
        query: 'hello world',
        categories: '',
        engines: '',
        language: '',
      }
    )
    const url = new URL(fetchFn.mock.calls[0][0] as URL)
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('categories')).toBeNull()
    expect(url.searchParams.get('engines')).toBeNull()
    expect(url.searchParams.get('language')).toBeNull()
  })
})

describe('createSearxngSearchTool — output shapes', () => {
  beforeEach(() => stubFetch())

  it('normalized: trims results to known fields and drops empty arrays', async () => {
    const out = await run({ instanceUrl: 'https://searx.example.org' }, { query: 'adk' })
    const parsed = JSON.parse(out)
    expect(parsed.number_of_results).toBe(2)
    expect(parsed.results[0]).toEqual({
      title: 'First',
      url: 'https://a.example/1',
      content: 'one',
      engine: 'duckduckgo',
      score: 0.9,
    })
    expect(parsed.answers).toEqual(['the answer'])
    expect(parsed.suggestions).toEqual(['adk docs'])
    // infoboxes was [] in the body — dropped.
    expect('infoboxes' in parsed).toBe(false)
  })

  it('raw: returns the full SearXNG body verbatim', async () => {
    const out = await run(
      { instanceUrl: 'https://searx.example.org', resultFormat: 'raw' },
      { query: 'adk' }
    )
    expect(JSON.parse(out)).toEqual(SAMPLE_BODY)
  })

  it('pinned resultFormat removes the model-facing format field from the schema', () => {
    const neutral = createSearxngSearchToolSync({ instanceUrl: 'https://x.example' })
    const pinned = createSearxngSearchToolSync({
      instanceUrl: 'https://x.example',
      resultFormat: 'normalized',
    })
    const keys = (t: ReturnType<typeof createSearxngSearchToolSync>) =>
      Object.keys((t.describe().inputSchema as { keys: Record<string, unknown> }).keys)
    expect(keys(neutral)).toContain('format')
    expect(keys(pinned)).not.toContain('format')
  })

  it('neutral resultFormat honours the model-chosen format arg', async () => {
    const out = await run({ instanceUrl: 'https://x.example' }, { query: 'adk', format: 'raw' })
    expect(JSON.parse(out)).toEqual(SAMPLE_BODY)
  })
})

describe('createSearxngSearchTool — error handling', () => {
  it('rejects missing query with E_INVALID_TOOL_ARGS', async () => {
    stubFetch()
    await expect(run({ instanceUrl: 'https://x.example' }, {})).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('returns an Error string mentioning settings.yml on 403', async () => {
    stubFetch(SAMPLE_BODY, { ok: false, status: 403, statusText: 'Forbidden' })
    const out = await run({ instanceUrl: 'https://x.example' }, { query: 'q' })
    expect(out).toMatch(/^Error:/)
    expect(out).toContain('settings.yml')
  })

  it('returns an Error string (not a throw) on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const out = await run({ instanceUrl: 'https://x.example' }, { query: 'q' })
    expect(out).toMatch(/^Error:.*ECONNREFUSED/)
  })
})

describe('createSearxngSearchTool — input pipeline', () => {
  it('reflects param/query/header mutations in the outgoing request', async () => {
    const fetchFn = stubFetch()
    await run(
      {
        instanceUrl: 'https://x.example',
        inputPipeline: [
          async (ctx, next) => {
            ctx.query = `${ctx.query} site:example.com`
            ctx.params.language = 'en'
            ctx.headers['X-Tenant'] = 't1'
            await next()
          },
        ],
      },
      { query: 'docs' }
    )
    const [url, opts] = fetchFn.mock.calls[0] as [URL, { headers: Record<string, string> }]
    expect(new URL(url).searchParams.get('q')).toBe('docs site:example.com')
    expect(new URL(url).searchParams.get('language')).toBe('en')
    expect(opts.headers['X-Tenant']).toBe('t1')
  })

  it('short-circuits without calling fetch', async () => {
    const fetchFn = stubFetch()
    const out = await run(
      {
        instanceUrl: 'https://x.example',
        inputPipeline: [
          async (ctx) => {
            ctx.shortCircuit('cached-result')
          },
        ],
      },
      { query: 'docs' }
    )
    expect(out).toBe('cached-result')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('surfaces a non-terminal pipeline (no next, no short-circuit) as an Error string', async () => {
    stubFetch()
    const out = await run(
      {
        instanceUrl: 'https://x.example',

        inputPipeline: [async (_ctx, _next) => {}],
      },
      { query: 'docs' }
    )
    expect(out).toMatch(/^Error:.*did not call next/)
  })
})

describe('createSearxngSearchTool — output pipeline', () => {
  beforeEach(() => stubFetch())

  it('applies result filtering/re-ranking to the normalized payload', async () => {
    const out = await run(
      {
        instanceUrl: 'https://x.example',
        outputPipeline: [
          async (ctx, next) => {
            ctx.results = ctx.results.filter((r) => (r.score ?? 0) > 0.1)
            await next()
          },
        ],
      },
      { query: 'adk' }
    )
    const parsed = JSON.parse(out)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].title).toBe('First')
  })

  it('uses ctx.output verbatim when a stage sets it', async () => {
    const out = await run(
      {
        instanceUrl: 'https://x.example',
        outputPipeline: [
          async (ctx, next) => {
            ctx.output = ctx.results.map((r) => `- ${r.title}`).join('\n')
            await next()
          },
        ],
      },
      { query: 'adk' }
    )
    expect(out).toBe('- First\n- Second')
  })

  it('carries stash from the input stage to the output stage', async () => {
    let seen: unknown
    await run(
      {
        instanceUrl: 'https://x.example',
        inputPipeline: [
          async (ctx, next) => {
            ctx.stash.set('marker', 42)
            await next()
          },
        ],
        outputPipeline: [
          async (ctx, next) => {
            seen = ctx.stash.get('marker')
            await next()
          },
        ],
      },
      { query: 'adk' }
    )
    expect(seen).toBe(42)
  })
})

describe('createSearxngSearchTool — artifact resolver', () => {
  it('defaults to SpooledJsonArtifact (async + sync)', async () => {
    const asyncTool = await createSearxngSearchTool({ instanceUrl: 'https://x.example' })
    expect(asyncTool.artifactConstructor!()).toBe(SpooledJsonArtifact)
    expect(
      createSearxngSearchToolSync({ instanceUrl: 'https://x.example' }).artifactConstructor!()
    ).toBe(SpooledJsonArtifact)
  })

  it('accepts a bare constructor, a sync resolver, and an async/dynamic-import resolver', async () => {
    const ctor = createSearxngSearchToolSync({
      instanceUrl: 'https://x.example',
      artifact: SpooledMarkdownArtifact,
    })
    const sync = createSearxngSearchToolSync({
      instanceUrl: 'https://x.example',
      artifact: () => SpooledArtifact,
    })
    const asyncTool = await createSearxngSearchTool({
      instanceUrl: 'https://x.example',
      artifact: async () => ({ default: SpooledMarkdownArtifact }),
    })
    expect(ctor.artifactConstructor!()).toBe(SpooledMarkdownArtifact)
    expect(sync.artifactConstructor!()).toBe(SpooledArtifact)
    expect(asyncTool.artifactConstructor!()).toBe(SpooledMarkdownArtifact)
  })

  it('sync factory rejects an async resolver with E_INVALID_SEARXNG_CONFIG', () => {
    expect(() =>
      createSearxngSearchToolSync({
        instanceUrl: 'https://x.example',
        // @ts-expect-error — async resolver is not assignable to the sync subset
        artifact: async () => SpooledMarkdownArtifact,
      })
    ).toThrow(E_INVALID_SEARXNG_CONFIG)
  })
})

describe('createSearxngSearchTool — artifact round-trip (end-to-end)', () => {
  // Reproduce the wrap-site exactly: run the tool, take its real output bytes, then build the
  // tool's OWN configured artifact from them (via `tool.artifactConstructor!()`) and assert the
  // typed read methods actually consume those bytes. This proves each of the three spool types
  // behaves on genuine SearXNG output, not just that the right constructor was selected.
  beforeEach(() => stubFetch())

  /** Run the tool and wrap its output in whatever artifact the tool declares. */
  const runThroughArtifact = async (config: SearxngToolConfig, args: Record<string, unknown>) => {
    const tool = await createSearxngSearchTool(config)
    const out = (await tool.executor(makeToolCtxStub())(args)) as string
    const Ctor = tool.artifactConstructor!()
    const artifact = new Ctor(new InMemorySpoolReader(out))
    return { out, artifact }
  }

  it('JSON: default tool output parses through SpooledJsonArtifact', async () => {
    const { artifact } = await runThroughArtifact(
      { instanceUrl: 'https://x.example' },
      {
        query: 'adk',
      }
    )
    expect(artifact).toBeInstanceOf(SpooledJsonArtifact)
    const json = artifact as SpooledJsonArtifact
    // The normalized payload is a JSON object — its keys are readable via the typed API.
    expect(await json.json_type()).toBe('json')
    expect(await json.json_keys()).toEqual(expect.arrayContaining(['query', 'results']))
    // json_get reaches into the parsed structure (not just raw text).
    expect(await json.json_get('$.results[0].title')).toEqual(['First'])
  })

  it('raw JSON: full body also parses through SpooledJsonArtifact', async () => {
    const { artifact } = await runThroughArtifact(
      { instanceUrl: 'https://x.example', resultFormat: 'raw' },
      { query: 'adk' }
    )
    const json = artifact as SpooledJsonArtifact
    expect(await json.json_type()).toBe('json')
    expect(await json.json_get('$.number_of_results')).toEqual([2])
  })

  it('Markdown: rendered output parses through SpooledMarkdownArtifact', async () => {
    const { artifact } = await runThroughArtifact(
      {
        instanceUrl: 'https://x.example',
        artifact: () => SpooledMarkdownArtifact,
        outputPipeline: [
          async (ctx, next) => {
            ctx.output = [
              '## Results',
              '',
              ...ctx.results.map((r) => `- [${r.title}](${r.url})`),
            ].join('\n')
            await next()
          },
        ],
      },
      { query: 'adk' }
    )
    expect(artifact).toBeInstanceOf(SpooledMarkdownArtifact)
    const md = artifact as SpooledMarkdownArtifact
    const headings = await md.md_headings()
    expect(headings.map((h) => h.text)).toContain('Results')
    const links = await md.md_links()
    expect(links.map((l) => l.url)).toEqual(
      expect.arrayContaining(['https://a.example/1', 'https://b.example/2'])
    )
  })

  it('Text: output parses through the base SpooledArtifact', async () => {
    const { out, artifact } = await runThroughArtifact(
      {
        instanceUrl: 'https://x.example',
        artifact: () => SpooledArtifact,
        outputPipeline: [
          async (ctx, next) => {
            ctx.output = ctx.results.map((r) => `${r.title}\t${r.url}`).join('\n')
            await next()
          },
        ],
      },
      { query: 'adk' }
    )
    // Base SpooledArtifact is line-oriented: cat() returns the exact lines we emitted.
    const lines = await artifact.cat()
    expect(lines).toEqual(out.split('\n'))
    expect(lines[0]).toBe('First\thttps://a.example/1')
    expect(await artifact.lineCount()).toBe(2)
  })
})

describe('createSearxngSearchTool — fresh runner per invocation', () => {
  it('runs both pipelines on every call (runners are single-use)', async () => {
    stubFetch()
    let inputRuns = 0
    let outputRuns = 0
    const tool = await createSearxngSearchTool({
      instanceUrl: 'https://x.example',
      inputPipeline: [
        async (_ctx, next) => {
          inputRuns += 1
          await next()
        },
      ],
      outputPipeline: [
        async (_ctx, next) => {
          outputRuns += 1
          await next()
        },
      ],
    })
    await tool.executor(makeToolCtxStub())({ query: 'a' })
    await tool.executor(makeToolCtxStub())({ query: 'b' })
    expect(inputRuns).toBe(2)
    expect(outputRuns).toBe(2)
  })
})
