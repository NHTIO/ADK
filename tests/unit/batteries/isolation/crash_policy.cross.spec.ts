import { describe, expect, it } from 'vitest'
import {
  createCrashPolicy,
  DEFAULT_CRASH_POLICY_MAX_CRASHES,
  DEFAULT_CRASH_POLICY_WINDOW_MS,
} from '@nhtio/adk/batteries/isolation'

/** An injectable clock the tests advance manually — never a real timer. */
const makeClock = (start = 0): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('createCrashPolicy() — defaults', () => {
  it('exports the documented default window and max-crashes constants', () => {
    expect(DEFAULT_CRASH_POLICY_WINDOW_MS).toBe(120_000)
    expect(DEFAULT_CRASH_POLICY_MAX_CRASHES).toBe(3)
  })

  it('starts with recentCount 0', () => {
    const policy = createCrashPolicy()
    expect(policy.recentCount).toBe(0)
  })
})

describe('createCrashPolicy() — sliding-window escalation', () => {
  it('returns "respawn" for crashes under maxCrashes, then "giveUp" at the threshold', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 3, windowMs: 10_000, now: clock.now })
    expect(policy.record()).toBe('respawn') // 1st
    clock.advance(100)
    expect(policy.record()).toBe('respawn') // 2nd
    clock.advance(100)
    expect(policy.record()).toBe('giveUp') // 3rd — reaches maxCrashes
  })

  it('every crash after reaching maxCrashes (still inside the window) also gives up', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 2, windowMs: 10_000, now: clock.now })
    expect(policy.record()).toBe('respawn')
    expect(policy.record()).toBe('giveUp')
    expect(policy.record()).toBe('giveUp')
  })

  it('tracks recentCount accurately as crashes accumulate inside the window', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 5, windowMs: 10_000, now: clock.now })
    policy.record()
    policy.record()
    expect(policy.recentCount).toBe(2)
  })

  it('prunes crashes older than the window, resetting a cooled-off burst to fresh', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 2, windowMs: 1000, now: clock.now })
    expect(policy.record()).toBe('respawn') // t=0
    clock.advance(2000) // well past the 1000ms window — the first crash no longer counts
    expect(policy.record()).toBe('respawn') // treated as a fresh 1st-in-window crash
    expect(policy.recentCount).toBe(1)
  })

  it('a crash exactly at the window boundary is pruned (uses strict <, not <=)', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 5, windowMs: 1000, now: clock.now })
    policy.record() // t=0
    clock.advance(1000) // now - ts === windowMs exactly
    policy.record()
    expect(policy.recentCount).toBe(1) // the t=0 crash was pruned; only the second remains
  })

  it('two crashes spaced further apart than windowMs are each a fresh first-in-window crash', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 2, windowMs: 5000, now: clock.now })
    expect(policy.record()).toBe('respawn')
    clock.advance(6000)
    expect(policy.record()).toBe('respawn') // never escalates to giveUp — always isolated
    clock.advance(6000)
    expect(policy.record()).toBe('respawn')
  })
})

describe('createCrashPolicy() — reset()', () => {
  it('clears the crash history so the next record() is treated as fresh', () => {
    const clock = makeClock()
    const policy = createCrashPolicy({ maxCrashes: 2, windowMs: 10_000, now: clock.now })
    expect(policy.record()).toBe('respawn')
    expect(policy.record()).toBe('giveUp')
    policy.reset()
    expect(policy.recentCount).toBe(0)
    expect(policy.record()).toBe('respawn')
  })
})

describe('createCrashPolicy() — default clock', () => {
  it('uses Date.now when no clock is injected (smoke test, not a timing assertion)', () => {
    const policy = createCrashPolicy({ maxCrashes: 5 })
    expect(policy.record()).toBe('respawn')
    expect(policy.recentCount).toBe(1)
  })
})
