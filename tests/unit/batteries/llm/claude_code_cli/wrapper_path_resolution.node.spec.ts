import { describe, expect, it } from 'vitest'
import { E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND } from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import {
  __resolveWrapperPathWithFallback,
  __resolveWrapperPathViaSelfReference,
} from '../../../../../src/batteries/llm/claude_code_cli/adapter'

/**
 * Issue #40, defect 2: `resolveDefaultWrapperPath()` resolves the wrapper asset relative to the
 * adapter module's OWN compiled location, which breaks once a consumer bundles the adapter
 * (Vite/Electron Forge bundling an Electron main process relocates it outside `@nhtio/adk`'s own
 * directory tree). These tests exercise the internal fallback resolver
 * (`__resolveWrapperPathWithFallback`, a test-only alias — see its doc comment) through its
 * injectable seams, covering all three outcomes without needing a real `dist/` build:
 *
 *   1. unbundled default resolves            -> covered by the sibling `claude_code_cli_wrapper_
 *      resolves.node.spec.ts` against the real built output; not repeated here.
 *   2. simulated bundled location            -> relative resolution fails, self-reference fallback
 *      succeeds.
 *   3. nothing resolvable                    -> E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND, naming every
 *      path tried and pointing at `wrapperPath`.
 *
 * The self-reference seam returns a `SelfReferenceResolution` (`{ path?, tried }`), not a bare
 * `string | undefined`, so these seams can simulate the real resolver's own "tried every
 * candidate" bookkeeping — see `resolveWrapperPathViaSelfReference`'s doc comment for why it tries
 * an ambient `require` first, then `createRequire(import.meta.url)`, and reports every attempt.
 * The real (non-seamed) resolution against actual esbuild-bundled CJS/ESM output is covered
 * separately in `tests/unit/build/claude_code_cli_wrapper_resolves_bundled.node.spec.ts`, since
 * that needs a real built `dist/` and real bundler output to be meaningful.
 */
