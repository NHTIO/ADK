/**
 * The SheetJS-backed spreadsheet {@link @nhtio/adk/batteries/media/contracts!MediaEngine}:
 * the in-process, cross-environment spreadsheet converter, generator, and structural editor.
 *
 * @module @nhtio/adk/batteries/media/engines/sheetjs
 *
 * @remarks
 * SheetJS (the `xlsx` package) reads and writes the widest spreadsheet matrix of any pure-JS
 * library — XLSX/XLSM/XLSB, every XLS BIFF era, ODS/FODS, CSV, SYLK, DIF, DBF, HTML, RTF,
 * Apple NUMBERS — with no binary, no native bindings, in any environment. This engine exposes
 * that matrix three ways:
 *
 * - **convert**: any readable spreadsheet MIME → any writable format token.
 * - **generate**: `EMPTY_MIME` → any writable token (a blank `Sheet1` workbook, written out).
 * - **edit**: the `sheet.*` structural ops via CSF cell-object surgery. ⚠️ SheetJS Community
 *   Edition does NOT model cell styling — fonts, fills, and comments are STRIPPED by any edit
 *   or convert that round-trips a styled workbook (styling is a SheetJS Pro feature). For
 *   fidelity-preserving edits compose the exceljs engine FIRST in the engines array; this
 *   engine's edits are for unstyled/data workbooks and for breadth (it edits ODS, XLS, and
 *   every other readable format by normalizing through CSF).
 *
 * ⚠️ **Install from the SheetJS CDN, not the npm registry.** The registry copy of `xlsx` is
 * frozen at 0.18.5 (2023) and carries CVE-2023-30533 and CVE-2024-22363; this engine requires
 * `>=0.20.2`. Install: `pnpm add xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
 * (SheetJS recommends vendoring the tarball — see docs.sheetjs.com).
 *
 * `xlsx` is an optional peer dependency, lazily imported on first actual use. The NUMBERS
 * write target additionally loads the ZAHL payload (`xlsx/dist/xlsx.zahl.mjs`, ~110 KB) on
 * first request of that specific target.
 */

import { MIME } from '../formats'
import { EMPTY_MIME } from '../contracts'
import { isError } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type * as XlsxNS from 'xlsx'
import type {
  MediaEngine,
  ConvertRequest,
  ConvertResult,
  EditRequest,
  EditResult,
} from '../contracts'

type XlsxModule = typeof XlsxNS

/** Options for {@link sheetjsEngine}. */
export interface SheetjsEngineOptions {
  /** Override the module resolution (tests / custom builds). Default: `import('xlsx')`. */
  xlsx?: () => XlsxModule | Promise<XlsxModule>
  /**
   * Override the ZAHL payload resolution for NUMBERS output (tests / custom builds).
   * Default: `import('xlsx/dist/xlsx.zahl.mjs')`.
   */
  zahl?: () => unknown | Promise<unknown>
}

/** Every format token this engine can write, mapped to the SheetJS bookType that produces it. */
const BOOKTYPE_BY_TARGET: Record<string, string> = {
  xlsx: 'xlsx',
  xlsm: 'xlsm',
  xlsb: 'xlsb',
  xls: 'biff8',
  ods: 'ods',
  fods: 'fods',
  csv: 'csv',
  txt: 'txt',
  html: 'html',
  rtf: 'rtf',
  sylk: 'sylk',
  dif: 'dif',
  dbf: 'dbf',
  numbers: 'numbers',
  // json is synthesized via sheet_to_json, not a bookType — handled separately.
}

/** The convert/generation target tokens, json included. */
const SHEET_WRITE_TARGETS: readonly string[] = [...Object.keys(BOOKTYPE_BY_TARGET), 'json']

/** Output MIME per target token. */
const MIME_BY_TARGET: Record<string, string> = {
  xlsx: MIME.XLSX,
  xlsm: MIME.XLSM,
  xlsb: MIME.XLSB,
  xls: MIME.XLS,
  ods: MIME.ODS,
  fods: MIME.FODS,
  csv: MIME.CSV,
  txt: MIME.TXT,
  html: MIME.HTML,
  rtf: 'application/rtf',
  sylk: MIME.SYLK,
  dif: MIME.DIF,
  dbf: MIME.DBF,
  numbers: MIME.NUMBERS,
  json: MIME.JSON,
}

