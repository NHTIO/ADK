import { createException } from '../../../lib/utils/exceptions'

/** SES lockdown was unavailable or did not harden the guest realm. */
export const E_SES_LOCKDOWN_REQUIRED = createException<[string]>(
  'E_SES_LOCKDOWN_REQUIRED',
  '%s',
  'E_SES_LOCKDOWN_REQUIRED',
  500,
  false
)
/** A guest evaluation exceeded its tool-selected deadline. */
export const E_SES_EVALUATION_TIMEOUT = createException<[string]>(
  'E_SES_EVALUATION_TIMEOUT',
  '%s',
  'E_SES_EVALUATION_TIMEOUT',
  408,
  false
)
