import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sandboxRuntimeGate, sandboxRuntimeGateReason } from '../../../_fixtures/sandbox_runtime'
import { encodeSandboxedCommand } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'

/**
 * Why a per-CHILD network allow-list is not available under SRT (issue #50, round 3).
 *
 * @remarks
 * The maintainer asked whether the `initialize()` ask callback or `network.filterRequest` could carry
 * a per-child allow-list, and required the answer be PROVEN by measurement rather than reasoning. This
 * suite measures the three properties any such route would need: a stable child identity, a callback
 * that receives it, and an unforgeable way to key on it. All three fail against the real SRT proxy:
 *
 *  - COLLISION: the identity SRT conveys is `encodeSandboxedCommand(command)` = base64 of the
 *    command's FIRST 100 characters, so two different commands sharing a 100-char prefix are the SAME
 *    identity (measured).
 *  - IDENTITY DELIVERY: the ask callback is invoked with `{ host, port }` only — never the
 *    `encodedCommand` the filter received (measured by reading the callback's own arguments).
 *  - UNREACHABLE: this battery maps every policy to `strictAllowlist: true`, and SRT then denies a
 *    host outside the session list WITHOUT consulting the callback (measured: 0 invocations, HTTP 403).
 *  - DENY-ONLY HOOK: `network.filterRequest` runs only after the session list already allowed the host,
 *    so it can deny within the list but never GRANT beyond it (measured: it 403s an allowed host).
 *  - FORGERY: the proxy username is client-controlled inside the sandbox and the session token is in
 *    that child's own environment, so a child can present another child's username with the valid
 *    token and have its traffic attributed to that other child (measured).
 *
 * These are SRT's behaviour, not ADK's, so this spec drives `SandboxManager` directly. It is the
 * evidence behind the typed `E_SANDBOX_NETWORK_GRANT_UNSUPPORTED` refusal in `srt_enforcer.ts`: with
 * identity unavailable, forgeable and collidable, no per-child allow-list can be both unforgeable and
 * collision-free without patching SRT.
 *
 * No filesystem writes are needed, so the policy is network-only with a temp git safe directory.
 */
const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adk50ident-'))
  roots.push(root)
  return root
}

const config = async (root: string, strictAllowlist?: boolean) => ({
  filesystem: {
    denyRead: [],
    allowRead: [],
    allowWrite: [root],
    denyWrite: [],
    allowGitConfig: false,
  },
  network: {
    allowedDomains: ['example.com'],
    deniedDomains: [],
    deniedDomainReasons: {},
    allowLocalBinding: false,
    allowUnixSockets: [],
    allowMachLookup: [],
    ...(strictAllowlist === undefined ? {} : { strictAllowlist }),
  },
  git: { safeDirectories: [root] },
})

/** A raw CONNECT through the mux proxy with a caller-chosen proxy username. */
const connect = (
  port: number,
  host: string,
  user: string,
  token: string
): Promise<{ status?: number; err?: string }> =>
  new Promise((settle) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: {
        'proxy-authorization': 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64'),
      },
    })
    req.on('connect', (response) => settle({ status: response.statusCode }))
    req.on('response', (response) => settle({ status: response.statusCode }))
    req.on('error', (error) => settle({ err: String(error) }))
    req.end()
  })

/** A plain-HTTP proxy request, which is the path `network.filterRequest` also runs on. */
const plainHttp = (
  port: number,
  url: string,
  user: string,
  token: string
): Promise<{ status?: number; err?: string }> =>
  new Promise((settle) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: url,
      headers: {
        'host': new URL(url).host,
        'proxy-authorization': 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64'),
      },
    })
    req.on('response', (response) => {
      response.resume()
      settle({ status: response.statusCode })
    })
    req.on('error', (error) => settle({ err: String(error) }))
    req.end()
  })

describe('encodeSandboxedCommand child identity behaviour', () => {
  it('collides child identities: encodeSandboxedCommand truncates to 100 chars', () => {
    // Two DIFFERENT commands differing only after character 100.
    const prefix = 'curl https://api.github.com/x/'
    const padding = 'x'.repeat(120)
    const first = `${prefix}${padding}A-child-one`
    const second = `${prefix}${padding}B-child-two`
    expect(encodeSandboxedCommand(first)).toBe(encodeSandboxedCommand(second))
    // ...and it is exactly a 100-character truncation, base64-encoded.
    expect(Buffer.from(encodeSandboxedCommand(first), 'base64').toString('utf8')).toBe(
      first.slice(0, 100)
    )
  })

  it('reports whether real-SRT network identity assertions ran', () => {
    console.info(`sandbox runtime gate: ${sandboxRuntimeGateReason}`)
    expect(['darwin', 'linux']).toContain(process.platform)
  })
})

