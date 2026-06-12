import * as XLSX from 'xlsx'
import { default as ExcelJS } from 'exceljs'
import { describe, expect, it } from 'vitest'
import { createMediaPipeline, MIME } from '../../../../../src/batteries/media'
import { sheetjsEngine } from '../../../../../src/batteries/media/engines/sheetjs'
import { exceljsEngine } from '../../../../../src/batteries/media/engines/exceljs'
import { implementsMediaEngine, EMPTY_MIME } from '../../../../../src/batteries/media/contracts'
import type { StepPayload } from '../../../../../src/batteries/media'

/**
 * The sheetjs engine's cross-env proof: chromium/firefox/webkit and Node all mint, read, and
 * write through the same code path (no fixtures, no fs — everything in-memory).
 */

const engine = () => sheetjsEngine({ xlsx: () => XLSX })

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Mint a populated workbook in `bookType` via SheetJS itself. */
const makeSheet = (bookType: string, rows: unknown[][]): Uint8Array => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
  const out = XLSX.write(wb, { bookType: bookType as XLSX.BookType, type: 'array' }) as
    | ArrayBuffer
    | Uint8Array
  return ArrayBuffer.isView(out) ? out : new Uint8Array(out)
}

describe('sheetjs engine — contract + generation', () => {
  it('implements the MediaEngine contract', () => {
    expect(implementsMediaEngine(engine())).toBe(true)
  })

  it('empty→xlsx mints a workbook ExcelJS can open with one Sheet1', async () => {
    const result = await engine().converts![0].convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to: 'xlsx',
    })
    const wb = new ExcelJS.Workbook()
    const bytes = result.outputs[0].bytes
    await wb.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    )
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sheet1'])
  })

  it.each(['ods', 'csv', 'xls', 'xlsb', 'html'])('empty→%s yields non-empty output', async (to) => {
    const result = await engine().converts![0].convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to,
    })
    expect(result.outputs[0].bytes.length).toBeGreaterThan(0)
  })

  it('rejects an unwritable target with the supported list', async () => {
    await expect(
      engine().converts![0].convert({
        bytes: new Uint8Array(0),
        mimeType: EMPTY_MIME,
        filename: 'untitled',
        to: 'docx',
      })
    ).rejects.toThrow(/supported:/)
  })
})

describe('sheetjs engine — read matrix', () => {
  const ROWS = [
    ['a', 1],
    ['b', 2],
  ]

  it.each([
    ['ods', MIME.ODS],
    ['biff8', MIME.XLS],
    ['csv', MIME.CSV],
    ['xlsb', MIME.XLSB],
    ['sylk', MIME.SYLK],
    ['dif', MIME.DIF],
  ])('%s → xlsx round-trips cell values', async (bookType, mime) => {
    const input = makeSheet(bookType, ROWS)
    const result = await engine().converts![1].convert({
      bytes: input,
      mimeType: mime,
      filename: `data.${bookType}`,
      to: 'xlsx',
    })
    const back = XLSX.read(result.outputs[0].bytes)
    const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 })
    expect(rows).toEqual(ROWS)
  })

  it('xlsx → csv extracts the cells as text', async () => {
    const result = await engine().converts![1].convert({
      bytes: makeSheet('xlsx', ROWS),
      mimeType: MIME.XLSX,
      filename: 'data.xlsx',
      to: 'csv',
    })
    expect(decode(result.outputs[0].bytes).trim().split('\n')).toEqual(['a,1', 'b,2'])
  })

  it('xlsx → json emits the array-of-arrays table shape (same as soffice)', async () => {
    const result = await engine().converts![1].convert({
      bytes: makeSheet('xlsx', ROWS),
      mimeType: MIME.XLSX,
      filename: 'data.xlsx',
      to: 'json',
    })
    expect(JSON.parse(decode(result.outputs[0].bytes))).toEqual(ROWS)
    expect(result.outputs[0].mimeType).toBe(MIME.JSON)
  })

  it('numbers round-trips through the ZAHL payload', async () => {
    const minted = await engine().converts![0].convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to: 'numbers',
    })
    expect(minted.outputs[0].mimeType).toBe(MIME.NUMBERS)
    const back = XLSX.read(minted.outputs[0].bytes)
    expect(back.SheetNames.length).toBeGreaterThan(0)
  })
})

