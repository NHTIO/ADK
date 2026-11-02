import { E_QUOTA } from './exceptions'

// Control: the correct form for a non-empty tuple. Never flagged.
throw new E_QUOTA(['detail', 1])
