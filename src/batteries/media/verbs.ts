/**
 * The canonical verb table: every verb the media DSL knows, with arg schemas, engine
 * requirements, format-family applicability, and output kinds.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. This table is the single source
 * of truth consumed by:
 *
 * - the pipe parser's semantic validator (unknown-verb/arg detection, did-you-mean),
 * - the plan compiler (arg coercion + constraint checks),
 * - the engine-narrowing pass (which verbs a deployment advertises),
 * - the forge (generating the `media_query` tool description and few-shot examples),
 * - the builder (typed front-end methods map 1:1 onto entries here).
 *
 * Frozen design decisions (design doc section 0): canonical verb ids are dot-namespaced
 * snake_case; verb matching is separator-insensitive (space/`_`/`.` fold); args are named-only;
 * indices are 1-based everywhere; arg names follow one-meaning-one-name (`to`, `with`, `match`,
 * `replace`, `order`, `pages`, `at`).
 */

import { PCM_MIME } from './contracts'

/** The value type of a single declared arg. */
export type VerbArgType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'number-list'
  | 'string-list'
  | 'regex-or-string-list'
  | 'name-or-index'
  | 'media-ref'
  | 'media-ref-list'
  | 'json'

/** Declaration of one named arg on a verb. */
export interface VerbArgSpec {
  /** The arg's value type. */
  type: VerbArgType
  /** Whether the statement must supply this arg. */
  required?: boolean
  /** Legal values when `type === 'enum'` (or per-element for list types). */
  values?: readonly string[]
  /** Inclusive minimum for numbers / per-element for number lists. */
  min?: number
  /** Inclusive maximum for numbers / per-element for number lists. */
  max?: number
  /** Model-facing description used in generated tool grammar text. */
  description: string
}

/**
 * A verb's capability requirement against the deployment's engine registry. Verbs with no
 * requirement are always advertised; input-conditional engine needs (e.g. `extract.text`
 * needing OCR only for images) stay runtime checks inside the step implementation.
 */
export type VerbRequirement =
  | { capability: 'convert'; from?: string; to?: string }
  | { capability: 'mutate' }
  | { capability: 'edit'; op?: string }

/** Broad input families used for verb-applicability checks. */
export type FormatFamily =
  | 'document' // pdf/docx/odt/rtf/txt/md/html...
  | 'spreadsheet' // xlsx/ods/xls/csv
  | 'presentation' // pptx/odp/ppt
  | 'image'
  | 'audio'
  | 'any'

/** What awaiting a chain ending in this verb resolves to. */
export type VerbOutput = 'media' | 'media-list' | 'text' | 'json'

/** One verb table entry. */
export interface VerbSpec {
  /** Canonical id: dot-namespaced snake_case (`extract.text`, `sheet.update_cells`). */
  id: string
  /** Model-facing one-line description. */
  description: string
  /** Named args (named-only grammar; no positionals). */
  args: Record<string, VerbArgSpec>
  /**
   * Capability the verb always requires, if any — gates whether the verb is advertised and
   * accepted under a given engine configuration. Input-conditional needs are handled (and
   * error-messaged) by the step implementation at runtime.
   */
  requires?: VerbRequirement
  /** Input families the verb applies to. */
  appliesTo: readonly FormatFamily[]
  /** Output kind. May be refined by an `out`-style arg (documented per verb). */
  output: VerbOutput
}

/** Conversion targets supported by `convert` (the server's enum plus the SheetJS/data matrix). */
export const CONVERT_TARGETS = [
  'pdf',
  'html',
  'txt',
  'md',
  'csv',
  'json',
  'yaml',
  'docx',
  'doc',
  'rtf',
  'odt',
  'xlsx',
  'xls',
  'ods',
  'xlsm',
  'xlsb',
  'fods',
  'sylk',
  'dif',
  'dbf',
  'numbers',
  'pptx',
  'ppt',
  'odp',
] as const

/** Image output formats supported by `image.format`. */
export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'avif'] as const

