/**
 * Optional-peer-missing coverage for all four artifact batteries, in BOTH the node and browser
 * projects.
 *
 * Three of the four batteries lazily `import()` an optional peer and wrap a resolution failure in
 * a battery-scoped exception. That path had no coverage in either runtime, and the browser side is
 * the one that matters most: module resolution differs there, so a browser-only failure to wrap
 * could reach consumers undetected. Hence one shared `*.cross.spec.ts`.
 *
 * ── Why ONE file, and why `__mocks__` rather than a `vi.mock` factory ──
 *
 * The peer failure has to be simulated per MODULE GRAPH, not per test: `vi.mock` is hoisted to the
 * top of its file and the battery caches its peer promise at module scope, so a file that mocks a
 * peer poisons that peer for every test in it. Four batteries, four independent peers, and each
 * battery's own `index.cross.spec.ts` needs the REAL peer — so the mocks cannot live in those. One
 * dedicated file holding all four keeps every mock in exactly one module graph and leaves the four
 * behavioural spec files untouched.
 *
 * The simulation itself is a `__mocks__/<pkg>` module that throws at module scope, opted into by an
 * explicit no-factory `vi.mock(<pkg>)` here. Two more obvious approaches were tried first and do
 * not survive the browser project:
 *
 * - `vi.mock(pkg, () => { throw ... })` passes under node and CANNOT work under the browser
 *   provider. The provider builds a module shim by enumerating the factory's exports, so a factory
 *   that throws fails during route registration with `[vitest] There was an error when mocking a
 *   module` — an unhandled rejection, before any test body runs.
 * - `vi.doMock(pkg)` inside a test body passes under node and silently does NOTHING under the
 *   browser provider (the peer resolves for real, so no exception is thrown at all). The route has
 *   to be registered before the page loads the module.
 *
 * A `__mocks__` redirect is served as a real module by both providers, and a module that throws on
 * evaluation is exactly what a genuine `ERR_MODULE_NOT_FOUND` looks like at the `import()` site.
 * `__mocks__` for a bare package specifier is opt-in, never automatic: only files that name the
 * package in `vi.mock` get the redirect, so the four behavioural spec files keep the real peers.
 */

import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { E_TOOL_DOWNSTREAM_ERROR } from '../../../../src/lib/exceptions/runtime'
import { InMemorySpoolReader } from '../../../../src/batteries/storage/in_memory'
import { SpooledYamlArtifact, E_YAML_PEER_MISSING } from '../../../../src/batteries/artifacts/yaml'
import {
  SpooledXmlArtifact,
  E_XML_PARSER_PEER_MISSING,
} from '../../../../src/batteries/artifacts/xml'
import {
  SpooledEcmaScriptArtifact,
  E_TYPESCRIPT_PEER_MISSING,
} from '../../../../src/batteries/artifacts/ecmascript'
import {
  SpooledToonArtifact,
  toonToJsonTool,
  jsonToToonTool,
  E_TOON_PEER_MISSING,
} from '../../../../src/batteries/artifacts/toon'

// No factory: each call redirects to the sibling `__mocks__/<pkg>` module, which throws on
// evaluation. Only files that call vi.mock get the redirect — every other spec loads the real peer.
vi.mock('@toon-format/toon')
vi.mock('js-yaml')
vi.mock('fast-xml-parser')
vi.mock('typescript')

// `js-yaml` is a hard dependency of the CORE `SpooledMarkdownArtifact` (a STATIC top-level import,
// not a lazy one), and that class is re-exported from `src/common`, which every artifact battery
// imports. Without this stub the throwing js-yaml mock would take down the whole static import
// graph and the file would fail to collect with zero tests run — masking the coverage entirely
// rather than exercising it. Stubbing the class keeps the collapse scoped to the LAZY yaml-battery
// load site, which is the code actually under test. Nothing here touches
// `SpooledMarkdownArtifact`, so the stub is never exercised as a class.
vi.mock('../../../../src/lib/classes/spooled_markdown_artifact', () => ({
  SpooledMarkdownArtifact: class {},
}))

/**
 * Settles a promise into either its rejection reason or `undefined` on success, so the CAUGHT
 * VALUE itself can be asserted on. `rejects.toThrow(/…/)` would only match a substring of the
 * message and would say nothing about the class, which is half of what is under test here.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (caught: unknown) => caught
  )

/**
 * Asserts the four things a peer-missing failure must carry:
 *
 * 1. the battery's OWN exception class (not the raw `Error` the module resolution produced),
 * 2. its exact `name` — the identity `isNamedException` narrows on across module boundaries,
 * 3. the exact message head, naming the missing package,
 * 4. the exact message tail, carrying the install command.
 *
 * Head and tail are compared by exact slice rather than `toContain`, so a reworded template, a
 * dropped install command, or a swapped interpolation order all fail. That message is the entire
 * actionable payload of this exception and is the part most likely to rot unnoticed.
 */
const expectPeerMissing = (
  err: unknown,
  expected: { ctor: new (args: [string]) => Error; name: string; prefix: string; suffix: string }
) => {
  expect(err).toBeInstanceOf(expected.ctor)
  const exception = err as Error
  expect(exception.name).toBe(expected.name)
  expect(exception.message.slice(0, expected.prefix.length)).toBe(expected.prefix)
  expect(exception.message.slice(-expected.suffix.length)).toBe(expected.suffix)
  // The underlying detail is interpolated BETWEEN head and tail — proving the wrap preserved the
  // original failure rather than discarding it, and that head and tail are not the same substring
  // of a degenerate empty message.
  expect(exception.message.length).toBeGreaterThan(expected.prefix.length + expected.suffix.length)
}

