import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
/** MIME resolver; `undefined` means the resolver declines and a later resolver may decide. */
export type MimeResolver = (ctx: {
  path: string
  declared?: string
  /** Read a bounded prefix only; this callback cannot read the whole file. */
  peek: (bytes: number) => Promise<Uint8Array>
}) => string | undefined | Promise<string | undefined>
/** MIME resolver schema. */
export const mimeResolverSchema = validator
  .any()
  .required()
  .custom((v, h) => (typeof v === 'function' ? v : h.error('any.invalid')))
/** MIME resolver guard. */
export const implementsMimeResolver = (v: unknown): v is MimeResolver =>
  passesSchema(mimeResolverSchema, v)
