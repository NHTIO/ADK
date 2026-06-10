/**
 * `sheet.*` step implementations: ExcelJS workbook mutations on in-memory bytes.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Ported from the source server's
 * sheet adapters (its green e2e suite informs the spec coverage). All ten mutations operate on
 * xlsx natively via ExcelJS (optional peer, lazily imported); ODS and legacy-xls inputs are
 * normalized to xlsx first through the configured `sheetNormalize` engine, degrading to a
 * readable failure when none is configured. Output is always xlsx.
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { MIME, replaceExtension, unsupportedForMutationReason } from '../formats'
import type { MediaArgJson } from '../plan'
import type { default as ExcelJSNS } from 'exceljs'
import type { StepImpl, StepContext, StepPayload } from '../runtime'

type ExcelJSModule = typeof ExcelJSNS

let excelPromise: Promise<ExcelJSModule> | undefined
const excel = (): Promise<ExcelJSModule> => {
  excelPromise ??= import('exceljs').then((m) => ('default' in m ? m.default : m) as ExcelJSModule)
  return excelPromise
}

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

/** Acquire xlsx bytes for the step, converting ODS/xls to xlsx via the engine registry. */
const acquireXlsx = async (ctx: StepContext, verb: string): Promise<Uint8Array> => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime === MIME.XLSX) return ctx.payload.bytes
  const mutationBlock = unsupportedForMutationReason(mime)
  if (mime === MIME.ODS || mime === MIME.XLS) {
    if (!ctx.engines.hasConvert(mime, 'xlsx')) {
      fail(
        verb,
        `this input is ${mime} — an engine that converts it to xlsx is required first, and none is configured. Do not retry this verb on this media in this deployment.`
      )
    }
    const result = await ctx.engines.convert({
      bytes: ctx.payload.bytes,
      mimeType: mime,
      filename: ctx.payload.filename,
      to: 'xlsx',
      signal: ctx.signal,
    })
    const output = result.outputs[0]
    if (!output) fail(verb, 'normalizing the workbook to xlsx produced no output')
    return output!.bytes
  }
  if (mutationBlock) fail(verb, mutationBlock)
  fail(verb, `sheet operations expect a spreadsheet; the media is ${mime}`)
  /* unreachable */ throw new Error('unreachable')
}

interface MutationSummary {
  added?: number
  removed?: number
  modified?: number
  warnings?: string[]
}

/** The shared open → mutate → write-back lifecycle every sheet verb uses. */
const withWorkbook = async (
  ctx: StepContext,
  verb: string,
  mutate: (wb: ExcelJSNS.Workbook) => MutationSummary | Promise<MutationSummary>
): Promise<{ kind: 'media'; payload: StepPayload }> => {
  const xlsxBytes = await acquireXlsx(ctx, verb)
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(
      xlsxBytes.buffer.slice(
        xlsxBytes.byteOffset,
        xlsxBytes.byteOffset + xlsxBytes.byteLength
      ) as ArrayBuffer
    )
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `could not open the spreadsheet: ${detail}`)
  }
  await mutate(wb)
  const out = new Uint8Array(await wb.xlsx.writeBuffer())
  return {
    kind: 'media',
    payload: {
      bytes: out,
      mimeType: MIME.XLSX,
      filename: replaceExtension(ctx.payload.filename, 'xlsx'),
    },
  }
}

/** Resolve the target worksheet from the frozen `sheet=` rule (bare number=index, string=name). */
const resolveSheet = (
  verb: string,
  wb: ExcelJSNS.Workbook,
  sheetArg: string | number | undefined
): ExcelJSNS.Worksheet => {
  if (sheetArg === undefined) {
    const first = wb.worksheets[0]
    if (!first) fail(verb, 'the workbook has no worksheets')
    return first
  }
  // Frozen 0.11: bare number targets by 1-based index; quoted string targets by name.
  if (typeof sheetArg === 'number') {
    const byIndex = wb.worksheets[sheetArg - 1]
    if (byIndex) return byIndex
    const byName = wb.getWorksheet(String(sheetArg))
    if (byName) {
      fail(
        verb,
        `no sheet at index ${sheetArg}, but a sheet NAMED "${sheetArg}" exists — quote it: sheet="${sheetArg}"`
      )
    }
    fail(
      verb,
      `sheet index ${sheetArg} is out of range (1-based; the workbook has ${wb.worksheets.length})`
    )
  }
  const ws = wb.getWorksheet(sheetArg as string)
  if (!ws) {
    const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
    fail(verb, `no sheet named "${sheetArg}". Sheets: ${names}`)
  }
  return ws!
}

