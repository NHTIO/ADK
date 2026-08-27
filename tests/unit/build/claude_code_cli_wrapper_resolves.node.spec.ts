import { execa } from 'execa'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * First-of-its-kind regression: no other battery has ever needed to resolve a sibling
 * spawned-executable relative to its own compiled `dist/` location (see Decision C in the
 * design notes). Gated to only run once a real build has produced `dist/` — `pnpm run
 * test:node` executes before `Build Library` in CI, so this test is a local/late-stage check,
 * not part of the gate that gets exercised before a build exists.
 *
 * `resolveDefaultWrapperPath()` must be exercised inside a REAL, PLAIN Node ESM module context —
 * not vitest's own SSR-transformed `import()`, which does not reproduce the built module's actual
 * `import.meta.url`/`require`-shim resolution behavior. A tiny `node --input-type=module` child
 * process, spawned via `execa` and fed the real built `dist/batteries/llm/claude_code_cli/adapter.mjs`
 * path as a dynamic import, is what actually proves the resolution logic works against the real
 * built output.
 */
const distDir = resolve(__dirname, '../../../dist')
const adapterMjsPath = resolve(distDir, 'batteries/llm/claude_code_cli/adapter.mjs')
const wrapperMjsPath = resolve(distDir, 'claude-code-cli-wrapper.mjs')
const distBuilt = existsSync(adapterMjsPath) && existsSync(wrapperMjsPath)

/** Runs `resolveDefaultWrapperPath()` inside a genuinely separate, plain Node ESM process. */
const resolveInRealNodeProcess = async (): Promise<string> => {
  const script = `
    import { resolveDefaultWrapperPath } from ${JSON.stringify(`file://${adapterMjsPath}`)}
    process.stdout.write(resolveDefaultWrapperPath())
  `
  const result = await execa(process.execPath, ['--input-type=module', '--eval', script])
  return result.stdout.trim()
}

describe('resolveDefaultWrapperPath() percent-encoding regression', () => {
  it('decodes a percent-encoded install path (space/unicode) back to the native filesystem path, not the raw URL.pathname', () => {
    // `resolveDefaultWrapperPath()`'s ESM branch resolves `import.meta.url` relative to ITS OWN
    // compiled location, so the install path itself can't be injected here — but the fix's actual
    // mechanism is exactly what this asserts: a `file://` URL whose path segment contains
    // URL-reserved characters (a space, a unicode char) round-trips to the correct native POSIX
    // path only through `decodeURIComponent(url.pathname)`; the raw `.pathname` stays
    // percent-encoded and would be handed to `execaFn`/`spawn` as a non-existent argv path.
    // `decodeURIComponent` is used (not `node:url`'s `fileURLToPath`) because `adapter.ts` is
    // transitively pulled into the browser test project via `src/batteries`'s barrel, where Vite
    // externalizes `node:url` — this asserts the two agree for a POSIX path, which is the only
    // case that matters (this battery is POSIX-only in v1).
    const nativePath = '/opt/adk café/claude-code-cli-wrapper.mjs'
    const url = pathToFileURL(nativePath)
    expect(url.pathname).not.toBe(nativePath)
    expect(url.pathname).toContain('%20')
    expect(decodeURIComponent(url.pathname)).toBe(nativePath)
    expect(decodeURIComponent(url.pathname)).toBe(fileURLToPath(url))
  })
})

describe.skipIf(!distBuilt)(
  'resolveDefaultWrapperPath() against the real built dist/ output',
  () => {
    it('resolves to an EXISTING, READABLE wrapper module file (never checking the executable bit)', async () => {
      const resolved = await resolveInRealNodeProcess()
      expect(existsSync(resolved)).toBe(true)
      // A plain, non-executable .mjs file, exactly as built (Decision C item 3 — Vite's build
      // output deliberately carries no executable bit; asserting X_OK here would be wrong).
      const content = await readFile(resolved, 'utf-8')
      expect(content.length).toBeGreaterThan(0)
      const stats = await stat(resolved)
      expect(stats.isFile()).toBe(true)
      expect((stats.mode & 0o111) === 0).toBe(true)
    })

    it('resolves to the sibling claude-code-cli-wrapper.mjs at the package root, not a flat dist/batteries/llm/claude_code_cli.mjs path', async () => {
      const resolved = await resolveInRealNodeProcess()
      expect(resolved).toBe(wrapperMjsPath)
    })

    it('a real smoke spawn via process.execPath observes a ready WrapperEvent on stdout', async () => {
      const resolved = await resolveInRealNodeProcess()
      const child = execa(process.execPath, [resolved], {
        cleanup: true,
        reject: false,
      })

      const ready = await new Promise<boolean>((resolvePromise) => {
        let buffer = ''
        const onData = (chunk: Buffer): void => {
          buffer += chunk.toString('utf-8')
          const lines = buffer.split('\n')
          for (const line of lines) {
            if (line.trim().length === 0) continue
            try {
              const parsed = JSON.parse(line) as { type?: string }
              if (parsed.type === 'ready') {
                resolvePromise(true)
                return
              }
            } catch {
              // not yet a complete line — keep buffering
            }
          }
        }
        child.stdout?.on('data', onData)
        setTimeout(() => resolvePromise(false), 10_000)
      })

      expect(ready).toBe(true)

      // Kill the process rather than let it hang — we only needed to observe `ready`.
      child.kill('SIGKILL')
      await child.catch(() => undefined)
    }, 15_000)
  }
)
