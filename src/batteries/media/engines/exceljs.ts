/**
 * The ExcelJS-backed workbook {@link @nhtio/adk/batteries/media/contracts!MediaEngine}: the
 * fidelity-preserving structural editor for xlsx, plus in-process blank-workbook generation.
 *
 * @module @nhtio/adk/batteries/media/engines/exceljs
 *
 * @remarks
 * ExcelJS models the parts of a workbook that matter to humans — fonts, fills, comments,
 * merged ranges, data validations — and carries them through a read→edit→write cycle intact.
 * That is this engine's whole reason to exist: the `sheet.*` verbs mutate workbooks users
 * hand us, and an edit that strips the user's formatting as a side effect is corruption with
 * good intentions. Compose this engine FIRST in the engines array when fidelity matters; the
 * sheetjs engine edits a far wider read matrix (ODS, XLS, NUMBERS, …) but SheetJS Community
 * Edition strips styling in the process.
 *
 * Capabilities:
 *
 * - **generate**: `EMPTY_MIME` → xlsx (a blank workbook with one `Sheet1` — every sheet step
 *   expects at least one worksheet).
 * - **edit**: the ten `sheet.*` structural ops over xlsx, styling preserved.
 *
 * `exceljs` is an optional peer dependency, lazily imported on first actual use. Cross-env by
 * construction: no `node:*` imports, `Uint8Array` in and out (ExcelJS ships a browser build
 * via its `browser` field).
 */

import { MIME } from '../formats'
import { EMPTY_MIME } from '../contracts'
import { isError } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { default as ExcelJSNS } from 'exceljs'
import type {
  MediaEngine,
  ConvertRequest,
  ConvertResult,
  EditRequest,
  EditResult,
  EditSummary,
} from '../contracts'

type ExcelJSModule = typeof ExcelJSNS

/** Options for {@link exceljsEngine}. */
export interface ExceljsEngineOptions {
  /** Override the module resolution (tests / custom builds). Default: `import('exceljs')`. */
  exceljs?: () => ExcelJSModule | Promise<ExcelJSModule>
}

/** The structural ops this engine edits (same names the verb table uses). */
const SHEET_OPS: readonly string[] = [
  'sheet.add_rows',
  'sheet.add_columns',
  'sheet.update_cells',
  'sheet.delete_rows',
  'sheet.delete_columns',
  'sheet.rename_sheet',
  'sheet.add_sheet',
  'sheet.remove_sheet',
  'sheet.reorder_sheets',
  'sheet.transform_table',
]

/**
 * Construct the ExcelJS-backed workbook engine.
 *
 * @param options - Optional module resolver override.
 * @returns The engine.
 */
export const exceljsEngine = (options: ExceljsEngineOptions = {}): MediaEngine => {
  let modPromise: Promise<ExcelJSModule> | undefined
  const getExcel = (): Promise<ExcelJSModule> => {
    modPromise ??= Promise.resolve(
      options.exceljs
        ? options.exceljs()
        : import('exceljs').then((m) => ('default' in m ? m.default : m) as ExcelJSModule)
    ).catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `the exceljs engine could not load its peer dependency "exceljs": ${detail} — install it (pnpm add exceljs)`,
      ])
    })
    return modPromise
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    if (request.to !== 'xlsx') {
      throw new Error(`exceljs generates "xlsx" only; requested "${request.to}"`)
    }
    const ExcelJS = await getExcel()
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Sheet1')
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer())
    return { outputs: [{ bytes, mimeType: MIME.XLSX }] }
  }

  const edit = async (request: EditRequest): Promise<EditResult> => {
    const ExcelJS = await getExcel()
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(
        request.bytes.buffer.slice(
          request.bytes.byteOffset,
          request.bytes.byteOffset + request.bytes.byteLength
        ) as ArrayBuffer
      )
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new Error(`could not open the spreadsheet: ${detail}`)
    }
    const summary = applyEdit(wb, request.op, request.args)
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer())
    return { bytes, mimeType: MIME.XLSX, summary }
  }

  return {
    id: 'exceljs',
    converts: [{ from: [EMPTY_MIME], to: ['xlsx'], convert }],
    edits: [{ over: [MIME.XLSX], ops: SHEET_OPS, edit }],
  }
}

// ── op implementations (moved from steps/sheet.ts; styling-preserving by library) ───────────

