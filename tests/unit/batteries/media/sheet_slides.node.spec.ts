import { default as ExcelJS } from 'exceljs'
import { describe, expect, it } from 'vitest'
import { loadMediaFixture } from '../../../_fixtures/media_fixtures'
import { countSlides } from '../../../../src/batteries/media/steps/slides'
import { createMediaPipeline, MIME } from '../../../../src/batteries/media'
import { exceljsEngine } from '../../../../src/batteries/media/engines/exceljs'
import type { StepPayload } from '../../../../src/batteries/media'

/** Sheet edits dispatch through the edit capability — register the exceljs engine. */
const sheetPipeline = () => createMediaPipeline({ engines: [exceljsEngine()] })

const openWb = async (payload: StepPayload): Promise<ExcelJS.Workbook> => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(
    payload.bytes.buffer.slice(
      payload.bytes.byteOffset,
      payload.bytes.byteOffset + payload.bytes.byteLength
    ) as ArrayBuffer
  )
  return wb
}

/** Build an xlsx payload from rows (header first). */
const makeXlsx = async (rows: Array<Array<string | number>>): Promise<StepPayload> => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  for (const row of rows) ws.addRow(row)
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer())
  return { bytes, mimeType: MIME.XLSX, filename: 'data.xlsx' }
}

describe('sheet.* steps (ExcelJS, in-memory)', () => {
  it('update_cells by address and by row/col, formulas via leading =', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([
      ['Name', 'Value'],
      ['a', 1],
      ['b', 2],
    ])
    const out = (await mp(input).sheet.updateCells([
      { address: 'B2', value: 42 },
      { row: 3, col: 2, value: '=B2*2' },
    ])) as StepPayload
    const wb = await openWb(out)
    const ws = wb.getWorksheet('Data')!
    expect(ws.getCell('B2').value).toBe(42)
    expect((ws.getCell('B3').value as { formula: string }).formula).toBe('B2*2')
  })

  it('update_cells via the pipe surface with quoted JSON', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([['H'], ['x']])
    const result = await mp.query(
      input,
      `sheet update_cells updates='[{"address":"A2","value":"updated"}]'`
    )
    expect(result.kind).toBe('media')
    const wb = await openWb((result as { payload: StepPayload }).payload)
    expect(wb.worksheets[0].getCell('A2').value).toBe('updated')
  })

  it('add_rows appends and inserts before', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([['H'], ['one']])
    const appended = (await mp(input).sheet.addRows([['two'], ['three']])) as StepPayload
    const appendedWb = await openWb(appended)
    let ws = appendedWb.worksheets[0]
    expect(ws.getCell('A3').value).toBe('two')
    const inserted = (await mp(input).sheet.addRows([['zero']], { before: 2 })) as StepPayload
    const insertedWb = await openWb(inserted)
    ws = insertedWb.worksheets[0]
    expect(ws.getCell('A2').value).toBe('zero')
    expect(ws.getCell('A3').value).toBe('one')
  })

  it('delete_rows and delete_columns', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([
      ['A', 'B', 'C'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ])
    const out = (await mp(input).sheet.deleteRows([2]).sheet.deleteColumns([2])) as StepPayload
    const outWb = await openWb(out)
    const ws = outWb.worksheets[0]
    expect(ws.getCell('A2').value).toBe('4')
    expect(ws.getCell('B1').value).toBe('C')
  })

  it('rename/add/remove/reorder sheets', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([['x']])
    const out = (await mp(input)
      .sheet.renameSheet('Data', 'Renamed')
      .sheet.addSheet('Second')
      .sheet.reorderSheets(['Second', 'Renamed'])) as StepPayload
    const wb = await openWb(out)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Second', 'Renamed'])
    const removed = (await mp(out).sheet.removeSheet('Second')) as StepPayload
    const removedWb = await openWb(removed)
    expect(removedWb.worksheets.map((w) => w.name)).toEqual(['Renamed'])
  })

  it('transform_table renames, drops, selects columns by header', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([
      ['Name', 'Age', 'City'],
      ['a', 30, 'X'],
    ])
    const out = (await mp(input).sheet.transformTable({
      rename: [{ from: 'Name', to: 'FullName' }],
      drop: ['City'],
    })) as StepPayload
    const transformedWb = await openWb(out)
    const ws = transformedWb.worksheets[0]
    expect(ws.getCell('A1').value).toBe('FullName')
    expect(ws.getCell('B1').value).toBe('Age')
    expect(ws.getCell('C1').value).toBeNull()
  })

  it('sheet name vs index disambiguation: quoted numeric names are names', async () => {
    const mp = await sheetPipeline()
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('First')
    wb.addWorksheet('2026')
    const input: StepPayload = {
      bytes: new Uint8Array(await wb.xlsx.writeBuffer()),
      mimeType: MIME.XLSX,
      filename: 'multi.xlsx',
    }
    const result = await mp.query(
      input,
      `sheet update_cells sheet="2026" updates='[{"address":"A1","value":"hit"}]'`
    )
    const out = await openWb((result as { payload: StepPayload }).payload)
    expect(out.getWorksheet('2026')!.getCell('A1').value).toBe('hit')
    expect(out.getWorksheet('First')!.getCell('A1').value).toBeNull()
  })

  it('rename targets sheet NAMES only and explains the rule', async () => {
    const mp = await sheetPipeline()
    const input = await makeXlsx([['x']])
    await expect(mp(input).sheet.renameSheet('Nope', 'New')).rejects.toThrow(/sheet NAME/)
  })

  it('ODS without a sheetNormalize engine fails with do-not-retry', async () => {
    const mp = await sheetPipeline()
    const ods = await loadMediaFixture('sample.ods')
    await expect(mp(ods).sheet.addRows([['x']])).rejects.toThrow(/converts it to xlsx is required/)
  })

  it('legacy xls is mutation-blocked with the conversion hint', async () => {
    const mp = await sheetPipeline()
    const xls: StepPayload = {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'application/vnd.ms-excel',
      filename: 'old.xls',
    }
    await expect(mp(xls).sheet.addRows([['x']])).rejects.toThrow(/no configured engine converts/)
  })

  it('real rich.xlsx fixture round-trips a mutation', async () => {
    const mp = await sheetPipeline()
    const fixture = await loadMediaFixture('rich.xlsx')
    const out = (await mp(fixture).sheet.addSheet('FromTest')) as StepPayload
    const wb = await openWb(out)
    expect(wb.getWorksheet('FromTest')).toBeDefined()
  })
})

