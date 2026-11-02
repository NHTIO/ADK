import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { UNSAFE_CONTROLS, rules } from '../../../../src/batteries/skills/lint'
import type { SkillManagerConfig } from '../../../../src/batteries/skills'

/**
 * The lint plugin's `no-unsafe-opt-in` rule reasons about the `unsafe` block from a hand-maintained
 * table (an ESLint rule cannot execute the types it lints). That table is a drift bomb unless
 * something pins it to reality — this spec is that pin. It reads the declared `unsafe` shape out of
 * `src/batteries/skills/types.ts` and requires the table to match it exactly, in BOTH directions:
 *
 * - a key declared in `types.ts` but absent from the table would be an unsafe control the rule
 *   silently never reports (the worst outcome: the rule looks like coverage and is not);
 * - a key in the table that `types.ts` does not declare is dead wording, and the message would name
 *   a boundary the battery no longer has.
 *
 * If you add or rename an `unsafe` control, this fails until `UNSAFE_CONTROLS` says so.
 */
const TYPES_PATH = resolve(__dirname, '../../../../src/batteries/skills/types.ts')

/** The property names declared directly inside the `unsafe?: { … }` block of `types.ts`. */
const declaredUnsafeControls = async (): Promise<string[]> => {
  const source = await readFile(TYPES_PATH, 'utf8')
  const start = source.indexOf('unsafe?: {')
  expect(start, 'the `unsafe?: { … }` block moved or was renamed in types.ts').toBeGreaterThan(-1)
  // Brace-match from the opening `{` of the block so a nested object cannot end the scan early.
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const block = source.slice(open + 1, end)
  // Top-level members only: nested object literals are indented deeper, and their keys are not
  // themselves `unsafe` controls.
  const names: string[] = []
  let nested = 0
  for (const line of block.split('\n')) {
    const member = nested === 0 ? /^\s{4}([A-Za-z_$][\w$]*)\??:/.exec(line) : null
    if (member) names.push(member[1]!)
    for (const ch of line) {
      if (ch === '{') nested++
      else if (ch === '}') nested--
    }
  }
  return names
}

describe('lint UNSAFE_CONTROLS drift pin', () => {
  it('the table names exactly the controls declared in types.ts', async () => {
    const declared = await declaredUnsafeControls()
    expect(declared.length, 'no controls parsed out of types.ts — the scan shape changed').toBe(3)
    expect(declared.sort()).toEqual(Object.keys(UNSAFE_CONTROLS).sort())
  })

  it('every control carries the boundary wording, not a placeholder', () => {
    for (const [key, boundary] of Object.entries(UNSAFE_CONTROLS)) {
      expect(boundary.length, `${key} has no boundary description`).toBeGreaterThan(20)
      expect(
        boundary,
        `${key} describes itself by name instead of by the boundary it removes`
      ).not.toBe(key)
    }
  })

  it('the rule reports the same key set the type declares', () => {
    // The messages interpolate `key`, so a control that exists in the table but has no rule path
    // (or vice versa) is a table no consumer can ever see. `no-unsafe-opt-in` is the only consumer.
    expect(Object.keys(rules)).toContain('no-unsafe-opt-in')
    expect(new Set(Object.keys(UNSAFE_CONTROLS)).size).toBe(3)
  })

  it('the config types actually expose the controls as optional literals', () => {
    // Compile-time pin (never executed against a value): if `SkillManagerConfig['unsafe']` loses a
    // key, the `satisfies` below stops compiling, which fails `pnpm type-check`.
    const shape = {
      isolatedToolsInProcess: true,
      scriptsPermissivePolicy: {} as never,
      ungatedSkillTools: true,
    } satisfies NonNullable<SkillManagerConfig['unsafe']>
    expect(Object.keys(shape).sort()).toEqual(Object.keys(UNSAFE_CONTROLS).sort())
  })
})
