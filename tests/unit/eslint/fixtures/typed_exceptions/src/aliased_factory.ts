import { createException as ce } from '@nhtio/adk/factories'

// The factory itself under a local alias: the declaration path resolves the callee through the
// import bindings, so the binding is still recognised as `createException`.
const E_ALIASED = ce<[string]>('E_ALIASED', 'aliased %s', 'E_ALIASED')
throw new E_ALIASED('detail')