const columnLetterToNumber = (col: string): number => {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

type CellValue = string | number | boolean | null

const asCellValue = (verb: string, value: unknown): ExcelJSNS.CellValue => {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  fail(verb, `cell values must be string, number, boolean, or null; got ${typeof value}`)
  /* unreachable */ throw new Error('unreachable')
}

// ── step implementations ─────────────────────────────────────────────────────

/** `sheet.add_rows` — insert rows before/after an index, or append. */
export const sheetAddRowsStep: StepImpl = async (ctx) => {
  const verb = 'sheet add_rows'
  const rows = ctx.step.args.rows as MediaArgJson
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) {
    fail(verb, `rows must be a non-empty JSON array of arrays, e.g. rows='[["a",1]]'`)
  }
  const before = argOf<number>(ctx.step, 'before')
  const after = argOf<number>(ctx.step, 'after')
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
    const insertAt =
      before !== undefined ? before : after !== undefined ? after + 1 : ws.rowCount + 1
    const cellRows = (rows as unknown[][]).map((r) => r.map((v) => asCellValue(verb, v)))
    ws.spliceRows(insertAt, 0, ...cellRows)
    return { added: cellRows.length }
  })
}

/** `sheet.add_columns` — insert columns with headers or full descriptors. */
export const sheetAddColumnsStep: StepImpl = async (ctx) => {
  const verb = 'sheet add_columns'
  const headers = ctx.step.args.headers as string[] | undefined
  const columnsJson = ctx.step.args.columns as MediaArgJson | undefined
  const columns: Array<{ header: string; values?: CellValue[] }> | undefined =
    (columnsJson as Array<{ header: string; values?: CellValue[] }> | undefined) ??
    headers?.map((header) => ({ header }) as { header: string; values?: CellValue[] })
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(verb, `provide headers=a,b or columns='[{"header":"X","values":[1]}]'`)
  }
  const before = argOf<number>(ctx.step, 'before')
  const after = argOf<number>(ctx.step, 'after')
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
    const insertAt =
      before !== undefined ? before : after !== undefined ? after + 1 : ws.columnCount + 1
    for (const [i, col] of columns!.entries()) {
      if (typeof col?.header !== 'string') fail(verb, 'every column needs a string header')
      ws.spliceColumns(insertAt + i, 0, [
        col.header,
        ...(col.values ?? []).map((v) => asCellValue(verb, v)),
      ])
    }
    return { added: columns!.length }
  })
}

/** `sheet.update_cells` — set cells by A1 address or row/col. Leading `=` writes a formula. */
export const sheetUpdateCellsStep: StepImpl = async (ctx) => {
  const verb = 'sheet update_cells'
  const updates = ctx.step.args.updates as MediaArgJson
  if (!Array.isArray(updates) || updates.length === 0) {
    fail(
      verb,
      `updates must be a non-empty JSON array, e.g. updates='[{"address":"B2","value":3}]'`
    )
  }
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
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
        fail(verb, 'each update needs address, or both row and col')
        continue
      }
      const value = raw.value
      if (typeof value === 'string' && value.startsWith('=')) {
        cell.value = { formula: value.slice(1) } as ExcelJSNS.CellValue
      } else {
        cell.value = asCellValue(verb, value)
      }
      modified += 1
    }
    return { modified }
  })
}

/** `sheet.delete_rows` — delete 1-based rows (bottom-up so indices stay valid). */
export const sheetDeleteRowsStep: StepImpl = async (ctx) => {
  const verb = 'sheet delete_rows'
  const rows = ctx.step.args.rows as number[]
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
    for (const r of [...rows].sort((a, b) => b - a)) ws.spliceRows(r, 1)
    return { removed: rows.length }
  })
}

/** `sheet.delete_columns` — delete 1-based columns. */
export const sheetDeleteColumnsStep: StepImpl = async (ctx) => {
  const verb = 'sheet delete_columns'
  const columns = ctx.step.args.columns as number[]
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
    for (const c of [...columns].sort((a, b) => b - a)) ws.spliceColumns(c, 1)
    return { removed: columns.length }
  })
}

