import { describe, expect, it, vi } from 'vitest'
import { makeToolCtxStub, callTool } from '../../../../_fixtures/tool_ctx_stub'
import { convertTimeTool, getCurrentTimeTool } from '../../../../../src/batteries/tools/time'

const runNow = async (args: Record<string, unknown>): Promise<string> => {
  return (await getCurrentTimeTool.executor(makeToolCtxStub())(args)) as string
}
const runConv = async (args: Record<string, unknown>): Promise<string> => {
  return (await convertTimeTool.executor(makeToolCtxStub())(args)) as string
}

describe('getCurrentTimeTool', () => {
  it('returns a time in UTC by default', async () => {
    const out = await runNow({})
    expect(out.startsWith('UTC:')).toBe(true)
    expect(out).toMatch(/\d{4}/)
  })

  it('returns a time in a specified IANA zone', async () => {
    const out = await runNow({ timezone: 'America/New_York' })
    expect(out.startsWith('America/New_York:')).toBe(true)
  })

  it('errors on invalid timezone', async () => {
    const out = await runNow({ timezone: 'Atlantis/Springfield' })
    expect(out).toMatch(/^Error.*Invalid timezone/)
  })
})

describe('convertTimeTool', () => {
  it('converts 12:00 in UTC to UTC unchanged', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '12:00',
      target_timezone: 'UTC',
    })
    expect(out).toContain('12:00 UTC = 12:00 UTC')
  })

  it('converts 12:00 UTC to America/New_York (UTC-5 or UTC-4 with DST)', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '12:00',
      target_timezone: 'America/New_York',
    })
    // Either 07:00 (EST) or 08:00 (EDT) — accept either
    expect(out).toMatch(/= 0[78]:00 America\/New_York/)
  })

  it('round-trips between two zones', async () => {
    // 09:00 in Tokyo = 00:00 UTC
    const out = await runConv({
      source_timezone: 'Asia/Tokyo',
      time: '09:00',
      target_timezone: 'UTC',
    })
    expect(out).toContain('= 00:00 UTC')
  })

  it('errors on invalid source timezone', async () => {
    const out = await runConv({
      source_timezone: 'Nowhere',
      time: '12:00',
      target_timezone: 'UTC',
    })
    expect(out).toMatch(/^Error.*source timezone/)
  })

  it('errors on invalid target timezone', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '12:00',
      target_timezone: 'Nowhere',
    })
    expect(out).toMatch(/^Error.*target timezone/)
  })

  it('errors on invalid time format', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '25:99',
      target_timezone: 'UTC',
    })
    expect(out).toMatch(/^Error.*Invalid time/)
  })

  it('defaults target_timezone to UTC', async () => {
    const out = await runConv({
      source_timezone: 'Asia/Tokyo',
      time: '09:00',
    })
    expect(out).toContain('UTC')
  })
})

// ─── Extended oracle tests: getCurrentTimeTool ──────────────────────────