/** The canonical verb table. Order is presentation order in generated grammar text. */
export const VERBS: readonly VerbSpec[] = [
  // ── root: document transforms ──────────────────────────────────────────────
  {
    id: 'convert',
    description: 'Convert the media to another format.',
    args: {
      to: {
        type: 'enum',
        required: true,
        values: CONVERT_TARGETS,
        description: 'Target format.',
      },
    },
    requires: { capability: 'convert' },
    appliesTo: ['document', 'spreadsheet', 'presentation'],
    output: 'media',
  },
  {
    id: 'select',
    description: 'Keep only the listed pages/slides/sections (1-based), producing one file.',
    args: {
      pages: {
        type: 'number-list',
        required: true,
        min: 1,
        description: 'Pages (or slides/sections) to keep, 1-based. Ranges allowed: 2-5,8.',
      },
    },
    appliesTo: ['document', 'presentation'],
    output: 'media',
  },
  {
    id: 'split',
    description: 'Split the media into multiple files by page or section.',
    args: {
      by: {
        type: 'enum',
        values: ['page', 'section'],
        description: 'Split unit. Default: page.',
      },
      ranges: {
        type: 'json',
        description:
          "Explicit grouping as a JSON array of [start,end] pairs (1-based), e.g. '[[1,3],[5,7]]'.",
      },
    },
    appliesTo: ['document', 'presentation'],
    output: 'media-list',
  },
  {
    id: 'merge',
    description: 'Merge other media into this one, in order.',
    args: {
      with: {
        type: 'media-ref-list',
        required: true,
        description: 'Other media to append, as @id refs: with=@<media id>,@<media id>.',
      },
    },
    appliesTo: ['document', 'presentation'],
    output: 'media',
  },
  {
    id: 'reorder',
    description: 'Reorder pages/slides/sections by the given 1-based index order.',
    args: {
      order: {
        type: 'number-list',
        required: true,
        min: 1,
        description: 'New order of existing 1-based indices.',
      },
    },
    appliesTo: ['document', 'presentation'],
    output: 'media',
  },
  {
    id: 'redact',
    description:
      'Redact matching text. Prefer literal strings; /regex/ is supported. PDF redaction is VISUAL (draw-over + metadata strip; content streams keep the text) — for content-level PDF redaction, extract text first.',
    args: {
      match: {
        type: 'regex-or-string-list',
        required: true,
        description: 'Literal string(s) or a /regex/ to redact.',
      },
      replace: {
        type: 'string',
        description: 'Replacement text. Default: blackout/removal.',
      },
    },
    appliesTo: ['document', 'spreadsheet', 'presentation'],
    output: 'media',
  },
  {
    id: 'sanitize',
    description: 'Remove potentially unsafe embedded content from the media.',
    args: {},
    appliesTo: ['document', 'spreadsheet', 'presentation'],
    output: 'media',
  },
  {
    id: 'normalize',
    description: 'Normalize the media structure/encoding for downstream consistency.',
    args: {},
    appliesTo: ['document', 'spreadsheet', 'presentation'],
    output: 'media',
  },
  {
    id: 'update_text',
    description: 'Replace the first occurrence of an anchor text.',
    args: {
      anchor: {
        type: 'string',
        required: true,
        description: 'Existing text to find.',
      },
      replace: {
        type: 'string',
        required: true,
        description: 'Replacement text (empty string deletes).',
      },
    },
    appliesTo: ['document', 'presentation'],
    output: 'media',
  },
  {
    id: 'diff',
    description:
      'Compare this media against another; returns a structured diff whose patch text feeds apply_patch directly.',
    args: {
      with: {
        type: 'media-ref',
        required: true,
        description: 'The media to compare against, as an @id ref.',
      },
    },
    appliesTo: ['document', 'spreadsheet', 'presentation'],
    output: 'json',
  },
  {
    id: 'apply_patch',
    description:
      'Apply a patch to the media text: a unified diff (as produced by the diff verb — that output feeds this verb directly), or a structured "*** Begin Patch" envelope (Add/Delete/Update File) for multi-file changes. In the structured envelope, add-file content lines must start with "+" (the unified-diff convention).',
    args: {
      patch: {
        type: 'string',
        required: true,
        description:
          'The patch content: unified diff, or a structured envelope starting with "*** Begin Patch". Add-file content lines must start with "+".',
      },
      with: {
        type: 'media-ref-list',
        description: 'Optional additional context media, as @id refs.',
      },
    },
    appliesTo: ['document'],
    output: 'media',
  },
  {
    id: 'append',
    description: 'Append text to text-family media (txt/md/csv/yaml).',
    args: {
      text: { type: 'string', required: true, description: 'The text to append.' },
      newline: {
        type: 'boolean',
        description: 'Terminate with a newline (and separate from existing content). Default true.',
      },
    },
    appliesTo: ['document', 'spreadsheet'],
    output: 'media',
  },
  // ── data namespace (JSON/YAML structural ops) ───────────────────────────────
  {
    id: 'data.set',
    description: 'Set a value at a path in JSON/YAML media (creates missing containers).',
    args: {
      path: {
        type: 'string',
        required: true,
        description: 'Dot/bracket path, e.g. a.b[2].c',
      },
      value: {
        type: 'string',
        required: true,
        description: "JSON-encoded value: '42', '\"text\"', '{\"k\":1}'. Bare strings accepted.",
      },
    },
    appliesTo: ['document'],
    output: 'media',
  },
  {
    id: 'data.merge',
    description: 'Merge a JSON object fragment into JSON/YAML media.',
    args: {
      fragment: {
        type: 'string',
        required: true,
        description: 'The JSON object to merge, e.g. \'{"a":{"b":1}}\'.',
      },
      strategy: {
        type: 'enum',
        values: ['deep', 'shallow'],
        description: 'Merge strategy. Default deep.',
      },
    },
    appliesTo: ['document'],
    output: 'media',
  },
  {
    id: 'data.delete',
    description: 'Delete a key or array element at a path in JSON/YAML media.',
    args: {
      path: {
        type: 'string',
        required: true,
        description: 'Dot/bracket path of the key/element to remove.',
      },
    },
    appliesTo: ['document'],
    output: 'media',
  },
  // ── root: extraction ────────────────────────────────────────────────────────
  {
    id: 'extract.text',
    description:
      'Extract text from any supported media (document, spreadsheet, image). To limit pages: select pages=… | extract text.',
    args: {
      ocr: {
        type: 'enum',
        values: ['off', 'auto', 'force'],
        description: 'OCR behavior. Default auto (OCR only when there is no text layer).',
      },
      ocr_out: {
        type: 'enum',
        values: ['txt', 'hocr', 'json'],
        description: 'OCR output structure when OCR runs. Default txt.',
      },
      lang: {
        type: 'string-list',
        description: 'OCR language hint(s), e.g. lang=eng,deu. Quote tags with dashes.',
      },
    },
    appliesTo: ['document', 'spreadsheet', 'presentation', 'image'],
    output: 'text',
  },
  {
    id: 'extract.metadata',
    description: 'Extract document metadata (author, dates, page count) as JSON.',
    args: {},
    appliesTo: ['document', 'spreadsheet', 'presentation', 'image', 'audio'],
    output: 'json',
  },
  {
    id: 'extract.assets',
    description: 'Extract embedded assets (images, fonts, attachments) as separate media.',
    args: {
      types: {
        type: 'string-list',
        values: ['image', 'font', 'attachment', 'all'],
        description: 'Asset kinds to extract. Default all.',
      },
      format: {
        type: 'enum',
        values: IMAGE_FORMATS,
        description:
          'Re-encode extracted images to this format. Default: native encoding as stored.',
      },
    },
    appliesTo: ['document', 'presentation', 'spreadsheet'],
    output: 'media-list',
  },
  {
    id: 'chunk',
    description: 'Split extracted text into chunks for retrieval/indexing.',
    args: {
      by: {
        type: 'enum',
        values: ['sentence', 'paragraph', 'fixed'],
        description: 'Chunking strategy. Default paragraph.',
      },
      size: {
        type: 'number',
        min: 1,
        description: 'Chunk size for fixed strategy / max size otherwise.',
      },
      overlap: {
        type: 'number',
        min: 0,
        description: 'Overlap between consecutive chunks.',
      },
    },
    appliesTo: ['document', 'any'],
    output: 'json',
  },
  // ── sheet namespace ─────────────────────────────────────────────────────────
  {
    id: 'sheet.add_rows',
    description: 'Insert rows into a worksheet.',
    args: {
      sheet: {
        type: 'name-or-index',
        description: 'Target worksheet: bare number = 1-based index, quoted string = name.',
      },
      rows: {
        type: 'json',
        required: true,
        description: 'Rows as a JSON array of arrays of cell values, e.g. \'[["a",1],["b",2]]\'.',
      },
      before: { type: 'number', min: 1, description: 'Insert before this 1-based row.' },
      after: { type: 'number', min: 1, description: 'Insert after this 1-based row.' },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.add_columns',
    description: 'Insert columns into a worksheet.',
    args: {
      sheet: { type: 'name-or-index', description: 'Target worksheet (index or quoted name).' },
      headers: {
        type: 'string-list',
        description: 'Header names for the new columns (values empty).',
      },
      columns: {
        type: 'json',
        description: 'Full column descriptors as JSON: \'[{"header":"X","values":[1,2]}]\'.',
      },
      before: { type: 'number', min: 1, description: 'Insert before this 1-based column.' },
      after: { type: 'number', min: 1, description: 'Insert after this 1-based column.' },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.update_cells',
    description: 'Update specific cells.',
    args: {
      sheet: { type: 'name-or-index', description: 'Target worksheet (index or quoted name).' },
      updates: {
        type: 'json',
        required: true,
        description:
          'JSON array of updates: \'[{"address":"B2","value":42}]\' or \'[{"row":2,"col":3,"value":"x"}]\'.',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.delete_rows',
    description: 'Delete rows by 1-based index.',
    args: {
      sheet: { type: 'name-or-index', description: 'Target worksheet (index or quoted name).' },
      rows: {
        type: 'number-list',
        required: true,
        min: 1,
        description: '1-based row indices to delete.',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.delete_columns',
    description: 'Delete columns by 1-based index.',
    args: {
      sheet: { type: 'name-or-index', description: 'Target worksheet (index or quoted name).' },
      columns: {
        type: 'number-list',
        required: true,
        min: 1,
        description: '1-based column indices to delete.',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.rename_sheet',
    description: 'Rename a worksheet. The target must be a sheet NAME (quote it).',
    args: {
      sheet: {
        type: 'string',
        required: true,
        description: 'Current sheet name (names only for rename; quote it).',
      },
      to: { type: 'string', required: true, description: 'New sheet name.' },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.add_sheet',
    description: 'Add a new worksheet.',
    args: {
      name: { type: 'string', required: true, description: 'Name for the new worksheet.' },
      at: { type: 'number', min: 1, description: 'Insert at this 1-based position.' },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.remove_sheet',
    description: 'Remove a worksheet. The target must be a sheet NAME (quote it).',
    args: {
      sheet: {
        type: 'string',
        required: true,
        description: 'Sheet name to remove (names only; quote it).',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.reorder_sheets',
    description: 'Reorder worksheets.',
    args: {
      order: {
        type: 'json',
        required: true,
        description:
          'JSON array of sheet names and/or 1-based indices in the new order: \'["Summary",2,3]\'.',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  {
    id: 'sheet.transform_table',
    description: 'Rename/select/drop table columns by header name.',
    args: {
      sheet: { type: 'name-or-index', description: 'Target worksheet (index or quoted name).' },
      header_row: { type: 'number', min: 1, description: '1-based header row. Default 1.' },
      select: { type: 'string-list', description: 'Column headers to keep.' },
      drop: { type: 'string-list', description: 'Column headers to drop.' },
      rename: {
        type: 'json',
        description: 'JSON array of renames: \'[{"from":"Old","to":"New"}]\'.',
      },
    },
    requires: { capability: 'edit' },
    appliesTo: ['spreadsheet'],
    output: 'media',
  },
  // ── slides namespace ────────────────────────────────────────────────────────
  {
    id: 'slides.add',
    description: 'Add a new slide.',
    args: {
      at: { type: 'number', min: 1, description: 'Insert at this 1-based position.' },
      title: { type: 'string', description: 'Title text for the new slide.' },
      layout: { type: 'string', description: 'Layout name (template-dependent).' },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.update_text',
    description: 'Update text on a slide.',
    args: {
      slide: {
        type: 'name-or-index',
        description: 'Target slide: bare number = 1-based index, quoted string = title.',
      },
      placeholder: { type: 'string', description: 'Placeholder/shape to target.' },
      text: { type: 'string', required: true, description: 'Replacement text.' },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.update_table',
    description: 'Update table cells on a slide.',
    args: {
      slide: { type: 'name-or-index', description: 'Target slide (index or quoted title).' },
      updates: {
        type: 'json',
        required: true,
        description: 'JSON array: \'[{"row":1,"col":2,"value":"x"}]\' (1-based).',
      },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.update_image',
    description: 'Replace an image on a slide with another media.',
    args: {
      slide: { type: 'name-or-index', description: 'Target slide (index or quoted title).' },
      placeholder: { type: 'string', description: 'Placeholder/shape to target.' },
      with: {
        type: 'media-ref',
        required: true,
        description: 'The replacement image, as an @id ref.',
      },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.update_chart',
    description: 'Update chart data on a slide.',
    args: {
      slide: { type: 'name-or-index', description: 'Target slide (index or quoted title).' },
      data: {
        type: 'json',
        description: 'JSON array-of-arrays of chart data: \'[["Q1",10],["Q2",20]]\'.',
      },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.delete',
    description: 'Delete slides by 1-based index.',
    args: {
      slides: {
        type: 'number-list',
        required: true,
        min: 1,
        description: '1-based slide indices to delete.',
      },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.reorder',
    description: 'Reorder slides.',
    args: {
      order: {
        type: 'number-list',
        required: true,
        min: 1,
        description: 'New order of existing 1-based slide indices.',
      },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  {
    id: 'slides.duplicate',
    description: 'Duplicate a slide.',
    args: {
      slide: { type: 'number', required: true, min: 1, description: '1-based slide to copy.' },
      at: { type: 'number', min: 1, description: 'Insert the copy at this position.' },
    },
    appliesTo: ['presentation'],
    output: 'media',
  },
  // ── image namespace (split verbs; runtime fuses adjacent image.* steps) ─────
  {
    id: 'image.resize',
    description: 'Resize the image.',
    args: {
      width: { type: 'number', min: 1, max: 16384, description: 'Target width in px.' },
      height: { type: 'number', min: 1, max: 16384, description: 'Target height in px.' },
      fit: {
        type: 'enum',
        values: ['cover', 'contain', 'fill', 'inside', 'outside'],
        description: 'Resize fit mode. Default cover.',
      },
    },
    requires: { capability: 'mutate' },
    appliesTo: ['image'],
    output: 'media',
  },
  {
    id: 'image.format',
    description: 'Re-encode the image to another format.',
    args: {
      to: {
        type: 'enum',
        required: true,
        values: IMAGE_FORMATS,
        description: 'Target image format.',
      },
      quality: { type: 'number', min: 1, max: 100, description: 'Quality for lossy formats.' },
      strip_metadata: {
        type: 'boolean',
        description: 'Remove EXIF/ICC metadata from the output.',
      },
    },
    requires: { capability: 'mutate' },
    appliesTo: ['image'],
    output: 'media',
  },
  {
    id: 'image.rotate',
    description: 'Rotate the image.',
    args: {
      deg: {
        type: 'enum',
        required: true,
        values: ['90', '180', '270'],
        description: 'Rotation in degrees (clockwise).',
      },
    },
    requires: { capability: 'mutate' },
    appliesTo: ['image'],
    output: 'media',
  },
  {
    id: 'image.flip',
    description: 'Flip the image.',
    args: {
      axis: {
        type: 'enum',
        required: true,
        values: ['horizontal', 'vertical', 'both'],
        description: 'Flip axis.',
      },
    },
    requires: { capability: 'mutate' },
    appliesTo: ['image'],
    output: 'media',
  },
  {
    id: 'image.strip_metadata',
    description: 'Remove EXIF/ICC metadata from the image without other changes.',
    args: {},
    requires: { capability: 'mutate' },
    appliesTo: ['image'],
    output: 'media',
  },
  // ── audio namespace ─────────────────────────────────────────────────────────
  {
    id: 'audio.transcribe',
    description: 'Transcribe speech to text.',
    args: {
      lang: {
        type: 'string',
        description: 'Language hint, e.g. lang=en. Quote tags with dashes: lang="en-US".',
      },
      out: {
        type: 'enum',
        values: ['txt', 'srt', 'vtt', 'json'],
        description: 'Output format. Default txt. srt/vtt produce subtitles.',
      },
      translate: {
        type: 'boolean',
        description: 'Translate the transcription to English.',
      },
    },
    requires: { capability: 'convert', from: PCM_MIME },
    appliesTo: ['audio'],
    output: 'text',
  },
] as const

/** Map of canonical verb id → spec, for direct lookup. */
export const VERB_INDEX: ReadonlyMap<string, VerbSpec> = new Map(VERBS.map((v) => [v.id, v]))

/**
 * Fold a verb token sequence to canonical form: lowercase, separators (space/`_`/`.`)
 * normalized so `extract_text` ≡ `extract text` ≡ `extract.text` all match `extract.text`.
 *
 * @param words - The verb word tokens as written (1 or 2 words, possibly containing `_`/`.`).
 * @returns The canonical verb id when a fold-match exists, otherwise `undefined`.
 */
export const foldVerb = (words: string[]): string | undefined => {
  const flat = words
    .join(' ')
    .toLowerCase()
    .replace(/[._\s]+/g, ' ')
    .trim()
  return FOLDED_INDEX.get(flat)
}

/** Internal: folded "word word" form → canonical id. */
const FOLDED_INDEX: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const v of VERBS) {
    const folded = v.id.replace(/[._]+/g, ' ')
    if (map.has(folded)) {
      throw new Error(`verb table invariant violated: "${folded}" folds to multiple verbs`)
    }
    map.set(folded, v.id)
  }
  return map
})()

/**
 * All folded verb word-sequences, for the parser's longest-match verb recognition and for
 * generated grammar text.
 */
export const FOLDED_VERBS: readonly string[] = Array.from(FOLDED_INDEX.keys())

/**
 * Suggest the nearest verbs to an unknown input, for did-you-mean errors. Matches whole folded
 * forms AND suffix words (`resize` suggests `image resize`), per the frozen error model.
 *
 * @param input - The unknown verb text as written.
 * @param candidates - The folded verb forms to search (pass the narrowed set to avoid
 *   suggesting unconfigured verbs).
 * @returns Up to three suggestions, best first.
 */
export const suggestVerbs = (input: string, candidates: readonly string[]): string[] => {
  const folded = input
    .toLowerCase()
    .replace(/[._\s]+/g, ' ')
    .trim()
  const scored: Array<{ name: string; score: number }> = []
  for (const cand of candidates) {
    const direct = levenshtein(folded, cand)
    const words = cand.split(' ')
    const suffix = words.length > 1 ? levenshtein(folded, words[words.length - 1]) : Infinity
    const score = Math.min(direct, suffix)
    if (score <= Math.max(2, Math.floor(folded.length / 3))) {
      scored.push({ name: cand, score })
    }
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, 3).map((s) => s.name)
}

/** Classic two-row Levenshtein distance. */
const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}
