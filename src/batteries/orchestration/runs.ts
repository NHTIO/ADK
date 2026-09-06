/**
 * The run-event fold: turn a persisted run log into a `RunProjection`.
 *
 * @module @nhtio/adk/batteries/orchestration/runs
 */

import { branchKey } from './ops'
import type {
  RunEvent,
  RunProjection,
  PendingFrame,
  JoinState,
  FrameRef,
  NodeOutcome,
  NodeOutput,
  InterruptionCause,
  NodeId,
  EdgeHandle,
  EncodableValue,
} from './types'

/**
 * Fold a sequence of run events into a single {@link RunProjection}.
 *
 * The projection is derived entirely from the events themselves — no graph, no store, and no
 * side channel. It is deterministic and total: the same event list always folds to the same
 * projection.
 *
 * @param events - The ordered run events to fold.
 * @returns The projected state of the run.
 * @throws If the first event is not `run_started` (a malformed event list).
 */
export function foldRun(events: RunEvent[]): RunProjection {
  if (events.length === 0 || events[0].kind !== 'run_started') {
    throw new Error('foldRun: malformed event list; first event must be run_started')
  }

  const started = events[0]
  const runId = started.runId
  const digest = started.digest

  const frameStatus = new Map<string, 'running' | 'done' | 'failed' | 'skipped'>()
  const nodeStatusById = new Map<NodeId, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>()
  const outputs: Map<string, NodeOutput> = new Map()
  const indeterminate: FrameRef[] = []
  const edgesTaken: { edgeId: string; handle: EdgeHandle; evidence?: EncodableValue }[] = []

  let frontier: { frames: PendingFrame[]; joins: JoinState[] } = { frames: [], joins: [] }
  let outcome: 'running' | 'completed' | 'halted' | 'aborted' = 'running'
  let interruption: InterruptionCause | undefined

  const frameKey = (frame: FrameRef): string => `${frame.nodeId}:${branchKey(frame.branchId)}`
  const nodeIdFromKey = (key: string): NodeId => key.slice(0, key.indexOf(':'))

  for (const event of events) {
    switch (event.kind) {
      case 'run_started':
        // Already handled above; nothing further to fold.
        break

      case 'node_entered': {
        const key = frameKey(event.frame)
        if (!frameStatus.has(key)) {
          frameStatus.set(key, 'running')
        }
        break
      }

      case 'node_settled': {
        const key = frameKey(event.frame)
        frameStatus.set(key, outcomeStatus(event.outcome))

        if (event.outcome.status === 'ok') {
          outputs.set(key, event.outcome.output)
        }
        break
      }

      case 'edge_taken': {
        edgesTaken.push({ edgeId: event.edgeId, handle: event.handle, evidence: event.evidence })
        break
      }

      case 'frontier_snapshot': {
        frontier = { frames: event.frames, joins: event.joins }
        break
      }

      case 'run_interrupted': {
        interruption = event.cause
        break
      }

      case 'run_settled': {
        outcome = event.outcome
        break
      }
    }
  }

  // Advance the frontier past the last snapshot using the events after it: each later
  // node_settled removes its frame, each later edge_taken adds its `to` frame with the
  // outputs and artifacts that event carries.
  const snapshotIndex = lastIndexWhere(events, (e) => e.kind === 'frontier_snapshot')
  const frames = new Map<string, PendingFrame>()
  for (const frame of frontier.frames) {
    frames.set(frameKey(frame.frame), frame)
  }
  for (let i = snapshotIndex + 1; i < events.length; i++) {
    const event = events[i]
    if (event.kind === 'node_settled') {
      frames.delete(frameKey(event.frame))
    } else if (event.kind === 'edge_taken') {
      frames.set(frameKey(event.to), {
        frame: event.to,
        outputs: event.outputs,
        artifacts: event.artifacts,
      })
    }
  }
  frontier = { frames: [...frames.values()], joins: frontier.joins }

  // Indeterminate frames: entered-without-settled AND kind === 'call', exactly. No other kind
  // ever appears — branch/select/transform/reason/join are re-entered unconditionally on resume.
  const settledKeys = new Set<string>()
  for (const event of events) {
    if (event.kind === 'node_settled') {
      settledKeys.add(frameKey(event.frame))
    }
  }
  const seenIndeterminate = new Set<string>()
  for (const event of events) {
    if (event.kind === 'node_entered' && event.frame.kind === 'call') {
      const key = frameKey(event.frame)
      if (!settledKeys.has(key) && !seenIndeterminate.has(key)) {
        seenIndeterminate.add(key)
        indeterminate.push(event.frame)
      }
    }
  }

  // Roll up per-node status from per-frame status.
  const framesByNode = new Map<NodeId, ('running' | 'done' | 'failed' | 'skipped')[]>()
  for (const [key, status] of frameStatus) {
    const nodeId = nodeIdFromKey(key)
    const list = framesByNode.get(nodeId) ?? []
    list.push(status)
    framesByNode.set(nodeId, list)
  }
  for (const [nodeId, statuses] of framesByNode) {
    nodeStatusById.set(nodeId, rollupNodeStatus(statuses))
  }

  return {
    runId,
    digest,
    frameStatus,
    nodeStatusById,
    outputs,
    frontier,
    indeterminate,
    edgesTaken,
    outcome,
    interruption,
  }
}

function outcomeStatus(outcome: NodeOutcome): 'done' | 'failed' | 'skipped' {
  switch (outcome.status) {
    case 'ok':
      return 'done'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
  }
}

function rollupNodeStatus(
  statuses: ('running' | 'done' | 'failed' | 'skipped')[]
): 'pending' | 'running' | 'done' | 'failed' | 'skipped' {
  if (statuses.some((s) => s === 'running')) return 'running'
  if (statuses.some((s) => s === 'failed')) return 'failed'
  if (statuses.every((s) => s === 'done' || s === 'skipped')) return 'done'
  return 'pending'
}

function lastIndexWhere(events: RunEvent[], predicate: (e: RunEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (predicate(events[i])) return i
  }
  return -1
}
