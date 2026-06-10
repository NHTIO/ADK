/**
 * The LibreOffice-backed {@link @nhtio/adk/batteries/media/contracts!MediaEngine}: document,
 * spreadsheet, and presentation conversion via the `soffice` binary.
 *
 * @module @nhtio/adk/batteries/media/engines/soffice
 *
 * @remarks
 * Document conversion is the one capability in the media battery with no mature
 * cross-environment equivalent, so this engine is binary-backed by design. It composes the
 * two BYO runtime contracts: a {@link @nhtio/adk/batteries/media/contracts!BinaryExecutor}
 * runs the invocation (bundled: `execa_executor`) and a
 * {@link @nhtio/adk/batteries/media/contracts!ScratchWorkspace} exchanges bytes with it
 * (bundled: `fs_workspace`). The executor and workspace must agree on path visibility —
 * that pairing is the consumer's composition decision.
 *
 * One engine, one capability kind: the conversion matrix is declared as convert capability
 * groups (each format silo converts within itself plus to PDF/HTML; PDF converts to
 * html/txt/docx/odt). The spreadsheet group covers ODS/legacy-xls to xlsx — what used to be
 * a separate "normalize" engine is just an edge in the matrix.
 */

import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import { implementsBinaryExecutor, implementsScratchWorkspace } from '../contracts'
import type {
  MediaEngine,
  ConvertCapability,
  ConvertRequest,
  ConvertResult,
  BinaryExecutor,
  ScratchWorkspaceFactory,
} from '../contracts'

/** Options for {@link sofficeEngine}. */
export interface SofficeEngineOptions {
  /** Path (or resolvable name) of the soffice binary. */
  path: string
  /** Runs the soffice invocation. Required — no platform default. */
  executor: BinaryExecutor
  /** Mints a scratch dir per invocation whose paths the executor can open. Required. */
  workspace: ScratchWorkspaceFactory
  /** Per-invocation timeout. Default 120000. */
  timeoutMs?: number
}

const MIME_BY_TARGET: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
}

/** Server-parity conversion matrix: same-silo targets plus pdf/html. */
const TARGETS_BY_EXT: Record<string, readonly string[]> = {
  docx: ['pdf', 'html', 'txt', 'md', 'odt', 'doc', 'rtf'],
  odt: ['pdf', 'html', 'txt', 'md', 'docx', 'doc', 'rtf'],
  doc: ['pdf', 'html', 'txt', 'md', 'docx', 'odt', 'rtf'],
  rtf: ['pdf', 'html', 'txt', 'md', 'docx', 'odt', 'doc'],
  xlsx: ['pdf', 'html', 'csv', 'json', 'ods', 'xls'],
  ods: ['pdf', 'html', 'csv', 'json', 'xlsx', 'xls'],
  xls: ['pdf', 'html', 'csv', 'json', 'xlsx', 'ods'],
  pptx: ['pdf', 'html', 'odp', 'ppt'],
  odp: ['pdf', 'html', 'pptx', 'ppt'],
  ppt: ['pdf', 'html', 'pptx', 'odp'],
  pdf: ['html', 'txt', 'docx', 'odt'],
}

/** soffice convert-to filter token per target (md goes via txt; json via csv). */
const CONVERT_TOKEN: Record<string, string> = {
  md: 'txt:Text',
  json: 'csv',
}

const validateOptions = (options: SofficeEngineOptions, name: string): void => {
  if (typeof options?.path !== 'string' || options.path.length === 0) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([`${name} requires the soffice binary path`])
  }
  if (!implementsBinaryExecutor(options.executor)) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      `${name} requires an executor implementing the BinaryExecutor contract`,
    ])
  }
  if (typeof options.workspace !== 'function') {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      `${name} requires a workspace factory (e.g. fsScratchWorkspace({ root }))`,
    ])
  }
}