/** `sheet.rename_sheet` — rename by NAME (the server contract; index targeting is rejected). */
export const sheetRenameSheetStep: StepImpl = async (ctx) => {
  const verb = 'sheet rename_sheet'
  const sheet = argOf<string | number>(ctx.step, 'sheet') as string
  const to = argOf<string>(ctx.step, 'to') as string
  return withWorkbook(ctx, verb, (wb) => {
    const ws = wb.getWorksheet(sheet)
    if (!ws) {
      const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
      fail(verb, `rename targets a sheet NAME; no sheet named "${sheet}". Sheets: ${names}`)
    }
    ws!.name = to
    return { modified: 1 }
  })
}

/** `sheet.add_sheet` — add a worksheet, optionally at a 1-based position. */
export const sheetAddSheetStep: StepImpl = async (ctx) => {
  const verb = 'sheet add_sheet'
  const name = argOf<string>(ctx.step, 'name') as string
  const at = argOf<number>(ctx.step, 'at')
  return withWorkbook(ctx, verb, (wb) => {
    if (wb.getWorksheet(name)) fail(verb, `a sheet named "${name}" already exists`)
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
  })
}

/** `sheet.remove_sheet` — remove by NAME (the server contract). */
export const sheetRemoveSheetStep: StepImpl = async (ctx) => {
  const verb = 'sheet remove_sheet'
  const sheet = argOf<string | number>(ctx.step, 'sheet') as string
  return withWorkbook(ctx, verb, (wb) => {
    const ws = wb.getWorksheet(sheet)
    if (!ws) {
      const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ')
      fail(verb, `remove targets a sheet NAME; no sheet named "${sheet}". Sheets: ${names}`)
    }
    wb.removeWorksheet(ws!.id)
    return { removed: 1 }
  })
}

/** `sheet.reorder_sheets` — every sheet exactly once, by name or 1-based index. */
export const sheetReorderSheetsStep: StepImpl = async (ctx) => {
  const verb = 'sheet reorder_sheets'
  const order = ctx.step.args.order as MediaArgJson
  if (!Array.isArray(order) || order.length === 0) {
    fail(verb, `order must be a JSON array of names/indices, e.g. order='["Summary",2]'`)
  }
  return withWorkbook(ctx, verb, (wb) => {
    const refs = order as Array<string | number>
    if (refs.length !== wb.worksheets.length) {
      fail(
        verb,
        `order must include every worksheet exactly once (the workbook has ${wb.worksheets.length})`
      )
    }
    const reordered: ExcelJSNS.Worksheet[] = []
    const seen = new Set<number>()
    for (const ref of refs) {
      const ws = typeof ref === 'number' ? wb.worksheets[ref - 1] : wb.getWorksheet(ref)
      if (!ws) fail(verb, `sheet not found: ${String(ref)}`)
      if (seen.has(ws!.id)) fail(verb, `duplicate sheet reference: ${String(ref)}`)
      seen.add(ws!.id)
      reordered.push(ws!)
    }
    // ExcelJS serializes by orderNo; the worksheets getter returns a sorted clone.
    reordered.forEach((ws, i) => {
      ;(ws as unknown as { orderNo: number }).orderNo = i + 1
    })
    return { modified: reordered.length }
  })
}

/** `sheet.transform_table` — rename/select/drop columns by header name. */
export const sheetTransformTableStep: StepImpl = async (ctx) => {
  const verb = 'sheet transform_table'
  const headerRow = argOf<number>(ctx.step, 'header_row') ?? 1
  const rename = ctx.step.args.rename as Array<{ from: string; to: string }> | undefined
  const select = ctx.step.args.select as string[] | undefined
  const drop = ctx.step.args.drop as string[] | undefined
  return withWorkbook(ctx, verb, (wb) => {
    const ws = resolveSheet(verb, wb, argOf<string | number>(ctx.step, 'sheet'))
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
  })
}

/** The sheet step registry fragment, keyed by canonical verb id. */
export const SHEET_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['sheet.add_rows', sheetAddRowsStep],
  ['sheet.add_columns', sheetAddColumnsStep],
  ['sheet.update_cells', sheetUpdateCellsStep],
  ['sheet.delete_rows', sheetDeleteRowsStep],
  ['sheet.delete_columns', sheetDeleteColumnsStep],
  ['sheet.rename_sheet', sheetRenameSheetStep],
  ['sheet.add_sheet', sheetAddSheetStep],
  ['sheet.remove_sheet', sheetRemoveSheetStep],
  ['sheet.reorder_sheets', sheetReorderSheetsStep],
  ['sheet.transform_table', sheetTransformTableStep],
]
