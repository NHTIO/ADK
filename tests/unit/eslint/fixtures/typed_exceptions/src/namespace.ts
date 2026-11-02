import * as exc from './exceptions'

// Same footgun reached through a namespace import: the typed path must see the class, not the
// module object.
throw new exc.E_QUOTA('detail')
