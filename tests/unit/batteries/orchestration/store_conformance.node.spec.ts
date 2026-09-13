import { describe, expect, it } from 'vitest'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { runPlanStoreConformance } from '../../../../src/batteries/orchestration/conformance'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'

registerOrchestrationEncodables()

describe('InMemoryPlanStore conformance', () => {
  it('satisfies the shared contract', async () => {
    await runPlanStoreConformance('InMemoryPlanStore', () => new InMemoryPlanStore())
  })

  it('reports failure for a deliberately broken plan-store fake', async () => {
    await expect(
      runPlanStoreConformance('broken', () => {
        throw new Error('broken fake')
      })
    ).rejects.toThrow('broken fake')
  })
})
