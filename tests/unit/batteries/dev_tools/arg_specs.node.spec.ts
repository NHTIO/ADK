import { describe, expect, it } from 'vitest'
import { DEV_ARG_SPECS } from '../../../../src/batteries/dev_tools/arg_specs'

describe('dev-tools argument specification table', () => {
  it('declares the complete step and argument contract', () => {
    expect(Object.keys(DEV_ARG_SPECS)).toEqual([
      'read_lines',
      'edit',
      'apply_patch',
      'write',
      'format',
      'lint',
      'check',
    ])
    expect(DEV_ARG_SPECS.read_lines).toEqual({
      path: { type: 'string', required: true },
      start: { type: 'number', required: true },
      end: { type: 'number' },
    })
    expect(DEV_ARG_SPECS.edit.path).toEqual({ type: 'string', required: true })
    expect(DEV_ARG_SPECS.edit.edits).toEqual({
      type: 'array',
      required: true,
      nonEmpty: true,
      element: {
        nonEmpty: true,
        fields: {
          find: { type: 'string', nonEmpty: true },
          replace: { type: 'string' },
        },
      },
    })
    expect(DEV_ARG_SPECS.apply_patch).toEqual({ patch: { type: 'string', required: true } })
    expect(DEV_ARG_SPECS.write.paths).toEqual({ type: 'array', element: 'string', nonEmpty: true })
    expect(DEV_ARG_SPECS.format.paths).toEqual({ type: 'array', element: 'string', nonEmpty: true })
    expect(DEV_ARG_SPECS.lint).toEqual({
      paths: { type: 'array', element: 'string', nonEmpty: true },
      fix: { type: 'boolean' },
    })
    expect(DEV_ARG_SPECS.check).toEqual({})
    expect(DEV_ARG_SPECS.edit.edits.element).toMatchObject({
      fields: { find: { nonEmpty: true }, replace: { type: 'string' } },
    })
    expect((DEV_ARG_SPECS.edit.edits.element as any).fields.replace.nonEmpty).toBeUndefined()
  })
})
