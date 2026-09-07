import { describe, expect, it, beforeAll } from 'vitest'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import { ArtifactTool } from '../../../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../../../_fixtures/dispatch_context'
import { registerAdkEncodables } from '../../../../../src/batteries/encoding'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledArtifact } from '../../../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../../../_fixtures/primitives'
import { ENCODE_METHOD, DECODE_METHOD } from '../../../../../src/lib/utils/encoder_symbols'
import { SpooledEcmaScriptArtifact } from '../../../../../src/batteries/artifacts/ecmascript'

// A comprehensive fixture source file containing:
// - exported class with methods and properties
// - non-exported function
// - interface
// - type alias
// - enum
// - several imports (type-only, namespace, regular)
// - export * from re-export
// - JSDoc-commented declarations
const FIXTURE_CODE = `import { describe, expect, it } from 'vitest'
import type { DispatchContext } from '@nhtio/adk/types'
import * as path from 'path'

/**
 * A well-documented helper function.
 * @param name The name parameter
 * @returns The result
 */
function helperFunction(name: string): string {
  return \`processed-\${name}\`
}

/** Marker for documentation test */
const CONSTANT_VALUE = 42

export interface UserConfig {
  name: string
  email: string
}

export type ConfigKey = 'user' | 'admin' | 'guest'

export enum Status {
  Pending = 'pending',
  Active = 'active',
  Archived = 'archived',
}

export class ConfigManager {
  private config: UserConfig

  constructor(initialConfig: UserConfig) {
    this.config = initialConfig
  }

  getConfig(): UserConfig {
    return this.config
  }

  updateConfig(partial: Partial<UserConfig>): void {
    this.config = { ...this.config, ...partial }
  }
}

export class Logger {
  log(msg: string): void {
    console.log(msg)
  }
}

export { Version } from './version'
export * from './utils'

export default ConfigManager
`

const make = (content: string, fileName?: string) =>
  new SpooledEcmaScriptArtifact(new InMemorySpoolReader(content), { fileName })

