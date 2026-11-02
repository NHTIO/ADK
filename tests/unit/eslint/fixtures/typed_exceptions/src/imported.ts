import { E_QUOTA } from './exceptions'

// The footgun: the class comes from ANOTHER module and carries a non-empty args tuple, but the
// construction passes a bare string — which lands in the `ExceptionOptions` parameter instead.
throw new E_QUOTA('detail')