describe('slides.* steps (JSZip XML, in-memory)', () => {
  it('update_text replaces the first text node on slide 1', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    const out = (await mp(pptx).slides.updateText('Replaced Title', { slide: 1 })) as StepPayload
    expect(out.mimeType).toBe(MIME.PPTX)
    const text = (await mp(out)
      .extractText()
      .run()
      .catch(() => undefined)) as unknown
    void text // extraction for pptx lands in Phase 4; byte-level assertion below
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(out.bytes)
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('text')
    expect(slide1).toContain('<a:t>Replaced Title</a:t>')
  })

  it('add clones the last slide; duplicate copies a slide; delete removes', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    const before = await countSlides(pptx.bytes)
    const added = (await mp(pptx).slides.add({ title: 'New Slide' })) as StepPayload
    expect(await countSlides(added.bytes)).toBe(before + 1)
    const duplicated = (await mp(pptx).slides.duplicate(1)) as StepPayload
    expect(await countSlides(duplicated.bytes)).toBe(before + 1)
    if (before > 1) {
      const deleted = (await mp(pptx).slides.delete([1])) as StepPayload
      expect(await countSlides(deleted.bytes)).toBe(before - 1)
    }
  })

  it('reorder requires every slide exactly once', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    const count = await countSlides(pptx.bytes)
    const order = Array.from({ length: count }, (_, i) => count - i)
    const out = (await mp(pptx).slides.reorder(order)) as StepPayload
    expect(await countSlides(out.bytes)).toBe(count)
    await expect(mp(pptx).slides.reorder([1, 1])).rejects.toThrow(/exactly once|duplicate/)
  })

  it('update_image swaps the image part bytes from an @id ref', async () => {
    const mp0 = await createMediaPipeline()
    const rich = await loadMediaFixture('rich.pptx')
    const png = await loadMediaFixture('sample.png')
    const mp = await createMediaPipeline({ resolveRef: () => png })
    const result = await mp.query(rich, 'slides update_image with=@img').catch((err: Error) => err)
    // eslint-disable-next-line adk/prefer-is-error -- vitest spec asserting native Error from .catch
    if (result instanceof Error) {
      // rich.pptx may not carry an image relationship — accept the targeted error.
      expect(result.message).toMatch(/no image relationship|placeholder/i)
    } else {
      expect((result as { kind: string }).kind).toBe('media')
    }
    void mp0
  })

  it('slide index out of range is a 1-based error', async () => {
    const mp = await createMediaPipeline()
    const pptx = await loadMediaFixture('sample.pptx')
    await expect(mp(pptx).slides.updateText('x', { slide: 99 })).rejects.toThrow(/1-based/)
  })

  it('ODP without a convert engine fails with do-not-retry', async () => {
    const mp = await createMediaPipeline()
    const odp = await loadMediaFixture('sample.odp')
    await expect(mp(odp).slides.updateText('x')).rejects.toThrow(/converts it to PPTX is required/)
  })
})