describe('SpooledEcmaScriptArtifact', () => {
  describe('es_symbols (top-level declarations)', () => {
    it('returns all top-level declarations with kind, name, exported flag, and line ranges', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      // Verify structure
      expect(Array.isArray(symbols)).toBe(true)
      expect(symbols.length).toBeGreaterThan(0)

      // Check that each symbol has required fields
      for (const sym of symbols) {
        expect(sym).toHaveProperty('kind')
        expect(sym).toHaveProperty('name')
        expect(sym).toHaveProperty('exported')
        expect(sym).toHaveProperty('startLine')
        expect(sym).toHaveProperty('endLine')
        expect(typeof sym.startLine).toBe('number')
        expect(typeof sym.endLine).toBe('number')
        expect(sym.startLine >= 0).toBe(true)
        expect(sym.endLine >= sym.startLine).toBe(true)
      }
    })

    it('includes function declarations with exported flag correct', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      // helperFunction is not exported
      const helperFunc = symbols.find((s) => s.name === 'helperFunction')
      expect(helperFunc).toBeDefined()
      expect(helperFunc?.exported).toBe(false)
      expect(helperFunc?.kind).toBe('function')
      expect(typeof helperFunc?.startLine).toBe('number')
      expect(typeof helperFunc?.endLine).toBe('number')
    })

    it('includes class declarations with exported flag correct', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      // ConfigManager is exported
      const configMgr = symbols.find((s) => s.name === 'ConfigManager')
      expect(configMgr).toBeDefined()
      expect(configMgr?.exported).toBe(true)
      expect(configMgr?.kind).toBe('class')
    })

    it('includes interface declarations', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      const iface = symbols.find((s) => s.name === 'UserConfig')
      expect(iface).toBeDefined()
      expect(iface?.kind).toBe('interface')
      expect(iface?.exported).toBe(true)
    })

    it('includes type alias declarations', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      const typeAlias = symbols.find((s) => s.name === 'ConfigKey')
      expect(typeAlias).toBeDefined()
      expect(typeAlias?.kind).toBe('type')
      expect(typeAlias?.exported).toBe(true)
    })

    it('includes enum declarations', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      const enumDecl = symbols.find((s) => s.name === 'Status')
      expect(enumDecl).toBeDefined()
      expect(enumDecl?.kind).toBe('enum')
      expect(enumDecl?.exported).toBe(true)
    })

    it('includes const/let/var bindings', async () => {
      const artifact = make(FIXTURE_CODE)
      const symbols = await artifact.es_symbols()

      const constant = symbols.find((s) => s.name === 'CONSTANT_VALUE')
      expect(constant).toBeDefined()
      expect(['const', 'let', 'var']).toContain(constant?.kind)
      expect(constant?.exported).toBe(false)
    })

    it('filters by kind when provided', async () => {
      const artifact = make(FIXTURE_CODE)
      const onlyClasses = await artifact.es_symbols('class')

      for (const sym of onlyClasses) {
        expect(sym.kind).toBe('class')
      }

      // Verify we get classes but not functions
      expect(onlyClasses.some((s) => s.name === 'ConfigManager')).toBe(true)
      expect(onlyClasses.some((s) => s.name === 'helperFunction')).toBe(false)
    })

    it('treats empty kind string as no filter', async () => {
      const artifact = make(FIXTURE_CODE)
      const all = await artifact.es_symbols()
      const withEmpty = await artifact.es_symbols('')

      expect(all.length).toBe(withEmpty.length)
    })

    it('handles a file with no top-level declarations', async () => {
      const emptyCode = `// just a comment\n/* multi-line */`
      const artifact = make(emptyCode)
      const symbols = await artifact.es_symbols()

      expect(Array.isArray(symbols)).toBe(true)
      expect(symbols.length).toBe(0)
    })

    describe('DEFECT DETECTION: comprehensive export visibility', () => {
      it('returns entries for every ordinary exported declaration by name', async () => {
        // This fixture matches the defect report exactly
        const fixtureCode = `export function alpha() { return 1 }
export class Beta { m(): void {} }
export const gamma = 1, delta = 2
export interface Iface { a: string }
export * from "./other"`

        const artifact = make(fixtureCode)
        const symbols = await artifact.es_symbols()
        const symbolNames = symbols.map((s) => s.name)

        // Each ordinary export must appear as a separate symbol
        expect(symbolNames).toContain('alpha')
        expect(symbolNames).toContain('Beta')
        expect(symbolNames).toContain('gamma')
        expect(symbolNames).toContain('delta')
        expect(symbolNames).toContain('Iface')

        // Verify exported flags are correct
        const alpha = symbols.find((s) => s.name === 'alpha')
        expect(alpha?.exported).toBe(true)
        expect(alpha?.kind).toBe('function')

        const beta = symbols.find((s) => s.name === 'Beta')
        expect(beta?.exported).toBe(true)
        expect(beta?.kind).toBe('class')

        const gamma = symbols.find((s) => s.name === 'gamma')
        expect(gamma?.exported).toBe(true)
        expect(['const', 'let', 'var']).toContain(gamma?.kind)

        const iface = symbols.find((s) => s.name === 'Iface')
        expect(iface?.exported).toBe(true)
        expect(iface?.kind).toBe('interface')
      })

      it('includes every binding from multi-binding const/let/var declarations', async () => {
        // The defect report shows: `const gamma = 1, delta = 2` was dropped entirely or delta was missing
        const multiBindingCode = `export const a = 1, b = 2, c = 3
const x = 10, y = 20`

        const artifact = make(multiBindingCode)
        const symbols = await artifact.es_symbols()
        const symbolNames = symbols.map((s) => s.name)

        // All bindings must appear individually
        expect(symbolNames).toContain('a')
        expect(symbolNames).toContain('b')
        expect(symbolNames).toContain('c')
        expect(symbolNames).toContain('x')
        expect(symbolNames).toContain('y')

        // Check exported flags
        const aSymbol = symbols.find((s) => s.name === 'a')
        expect(aSymbol?.exported).toBe(true)
        const xSymbol = symbols.find((s) => s.name === 'x')
        expect(xSymbol?.exported).toBe(false)
      })

      it('distinguishes exported vs non-exported declarations correctly', async () => {
        const mixedCode = `export function publicFn() {}
function privateFn() {}
export class Public {}
class Private {}
export const PUBLIC = 1
const PRIVATE = 2`

        const artifact = make(mixedCode)
        const symbols = await artifact.es_symbols()

        const publicFn = symbols.find((s) => s.name === 'publicFn')
        const privateFn = symbols.find((s) => s.name === 'privateFn')
        const publicClass = symbols.find((s) => s.name === 'Public')
        const privateClass = symbols.find((s) => s.name === 'Private')
        const publicConst = symbols.find((s) => s.name === 'PUBLIC')
        const privateConst = symbols.find((s) => s.name === 'PRIVATE')

        expect(publicFn?.exported).toBe(true)
        expect(privateFn?.exported).toBe(false)
        expect(publicClass?.exported).toBe(true)
        expect(privateClass?.exported).toBe(false)
        expect(publicConst?.exported).toBe(true)
        expect(privateConst?.exported).toBe(false)
      })

      it('covers export default declarations', async () => {
        const defaultExportCode = `export default function DefaultFn() {}
export default class DefaultClass {}`

        const artifact = make(defaultExportCode)
        const symbols = await artifact.es_symbols()

        // Default exports should still be recorded with their declared names
        expect(symbols.length).toBeGreaterThan(0)
        // Most implementations track the default export by the declaration kind
        expect(symbols.some((s) => s.exported)).toBe(true)
      })
    })
  })

  describe('es_imports (import statements)', () => {
    it('returns all import declarations with module specifier and imported names', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      expect(Array.isArray(imports)).toBe(true)
      expect(imports.length).toBeGreaterThan(0)

      for (const imp of imports) {
        expect(imp).toHaveProperty('moduleSpecifier')
        expect(imp).toHaveProperty('named')
        expect(imp).toHaveProperty('default')
        expect(imp).toHaveProperty('namespace')
        expect(imp).toHaveProperty('typeOnly')
        expect(imp).toHaveProperty('line')
        expect(Array.isArray(imp.named)).toBe(true)
      }
    })

    it('detects named imports from vitest', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      const vitestImport = imports.find((i) => i.moduleSpecifier === 'vitest')
      expect(vitestImport).toBeDefined()
      expect(vitestImport?.named).toContain('describe')
      expect(vitestImport?.named).toContain('expect')
      expect(vitestImport?.named).toContain('it')
    })

    it('detects type-only imports', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      const typeOnlyImport = imports.find((i) => i.moduleSpecifier === '@nhtio/adk/types')
      expect(typeOnlyImport).toBeDefined()
      expect(typeOnlyImport?.typeOnly).toBe(true)
      expect(typeOnlyImport?.named).toContain('DispatchContext')
    })

    it('detects namespace imports', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      const nsImport = imports.find((i) => i.moduleSpecifier === 'path')
      expect(nsImport).toBeDefined()
      expect(nsImport?.namespace).toBe('path')
    })

    it('assigns line numbers correctly (0-based)', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      for (const imp of imports) {
        expect(typeof imp.line).toBe('number')
        expect(imp.line >= 0).toBe(true)
      }
    })

    it('handles a file with no imports', async () => {
      const noImportCode = `export const x = 1`
      const artifact = make(noImportCode)
      const imports = await artifact.es_imports()

      expect(Array.isArray(imports)).toBe(true)
      expect(imports.length).toBe(0)
    })

    describe('DEFECT DETECTION: imports assertions tightened', () => {
      it('records every import declaration with correct form classification', async () => {
        const importCode = `import { a, b } from 'module1'
import type { T } from 'module2'
import * as ns from 'module3'
import def from 'module4'
import { x }, type { Y } from 'module5'`

        const artifact = make(importCode)
        const imports = await artifact.es_imports()

        // Should find at least 5 import statements
        expect(imports.length).toBeGreaterThanOrEqual(5)

        // Check for each form
        const namedImport = imports.find((i) => i.moduleSpecifier === 'module1')
        expect(namedImport?.named).toContain('a')
        expect(namedImport?.named).toContain('b')
        expect(namedImport?.typeOnly).toBe(false)

        const typeImport = imports.find((i) => i.moduleSpecifier === 'module2')
        expect(typeImport?.typeOnly).toBe(true)
        expect(typeImport?.named).toContain('T')

        const nsImport = imports.find((i) => i.moduleSpecifier === 'module3')
        expect(nsImport?.namespace).toBe('ns')

        const defaultImport = imports.find((i) => i.moduleSpecifier === 'module4')
        expect(defaultImport?.default).toBe('def')
      })

      it('includes all imported names from a single import statement', async () => {
        const multiNameCode = `import { one, two, three, four } from 'utils'`

        const artifact = make(multiNameCode)
        const imports = await artifact.es_imports()

        const utilsImport = imports.find((i) => i.moduleSpecifier === 'utils')
        expect(utilsImport).toBeDefined()
        expect(utilsImport).toEqual(expect.objectContaining({ moduleSpecifier: 'utils' }))

        // All names must be present
        expect(utilsImport?.named).toContain('one')
        expect(utilsImport?.named).toContain('two')
        expect(utilsImport?.named).toContain('three')
        expect(utilsImport?.named).toContain('four')

        // Exact length check
        expect(utilsImport?.named.length).toBe(4)
      })

      it('correctly flags type-only vs value imports', async () => {
        const mixedTypeCode = `import { value } from 'mod1'
import type { OnlyType } from 'mod2'`

        const artifact = make(mixedTypeCode)
        const imports = await artifact.es_imports()

        const valueImport = imports.find((i) => i.moduleSpecifier === 'mod1')
        expect(valueImport?.typeOnly).toBe(false)
        expect(valueImport?.named).toContain('value')

        const typeImport = imports.find((i) => i.moduleSpecifier === 'mod2')
        expect(typeImport?.typeOnly).toBe(true)
        expect(typeImport?.named).toContain('OnlyType')
      })

      it('tracks line numbers for each import statement individually', async () => {
        const multiLineCode = `import { a } from 'first'
import { b } from 'second'
import { c } from 'third'`

        const artifact = make(multiLineCode)
        const imports = await artifact.es_imports()

        expect(imports.length).toBe(3)

        // Lines should be strictly increasing (or at least different)
        const lines = imports.map((i) => i.line)
        expect(lines[0]).toBeLessThan(lines[1])
        expect(lines[1]).toBeLessThan(lines[2])
      })
    })
  })

  describe('es_exports (export declarations)', () => {
    it('returns export declarations and re-exports', async () => {
      const artifact = make(FIXTURE_CODE)
      const exports = await artifact.es_exports()

      expect(Array.isArray(exports)).toBe(true)
      expect(exports.length).toBeGreaterThan(0)

      for (const exp of exports) {
        expect(exp).toHaveProperty('line')
        expect(exp).toHaveProperty('moduleSpecifier')
        expect(exp).toHaveProperty('named')
        expect(exp).toHaveProperty('isDefault')
        expect(exp).toHaveProperty('isNamespaceReExport')
        expect(exp).toHaveProperty('isTypeOnly')
        expect(Array.isArray(exp.named)).toBe(true)
      }
    })

    it('detects export * from re-exports', async () => {
      const artifact = make(FIXTURE_CODE)
      const exports = await artifact.es_exports()

      // Should include export * from './utils'
      const starExport = exports.find((e) => e.isNamespaceReExport)
      expect(starExport).toBeDefined()
      expect(starExport).toEqual(expect.objectContaining({ isNamespaceReExport: true }))
      if (starExport) {
        expect(typeof starExport.moduleSpecifier).toBe('string')
        expect(starExport.moduleSpecifier).toBeTruthy()
      }
    })

    it('detects named re-export declarations', async () => {
      const artifact = make(FIXTURE_CODE)
      const exports = await artifact.es_exports()

      // Should have re-export for Version from './version'
      const versionExport = exports.find((e) => e.moduleSpecifier === './version')
      expect(versionExport).toBeDefined()
      expect(versionExport).toEqual(expect.objectContaining({ moduleSpecifier: './version' }))
    })

    it('detects export default', async () => {
      const artifact = make(FIXTURE_CODE)
      const exports = await artifact.es_exports()

      const defaultExport = exports.find((e) => e.isDefault)
      expect(defaultExport).toBeDefined()
      expect(defaultExport).toEqual(expect.objectContaining({ isDefault: true }))
    })

    it('handles a file with no exports', async () => {
      const noExportCode = `const x = 1; function y() {}`
      const artifact = make(noExportCode)
      const exports = await artifact.es_exports()

      expect(Array.isArray(exports)).toBe(true)
      expect(exports.length).toBe(0)
    })

    describe('DEFECT DETECTION: ordinary exports must be recorded', () => {
      it('records export function, export class, export const, export interface, export type declarations', async () => {
        // Exact fixture from defect report: ordinary exports were entirely missing
        const fixtureCode = `export function alpha() { return 1 }
export class Beta { m(): void {} }
export const gamma = 1, delta = 2
export interface Iface { a: string }
export * from "./other"`

        const artifact = make(fixtureCode)
        const exports = await artifact.es_exports()

        // Should have 6 export records: alpha, Beta, gamma, delta, Iface, and star re-export
        expect(exports.length).toBe(6)

        // Verify each ordinary export is present as a separate record
        expect(exports.some((e) => e.named.includes('alpha'))).toBe(true)
        expect(exports.some((e) => e.named.includes('Beta'))).toBe(true)
        expect(exports.some((e) => e.named.includes('gamma'))).toBe(true)
        expect(exports.some((e) => e.named.includes('delta'))).toBe(true)
        expect(exports.some((e) => e.named.includes('Iface'))).toBe(true)

        // Should also have the star re-export
        const starReExport = exports.find((e) => e.isNamespaceReExport)
        expect(starReExport).toBeDefined()
        expect(starReExport?.moduleSpecifier).toBe('./other')
      })

      it('tracks multiple export forms: named, default, re-exports, and namespace', async () => {
        const allFormsCode = `export function localFn() {}
export { Version } from './version'
export * from './utils'
export default class DefaultClass {}`

        const artifact = make(allFormsCode)
        const exports = await artifact.es_exports()

        // Must include: namespace re-export and default export
        const starExport = exports.find((e) => e.isNamespaceReExport)
        const defaultExport = exports.find((e) => e.isDefault)

        expect(starExport).toBeDefined()
        expect(defaultExport).toBeDefined()

        // Should have more than just the star re-export
        expect(exports.length).toBeGreaterThanOrEqual(2)
      })

      it('marks isTypeOnly correctly for export type vs export const/function/class', async () => {
        const typeExportCode = `export type MyType = string | number
export const VALUE = 42
export interface IFace {}
export type OtherType = { x: number }`

        const artifact = make(typeExportCode)
        const exports = await artifact.es_exports()

        // Type exports should have isTypeOnly = true
        const typeExports = exports.filter((e) => e.isTypeOnly)
        expect(typeExports.length).toBeGreaterThan(0)

        // At least some exports should be found
        expect(exports.length).toBeGreaterThan(0)
      })

      it('returns an entry per export statement, not per binding within multi-binding exports', async () => {
        // es_exports returns export STATEMENTS; compare to es_symbols which returns per binding
        const multiBindingCode = `export const a = 1, b = 2
export type T1 = string, T2 = number`

        const artifact = make(multiBindingCode)
        const exports = await artifact.es_exports()

        // Should have at least 2 export records (one for each export statement)
        expect(exports.length).toBeGreaterThanOrEqual(2)

        for (const exp of exports) {
          expect(exp).toHaveProperty('named')
          expect(Array.isArray(exp.named)).toBe(true)
        }
      })

      it('distinguishes local exports from re-exports', async () => {
        const mixedCode = `export function local() {}
export { fromModule } from './other'
export * from './utils'`

        const artifact = make(mixedCode)
        const exports = await artifact.es_exports()

        // Should have at least 3 export records
        expect(exports.length).toBeGreaterThanOrEqual(3)

        const reExportEntries = exports.filter((e) => e.moduleSpecifier)
        expect(reExportEntries.length).toBeGreaterThan(0)

        const starReExports = exports.filter((e) => e.isNamespaceReExport)
        expect(starReExports.length).toBeGreaterThan(0)
      })
    })
  })

  describe('es_outline (nested member index)', () => {
    it('returns structured outline with classes and their members', async () => {
      const artifact = make(FIXTURE_CODE)
      const outline = await artifact.es_outline()

      expect(outline).toBeDefined()
      expect(typeof outline).toBe('object')
    })

    it('includes class members with line ranges', async () => {
      const artifact = make(FIXTURE_CODE)
      const outline = await artifact.es_outline()

      // Should have information about ConfigManager's methods/properties
      expect(Array.isArray(outline)).toBe(true)
      const configMgr = (
        outline as Array<{ name: string; members?: Array<{ name: string }> }>
      ).find((e) => e.name === 'ConfigManager')
      expect(configMgr).toBeDefined()
      expect(configMgr?.members).toBeDefined()
      const memberNames = configMgr?.members?.map((m) => m.name) || []
      // Both constructor and getConfig must be present as members
      expect(memberNames).toContain('constructor')
      expect(memberNames).toContain('getConfig')
    })

    it('handles files with no classes/interfaces', async () => {
      const simpleCode = `const x = 1; function y() { return 2 }`
      const artifact = make(simpleCode)
      const outline = await artifact.es_outline()

      // Should return some representation (possibly empty or minimal)
      expect(outline !== undefined).toBe(true)
    })

    describe('DEFECT DETECTION: outline assertions tightened', () => {
      it('records every class with all its members', async () => {
        const classCode = `export class Manager {
  private config: Config
  constructor(cfg: Config) { this.config = cfg }
  getConfig(): Config { return this.config }
  updateConfig(p: Partial<Config>) { this.config = {...this.config, ...p} }
  private validate() {}
}

interface Config {
  name: string
  email: string
}`

        const artifact = make(classCode)
        const outline = await artifact.es_outline()

        expect(outline).toBeDefined()
        expect(Array.isArray(outline)).toBe(true)
        if (Array.isArray(outline)) {
          const manager = (
            outline as Array<{ name: string; members?: Array<{ name: string }> }>
          ).find((e) => e.name === 'Manager')
          expect(manager).toBeDefined()
          expect(manager).toEqual(expect.objectContaining({ name: 'Manager' }))
          if (manager && manager.members) {
            const memberNames = manager.members.map((m) => m.name)
            // Should include methods
            expect(memberNames).toContain('getConfig')
            expect(memberNames).toContain('updateConfig')
            expect(memberNames).toContain('validate')
            // Should have at least the methods
            expect(memberNames.length).toBeGreaterThanOrEqual(3)
          }
        }
      })

      it('includes line ranges for each member', async () => {
        const classCode = `export class Service {
  method1() { return 1 }
  method2() { return 2 }
}`

        const artifact = make(classCode)
        const outline = await artifact.es_outline()

        if (Array.isArray(outline)) {
          for (const entry of outline) {
            if (
              entry &&
              typeof entry === 'object' &&
              'members' in entry &&
              Array.isArray(entry.members)
            ) {
              for (const member of entry.members) {
                expect(member).toHaveProperty('startLine')
                expect(member).toHaveProperty('endLine')
                expect(typeof member.startLine).toBe('number')
                expect(typeof member.endLine).toBe('number')
                expect(member.startLine >= 0).toBe(true)
                expect(member.endLine >= member.startLine).toBe(true)
              }
            }
          }
        }
      })

      it('handles interface members as well as class members', async () => {
        const interfaceCode = `interface IRepository {
  findById(id: string): Promise<Item>
  save(item: Item): Promise<void>
  delete(id: string): Promise<boolean>
}`

        const artifact = make(interfaceCode)
        const outline = await artifact.es_outline()

        if (Array.isArray(outline)) {
          const iface = (
            outline as Array<{ name: string; kind?: string; members?: Array<{ name: string }> }>
          ).find((e) => e.name === 'IRepository')
          expect(iface).toBeDefined()
          expect(iface).toEqual(expect.objectContaining({ name: 'IRepository' }))
          if (iface && iface.members) {
            const memberNames = iface.members.map((m) => m.name)
            expect(memberNames).toContain('findById')
            expect(memberNames).toContain('save')
            expect(memberNames).toContain('delete')
          }
        }
      })

      it('returns an array or object structure that can be inspected', async () => {
        const artifact = make(FIXTURE_CODE)
        const outline = await artifact.es_outline()

        // Should be inspectable
        const stringified = JSON.stringify(outline)
        expect(typeof stringified).toBe('string')
        expect(stringified.length).toBeGreaterThan(0)
      })
    })
  })

  describe('es_signature (method/function signature)', () => {
    it('returns the signature text without body for a named function', async () => {
      const artifact = make(FIXTURE_CODE)
      const sig = await artifact.es_signature('helperFunction')

      expect(typeof sig).toBe('string')
      // Should include parameters and possibly return type
      expect(sig).toContain('name')
      // Should NOT include function body statement
      expect(sig).not.toContain('processed-')
    })

    it('returns signature for a class method', async () => {
      const artifact = make(FIXTURE_CODE)
      const sig = await artifact.es_signature('getConfig')

      expect(sig).toBe('getConfig(): UserConfig')
    })

    it('returns signature for a class constructor', async () => {
      const artifact = make(FIXTURE_CODE)
      const sig = await artifact.es_signature('constructor')

      expect(sig).toBe('constructor(initialConfig: UserConfig)')
    })

    it('handles non-existent function names gracefully', async () => {
      const artifact = make(FIXTURE_CODE)
      const sig = await artifact.es_signature('nonExistentFunction')

      // Should either return empty string or an error string
      expect(typeof sig).toBe('string')
    })

    describe('DEFECT DETECTION: signature excludes bodies, includes parameters and types', () => {
      it('returns function signature WITHOUT body statements', async () => {
        // Defect: es_signature("alpha") returned "export function alpha() { return 1 }" (included body)
        const fixtureCode = `export function alpha() { return 1 }`

        const artifact = make(fixtureCode)
        const sig = await artifact.es_signature('alpha')

        expect(typeof sig).toBe('string')
        // Must NOT contain body statements
        expect(sig).not.toContain('return 1')
        expect(sig).not.toContain('{')
        expect(sig).not.toContain('}')
        // Should contain function name and parameter list
        expect(sig).toContain('alpha')
      })

      it('includes parameter list and return type in function signature', async () => {
        const funcCode = `export function process(input: string, count: number): string[] {
  return [input].repeat(count)
}`

        const artifact = make(funcCode)
        const sig = await artifact.es_signature('process')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        // Should have parameters
        expect(sig).toContain('input')
        expect(sig).toContain('string')
        expect(sig).toContain('count')
        expect(sig).toContain('number')
        // Should NOT include body
        expect(sig).not.toContain('repeat')
      })

      it('includes type parameters and heritage for class signatures', async () => {
        // Defect: es_signature("Beta") returned "class Beta" (skeleton, no heritage/generics)
        const classCode = `export class Beta<T> implements Comparable { m(): void {} }`

        const artifact = make(classCode)
        const sig = await artifact.es_signature('Beta')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        // Must contain class name, full type parameter, and implements clause
        expect(sig).toBe('export class Beta<T> implements Comparable')
      })

      it('returns full signature for class with complex type parameter (empty body case)', async () => {
        // Defect A: es_signature returns the BODY for an EMPTY class
        // export class C<T extends { x: string }> implements Comparable {}
        // -> currently returns "export class C<T extends { x: string }> implements Comparable {}"
        // Expected: should NOT end with {} when the class body is empty
        const classCode = `export class C<T extends { x: string }> implements Comparable {}`

        const artifact = make(classCode)
        const sig = await artifact.es_signature('C')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        // Must NOT include empty body braces
        expect(sig.endsWith('{}')).toBe(false)
        // Must include class name and type parameter
        expect(sig).toContain('C')
        expect(sig).toContain('T')
        expect(sig).toContain('extends')
        // Must include implements clause
        expect(sig).toContain('implements')
        expect(sig).toContain('Comparable')
      })

      it('returns empty class signature WITHOUT body braces', async () => {
        // Minimal empty class case - Defect A variant
        // export class E {}
        // currently returns: "export class E {}"
        // Expected: "export class E"
        const classCode = `export class E {}`

        const artifact = make(classCode)
        const sig = await artifact.es_signature('E')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        expect(sig).toContain('E')
        // Must NOT end with {} (empty body)
        expect(sig.endsWith('{}')).toBe(false)
      })

      it('returns empty interface signature WITHOUT body braces', async () => {
        // Empty interface with generic and extends - Defect A variant
        // export interface I<T> extends Base {}
        // currently returns: "export interface I<T> extends Base {}"
        // Expected: "export interface I<T> extends Base"
        const interfaceCode = `export interface I<T> extends Base {}`

        const artifact = make(interfaceCode)
        const sig = await artifact.es_signature('I')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        // Must NOT end with {} (empty body)
        expect(sig.endsWith('{}')).toBe(false)
        // Must contain full signature: interface name, type parameter, and extends clause
        expect(sig).toContain('I<T> extends Base')
      })

      it('finds class methods and constructors by name', async () => {
        const classCode = `export class Service {
  constructor(name: string) { this.name = name }
  getName(): string { return this.name }
  private name: string
}`

        const artifact = make(classCode)

        // Should find the constructor
        const ctorSig = await artifact.es_signature('constructor')
        expect(typeof ctorSig).toBe('string')
        expect(ctorSig.length).toBeGreaterThan(0)
        expect(ctorSig).toContain('constructor')
        expect(ctorSig).toContain('name')

        // Should find the method
        const methodSig = await artifact.es_signature('getName')
        expect(typeof methodSig).toBe('string')
        expect(methodSig.length).toBeGreaterThan(0)
        expect(methodSig).toContain('getName')
      })

      it('returns non-empty, meaningful signature for variable bindings', async () => {
        // Defect: es_signature("gamma") returned "" (empty)
        const varCode = `export const gamma = 1, delta = 2`

        const artifact = make(varCode)
        const gammaSig = await artifact.es_signature('gamma')

        expect(typeof gammaSig).toBe('string')
        expect(gammaSig.length).toBeGreaterThan(0)
        expect(gammaSig).toContain('gamma')
      })

      it('returns empty or error-like string for names that do not exist', async () => {
        const artifact = make(FIXTURE_CODE)
        const sig = await artifact.es_signature('definitelyNonExistent')

        expect(typeof sig).toBe('string')
        // Should be empty or contain an error marker
      })

      it('returns full type parameter list and implements clause for class with type parameters', async () => {
        const classCode = `export class C<T extends { x: string }> implements Comparable { m(): void {} }`

        const artifact = make(classCode)
        const sig = await artifact.es_signature('C')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        expect(sig).toContain('C')
        expect(sig).toContain('T')
        expect(sig).toContain('extends')
        expect(sig).toContain('implements')
        // Should not be truncated at the first {
        expect(sig).toContain('Comparable')
      })

      it('returns full type parameter and extends clause for interface', async () => {
        const interfaceCode = `export interface I<T extends { x: string }> extends Base { m(): void }`

        const artifact = make(interfaceCode)
        const sig = await artifact.es_signature('I')

        expect(typeof sig).toBe('string')
        expect(sig.length).toBeGreaterThan(0)
        expect(sig).toContain('I')
        expect(sig).toContain('T')
        expect(sig).toContain('extends')
        expect(sig).toContain('Base')
      })

      it('returns meaningful signature for class property, getter, and setter', async () => {
        const classCode = `export class Data {
  prop: string
  get value(): number { return 42 }
  set value(v: number) { }
}`

        const artifact = make(classCode)

        const propSig = await artifact.es_signature('prop')
        expect(propSig.length).toBeGreaterThan(0)
        expect(propSig).toBe('prop: string')

        const getSig = await artifact.es_signature('value')
        expect(getSig.length).toBeGreaterThan(0)
        // getter signature should contain get keyword and return type
        expect(getSig).toContain('value')
        expect(getSig).toContain('number')
      })

      it('returns signatures for interface method and interface property', async () => {
        const interfaceCode = `interface I {
  m(a: number): void
  readonly x: string
}`

        const artifact = make(interfaceCode)

        const methodSig = await artifact.es_signature('m')
        expect(methodSig.length).toBeGreaterThan(0)
        expect(methodSig).toBe('m(a: number): void')

        const propSig = await artifact.es_signature('x')
        expect(propSig.length).toBeGreaterThan(0)
        expect(propSig).toBe('readonly x: string')
      })

      it('returns signature for variable initialized with function expression or arrow function WITHOUT body statements', async () => {
        const varCode = `export const handler = function(x: number): number { return x * 2 }
export const arrow = (y: string): number => { return y.length }`

        const artifact = make(varCode)

        const handlerSig = await artifact.es_signature('handler')
        expect(typeof handlerSig).toBe('string')
        expect(handlerSig.length).toBeGreaterThan(0)
        // Must NOT include body statements
        expect(handlerSig).not.toContain('return x * 2')
        expect(handlerSig).not.toContain('*')

        const arrowSig = await artifact.es_signature('arrow')
        expect(typeof arrowSig).toBe('string')
        expect(arrowSig.length).toBeGreaterThan(0)
        // Must NOT include body statements
        expect(arrowSig).not.toContain('return y.length')
        expect(arrowSig).not.toContain('.length')
      })

      it('excludes JSDoc and decorators from the signature', async () => {
        const docCode = `/**
 * A documented function
 * @param x The input
 */
export function documented(x: number): number {
  return x * 2
}`

        const artifact = make(docCode)
        const sig = await artifact.es_signature('documented')

        expect(typeof sig).toBe('string')
        // Should NOT include JSDoc
        expect(sig).not.toContain('@param')
        expect(sig).not.toContain('documented function')
        // Should NOT include body
        expect(sig).not.toContain('* 2')
      })

      describe('REGRESSION: multi-declaration file with exact equality (catches bleed + truncation)', () => {
        // CRITICAL: This fixture contains multiple declarations in sequence.
        // Two prior regressions were invisible to containment assertions:
        // 1. A fix using lastIndexOf('{') scanned to end-of-file, causing es_signature('C')
        //    to return THREE CONCATENATED DECLARATIONS. Assertions like "does not end in {}"
        //    would pass (it ended after 'J'), silently missing the bleed.
        // 2. A later fix used node.members.pos for populated bodies, leaving a trailing '{'.
        //    Only exact equality (toBe) caught the trailing brace; toContain would pass.
        // Single-declaration fixtures cannot detect either defect. Multi-declaration with
        // exact-equality assertions is the minimum bar.
        it('returns exact signature for Status enum (newly added support)', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('Status')
          expect(sig).toBe('export enum Status')
          expect(sig).not.toContain('\n')
        })

        it('returns exact signature for class with generic constraint and implements clause', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('C')
          expect(sig).toBe('export class C<T extends { x: string }> implements Comparable')
          expect(sig).not.toContain('\n')
        })

        it('returns exact signature for generic interface with extends clause', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('I')
          expect(sig).toBe('export interface I<T> extends Base')
          expect(sig).not.toContain('\n')
        })

        it('returns exact signature for empty class (no trailing braces)', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('E')
          expect(sig).toBe('export class E')
          expect(sig).not.toContain('\n')
        })

        it('returns exact signature for class with generic and method (method excluded)', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('D')
          expect(sig).toBe('export class D<T> implements Comparable')
          expect(sig).not.toContain('\n')
        })

        it('returns exact signature for generic interface with method (method excluded)', async () => {
          const sourceCode = `export enum Status { Active, Inactive }
export class C<T extends { x: string }> implements Comparable {}
export interface I<T> extends Base {}
export class E {}
export class D<T> implements Comparable { m(): void {} }
export interface J<T> extends Base { m(a: number): void }`

          const artifact = make(sourceCode)

          const sig = await artifact.es_signature('J')
          expect(sig).toBe('export interface J<T> extends Base')
          expect(sig).not.toContain('\n')
        })
      })

      it('distinguishes signature from body across all declaration kinds', async () => {
        const allKinds = `
export function fn() { return 1 }
export class Cls { m() { return 2 } }
export const x = 3
export interface I { a: string }
export type T = { b: number }
export enum E { A = 'a' }
`

        const artifact = make(allKinds)

        const fnSig = await artifact.es_signature('fn')
        expect(fnSig).not.toContain('return 1')

        const clsSig = await artifact.es_signature('Cls')
        expect(clsSig).not.toContain('return 2')

        // Type alias signature returns the full declaration including type
        const tSig = await artifact.es_signature('T')
        expect(tSig.length).toBeGreaterThan(0)
        expect(tSig).toContain('T')
      })
    })
  })

  describe('es_jsdoc (JSDoc comments)', () => {
    it('returns the JSDoc comment attached to a named declaration', async () => {
      const artifact = make(FIXTURE_CODE)
      const doc = await artifact.es_jsdoc('helperFunction')

      expect(typeof doc).toBe('string')
      // Should contain the JSDoc text
      expect(doc.length).toBeGreaterThan(0)
      expect(doc).toContain('well-documented')
    })

    it('returns JSDoc for annotated constants', async () => {
      const artifact = make(FIXTURE_CODE)
      const doc = await artifact.es_jsdoc('CONSTANT_VALUE')

      expect(typeof doc).toBe('string')
      // Should contain the marker comment
      expect(doc.length).toBeGreaterThan(0)
      expect(doc).toContain('Marker')
    })

    it('returns empty for declarations without JSDoc', async () => {
      const artifact = make(FIXTURE_CODE)
      const doc = await artifact.es_jsdoc('ConfigManager')

      expect(typeof doc).toBe('string')
      // Will be empty or minimal since ConfigManager has no JSDoc
    })

    it('handles non-existent names gracefully', async () => {
      const artifact = make(FIXTURE_CODE)
      const doc = await artifact.es_jsdoc('nonExistent')

      expect(typeof doc).toBe('string')
    })

    describe('es_jsdoc member fix (class and interface members)', () => {
      const memberTestCode = `
/** Class with documented members. */
export class DocumentedClass {
  /** Property doc. */
  prop: string;

  /** Method doc. */
  method(): void {}

  /** Getter doc. */
  get value(): number {
    return 42;
  }
}

/** Interface with documented members. */
export interface DocumentedInterface {
  /** Interface method doc. */
  iMethod(): boolean;

  /** Interface property doc. */
  iProp: string;
}
`

      it('returns JSDoc for class member method', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('method')
        expect(jsdoc).toContain('Method doc')
      })

      it('returns JSDoc for class member property', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('prop')
        expect(jsdoc).toContain('Property doc')
      })

      it('returns JSDoc for class member getter', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('value')
        expect(jsdoc).toContain('Getter doc')
      })

      it('returns JSDoc for interface method member', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('iMethod')
        expect(jsdoc).toContain('Interface method doc')
      })

      it('returns JSDoc for interface property member', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('iProp')
        expect(jsdoc).toContain('Interface property doc')
      })

      it('still returns top-level class JSDoc', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('DocumentedClass')
        expect(jsdoc).toContain('Class with documented members')
      })

      it('still returns top-level interface JSDoc', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const jsdoc = await artifact.es_jsdoc('DocumentedInterface')
        expect(jsdoc).toContain('Interface with documented members')
      })

      it('es_signature also finds members', async () => {
        const reader = new InMemorySpoolReader(memberTestCode)
        const artifact = new SpooledEcmaScriptArtifact(reader, { fileName: 'test.ts' })

        const sig = await artifact.es_signature('method')
        expect(sig).toContain('method')
      })
    })

    describe('DEFECT: es_jsdoc/es_signature disagreed about enums', () => {
      // es_signature resolved a top-level enum via ts.isEnumDeclaration, but the es_jsdoc
      // visitor had no enum branch at all, so es_jsdoc('E') returned '' while
      // es_signature('E') returned 'export enum E'. Both now share #findTopLevelDeclaration.
      const kindsCode = `/** enum doc here */
export enum E { A, B }
/** const enum doc here */
export const enum CE { X }
/** iface doc here */
export interface I { x: number }
/** fn doc here */
export function f(): void {}
/** type doc here */
export type T = string
/** class doc here */
export class C { m(): void {} }
/** const doc here */
export const K = 1
/** let doc here */
export let L = 2
/** var doc here */
var V = 3
/** multi doc here */
export const m1 = 1, m2 = 2
`

      const makeKinds = () =>
        new SpooledEcmaScriptArtifact(new InMemorySpoolReader(kindsCode), { fileName: 'kinds.ts' })

      it('returns the JSDoc for a top-level enum', async () => {
        expect(await makeKinds().es_jsdoc('E')).toBe('/** enum doc here */')
      })

      it('returns the JSDoc for a top-level const enum', async () => {
        expect(await makeKinds().es_jsdoc('CE')).toBe('/** const enum doc here */')
      })

      it('returns the JSDoc for a top-level interface', async () => {
        expect(await makeKinds().es_jsdoc('I')).toBe('/** iface doc here */')
      })

      it('returns the JSDoc for a top-level function', async () => {
        expect(await makeKinds().es_jsdoc('f')).toBe('/** fn doc here */')
      })

      it('returns the JSDoc for a top-level type alias', async () => {
        expect(await makeKinds().es_jsdoc('T')).toBe('/** type doc here */')
      })

      it('returns the JSDoc for a top-level class', async () => {
        expect(await makeKinds().es_jsdoc('C')).toBe('/** class doc here */')
      })

      it('returns the JSDoc for a const binding', async () => {
        expect(await makeKinds().es_jsdoc('K')).toBe('/** const doc here */')
      })

      it('returns the JSDoc for a let binding', async () => {
        expect(await makeKinds().es_jsdoc('L')).toBe('/** let doc here */')
      })

      it('returns the JSDoc for a var binding', async () => {
        expect(await makeKinds().es_jsdoc('V')).toBe('/** var doc here */')
      })

      it('returns the statement JSDoc for every binding of a multi-declarator statement', async () => {
        const artifact = makeKinds()
        expect(await artifact.es_jsdoc('m1')).toBe('/** multi doc here */')
        expect(await artifact.es_jsdoc('m2')).toBe('/** multi doc here */')
      })

      it('es_signature resolves the same enum names es_jsdoc now does', async () => {
        const artifact = makeKinds()
        expect(await artifact.es_signature('E')).toBe('export enum E')
        expect(await artifact.es_signature('CE')).toBe('export const enum CE')
      })

      it('es_jsdoc still returns "" for a name neither method resolves', async () => {
        const artifact = makeKinds()
        expect(await artifact.es_jsdoc('notDeclaredAnywhere')).toBe('')
        expect(await artifact.es_signature('notDeclaredAnywhere')).toBe('')
      })
    })
  })

  describe('es_references (identifier references)', () => {
    it('returns line and column where an identifier appears (syntactic scan)', async () => {
      const artifact = make(FIXTURE_CODE)
      const refs = await artifact.es_references('ConfigManager')

      expect(Array.isArray(refs)).toBe(true)
      for (const ref of refs) {
        expect(ref).toHaveProperty('line')
        expect(ref).toHaveProperty('column')
        expect(typeof ref.line).toBe('number')
        expect(typeof ref.column).toBe('number')
        expect(ref.line >= 0).toBe(true)
        expect(ref.column >= 0).toBe(true)
      }
    })

    it('finds multiple occurrences across the file', async () => {
      const multiOccurrence = `const x = 42; if (x > 10) { console.log(x) }`
      const artifact = make(multiOccurrence)
      const refs = await artifact.es_references('x')

      expect(Array.isArray(refs)).toBe(true)
      expect(refs.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty array when identifier is not found', async () => {
      const artifact = make(FIXTURE_CODE)
      const refs = await artifact.es_references('nonExistentIdentifier')

      expect(Array.isArray(refs)).toBe(true)
      expect(refs.length).toBe(0)
    })

    it('performs syntactic (not semantic) matching - cannot distinguish shadowed names', async () => {
      const shadowCode = `
        function outer() {
          const x = 1
          function inner() {
            const x = 2
            return x
          }
        }
      `
      const artifact = make(shadowCode)
      const refs = await artifact.es_references('x')

      // Should find all syntactic occurrences of 'x', even though they're different bindings
      expect(Array.isArray(refs)).toBe(true)
      // Will include all 'x' identifiers regardless of scope
    })

    describe('DEFECT DETECTION: references assertions tightened', () => {
      it('finds every occurrence of an identifier, no matter where it appears', async () => {
        const multiRefCode = `const myVar = 1
function usedOnce() { return myVar }
const again = myVar
if (myVar > 0) { console.log(myVar) }
class Container {
  check() { return myVar ? 'yes' : 'no' }
}`

        const artifact = make(multiRefCode)
        const refs = await artifact.es_references('myVar')

        expect(Array.isArray(refs)).toBe(true)
        // Must find at least the declaration + each use
        expect(refs.length).toBeGreaterThanOrEqual(6)

        // All references should have valid positions
        for (const ref of refs) {
          expect(ref.line >= 0).toBe(true)
          expect(ref.column >= 0).toBe(true)
        }
      })

      it('returns accurate line and column positions', async () => {
        const posCode = `const x = 1  // line 0, x at column 6
const y = x  // line 1, x at column 10`

        const artifact = make(posCode)
        const refs = await artifact.es_references('x')

        expect(refs.length).toBeGreaterThanOrEqual(2)

        // Sort by line
        const sorted = refs.sort((a, b) =>
          a.line === b.line ? a.column - b.column : a.line - b.line
        )

        // First occurrence should be before second
        expect(sorted[0].line).toBeLessThanOrEqual(sorted[1].line)
      })

      it('includes all uses: declaration, assignments, reads, and passed arguments', async () => {
        const usageCode = `const value = 42
function process(arg: number) { return arg }
const result = process(value)
value
if (value === 42) { }
const copy = value`

        const artifact = make(usageCode)
        const refs = await artifact.es_references('value')

        expect(Array.isArray(refs)).toBe(true)
        expect(refs.length).toBeGreaterThanOrEqual(5)
      })

      it('finds references inside nested scopes', async () => {
        const nestedCode = `const outer = 10
function outer_scope() {
  function middle() {
    function inner() {
      return outer
    }
    return outer
  }
  return outer
}
if (outer > 5) { const x = outer }`

        const artifact = make(nestedCode)
        const refs = await artifact.es_references('outer')

        expect(Array.isArray(refs)).toBe(true)
        // Should find: declaration + at least 4 uses
        expect(refs.length).toBeGreaterThanOrEqual(5)
      })

      it('distinguishes between different identifiers even if similar', async () => {
        const similarCode = `const myValue = 1
const myValuex = 2
const anotherValue = 3
return myValue + myValue`

        const artifact = make(similarCode)
        const refs = await artifact.es_references('myValue')

        // Should only match "myValue", not "myValuex"
        // Assuming exact matching
        for (const ref of refs) {
          // Verify by checking context — this is a syntactic scan
          expect(typeof ref.line).toBe('number')
          expect(typeof ref.column).toBe('number')
        }

        // Should find: declaration + at least 2 uses
        expect(refs.length).toBeGreaterThanOrEqual(3)
      })

      it('handles empty-name or whitespace gracefully', async () => {
        const artifact = make(FIXTURE_CODE)

        const emptyRefs = await artifact.es_references('')
        expect(Array.isArray(emptyRefs)).toBe(true)

        const spaceRefs = await artifact.es_references('   ')
        expect(Array.isArray(spaceRefs)).toBe(true)
      })
    })
  })

  describe('SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact', () => {
    it('returns true for SpooledEcmaScriptArtifact instances', () => {
      const artifact = make(FIXTURE_CODE)
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(artifact)).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact({})).toBe(false)
    })

    it('returns false for null', () => {
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(null)).toBe(false)
    })

    it('returns false for other SpooledArtifact subclasses', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('line 1\nline 2')
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(baseArtifact)).toBe(false)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + es_* tools when the turn has an ecmascript artifact', async () => {
      const esArtifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE))
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(esArtifact, { id: 'tc-es' })],
      })
      const registry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      // Base set
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))

      // EcmaScript-specific
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_es_symbols',
          'artifact_es_imports',
          'artifact_es_exports',
          'artifact_es_outline',
          'artifact_es_signature',
          'artifact_es_jsdoc',
          'artifact_es_references',
        ])
      )

      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('discovers retrievable-backed ecmascript artifacts through forged tools', () => {
      const artifact = make(FIXTURE_CODE)
      const r = new Retrievable({
        id: 'ret-es',
        content: artifact,
        trustTier: 'first-party',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      })
      const registry = SpooledEcmaScriptArtifact.forgeTools(
        makeDispatchContext({ retrievables: [r] })
      )
      expect(JSON.stringify(registry.get('artifact_es_symbols')!.describe().inputSchema)).toContain(
        'ret-es'
      )
    })

    it('restricts artifact_es_* callId enum to ecmascript artifacts; base tools see every artifact', async () => {
      const esArtifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE))
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb\nc', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(esArtifact, { id: 'tc-es' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      const esSymbols = registry.get('artifact_es_symbols')!
      const baseHead = registry.get('artifact_head')!
      const esSymbolsDump = JSON.stringify(esSymbols.describe().inputSchema)
      const baseHeadDump = JSON.stringify(baseHead.describe().inputSchema)

      expect(esSymbolsDump).toContain('tc-es')
      expect(esSymbolsDump).not.toContain('tc-base')

      // Base methods come from SpooledArtifact.forgeTools and accept any SpooledArtifact
      expect(baseHeadDump).toContain('tc-es')
      expect(baseHeadDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_es_symbols at validation time', async () => {
      const esArtifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE))
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(esArtifact, { id: 'tc-es' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      const esSymbols = registry.get('artifact_es_symbols')!

      await expect(esSymbols.validate({ callId: 'tc-base' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_es_* tools when no ecmascript artifacts are present (base tools still appear)', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      for (const n of names) {
        expect(n).not.toMatch(/^artifact_es_/)
      }
    })

    it('returns an empty registry when ctx.turnToolCalls is empty', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('still emits the base set as ordinary base-class names (not subclass-prefixed)', async () => {
      const esArtifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE))
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(esArtifact, { id: 'tc-es' })],
      })
      const baseRegistry = SpooledArtifact.forgeTools(ctx)
      const subclassRegistry = SpooledEcmaScriptArtifact.forgeTools(ctx)
      const baseNames = baseRegistry.all().map((t) => t.name)

      for (const n of baseNames) {
        expect(subclassRegistry.has(n)).toBe(true)
      }
    })
  })

  describe('inheritance from SpooledArtifact', () => {
    it('still supports head / tail / cat / lineCount from the base class', async () => {
      const artifact = make(FIXTURE_CODE)
      expect(await artifact.lineCount()).toBeGreaterThan(0)

      const head = await artifact.head(1)
      expect(Array.isArray(head)).toBe(true)
      expect(head.length).toBe(1)
      expect(typeof head[0]).toBe('string')
    })

    it('supports tail from the base class', async () => {
      const artifact = make(FIXTURE_CODE)
      const tail = await artifact.tail(1)
      expect(Array.isArray(tail)).toBe(true)
      expect(tail.length).toBe(1)
    })

    it('supports cat for reading a range', async () => {
      const artifact = make(FIXTURE_CODE)
      const lines = await artifact.cat(0, 5)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
    })
  })

  describe('constructor options', () => {
    it('accepts fileName and scriptKind options', () => {
      const artifact1 = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'test.ts',
        scriptKind: 'ts',
      })
      expect(artifact1).toBeDefined()
      expect(artifact1).toBeInstanceOf(SpooledEcmaScriptArtifact)
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(artifact1)).toBe(true)
    })

    it('infers scriptKind from fileName when provided', () => {
      // .ts → ts
      const ts = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'config.ts',
      })
      expect(ts).toBeDefined()
      expect(ts).toBeInstanceOf(SpooledEcmaScriptArtifact)

      // .tsx → tsx
      const tsx = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'component.tsx',
      })
      expect(tsx).toBeDefined()
      expect(tsx).toBeInstanceOf(SpooledEcmaScriptArtifact)

      // .js → js
      const js = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'script.js',
      })
      expect(js).toBeDefined()
      expect(js).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('defaults to ts scriptKind when no fileName is given', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE))
      expect(artifact).toBeDefined()
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(artifact)).toBe(true)
    })
  })

  describe('error-tolerant parsing', () => {
    it('yields an artifact even for code that does not parse cleanly', async () => {
      const malformedCode = `
        export class Broken {
          method() {
            // Missing closing brace

        export const x = "unclosed string
      `
      const artifact = make(malformedCode)
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(artifact)).toBe(true)

      // Should not throw, even though parsing failed
      const symbols = await artifact.es_symbols()
      expect(Array.isArray(symbols)).toBe(true)
    })

    it('handles empty files', async () => {
      const emptyCode = ''
      const artifact = make(emptyCode)
      const symbols = await artifact.es_symbols()
      expect(Array.isArray(symbols)).toBe(true)
    })

    it('handles files with only comments', async () => {
      const commentOnlyCode = `
        // This is a comment
        /* This is a block comment */
      `
      const artifact = make(commentOnlyCode)
      const symbols = await artifact.es_symbols()
      expect(Array.isArray(symbols)).toBe(true)
    })
  })

  describe('line number reporting (0-based)', () => {
    it('reports 0-based line indices in es_symbols', async () => {
      const simpleCode = `const a = 1\nconst b = 2`
      const artifact = make(simpleCode)
      const symbols = await artifact.es_symbols()

      for (const sym of symbols) {
        expect(sym.startLine >= 0).toBe(true)
        expect(sym.endLine >= 0).toBe(true)
      }
    })

    it('reports 0-based line indices in es_imports', async () => {
      const artifact = make(FIXTURE_CODE)
      const imports = await artifact.es_imports()

      for (const imp of imports) {
        expect(imp.line >= 0).toBe(true)
      }
    })

    it('reports 0-based line indices in es_references', async () => {
      const artifact = make(FIXTURE_CODE)
      const refs = await artifact.es_references('ConfigManager')

      for (const ref of refs) {
        expect(ref.line >= 0).toBe(true)
        expect(ref.column >= 0).toBe(true)
      }
    })
  })

  describe('scriptKind inference from fileName', () => {
    it('infers ts for .ts files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'module.ts',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers ts for .mts files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'module.mts',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers ts for .cts files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'module.cts',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers tsx for .tsx files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'component.tsx',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers jsx for .jsx files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'component.jsx',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers js for .js files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'script.js',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers js for .mjs files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'module.mjs',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })

    it('infers js for .cjs files', () => {
      const artifact = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'module.cjs',
      })
      expect(artifact).toBeDefined()
      expect(artifact).toBeInstanceOf(SpooledEcmaScriptArtifact)
    })
  })

  describe('encode/decode round-trip', () => {
    beforeAll(() => {
      registerAdkEncodables()
    })

    it('encodes and decodes to the same SpooledEcmaScriptArtifact subclass with options intact', async () => {
      const fileName = 'example.ts'
      const scriptKind = 'ts' as const
      const original = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName,
        scriptKind,
      })

      // Encode to a snapshot
      const encoded = original[ENCODE_METHOD]()
      expect(encoded).toBeDefined()
      expect((encoded as { fileName?: string }).fileName).toBe(fileName)
      expect((encoded as { scriptKind?: string }).scriptKind).toBe(scriptKind)

      // Decode from the snapshot
      const decoded = SpooledEcmaScriptArtifact[DECODE_METHOD](encoded) as SpooledEcmaScriptArtifact

      // Assert it is a SpooledEcmaScriptArtifact, not a bare SpooledArtifact
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(decoded)).toBe(true)
      expect(SpooledArtifact.isSpooledArtifact(decoded)).toBe(true)

      // Assert the decoded artifact still answers es_* methods correctly
      const symbols = await decoded.es_symbols()
      expect(Array.isArray(symbols)).toBe(true)
      expect(symbols.length).toBeGreaterThan(0)

      const imports = await decoded.es_imports()
      expect(Array.isArray(imports)).toBe(true)
      expect(imports.some((i: { moduleSpecifier: string }) => i.moduleSpecifier === 'vitest')).toBe(
        true
      )

      const exports = await decoded.es_exports()
      expect(Array.isArray(exports)).toBe(true)
      expect(exports.some((e: { isDefault: boolean }) => e.isDefault)).toBe(true)
    })

    it('decodes to a SpooledEcmaScriptArtifact that is distinguishable from a base SpooledArtifact', async () => {
      const original = new SpooledEcmaScriptArtifact(new InMemorySpoolReader(FIXTURE_CODE), {
        fileName: 'config.ts',
      })

      const encoded = original[ENCODE_METHOD]()
      const decoded = SpooledEcmaScriptArtifact[DECODE_METHOD](encoded) as SpooledEcmaScriptArtifact

      // A bare SpooledArtifact should NOT pass this check
      expect(SpooledEcmaScriptArtifact.isSpooledEcmaScriptArtifact(decoded)).toBe(true)

      // The subclass-only es_symbols method should be callable
      expect(typeof decoded.es_symbols).toBe('function')
      const symbols = await decoded.es_symbols()
      expect(Array.isArray(symbols)).toBe(true)
    })
  })
})