/**
 * Every spreadsheet MIME this engine reads. SheetJS sniffs the actual format from the bytes
 * (zip vs CFB vs text heuristics), so one entry serves the whole read matrix. Formats SheetJS
 * can parse but that have no standard MIME (Quattro Pro, Works, Lotus variants) are readable
 * whenever a resolver hands us one of these MIMEs for them — the MIME is the only addressable
 * contract the battery has.
 */
const SHEET_READ_MIMES: readonly string[] = [
  MIME.XLSX,
  MIME.XLSM,
  MIME.XLSB,
  MIME.XLS,
  MIME.ODS,
  MIME.FODS,
  MIME.CSV,
  MIME.NUMBERS,
  MIME.SYLK,
  MIME.DIF,
  MIME.DBF,
]

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
 * Construct the SheetJS-backed spreadsheet engine.
 *
 * @param options - Optional module resolver overrides.
 * @returns The engine.
 */
export const sheetjsEngine = (options: SheetjsEngineOptions = {}): MediaEngine => {
  let modPromise: Promise<XlsxModule> | undefined
  const getXlsx = (): Promise<XlsxModule> => {
    modPromise ??= Promise.resolve(options.xlsx ? options.xlsx() : import('xlsx')).catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `the sheetjs engine could not load its peer dependency "xlsx": ${detail} — install it FROM THE SHEETJS CDN (the npm registry copy is stale and vulnerable): pnpm add xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`,
      ])
    })
    return modPromise
  }

  let zahlPromise: Promise<unknown> | undefined
  const getZahl = (): Promise<unknown> => {
    zahlPromise ??= Promise.resolve(
      options.zahl ? options.zahl() : import('xlsx/dist/xlsx.zahl.mjs' as string)
    ).then(
      (m) => (m as { default?: unknown }).default ?? m,
      (err) => {
        const detail = isError(err) ? err.message : String(err)
        throw new Error(
          `NUMBERS output needs the SheetJS ZAHL payload (xlsx/dist/xlsx.zahl.mjs) and it could not be loaded: ${detail}`
        )
      }
    )
    return zahlPromise
  }

  /** Write `wb` to the requested target token. */
  const writeOut = async (
    X: XlsxModule,
    wb: XlsxNS.WorkBook,
    to: string
  ): Promise<{ bytes: Uint8Array; mimeType: string }> => {
    if (to === 'json') {
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = ws ? X.utils.sheet_to_json(ws, { header: 1 }) : []
      return {
        bytes: new TextEncoder().encode(JSON.stringify(rows)),
        mimeType: MIME.JSON,
      }
    }
    const bookType = BOOKTYPE_BY_TARGET[to]
    if (!bookType) {
      throw new Error(`sheetjs cannot write "${to}"; supported: ${SHEET_WRITE_TARGETS.join(', ')}`)
    }
    const writeOpts: XlsxNS.WritingOptions = {
      bookType: bookType as XlsxNS.BookType,
      type: 'array',
    }
    if (to === 'numbers') {
      ;(writeOpts as { numbers?: unknown }).numbers = await getZahl()
    }
    const out = X.write(wb, writeOpts) as ArrayBuffer | Uint8Array
    const bytes = ArrayBuffer.isView(out) ? out : new Uint8Array(out)
    return { bytes, mimeType: MIME_BY_TARGET[to] ?? 'application/octet-stream' }
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const X = await getXlsx()
    const mime = request.mimeType.toLowerCase().split(';')[0].trim()
    let wb: XlsxNS.WorkBook
    if (mime === EMPTY_MIME) {
      // Generation: a blank workbook with one empty Sheet1 (steps expect ≥1 worksheet).
      // NUMBERS refuses a zero-cell sheet, so that target seeds one blank cell.
      wb = X.utils.book_new()
      const seed = request.to === 'numbers' ? [['']] : [[]]
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(seed), 'Sheet1')
    } else {
      wb = X.read(request.bytes)
      if (wb.SheetNames.length === 0) {
        throw new Error(
          `sheetjs parsed ${request.mimeType} but found no worksheets — the file may be corrupt or not actually a spreadsheet`
        )
      }
    }
    const { bytes, mimeType } = await writeOut(X, wb, request.to)
    return { outputs: [{ bytes, mimeType }] }
  }

  const edit = async (request: EditRequest): Promise<EditResult> => {
    const X = await getXlsx()
    const wb = X.read(request.bytes)
    if (wb.SheetNames.length === 0) {
      throw new Error('sheetjs parsed the workbook but found no worksheets')
    }
    const summary = applyEdit(X, wb, request.op, request.args)
    const { bytes, mimeType } = await writeOut(X, wb, 'xlsx')
    return { bytes, mimeType, summary }
  }

  return {
    id: 'sheetjs',
    converts: [
      // Generation: blank Sheet1 workbook, written to any target.
      { from: [EMPTY_MIME], to: SHEET_WRITE_TARGETS, convert },
      // The read matrix: format is sniffed from bytes, so one entry serves every MIME.
      { from: SHEET_READ_MIMES, to: SHEET_WRITE_TARGETS, convert },
    ],
    edits: [
      // ⚠️ CE strips styling (fonts/fills/comments) — compose exceljs first for fidelity.
      { over: SHEET_READ_MIMES, ops: SHEET_OPS, edit },
    ],
  }
}

