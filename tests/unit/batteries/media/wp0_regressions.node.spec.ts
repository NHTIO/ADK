import { describe, expect, it } from 'vitest'
import { createMediaPipeline, MIME } from '../../../../src/batteries/media'
import type { StepPayload } from '../../../../src/batteries/media'
import type { ConvertRequest, MediaEngine } from '../../../../src/batteries/media/contracts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const utf16le = (text: string): Uint8Array => {
  const body = new Uint8Array(new TextEncoder().encode(text).length * 2)
  const view = new DataView(body.buffer)
  let offset = 0
  for (const codePoint of text) {
    const code = codePoint.codePointAt(0)!
    view.setUint16(offset, code, true)
    offset += 2
  }
  return new Uint8Array([0xff, 0xfe, ...body])
}
const utf16be = (text: string): Uint8Array => {
  const body = new Uint8Array(text.length * 2)
  const view = new DataView(body.buffer)
  for (let i = 0; i < text.length; i += 1) view.setUint16(i * 2, text.charCodeAt(i), false)
  return new Uint8Array([0xfe, 0xff, ...body])
}
const payload = (
  bytes: Uint8Array,
  filename = 'fixture.txt',
  mimeType: string = MIME.TXT
): StepPayload => ({
  bytes,
  mimeType,
  filename,
})
const ocrEngine = (seen: string[]): MediaEngine => ({
  id: 'wp0-ocr',
  converts: [
    {
      from: ['image/*'],
      to: ['txt'],
      async convert(request: ConvertRequest) {
        seen.push(request.mimeType)
        return { outputs: [{ bytes: encode('OCR RESULT'), mimeType: MIME.TXT }] }
      },
    },
  ],
})

describe('WP0 C1 SVG textual wrapper regressions', () => {
  const svg = payload(encode('<svg><text>secret</text></svg>'), 'fixture.svg', 'image/svg+xml')

  it('append accepts image/svg+xml', async () => {
    const mp = await createMediaPipeline()
    const result = (await mp.ops(svg, [
      { verb: 'append', args: { text: '<text>added</text>' } },
    ])) as { payload: StepPayload }
    expect(new TextDecoder().decode(result.payload.bytes)).toContain('<text>added</text>')
  })

  it('redact accepts image/svg+xml', async () => {
    const mp = await createMediaPipeline()
    const result = (await mp(svg).redact({ match: 'secret', replace: 'redacted' })) as StepPayload
    expect(new TextDecoder().decode(result.bytes)).toContain('redacted')
  })

  it('update_text accepts image/svg+xml', async () => {
    const mp = await createMediaPipeline()
    const result = (await mp(svg).updateText('secret', 'updated')) as StepPayload
    expect(new TextDecoder().decode(result.bytes)).toContain('updated')
  })

  it('sanitize accepts image/svg+xml', async () => {
    const mp = await createMediaPipeline()
    const result = (await mp(
      payload(encode('<svg>ok\u0001</svg>'), 'fixture.svg', 'image/svg+xml')
    ).sanitize()) as StepPayload
    expect(new TextDecoder().decode(result.bytes)).toBe('<svg>ok</svg>')
  })

  it('normalize accepts image/svg+xml', async () => {
    const mp = await createMediaPipeline()
    const result = (await mp(
      payload(encode('<svg>line  \r\n</svg>'), 'fixture.svg', 'image/svg+xml')
    ).normalize()) as StepPayload
    expect(new TextDecoder().decode(result.bytes)).toBe('<svg>line\n</svg>')
  })

  it('extract.text in auto mode decodes image/svg+xml markup instead of invoking OCR', async () => {
    const seen: string[] = []
    const mp = await createMediaPipeline({ engines: [ocrEngine(seen)] })
    expect(await mp(svg).extractText()).toBe('<svg><text>secret</text></svg>')
    expect(seen).toEqual([])
  })

  it('extract.text with ocr=force still routes image/svg+xml to OCR', async () => {
    const seen: string[] = []
    const mp = await createMediaPipeline({ engines: [ocrEngine(seen)] })
    expect(await mp(svg).extractText({ ocr: 'force' })).toBe('OCR RESULT')
    expect(seen).toEqual(['image/svg+xml'])
  })
})

describe('WP0 C2 UTF-16 BOM CR normalization regressions', () => {
  it('normalizes CR in chunk input', async () => {
    const mp = await createMediaPipeline()
    const chunks = await mp(payload(utf16le('one\rtwo\r\nthree'))).chunk({ strategy: 'paragraph' })
    expect((chunks as Array<{ text: string }>).map((chunk) => chunk.text).join('')).toBe(
      'one\ntwo\nthree'
    )
  })

  it('normalizes CR in extract.text input', async () => {
    const mp = await createMediaPipeline()
    expect(await mp(payload(utf16be('one\rtwo\r\nthree'))).extractText()).toBe('one\ntwo\nthree')
  })

  it('normalizes CR in redact input', async () => {
    const mp = await createMediaPipeline()
    const out = (await mp(payload(utf16le('one\rtwo'))).redact({
      match: 'one',
      replace: 'ONE',
    })) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('ONE\ntwo')
  })

  it('normalizes CR in update_text input', async () => {
    const mp = await createMediaPipeline()
    const out = (await mp(payload(utf16be('one\rtwo'))).updateText(
      'one\ntwo',
      'ONE\nTWO'
    )) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('ONE\nTWO')
  })

  it('normalizes CR in both inputs to diff', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(payload(utf16le('one\rtwo')), 'diff with=@other', {
      resolveRef: async () => payload(utf16be('one\nTHREE'), 'other.txt'),
    })
    expect(result.kind).toBe('data')
    expect((result as { data: { changes: Array<{ value: string }> } }).data.changes).toEqual([
      { count: 1, added: false, removed: false, value: 'one\n' },
      { count: 1, added: false, removed: true, value: 'two' },
      { count: 1, added: true, removed: false, value: 'THREE' },
    ])
  })

  it('normalizes CR in the unified apply_patch source', async () => {
    const mp = await createMediaPipeline()
    const patch = [
      '--- fixture.txt',
      '+++ fixture.txt',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '',
    ].join('\n')
    const out = (await mp(payload(utf16le('one\rtwo'))).applyPatch(patch)) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('ONE\ntwo')
  })

  it('normalizes CR in structured apply_patch source', async () => {
    const mp = await createMediaPipeline()
    const patch = [
      '*** Begin Patch',
      '*** Update File: fixture.txt',
      '@@',
      '-one',
      '+ONE',
      ' two',
      '*** End Patch',
    ].join('\n')
    const result = await mp.ops(payload(utf16be('one\rtwo')), [
      { verb: 'apply_patch', args: { patch } },
    ])
    expect(result.kind).toBe('media')
    expect(new TextDecoder().decode((result as { payload: StepPayload }).payload.bytes)).toBe(
      'ONE\ntwo'
    )
  })

  it('normalizes CR in sanitize input', async () => {
    const mp = await createMediaPipeline()
    const out = (await mp(payload(utf16le('one\rtwo'))).sanitize()) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('one\ntwo')
  })

  it('normalizes CR in normalize input', async () => {
    const mp = await createMediaPipeline()
    const out = (await mp(payload(utf16be('one\rtwo'))).normalize()) as StepPayload
    expect(new TextDecoder().decode(out.bytes)).toBe('one\ntwo')
  })
})
