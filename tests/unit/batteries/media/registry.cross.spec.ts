import { describe, expect, it } from 'vitest'
import { buildEngineRegistry } from '../../../../src/batteries/media/registry'
import { createMediaPipeline, MIME, PCM_MIME } from '../../../../src/batteries/media'
import type { StepPayload } from '../../../../src/batteries/media'
import type { EngineSelectionMiddlewareFn } from '../../../../src/batteries/media/registry'
import type {
  MediaEngine,
  ConvertRequest,
  ConvertCapability,
  MutateCapability,
} from '../../../../src/batteries/media/contracts'

const encoder = new TextEncoder()

const payloadOf = (text: string, mimeType: string, filename: string): StepPayload => ({
  bytes: encoder.encode(text),
  mimeType,
  filename,
})

const OUT_MIME: Record<string, string> = {
  pdf: MIME.PDF,
  docx: MIME.DOCX,
  xlsx: MIME.XLSX,
  txt: MIME.TXT,
}

/** A stub convert engine over fixed (input mime → target token) edges. */
const convertEngineOf = (
  name: string,
  edges: Record<string, string[]>,
  log?: string[]
): MediaEngine => {
  const converts: ConvertCapability[] = Object.entries(edges).map(([from, to]) => ({
    from: [from],
    to,
    async convert(request: ConvertRequest) {
      log?.push(`${name}:${request.mimeType}->${request.to}`)
      return {
        outputs: [
          {
            bytes: encoder.encode(`${name}(${new TextDecoder().decode(request.bytes)})`),
            mimeType: OUT_MIME[request.to] ?? 'application/octet-stream',
          },
        ],
      }
    },
  }))
  return { id: name, converts }
}

/** A stub mutate engine. */
const mutateEngineOf = (
  name: string,
  over: string[],
  ops: string[],
  encodes: string[],
  log?: string[]
): MediaEngine => {
  const mutates: MutateCapability[] = [
    {
      over,
      ops,
      encodes,
      async mutate(request) {
        log?.push(`${name}:mutate:${request.mimeType}`)
        return { bytes: request.bytes, mimeType: request.mimeType }
      },
    },
  ]
  return { id: name, mutates }
}

