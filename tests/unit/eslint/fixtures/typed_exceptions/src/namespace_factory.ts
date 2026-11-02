import * as adk from '@nhtio/adk/factories'

// The factory reached through a namespace import.
const E_NS = adk.createException<[number]>('E_NS', 'ns %d', 'E_NS')
throw new E_NS([7])
