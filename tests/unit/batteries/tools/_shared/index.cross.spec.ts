import { describe, expect, it } from 'vitest'
import { Middleware } from '@nhtio/middleware'
import {
  SpooledArtifact,
  SpooledJsonArtifact,
  SpooledMarkdownArtifact,
} from '../../../../../src/spooled_artifact'
import {
  resolveHeaders,
  resolveArtifact,
  resolveArtifactSync,
  makeShortCircuit,
  isShortCircuit,
  runInputPipeline,
  runOutputPipeline,
  type MiddlewareFn,
} from '../../../../../src/batteries/tools/_shared'

const boom = (reason: string): never => {
  throw new Error(`invalid: ${reason}`)
}

describe('_shared — resolveHeaders', () => {
  it('returns an owned copy of a static header object', async () => {
    const src = { 'X-Auth': 'k' }
    const out = await resolveHeaders(src)
    expect(out).toEqual({ 'X-Auth': 'k' })
    expect(out).not.toBe(src)
  })

  it('awaits a sync resolver and an async resolver', async () => {
    expect(await resolveHeaders(() => ({ a: '1' }))).toEqual({ a: '1' })
    expect(await resolveHeaders(async () => ({ b: '2' }))).toEqual({ b: '2' })
  })

  it('returns {} for undefined', async () => {
    expect(await resolveHeaders(undefined)).toEqual({})
  })
})

describe('_shared — resolveArtifact (async)', () => {
  it('accepts a bare constructor', async () => {
    const r = await resolveArtifact(SpooledMarkdownArtifact, boom)
    expect(r()).toBe(SpooledMarkdownArtifact)
  })

  it('accepts a sync resolver', async () => {
    const r = await resolveArtifact(() => SpooledJsonArtifact, boom)
    expect(r()).toBe(SpooledJsonArtifact)
  })

  it('accepts an async resolver', async () => {
    const r = await resolveArtifact(async () => SpooledArtifact, boom)
    expect(r()).toBe(SpooledArtifact)
  })

  it('unwraps a module-namespace { default } from an async resolver', async () => {
    const r = await resolveArtifact(async () => ({ default: SpooledMarkdownArtifact }), boom)
    expect(r()).toBe(SpooledMarkdownArtifact)
  })

  it('rejects (via onInvalid) a resolver that yields a non-constructor', async () => {
    await expect(resolveArtifact((() => 42) as never, boom)).rejects.toThrow(/invalid/)
  })

  it('rejects (via onInvalid) a resolver that throws', async () => {
    await expect(
      resolveArtifact(
        (() => {
          throw new Error('nope')
        }) as never,
        boom
      )
    ).rejects.toThrow(/invalid/)
  })
})

describe('_shared — resolveArtifactSync', () => {
  it('accepts a bare constructor and a sync resolver', () => {
    expect(resolveArtifactSync(SpooledArtifact, boom)()).toBe(SpooledArtifact)
    expect(resolveArtifactSync(() => SpooledJsonArtifact, boom)()).toBe(SpooledJsonArtifact)
  })

  it('throws (via onInvalid) on an async resolver', () => {
    expect(() => resolveArtifactSync((async () => SpooledArtifact) as never, boom)).toThrow(
      /invalid/
    )
  })

  it('throws (via onInvalid) on a non-constructor result', () => {
    expect(() => resolveArtifactSync((() => 'x') as never, boom)).toThrow(/invalid/)
  })
})

interface Ctx {
  hits: string[]
  shortCircuit: (result: string) => never
}

describe('_shared — pipeline runners', () => {
  const mwWith = (...fns: MiddlewareFn<Ctx>[]): Middleware<MiddlewareFn<Ctx>> => {
    const mw = new Middleware<MiddlewareFn<Ctx>>()
    for (const fn of fns) mw.add(fn)
    return mw
  }

  it('runInputPipeline runs stages and returns undefined on completion', async () => {
    const ctx: Ctx = { hits: [], shortCircuit: makeShortCircuit() }
    const mw = mwWith(
      async (c, next) => {
        c.hits.push('a')
        await next()
      },
      async (c, next) => {
        c.hits.push('b')
        await next()
      }
    )
    const r = await runInputPipeline(mw, ctx, 'Test')
    expect(r).toBeUndefined()
    expect(ctx.hits).toEqual(['a', 'b'])
  })

  it('runInputPipeline returns the short-circuit string and stops', async () => {
    const ctx: Ctx = { hits: [], shortCircuit: makeShortCircuit() }
    const mw = mwWith(
      async (c) => {
        c.hits.push('a')
        c.shortCircuit('cached')
      },
      async (c, next) => {
        c.hits.push('b')
        await next()
      }
    )
    const r = await runInputPipeline(mw, ctx, 'Test')
    expect(r).toBe('cached')
    expect(ctx.hits).toEqual(['a'])
  })

  it('runInputPipeline throws on a non-terminal pipeline (no next, no short-circuit)', async () => {
    const ctx: Ctx = { hits: [], shortCircuit: makeShortCircuit() }
    const mw = mwWith(async () => {
      /* neither next() nor shortCircuit */
    })
    await expect(runInputPipeline(mw, ctx, 'Test')).rejects.toThrow(/did not call next/)
  })

  it('runInputPipeline rethrows a genuine stage error', async () => {
    const ctx: Ctx = { hits: [], shortCircuit: makeShortCircuit() }
    const mw = mwWith(async () => {
      throw new Error('stage boom')
    })
    await expect(runInputPipeline(mw, ctx, 'Test')).rejects.toThrow(/stage boom/)
  })

  it('runOutputPipeline runs stages and rethrows stage errors', async () => {
    const ctx: Ctx = { hits: [], shortCircuit: makeShortCircuit() }
    const ok = mwWith(async (c, next) => {
      c.hits.push('o')
      await next()
    })
    await runOutputPipeline(ok, ctx, 'Test')
    expect(ctx.hits).toEqual(['o'])

    const bad = mwWith(async () => {
      throw new Error('out boom')
    })
    await expect(runOutputPipeline(bad, ctx, 'Test')).rejects.toThrow(/out boom/)
  })

  it('isShortCircuit only matches the sentinel', () => {
    expect(isShortCircuit(new Error('x'))).toBe(false)
    expect(isShortCircuit({ result: 'x' })).toBe(false)
    let caught: unknown
    try {
      makeShortCircuit()('hi')
    } catch (e) {
      caught = e
    }
    expect(isShortCircuit(caught)).toBe(true)
    expect((caught as { result: string }).result).toBe('hi')
  })
})
