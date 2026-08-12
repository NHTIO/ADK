import { describe, expect, it } from 'vitest'
import { mapPolicy } from '../../../../src/batteries/sandbox/node/srt_enforcer'
import { createRipgrepSearch } from '../../../../src/batteries/sandbox/node/search_ripgrep'
import {
  derivedRulesFromSrt,
  createFsNode,
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
  reproduceMandatoryDeny,
} from '../../../../src/batteries/sandbox/node/fs_node'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })
const policy = (extra: Record<string, unknown> = {}) =>
  ({ filesystem: {}, network: {}, ...extra }) as any

describe('sandbox node enforcer and adapters', () => {
  it('maps every absent ADK axis to explicit SRT arrays and pins restrictive knobs', () => {
    const mapped = mapPolicy(policy())
    expect(mapped.filesystem).toMatchObject({
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
      allowGitConfig: false,
    })
    expect(mapped.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: [],
      deniedDomainReasons: {},
      strictAllowlist: true,
      allowLocalBinding: false,
      allowUnixSockets: [],
      allowMachLookup: [],
    })
    expect(mapped.git).toEqual({ safeDirectories: [process.cwd()] })
    expect(Object.hasOwn(mapped.filesystem, 'gitSafeDirectories')).toBe(false)
  })

  it('maps disabled network to allow-all, and rejects contradictory restrictions', () => {
    expect(mapPolicy(policy({ network: { disabled: true } })).network.allowedDomains).toEqual(['*'])
    expect(mapPolicy(policy({ network: { disabled: true } })).network.deniedDomains).toEqual([])
    expect(mapPolicy(policy({ network: { disabled: true } })).network.deniedDomainReasons).toEqual(
      {}
    )
    expect(() =>
      mapPolicy(policy({ network: { disabled: true, allowedDomains: ['foo.com'] } }))
    ).toThrow('network.disabled contradicts')
    expect(() =>
      mapPolicy(
        policy({
          network: {
            disabled: true,
            deniedDomains: ['foo.com'],
            deniedDomainReasons: { 'foo.com': 'x' },
          },
        })
      )
    ).toThrow('network.disabled contradicts')
  })

  it('keeps disabled filesystem read and write axes distinct', () => {
    const disabled = mapPolicy(policy({ filesystem: { disabled: true } }))
    expect(disabled.filesystem).toMatchObject({
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    })
    const rules = derivedRulesFromSrt({
      platform: 'darwin',
      read: { denyOnly: [] },
      write: { allowOnly: ['/'], denyWithinAllow: [] },
      filesystemDisabled: true,
    })
    expect(createFsNode(rules).canRead('/anything')).toBe(true)
    expect(createFsNode(rules).canWrite('/anything')).toBe(true)
    const enabled = derivedRulesFromSrt({
      platform: 'darwin',
      read: { denyOnly: [] },
      write: { allowOnly: ['/'], denyWithinAllow: [] },
    })
    expect(createFsNode(enabled).canWrite('/anything')).toBe(true)
    expect(
      createFsNode(
        derivedRulesFromSrt({
          platform: 'darwin',
          read: { denyOnly: [] },
          write: { allowOnly: [], denyWithinAllow: [] },
        })
      ).canWrite('/anything')
    ).toBe(false)
  })

  it('applies read allow-after-deny and write deny-after-allow precedence', () => {
    const node = createFsNode(
      derivedRulesFromSrt({
        platform: 'darwin',
        read: { denyOnly: ['/secret'], allowWithinDeny: ['/secret/open'] },
        write: { allowOnly: ['/tmp'], denyWithinAllow: ['/tmp/no'] },
      })
    )
    expect(node.canRead('/secret/file')).toBe(false)
    expect(node.canRead('/secret/open')).toBe(true)
    expect(node.canWrite('/tmp/file')).toBe(true)
    expect(node.canWrite('/tmp/no')).toBe(false)
  })

  it('pins the four case rules', () => {
    const mac = createFsNode(
      derivedRulesFromSrt({
        platform: 'darwin',
        read: { denyOnly: ['*.bashrc'] },
        write: { allowOnly: ['/'], denyWithinAllow: [] },
        mandatoryDeny: {
          form: 'glob',
          entries: ['.bashrc'],
          allowGitConfig: false,
          searchDepth: 3,
        },
      })
    )
    expect(mac.canRead('.BASHRC')).toBe(true)
    const linux = createFsNode(
      derivedRulesFromSrt({
        platform: 'linux',
        read: { denyOnly: ['.bashrc'] },
        write: { allowOnly: ['/'], denyWithinAllow: [] },
        mandatoryDeny: {
          form: 'expanded-paths',
          entries: ['.bashrc'],
          allowGitConfig: false,
          searchDepth: 3,
        },
      })
    )
    expect(linux.canWrite('.BASHRC')).toBe(false)
    const git = createFsNode(
      derivedRulesFromSrt({
        platform: 'linux',
        read: { denyOnly: [] },
        write: { allowOnly: ['/'], denyWithinAllow: [] },
        mandatoryDeny: {
          form: 'expanded-paths',
          entries: ['.git/hooks', '.git/config'],
          allowGitConfig: false,
          searchDepth: 3,
        },
      })
    )
    expect(git.canWrite('sub/repo/.GIT/hooks/pre-commit')).toBe(true)
    expect(
      createFsNode(
        derivedRulesFromSrt({
          platform: 'darwin',
          read: { denyOnly: ['foo'] },
          write: { allowOnly: ['/'], denyWithinAllow: [] },
        })
      ).canRead('FOO')
    ).toBe(true)
  })

  it('reproduces the upstream macOS mandatory-deny set EXACTLY, for both allowGitConfig values', async () => {
    // HERMETIC PARITY, and this is the cheap check that catches the whole "a list gained an entry
    // upstream" class without needing a real sandbox. Two things an earlier version of this test got
    // wrong, both of which made it prove nothing:
    //   · it imported upstream from an ABSOLUTE developer-machine path, so it could only ever run
    //     here — and would fail or silently mislead anywhere else;
    //   · it compared `macGetMandatoryDenyPatterns(allow)` to ITSELF, which is true by construction
    //     and never touched our reproduction at all.
    // The package-relative deep import is safe: `sandbox-utils` and `macos-sandbox-utils` are
    // zod-free, so this cannot pull upstream's bundled schema library into the repo.
    const upstream =
      (await import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js')) as unknown as {
        DANGEROUS_FILES: readonly string[]
        getDangerousDirectories: () => readonly string[]
      }
    const mac =
      (await import('@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js')) as unknown as {
        macGetMandatoryDenyPatterns: (allowGitConfig: boolean) => readonly string[]
      }

    expect(DANGEROUS_FILES).toEqual(upstream.DANGEROUS_FILES)
    // Upstream filters `.git` out of its own directory list and handles it separately.
    expect(DANGEROUS_DIRECTORIES).toEqual(
      upstream.getDangerousDirectories().filter((x) => x !== '.git')
    )

    for (const allowGitConfig of [false, true]) {
      const theirs = [...mac.macGetMandatoryDenyPatterns(allowGitConfig)]
      const ours = reproduceMandatoryDeny({
        cwd: process.cwd(),
        allowGitConfig,
        platform: 'darwin',
        dotGitIsDirectory: true,
      })
      // Set equality, not merely "ours is a superset": an EXTRA entry denies what the profile permits
      // (stricter than the sandbox, which the live agreement test correctly fails), and a MISSING one
      // is the `save_media` out-permits-the-shell hole. Both directions matter.
      expect([...ours].sort(), `allowGitConfig=${allowGitConfig}`).toEqual([...theirs].sort())
    }
  })

  it('classifies ripgrep diagnostics before exit status and preserves all result classes', async () => {
    let diagnostics: string[] = []
    const enforcer: SandboxPolicyEnforcer = {
      isSupported: () => true,
      checkDependencies: async () => ({ errors: [], warnings: [] }),
      effectivePolicy: () => undefined,
      diagnosticsFor: () => diagnostics,
      dispose: async () => {},
      run: async () => ({
        stdout: stream(''),
        stderr: stream('regex parse error: bad'),
        completed: Promise.resolve({ exitCode: 2, failed: true }),
      }),
    }
    const search = createRipgrepSearch(enforcer, policy())
    await expect(
      (async () => {
        // Draining is the point — the throw happens during iteration, and the frames themselves
        // are not asserted here, so nothing is bound.
        for await (const frame of search.findPaths({
          root: '.',
          glob: 'x',
          maxDepth: 1,
        }))
          expect(frame).toBeTruthy()
      })()
    ).rejects.toThrow(/regex parse error/)
    diagnostics = ['denied']
    await expect(
      (async () => {
        // Draining is the point — the throw happens during iteration, and the frames themselves
        // are not asserted here, so nothing is bound.
        for await (const frame of search.findPaths({
          root: '.',
          glob: 'x',
          maxDepth: 1,
        }))
          expect(frame).toBeTruthy()
      })()
    ).rejects.toThrow(/denied-by-policy/)
  })
})
