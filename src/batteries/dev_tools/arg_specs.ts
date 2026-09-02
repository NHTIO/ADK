/** Machine-readable declaration for one step argument. */
export interface DevArgSpec {
  /** Primitive argument kind. */
  type: 'string' | 'number' | 'boolean' | 'array'
  /** Whether the argument must be present. */
  required?: boolean
  /** Constraint on array members, including object field constraints. */
  element?:
    | 'string'
    | {
        fields: Readonly<Record<string, 'string' | { type: 'string'; nonEmpty?: boolean }>>
        nonEmpty?: boolean
      }
  /** Whether a string or array argument itself must be non-empty. */
  nonEmpty?: boolean
}

/** Per-step argument specifications used by development plan validation. */
export const DEV_ARG_SPECS: Readonly<Record<string, Readonly<Record<string, DevArgSpec>>>> = {
  read_lines: {
    path: { type: 'string', required: true },
    start: { type: 'number', required: true },
    end: { type: 'number' },
  },
  edit: {
    path: { type: 'string', required: true },
    edits: {
      type: 'array',
      required: true,
      element: {
        fields: {
          find: { type: 'string', nonEmpty: true },
          replace: { type: 'string' },
        },
        nonEmpty: true,
      },
      nonEmpty: true,
    },
  },
  apply_patch: { patch: { type: 'string', required: true } },
  write: { paths: { type: 'array', element: 'string', nonEmpty: true } },
  format: { paths: { type: 'array', element: 'string', nonEmpty: true } },
  lint: { paths: { type: 'array', element: 'string', nonEmpty: true }, fix: { type: 'boolean' } },
  check: {},
}