describe('sheetjs engine — edits (CE: structurally correct, styling stripped)', () => {
  it('sheet.update_cells on an unstyled workbook is value-correct', async () => {
    const result = await engine().edits![0].edit({
      bytes: makeSheet('xlsx', [['H'], ['x']]),
      mimeType: MIME.XLSX,
      op: 'sheet.update_cells',
      args: { updates: [{ address: 'A2', value: 'updated' }] },
    })
    const back = XLSX.read(result.bytes)
    const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 })
    expect(rows).toEqual([['H'], ['updated']])
    expect(result.summary?.modified).toBe(1)
  })

  it('edits ODS directly (the breadth exceljs cannot reach)', async () => {
    const result = await engine().edits![0].edit({
      bytes: makeSheet('ods', [['H'], ['x']]),
      mimeType: MIME.ODS,
      op: 'sheet.update_cells',
      args: { updates: [{ address: 'A2', value: 'from-ods' }] },
    })
    const back = XLSX.read(result.bytes)
    const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 })
    expect(rows).toEqual([['H'], ['from-ods']])
  })

  it('strips styling — asserted, not hidden (SheetJS CE contract)', async () => {
    // Build a styled workbook with ExcelJS, edit through sheetjs, reload: fill is gone.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Styled')
    ws.getCell('A1').value = 'Header'
    ws.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' },
    }
    const styled = new Uint8Array(await wb.xlsx.writeBuffer())
    const result = await engine().edits![0].edit({
      bytes: styled,
      mimeType: MIME.XLSX,
      op: 'sheet.update_cells',
      args: { updates: [{ address: 'A2', value: 'x' }] },
    })
    const reloaded = new ExcelJS.Workbook()
    await reloaded.xlsx.load(
      result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength
      ) as ArrayBuffer
    )
    const cell = reloaded.worksheets[0].getCell('A1')
    expect(cell.value).toBe('Header') // values survive
    expect(cell.fill?.type === 'pattern' && cell.fill.fgColor?.argb).not.toBe('FFFFFF00') // styling does not
  })
})

describe('sheetjs engine — through the pipeline', () => {
  it('empty:xlsx | sheet.update_cells | convert to=csv — create→populate→extract, no binary', async () => {
    const mp = await createMediaPipeline({ engines: [engine(), exceljsEngine()] })
    const minted = await mp.capabilities.convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to: 'xlsx',
    })
    const payload: StepPayload = {
      bytes: minted.outputs[0].bytes,
      mimeType: minted.outputs[0].mimeType,
      filename: 'untitled.xlsx',
    }
    const result = await mp.query(
      payload,
      `sheet update_cells updates='[{"address":"A1","value":"Title"},{"address":"A2","value":42}]' | convert to=csv`
    )
    expect(result.kind).toBe('media')
    const text = decode((result as { payload: StepPayload }).payload.bytes)
    expect(text.trim().split('\n')).toEqual(['Title', '42'])
  })

  it('ODS flows through the generalized sheet normalize path into an edit', async () => {
    const mp = await createMediaPipeline({ engines: [exceljsEngine(), engine()] })
    const payload: StepPayload = {
      bytes: makeSheet('ods', [['H'], ['x']]),
      mimeType: MIME.ODS,
      filename: 'data.ods',
    }
    const result = await mp.query(
      payload,
      `sheet update_cells updates='[{"address":"A2","value":"normalized"}]'`
    )
    expect(result.kind).toBe('media')
    const back = XLSX.read((result as { payload: StepPayload }).payload.bytes)
    const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 })
    expect(rows).toEqual([['H'], ['normalized']])
  })
})
