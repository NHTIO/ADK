import { describe, expectTypeOf, it } from 'vitest'
import type { ConvertOptions } from '../../../../src/batteries/media/contracts'

// The BYO options surface: consumers extend ConvertOptions via declaration merging against
// the contracts module. This spec proves the augmentation compiles and type-checks — a key
// added here must be visible (and type-safe) at every ConvertRequest call site.
declare module '../../../../src/batteries/media/contracts' {
  interface ConvertOptions {
    augmentedWatermark?: { text: string }
  }
}

describe('ConvertOptions declaration merging (type-level)', () => {
  it('bundled convention keys are present and typed', () => {
    expectTypeOf<ConvertOptions>().toHaveProperty('languages')
    expectTypeOf<ConvertOptions>().toHaveProperty('lang')
    expectTypeOf<ConvertOptions>().toHaveProperty('translate')
    expectTypeOf<ConvertOptions>().toHaveProperty('format')
  })

  it('a consumer-augmented key merges into the bag', () => {
    expectTypeOf<ConvertOptions>().toHaveProperty('augmentedWatermark')
    const options: ConvertOptions = {
      languages: ['eng'],
      augmentedWatermark: { text: 'CONFIDENTIAL' },
    }
    expectTypeOf(options.augmentedWatermark).toEqualTypeOf<{ text: string } | undefined>()
  })
})
