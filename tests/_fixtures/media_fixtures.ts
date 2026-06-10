import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { StepPayload } from '../../src/batteries/media'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'media')

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain',
  png: 'image/png',
  wav: 'audio/wav',
}

/**
 * Load a media fixture from `tests/_fixtures/media/` as a step payload.
 *
 * @param filename - The fixture basename (extension determines the MIME type).
 * @returns The payload for pipeline specs.
 */
export const loadMediaFixture = async (filename: string): Promise<StepPayload> => {
  const bytes = new Uint8Array(await readFile(join(FIXTURE_DIR, filename)))
  const ext = filename.split('.').pop() ?? ''
  const mimeType = MIME_BY_EXT[ext]
  if (!mimeType) throw new Error(`no MIME mapping for fixture extension .${ext}`)
  return { bytes, mimeType, filename }
}
