/**
 * MIME tables and format-family classification for the media pipeline.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Ported from the source server's
 * `format_families.ts` support tiers, reshaped for the DSL's verb-applicability checks:
 *
 * - Tier 1 (full read + mutate): OOXML (docx/xlsx/pptx) and ODF (odt/ods/odp, via a normalize
 *   engine), plus PDF for page-level operations.
 * - Tier 2 (extraction only): legacy Office (doc/xls/ppt) and Apple iWork — mutation verbs
 *   reject these with a reason string rather than a throw, so callers can surface
 *   model-actionable failures.
 * - Everything else classifies by top-level MIME family (image/audio/text).
 */

import type { FormatFamily } from './verbs'

/** Well-known MIME constants used across the battery. */
export const MIME = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ODT: 'application/vnd.oasis.opendocument.text',
  ODS: 'application/vnd.oasis.opendocument.spreadsheet',
  ODP: 'application/vnd.oasis.opendocument.presentation',
  PDF: 'application/pdf',
  DOC: 'application/msword',
  XLS: 'application/vnd.ms-excel',
  PPT: 'application/vnd.ms-powerpoint',
  PAGES: 'application/x-iwork-pages-sffpages',
  NUMBERS: 'application/x-iwork-numbers-sffnumbers',
  KEYNOTE: 'application/x-iwork-keynote-sffkey',
  TXT: 'text/plain',
  MD: 'text/markdown',
  CSV: 'text/csv',
  HTML: 'text/html',
  JSON: 'application/json',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
  TIFF: 'image/tiff',
  AVIF: 'image/avif',
  WAV: 'audio/wav',
  MP3: 'audio/mpeg',
} as const

/** Legacy Office MIME types (extraction only — mutation is rejected). */
export const LEGACY_OFFICE_MIMES: ReadonlySet<string> = new Set([MIME.DOC, MIME.XLS, MIME.PPT])

/** Apple iWork MIME types (extraction only — mutation is rejected). */
export const IWORK_MIMES: ReadonlySet<string> = new Set([MIME.PAGES, MIME.NUMBERS, MIME.KEYNOTE])

const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([MIME.XLSX, MIME.ODS, MIME.XLS, MIME.CSV])
const PRESENTATION_MIMES: ReadonlySet<string> = new Set([
  MIME.PPTX,
  MIME.ODP,
  MIME.PPT,
  MIME.KEYNOTE,
])
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  MIME.PDF,
  MIME.DOCX,
  MIME.ODT,
  MIME.DOC,
  MIME.PAGES,
  MIME.TXT,
  MIME.MD,
  MIME.HTML,
  MIME.JSON,
  'application/rtf',
  'text/rtf',
])

/**
 * Classify a MIME type into the verb table's broad format family.
 *
 * @param mimeType - The media MIME type.
 * @returns The family used by verb-applicability checks.
 */
export const familyOf = (mimeType: string): FormatFamily => {
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  if (SPREADSHEET_MIMES.has(mime)) return 'spreadsheet'
  if (PRESENTATION_MIMES.has(mime)) return 'presentation'
  if (DOCUMENT_MIMES.has(mime)) return 'document'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/')) return 'document'
  return 'document'
}

/**
 * Reason a mutation verb cannot run against this MIME type, or `undefined` when mutation is
 * allowed. Returns a reason string (not a throw) so callers compose model-actionable failures.
 *
 * @param mimeType - The media MIME type.
 * @returns A human-readable reason, or `undefined` when mutation is supported.
 */
export const unsupportedForMutationReason = (mimeType: string): string | undefined => {
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  if (LEGACY_OFFICE_MIMES.has(mime)) {
    return `legacy Office format (${mime}) supports extraction only — convert it first (e.g. convert to=docx)`
  }
  if (IWORK_MIMES.has(mime)) {
    return `Apple iWork format (${mime}) supports extraction only`
  }
  return undefined
}

/** A small extension → MIME lookup for filenames produced by transforms. */
export const EXT_TO_MIME: Readonly<Record<string, string>> = {
  pdf: MIME.PDF,
  docx: MIME.DOCX,
  xlsx: MIME.XLSX,
  pptx: MIME.PPTX,
  odt: MIME.ODT,
  ods: MIME.ODS,
  odp: MIME.ODP,
  doc: MIME.DOC,
  xls: MIME.XLS,
  ppt: MIME.PPT,
  txt: MIME.TXT,
  md: MIME.MD,
  csv: MIME.CSV,
  html: MIME.HTML,
  json: MIME.JSON,
  rtf: 'application/rtf',
  png: MIME.PNG,
  jpg: MIME.JPEG,
  jpeg: MIME.JPEG,
  webp: MIME.WEBP,
  tiff: MIME.TIFF,
  avif: MIME.AVIF,
  wav: MIME.WAV,
  mp3: MIME.MP3,
}

/**
 * Replace (or add) a filename's extension.
 *
 * @param filename - The original filename.
 * @param ext - The new extension, without the dot.
 * @returns The filename with the new extension.
 */
export const replaceExtension = (filename: string, ext: string): string => {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  return `${base}.${ext}`
}
