/**
 * Fuzz harness for every bundled tool.
 *
 * @module fuzz.node.spec
 *
 * @remarks
 * This file runs ONLY in Node (`.node.spec.ts` suffix). It imports every tool from the barrel,
 * reads each tool's `.describe().inputSchema` to discover required keys, their types, and
 * `valid` enums, then generates a corpus of adversarial-but-schema-shaped inputs.
 *
 * INVARIANT under test: every call to `tool.executor(ctx)(args)` must either:
 *   - resolve to a `string | Uint8Array` (happy path or graceful error string like "Error: ..."),
 *   - reject with `E_INVALID_TOOL_ARGS` (schema violation),
 *
 * ANY other rejection (e.g. `E_TOOL_DOWNSTREAM_ERROR`) or a handler returning
 * `undefined`/non-string/non-Uint8Array is a DEFECT.
 */

import { describe, expect, it } from 'vitest'
import { Tool } from '../../../../src/lib/classes/tool'
import * as tools from '../../../../src/batteries/tools'
import { callTool } from '../../../_fixtures/tool_ctx_stub'

// ─── Collect all Tool instances from the barrel ──────────────────────────
// eslint-disable-next-line adk/use-is-instance-of -- test introspection over the same-realm module exports
const allTools: Tool[] = Object.values(tools).filter((v): v is Tool => v instanceof Tool) as Tool[]

// ─── Adversarial input generators ───────────────────────────────────────

const STRING_CORPUS: string[] = [
  '', // empty
  ' ', // whitespace only
  '\t\n\r', // control whitespace
  '\n', // lone newline
  '\uD800', // lone high surrogate
  '\uDC00', // lone low surrogate
  'a\u0308', // combining mark (NFD ä)
  'ä', // precomposed (NFC ä)
  '💥', // astral emoji (surrogate pair in JS)
  '🎉🎊', // multiple emoji
  '\u200B', // zero-width space
  '\u200D', // zero-width joiner
  '\uFEFF', // BOM
  '\0', // null byte
  'a\0b', // embedded null
  'hello\nworld', // embedded newline
  'a\tb', // embedded tab
  '<script>alert(1)</script>', // HTML metacharacters
  '"quotes"', // double quotes
  "'single'", // single quotes
  'a,b\nc\td', // CSV metacharacters
  '{"key":"val"}', // JSON-like
  '{"__proto__":"polluted"}', // prototype pollution attempt
  '\\', // lone backslash
  'a'.repeat(100), // medium string
  'a'.repeat(10000), // large string (capped at ~100k)
]

const NUMERIC_EXTREMES: number[] = [
  0,
  -0, // negative zero
  1,
  -1,
  0.1 + 0.2, // floating-point imprecision
  42,
  100,
  -100,
  Number.MAX_SAFE_INTEGER, // 2^53 - 1 — trips String.repeat/padStart overflow
  Number.MIN_SAFE_INTEGER,
  2 ** 53, // beyond safe integer
  1e9, // huge — trips unclamped String.repeat/padStart (format_list indent)
  1e308, // very large
  -1e308, // very large negative
  1e-308, // very small positive
  -1e-308, // very small negative
  Infinity,
  -Infinity,
  Number.NaN,
]

// JSON payloads for keys named data/data_a/data_b/numbers/x/y/record_a/record_b
const JSON_PAYLOADS: string[] = [
  '[]',
  '[null]', // null elements (trips format_table)
  '[1,2,3]', // primitive rows (trips format_table)
  '[1,"two",3]', // mixed primitive rows
  '[{}]', // empty objects
  '[{"a":1}]', // single-key objects
  '{}',
  '{"a":1}',
  'not json',
  'null', // top-level null
  '"just a string"', // top-level string
  '42', // top-level number
  JSON.stringify(Array.from({ length: 100 }, (_, i) => i)), // big array
]

// ─── Helper: extract keys, types, valids from schema description ────────

interface SchemaInfo {
  key: string
  type: string
  valids: unknown[]
  required: boolean
  defaultVal: unknown
  hasDefault: boolean
}

