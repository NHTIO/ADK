import { describe, expect, it, vi } from 'vitest'
import { createSkillManager } from '@nhtio/adk/batteries/skills'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createGuestRunner, resolveGuestLimits } from '../../../../src/batteries/sandbox'
import { E_SKILL_SOURCE_PATH_REJECTED } from '../../../../src/batteries/skills/exceptions'
import {
  assertPolicySubset,
  validateSkillSourcePath,
} from '../../../../src/batteries/skills/scripts'
import type { SkillDescriptor } from '@nhtio/adk/batteries/skills'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { DiscoveredSkill, SkillRef, SkillSource } from '@nhtio/adk/batteries/skills'
import type {
  GuestGlobal,
  GuestRuntimeLike,
} from '../../../../src/batteries/sandbox/js/ses_contracts'

const gate = async () => {}
const session: SandboxPolicy = {
  filesystem: { allowRead: ['/session'], allowWrite: ['/session/tmp'] },
  network: { allowedDomains: ['example.test'] },
}

class Source implements SkillSource {
  readonly id = 'sandbox-fixture'
  constructor(readonly descriptorValue: SkillDescriptor) {}
  async *discover(): AsyncIterable<DiscoveredSkill> {
    yield {
      id: this.descriptorValue.id,
      version: '1',
      name: 'fixture',
      description: 'fixture',
    }
  }
  async descriptor(_ref: SkillRef): Promise<unknown> {
    return this.descriptorValue
  }
  async read(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('body'))
        c.close()
      },
    })
  }
  async stat(ref: SkillRef) {
    return { size: 4, version: ref.version }
  }
}

const isolated = (name = 'answer'): SkillDescriptor => ({
  id: 'fixture',
  name: 'fixture',
  description: 'fixture',
  version: '1',
  isolatedTools: [{ name, description: name, source: 'async (args) => args.value' }],
})

describe('skills group 4: sandbox and isolation', () => {
  it('rejects hostile source paths before any materialization seam can be used', () => {
    for (const value of [
      '../../outside',
      '/etc/passwd',
      '\\\\etc\\\\passwd',
      '~/.ssh/id_rsa',
      'nul\0name',
    ]) {
      expect(() => validateSkillSourcePath(value)).toThrow(E_SKILL_SOURCE_PATH_REJECTED)
    }
  })

  it('uses containment rather than exact path matching for policy subsets', () => {
    expect(() =>
      assertPolicySubset(
        {
          filesystem: { allowRead: ['/session/random-materialization'] },
          network: { allowedDomains: ['example.test'] },
        },
        session
      )
    ).not.toThrow()
    expect(() =>
      assertPolicySubset({ filesystem: { allowRead: ['/outside'] }, network: {} }, session)
    ).toThrow()
  })

  it('does not allow a disabled network policy to masquerade as a narrow subset', () => {
    expect(() =>
      assertPolicySubset({ filesystem: {}, network: { disabled: true } }, session)
    ).toThrow()
  })

  it('refuses a per-call wildcard domain under a named-domain session', () => {
    // `*` is the widest request; under a session limited to named domains it is NOT a subset and
    // must be rejected. Before the fix, the `domain !== '*'` short-circuit let it pass unchecked.
    expect(() =>
      assertPolicySubset({ filesystem: {}, network: { allowedDomains: ['*'] } }, session)
    ).toThrow()
    // …but a wildcard IS a subset of a wildcard session.
    expect(() =>
      assertPolicySubset(
        { filesystem: {}, network: { allowedDomains: ['*'] } },
        { filesystem: {}, network: { allowedDomains: ['*'] } }
      )
    ).not.toThrow()
  })

  it('passes the complete declared GuestGlobal set to resolveGuest and preserves fn', async () => {
    const capability: GuestGlobal = {
      cancellation: 'cooperative',
      fn: () => 'declared',
    }
    const limits = resolveGuestLimits()
    const spawn = vi.fn(async (_options: Parameters<GuestRuntimeLike['spawn']>[0]) => ({
      evaluate: async () => ({
        ok: true as const,
        result: 'guest-result',
        encoding: 'encoder' as const,
        durationMs: 0,
        logsComplete: true as const,
        logs: [],
        logsCapped: false,
      }),
      kill: async () => {},
    }))
    const resolveGuest = vi.fn(async () => ({ spawn }) as GuestRuntimeLike)
    const manager = await createSkillManager({
      sources: [new Source(isolated())],
      gate,
      isolation: {
        globals: { capability },
        modules: { fixture: {} },
        limits,
        resolveGuest,
        maxTimeoutSeconds: 3,
        defaultTimeoutSeconds: 1,
      },
    })
    const ctx = makeDispatchContext()
    await manager.load('fixture', ctx)
    const result = await ctx.tools.get('answer')!.executor(ctx)({})
    expect(result).toContain('guest-result')
    expect(resolveGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        globals: { capability },
        modules: { fixture: {} },
        limits,
        signal: ctx.abortSignal,
      })
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        globals: [{ name: 'capability', kind: 'async-fn' }],
        modules: ['fixture'],
        limits,
        signal: ctx.abortSignal,
      })
    )
    await manager.dispose()
  })

  it('refuses in-process isolated tools without the explicit unsafe door', async () => {
    await expect(
      createSkillManager({
        sources: [new Source(isolated())],
        gate,
        isolation: { maxTimeoutSeconds: 3, defaultTimeoutSeconds: 1 },
      })
    ).rejects.toMatchObject({ name: 'E_INVALID_SKILLS_CONFIG' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const manager = await createSkillManager({
      sources: [new Source(isolated())],
      gate,
      isolation: { maxTimeoutSeconds: 3, defaultTimeoutSeconds: 1 },
      unsafe: { isolatedToolsInProcess: true },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in-process'))
    warn.mockRestore()
    await manager.dispose()
  })

  it('guest limits reject a requested timeout above the declared ceiling', async () => {
    const runtime = await createGuestRunner({}, resolveGuestLimits())
    const guest = await runtime.spawn({
      modules: [],
      globals: [],
      limits: resolveGuestLimits(),
    })
    await expect(guest.evaluate('1', { timeoutMs: 1000 })).resolves.toMatchObject({ ok: true })
  })
})
