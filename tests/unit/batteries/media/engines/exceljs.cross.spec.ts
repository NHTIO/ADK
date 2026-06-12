import { default as ExcelJS } from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildEngineRegistry, MIME } from '../../../../../src/batteries/media'
import { exceljsEngine } from '../../../../../src/batteries/media/engines/exceljs'
import { sheetjsEngine } from '../../../../../src/batteries/media/engines/sheetjs'
import { implementsMediaEngine, EMPTY_MIME } from '../../../../../src/batteries/media/contracts'

/**
 * The exceljs engine's specs: blank-workbook generation, every sheet.* op through
 * registry.edit, and THE fidelity pin — the test that justifies this engine's existence
 * alongside sheetjs (edits must preserve the styling they don't touch).
 */

const engine = () => exceljsEngine({ exceljs: () => ExcelJS })

const openWb = async (bytes: Uint8Array): Promise<ExcelJS.Workbook> => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  )
  return wb
}

const makeXlsx = async (rows: Array<Array<string | number>>): Promise<Uint8Array> => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  for (const row of rows) ws.addRow(row)
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

const edit = async (
  bytes: Uint8Array,
  op: string,
  args: Record<string, unknown>
): Promise<Uint8Array> => {
  const result = await engine().edits![0].edit({ bytes, mimeType: MIME.XLSX, op, args })
  return result.bytes
}

describe('exceljs engine — contract + generation', () => {
  it('implements the MediaEngine contract', () => {
    expect(implementsMediaEngine(engine())).toBe(true)
  })

  it('empty→xlsx mints a blank workbook with one Sheet1', async () => {
    const result = await engine().converts![0].convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to: 'xlsx',
    })
    const wb = await openWb(result.outputs[0].bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sheet1'])
  })

  it('rejects non-xlsx generation targets', async () => {
    await expect(
      engine().converts![0].convert({
        bytes: new Uint8Array(0),
        mimeType: EMPTY_MIME,
        filename: 'untitled',
        to: 'ods',
      })
    ).rejects.toThrow(/"xlsx" only/)
  })
})

describe('exceljs engine — every sheet.* op through edit()', () => {
  it('add_rows / delete_rows', async () => {
    let bytes = await makeXlsx([['H'], ['one']])
    bytes = await edit(bytes, 'sheet.add_rows', { rows: [['two'], ['three']] })
    let wb = await openWb(bytes)
    expect(wb.worksheets[0].getCell('A3').value).toBe('two')
    bytes = await edit(bytes, 'sheet.delete_rows', { rows: [2] })
    wb = await openWb(bytes)
    expect(wb.worksheets[0].getCell('A2').value).toBe('two')
  })

  it('add_columns / delete_columns', async () => {
    let bytes = await makeXlsx([
      ['A', 'B'],
      ['1', '2'],
    ])
    bytes = await edit(bytes, 'sheet.add_columns', {
      columns: [{ header: 'C', values: ['3'] }],
    })
    let wb = await openWb(bytes)
    expect(wb.worksheets[0].getCell('C1').value).toBe('C')
    bytes = await edit(bytes, 'sheet.delete_columns', { columns: [2] })
    wb = await openWb(bytes)
    expect(wb.worksheets[0].getCell('B1').value).toBe('C')
  })

  it('update_cells with formulas via leading =', async () => {
    const bytes = await edit(
      await makeXlsx([
        ['Name', 'Value'],
        ['a', 1],
      ]),
      'sheet.update_cells',
      {
        updates: [
          { address: 'B2', value: 42 },
          { row: 3, col: 2, value: '=B2*2' },
        ],
      }
    )
    const wb = await openWb(bytes)
    expect(wb.worksheets[0].getCell('B2').value).toBe(42)
    expect((wb.worksheets[0].getCell('B3').value as { formula: string }).formula).toBe('B2*2')
  })

  it('rename/add/remove/reorder sheets + transform_table', async () => {
    let bytes = await makeXlsx([
      ['Name', 'Age', 'City'],
      ['a', 30, 'X'],
    ])
    bytes = await edit(bytes, 'sheet.rename_sheet', { sheet: 'Data', to: 'Renamed' })
    bytes = await edit(bytes, 'sheet.add_sheet', { name: 'Second' })
    bytes = await edit(bytes, 'sheet.reorder_sheets', { order: ['Second', 'Renamed'] })
    let wb = await openWb(bytes)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Second', 'Renamed'])
    bytes = await edit(bytes, 'sheet.remove_sheet', { sheet: 'Second' })
    bytes = await edit(bytes, 'sheet.transform_table', {
      sheet: 'Renamed',
      rename: [{ from: 'Name', to: 'FullName' }],
      drop: ['City'],
    })
    wb = await openWb(bytes)
    const ws = wb.getWorksheet('Renamed')!
    expect(ws.getCell('A1').value).toBe('FullName')
    expect(ws.getCell('C1').value).toBeNull()
  })

  it('unknown op fails readably', async () => {
    await expect(edit(await makeXlsx([['x']]), 'sheet.nope', {})).rejects.toThrow(
      /does not implement edit op/
    )
  })
})

describe('exceljs engine — THE fidelity pin', () => {
  it('an edit preserves bold/fill/comment/formula it did not touch', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Styled')
    ws.getCell('A1').value = 'Header'
    ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
    ws.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' },
    }
    ws.getCell('A2').value = 2
    ws.getCell('A2').note = 'a comment'
    ws.getCell('A3').value = { formula: 'A2*2' } as ExcelJS.CellValue
    const styled = new Uint8Array(await wb.xlsx.writeBuffer())

    const bytes = await edit(styled, 'sheet.update_cells', {
      updates: [{ address: 'B1', value: 'untouched-cell-edit' }],
    })
    const reloaded = await openWb(bytes)
    const s = reloaded.getWorksheet('Styled')!
    expect(s.getCell('A1').font?.bold).toBe(true)
    expect(
      s.getCell('A1').fill?.type === 'pattern' &&
        (s.getCell('A1').fill as ExcelJS.FillPattern).fgColor?.argb
    ).toBe('FFFFFF00')
    expect(s.getCell('A2').note).toBe('a comment')
    expect((s.getCell('A3').value as { formula: string }).formula).toBe('A2*2')
    expect(s.getCell('B1').value).toBe('untouched-cell-edit')
  })
})

describe('engine arbitration — supply order picks the editor', () => {
  it('exceljs-first wins the xlsx edit over sheetjs', async () => {
    const registry = buildEngineRegistry([engine(), sheetjsEngine()])
    // Styled fixture: if exceljs serves the edit, the fill survives.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.getCell('A1').value = 'x'
    ws.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' },
    }
    const styled = new Uint8Array(await wb.xlsx.writeBuffer())
    const result = await registry.edit({
      bytes: styled,
      mimeType: MIME.XLSX,
      op: 'sheet.update_cells',
      args: { updates: [{ address: 'B1', value: 'y' }] },
    })
    const reloaded = await openWb(result.bytes)
    expect(
      reloaded.worksheets[0].getCell('A1').fill?.type === 'pattern' &&
        (reloaded.worksheets[0].getCell('A1').fill as ExcelJS.FillPattern).fgColor?.argb
    ).toBe('FFFFFF00')
  })
})
