import { sha256 } from 'js-sha256'
import { describe, expect, it, vi } from 'vitest'
import { Retrievable } from '../../../../../src/common'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { SpooledArtifact, SpooledMarkdownArtifact } from '../../../../../src/spooled_artifact'
import {
  searxngResultsToRetrievables,
  scrapperArticleToRetrievable,
  scrapperLinksToRetrievables,
  storeRetrievables,
  type RetrievableCtor,
} from '../../../../../src/batteries/tools/web_retrieval'

describe('web_retrieval — searxngResultsToRetrievables', () => {
  const payload = {
    results: [
      { url: 'https://a.example', title: 'A', content: 'about a', score: 0.9 },
      { url: 'https://b.example', title: 'B', content: 'about b', score: 5 },
    ],
  }

  it('yields one plain RawRetrievable per result, snippet inline, third-party-public', () => {
    const raws = searxngResultsToRetrievables(payload)
    expect(raws).toHaveLength(2)
    expect(raws[0].trustTier).toBe('third-party-public')
    expect(raws[0].source).toBe('https://a.example')
    expect(typeof raws[0].content).toBe('string')
    expect(raws[0].content).toContain('about a')
    // not a core instance — just data
    expect(raws[0]).not.toBeInstanceOf(Retrievable)
  })

  it('clamps score into [0,1] and honours a trustTier override', () => {
    const raws = searxngResultsToRetrievables(payload, { trustTier: 'first-party' })
    expect(raws[0].score).toBe(0.9)
    expect(raws[1].score).toBe(1) // 5 clamped
    expect(raws[0].trustTier).toBe('first-party')
  })

  it('offers the spool hook an open resolver (function), not a string', () => {
    let receivedKind: unknown
    searxngResultsToRetrievables(
      payload,
      {
        spool: (_id, _text, recommended) => {
          receivedKind = recommended
          return undefined
        },
      },
      { text: () => SpooledArtifact }
    )
    expect(typeof receivedKind).toBe('function')
    expect((receivedKind as () => unknown)()).toBe(SpooledArtifact)
  })
})

describe('web_retrieval — scrapperArticleToRetrievable', () => {
  const article = {
    url: 'https://example.com',
    title: 'Example',
    textContent: 'short text',
  }

  it('keeps short textContent inline as a string by default', () => {
    const raw = scrapperArticleToRetrievable(article)
    expect(typeof raw.content).toBe('string')
    expect(raw.content).toBe('short text')
    expect(raw.source).toBe('https://example.com')
    expect(raw.kind).toBe('web-article')
  })

  it('routes through a spool hook to a SpooledArtifact when supplied, passing it through onto content', () => {
    const spooled = new SpooledMarkdownArtifact(new InMemorySpoolReader('# md'))
    const raw = scrapperArticleToRetrievable(
      article,
      { asMarkdown: true, spool: () => spooled },
      { markdown: () => SpooledMarkdownArtifact }
    )
    expect(raw.content).toBe(spooled)
    expect(SpooledArtifact.isSpooledArtifact(raw.content)).toBe(true)
  })

  it('recommends markdown when asMarkdown, text otherwise', () => {
    let kind: 'md' | 'text' | undefined
    scrapperArticleToRetrievable(
      article,
      {
        asMarkdown: true,
        spool: (_i, _t, rec) => {
          kind = rec() === SpooledMarkdownArtifact ? 'md' : 'text'
          return undefined
        },
      },
      { markdown: () => SpooledMarkdownArtifact, text: () => SpooledArtifact }
    )
    expect(kind).toBe('md')
  })
})

describe('web_retrieval — scrapperLinksToRetrievables', () => {
  it('yields one RawRetrievable per { url, text } link and keeps links inline by default', () => {
    const raws = scrapperLinksToRetrievables({
      url: 'https://news.example',
      links: [
        { url: 'https://news.example/a', text: 'A' },
        { url: 'https://news.example/b', text: 'B' },
      ],
    })
    expect(raws).toHaveLength(2)
    expect(raws[0].content).toBe('A')
    expect(raws[0].inline).toBe(true)
    expect(raws[0].source).toBe('https://news.example/a')
    expect(raws[1].content).toBe('B')
  })

  it('preserves the old two-argument inline-string behavior', () => {
    const [raw] = scrapperLinksToRetrievables({ links: [{ url: 'https://x', text: 'X' }] })
    expect(raw.content).toBe('X')
    expect(typeof raw.content).toBe('string')
  })

  it('uses the spool hook when a recommendation is supplied', () => {
    const artifact = new SpooledArtifact(new InMemorySpoolReader('large link text'))
    const recommended = () => SpooledArtifact
    const spool = vi.fn(() => artifact)
    const raw = scrapperLinksToRetrievables(
      { links: [{ url: 'https://x', text: 'large link text' }] },
      { spool },
      { text: recommended }
    )[0]
    expect(spool).toHaveBeenCalledWith(sha256('https://x'), 'large link text', recommended)
    expect(raw.content).toBe(artifact)
    expect(raw.inline).toBe(true)
  })

  it('honors an explicit inline false', () => {
    const raw = scrapperLinksToRetrievables(
      { links: [{ url: 'https://x', text: 'X' }] },
      { inline: false }
    )[0]
    expect(raw.inline).toBe(false)
  })
})