describe('buildEngineRegistry — convert dispatch', () => {
  it('first capable engine in array order wins', async () => {
    const log: string[] = []
    const narrow = convertEngineOf('narrow', { [MIME.DOCX]: ['pdf'] }, log)
    const broad = convertEngineOf('broad', { [MIME.DOCX]: ['pdf', 'txt'] }, log)
    const registry = buildEngineRegistry([narrow, broad])
    await registry.convert({
      bytes: encoder.encode('x'),
      mimeType: MIME.DOCX,
      filename: 'a.docx',
      to: 'pdf',
    })
    expect(log).toEqual([`narrow:${MIME.DOCX}->pdf`])
  })

  it('dispatch falls through past an incapable engine', async () => {
    const log: string[] = []
    const narrow = convertEngineOf('narrow', { [MIME.DOCX]: ['pdf'] }, log)
    const broad = convertEngineOf('broad', { [MIME.ODT]: ['pdf'] }, log)
    const registry = buildEngineRegistry([narrow, broad])
    await registry.convert({
      bytes: encoder.encode('x'),
      mimeType: MIME.ODT,
      filename: 'a.odt',
      to: 'pdf',
    })
    expect(log).toEqual([`broad:${MIME.ODT}->pdf`])
  })

  it('wildcard from-patterns match by family', async () => {
    const ocrish = convertEngineOf('ocrish', { 'image/*': ['txt'] })
    const registry = buildEngineRegistry([ocrish])
    expect(registry.hasConvert('image/png', 'txt')).toBe(true)
    expect(registry.hasConvert('image/webp', 'txt')).toBe(true)
    expect(registry.hasConvert('audio/mpeg', 'txt')).toBe(false)
  })

  it('computes a multi-hop path when no engine has a direct edge', async () => {
    const log: string[] = []
    const a = convertEngineOf('a', { [MIME.ODT]: ['docx'] }, log)
    const b = convertEngineOf('b', { [MIME.DOCX]: ['pdf'] }, log)
    const registry = buildEngineRegistry([a, b])
    const result = await registry.convert({
      bytes: encoder.encode('seed'),
      mimeType: MIME.ODT,
      filename: 'a.odt',
      to: 'pdf',
    })
    expect(log).toEqual([`a:${MIME.ODT}->docx`, `b:${MIME.DOCX}->pdf`])
    expect(new TextDecoder().decode(result.outputs[0].bytes)).toBe('b(a(seed))')
  })

  it('prefers a direct path over a multi-hop one', async () => {
    const log: string[] = []
    const hopper = convertEngineOf('hopper', { [MIME.ODT]: ['docx'], [MIME.DOCX]: ['pdf'] }, log)
    const direct = convertEngineOf('direct', { [MIME.ODT]: ['pdf'] }, log)
    const registry = buildEngineRegistry([hopper, direct])
    await registry.convert({
      bytes: encoder.encode('x'),
      mimeType: MIME.ODT,
      filename: 'a.odt',
      to: 'pdf',
    })
    expect(log).toEqual([`direct:${MIME.ODT}->pdf`])
  })

  it('convertTargets reports reachable formats, including via hops', () => {
    const a = convertEngineOf('a', { [MIME.ODT]: ['docx'] })
    const b = convertEngineOf('b', { [MIME.DOCX]: ['pdf', 'txt'] })
    const registry = buildEngineRegistry([a, b])
    const targets = registry.convertTargets(MIME.ODT)
    expect(targets).toContain('docx')
    expect(targets).toContain('pdf')
    expect(targets).toContain('txt')
  })

  it('fails with reachable targets listed when no path exists', async () => {
    const a = convertEngineOf('a', { [MIME.ODT]: ['docx'] })
    const registry = buildEngineRegistry([a])
    await expect(
      registry.convert({
        bytes: encoder.encode('x'),
        mimeType: MIME.ODT,
        filename: 'a.odt',
        to: 'pdf',
      })
    ).rejects.toThrow(/no configured engine.*reachable targets: docx/)
  })

  it('terminal tokens are endpoints, never intermediate hops (no-bridge rule)', async () => {
    // txt is producible, and txt→pdf exists — but routing docx→txt→pdf would be garbage.
    const lossy = convertEngineOf('lossy', { [MIME.DOCX]: ['txt'] })
    const fromTxt = convertEngineOf('fromTxt', { [MIME.TXT]: ['pdf'] })
    const registry = buildEngineRegistry([lossy, fromTxt])
    await expect(
      registry.convert({
        bytes: encoder.encode('x'),
        mimeType: MIME.DOCX,
        filename: 'a.docx',
        to: 'pdf',
      })
    ).rejects.toThrow(/no configured engine/)
  })

  it('pcm is never auto-chained through (the transcribe step composes that path)', async () => {
    const decoder = convertEngineOf('decoder', { 'audio/wav': ['pcm'] })
    const asr = convertEngineOf('asr', { [PCM_MIME]: ['txt'] })
    const registry = buildEngineRegistry([decoder, asr])
    await expect(
      registry.convert({
        bytes: encoder.encode('x'),
        mimeType: 'audio/wav',
        filename: 'a.wav',
        to: 'txt',
      })
    ).rejects.toThrow(/no configured engine/)
    // Each leg is individually reachable.
    expect(registry.hasConvert('audio/wav', 'pcm')).toBe(true)
    expect(registry.hasConvert(PCM_MIME, 'txt')).toBe(true)
  })

  it('a multi-capability engine serves several edges', async () => {
    const multi: MediaEngine = {
      id: 'multi',
      converts: [
        {
          from: [MIME.DOCX],
          to: ['pdf'],
          convert: async () => ({ outputs: [{ bytes: encoder.encode('p'), mimeType: MIME.PDF }] }),
        },
        {
          from: [MIME.ODS],
          to: ['xlsx'],
          convert: async () => ({
            outputs: [{ bytes: encoder.encode('x'), mimeType: MIME.XLSX }],
          }),
        },
      ],
      mutates: [
        {
          over: ['image/*'],
          ops: ['resize'],
          encodes: ['png'],
          mutate: async (r) => ({ bytes: r.bytes, mimeType: r.mimeType }),
        },
      ],
    }
    const registry = buildEngineRegistry([multi])
    expect(registry.hasConvert(MIME.DOCX, 'pdf')).toBe(true)
    expect(registry.hasConvert(MIME.ODS, 'xlsx')).toBe(true)
    expect(registry.hasConvert(MIME.DOCX, 'xlsx')).toBe(false)
    expect(registry.hasMutate()).toBe(true)
  })

  it('multi-output converts return every output', async () => {
    const extractor: MediaEngine = {
      id: 'extractor',
      converts: [
        {
          from: [MIME.PDF],
          to: ['images'],
          convert: async () => ({
            outputs: [
              { bytes: encoder.encode('1'), mimeType: 'image/jpeg' },
              { bytes: encoder.encode('2'), mimeType: 'image/png' },
            ],
          }),
        },
      ],
    }
    const registry = buildEngineRegistry([extractor])
    const result = await registry.convert({
      bytes: encoder.encode('x'),
      mimeType: MIME.PDF,
      filename: 'a.pdf',
      to: 'images',
    })
    expect(result.outputs).toHaveLength(2)
  })
})