function extractSchemaInfo(tool: Tool): SchemaInfo[] {
  const desc = tool.describe().inputSchema
  if (desc.type !== 'object' || !desc.keys) return []
  const infos: SchemaInfo[] = []
  for (const [key, val] of Object.entries(desc.keys as Record<string, any>)) {
    const v = val as Record<string, any>
    infos.push({
      key,
      type: v.type ?? 'any',
      valids: Array.isArray(v.valids)
        ? v.valids
        : Array.isArray(v.allow)
          ? (v.allow as unknown[]).filter(
              (a: unknown) => a !== undefined && a !== null && typeof a !== 'object'
            )
          : [],
      required: v.flags?.presence === 'required',
      defaultVal: v.flags?.default,
      hasDefault: v.flags?.default !== undefined,
    })
  }
  return infos
}

// ─── Build args for a single required-key assignment ────────────────────

function buildArg(
  requiredKeys: SchemaInfo[],
  focusKey: string,
  focusValue: unknown
): Record<string, unknown> {
  const arg: Record<string, unknown> = {}
  for (const other of requiredKeys) {
    arg[other.key] = other.key === focusKey ? focusValue : generateDefaultishValue(other)
  }
  return arg
}

function buildArgAll(
  requiredKeys: SchemaInfo[],
  optionalKeys: SchemaInfo[],
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const arg: Record<string, unknown> = {}
  for (const r of requiredKeys) arg[r.key] = generateDefaultishValue(r)
  for (const o of optionalKeys) {
    if (o.hasDefault) arg[o.key] = o.defaultVal
  }
  Object.assign(arg, overrides)
  return arg
}

// ─── Generate adversarial args for a tool ───────────────────────────────

