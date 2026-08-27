import { describe, expect, it, vi, afterEach } from 'vitest'
import { validateOptions } from '../../../../../src/batteries/llm/claude_code_cli/validation'
import { E_INVALID_CLAUDE_CODE_CLI_OPTIONS } from '../../../../../src/batteries/llm/claude_code_cli/exceptions'

const baseOptions = (): Record<string, unknown> => ({
  model: 'claude-sonnet-5',
  apiKey: 'sk-test',
})

const originalPlatform = process.platform

const setPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('claude_code_cli validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setPlatform(originalPlatform)
  })

  it('accepts minimal valid options and fills in defaults', () => {
    const resolved = validateOptions(baseOptions())
    expect(resolved.model).toBe('claude-sonnet-5')
    expect(resolved.claudeBin).toBe('claude')
    expect(resolved.disallowedTools).toEqual([])
    expect(resolved.selfIdentity).toBe('assistant')
    expect(resolved.autoAck).toBe(false)
    expect(resolved.forwardSubagentText).toBe(false)
    expect(resolved.streamIdleTimeoutMs).toBe(60_000)
    expect(resolved.startupTimeoutMs).toBe(45_000)
    expect(resolved.disposeGraceMs).toBe(2_000)
    expect(resolved.unsupportedMediaPolicy).toBe('throw')
    expect(resolved.unsupportedResultMediaPolicy).toBe('throw')
    expect(resolved.bucketOrder).toEqual([
      'standingInstructions',
      'memories',
      'retrievables',
      'timeline',
    ])
  })

  it('rejects options missing the required model field', () => {
    const opts = baseOptions()
    delete opts.model
    expect(() => validateOptions(opts)).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
  })

  it('rejects an unknown top-level key', () => {
    expect(() => validateOptions({ ...baseOptions(), notARealOption: true })).toThrow(
      E_INVALID_CLAUDE_CODE_CLI_OPTIONS
    )
  })

  describe('apiKey / authToken XOR', () => {
    it('rejects when both apiKey and authToken are set', () => {
      expect(() =>
        validateOptions({ model: 'claude-sonnet-5', apiKey: 'a', authToken: 'b' })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects when neither apiKey nor authToken is set', () => {
      expect(() => validateOptions({ model: 'claude-sonnet-5' })).toThrow(
        E_INVALID_CLAUDE_CODE_CLI_OPTIONS
      )
    })

    it('accepts apiKey alone', () => {
      expect(() => validateOptions({ model: 'claude-sonnet-5', apiKey: 'sk-test' })).not.toThrow()
    })

    it('accepts authToken alone', () => {
      expect(() =>
        validateOptions({ model: 'claude-sonnet-5', authToken: 'tok-test' })
      ).not.toThrow()
    })
  })

  describe('extraArgs structured allowlist', () => {
    it('accepts --betas with a non-empty string[] value', () => {
      const resolved = validateOptions({
        ...baseOptions(),
        extraArgs: [{ flag: '--betas', value: ['beta-a', 'beta-b'] }],
      })
      expect(resolved.extraArgs).toEqual([{ flag: '--betas', value: ['beta-a', 'beta-b'] }])
    })

    it('rejects --betas with a plain string value (wrong arity)', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--betas', value: 'beta-a' }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects --betas with an empty array value', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--betas', value: [] }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it.each(['--effort', '--agent', '--json-schema', '--name'] as const)(
      'accepts %s with a required plain string value',
      (flag) => {
        expect(() =>
          validateOptions({ ...baseOptions(), extraArgs: [{ flag, value: 'x' }] })
        ).not.toThrow()
      }
    )

    it.each(['--effort', '--agent', '--json-schema', '--name'] as const)(
      'rejects %s when value is omitted',
      (flag) => {
        expect(() => validateOptions({ ...baseOptions(), extraArgs: [{ flag }] })).toThrow(
          E_INVALID_CLAUDE_CODE_CLI_OPTIONS
        )
      }
    )

    it.each(['--effort', '--agent', '--json-schema', '--name'] as const)(
      'rejects %s with an empty string value',
      (flag) => {
        expect(() =>
          validateOptions({ ...baseOptions(), extraArgs: [{ flag, value: '' }] })
        ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
      }
    )

    it('accepts --prompt-suggestions with value omitted', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--prompt-suggestions' }] })
      ).not.toThrow()
    })

    it('accepts --prompt-suggestions with a value present', () => {
      expect(() =>
        validateOptions({
          ...baseOptions(),
          extraArgs: [{ flag: '--prompt-suggestions', value: 'x' }],
        })
      ).not.toThrow()
    })

    it('rejects a flag string outside the six-item enum', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--model', value: 'x' }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects a literal "--" as a flag', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--', value: 'x' }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects a value string starting with "-" in single-value position', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--effort', value: '-x' }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
      expect(() =>
        validateOptions({ ...baseOptions(), extraArgs: [{ flag: '--effort', value: '--model' }] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects a value string starting with "-" inside a --betas array (injection attempt)', () => {
      expect(() =>
        validateOptions({
          ...baseOptions(),
          extraArgs: [{ flag: '--betas', value: ['--model', 'attacker-chosen'] }],
        })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('accepts multiple valid extraArgs entries together', () => {
      const resolved = validateOptions({
        ...baseOptions(),
        extraArgs: [
          { flag: '--effort', value: 'high' },
          { flag: '--name', value: 'session-1' },
          { flag: '--betas', value: ['beta-x'] },
        ],
      })
      expect(resolved.extraArgs).toHaveLength(3)
    })
  })

  describe('platform guard (POSIX-only in v1)', () => {
    it('throws E_INVALID_CLAUDE_CODE_CLI_OPTIONS naming the POSIX-only limitation on win32', () => {
      setPlatform('win32')
      expect(() => validateOptions(baseOptions())).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('succeeds when mocked to darwin', () => {
      setPlatform('darwin')
      expect(() => validateOptions(baseOptions())).not.toThrow()
    })

    it('succeeds when mocked to linux', () => {
      setPlatform('linux')
      expect(() => validateOptions(baseOptions())).not.toThrow()
    })
  })

  describe('other fields', () => {
    it('accepts a fully-populated options object', () => {
      const resolved = validateOptions({
        model: 'claude-sonnet-5',
        authToken: 'tok',
        baseURL: 'https://example.test',
        claudeBin: '/usr/local/bin/claude',
        appendSystemPrompt: 'be terse',
        cwd: '/tmp',
        addDir: ['/tmp/a', '/tmp/b'],
        disallowedTools: ['dangerous_tool'],
        maxTurns: 5,
        maxBudgetUsd: 1.5,
        fallbackModel: ['claude-fable-5', 'claude-opus-5'],
        selfIdentity: 'agent',
        autoAck: true,
        forwardSubagentText: true,
        bucketOrder: ['timeline', 'memories'],
        thoughtSurfacing: 'all',
        replayCompatibility: ['v1'],
        unsupportedMediaPolicy: 'fallback-stash',
        unsupportedResultMediaPolicy: 'synthetic-description',
        streamIdleTimeoutMs: 1000,
        startupTimeoutMs: 2000,
        disposeGraceMs: 500,
        mcpToolIdleTimeoutMs: 3000,
        disableTelemetry: true,
        disableErrorReporting: true,
        disableNonessentialTraffic: true,
      })
      expect(resolved.maxTurns).toBe(5)
      expect(resolved.fallbackModel).toEqual(['claude-fable-5', 'claude-opus-5'])
      expect(resolved.disallowedTools).toEqual(['dangerous_tool'])
    })

    it('rejects an invalid bucketOrder label', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), bucketOrder: ['not-a-real-bucket'] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects a duplicate bucketOrder label', () => {
      expect(() =>
        validateOptions({ ...baseOptions(), bucketOrder: ['timeline', 'timeline'] })
      ).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
    })

    it('rejects an invalid thoughtSurfacing value', () => {
      expect(() => validateOptions({ ...baseOptions(), thoughtSurfacing: 'not-a-mode' })).toThrow(
        E_INVALID_CLAUDE_CODE_CLI_OPTIONS
      )
    })

    it('accepts the object-form unsupportedMediaPolicy', () => {
      const resolved = validateOptions({
        ...baseOptions(),
        unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['k1'] },
      })
      expect(resolved.unsupportedMediaPolicy).toEqual({
        mode: 'fallback-stash',
        stashKeys: ['k1'],
      })
    })

    it('rejects a negative maxBudgetUsd', () => {
      expect(() => validateOptions({ ...baseOptions(), maxBudgetUsd: -1 })).toThrow(
        E_INVALID_CLAUDE_CODE_CLI_OPTIONS
      )
    })

    it('rejects a non-integer maxTurns', () => {
      expect(() => validateOptions({ ...baseOptions(), maxTurns: 1.5 })).toThrow(
        E_INVALID_CLAUDE_CODE_CLI_OPTIONS
      )
    })
  })
})