describe('buildEngineRegistry — mutate dispatch', () => {
  it('selects on over + ops subset + encodes', async () => {
    const log: string[] = []
    const limited = mutateEngineOf('limited', ['image/png'], ['resize'], ['png'], log)
    const full = mutateEngineOf(
      'full',
      ['image/*'],
      ['resize', 'rotate', 'flip', 'strip_metadata'],
      ['png', 'jpg', 'webp'],
      log
    )
    const registry = buildEngineRegistry([limited, full])
    // resize-only png: limited wins by order.
    await registry.mutate({ bytes: encoder.encode('x'), mimeType: 'image/png', resize: {} })
    // rotate: limited can't, falls through to full.
    await registry.mutate({ bytes: encoder.encode('x'), mimeType: 'image/png', rotate: 90 })
    // format change to webp: only full encodes it.
    await registry.mutate({
      bytes: encoder.encode('x'),
      mimeType: 'image/png',
      format: { to: 'webp' },
    })
    expect(log).toEqual([
      'limited:mutate:image/png',
      'full:mutate:image/png',
      'full:mutate:image/png',
    ])
  })

  it('a no-candidate mutate fails naming declared ops and encodings', async () => {
    const only = mutateEngineOf('only', ['image/*'], ['resize'], ['png'])
    const registry = buildEngineRegistry([only])
    await expect(
      registry.mutate({
        bytes: encoder.encode('x'),
        mimeType: 'image/png',
        format: { to: 'webp' },
      })
    ).rejects.toThrow(/declared encodings: png/)
  })
})

