import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createMediaPipeline, MIME } from '../../../../src/batteries/media'
import type { StepPayload, MediaStepMiddlewareFn } from '../../../../src/batteries/media'

const encoder = new TextEncoder()

const textPayload = (text: string, filename = 'note.txt'): StepPayload => ({
  bytes: encoder.encode(text),
  mimeType: 'text/plain',
  filename,
})

/** Build a tiny real PDF with one numbered page per entry. */
const makePdf = async (labels: string[]): Promise<StepPayload> => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const label of labels) {
    const page = doc.addPage([200, 100])
    page.drawText(label, { x: 20, y: 50, size: 12, font })
  }
  return { bytes: new Uint8Array(await doc.save()), mimeType: MIME.PDF, filename: 'doc.pdf' }
}

const pageCountOf = async (bytes: Uint8Array): Promise<number> => {
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}

describe('createMediaPipeline (pure steps, zero engines)', () => {
  it('builder: chunk over text resolves to chunk data', async () => {
    const mp = await createMediaPipeline()
    const chunks = (await mp(textPayload('para one.\n\npara two.\n\npara three.')).chunk({
      strategy: 'paragraph',
    })) as Array<{ index: number; text: string }>
    expect(chunks).toHaveLength(3)
    expect(chunks[0].text).toBe('para one.')
  })

  it('query: the pipe front-end produces the same result as the builder', async () => {
    const mp = await createMediaPipeline()
    const viaBuilder = (await mp(textPayload('a.\n\nb.')).chunk({
      strategy: 'paragraph',
    })) as unknown[]
    const viaQuery = await mp.query(textPayload('a.\n\nb.'), 'chunk by=paragraph')
    expect(viaQuery.kind).toBe('data')
    expect((viaQuery as { data: unknown }).data).toEqual(viaBuilder)
  })

  it('ops: the JSON front-end produces the same result too', async () => {
    const mp = await createMediaPipeline()
    const viaOps = await mp.ops(textPayload('a.\n\nb.'), [
      { verb: 'chunk', args: { by: 'paragraph' } },
    ])
    expect(viaOps.kind).toBe('data')
    expect(((viaOps as { data: unknown[] }).data as unknown[]).length).toBe(2)
  })

  it('extract text on native text media', async () => {
    const mp = await createMediaPipeline()
    const text = (await mp(textPayload('hello world')).extractText()) as string
    expect(text).toBe('hello world')
  })

  it('extract text | chunk chains (R-step materialization)', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(textPayload('one.\n\ntwo.'), 'extract text | chunk by=paragraph')
    expect(result.kind).toBe('data')
    expect(((result as { data: unknown[] }).data as unknown[]).length).toBe(2)
  })

  it('redact over text media via pipe with regex literal', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(
      textPayload('ssn 123-45-6789 end'),
      'redact match=/\\d{3}-\\d{2}-\\d{4}/ replace="[SSN]"'
    )
    expect(result.kind).toBe('media')
    const text = new TextDecoder().decode((result as { payload: StepPayload }).payload.bytes)
    expect(text).toBe('ssn [SSN] end')
  })

  it('update_text replaces the anchor and errors when absent', async () => {
    const mp = await createMediaPipeline()
    const ok = (await mp(textPayload('alpha beta')).updateText('beta', 'gamma')) as StepPayload
    expect(new TextDecoder().decode(ok.bytes)).toBe('alpha gamma')
    await expect(mp(textPayload('alpha')).updateText('zeta', 'x')).rejects.toThrow(
      /anchor text not found/
    )
  })

  it('diff + apply_patch round-trip through resolveRef', async () => {
    const a = textPayload('line one\nline two\n', 'a.txt')
    const b = textPayload('line one\nline 2\n', 'b.txt')
    const mp = await createMediaPipeline({
      resolveRef: (id) => {
        expect(id).toBe('other')
        return b
      },
    })
    const diff = await mp.query(a, 'diff with=@other')
    expect(diff.kind).toBe('data')
    const { patch } = (diff as { data: { patch: string } }).data
    expect(patch).toContain('-line two')
    expect(patch).toContain('+line 2')
    const patched = (await mp(a).applyPatch(patch)) as StepPayload
    expect(new TextDecoder().decode(patched.bytes)).toBe('line one\nline 2\n')
  })

  it('select keeps 1-based pages from a real PDF', async () => {
    const mp = await createMediaPipeline()
    const pdf = await makePdf(['p1', 'p2', 'p3', 'p4'])
    const out = (await mp(pdf).select({ pages: [2, 4] })) as StepPayload
    expect(await pageCountOf(out.bytes)).toBe(2)
  })

  it('select rejects out-of-range pages with a 1-based message', async () => {
    const mp = await createMediaPipeline()
    const pdf = await makePdf(['p1'])
    await expect(mp(pdf).select({ pages: [3] })).rejects.toThrow(/1-based/)
  })

  it('split with JSON ranges yields a media list', async () => {
    const mp = await createMediaPipeline()
    const pdf = await makePdf(['p1', 'p2', 'p3', 'p4'])
    const result = await mp.query(pdf, `split ranges='[[1,2],[4,4]]'`)
    expect(result.kind).toBe('media-list')
    const payloads = (result as { payloads: StepPayload[] }).payloads
    expect(payloads).toHaveLength(2)
    expect(await pageCountOf(payloads[0].bytes)).toBe(2)
    expect(await pageCountOf(payloads[1].bytes)).toBe(1)
  })

  it('merge appends pages from a resolved @id ref', async () => {
    const first = await makePdf(['a1', 'a2'])
    const second = await makePdf(['b1'])
    const mp = await createMediaPipeline({ resolveRef: () => second })
    const result = await mp.query(first, 'merge with=@second')
    expect(result.kind).toBe('media')
    expect(await pageCountOf((result as { payload: StepPayload }).payload.bytes)).toBe(3)
  })

  it('reorder requires every page exactly once', async () => {
    const mp = await createMediaPipeline()
    const pdf = await makePdf(['p1', 'p2', 'p3'])
    const out = (await mp(pdf).reorder([3, 1, 2])) as StepPayload
    expect(await pageCountOf(out.bytes)).toBe(3)
    await expect(mp(pdf).reorder([1])).rejects.toThrow(/every page exactly once/)
  })

  it('compile validates without executing', async () => {
    const mp = await createMediaPipeline()
    const plan = mp.compile('select pages=1 | chunk')
    expect(plan.steps.map((s) => s.verb)).toEqual(['select', 'chunk'])
    expect(() => mp.compile('convert to=pdf')).toThrow(/none is configured/)
  })

  it('builder toPipe/toOps mirror the chain', async () => {
    const mp = await createMediaPipeline()
    const chain = mp(textPayload('x'))
      .select({ pages: [2, 3, 4] })
      .updateText('a', 'b')
    expect(chain.toPipe()).toBe('select pages=2-4 | update_text anchor=a replace=b')
    expect(chain.toOps()).toEqual([
      { verb: 'select', args: { pages: [2, 3, 4] } },
      { verb: 'update_text', args: { anchor: 'a', replace: 'b' } },
    ])
  })

  it('engine-gated verbs are rejected at compile with do-not-retry', async () => {
    const mp = await createMediaPipeline()
    await expect(mp.query(textPayload('x'), 'convert to=pdf')).rejects.toThrow(/Do not retry/)
  })

  it('non-terminal data steps are rejected', async () => {
    const mp = await createMediaPipeline()
    await expect(
      mp.query(textPayload('x'), 'chunk | update_text anchor=a replace=b')
    ).rejects.toThrow(/only the last step/)
  })
})