function generateArgs(tool: Tool): unknown[] {
  const infos = extractSchemaInfo(tool)
  if (infos.length === 0) return [{}] // no schema info, just try empty

  const requiredKeys = infos.filter((i) => i.required)
  const optionalKeys = infos.filter((i) => !i.required)
  const allKeys = infos

  const args: unknown[] = []

  // ── 1. Valid-ish inputs: each required key with value variants ──────
  for (const info of requiredKeys) {
    const valueVariants = generateValueVariants(info)
    for (const val of valueVariants) {
      args.push(buildArg(requiredKeys, info.key, val))
    }
  }

  // ── 2. Schema-invalid: missing each required key ───────────────────
  for (const info of requiredKeys) {
    const arg: Record<string, unknown> = {}
    for (const other of requiredKeys) {
      if (other.key !== info.key) arg[other.key] = generateDefaultishValue(other)
    }
    args.push(arg)
  }

  // ── 3. Schema-invalid: wrong type for each required key ────────────
  for (const info of requiredKeys) {
    if (info.type === 'string') {
      args.push(buildArg(requiredKeys, info.key, 12345))
    } else if (info.type === 'number') {
      args.push(buildArg(requiredKeys, info.key, 'not-a-number'))
    } else if (info.type === 'boolean') {
      args.push(buildArg(requiredKeys, info.key, 'not-a-bool'))
    } else if (info.type === 'array') {
      args.push(buildArg(requiredKeys, info.key, 'not-an-array'))
    }
  }

  // ── 4. Numeric extremes for number keys (including 1e9, MAX_SAFE_INTEGER) ─
  for (const info of requiredKeys) {
    if (info.type === 'number') {
      for (const num of NUMERIC_EXTREMES) {
        args.push(buildArg(requiredKeys, info.key, num))
      }
    }
  }

  // ── 5. Numeric extremes for OPTIONAL number keys (e.g. indent, min_decimals) ─
  for (const opt of optionalKeys) {
    if (opt.type === 'number') {
      for (const num of NUMERIC_EXTREMES) {
        args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: num }))
      }
    }
  }

  // ── 6. String corpus for free-text string keys ─────────────────────
  for (const info of requiredKeys) {
    if (info.type === 'string' && info.valids.length === 0) {
      for (const str of STRING_CORPUS) {
        args.push(buildArg(requiredKeys, info.key, str))
      }
    }
  }

  // ── 7. String corpus for OPTIONAL free-text string keys ─────────────
  for (const opt of optionalKeys) {
    if (opt.type === 'string' && opt.valids.length === 0) {
      for (const str of STRING_CORPUS.slice(0, 10)) {
        args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: str }))
      }
    }
  }

  // ── 8. Enum values + invalid enum ──────────────────────────────────
  for (const info of requiredKeys) {
    if (info.valids.length > 0) {
      for (const v of info.valids) {
        args.push(buildArg(requiredKeys, info.key, v))
      }
      args.push(buildArg(requiredKeys, info.key, '__INVALID_ENUM__'))
    }
  }
  for (const opt of optionalKeys) {
    if (opt.valids.length > 0) {
      for (const v of opt.valids) {
        args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: v }))
      }
      args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: '__INVALID_ENUM__' }))
    }
  }

  // ── 9. JSON payloads for data/numbers/x/y/record_a/record_b/data_a/data_b ─
  const jsonKeyPattern = /^(data|numbers?|x|y|record_[ab]|data_[ab]|text_a|text_b|a|b)$/
  const jsonKeys = allKeys.filter((i) => jsonKeyPattern.test(i.key) && i.type === 'string')
  for (const info of jsonKeys) {
    for (const payload of JSON_PAYLOADS) {
      if (info.required) {
        args.push(buildArg(requiredKeys, info.key, payload))
      } else {
        args.push(buildArgAll(requiredKeys, optionalKeys, { [info.key]: payload }))
      }
    }
  }

  // ── 10. Operations pipeline for 'operations' key ───────────────────
  const opsKeys = allKeys.filter((i) => i.key === 'operations')
  for (const info of opsKeys) {
    args.push(buildArg(requiredKeys, info.key, [{ op: 'sort' }, { op: 'reverse' }]))
    args.push(buildArg(requiredKeys, info.key, []))
  }

  // ── 11. Optional boolean keys: true/false ──────────────────────────
  for (const opt of optionalKeys) {
    if (opt.type === 'boolean') {
      args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: true }))
      args.push(buildArgAll(requiredKeys, optionalKeys, { [opt.key]: false }))
    }
  }

  // ── 12. Array-typed keys with adversarial contents ─────────────────
  for (const info of requiredKeys) {
    if (info.type === 'array') {
      args.push(buildArg(requiredKeys, info.key, []))
      args.push(buildArg(requiredKeys, info.key, [null]))
      args.push(buildArg(requiredKeys, info.key, [1, 2, 3]))
      args.push(buildArg(requiredKeys, info.key, ['']))
      args.push(buildArg(requiredKeys, info.key, ['\uD800']))
    }
  }

  // ── Deduplicate ────────────────────────────────────────────────────
  const seen = new Set<string>()
  return args.filter((arg) => {
    let key: string
    try {
      key = JSON.stringify(arg)
    } catch {
      key = String(arg)
    }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function generateValueVariants(info: SchemaInfo): unknown[] {
  const variants: unknown[] = []

  if (info.valids.length > 0) {
    variants.push(...info.valids)
  }

  switch (info.type) {
    case 'string':
      variants.push('hello', 'test', '', ' ', '\n', '\uD800', '💥', '\uFEFF', 'a'.repeat(50))
      break
    case 'number':
      variants.push(
        0,
        1,
        -1,
        0.5,
        100,
        -100,
        0.1 + 0.2,
        Infinity,
        -Infinity,
        Number.NaN,
        Number.MAX_SAFE_INTEGER,
        1e9 // trips unclamped String.repeat / padStart
      )
      break
    case 'boolean':
      variants.push(true, false)
      break
    case 'array':
      variants.push([], [1], ['a'], [null])
      break
    case 'object':
      variants.push({}, { key: 'val' })
      break
  }

  return variants
}

function generateDefaultishValue(info: SchemaInfo): unknown {
  if (info.valids.length > 0) return info.valids[0]

  switch (info.type) {
    case 'string':
      return 'test'
    case 'number':
      return 1
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return 'test'
  }
}

// ─── The fuzz test ──────────────────────────────────────────────────────

describe('Fuzz: all bundled tools handle adversarial input without crashing', () => {
  it('every tool either resolves or rejects with E_INVALID_TOOL_ARGS', async () => {
    const failures: Array<{
      tool: string
      args: unknown
      kind: string
      detail: string
    }> = []

    for (const tool of allTools) {
      const argList = generateArgs(tool)
      // Cap total calls per tool to keep runtime manageable
      const cappedArgs = argList.slice(0, 400)

      for (const args of cappedArgs) {
        const r = await callTool(tool, args)

        if (r.kind === 'threw') {
          if (r.errorName !== 'E_INVALID_TOOL_ARGS') {
            // E_TOOL_DOWNSTREAM_ERROR or other unexpected throw — DEFECT
            failures.push({
              tool: tool.name,
              args,
              kind: 'unexpected-throw',
              detail: `${r.errorName}: ${r.message}`,
            })
          }
          // E_INVALID_TOOL_ARGS is acceptable — schema violation
        } else {
          // Resolved — check the result is actually a string or Uint8Array
          const outVal = r.out as unknown
          // eslint-disable-next-line adk/use-is-instance-of -- same-realm check of a tool's own return value
          if (typeof outVal !== 'string' && !(outVal instanceof Uint8Array)) {
            failures.push({
              tool: tool.name,
              args,
              kind: 'bad-return-type',
              detail: `handler returned ${typeof r.out} instead of string/Uint8Array`,
            })
          }
          // Also catch handlers that return actual `undefined` (which callTool
          // coerces to the string "undefined" — but the raw value before coercion
          // is the real problem). We check if r.out is literally "undefined" as a
          // hint, but the real check is that the executor resolved with a value
          // that is not a proper string result.
        }
      }
    }

    // Report all failures in a readable format
    if (failures.length > 0) {
      const details = failures
        .map((t, i) => {
          const argsPreview = JSON.stringify(t.args)?.slice(0, 200)
          return `\n[${i + 1}] Tool: ${t.tool}\n    Kind: ${t.kind}\n    Args: ${argsPreview}\n    Detail: ${t.detail}`
        })
        .join('\n')
      expect(
        failures,
        `Found ${failures.length} defect(s) where a tool threw E_TOOL_DOWNSTREAM_ERROR or returned non-string/undefined instead of a graceful error string:${details}`
      ).toEqual([])
    } else {
      expect(failures).toEqual([])
    }
  })

  it('discovers all tool instances from the barrel', () => {
    expect(allTools.length).toBeGreaterThan(0)
    const toolNames = allTools.map((t) => t.name).sort()
    // Just verify we got a reasonable number of tools
    expect(toolNames.length).toBeGreaterThanOrEqual(30)
  })
})

// ─── Targeted known-bug assertions ────────────────────────────────────
// These tests assert the CORRECT behaviour; they are EXPECTED to go RED
// until the bugs are fixed.

describe('Fuzz: known bug regressions (EXPECTED-RED until fixed)', () => {
  it('format_list: huge indent (1e9) must NOT crash', async () => {
    const r = await callTool(tools.formatListTool, { items: ['a'], indent: 1e9 })
    // The tool should either resolve (graceful clamp) or reject with E_INVALID_TOOL_ARGS.
    // Currently it throws E_TOOL_DOWNSTREAM_ERROR because ' '.repeat(1e9) exceeds string limit.
    expect(r.kind).toBe('resolved') // EXPECTED-RED: currently throws
  })

  it('format_table: [null] row data must NOT crash', async () => {
    const r = await callTool(tools.formatTableTool, { data: '[null]', format: 'markdown' })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: currently crashes on null row cast
  })

  it('format_table: primitive row [1,2] with explicit columns must NOT crash', async () => {
    const r = await callTool(tools.formatTableTool, {
      data: '[1,2]',
      format: 'markdown',
      columns: ['a', 'b'],
    })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: currently crashes on primitive row cast
  })

  it('format_table: null row [null] with explicit columns must NOT crash', async () => {
    const r = await callTool(tools.formatTableTool, {
      data: '[null]',
      format: 'markdown',
      columns: ['a'],
    })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: null['a"] throws TypeError
  })

  it('parse_yaml: whitespace-only " " must resolve to a string', async () => {
    const r = await callTool(tools.parseYamlTool, { text: ' ' })
    // js-yaml parses whitespace to undefined; handler returns actual undefined (not a string)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED: handler returns actual undefined
    }
  })

  it('parse_yaml: lone newline "\\n" must resolve to a string', async () => {
    const r = await callTool(tools.parseYamlTool, { text: '\n' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED
    }
  })

  it('parse_yaml: BOM "\\uFEFF" must resolve to a string', async () => {
    const r = await callTool(tools.parseYamlTool, { text: '\uFEFF' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED
    }
  })
})