describe('resolveWrapperPathWithFallback()', () => {
  it('falls back to the self-reference resolver when the relative-to-module candidate does not exist on disk (simulated bundling)', async () => {
    const resolved = await __resolveWrapperPathWithFallback({
      resolveRelative: () => '/bundled/somewhere/outside/the/package/claude-code-cli-wrapper.mjs',
      checkExists: async (path: string) =>
        path === '/nhtio-adk-install/dist/claude-code-cli-wrapper.mjs',
      resolveSelfRef: async (wrapperBasename: string) => ({
        path: `/nhtio-adk-install/dist/${wrapperBasename}`,
        tried: [`/nhtio-adk-install/dist/${wrapperBasename}`],
      }),
    })
    expect(resolved).toBe('/nhtio-adk-install/dist/claude-code-cli-wrapper.mjs')
  })

  it('never calls the self-reference fallback when the relative candidate already exists (zero behavior change for the unbundled case)', async () => {
    let selfRefCalls = 0
    const resolved = await __resolveWrapperPathWithFallback({
      resolveRelative: () => '/unbundled/dist/claude-code-cli-wrapper.mjs',
      checkExists: async (path: string) => path === '/unbundled/dist/claude-code-cli-wrapper.mjs',
      resolveSelfRef: async (wrapperBasename: string) => {
        selfRefCalls += 1
        return { path: `/should-not-be-used/${wrapperBasename}`, tried: [] }
      },
    })
    expect(resolved).toBe('/unbundled/dist/claude-code-cli-wrapper.mjs')
    expect(selfRefCalls).toBe(0)
  })

  it('throws E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND naming wrapperPath when neither candidate exists', async () => {
    await expect(
      __resolveWrapperPathWithFallback({
        resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.mjs',
        checkExists: async () => false,
        resolveSelfRef: async () => ({ tried: ['self-reference: not found'] }),
      })
    ).rejects.toThrow(E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND)
  })

  it('the thrown error message names the wrapperPath option and every path tried', async () => {
    try {
      await __resolveWrapperPathWithFallback({
        resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.mjs',
        checkExists: async () => false,
        resolveSelfRef: async () => ({ tried: ['self-reference: not found'] }),
      })
      expect.unreachable('expected __resolveWrapperPathWithFallback to throw')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('wrapperPath')
      expect(message).toContain('/bundled/nowhere/claude-code-cli-wrapper.mjs')
    }
  })

  it('the thrown error message ALSO includes every self-reference candidate/reason tried, not just the relative resolver error', async () => {
    // Regression for the AI-review finding: resolveWrapperPathViaSelfReference used to return a
    // bare `string | undefined`, discarding what it had attempted on failure, so the thrown
    // error's "Tried:" list only ever showed the relative resolver's own error text. It must show
    // BOTH what the relative resolver tried AND every self-reference attempt/reason.
    try {
      await __resolveWrapperPathWithFallback({
        resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.mjs',
        checkExists: async () => false,
        resolveSelfRef: async () => ({
          tried: [
            "self-reference via ambient require('@nhtio/adk') failed: Cannot find module '@nhtio/adk'",
            '/nhtio-adk-install/dist/claude-code-cli-wrapper.mjs',
          ],
        }),
      })
      expect.unreachable('expected __resolveWrapperPathWithFallback to throw')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('/bundled/nowhere/claude-code-cli-wrapper.mjs')
      expect(message).toContain("Cannot find module '@nhtio/adk'")
      expect(message).toContain('/nhtio-adk-install/dist/claude-code-cli-wrapper.mjs')
    }
  })

  it('also throws when the relative resolver itself throws (e.g. a real require.resolve MODULE_NOT_FOUND) and self-reference cannot help either', async () => {
    await expect(
      __resolveWrapperPathWithFallback({
        resolveRelative: () => {
          throw new Error("Cannot find module '../../../claude-code-cli-wrapper.cjs'")
        },
        checkExists: async () => false,
        resolveSelfRef: async () => ({ tried: [] }),
      })
    ).rejects.toThrow(E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND)
  })

  it('resolveWrapperPathViaSelfReference records an explicit "skipped: import.meta.url unavailable" entry when the ambient-require route failed AND import.meta.url is unavailable (regression: the createRequire route used to vanish silently in that case)', async () => {
    // Exercises `__resolveWrapperPathViaSelfReference` directly (a dedicated test-only alias one
    // layer below `__resolveWrapperPathWithFallback`) via its own `SelfReferenceResolutionSeams`,
    // since neither a real ambient `require` nor a real `import.meta.url` can be forced to fail
    // from outside the module: `require` is module-scoped per compiled file (patching this test
    // file's own `require.resolve` was verified NOT to affect adapter.ts's `require`), and this
    // worktree's own `package.json` is itself named `@nhtio/adk`, so real self-reference genuinely
    // SUCCEEDS in this test environment rather than failing. The seams let this regression be
    // covered deterministically regardless.
    const result = await __resolveWrapperPathViaSelfReference('claude-code-cli-wrapper.mjs', {
      ambientRequireResolve: () => {
        throw new Error("Cannot find module '@nhtio/adk'")
      },
      importMetaUrl: undefined,
    })
    expect(result.path).toBeUndefined()
    expect(result.tried).toEqual([
      "self-reference via ambient require('@nhtio/adk') failed: Cannot find module '@nhtio/adk'",
      'self-reference via createRequire(import.meta.url) skipped: import.meta.url unavailable in this module context',
    ])
  })

  it('resolveWrapperPathViaSelfReference falls through to createRequire(import.meta.url) and records ITS failure when the ambient-require route failed but import.meta.url IS available', async () => {
    const result = await __resolveWrapperPathViaSelfReference('claude-code-cli-wrapper.mjs', {
      ambientRequireResolve: () => {
        throw new Error("Cannot find module '@nhtio/adk'")
      },
      importMetaUrl: 'file:///bundled/somewhere/adapter.mjs',
    })
    expect(result.path).toBeUndefined()
    expect(result.tried[0]).toBe(
      "self-reference via ambient require('@nhtio/adk') failed: Cannot find module '@nhtio/adk'"
    )
    expect(result.tried[1]).toMatch(
      /^self-reference via createRequire\(import\.meta\.url\)\.resolve\('@nhtio\/adk'\) failed:/
    )
  })

  it('surfaces the self-reference routes end-to-end: returns the self-reference path, and on total failure the thrown error lists the relative candidate and every self-reference attempt', async () => {
    // The outer-orchestration counterpart of the two tests above. It injects `resolveSelfRef`
    // rather than running the real self-reference, which resolves `@nhtio/adk` to this repo's own
    // `dist/index.cjs` and so only passes once a build exists — false-green locally after
    // `pnpm generate`, red in CI's `Core Node.JS Functionality Check`, which never builds. The real
    // self-reference against real files is covered, in a real bundle, by
    // `tests/unit/build/claude_code_cli_wrapper_resolves_bundled.node.spec.ts`.
    const selfRefTried = [
      "self-reference via ambient require('@nhtio/adk') failed: Cannot find module '@nhtio/adk'",
      'self-reference via createRequire(import.meta.url) skipped: import.meta.url unavailable in this module context',
    ]

    const resolved = await __resolveWrapperPathWithFallback({
      resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.mjs',
      checkExists: async () => false,
      resolveSelfRef: async (wrapperBasename: string) => ({
        path: `/nhtio-adk-install/dist/${wrapperBasename}`,
        tried: [`/nhtio-adk-install/dist/${wrapperBasename}`],
      }),
    })
    expect(resolved).toBe('/nhtio-adk-install/dist/claude-code-cli-wrapper.mjs')

    const error = await __resolveWrapperPathWithFallback({
      resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.mjs',
      checkExists: async () => false,
      resolveSelfRef: async () => ({ path: undefined, tried: selfRefTried }),
    }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND)
    const message = (error as Error).message
    expect(message).toContain('/bundled/nowhere/claude-code-cli-wrapper.mjs')
    for (const attempt of selfRefTried) expect(message).toContain(attempt)
    expect(message).toContain('wrapperPath')
  })

  it('derives the .cjs wrapper basename for the self-reference fallback when the relative candidate was itself a .cjs path', async () => {
    let requestedBasename: string | undefined
    await __resolveWrapperPathWithFallback({
      resolveRelative: () => '/bundled/nowhere/claude-code-cli-wrapper.cjs',
      checkExists: async (path: string) =>
        path === '/nhtio-adk-install/dist/claude-code-cli-wrapper.cjs',
      resolveSelfRef: async (wrapperBasename: string) => {
        requestedBasename = wrapperBasename
        return {
          path: `/nhtio-adk-install/dist/${wrapperBasename}`,
          tried: [`/nhtio-adk-install/dist/${wrapperBasename}`],
        }
      },
    })
    expect(requestedBasename).toBe('claude-code-cli-wrapper.cjs')
  })
})
