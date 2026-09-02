import { describe, expect, it } from 'vitest'
import * as devTools from '../../../../src/batteries/dev_tools'
import type {
  DevPipeline,
  DevChain,
  DevPlan,
  DevStep,
  DevOp,
  RunOptions,
  WorkspaceBounds,
  DevEngine,
  FormatCapability,
  LintCapability,
  CheckCapability,
  FormatRequest,
  LintRequest,
  CheckRequest,
  WorkspaceDelta,
  RawDiagnostic,
  Diagnostic,
  Severity,
  DevResult,
  FileChangeSummary,
  DevFileAccess,
  DevGateFn,
  DevGateVerdict,
  DevGateContext,
  DevGateCall,
  DevWorkspace,
  DevWorkspaceToken,
  DevStepMiddlewareFn,
  DevStepContext,
  DevSelectionMiddlewareFn,
  DevSelectionContext,
  DevCandidate,
  DevCapabilityProbe,
} from '../../../../src/batteries/dev_tools'

type AssertAssignable<Expected, Actual> = Actual extends Expected ? true : never
type PublicTypeSurface = [
  DevPipeline,
  DevChain,
  DevPlan,
  DevStep,
  DevOp,
  RunOptions,
  WorkspaceBounds,
  DevEngine,
  FormatCapability,
  LintCapability,
  CheckCapability,
  FormatRequest,
  LintRequest,
  CheckRequest,
  WorkspaceDelta,
  RawDiagnostic,
  Diagnostic,
  Severity,
  DevResult,
  FileChangeSummary,
  DevFileAccess,
  DevGateFn,
  DevGateVerdict,
  DevGateContext,
  DevGateCall,
  DevWorkspace,
  DevWorkspaceToken,
  DevStepMiddlewareFn,
  DevStepContext,
  DevSelectionMiddlewareFn,
  DevSelectionContext,
  DevCandidate,
  DevCapabilityProbe,
]
type PublicTypeSurfaceIsImportable = AssertAssignable<PublicTypeSurface, PublicTypeSurface>
void (null as unknown as PublicTypeSurfaceIsImportable)

const exceptions = [
  'E_INVALID_DEV_PIPELINE_CONFIG',
  'E_DEV_UNKNOWN_STEP',
  'E_DEV_BAD_ARG',
  'E_DEV_ENGINE_REQUIRED',
  'E_DEV_STEP_FAILED',
  'E_DEV_STEP_UNAVAILABLE',
  'E_DEV_WORKSPACE_BOUNDS',
  'E_DEV_GATE_DECLINED',
]

describe('dev-tools root subpath exports', () => {
  it('exports only the factory and the enumerated runtime exceptions', () => {
    expect(Object.keys(devTools).sort()).toEqual(['createDevPipeline', ...exceptions].sort())
    expect(devTools).not.toHaveProperty('DEV_ARG_SPECS')
    expect(devTools).not.toHaveProperty('buildDevRegistry')
    expect(devTools).not.toHaveProperty('DevArgSpec')
  })
})
