/**
 * Exception classes for the TYPED path of `adk/create-exception-args-array`'s spec.
 *
 * @remarks
 * This file is never linted directly: it is the cross-module supplier the rule's type checker has
 * to walk into. `E_QUOTA` carries a NON-empty args tuple (so a bare string is the footgun), while
 * `E_FIXED` carries the empty tuple (so a bare `ExceptionOptions`-shaped value is the documented
 * form and must NOT be flagged).
 */

import { createException } from '@nhtio/adk/factories'

export const E_QUOTA = createException<[string, number]>(
  'E_QUOTA',
  'quota for %s exceeded %d',
  'E_QUOTA',
  429,
  true
)

export const E_FIXED = createException<[]>('E_FIXED', 'fixed message', 'E_FIXED', 500, false)
