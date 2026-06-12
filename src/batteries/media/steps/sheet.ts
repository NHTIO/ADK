/**
 * `sheet.*` step implementations: thin dispatchers into the engine registry's edit
 * capability.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. The actual workbook surgery
 * lives in edit-capable engines (`engines/exceljs` preserves styling; `engines/sheetjs`
 * covers the wider read matrix but strips styling — SheetJS CE limitation). Each step here:
 * normalizes non-xlsx spreadsheet inputs to xlsx when the selected edit coverage requires it
 * (any spreadsheet-family MIME with a declared `hasConvert(mime, 'xlsx')` edge qualifies —
 * ODS/XLS via soffice or sheetjs, XLSB/FODS/SYLK/DIF/DBF/NUMBERS via sheetjs), dispatches the
 * op through `ctx.engines.edit`, and degrades to a model-actionable failure when no edit
 * engine is configured.
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { MIME, SPREADSHEET_MIMES, replaceExtension, unsupportedForMutationReason } from '../formats'
import type { StepImpl, StepContext, StepPayload } from '../runtime'

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

/** Acquire bytes the edit dispatch can work on, normalizing to xlsx when necessary. */
const acquireEditable = async (
  ctx: StepContext,
  verb: string
): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  // An engine that edits this MIME directly (sheetjs edits its whole read matrix) wins.
  if (ctx.engines.hasEdit?.(mime)) return { bytes: ctx.payload.bytes, mimeType: mime }
  // Otherwise: any spreadsheet-family input with a declared path to xlsx normalizes first.
  if (SPREADSHEET_MIMES.has(mime) && mime !== MIME.XLSX) {
    if (!ctx.engines.hasConvert(mime, 'xlsx')) {
      const reason = unsupportedForMutationReason(mime)
      fail(
        verb,
        reason ??
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
    return { bytes: output!.bytes, mimeType: MIME.XLSX }
  }
  if (mime !== MIME.XLSX) {
    const mutationBlock = unsupportedForMutationReason(mime)
    if (mutationBlock) fail(verb, mutationBlock)
    fail(verb, `sheet operations expect a spreadsheet; the media is ${mime}`)
  }
  return { bytes: ctx.payload.bytes, mimeType: MIME.XLSX }
}

/** Dispatch one `sheet.*` op through the registry's edit capability. */
const dispatchEdit = async (
  ctx: StepContext,
  verb: string,
  op: string
): Promise<{ kind: 'media'; payload: StepPayload }> => {
  const { bytes, mimeType } = await acquireEditable(ctx, verb)
  if (!ctx.engines.hasEdit?.(mimeType, op)) {
    fail(
      verb,
      `no engine that edits spreadsheets is configured — add engines/exceljs (or engines/sheetjs) to the pipeline's engines array. Do not retry this verb in this deployment.`
    )
  }
  try {
    const result = await ctx.engines.edit({
      bytes,
      mimeType,
      op,
      args: ctx.step.args as Record<string, unknown>,
      signal: ctx.signal,
    })
    return {
      kind: 'media',
      payload: {
        bytes: result.bytes,
        mimeType: result.mimeType,
        filename: replaceExtension(ctx.payload.filename, 'xlsx'),
      },
    }
  } catch (err) {
    if (isError(err) && err.name.startsWith('E_MEDIA_')) throw err
    const detail = isError(err) ? err.message : String(err)
    fail(verb, detail)
    /* unreachable */ throw err
  }
}

/** Pre-dispatch arg validation: keep the historical readable failures for malformed args. */
const requireJsonArray = (verb: string, value: unknown, message: string): void => {
  if (!Array.isArray(value) || value.length === 0) fail(verb, message)
}

// ── step implementations ─────────────────────────────────────────────────────

/** `sheet.add_rows` — insert rows before/after an index, or append. */
export const sheetAddRowsStep: StepImpl = async (ctx) => {
  const verb = 'sheet add_rows'
  const rows = ctx.step.args.rows
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) {
    fail(verb, `rows must be a non-empty JSON array of arrays, e.g. rows='[["a",1]]'`)
  }
  return dispatchEdit(ctx, verb, 'sheet.add_rows')
}

/** `sheet.add_columns` — insert columns with headers or full descriptors. */
export const sheetAddColumnsStep: StepImpl = async (ctx) => {
  const verb = 'sheet add_columns'
  const headers = ctx.step.args.headers as string[] | undefined
  const columns = ctx.step.args.columns ?? headers
  requireJsonArray(verb, columns, `provide headers=a,b or columns='[{"header":"X","values":[1]}]'`)
  return dispatchEdit(ctx, verb, 'sheet.add_columns')
}

/** `sheet.update_cells` — set cells by A1 address or row/col. Leading `=` writes a formula. */
export const sheetUpdateCellsStep: StepImpl = async (ctx) => {
  const verb = 'sheet update_cells'
  requireJsonArray(
    verb,
    ctx.step.args.updates,
    `updates must be a non-empty JSON array, e.g. updates='[{"address":"B2","value":3}]'`
  )
  return dispatchEdit(ctx, verb, 'sheet.update_cells')
}

/** `sheet.delete_rows` — delete 1-based rows (bottom-up so indices stay valid). */
export const sheetDeleteRowsStep: StepImpl = async (ctx) =>
  dispatchEdit(ctx, 'sheet delete_rows', 'sheet.delete_rows')

/** `sheet.delete_columns` — delete 1-based columns. */
export const sheetDeleteColumnsStep: StepImpl = async (ctx) =>
  dispatchEdit(ctx, 'sheet delete_columns', 'sheet.delete_columns')

/** `sheet.rename_sheet` — rename by NAME (the server contract; index targeting is rejected). */
export const sheetRenameSheetStep: StepImpl = async (ctx) =>
  dispatchEdit(ctx, 'sheet rename_sheet', 'sheet.rename_sheet')

/** `sheet.add_sheet` — add a worksheet, optionally at a 1-based position. */
export const sheetAddSheetStep: StepImpl = async (ctx) =>
  dispatchEdit(ctx, 'sheet add_sheet', 'sheet.add_sheet')

/** `sheet.remove_sheet` — remove by NAME (the server contract). */
export const sheetRemoveSheetStep: StepImpl = async (ctx) =>
  dispatchEdit(ctx, 'sheet remove_sheet', 'sheet.remove_sheet')

/** `sheet.reorder_sheets` — every sheet exactly once, by name or 1-based index. */
export const sheetReorderSheetsStep: StepImpl = async (ctx) => {
  const verb = 'sheet reorder_sheets'
  requireJsonArray(
    verb,
    ctx.step.args.order,
    `order must be a JSON array of names/indices, e.g. order='["Summary",2]'`
  )
  return dispatchEdit(ctx, verb, 'sheet.reorder_sheets')
}

/** `sheet.transform_table` — rename/select/drop columns by header name. */
export const sheetTransformTableStep: StepImpl = async (ctx) => {
  const verb = 'sheet transform_table'
  // header_row defaults inside the engine; validate it is a number when present.
  const headerRow = argOf<number>(ctx.step, 'header_row')
  if (headerRow !== undefined && (!Number.isFinite(headerRow) || headerRow < 1)) {
    fail(verb, 'header_row must be a 1-based row number')
  }
  return dispatchEdit(ctx, verb, 'sheet.transform_table')
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