// ── CSF structural edits ──────────────────────────────────────────────────────
// SheetJS CE models a worksheet as a cell map; these ops normalize to array-of-arrays,
// operate, and rebuild. Styling does not survive this (CE has none to carry).

const asAoa = (X: XlsxModule, ws: XlsxNS.WorkSheet): unknown[][] =>
  X.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][]

const resolveSheetName = (wb: XlsxNS.WorkBook, sheetArg: unknown): string => {
  if (sheetArg === undefined || sheetArg === null) {
    const first = wb.SheetNames[0]
    if (!first) throw new Error('the workbook has no worksheets')
    return first
  }
  if (typeof sheetArg === 'number') {
    const byIndex = wb.SheetNames[sheetArg - 1]
    if (byIndex) return byIndex
    if (wb.SheetNames.includes(String(sheetArg))) {
      throw new Error(
        `no sheet at index ${sheetArg}, but a sheet NAMED "${sheetArg}" exists — quote it: sheet="${sheetArg}"`
      )
    }
    throw new Error(
      `sheet index ${sheetArg} is out of range (1-based; the workbook has ${wb.SheetNames.length})`
    )
  }
  const name = String(sheetArg)
  if (!wb.SheetNames.includes(name)) {
    const names = wb.SheetNames.map((n) => `"${n}"`).join(', ')
    throw new Error(`no sheet named "${name}" (sheets: ${names})`)
  }
  return name
}

