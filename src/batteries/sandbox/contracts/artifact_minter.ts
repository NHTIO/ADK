import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'

/** Artifact-class registry. Format constructors are lazy so unused parsers are never loaded. */
export interface ArtifactMinter {
  /** Return available formats and async constructors. */
  formats(): Promise<
    Array<{ id: string; mime: string[]; extensions: string[]; ctor: () => Promise<unknown> }>
  >
}

/** Duck-type schema. */
export const artifactMinterSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (value !== null && value !== undefined && typeof (value as any).formats === 'function')
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsArtifactMinter = (value: unknown): value is ArtifactMinter =>
  passesSchema(artifactMinterSchema, value)
