/**
 * Pure, synchronous per-spawn message-id state machine. Wrapper-only — never imported by
 * `adapter.ts` (mirrors `cli_protocol.ts`'s own header note: no `@nhtio/adk/*` imports anywhere,
 * so it stays safe for the wrapper's self-contained-process boundary — Decision A/C).
 *
 * @remarks
 * Extracted out of `wrapper.ts`'s `startTurn` closure (issue #43, fix B follow-up) so the
 * claim-and-reset step is provable WITHOUT any I/O or timing: every exported function here does
 * ONE synchronous state transition and returns before `wrapper.ts` ever reaches an `await`. This
 * matters because `wrapper.ts`'s own NDJSON line handler is `void handleClaudeLine(line)` —
 * unawaited — so several lines from one stdout chunk (or across chunks/`data` events) can have
 * their handler bodies INTERLEAVED at each other's `await` points. A version of this state machine
 * that mutated its fields AFTER an `await writeEvent(...)` (as the original fix-B patch did) let a
 * second, distinct assistant message's handler read the stale, not-yet-reset id and collide with
 * the just-sealed one — the exact race a verification pass caught against f3d7fde. Moving the
 * claim/reset into a single synchronous function call makes that race structurally impossible: by
 * the time ANY caller reaches its own first `await`, this module's state has already been fully
 * transitioned, with no in-between tick for a second line's synchronous prefix to observe.
 */

/** Mutable per-spawn state, created once per `startTurn` call. Never shared across spawns. */
export interface MessageIdState {
  /** The wrapper-local id of the message currently accumulating partial deltas, if any. */
  partialMessageId: string | undefined
  /** Bumped once per SEALED message, so the next distinct message mints a fresh wrapper-local id. */
  messageIndex: number
}

/** Fresh state for a new `startTurn` spawn. */
export const createMessageIdState = (): MessageIdState => ({
  partialMessageId: undefined,
  messageIndex: 0,
})

/**
 * Claim the wrapper-local id for a `stream_event` partial delta. Synchronously assigns
 * `partialMessageId` if this is the first delta seen for the in-progress message, so every
 * subsequent partial delta (and the eventual complete-message line) reuses the SAME id — call
 * this, and only this, before ever `await`-ing the corresponding `writeEvent`.
 */
export const claimPartialDeltaId = (state: MessageIdState): string => {
  const id = state.partialMessageId ?? `message-${state.messageIndex}`
  state.partialMessageId = id
  return id
}

/**
 * Claim the wrapper-local id for a complete (`assistant`/`user`) message line, and atomically
 * reset the state for whatever distinct message this SAME spawn may still emit next (text ->
 * tool_use -> more text all arrive within one spawn — issue #43, fix B). `hadPriorPartialDelta`
 * tells the caller whether a `stream_event` delta already carried this message's text (in which
 * case the complete line's own text must NOT be re-sent as the delta, or the adapter's per-id
 * accumulator would duplicate it) — matching the wrapper's pre-existing `partialMessageId ===
 * undefined ? text : ''` decision, now made in the same atomic step as the claim itself.
 */
export const claimCompleteMessageId = (
  state: MessageIdState
): { id: string; hadPriorPartialDelta: boolean } => {
  const id = state.partialMessageId ?? `message-${state.messageIndex}`
  const hadPriorPartialDelta = state.partialMessageId !== undefined
  state.partialMessageId = undefined
  state.messageIndex += 1
  return { id, hadPriorPartialDelta }
}
