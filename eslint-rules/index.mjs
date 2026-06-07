import { default as preferIsError } from './rules/prefer-is-error.mjs'
import { default as preferIsObject } from './rules/prefer-is-object.mjs'
import { default as useIsInstanceOf } from './rules/use-is-instance-of.mjs'
import { default as requireValidatorAnyRequired } from './rules/require-validator-any-required.mjs'
import { default as noSrcLibFromFunctional } from './rules/no-src-lib-import-from-functional-tests.mjs'
import { default as noNodeBuiltinFromCrossOrBrowser } from './rules/no-node-builtin-from-cross-or-browser-spec.mjs'

const plugin = {
  meta: { name: 'adk', version: '0.0.0' },
  rules: {
    'no-src-lib-import-from-functional-tests': noSrcLibFromFunctional,
    'no-node-builtin-from-cross-or-browser-spec': noNodeBuiltinFromCrossOrBrowser,
    'use-is-instance-of': useIsInstanceOf,
    'prefer-is-object': preferIsObject,
    'prefer-is-error': preferIsError,
    'require-validator-any-required': requireValidatorAnyRequired,
  },
}

export default plugin