describe('buildEngineRegistry — selection middleware', () => {
  const slow = (log?: string[]) => convertEngineOf('slow', { [MIME.DOCX]: ['pdf'] }, log)
  const fast = (log?: string[]) => convertEngineOf('fast', { [MIME.DOCX]: ['pdf'] }, log)
  const request = {
    bytes: encoder.encode('x'),
    mimeType: MIME.DOCX,
    filename: 'a.docx',
    to: 'pdf',
  }

  it('an exclusion stage steers dispatch to the next survivor', async () => {
    const log: string[] = []
    const exclude: EngineSelectionMiddlewareFn = async (ctx, next) => {
      ctx.candidates = ctx.candidates.filter((e) => e.id !== 'slow')
      await next()
    }
    const registry = buildEngineRegistry([slow(log), fast(log)], [exclude])
    await registry.convert(request)
    expect(log).toEqual([`fast:${MIME.DOCX}->pdf`])
  })

  it('a reorder stage overrides array order', async () => {
    const log: string[] = []
    const reorder: EngineSelectionMiddlewareFn = async (ctx, next) => {
      ctx.candidates = [...ctx.candidates].reverse()
      await next()
    }
    const registry = buildEngineRegistry([slow(log), fast(log)], [reorder])
    await registry.convert(request)
    expect(log).toEqual([`fast:${MIME.DOCX}->pdf`])
  })

  it('a stage cannot conscript an incapable engine (re-filter proves it)', async () => {
    const log: string[] = []
    const incapable = convertEngineOf('incapable', { [MIME.ODT]: ['pdf'] }, log)
    const capable = convertEngineOf('capable', { [MIME.DOCX]: ['pdf'] }, log)
    const conscript: EngineSelectionMiddlewareFn = async (ctx, next) => {
      ctx.candidates = [incapable, ...ctx.candidates]
      await next()
    }
    const registry = buildEngineRegistry([incapable, capable], [conscript])
    await registry.convert(request)
    expect(log).toEqual([`capable:${MIME.DOCX}->pdf`])
  })

  it('excluding every candidate fails honestly, naming the ids', async () => {
    const nuke: EngineSelectionMiddlewareFn = async (ctx, next) => {
      ctx.candidates = []
      await next()
    }
    const registry = buildEngineRegistry([slow(), fast()], [nuke])
    await expect(registry.convert(request)).rejects.toThrow(
      /all engines capable.*\(slow, fast\) were excluded by selection middleware/
    )
  })

  it('a throwing stage surfaces as the dispatch failure', async () => {
    const boom: EngineSelectionMiddlewareFn = async () => {
      throw new Error('selection stage exploded')
    }
    const registry = buildEngineRegistry([slow(), fast()], [boom])
    await expect(registry.convert(request)).rejects.toThrow(/selection stage exploded/)
  })

  it('stages see the request bytes (content-dependent rules)', async () => {
    const log: string[] = []
    const contentRule: EngineSelectionMiddlewareFn = async (ctx, next) => {
      if (new TextDecoder().decode(ctx.request.bytes).includes('complex')) {
        ctx.candidates = ctx.candidates.filter((e) => e.id !== 'slow')
      }
      await next()
    }
    const registry = buildEngineRegistry([slow(log), fast(log)], [contentRule])
    await registry.convert({ ...request, bytes: encoder.encode('a complex workbook') })
    await registry.convert({ ...request, bytes: encoder.encode('simple') })
    expect(log).toEqual([`fast:${MIME.DOCX}->pdf`, `slow:${MIME.DOCX}->pdf`])
  })

  it('the onion runs per executed hop on a multi-hop path', async () => {
    const seen: string[] = []
    const a1 = convertEngineOf('a1', { [MIME.ODT]: ['docx'] })
    const b1 = convertEngineOf('b1', { [MIME.DOCX]: ['pdf'] })
    const observer: EngineSelectionMiddlewareFn = async (ctx, next) => {
      seen.push(`${ctx.request.mimeType}->${ctx.request.to}`)
      await next()
    }
    // Two candidates per hop so the onion actually runs (single-candidate dispatches skip it).
    const a2 = convertEngineOf('a2', { [MIME.ODT]: ['docx'] })
    const b2 = convertEngineOf('b2', { [MIME.DOCX]: ['pdf'] })
    const registry = buildEngineRegistry([a1, a2, b1, b2], [observer])
    await registry.convert({
      bytes: encoder.encode('x'),
      mimeType: MIME.ODT,
      filename: 'a.odt',
      to: 'pdf',
    })
    expect(seen).toEqual([`${MIME.ODT}->docx`, `${MIME.DOCX}->pdf`])
  })

  it('a single capable candidate skips the onion entirely', async () => {
    let ran = false
    const stage: EngineSelectionMiddlewareFn = async (_ctx, next) => {
      ran = true
      await next()
    }
    const registry = buildEngineRegistry([slow()], [stage])
    await registry.convert(request)
    expect(ran).toBe(false)
  })
})