const TOON = {
  ctor: E_TOON_PEER_MISSING as unknown as new (args: [string]) => Error,
  name: 'E_TOON_PEER_MISSING',
  prefix:
    'the toon battery could not load its peer dependency "@toon-format/toon" (needed for TOON format artifact queries): ',
  suffix: ' — install it (pnpm add @toon-format/toon)',
}

const YAML = {
  ctor: E_YAML_PEER_MISSING as unknown as new (args: [string]) => Error,
  name: 'E_YAML_PEER_MISSING',
  prefix:
    'the yaml battery could not load its peer dependency "js-yaml" (needed for YAML format artifact queries): ',
  suffix: ' — install it (pnpm add js-yaml)',
}

const XML = {
  ctor: E_XML_PARSER_PEER_MISSING as unknown as new (args: [string]) => Error,
  name: 'E_XML_PARSER_PEER_MISSING',
  prefix:
    'the XML battery could not load its peer dependency "fast-xml-parser" (needed for XML format artifact queries): ',
  suffix: ' — install it (pnpm add fast-xml-parser)',
}

const TYPESCRIPT = {
  ctor: E_TYPESCRIPT_PEER_MISSING as unknown as new (args: [string]) => Error,
  name: 'E_TYPESCRIPT_PEER_MISSING',
  prefix:
    'the ecmascript battery could not load its peer dependency "typescript" (needed for EcmaScript artifact queries): ',
  suffix: ' — install it (pnpm add typescript)',
}

describe('artifact batteries — optional peer fails to resolve', () => {
  describe('toon battery (@toon-format/toon)', () => {
    it('throws E_TOON_PEER_MISSING from a query method, naming the package and install command', async () => {
      const artifact = new SpooledToonArtifact(new InMemorySpoolReader('data[1]{id}:\n  1'))
      expectPeerMissing(await rejectionOf(artifact.toon_type()), TOON)
    })

    // The battery caches its loader promise at module scope, so the SECOND caller must see the
    // same battery exception rather than a bare cached rejection or a re-thrown raw error.
    it('throws E_TOON_PEER_MISSING again for a second, independent artifact', async () => {
      const artifact = new SpooledToonArtifact(new InMemorySpoolReader('other[1]{id}:\n  2'))
      expectPeerMissing(await rejectionOf(artifact.toon_keys()), TOON)
    })

    // toon_to_json loads the peer at its OWN import site, not through the cached loader — so it
    // needs its own assertion. `Tool.executor` wraps handler throws in E_TOOL_DOWNSTREAM_ERROR and
    // preserves the original as `cause`, so the battery exception is read off the cause.
    it('surfaces E_TOON_PEER_MISSING as the cause of a toon_to_json tool failure', async () => {
      const executor = toonToJsonTool.executor(makeDispatchContext())
      const err = await rejectionOf(executor({ text: 'data[1]{id}:\n  1' }))
      expect(err).toBeInstanceOf(E_TOOL_DOWNSTREAM_ERROR)
      expectPeerMissing((err as Error).cause, TOON)
    })

    it('surfaces E_TOON_PEER_MISSING as the cause of a json_to_toon tool failure', async () => {
      const executor = jsonToToonTool.executor(makeDispatchContext())
      const err = await rejectionOf(executor({ text: '{"id":1}' }))
      expect(err).toBeInstanceOf(E_TOOL_DOWNSTREAM_ERROR)
      expectPeerMissing((err as Error).cause, TOON)
    })
  })

  describe('yaml battery (js-yaml)', () => {
    it('throws E_YAML_PEER_MISSING from a query method, naming the package and install command', async () => {
      const artifact = new SpooledYamlArtifact(new InMemorySpoolReader('name: alice'))
      expectPeerMissing(await rejectionOf(artifact.yaml_type()), YAML)
    })

    it('throws E_YAML_PEER_MISSING again for a second, independent artifact', async () => {
      const artifact = new SpooledYamlArtifact(new InMemorySpoolReader('name: bob'))
      expectPeerMissing(await rejectionOf(artifact.yaml_keys()), YAML)
    })
  })

  describe('xml battery (fast-xml-parser)', () => {
    it('throws E_XML_PARSER_PEER_MISSING from a query method, naming the package and install command', async () => {
      const artifact = new SpooledXmlArtifact(new InMemorySpoolReader('<root><a>hi</a></root>'))
      expectPeerMissing(await rejectionOf(artifact.xml_root()), XML)
    })

    it('throws E_XML_PARSER_PEER_MISSING again for a second, independent artifact', async () => {
      const artifact = new SpooledXmlArtifact(new InMemorySpoolReader('<other><b>yo</b></other>'))
      expectPeerMissing(await rejectionOf(artifact.xml_keys()), XML)
    })
  })

  describe('ecmascript battery (typescript)', () => {
    it('throws E_TYPESCRIPT_PEER_MISSING from a query method, naming the package and install command', async () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader('export const x = 1'))
      expectPeerMissing(await rejectionOf(artifact.es_symbols()), TYPESCRIPT)
    })

    // This battery caches on a STATIC private field rather than a module-level `let`; the second
    // call must still surface the battery exception, not the bare cached rejection.
    it('throws E_TYPESCRIPT_PEER_MISSING again for a second, independent artifact', async () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader('export const y = 2'))
      expectPeerMissing(await rejectionOf(artifact.es_imports()), TYPESCRIPT)
    })
  })
})
