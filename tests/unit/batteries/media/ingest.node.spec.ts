import { describe, expect, it } from 'vitest'
import { loadMediaFixture } from '../../../_fixtures/media_fixtures'
import { createMediaPipeline } from '../../../../src/batteries/media'
import type { MediaEngine, ConvertRequest } from '../../../../src/batteries/media/contracts'

/** Wrap an OCR-flavored recognize function as a MediaEngine convert capability. */
const ocrEngineOf = (
  from: string[],
  recognize: (request: ConvertRequest) => Promise<string>
): MediaEngine => ({
  id: 'stub-ocr',
  converts: [
    {
      from,
      to: ['txt', 'hocr', 'json'],
      async convert(request) {
        const text = await recognize(request)
        return { outputs: [{ bytes: new TextEncoder().encode(text), mimeType: 'text/plain' }] }
      },
    },
  ],
})

describe('unified extract.text — format dispatch', () => {
  it('extracts the PDF text layer', async () => {
    const mp = await createMediaPipeline()
    const pdf = await loadMediaFixture('pure_text.pdf')
    const text = (await mp(pdf).extractText()) as string
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('extracts DOCX text via mammoth', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const text = (await mp(docx).extractText()) as string
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('extracts XLSX text with sheet headers', async () => {
    const mp = await createMediaPipeline()
    const xlsx = await loadMediaFixture('sample.xlsx')
    const text = (await mp(xlsx).extractText()) as string
    expect(text).toMatch(/^# /m)
  })

  it('extracts ODT/ODS text from ODF content.xml', async () => {
    const mp = await createMediaPipeline()
    const odt = await loadMediaFixture('sample.odt')
    const text = (await mp(odt).extractText()) as string
    expect(text.trim().length).toBeGreaterThan(0)
    const ods = await loadMediaFixture('sample.ods')
    const odsText = (await mp(ods).extractText()) as string
    expect(odsText.trim().length).toBeGreaterThan(0)
  })

  it('extracts PPTX slide text', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    const text = (await mp(pptx).extractText()) as string
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('extract text | chunk works end-to-end on a real document', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const chunks = (await mp(docx).extractText().chunk({ strategy: 'paragraph' })) as Array<{
      text: string
    }>
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('image input routes to OCR conversion; without a provider it is a do-not-retry failure', async () => {
    const mp = await createMediaPipeline()
    const png = await loadMediaFixture('sample_ocr.png')
    await expect(mp(png).extractText()).rejects.toThrow(/requires OCR/)
  })

  it('a stub OCR engine receives image bytes and its output is returned', async () => {
    const seen: string[] = []
    const stubOcr = ocrEngineOf(['image/*'], async (request) => {
      seen.push(request.mimeType)
      expect(request.to).toBe('txt')
      return 'OCR SAW THE IMAGE'
    })
    const mp = await createMediaPipeline({ engines: [stubOcr] })
    const png = await loadMediaFixture('sample_ocr.png')
    const text = (await mp(png).extractText()) as string
    expect(text).toBe('OCR SAW THE IMAGE')
    expect(seen).toEqual(['image/png'])
  })

  it('ocr=force routes ANY input through the OCR engine (frozen 0.8 escape hatch)', async () => {
    const stubOcr = ocrEngineOf(['image/*', 'application/pdf'], async () => 'FORCED')
    const mp = await createMediaPipeline({ engines: [stubOcr] })
    const pdf = await loadMediaFixture('pure_text.pdf')
    const text = (await mp(pdf).extractText({ ocr: 'force' })) as string
    expect(text).toBe('FORCED')
  })

  it('ocr_out is passed through as the convert target (hocr/json reachable per-request)', async () => {
    let sawTo: string | undefined
    const stubOcr = ocrEngineOf(['image/*'], async (request) => {
      sawTo = request.to
      return '<hocr/>'
    })
    const mp = await createMediaPipeline({ engines: [stubOcr] })
    const png = await loadMediaFixture('sample_ocr.png')
    await mp(png).extractText({ ocrOut: 'hocr' })
    expect(sawTo).toBe('hocr')
  })
})

describe('format-aware extract.metadata', () => {
  it('reports PDF page counts', async () => {
    const mp = await createMediaPipeline()
    const pdf = await loadMediaFixture('sample.pdf')
    const meta = (await mp(pdf).extractMetadata()) as { page_count: number; family: string }
    expect(meta.page_count).toBeGreaterThanOrEqual(1)
    expect(meta.family).toBe('document')
  })

  it('reports XLSX sheet inventory', async () => {
    const mp = await createMediaPipeline()
    const xlsx = await loadMediaFixture('rich.xlsx')
    const meta = (await mp(xlsx).extractMetadata()) as { sheets: Array<{ name: string }> }
    expect(meta.sheets.length).toBeGreaterThan(0)
  })

  it('reports PPTX slide counts', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    const meta = (await mp(pptx).extractMetadata()) as { slide_count: number }
    expect(meta.slide_count).toBeGreaterThanOrEqual(1)
  })
})
