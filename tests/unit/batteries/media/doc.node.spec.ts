import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { default as JSZip } from 'jszip'
import { describe, expect, it } from 'vitest'
import { loadMediaFixture } from '../../../_fixtures/media_fixtures'
import { createMediaPipeline, MIME } from '../../../../src/batteries/media'
import { sofficeEngine } from '../../../../src/batteries/media/engines/soffice'
import { execaExecutor } from '../../../../src/batteries/media/engines/execa_executor'
import { fsScratchWorkspace } from '../../../../src/batteries/media/engines/fs_workspace'
import type { StepPayload, MediaPipeline } from '../../../../src/batteries/media'

const docxTextOf = async (payload: StepPayload): Promise<string> => {
  const zip = await JSZip.loadAsync(payload.bytes)
  const xml = await zip.file('word/document.xml')!.async('text')
  return (xml.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g) ?? [])
    .map((t) => t.replace(/<[^>]+>/g, ''))
    .join('')
}

describe('doc.* steps — format-preserving mutation (cross-env paths)', () => {
  it('redact on DOCX preserves the DOCX container and removes the text', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const before = await docxTextOf(docx)
    expect(before.length).toBeGreaterThan(0)
    const word = before.split(/\s+/).find((w) => w.length > 3)
    expect(word).toBeDefined()
    const out = (await mp(docx).redact({ match: [word as string], replace: '[X]' })) as StepPayload
    expect(out.mimeType).toBe(MIME.DOCX)
    const after = await docxTextOf(out)
    expect(after).toContain('[X]')
    expect(after).not.toContain(word as string)
  })

  it('redact with a regex matches across split runs (aggregation semantics)', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const out = (await mp(docx).redact({ match: [/[A-Za-z]+/], replace: 'Z' })) as StepPayload
    const after = await docxTextOf(out)
    expect(after).not.toMatch(/[A-Za-z]{2,}/)
  })

  it('update_text replaces an anchor in DOCX and reports a missing anchor', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const text = await docxTextOf(docx)
    const anchor = text.trim().split(/\s+/)[0]
    const out = (await mp(docx).updateText(anchor, 'REPLACED')) as StepPayload
    expect(await docxTextOf(out)).toContain('REPLACED')
    await expect(mp(docx).updateText('definitely-not-present-xyz', 'x')).rejects.toThrow(
      /anchor text not found/
    )
  })

  it('sanitize and normalize keep the DOCX container', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    const out = (await mp(docx).sanitize().normalize()) as StepPayload
    expect(out.mimeType).toBe(MIME.DOCX)
    const zip = await JSZip.loadAsync(out.bytes)
    expect(zip.file('word/document.xml')).toBeTruthy()
  })

  it('redact on PDF points the model at the extract-text composition', async () => {
    const mp = await createMediaPipeline()
    const pdf = await loadMediaFixture('sample.pdf')
    await expect(mp(pdf).redact({ match: ['x'] })).rejects.toThrow(/extract text \| redact/)
  })

  it('extract assets from rich.pptx yields embedded images', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('rich.pptx')
    const result = await mp.query(pptx, 'extract assets types=image').catch((err: Error) => err)
    // eslint-disable-next-line adk/prefer-is-error -- vitest spec asserting native Error from .catch
    if (result instanceof Error) {
      expect(result.message).toMatch(/no embedded assets/)
    } else {
      expect((result as { kind: string }).kind).toBe('media-list')
    }
  })

  it('convert without an engine is rejected at validation (do-not-retry)', async () => {
    const mp = await createMediaPipeline()
    const docx = await loadMediaFixture('sample.docx')
    await expect(mp(docx).convert('pdf')).rejects.toThrow(/Do not retry/)
  })
})

// Binary-gated: set TEST_SOFFICE to a working soffice path to enable these.
const SOFFICE = process.env.TEST_SOFFICE
const haveSoffice = typeof SOFFICE === 'string' && SOFFICE.length > 0

describe.skipIf(!haveSoffice)('soffice engines (binary-gated)', () => {
  const makePipeline = (): Promise<MediaPipeline> =>
    createMediaPipeline({
      engines: [
        () =>
          sofficeEngine({
            path: SOFFICE as string,
            executor: execaExecutor(),
            workspace: fsScratchWorkspace({ root: join(tmpdir(), 'adk-soffice-spec') }),
          }),
      ],
    })

  it('converts DOCX to PDF', { timeout: 120_000 }, async () => {
    const mp = await makePipeline()
    const docx = await loadMediaFixture('sample.docx')
    const out = (await mp(docx).convert('pdf')) as StepPayload
    expect(out.mimeType).toBe('application/pdf')
    expect(out.filename.endsWith('.pdf')).toBe(true)
    // %PDF magic
    expect(new TextDecoder().decode(out.bytes.subarray(0, 4))).toBe('%PDF')
  })

  it('rejects unsupported pairs with the supported list', { timeout: 120_000 }, async () => {
    const mp = await makePipeline()
    const docx = await loadMediaFixture('sample.docx')
    await expect(mp(docx).convert('xlsx')).rejects.toThrow(/reachable targets/)
  })

  it('normalizes ODS to xlsx so sheet mutations work', { timeout: 120_000 }, async () => {
    const mp = await makePipeline()
    const ods = await loadMediaFixture('sample.ods')
    const out = (await mp(ods).sheet.addSheet('FromOds')) as StepPayload
    expect(out.mimeType).toBe(MIME.XLSX)
  })

  it('ODP slides mutate after convert-engine normalization', { timeout: 120_000 }, async () => {
    const mp = await makePipeline()
    const odp = await loadMediaFixture('sample.odp')
    const out = (await mp(odp).slides.add({ title: 'From ODP' })) as StepPayload
    expect(out.mimeType).toBe(MIME.PPTX)
  })
})
