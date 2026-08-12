import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'

/** Model-path boundary: normalises ergonomic paths while refusing unambiguous host escapes. */
export interface PathTranslator {
  /** Validate and convert a model path; leading separators mean the sandbox root. */
  toRelative(modelPath: string): Promise<string>
  /** Convert a validated relative path to an opaque backend locator. */
  toBackendPath(relative: string): string
  /** Scrub root and common host identifiers from battery-generated text. */
  redact(text: string): string
  /** The translator always inspects the resolved path and every parent for symlink components. */
  assertNoSymlinkComponents(relative: string): Promise<void>
}

/** Duck-type schema. */
export const pathTranslatorSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).toRelative === 'function' &&
      typeof (value as any).toBackendPath === 'function' &&
      typeof (value as any).redact === 'function' &&
      typeof (value as any).assertNoSymlinkComponents === 'function'
    )
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsPathTranslator = (value: unknown): value is PathTranslator =>
  passesSchema(pathTranslatorSchema, value)
