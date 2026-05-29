import { describe, expect, it } from 'vitest'
import { Tokenizable } from '../../../../../src/lib/classes/tokenizable'
import {
  addStandingInstructionTool,
  listStandingInstructionsTool,
  removeStandingInstructionTool,
  standingInstructionTools,
} from '../../../../../src/batteries/tools/standing_instructions'
import type { DispatchContext } from '../../../../../src/lib/contracts/dispatch_context'

interface CtxStubState {
  items: (string | Tokenizable)[]
  stored: (string | Tokenizable)[]
  deleted: (string | Tokenizable)[]
}

const makeCtxStub = (
  initial: (string | Tokenizable)[] = []
): { ctx: DispatchContext; state: CtxStubState } => {
  const state: CtxStubState = {
    items: [...initial],
    stored: [],
    deleted: [],
  }
  const toStr = (v: string | Tokenizable) => (typeof v === 'string' ? v : v.toString())
  const ctx = {
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
    refreshStandingInstructions: async () => state.items,
    storeStandingInstruction: async (v: string | Tokenizable) => {
      state.stored.push(v)
      if (!state.items.some((existing) => toStr(existing) === toStr(v))) {
        state.items.push(v)
      }
    },
    deleteStandingInstruction: async (v: string | Tokenizable) => {
      state.deleted.push(v)
      state.items = state.items.filter((existing) => toStr(existing) !== toStr(v))
    },
  } as unknown as DispatchContext
  return { ctx, state }
}

describe('listStandingInstructionsTool', () => {
  it('has name `list_standing_instructions`', () => {
    expect(listStandingInstructionsTool.name).toBe('list_standing_instructions')
  })

  it('returns a JSON array of standing-instruction strings', async () => {
    const { ctx } = makeCtxStub(['one', 'two'])
    const result = await listStandingInstructionsTool.executor(ctx)({})
    expect(JSON.parse(result as string)).toEqual(['one', 'two'])
  })

  it('serialises Tokenizable instances as their string content', async () => {
    const { ctx } = makeCtxStub([new Tokenizable('tokenizable-one'), 'plain'])
    const result = await listStandingInstructionsTool.executor(ctx)({})
    expect(JSON.parse(result as string)).toEqual(['tokenizable-one', 'plain'])
  })

  it('returns `[]` when no instructions are present', async () => {
    const { ctx } = makeCtxStub()
    const result = await listStandingInstructionsTool.executor(ctx)({})
    expect(JSON.parse(result as string)).toEqual([])
  })
})

describe('addStandingInstructionTool', () => {
  it('has name `add_standing_instruction`', () => {
    expect(addStandingInstructionTool.name).toBe('add_standing_instruction')
  })

  it('persists a new standing instruction', async () => {
    const { ctx, state } = makeCtxStub()
    const result = await addStandingInstructionTool.executor(ctx)({
      content: 'always reply in JSON',
    })
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual({ ok: true, content: 'always reply in JSON' })
    expect(state.stored).toEqual(['always reply in JSON'])
  })

  it('rejects an empty content string', async () => {
    const { ctx } = makeCtxStub()
    await expect(addStandingInstructionTool.executor(ctx)({ content: '' })).rejects.toThrow()
  })

  it('returns an error string when storeStandingInstruction throws', async () => {
    const ctx = {
      id: 'turn-1',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
      storeStandingInstruction: async () => {
        throw new Error('persistence error')
      },
    } as unknown as DispatchContext
    const result = await addStandingInstructionTool.executor(ctx)({ content: 'x' })
    expect(result).toMatch(/^Error: /)
  })
})

describe('removeStandingInstructionTool', () => {
  it('has name `remove_standing_instruction`', () => {
    expect(removeStandingInstructionTool.name).toBe('remove_standing_instruction')
  })

  it('delegates to ctx.deleteStandingInstruction', async () => {
    const { ctx, state } = makeCtxStub(['one', 'two'])
    const result = await removeStandingInstructionTool.executor(ctx)({ content: 'one' })
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual({ ok: true, content: 'one' })
    expect(state.deleted).toEqual(['one'])
  })

  it('is idempotent when the content is unknown', async () => {
    const { ctx, state } = makeCtxStub(['one'])
    const result = await removeStandingInstructionTool.executor(ctx)({ content: 'missing' })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(state.deleted).toEqual(['missing'])
  })
})

describe('standingInstructionTools tuple', () => {
  it('contains every standing-instruction tool in declaration order', () => {
    expect(standingInstructionTools).toEqual([
      listStandingInstructionsTool,
      addStandingInstructionTool,
      removeStandingInstructionTool,
    ])
  })
})