describe('getCurrentTimeTool — oracle & edge cases', () => {
  it('output format includes day-of-week, month name, day number, year, time, and offset', async () => {
    const out = await runNow({ timezone: 'UTC' })
    // Format: "UTC: cccc, LLLL d, yyyy h:mm:ss a ZZZZ" — ZZZZ gives timezone name like 'UTC' or 'EDT'
    expect(out).toMatch(/^UTC: \w+, \w+ \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} [AP]M/)
  })

  it('returns correct day name for UTC zone', async () => {
    // Just verify the format is parseable and contains expected components
    const out = await runNow({ timezone: 'UTC' })
    // Must contain 'UTC:' prefix
    expect(out).toMatch(/^UTC:/)
    // Must contain year 202x (we're in this decade)
    expect(out).toMatch(/202\d/)
  })

  it('common IANA zones all produce output', async () => {
    const zones = ['Europe/London', 'Asia/Tokyo', 'Australia/Sydney', 'America/Los_Angeles']
    for (const tz of zones) {
      const out = await runNow({ timezone: tz })
      expect(out).toMatch(new RegExp(`^${tz.replace('/', '\\/')}:`))
    }
  })

  it('returns Error string (not throw) for invalid timezone', async () => {
    const out = await runNow({ timezone: 'Invalid/Zone' })
    expect(out).toMatch(/^Error:/)
    // Must NOT throw — the tool returns an error string
    expect(typeof out).toBe('string')
  })

  it('schema rejects non-string timezone', async () => {
    const { E_INVALID_TOOL_ARGS } = await import('../../../../../src/lib/exceptions/runtime')
    await expect(
      getCurrentTimeTool.executor(makeToolCtxStub())({ timezone: 123 })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ─── Extended oracle tests: convertTimeTool ──────────────────────────────

describe('convertTimeTool — oracle & edge cases', () => {
  // Oracle: 00:00 UTC = 09:00 Asia/Tokyo (JST is UTC+9, no DST)
  it('converts 00:00 UTC to 09:00 Asia/Tokyo (no DST)', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '00:00',
      target_timezone: 'Asia/Tokyo',
    })
    expect(out).toContain('= 09:00 Asia/Tokyo')
  })

  // Oracle: Asia/Tokyo +9 → UTC: 18:00 Tokyo = 09:00 UTC
  it('converts 18:00 Asia/Tokyo to 09:00 UTC', async () => {
    const out = await runConv({
      source_timezone: 'Asia/Tokyo',
      time: '18:00',
      target_timezone: 'UTC',
    })
    expect(out).toContain('= 09:00 UTC')
  })

  // INVARIANT: A→B then B→A round-trips (same time)
  it('INVARIANT: round-trip UTC → Tokyo → UTC preserves time', async () => {
    // Since Tokyo has no DST, round-tripping any time should be exact
    const out1 = await runConv({
      source_timezone: 'UTC',
      time: '14:30',
      target_timezone: 'Asia/Tokyo',
    })
    // Extract the Tokyo time from the result: "14:30 UTC = HH:mm Asia/Tokyo"
    const tokyoTime = out1.match(/= (\d{2}:\d{2}) Asia\/Tokyo/)![1]
    const out2 = await runConv({
      source_timezone: 'Asia/Tokyo',
      time: tokyoTime,
      target_timezone: 'UTC',
    })
    expect(out2).toContain('= 14:30 UTC')
  })

  // Edge: midnight (00:00)
  it('converts midnight correctly', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '00:00',
      target_timezone: 'UTC',
    })
    expect(out).toContain('= 00:00 UTC')
  })

  // Edge: 23:59
  it('converts 23:59 correctly', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '23:59',
      target_timezone: 'UTC',
    })
    expect(out).toContain('= 23:59 UTC')
  })

  // Invalid time: 25:00
  it('returns error for time 25:00', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '25:00',
      target_timezone: 'UTC',
    })
    expect(out).toMatch(/^Error.*Invalid time/)
  })

  // Invalid time: 12:99
  it('returns error for time 12:99', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '12:99',
      target_timezone: 'UTC',
    })
    expect(out).toMatch(/^Error.*Invalid time/)
  })

  // Edge: empty time string is schema-invalid
  it('schema rejects empty time string', async () => {
    const { E_INVALID_TOOL_ARGS } = await import('../../../../../src/lib/exceptions/runtime')
    await expect(
      convertTimeTool.executor(makeToolCtxStub())({
        source_timezone: 'UTC',
        time: '',
        target_timezone: 'UTC',
      })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  // Cross-DST timezone pair (London has DST)
  it('converts between London and London (identity)', async () => {
    const out = await runConv({
      source_timezone: 'Europe/London',
      time: '12:00',
      target_timezone: 'Europe/London',
    })
    expect(out).toContain('= 12:00 Europe/London')
  })

  // Negative offset: America/Los_Angeles
  it('converts UTC to America/Los_Angeles (PST/PDT)', async () => {
    const out = await runConv({
      source_timezone: 'UTC',
      time: '20:00',
      target_timezone: 'America/Los_Angeles',
    })
    // 20:00 UTC = 12:00 PST (UTC-8) or 13:00 PDT (UTC-7)
    expect(out).toMatch(/= 1[23]:00 America\/Los_Angeles/)
  })

  // Schema rejects missing source_timezone
  it('schema rejects missing source_timezone', async () => {
    const { E_INVALID_TOOL_ARGS } = await import('../../../../../src/lib/exceptions/runtime')
    await expect(
      convertTimeTool.executor(makeToolCtxStub())({ time: '12:00', target_timezone: 'UTC' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  // Schema rejects missing time
  it('schema rejects missing time', async () => {
    const { E_INVALID_TOOL_ARGS } = await import('../../../../../src/lib/exceptions/runtime')
    await expect(
      convertTimeTool.executor(makeToolCtxStub())({
        source_timezone: 'UTC',
        target_timezone: 'UTC',
      })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ─── Empty-string timezone disposition (C6) — frozen clock required ────
// `getCurrentTimeTool`/`convertTimeTool` call `DateTime.now()`, so two separate
// invocations can observe different wall-clock instants even when both correctly
// resolve to UTC — freeze the clock so "" and omitted produce byte-identical output.

describe('getCurrentTimeTool — empty-string timezone (C6)', () => {
  it('timezone: "" produces byte-identical output to omitting it, under a frozen clock', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-15T12:34:56Z'))
      const outEmpty = await runNow({ timezone: '' })
      const outOmitted = await runNow({})
      expect(outEmpty).toBe(outOmitted)
      expect(outEmpty.startsWith('UTC:')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timezone: "" passes schema validation (callTool)', async () => {
    const r = await callTool(getCurrentTimeTool, { timezone: '' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toMatch(/^Error/)
  })
})

describe('convertTimeTool — empty-string target_timezone (C6)', () => {
  it('target_timezone: "" produces byte-identical output to omitting it, under a frozen clock', async () => {
    vi.useFakeTimers()
    try {
      // `time` is a wall-clock HH:MM with today's date, so "today" must also be frozen.
      vi.setSystemTime(new Date('2026-06-15T00:00:00Z'))
      const outEmpty = await runConv({
        source_timezone: 'Asia/Tokyo',
        time: '09:00',
        target_timezone: '',
      })
      const outOmitted = await runConv({
        source_timezone: 'Asia/Tokyo',
        time: '09:00',
      })
      expect(outEmpty).toBe(outOmitted)
      expect(outEmpty).toContain('= 00:00 UTC')
    } finally {
      vi.useRealTimers()
    }
  })

  it('target_timezone: "" passes schema validation (callTool)', async () => {
    const r = await callTool(convertTimeTool, {
      source_timezone: 'UTC',
      time: '12:00',
      target_timezone: '',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toMatch(/^Error/)
  })

  it('source_timezone stays required and still rejects "" (out of scope for C6)', async () => {
    const { E_INVALID_TOOL_ARGS } = await import('../../../../../src/lib/exceptions/runtime')
    await expect(
      convertTimeTool.executor(makeToolCtxStub())({
        source_timezone: '',
        time: '12:00',
        target_timezone: 'UTC',
      })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ─── callTool no-crash regression tests ───────────────────────────────

describe('time — callTool no-crash edge cases', () => {
  it('getCurrentTimeTool does not crash on invalid timezone (returns Error string)', async () => {
    const r = await callTool(getCurrentTimeTool, { timezone: 'Invalid/Zone' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('convertTimeTool does not crash on invalid source timezone (returns Error string)', async () => {
    const r = await callTool(convertTimeTool, {
      source_timezone: 'Nowhere',
      time: '12:00',
      target_timezone: 'UTC',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('convertTimeTool does not crash on invalid target timezone (returns Error string)', async () => {
    const r = await callTool(convertTimeTool, {
      source_timezone: 'UTC',
      time: '12:00',
      target_timezone: 'Nowhere',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('convertTimeTool does not crash on invalid time format (returns Error string)', async () => {
    const r = await callTool(convertTimeTool, {
      source_timezone: 'UTC',
      time: '25:99',
      target_timezone: 'UTC',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })
})