describe('createMediaPipeline — engine array construction', () => {
  it('accepts instances and resolvers, dispatching through the registry', async () => {
    const log: string[] = []
    const a = convertEngineOf('a', { [MIME.ODT]: ['docx'] }, log)
    const mp = await createMediaPipeline({
      engines: [a, () => convertEngineOf('b', { [MIME.DOCX]: ['pdf'] }, log)],
    })
    const result = await mp.query(payloadOf('seed', MIME.ODT, 'a.odt'), 'convert to=pdf')
    expect(result.kind).toBe('media')
    expect(log).toEqual([`a:${MIME.ODT}->docx`, `b:${MIME.DOCX}->pdf`])
  })

  it('resolvers run eagerly at construction', async () => {
    let resolved = 0
    await createMediaPipeline({
      engines: [
        () => {
          resolved++
          return convertEngineOf('a', { [MIME.DOCX]: ['pdf'] })
        },
      ],
    })
    expect(resolved).toBe(1)
  })

  it('a failing resolver rejects construction, naming the index', async () => {
    await expect(
      createMediaPipeline({
        engines: [
          () => {
            throw new Error('peer import failed')
          },
        ],
      })
    ).rejects.toThrow(/engines\[0\] resolver failed: peer import failed/)
  })

  it('a malformed engine rejects construction, naming index and id', async () => {
    await expect(
      // @ts-expect-error deliberately wrong shape
      createMediaPipeline({ engines: [{ id: 'broken', converts: [{ nope: 1 }] }] })
    ).rejects.toThrow(/engines\[0\] \("broken"\) does not implement the MediaEngine contract/)
  })

  it('an engine with no capabilities is rejected', async () => {
    await expect(createMediaPipeline({ engines: [{ id: 'empty' }] })).rejects.toThrow(
      /engines\[0\] \("empty"\)/
    )
  })

  it('an empty engines array is legal (zero capabilities)', async () => {
    const mp = await createMediaPipeline({ engines: [] })
    expect(mp.engines).toEqual([])
    expect(mp.capabilities.hasConvert()).toBe(false)
    expect(() => mp.compile('convert to=pdf')).toThrow(/Do not retry/)
  })

  it('capabilities gate the advertised grammar (convert verb appears with a provider)', async () => {
    const mp = await createMediaPipeline({
      engines: [convertEngineOf('a', { [MIME.DOCX]: ['pdf'] })],
    })
    expect(mp.capabilities.hasConvert(MIME.DOCX, 'pdf')).toBe(true)
    expect(() => mp.compile('convert to=pdf')).not.toThrow()
  })

  it('the engines list is inspectable on the pipeline', async () => {
    const a = convertEngineOf('a', { [MIME.DOCX]: ['pdf'] })
    const mp = await createMediaPipeline({ engines: [a] })
    expect(mp.engines.map((e) => e.id)).toEqual(['a'])
  })

  it('selection stages from config reach the registry', async () => {
    const log: string[] = []
    const exclude: EngineSelectionMiddlewareFn = async (ctx, next) => {
      ctx.candidates = ctx.candidates.filter((e) => e.id !== 'slow')
      await next()
    }
    const mp = await createMediaPipeline({
      engines: [
        convertEngineOf('slow', { [MIME.DOCX]: ['pdf'] }, log),
        convertEngineOf('fast', { [MIME.DOCX]: ['pdf'] }, log),
      ],
      selection: [exclude],
    })
    await mp.query(payloadOf('x', MIME.DOCX, 'a.docx'), 'convert to=pdf')
    expect(log).toEqual([`fast:${MIME.DOCX}->pdf`])
  })
})