const runSoffice = async (
  options: SofficeEngineOptions,
  bytes: Uint8Array,
  inputExt: string,
  convertTo: string,
  outputExt: string,
  signal?: AbortSignal
): Promise<Uint8Array> => {
  const workspace = await options.workspace()
  if (!implementsScratchWorkspace(workspace)) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      'the workspace factory minted a value that does not implement ScratchWorkspace',
    ])
  }
  try {
    const inputPath = await workspace.materialize(bytes, `input.${inputExt}`)
    const result = await options.executor.exec({
      cmd: options.path,
      args: [
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        convertTo,
        '--outdir',
        workspace.dir(),
        inputPath,
      ],
      timeoutMs: options.timeoutMs ?? 120_000,
      signal,
    })
    if (result.failed) {
      const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`
      throw new Error(`LibreOffice conversion failed: ${detail}`)
    }
    const files = await workspace.list()
    const produced = files.find(
      (f) => f.toLowerCase().endsWith(`.${outputExt}`) && f !== `input.${inputExt}`
    )
    if (!produced) {
      throw new Error(
        `LibreOffice reported success but produced no .${outputExt} output (files: ${files.join(', ')})`
      )
    }
    return workspace.read(`${workspace.dir()}/${produced}`)
  } finally {
    await workspace.dispose()
  }
}

/** The MIME types of one extension group, for capability `from` declarations. */
const MIMES_OF = (exts: readonly string[]): string[] =>
  Object.entries(EXT_BY_MIME)
    .filter(([, ext]) => exts.includes(ext))
    .map(([mime]) => mime)

/**
 * Construct the LibreOffice engine.
 *
 * @param options - Binary path, executor, workspace factory, timeout.
 * @returns The engine, declaring one convert capability group per format silo.
 */
export const sofficeEngine = (options: SofficeEngineOptions): MediaEngine => {
  validateOptions(options, 'sofficeEngine')

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const mime = request.mimeType.toLowerCase().split(';')[0].trim()
    const inputExt = EXT_BY_MIME[mime]
    if (!inputExt) throw new Error(`unsupported input MIME for conversion: ${request.mimeType}`)
    const targets = TARGETS_BY_EXT[inputExt] ?? []
    if (!targets.includes(request.to)) {
      throw new Error(
        `cannot convert ${inputExt} to ${request.to}; supported: ${targets.join(', ')}`
      )
    }
    const convertTo = CONVERT_TOKEN[request.to] ?? request.to
    const outputExt = request.to === 'md' ? 'txt' : request.to === 'json' ? 'csv' : request.to
    let bytes = await runSoffice(
      options,
      request.bytes,
      inputExt,
      convertTo,
      outputExt,
      request.signal
    )
    let mimeType = MIME_BY_TARGET[request.to] ?? 'application/octet-stream'
    if (request.to === 'json') {
      // soffice emits CSV; lower to a JSON array-of-arrays for predictable structure.
      const text = new TextDecoder().decode(bytes)
      const rows = text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split(','))
      bytes = new TextEncoder().encode(JSON.stringify(rows))
      mimeType = MIME_BY_TARGET.json
    }
    return { outputs: [{ bytes, mimeType }] }
  }

  // One capability group per uniform from×to block of the matrix.
  const group = (exts: readonly string[], to: readonly string[]): ConvertCapability => ({
    from: MIMES_OF(exts),
    to,
    convert,
  })

  return {
    id: 'soffice',
    converts: [
      group(['docx'], TARGETS_BY_EXT.docx),
      group(['odt'], TARGETS_BY_EXT.odt),
      group(['doc'], TARGETS_BY_EXT.doc),
      group(['rtf'], TARGETS_BY_EXT.rtf),
      group(['xlsx'], TARGETS_BY_EXT.xlsx),
      group(['ods'], TARGETS_BY_EXT.ods),
      group(['xls'], TARGETS_BY_EXT.xls),
      group(['pptx'], TARGETS_BY_EXT.pptx),
      group(['odp'], TARGETS_BY_EXT.odp),
      group(['ppt'], TARGETS_BY_EXT.ppt),
      group(['pdf'], TARGETS_BY_EXT.pdf),
    ],
  }
}
