import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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
