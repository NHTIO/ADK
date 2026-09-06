import { createException } from '../../factories'

/** A required orchestration encoder is not configured. */
export const E_ORCH_ENCODER_REQUIRED = createException<[string]>(
  'E_ORCH_ENCODER_REQUIRED',
  '%s',
  'E_ORCH_ENCODER_REQUIRED',
  500,
  true
)
/** An orchestration cell is unavailable. */
export const E_ORCH_CELL_UNAVAILABLE = createException<[string]>(
  'E_ORCH_CELL_UNAVAILABLE',
  '%s',
  'E_ORCH_CELL_UNAVAILABLE',
  422,
  false
)