/** Column letters → 1-based number (`A` → 1, `AA` → 27). */
const columnLetterToNumber = (letters: string): number => {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** Parse an A1 address into 1-based row/col. */
const parseA1 = (address: string): { row: number; col: number } => {
  const m = /^([A-Za-z]+)(\d+)$/.exec(address.trim())
  if (!m) throw new Error(`invalid cell address "${address}" (expected A1 form)`)
  return { row: Number(m[2]), col: columnLetterToNumber(m[1]) }
}

const rebuild = (X: XlsxModule, wb: XlsxNS.WorkBook, name: string, aoa: unknown[][]): void => {
  wb.Sheets[name] = X.utils.aoa_to_sheet(aoa.length > 0 ? aoa : [[]])
}

/** Apply one structural op to the workbook in place; returns the change summary. */
const applyEdit = (
  X: XlsxModule,
  wb: XlsxNS.WorkBook,
  op: string,
  args: Record<string, unknown>
): { added?: number; removed?: number; modified?: number; warnings?: string[] } => {
  switch (op) {
    case 'sheet.add_rows': {
      const name = resolveSheetName(wb, args.sheet)
      const rows = args.rows as unknown[][]
      if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) {
        throw new Error('rows must be a non-empty array of arrays')
      }
      const aoa = asAoa(X, wb.Sheets[name])
      const before = args.before as number | undefined
      const after = args.after as number | undefined
      const insertAt = before !== undefined ? before - 1 : after !== undefined ? after : aoa.length
      aoa.splice(insertAt, 0, ...rows)
      rebuild(X, wb, name, aoa)
      return { added: rows.length }
    }
    case 'sheet.add_columns': {
      const name = resolveSheetName(wb, args.sheet)
      const headers = args.headers as string[] | undefined
      const descriptors: Array<{ header: string; values?: unknown[] }> | undefined =
        (args.columns as Array<{ header: string; values?: unknown[] }> | undefined) ??
        headers?.map((header) => ({ header }))
      if (!Array.isArray(descriptors) || descriptors.length === 0) {
        throw new Error(`provide headers=a,b or columns='[{"header":"X","values":[1]}]'`)
      }
      const aoa = asAoa(X, wb.Sheets[name])
      const before = args.before as number | undefined
      const after = args.after as number | undefined
      const width = aoa.reduce((w, r) => Math.max(w, r.length), 0)
      const insertAt = before !== undefined ? before - 1 : after !== undefined ? after : width
      for (const [i, col] of descriptors.entries()) {
        if (typeof col?.header !== 'string') throw new Error('every column needs a string header')
        const columnCells = [col.header, ...(col.values ?? [])]
        const rowsNeeded = Math.max(aoa.length, columnCells.length)
        for (let r = 0; r < rowsNeeded; r++) {
          aoa[r] ??= []
          while (aoa[r].length < insertAt + i) aoa[r].push(null)
          aoa[r].splice(insertAt + i, 0, columnCells[r] ?? null)
        }
      }
      rebuild(X, wb, name, aoa)
      return { added: descriptors.length }
    }
    case 'sheet.update_cells': {
      const name = resolveSheetName(wb, args.sheet)
      const updates = args.updates as Array<Record<string, unknown>>
      if (!Array.isArray(updates) || updates.length === 0) {
        throw new Error('updates must be a non-empty array')
      }
      const ws = wb.Sheets[name]
      for (const update of updates) {
        let row: number
        let col: number
        if (typeof update.address === 'string') {
          ;({ row, col } = parseA1(update.address))
        } else {
          row = Number(update.row)
          col =
            typeof update.col === 'string' ? columnLetterToNumber(update.col) : Number(update.col)
          if (!Number.isFinite(row) || !Number.isFinite(col)) {
            throw new Error('each update needs an address (A1) or row+col')
          }
        }
        const addr = X.utils.encode_cell({ r: row - 1, c: col - 1 })
        const value = update.value
        if (typeof value === 'string' && value.startsWith('=')) {
          ws[addr] = { t: 'n', f: value.slice(1) }
        } else if (value === null || value === undefined) {
          delete ws[addr]
        } else if (typeof value === 'number') {
          ws[addr] = { t: 'n', v: value }
        } else if (typeof value === 'boolean') {
          ws[addr] = { t: 'b', v: value }
        } else {
          ws[addr] = { t: 's', v: String(value) }
        }
        const range = ws['!ref']
          ? X.utils.decode_range(ws['!ref'] as string)
          : { s: { r: row - 1, c: col - 1 }, e: { r: row - 1, c: col - 1 } }
        range.s.r = Math.min(range.s.r, row - 1)
        range.s.c = Math.min(range.s.c, col - 1)
        range.e.r = Math.max(range.e.r, row - 1)
        range.e.c = Math.max(range.e.c, col - 1)
        ws['!ref'] = X.utils.encode_range(range)
      }
      return { modified: updates.length }
    }
    case 'sheet.delete_rows': {
      const name = resolveSheetName(wb, args.sheet)
      const rows = args.rows as number[]
      if (!Array.isArray(rows) || rows.length === 0)
        throw new Error('rows must be a non-empty array')
      const aoa = asAoa(X, wb.Sheets[name])
      for (const r of [...rows].sort((a, b) => b - a)) aoa.splice(r - 1, 1)
      rebuild(X, wb, name, aoa)
      return { removed: rows.length }
    }
    case 'sheet.delete_columns': {
      const name = resolveSheetName(wb, args.sheet)
      const columns = args.columns as number[]
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new Error('columns must be a non-empty array')
      }
      const aoa = asAoa(X, wb.Sheets[name])
      for (const c of [...columns].sort((a, b) => b - a)) {
        for (const row of aoa) if (row.length >= c) row.splice(c - 1, 1)
      }
      rebuild(X, wb, name, aoa)
      return { removed: columns.length }
    }
    case 'sheet.rename_sheet': {
      const from = String(args.sheet ?? '')
      const to = String(args.to ?? '')
      if (!wb.SheetNames.includes(from)) {
        const names = wb.SheetNames.map((n) => `"${n}"`).join(', ')
        throw new Error(`rename targets a sheet NAME; no sheet named "${from}". Sheets: ${names}`)
      }
      if (wb.SheetNames.includes(to)) throw new Error(`a sheet named "${to}" already exists`)
      wb.SheetNames[wb.SheetNames.indexOf(from)] = to
      wb.Sheets[to] = wb.Sheets[from]
      delete wb.Sheets[from]
      return { modified: 1 }
    }
    case 'sheet.add_sheet': {
      const name = String(args.name ?? '')
      if (!name) throw new Error('add_sheet requires a name')
      if (wb.SheetNames.includes(name)) throw new Error(`a sheet named "${name}" already exists`)
      const at = args.at as number | undefined
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([[]]), name)
      if (at !== undefined) {
        const idx = wb.SheetNames.indexOf(name)
        wb.SheetNames.splice(idx, 1)
        wb.SheetNames.splice(Math.max(0, at - 1), 0, name)
      }
      return { added: 1 }
    }
    case 'sheet.remove_sheet': {
      const name = String(args.sheet ?? '')
      if (!wb.SheetNames.includes(name)) {
        const names = wb.SheetNames.map((n) => `"${n}"`).join(', ')
        throw new Error(`no sheet named "${name}" (sheets: ${names})`)
      }
      if (wb.SheetNames.length === 1) throw new Error('cannot remove the only worksheet')
      wb.SheetNames.splice(wb.SheetNames.indexOf(name), 1)
      delete wb.Sheets[name]
      return { removed: 1 }
    }
    case 'sheet.reorder_sheets': {
      const order = args.order as Array<string | number>
      if (!Array.isArray(order) || order.length !== wb.SheetNames.length) {
        throw new Error(
          `order must include every worksheet exactly once (the workbook has ${wb.SheetNames.length})`
        )
      }
      const resolved = order.map((ref) =>
        typeof ref === 'number' ? wb.SheetNames[ref - 1] : String(ref)
      )
      if (
        new Set(resolved).size !== resolved.length ||
        resolved.some((n) => !n || !wb.SheetNames.includes(n))
      ) {
        throw new Error('order must reference every existing worksheet exactly once')
      }
      wb.SheetNames.length = 0
      wb.SheetNames.push(...resolved)
      return { modified: resolved.length }
    }
    case 'sheet.transform_table': {
      const name = resolveSheetName(wb, args.sheet)
      const headerRow = Number(args.header_row ?? 1)
      const aoa = asAoa(X, wb.Sheets[name])
      const header = (aoa[headerRow - 1] ?? []).map((h) => (h === null ? '' : String(h)))
      let modified = 0
      const rename = args.rename as Array<{ from: string; to: string }> | undefined
      if (rename) {
        for (const { from, to } of rename) {
          const idx = header.indexOf(from)
          if (idx !== -1) {
            aoa[headerRow - 1][idx] = to
            header[idx] = to
            modified++
          }
        }
      }
      const drop = args.drop as string[] | undefined
      const select = args.select as string[] | undefined
      const toRemove = new Set<number>()
      if (drop)
        for (const h of drop) {
          const idx = header.indexOf(h)
          if (idx !== -1) toRemove.add(idx)
        }
      if (select) {
        for (const [i, element] of header.entries()) {
          if (!select.includes(element)) toRemove.add(i)
        }
      }
      if (toRemove.size > 0) {
        const sorted = [...toRemove].sort((a, b) => b - a)
        for (const row of aoa) for (const idx of sorted) if (row.length > idx) row.splice(idx, 1)
        modified += toRemove.size
      }
      rebuild(X, wb, name, aoa)
      return { modified }
    }
    default:
      throw new Error(`sheetjs does not implement edit op "${op}"`)
  }
}
