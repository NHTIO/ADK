import { E_FIXED } from './exceptions'

// Control: `createException<[]>` — the constructor is `new (options?: ExceptionOptions)`, so a
// bare value here IS the documented options argument and the rule must stay silent.
throw new E_FIXED({ fatal: true })