describe('step interceptors (the use seam)', () => {
  it('interceptors wrap every step in order and can read the step descriptor', async () => {
    const seen: string[] = []
    const tap: MediaStepMiddlewareFn = async (ctx, next) => {
      seen.push(`pre:${ctx.step.verb}`)
      await next()
      seen.push(`post:${ctx.step.verb}`)
    }
    const mp = await createMediaPipeline({ use: [tap] })
    await mp.query(textPayload('a.\n\nb.'), 'extract text | chunk')
    expect(seen).toEqual(['pre:extract.text', 'post:extract.text', 'pre:chunk', 'post:chunk'])
  })

  it('shortCircuit skips the step with supplied bytes (cache idiom)', async () => {
    const cached = encoder.encode('cached!')
    const cacheHit: MediaStepMiddlewareFn = async (ctx, next) => {
      if (ctx.step.verb === 'update_text') {
        ctx.shortCircuit({ bytes: cached, mimeType: 'text/plain', filename: 'cached.txt' })
      }
      await next()
    }
    const mp = await createMediaPipeline({ use: [cacheHit] })
    const out = (await mp(textPayload('orig')).updateText('orig', 'never')) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('cached!')
  })

  it('a throwing interceptor surfaces as the chain error', async () => {
    const blocker: MediaStepMiddlewareFn = async () => {
      throw new Error('DLP scan rejected the bytes')
    }
    const mp = await createMediaPipeline({ use: [blocker] })
    await expect(mp(textPayload('x')).extractText()).rejects.toThrow(/DLP scan rejected/)
  })

  it('an interceptor that does not call next or short-circuit fails the step', async () => {
    const blocker: MediaStepMiddlewareFn = async () => {
      // Intentionally return without advancing the onion.
    }
    const mp = await createMediaPipeline({ use: [blocker] })
    await expect(mp(textPayload('x')).extractText()).rejects.toThrow(
      /did not call next\(\) and did not short-circuit/
    )
  })

  // `throw undefined` is legal JS, so a sentinel that tests the captured VALUE cannot tell it
  // from "nothing was thrown" — the onion would resolve as a success and the step would appear
  // to have run. The capture is flagged instead, and this pins that.
  it('surfaces an interceptor that throws undefined rather than swallowing it', async () => {
    const nihilist: MediaStepMiddlewareFn = async () => {
      throw undefined
    }
    const mp = await createMediaPipeline({ use: [nihilist] })
    let thrown: any = '(nothing thrown)'
    try {
      await mp(textPayload('x')).extractText()
    } catch (error) {
      thrown = error
    }
    // It surfaces as a wrapped step failure (media wraps any non-E_MEDIA_ throw), but the
    // DETAIL must not be the did-not-call-next diagnostic: with a value-test sentinel the onion
    // sees "no error", falls through to `onNoNext`, and blames the interceptor's contract for
    // what was actually a rejection.
    expect(thrown?.name).toBe('E_MEDIA_STEP_FAILED')
    expect(String(thrown?.message)).not.toMatch(/did not call next\(\)/)
  })

  it('the same chain can be awaited twice (fresh runner per execution)', async () => {
    const mp = await createMediaPipeline({ use: [async (_ctx, next) => next()] })
    const chain = mp(textPayload('a.\n\nb.')).chunk()
    const one = (await chain) as unknown[]
    const two = (await chain) as unknown[]
    expect(one).toEqual(two)
  })
})

describe('config enforcement', () => {
  it('rejects an instance engine failing its contract guard', async () => {
    await expect(
      // @ts-expect-error deliberately wrong shape
      createMediaPipeline({ engines: [{ wrong: true }] })
    ).rejects.toThrow(/engines\[0\] does not implement the MediaEngine contract/)
  })

  it('rejects a resolver that resolves to a non-conforming value AT CONSTRUCTION (eager)', async () => {
    await expect(createMediaPipeline({ engines: [() => ({ nope: 1 }) as never] })).rejects.toThrow(
      /engines\[0\] does not implement the MediaEngine contract/
    )
  })

  it('requires resolveRef before @id verbs can run', async () => {
    const mp = await createMediaPipeline()
    await expect(mp.query(textPayload('x'), 'diff with=@a')).rejects.toThrow(/no resolveRef/)
  })

  it('rejects unknown config keys', async () => {
    // @ts-expect-error deliberately wrong key
    await expect(createMediaPipeline({ banana: 1 })).rejects.toThrow()
  })
})
