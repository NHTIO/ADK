import { createException } from '@nhtio/adk/factories'

// Same-file declaration in a TYPED program: the declaration path must keep working, and it must
// not be shadowed by a no-op typed path.
const E_LOCAL = createException<[string]>('E_LOCAL', 'local %s', 'E_LOCAL')
throw new E_LOCAL('detail')