describe('web_retrieval — inline and markdown metadata', () => {
  it('leaves inline unset for search and article unless explicitly passed', () => {
    expect(searxngResultsToRetrievables({ results: [{ content: 'x' }] })[0].inline).toBeUndefined()
    expect(scrapperArticleToRetrievable({ textContent: 'x' }).inline).toBeUndefined()
    expect(scrapperArticleToRetrievable({ textContent: 'x' }, { inline: true }).inline).toBe(true)
  })

  it('passes the markdown artifact resolver through exactly', () => {
    const markdown = () => SpooledMarkdownArtifact
    expect(
      scrapperArticleToRetrievable({ textContent: 'x' }, { asMarkdown: true }, { markdown })
        .artifactConstructor
    ).toBe(markdown)
    expect(
      scrapperArticleToRetrievable({ textContent: 'x' }, { asMarkdown: true }).artifactConstructor
    ).toBeUndefined()
  })

  it('also passes the plain-text artifact resolver through when asMarkdown is false, so auto-spool still picks the recommended subclass', () => {
    const text = () => SpooledArtifact
    expect(
      scrapperArticleToRetrievable({ textContent: 'x' }, {}, { text }).artifactConstructor
    ).toBe(text)
    expect(
      scrapperArticleToRetrievable({ textContent: 'x' }, { asMarkdown: true }, { text })
        .artifactConstructor
    ).toBe(text)
  })
})

describe('web_retrieval — storeRetrievables (resolver-injected ctor)', () => {
  const raws = searxngResultsToRetrievables({
    results: [{ url: 'https://a.example', title: 'A', content: 'x', score: 0.5 }],
  })

  const makeCtx = () => {
    const stored: Retrievable[] = []
    return {
      stored,
      storeRetrievable: vi.fn((v: Retrievable) => {
        stored.push(v)
        return v
      }),
    }
  }

  it('accepts a bare ctor, a sync resolver, and an async { default } resolver', async () => {
    for (const dep of [
      Retrievable as unknown as RetrievableCtor,
      (() => Retrievable) as unknown as () => RetrievableCtor,
      (async () => ({ default: Retrievable })) as unknown as () => Promise<{
        default: RetrievableCtor
      }>,
    ]) {
      const ctx = makeCtx()
      const out = await storeRetrievables(ctx, raws, { retrievable: dep })
      expect(ctx.storeRetrievable).toHaveBeenCalledTimes(1)
      expect(out).toHaveLength(1)
      expect(out[0]).toBeInstanceOf(Retrievable)
      expect(out[0].trustTier).toBe('third-party-public')
    }
  })

  it('returns the post-store instance rather than the pre-store record', async () => {
    const ctx = makeCtx()
    const postSpool = new Retrievable({ ...raws[0], content: 'post-spool' })
    ctx.storeRetrievable.mockResolvedValueOnce(postSpool)
    const [out] = await storeRetrievables(ctx, raws, {
      retrievable: Retrievable as unknown as RetrievableCtor,
    })
    expect(out).toBe(postSpool)
  })

  it('rejects a bad trustTier at Retrievable construction (validation fires in the helper)', async () => {
    const bad = [{ ...raws[0], trustTier: 'bogus' as never }]
    const ctx = makeCtx()
    await expect(
      storeRetrievables(ctx, bad, { retrievable: Retrievable as unknown as RetrievableCtor })
    ).rejects.toBeTruthy()
    expect(ctx.storeRetrievable).not.toHaveBeenCalled()
  })

  it('a custom (fake) SpooledArtifact subclass resolver threads through untouched', () => {
    // Extensibility: the glue names no concrete artifact class; a future YAML/HTML subclass works.
    class YamlSpooledArtifact extends SpooledArtifact {}
    let got: unknown
    scrapperArticleToRetrievable(
      { url: 'https://x', textContent: 'y' },
      {
        spool: (_i, _t, rec) => {
          got = rec()
          return undefined
        },
      },
      { text: () => YamlSpooledArtifact }
    )
    expect(got).toBe(YamlSpooledArtifact)
  })
})
