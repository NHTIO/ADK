/**
 * The deterministic text/data {@link @nhtio/adk/batteries/media/contracts!MediaEngine}:
 * seeds and conversions for the text-shaped family (txt/md/json/yaml/csv/html).
 *
 * @module @nhtio/adk/batteries/media/engines/data
 *
 * @remarks
 * The smallest engine in the fleet, and deliberately so: text-family media generation is a
 * literal (`''`, `'{}'`, a minimal HTML shell) and text-family conversion is a parse and a
 * re-serialize. Everything here is deterministic — same inputs, same bytes — and cross-env
 * (no `node:*` anywhere).
 *
 * Capabilities:
 *
 * - **generate**: `EMPTY_MIME` → txt, md, json, yaml, csv, html.
 * - **convert**: json ⇄ yaml (js-yaml), json ⇄ csv (papaparse), json → txt (pretty print).
 *
 * `papaparse` is an optional peer (lazily imported only for the csv edges); `js-yaml` is a
 * regular dependency of the library.
 */

import { MIME } from '../formats'
import { EMPTY_MIME } from '../contracts'
import { isError } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type * as PapaNS from 'papaparse'
import type { MediaEngine, ConvertRequest, ConvertResult } from '../contracts'

type PapaModule = typeof PapaNS

/** Options for {@link dataEngine}. */
export interface DataEngineOptions {
  /** Override the papaparse resolution (tests / custom builds). Default: `import('papaparse')`. */
  papaparse?: () => PapaModule | Promise<PapaModule>
}

/** Literal seeds per generation target. */
const SEEDS: Record<string, { content: string; mimeType: string }> = {
  txt: { content: '', mimeType: MIME.TXT },
  md: { content: '', mimeType: MIME.MD },
  json: { content: '{}', mimeType: MIME.JSON },
  yaml: { content: '', mimeType: MIME.YAML },
  csv: { content: '', mimeType: MIME.CSV },
  html: {
    content:
      '<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body></body>\n</html>\n',
    mimeType: MIME.HTML,
  },
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Construct the deterministic text/data engine.
 *
 * @param options - Optional module resolver override.
 * @returns The engine.
 */
export const dataEngine = (options: DataEngineOptions = {}): MediaEngine => {
  let papaPromise: Promise<PapaModule> | undefined
  const getPapa = (): Promise<PapaModule> => {
    papaPromise ??= Promise.resolve(
      options.papaparse
        ? options.papaparse()
        : import('papaparse').then((m) => ('default' in m ? m.default : m) as PapaModule)
    ).catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `the data engine could not load its peer dependency "papaparse" (needed for csv conversion): ${detail} — install it (pnpm add papaparse)`,
      ])
    })
    return papaPromise
  }

  const generate = async (request: ConvertRequest): Promise<ConvertResult> => {
    const seed = SEEDS[request.to]
    if (!seed) {
      throw new Error(
        `the data engine generates ${Object.keys(SEEDS).join(', ')}; requested "${request.to}"`
      )
    }
    return {
      outputs: [{ bytes: encoder.encode(seed.content), mimeType: seed.mimeType }],
    }
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const mime = request.mimeType.toLowerCase().split(';')[0].trim()
    const text = decoder.decode(request.bytes)

    if (mime === MIME.JSON && request.to === 'yaml') {
      const { dump } = await import('js-yaml')
      const value: unknown = JSON.parse(text)
      return {
        outputs: [{ bytes: encoder.encode(dump(value)), mimeType: MIME.YAML }],
      }
    }
    if (mime === MIME.JSON && request.to === 'txt') {
      const value: unknown = JSON.parse(text)
      return {
        outputs: [{ bytes: encoder.encode(JSON.stringify(value, null, 2)), mimeType: MIME.TXT }],
      }
    }
    if (mime === MIME.JSON && request.to === 'csv') {
      const Papa = await getPapa()
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value)) {
        throw new Error(
          'json → csv expects a JSON array (of arrays, or of flat objects) at the top level'
        )
      }
      const csv = Papa.unparse(value as unknown[])
      return { outputs: [{ bytes: encoder.encode(csv), mimeType: MIME.CSV }] }
    }
    if (mime === MIME.YAML && request.to === 'json') {
      const { load } = await import('js-yaml')
      const value = load(text)
      return {
        outputs: [{ bytes: encoder.encode(JSON.stringify(value ?? null)), mimeType: MIME.JSON }],
      }
    }
    if (mime === MIME.CSV && request.to === 'json') {
      const Papa = await getPapa()
      const parsed = Papa.parse<string[]>(text.replace(/\r\n/g, '\n').replace(/\n+$/, ''), {
        skipEmptyLines: true,
      })
      if (parsed.errors.length > 0) {
        throw new Error(`csv parse failed: ${parsed.errors[0].message}`)
      }
      // Array-of-arrays, matching the battery's json table shape (soffice/sheetjs emit it too).
      return {
        outputs: [{ bytes: encoder.encode(JSON.stringify(parsed.data)), mimeType: MIME.JSON }],
      }
    }
    throw new Error(`the data engine cannot convert ${request.mimeType} to "${request.to}"`)
  }

  return {
    id: 'data',
    converts: [
      { from: [EMPTY_MIME], to: Object.keys(SEEDS), convert: generate },
      { from: [MIME.JSON], to: ['yaml', 'txt', 'csv'], convert },
      { from: [MIME.YAML], to: ['json'], convert },
      { from: [MIME.CSV], to: ['json'], convert },
    ],
  }
}