/** Resolve the target worksheet from the frozen `sheet=` rule (bare number=index, string=name). */
const resolveSheet = (wb: ExcelJSNS.Workbook, sheetArg: unknown): ExcelJSNS.Worksheet => {
  if (sheetArg === undefined || sheetArg === null) {
    const first = wb.worksheets[0]
    if (!first) throw new Error('the workbook has no worksheets')
    return first
  }
  // Frozen 0.11: bare number targets by 1-based index; quoted string targets by name.
  if (typeof sheetArg === 'number') {
    const byIndex = wb.worksheets[sheetArg - 1]
    if (byIndex) return byIndex
    const byName = wb.getWorksheet(String(sheetArg))
    if (byName) {
      throw new Error(
        `no sheet at index ${sheetArg}, but a sheet NAMED "${sheetArg}" exists — quote it: sheet="${sheetArg}"`
      )
    }
    throw new Error(
      `sheet index ${sheetArg} is out of range (1-based; the workbook has ${wb.worksheets.length})`
    )
  }
  const ws = wb.getWorksheet(sheetArg as string)
  if (!ws) {
    const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
    throw new Error(`no sheet named "${String(sheetArg)}". Sheets: ${names}`)
  }
  return ws
}

const columnLetterToNumber = (col: string): number => {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

type CellValue = string | number | boolean | null

const asCellValue = (value: unknown): ExcelJSNS.CellValue => {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`cell values must be string, number, boolean, or null; got ${typeof value}`)
}

