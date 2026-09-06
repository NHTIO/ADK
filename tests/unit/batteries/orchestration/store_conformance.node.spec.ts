import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { runPlanStoreConformance } from '../../../../src/batteries/orchestration/conformance'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'

registerOrchestrationEncodables()

runPlanStoreConformance('InMemoryPlanStore', () => new InMemoryPlanStore())