// These run everywhere SRT does; the point is to pin upstream behaviour an ADK decision rests on.
describe.skipIf(!sandboxRuntimeGate)(
  'SRT cannot carry a per-child network allow-list (issue #50, round 3)',
  () => {
    afterEach(async () => {
      await SandboxManager.reset()
    })

    afterAll(async () => {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
    })

    it('hands the ask callback only { host, port } — never the child identity', async () => {
      const root = await makeRoot()
      const asks: unknown[] = []
      await SandboxManager.initialize(await config(root), async (params) => {
        asks.push(params)
        return false
      })
      const port = SandboxManager.getProxyPort()
      const token = SandboxManager.getProxyAuthToken()
      expect(port).toBeDefined()
      expect(token).toBeDefined()
      // Two CONNECTs with IDENTICAL forged usernames: the callback cannot tell the children apart.
      const forged = encodeSandboxedCommand('curl https://api.github.com')
      await connect(port!, 'api.github.com', `srt.${forged}`, token!)
      await connect(port!, 'api.github.com', `srt.${forged}`, token!)
      expect(asks).toHaveLength(2)
      // The callback's ONLY inputs — the encodedCommand the filter saw is not among them.
      expect(Object.keys(asks[0] as object).sort()).toEqual(['host', 'port'])
      expect(asks[0]).toEqual({ host: 'api.github.com', port: 443 })
    })

    it('never consults the ask callback when strictAllowlist is set (what ADK always sets)', async () => {
      const root = await makeRoot()
      const asks: unknown[] = []
      await SandboxManager.initialize(await config(root, true), async (params) => {
        asks.push(params)
        return true // would ALLOW if ever consulted
      })
      const port = SandboxManager.getProxyPort()
      const token = SandboxManager.getProxyAuthToken()
      const result = await connect(
        port!,
        'api.github.com',
        `srt.${encodeSandboxedCommand('x')}`,
        token!
      )
      expect(result.status).toBe(403) // denied by the allow-list, not the callback
      expect(asks).toHaveLength(0)
    })

    it('offers network.filterRequest only as a deny hook within the allow-list, never a grant', async () => {
      const root = await makeRoot()
      const seen: boolean[] = []
      const whole = await config(root, true)
      await SandboxManager.initialize(
        {
          ...whole,
          network: {
            ...whole.network,
            filterRequest: async (request: Request) => {
              // The embedder hook DOES see headers — including the proxy identity.
              seen.push(request.headers.get('proxy-authorization') !== null)
              return { action: 'deny' as const, reason: 'the callback denies everything' }
            },
          },
        },
        async () => true
      )
      const port = SandboxManager.getProxyPort()
      const token = SandboxManager.getProxyAuthToken()
      // A host the SESSION list ALLOWS is still denied when the callback says deny — the hook is a
      // veto applied AFTER the allow-list.
      const insideList = await plainHttp(port!, 'http://example.com/', 'srt', token!)
      expect(insideList.status).toBe(403)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every(Boolean)).toBe(true)
    })

    it('cannot GRANT a host the session allow-list excludes (CONNECT)', async () => {
      const root = await makeRoot()
      const seen: boolean[] = []
      const whole = await config(root, true)
      await SandboxManager.initialize(
        {
          ...whole,
          network: {
            ...whole.network,
            // A callback that would ALLOW everything: if the hook could grant, this host would pass.
            filterRequest: async (request: Request) => {
              seen.push(request.headers.get('proxy-authorization') !== null)
              return { action: 'allow' as const }
            },
          },
        },
        async () => true
      )
      const port = SandboxManager.getProxyPort()
      const token = SandboxManager.getProxyAuthToken()
      // A host OUTSIDE the session list is blocked by the allow-list; the allow-returning callback
      // cannot rescue it, and is not even reached (the list decides first).
      const outsideList = await connect(port!, 'api.github.com', 'srt', token!)
      expect(outsideList.status).toBe(403)
    })

    it('accepts a forged proxy username and attributes the denial to the impersonated child', async () => {
      const root = await makeRoot()
      await SandboxManager.initialize(await config(root, true), async () => false)
      const port = SandboxManager.getProxyPort()
      const token = SandboxManager.getProxyAuthToken()
      // Identity of a DIFFERENT child, presented with this child's own valid token.
      const victim = encodeSandboxedCommand('ssh git@example.com')
      const result = await connect(port!, 'forbidden.example.org', `srt.${victim}`, token!)
      expect(result.status).toBe(403)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const attributed = SandboxManager.getSandboxViolationStore()
        .getViolations()
        .some((violation) => (violation as { encodedCommand?: string }).encodedCommand === victim)
      // The proxy cannot tell the forgery from the real child: the denial is filed under the victim.
      expect(attributed).toBe(true)
    })
  }
)