/** Apply one structural op to the workbook in place; returns the change summary. */
const applyEdit = (
  wb: ExcelJSNS.Workbook,
  op: string,
  args: Record<string, unknown>
): EditSummary => {
  switch (op) {
    case 'sheet.add_rows': {
      const rows = args.rows
      if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) {
        throw new Error(`rows must be a non-empty JSON array of arrays, e.g. rows='[["a",1]]'`)
      }
      const before = args.before as number | undefined
      const after = args.after as number | undefined
      const ws = resolveSheet(wb, args.sheet)
      const insertAt =
        before !== undefined ? before : after !== undefined ? after + 1 : ws.rowCount + 1
      const cellRows = (rows as unknown[][]).map((r) => r.map(asCellValue))
      ws.spliceRows(insertAt, 0, ...cellRows)
      return { added: cellRows.length }
    }
    case 'sheet.add_columns': {
      const headers = args.headers as string[] | undefined
      const columns: Array<{ header: string; values?: CellValue[] }> | undefined =
        (args.columns as Array<{ header: string; values?: CellValue[] }> | undefined) ??
        headers?.map((header) => ({ header }) as { header: string; values?: CellValue[] })
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new Error(`provide headers=a,b or columns='[{"header":"X","values":[1]}]'`)
      }
      const before = args.before as number | undefined
      const after = args.after as number | undefined
      const ws = resolveSheet(wb, args.sheet)
      const insertAt =
        before !== undefined ? before : after !== undefined ? after + 1 : ws.columnCount + 1
      for (const [i, col] of columns.entries()) {
        if (typeof col?.header !== 'string') throw new Error('every column needs a string header')
        ws.spliceColumns(insertAt + i, 0, [col.header, ...(col.values ?? []).map(asCellValue)])
      }
      return { added: columns.length }
    }
    case 'sheet.update_cells': {
      const updates = args.updates
      if (!Array.isArray(updates) || updates.length === 0) {
        throw new Error(
          `updates must be a non-empty JSON array, e.g. updates='[{"address":"B2","value":3}]'`
        )
      }
      const ws = resolveSheet(wb, args.sheet)
      let modified = 0
      for (const raw of updates as Array<Record<string, unknown>>) {
        const address = raw.address as string | undefined
        const row = raw.row as number | undefined
        const col = raw.col as number | string | undefined
        let cell: ExcelJSNS.Cell
        if (address) {
          cell = ws.getCell(address)
        } else if (row !== undefined && col !== undefined) {
          cell =
            typeof col === 'string'
              ? ws.getCell(row, columnLetterToNumber(col))
              : ws.getCell(row, col)
        } else {
          throw new Error('each update needs address, or both row and col')
        }
        const value = raw.value
        if (typeof value === 'string' && value.startsWith('=')) {
          cell.value = { formula: value.slice(1) } as ExcelJSNS.CellValue
        } else {
          cell.value = asCellValue(value)
        }
        modified += 1
      }
      return { modified }
    }
    case 'sheet.delete_rows': {
      const rows = args.rows as number[]
      const ws = resolveSheet(wb, args.sheet)
      for (const r of [...rows].sort((a, b) => b - a)) ws.spliceRows(r, 1)
      return { removed: rows.length }
    }
    case 'sheet.delete_columns': {
      const columns = args.columns as number[]
      const ws = resolveSheet(wb, args.sheet)
      for (const c of [...columns].sort((a, b) => b - a)) ws.spliceColumns(c, 1)
      return { removed: columns.length }
    }
    case 'sheet.rename_sheet': {
      const sheet = args.sheet as string
      const to = args.to as string
      const ws = wb.getWorksheet(sheet)
      if (!ws) {
        const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
        throw new Error(`rename targets a sheet NAME; no sheet named "${sheet}". Sheets: ${names}`)
      }
      ws.name = to
      return { modified: 1 }
    }
    case 'sheet.add_sheet': {
      const name = args.name as string
      const at = args.at as number | undefined
      if (wb.getWorksheet(name)) throw new Error(`a sheet named "${name}" already exists`)
      const ws = wb.addWorksheet(name)
      if (at !== undefined) {
        const all = wb.worksheets
        const wsIdx = all.indexOf(ws)
        if (wsIdx !== at - 1) {
          all.forEach((w, i) => {
            ;(w as unknown as { orderNo: number }).orderNo =
              w === ws ? at : i + 1 >= at && i < wsIdx ? i + 2 : i + 1
          })
        }
      }
      return { added: 1 }
    }
    case 'sheet.remove_sheet': {
      const sheet = args.sheet as string
      const ws = wb.getWorksheet(sheet)
      if (!ws) {
        const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
        throw new Error(`remove targets a sheet NAME; no sheet named "${sheet}". Sheets: ${names}`)
      }
      wb.removeWorksheet(ws.id)
      return { removed: 1 }
    }
    case 'sheet.reorder_sheets': {
      const order = args.order
      if (!Array.isArray(order) || order.length === 0) {
        throw new Error(`order must be a JSON array of names/indices, e.g. order='["Summary",2]'`)
      }
      const refs = order as Array<string | number>
      if (refs.length !== wb.worksheets.length) {
        throw new Error(
          `order must include every worksheet exactly once (the workbook has ${wb.worksheets.length})`
        )
      }
      const reordered: ExcelJSNS.Worksheet[] = []
      const seen = new Set<number>()
      for (const ref of refs) {
        const ws = typeof ref === 'number' ? wb.worksheets[ref - 1] : wb.getWorksheet(ref)
        if (!ws) throw new Error(`sheet not found: ${String(ref)}`)
        if (seen.has(ws.id)) throw new Error(`duplicate sheet reference: ${String(ref)}`)
        seen.add(ws.id)
        reordered.push(ws)
      }
      // ExcelJS serializes by orderNo; the worksheets getter returns a sorted clone.
      reordered.forEach((ws, i) => {
        ;(ws as unknown as { orderNo: number }).orderNo = i + 1
      })
      return { modified: reordered.length }
    }
    case 'sheet.transform_table': {
      const headerRow = (args.header_row as number | undefined) ?? 1
      const rename = args.rename as Array<{ from: string; to: string }> | undefined
      const select = args.select as string[] | undefined
      const drop = args.drop as string[] | undefined
      const ws = resolveSheet(wb, args.sheet)
      let modified = 0
      const headerMap = new Map<string, number>()
      ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (typeof cell.value === 'string') headerMap.set(cell.value, colNumber)
      })
      if (rename) {
        for (const { from, to } of rename) {
          const colNum = headerMap.get(from)
          if (colNum !== undefined) {
            ws.getRow(headerRow).getCell(colNum).value = to
            headerMap.delete(from)
            headerMap.set(to, colNum)
            modified += 1
          }
        }
      }
      if (drop) {
        const cols = drop
          .map((name) => headerMap.get(name))
          .filter((n): n is number => n !== undefined)
          .sort((a, b) => b - a)
        for (const col of cols) {
          ws.spliceColumns(col, 1)
          modified += 1
        }
      }
      if (select) {
        const keep = new Set(select)
        const cols: number[] = []
        ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (typeof cell.value === 'string' && !keep.has(cell.value)) cols.push(colNumber)
        })
        cols.sort((a, b) => b - a)
        for (const col of cols) {
          ws.spliceColumns(col, 1)
          modified += 1
        }
      }
      return { modified }
    }
    default:
      throw new Error(`exceljs does not implement edit op "${op}"`)
  }
}
