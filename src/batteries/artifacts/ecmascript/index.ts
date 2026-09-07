/**
 * @module @nhtio/adk/batteries/artifacts/ecmascript
 *
 * Provides `SpooledEcmaScriptArtifact`, a structured query interface for JavaScript and
 * TypeScript source files.
 *
 * @remarks
 * Parse source code via the TypeScript compiler API to enable structural queries:
 * - `artifact_es_symbols` — top-level declarations (functions, classes, interfaces, types)
 * - `artifact_es_imports` — import declarations and their source modules
 * - `artifact_es_exports` — export declarations and re-exports
 * - `artifact_es_outline` — nested member index (class methods/properties, interface members)
 * - `artifact_es_signature` — declaration signature text (parameters, return types)
 * - `artifact_es_jsdoc` — JSDoc comments attached to declarations
 * - `artifact_es_references` — syntactic scan for identifier usage (not semantic)
 *
 * **Decoding note:** `decode()` on a `SpooledEcmaScriptArtifact` throws until
 * `registerArtifactEncodables()` has run. `encode()` requires no setup.
 */

import { validator } from '@nhtio/validation'
import { E_TYPESCRIPT_PEER_MISSING } from './exceptions'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { ArtifactTool, ToolRegistry, resolveSpoolReader, ReaderDescriptor } from '@nhtio/adk/common'
import {
  SpooledArtifact,
  collectArtifactCompatibleIds,
  defaultSerialise,
  resolveArtifactById,
} from '@nhtio/adk/spooled_artifact'

/**
 * Well-known @nhtio/encoder contract keys, resolved via the global symbol registry
 * to avoid a hard dependency on the optional @nhtio/encoder peer.
 */
const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')
import type { SourceFile } from 'typescript'
import type { DispatchContext, SpoolReader, ToolMethodDescriptor } from '@nhtio/adk/types'

/** Snapshot payload for the encoder contract; the encoder treats it as opaque. */
type AdkEncodableSnapshot = unknown

/**
 * A top-level declaration (function, class, interface, type alias, enum, or binding).
 *
 * @remarks
 * Line numbers are 0-based. `startLine` is the line containing the declaration keyword or
 * identifier. `endLine` is the 0-based index of the last line belonging to this declaration
 * (inclusive).
 */
export interface EcmaScriptSymbol {
  /** Declaration kind: `'function'`, `'class'`, `'interface'`, `'type'`, `'enum'`, or `'const'`/`'let'`/`'var'`. */
  kind: string
  /** The declared name. */
  name: string
  /** Whether this declaration is exported. */
  exported: boolean
  /** 0-based line of the first line of this declaration. */
  startLine: number
  /** 0-based line of the last line of this declaration (inclusive). */
  endLine: number
}

/**
 * An import declaration.
 *
 * @remarks
 * Line numbers are 0-based. The `named` array contains all imported identifiers from a named
 * import; `default` contains the default import name (if any); `namespace` contains the
 * namespace import name (if `import * as`). `typeOnly` indicates whether this is a
 * `import type` declaration.
 */
export interface EcmaScriptImport {
  /** The module specifier (e.g., `'@nhtio/adk/common'` or `'./utils'`). */
  moduleSpecifier: string
  /** Array of named imports (empty if none). */
  named: string[]
  /** The default import name, or undefined. */
  default?: string
  /** The namespace import name (for `import *`), or undefined. */
  namespace?: string
  /** True for `import type` declarations. */
  typeOnly: boolean
  /** 0-based line of this import statement. */
  line: number
}

/**
 * An export declaration or re-export.
 *
 * @remarks
 * Includes named exports, default exports, re-exports (`export * from`), and re-export named
 * members. When `moduleSpecifier` is present, this is a re-export; otherwise it re-exports
 * locally-declared members.
 */
export interface EcmaScriptExport {
  /** 0-based line of this export statement. */
  line: number
  /** The module specifier for re-exports (e.g., `'./utils'`), or undefined for local exports. */
  moduleSpecifier?: string
  /** Array of named exports (empty if this is `export default` or `export * from`). */
  named: string[]
  /** True for `export default`. */
  isDefault: boolean
  /** True for `export * from`. */
  isNamespaceReExport: boolean
  /** True for `export type` declarations. */
  isTypeOnly: boolean
}

/**
 * A class or interface member in the outline.
 */
export interface OutlineMember {
  /** The member name. */
  name: string
  /** The member kind: `'method'`, `'property'`, `'accessor'`, or `'signature'`. */
  kind: string
  /** 0-based line of this member. */
  startLine: number
  /** 0-based line of the last line of this member (inclusive). */
  endLine: number
}

/**
 * An entry in the structural outline (class or interface with its members).
 */
export interface OutlineEntry {
  /** The container kind: `'class'` or `'interface'`. */
  kind: 'class' | 'interface'
  /** The container name. */
  name: string
  /** 0-based line of the container declaration. */
  startLine: number
  /** 0-based line of the last line of this container (inclusive). */
  endLine: number
  /** Array of members (methods, properties, accessors). */
  members: OutlineMember[]
}

/**
 * The location of an identifier reference.
 */
export interface IdentifierReference {
  /** 0-based line where this identifier appears. */
  line: number
  /** 0-based column where this identifier starts. */
  column: number
}

/**
 * A {@link @nhtio/adk!SpooledArtifact} specialisation for EcmaScript (JavaScript and TypeScript)
 * source files.
 *
 * @remarks
 * Parses source code syntactically (no type checker) using the TypeScript compiler API, enabling
 * structural queries without materialising the full file into memory.
 *
 * The parser automatically infers the script kind (`.js`, `.ts`, `.jsx`, `.tsx`) from the
 * `fileName` when provided; defaults to `ts` when omitted (it parses the widest grammar).
 *
 * All parsing errors are non-fatal — TypeScript's parser is error-tolerant and produces a
 * partial tree. Diagnostics are not surfaced by the query methods.
 */
export class SpooledEcmaScriptArtifact extends SpooledArtifact {
  #sourceFile: SourceFile | undefined
  #fileName: string | undefined
  #scriptKind: 'js' | 'jsx' | 'ts' | 'tsx'

  /**
   * @param reader - The backing store to read from.
   * @param options - Optional configuration.
   * @param options.fileName - The source file name. When provided, script kind is inferred from
   *   the extension (`.mts`/`.cts`/`.ts` → `'ts'`, `.mjs`/`.cjs`/`.js` → `'js'`, `.tsx` → `'tsx'`,
   *   `.jsx` → `'jsx'`). Defaults to `undefined`.
   * @param options.scriptKind - Explicit script kind override. Defaults to `'ts'` when not
   *   provided and cannot be inferred from `fileName`.
   */
  constructor(
    reader: SpoolReader,
    options?: {
      fileName?: string
      scriptKind?: 'js' | 'jsx' | 'ts' | 'tsx'
    }
  ) {
    super(reader)
    this.#fileName = options?.fileName
    this.#scriptKind = options?.scriptKind ?? this.#inferScriptKind(options?.fileName) ?? 'ts'
  }

  /**
   * Returns `true` if `value` is a {@link SpooledEcmaScriptArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard. Safe against the
   * dual-module-copy case.
   */
  public static isSpooledEcmaScriptArtifact(value: unknown): value is SpooledEcmaScriptArtifact {
    return isInstanceOf(value, 'SpooledEcmaScriptArtifact', SpooledEcmaScriptArtifact)
  }

  /**
   * The EcmaScript-specific artifact-query descriptors this class adds.
   *
   * @remarks
   * Lists seven descriptors; the base seven (`artifact_head`, etc.) are forged separately.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_es_symbols',
      method: 'es_symbols',
      description:
        'Return every top-level declaration (function, class, interface, type, enum, const/let/var) from an EcmaScript artifact produced earlier in this turn. Optionally filter by declaration kind.',
      argsSchema: validator.object({
        kind: validator
          .string()
          .optional()
          .allow('')
          .description(
            'Optional declaration kind filter (e.g., "function", "class", "interface"). Empty string or omitted means no filter.'
          ),
      }),
    },
    {
      name: 'artifact_es_imports',
      method: 'es_imports',
      description:
        'Return every import declaration from an EcmaScript artifact produced earlier in this turn, including default imports, named imports, namespace imports, and type-only imports.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_es_exports',
      method: 'es_exports',
      description:
        'Return every export declaration and re-export from an EcmaScript artifact produced earlier in this turn, including the export * form.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_es_outline',
      method: 'es_outline',
      description:
        'Return a nested structural index from an EcmaScript artifact produced earlier in this turn: each class or interface with its methods, properties, and accessors, all with line ranges.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_es_signature',
      method: 'es_signature',
      description:
        'Return the signature text (type parameters, parameters, return type) of a named declaration from an EcmaScript artifact produced earlier in this turn, without the body.',
      argsSchema: validator.object({
        name: validator
          .string()
          .required()
          .description('The name of the declaration whose signature to retrieve.'),
      }),
    },
    {
      name: 'artifact_es_jsdoc',
      method: 'es_jsdoc',
      description:
        'Return the JSDoc comment attached to a named declaration from an EcmaScript artifact produced earlier in this turn.',
      argsSchema: validator.object({
        name: validator
          .string()
          .required()
          .description('The name of the declaration whose JSDoc to retrieve.'),
      }),
    },
    {
      name: 'artifact_es_references',
      method: 'es_references',
      description:
        'Return every line (0-based) where an identifier appears in an EcmaScript artifact produced earlier in this turn. This is a syntactic scan only — without a type checker it cannot distinguish shadowed bindings or resolve ambiguous names. Do not treat this as a semantic find-references.',
      argsSchema: validator.object({
        name: validator.string().required().description('The identifier name to search for.'),
      }),
    },
  ])

  /**
   * Forges base-class tools plus EcmaScript-specific tools narrowed to {@link SpooledEcmaScriptArtifact}.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledEcmaScriptArtifact
    const compatibleIds = collectArtifactCompatibleIds(ctx, requires)
    if (compatibleIds.length === 0) return registry

    for (const descriptor of this.toolMethods) {
      const callIdSchema = validator
        .string()
        .valid(...compatibleIds)
        .required()
        .description('ToolCall id of the artifact to query.')

      const argsSchema = (
        descriptor.argsSchema ?? validator.object<Record<string, never>>({})
      ).append({
        callId: callIdSchema,
      })

      const tool = new ArtifactTool({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: argsSchema,
        ephemeral: true,
        onCollision: 'replace',
        handler: async (rawArgs, ctxInner) => {
          const args = rawArgs as Record<string, unknown> & { callId: string }
          const resolved = resolveArtifactById(ctxInner, args.callId, requires)
          if (!resolved) return `Error: no artifact with id ${args.callId} in this turn`
          const artifact = resolved.artifact
          const methodArgs: unknown[] = []
          if (descriptor.method === 'es_symbols') {
            methodArgs.push((args.kind as string) || '')
          } else if (
            descriptor.method === 'es_signature' ||
            descriptor.method === 'es_jsdoc' ||
            descriptor.method === 'es_references'
          ) {
            methodArgs.push(args.name as string)
          }
          const fn = (artifact as unknown as Record<string, (...a: unknown[]) => unknown>)[
            descriptor.method
          ]
          if (typeof fn !== 'function') {
            return `Error: artifact has no method ${descriptor.method}`
          }
          const result = await Promise.resolve(fn.apply(artifact, methodArgs))
          const serialise = descriptor.serialise ?? defaultSerialise
          return serialise(result)
        },
      })
      registry.register(tool)
    }
    return registry
  }

  /**
   * Infer script kind from file extension.
   */
  #inferScriptKind(fileName: string | undefined): 'js' | 'jsx' | 'ts' | 'tsx' | undefined {
    if (!fileName) return undefined
    const lower = fileName.toLowerCase()
    if (lower.endsWith('.mts') || lower.endsWith('.cts') || lower.endsWith('.ts')) {
      return 'ts'
    }
    if (lower.endsWith('.tsx')) {
      return 'tsx'
    }
    if (lower.endsWith('.jsx')) {
      return 'jsx'
    }
    if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) {
      return 'js'
    }
    return undefined
  }

  /**
   * Lazy-load the TypeScript module once and cache the promise.
   * All call sites route through this to ensure consistent error handling.
   */
  static #typeScriptPromise: Promise<any> | undefined

  /**
   * Load the TypeScript module, wrapping module-resolution errors in the battery exception.
   * @internal
   */
  static async #loadTypeScript(): Promise<any> {
    if (this.#typeScriptPromise !== undefined) {
      return this.#typeScriptPromise
    }

    this.#typeScriptPromise = import('typescript').catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_TYPESCRIPT_PEER_MISSING([detail])
    })

    return this.#typeScriptPromise
  }

  /**
   * Resolve and cache the parsed SourceFile.
   */
  async #resolveSourceFile(): Promise<SourceFile> {
    if (this.#sourceFile !== undefined) {
      return this.#sourceFile
    }

    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const text = await this.asString()
    const fileName = this.#fileName ?? 'source.ts'

    // Map script kind to ts.ScriptKind enum
    const scriptKindMap: Record<string, number> = {
      js: ts.ScriptKind.JS,
      jsx: ts.ScriptKind.JSX,
      ts: ts.ScriptKind.TS,
      tsx: ts.ScriptKind.TSX,
    }
    const scriptKind = scriptKindMap[this.#scriptKind] ?? ts.ScriptKind.TS

    this.#sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKind
    )

    return this.#sourceFile!
  }

  /**
   * Return every top-level declaration, optionally filtered by kind.
   */
  async es_symbols(kind?: string): Promise<EcmaScriptSymbol[]> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    const symbols: EcmaScriptSymbol[] = []
    const filterKind = kind === '' ? undefined : kind

    const visit = (node: any): void | undefined => {
      // Only visit top-level declarations
      if (node.parent !== sf) return

      let symbolKind: string | undefined
      let symbolName: string | undefined
      let isExported = false

      // Determine kind and name
      if (ts.isFunctionDeclaration(node)) {
        symbolKind = 'function'
        symbolName = node.name?.text
      } else if (ts.isClassDeclaration(node)) {
        symbolKind = 'class'
        symbolName = node.name?.text
      } else if (ts.isInterfaceDeclaration(node)) {
        symbolKind = 'interface'
        symbolName = node.name.text
      } else if (ts.isTypeAliasDeclaration(node)) {
        symbolKind = 'type'
        symbolName = node.name.text
      } else if (ts.isEnumDeclaration(node)) {
        symbolKind = 'enum'
        symbolName = node.name.text
      } else if (ts.isVariableStatement(node)) {
        // Extract kind from variable declaration flags
        const flags = node.declarationList.flags
        let varKind: string
        if (flags & ts.NodeFlags.Let) {
          varKind = 'let'
        } else if (flags & ts.NodeFlags.Const) {
          varKind = 'const'
        } else {
          varKind = 'var'
        }

        // Check if exported
        let varIsExported = false
        if (node.modifiers) {
          varIsExported = node.modifiers.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
        }

        // Emit one symbol per binding, not one per statement
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
        const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line

        node.declarationList.declarations.forEach((decl: any) => {
          if (ts.isIdentifier(decl.name)) {
            const bindingName = decl.name.text

            // Apply filter if provided
            if (filterKind && varKind !== filterKind) return

            symbols.push({
              kind: varKind,
              name: bindingName,
              exported: varIsExported,
              startLine,
              endLine,
            })
          }
        })
        return
      }

      if (!symbolKind || !symbolName) return

      // Check if exported
      if (node.modifiers) {
        isExported = node.modifiers.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
      }

      // Apply filter if provided
      if (filterKind && symbolKind !== filterKind) return

      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line

      symbols.push({
        kind: symbolKind,
        name: symbolName,
        exported: isExported,
        startLine,
        endLine,
      })
    }

    ts.forEachChild(sf, visit)
    return symbols
  }

  /**
   * Return every import declaration.
   */
  async es_imports(): Promise<EcmaScriptImport[]> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    const imports: EcmaScriptImport[] = []

    const visit = (node: any): void | undefined => {
      if (!ts.isImportDeclaration(node)) return

      const moduleSpecifier =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : ''

      const namedImports: string[] = []
      let defaultImport: string | undefined
      let namespaceImport: string | undefined
      let typeOnly = false

      if (node.importClause) {
        typeOnly = node.importClause.isTypeOnly ?? false

        // Default import
        if (node.importClause.name) {
          defaultImport = node.importClause.name.text
        }

        // Namespace import (import * as Foo)
        if (node.importClause.namedBindings) {
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            namespaceImport = node.importClause.namedBindings.name.text
          } else if (ts.isNamedImports(node.importClause.namedBindings)) {
            // Named imports
            node.importClause.namedBindings.elements.forEach((elem: any) => {
              namedImports.push(elem.name.text)
            })
          }
        }
      }

      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
      imports.push({
        moduleSpecifier,
        named: namedImports,
        default: defaultImport,
        namespace: namespaceImport,
        typeOnly,
        line,
      })
    }

    ts.forEachChild(sf, visit)
    return imports
  }

  /**
   * Return every export declaration and re-export.
   */
  async es_exports(): Promise<EcmaScriptExport[]> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    const exports: EcmaScriptExport[] = []

    const visit = (node: any): void | undefined => {
      // Handle export declarations (named exports, export *, re-exports)
      if (ts.isExportDeclaration(node)) {
        const isTypeOnly = node.isTypeOnly ?? false
        const moduleSpecifier =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined

        const namedExports: string[] = []
        let isNamespaceReExport = false

        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach((elem: any) => {
            namedExports.push(elem.name.text)
          })
        } else if (node.exportClause === undefined && moduleSpecifier) {
          // export * from '...'
          isNamespaceReExport = true
        }

        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
        exports.push({
          line,
          moduleSpecifier,
          named: namedExports,
          isDefault: false,
          isNamespaceReExport,
          isTypeOnly,
        })
      }
      // Handle export default (which is ExportAssignment, not ExportDeclaration)
      else if (ts.isExportAssignment(node)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
        exports.push({
          line,
          moduleSpecifier: undefined,
          named: [],
          isDefault: true,
          isNamespaceReExport: false,
          isTypeOnly: false,
        })
      }
      // Handle exported declarations with export modifier (export function, export class, etc.)
      else if (node.parent === sf && node.modifiers) {
        const hasExportModifier = node.modifiers.some(
          (m: any) => m.kind === ts.SyntaxKind.ExportKeyword
        )
        if (!hasExportModifier) return

        const hasDefaultModifier = node.modifiers.some(
          (m: any) => m.kind === ts.SyntaxKind.DefaultKeyword
        )

        let declaredName: string | undefined

        // Determine the name and isTypeOnly flag based on declaration kind
        let isTypeOnly = false

        if (ts.isFunctionDeclaration(node)) {
          declaredName = node.name?.text
        } else if (ts.isClassDeclaration(node)) {
          declaredName = node.name?.text
        } else if (ts.isInterfaceDeclaration(node)) {
          declaredName = node.name.text
          isTypeOnly = true
        } else if (ts.isTypeAliasDeclaration(node)) {
          declaredName = node.name.text
          isTypeOnly = true
        } else if (ts.isEnumDeclaration(node)) {
          declaredName = node.name.text
        } else if (ts.isVariableStatement(node)) {
          // For variable statements, emit one export per binding
          const flags = node.declarationList.flags
          const varIsTypeOnly =
            (flags & ts.NodeFlags.Const) !== 0 &&
            node.declarationList.declarations.some(
              (d: any) => d.type?.kind === ts.SyntaxKind.TypeKeyword
            )

          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line

          node.declarationList.declarations.forEach((decl: any) => {
            if (ts.isIdentifier(decl.name)) {
              const bindingName = decl.name.text
              exports.push({
                line,
                moduleSpecifier: undefined,
                named: hasDefaultModifier ? [] : [bindingName],
                isDefault: hasDefaultModifier,
                isNamespaceReExport: false,
                isTypeOnly: varIsTypeOnly,
              })
            }
          })
          return
        }

        if (declaredName) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
          exports.push({
            line,
            moduleSpecifier: undefined,
            named: hasDefaultModifier ? [] : [declaredName],
            isDefault: hasDefaultModifier,
            isNamespaceReExport: false,
            isTypeOnly,
          })
        }
      }
    }

    ts.forEachChild(sf, visit)
    return exports
  }

  /**
   * Return a structural outline of classes and interfaces with their members.
   */
  async es_outline(): Promise<OutlineEntry[]> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    const entries: OutlineEntry[] = []

    const visit = (node: any): void | undefined => {
      if (!node.parent || node.parent !== sf) return

      let entry: OutlineEntry | undefined

      if (ts.isClassDeclaration(node) && node.name) {
        const members = this.#getMembersFromNode(ts, sf, node)
        entry = {
          kind: 'class',
          name: node.name.text,
          startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line,
          members,
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        const members = this.#getMembersFromInterfaceNode(ts, sf, node)
        entry = {
          kind: 'interface',
          name: node.name.text,
          startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line,
          members,
        }
      }

      if (entry) {
        entries.push(entry)
      }
    }

    ts.forEachChild(sf, visit)
    return entries
  }

  /**
   * Extract members from a class node.
   */
  #getMembersFromNode(ts: any, sf: SourceFile, classNode: any): OutlineMember[] {
    const members: OutlineMember[] = []

    const visit = (node: any): void | undefined => {
      if (node.parent !== classNode) return

      let memberKind: string | undefined
      let memberName: string | undefined

      if (ts.isConstructorDeclaration(node)) {
        memberKind = 'method'
        memberName = 'constructor'
      } else if (ts.isMethodDeclaration(node)) {
        memberKind = 'method'
        memberName = node.name?.text
      } else if (ts.isPropertyDeclaration(node)) {
        memberKind = 'property'
        memberName = node.name?.text
      } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        memberKind = 'accessor'
        memberName = node.name?.text
      }

      if (memberKind && memberName) {
        members.push({
          name: memberName,
          kind: memberKind,
          startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line,
        })
      }
    }

    ts.forEachChild(classNode, visit)
    return members
  }

  /**
   * Extract members from an interface node.
   */
  #getMembersFromInterfaceNode(ts: any, sf: SourceFile, interfaceNode: any): OutlineMember[] {
    const members: OutlineMember[] = []

    const visit = (node: any): void | undefined => {
      if (node.parent !== interfaceNode) return

      let memberKind: string | undefined
      let memberName: string | undefined

      if (ts.isMethodSignature(node)) {
        memberKind = 'method'
        memberName = node.name?.text
      } else if (ts.isPropertySignature(node)) {
        memberKind = 'property'
        memberName = node.name?.text
      } else if (ts.isCallSignatureDeclaration(node)) {
        memberKind = 'signature'
        memberName = 'call'
      } else if (ts.isConstructSignatureDeclaration(node)) {
        memberKind = 'signature'
        memberName = 'constructor'
      } else if (ts.isIndexSignatureDeclaration(node)) {
        memberKind = 'signature'
        memberName = 'index'
      }

      if (memberKind && memberName) {
        members.push({
          name: memberName,
          kind: memberKind,
          startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line,
        })
      }
    }

    ts.forEachChild(interfaceNode, visit)
    return members
  }

  /**
   * Search for a named top-level declaration. Returns the matching node or undefined.
   *
   * @remarks
   * Searches FunctionDeclaration, ClassDeclaration, InterfaceDeclaration, EnumDeclaration,
   * TypeAliasDeclaration, and the individual VariableDeclaration bindings of a
   * VariableStatement. This is the single lookup shared by {@link SpooledEcmaScriptArtifact.es_signature}
   * and {@link SpooledEcmaScriptArtifact.es_jsdoc} so the two can never disagree about
   * what a name resolves to. For a variable the VariableDeclaration is returned, not its
   * enclosing statement — TypeScript attaches the JSDoc of a variable statement to both,
   * so this is safe for either caller.
   * @internal
   */
  #findTopLevelDeclaration(ts: any, sf: SourceFile, name: string): any | undefined {
    for (const node of sf.statements as unknown as any[]) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        return node
      } else if (ts.isClassDeclaration(node) && node.name?.text === name) {
        return node
      } else if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
        return node
      } else if (ts.isEnumDeclaration(node) && node.name.text === name) {
        return node
      } else if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
        return node
      } else if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations.find(
          (d: any) => ts.isIdentifier(d.name) && d.name.text === name
        )
        if (decl) return decl
      }
    }
    return undefined
  }

  /**
   * Search for a named member (method, property, constructor, accessor, or signature)
   * within class and interface declarations. Returns the matching node or undefined.
   *
   * @remarks
   * Searches class members: MethodDeclaration, PropertyDeclaration, ConstructorDeclaration,
   * GetAccessorDeclaration, SetAccessorDeclaration.
   * Searches interface members: MethodSignature, PropertySignature.
   * Returns the first matching node or undefined if not found.
   * @internal
   */
  #findNestedMember(ts: any, sf: SourceFile, name: string): any | undefined {
    let foundNode: any | undefined

    const searchClasses = (node: any): void => {
      if (foundNode) return
      if (ts.isClassDeclaration(node)) {
        const searchMember = (member: any): void => {
          if (foundNode) return

          if (ts.isMethodDeclaration(member) && member.name?.text === name) {
            foundNode = member
            return
          } else if (ts.isConstructorDeclaration(member) && name === 'constructor') {
            foundNode = member
            return
          } else if (ts.isPropertyDeclaration(member) && member.name?.text === name) {
            foundNode = member
            return
          } else if (
            (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
            member.name?.text === name
          ) {
            foundNode = member
            return
          }
        }
        ts.forEachChild(node, searchMember)
      }

      if (!foundNode) {
        ts.forEachChild(node, searchClasses)
      }
    }

    const searchInterfaces = (node: any): void => {
      if (foundNode) return
      if (ts.isInterfaceDeclaration(node)) {
        const searchMember = (member: any): void => {
          if (foundNode) return

          if (ts.isMethodSignature(member) && member.name?.text === name) {
            foundNode = member
            return
          } else if (ts.isPropertySignature(member) && member.name?.text === name) {
            foundNode = member
            return
          }
        }
        ts.forEachChild(node, searchMember)
      }

      if (!foundNode) {
        ts.forEachChild(node, searchInterfaces)
      }
    }

    ts.forEachChild(sf, searchClasses)
    if (!foundNode) {
      ts.forEachChild(sf, searchInterfaces)
    }

    return foundNode
  }

  /**
   * Extract the signature text of a declaration, excluding the body.
   * For functions/methods: includes type parameters, parameters, and return type.
   * For classes: includes the class keyword, name, type parameters, and heritage.
   * For interfaces: includes the interface keyword, name, type parameters, and heritage.
   * For enums: includes the enum keyword, modifiers, and name, excluding the member list.
   * For type aliases: includes the type keyword, name, and RHS up to the semicolon.
   * For variables: includes the variable declaration up to (but not including) the initializer.
   * For properties/accessors: includes the declaration without the body.
   * For method/property signatures: includes the signature without the body.
   *
   * @remarks
   * Variables and function expressions are returned as the binding name only (parameters
   * and return type are not surfaced for these cases).
   * @internal
   */
  #extractSignatureText(ts: any, sf: SourceFile, node: any): string {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      // For functions/methods: extract from start to the end of return type (or param list if no return type)
      const start = node.getStart(sf)
      // The body (if present) starts after the closing paren of parameters and optional return type
      const bodyStart = node.body ? node.body.getStart(sf) : node.getEnd()
      return sf.text.substring(start, bodyStart).trim()
    } else if (ts.isConstructorDeclaration(node)) {
      // constructor(params): void { body }
      const start = node.getStart(sf)
      const bodyStart = node.body ? node.body.getStart(sf) : node.getEnd()
      return sf.text.substring(start, bodyStart).trim()
    } else if (ts.isClassDeclaration(node)) {
      // class Name<T> extends Base { members }
      // Find the opening brace that starts the body and stop before it.
      const start = node.getStart(sf)
      const children = node.getChildren(sf)
      const openBrace = children.find((child: any) => child.kind === ts.SyntaxKind.OpenBraceToken)
      if (openBrace) {
        // Extract up to the opening brace and trim any trailing whitespace/brace
        const bracePos = openBrace.getStart(sf)
        let text = sf.text.substring(start, bracePos).trim()
        // Remove trailing opening brace and any whitespace before it
        text = text.replace(/\s*\{\s*$/, '')
        return text
      }
      return ''
    } else if (ts.isInterfaceDeclaration(node)) {
      // interface Name<T> extends Base { members }
      // Find the opening brace that starts the body and stop before it.
      const start = node.getStart(sf)
      const children = node.getChildren(sf)
      const openBrace = children.find((child: any) => child.kind === ts.SyntaxKind.OpenBraceToken)
      if (openBrace) {
        // Extract up to the opening brace and trim any trailing whitespace/brace
        const bracePos = openBrace.getStart(sf)
        let text = sf.text.substring(start, bracePos).trim()
        // Remove trailing opening brace and any whitespace before it
        text = text.replace(/\s*\{\s*$/, '')
        return text
      }
      return ''
    } else if (ts.isEnumDeclaration(node)) {
      // enum Name { members } or const enum Name { members } or declare enum Name { members }
      // Find the opening brace that starts the member list and stop before it.
      const start = node.getStart(sf)
      const children = node.getChildren(sf)
      const openBrace = children.find((child: any) => child.kind === ts.SyntaxKind.OpenBraceToken)
      if (openBrace) {
        // Extract up to the opening brace and trim any trailing whitespace/brace
        const bracePos = openBrace.getStart(sf)
        let text = sf.text.substring(start, bracePos).trim()
        // Remove trailing opening brace and any whitespace before it
        text = text.replace(/\s*\{\s*$/, '')
        return text
      }
      return ''
    } else if (ts.isTypeAliasDeclaration(node)) {
      // type Name<T> = ...
      const start = node.getStart(sf)
      const end = node.getEnd()
      return sf.text.substring(start, end).trim()
    } else if (ts.isVariableDeclaration(node)) {
      // const x = 5 or let y: string
      // Return up to the initializer or end if no initializer
      const start = node.getStart(sf)
      const initStart = node.initializer ? node.initializer.getStart(sf) : node.getEnd()
      let text = sf.text.substring(start, initStart).trim()
      // Remove trailing assignment operator and surrounding whitespace
      text = text.replace(/\s*=\s*$/, '')
      return text
    } else if (ts.isPropertyDeclaration(node)) {
      // class property: name: type = initializer;
      // Return from start to initializer (if any) or end (without body)
      const start = node.getStart(sf)
      const initStart = node.initializer ? node.initializer.getStart(sf) : node.getEnd()
      let text = sf.text.substring(start, initStart).trim()
      // Remove trailing assignment operator and surrounding whitespace
      text = text.replace(/\s*=\s*$/, '')
      return text
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      // getter/setter: get/set name(): type { body }
      const start = node.getStart(sf)
      const bodyStart = node.body ? node.body.getStart(sf) : node.getEnd()
      return sf.text.substring(start, bodyStart).trim()
    } else if (ts.isMethodSignature(node)) {
      // interface method signature: name(params): returnType;
      const start = node.getStart(sf)
      const end = node.getEnd()
      return sf.text.substring(start, end).trim()
    } else if (ts.isPropertySignature(node)) {
      // interface property: name: type;
      const start = node.getStart(sf)
      const end = node.getEnd()
      return sf.text.substring(start, end).trim()
    }
    return ''
  }

  /**
   * Return the signature text for a named declaration.
   * Searches top-level declarations (functions, classes, interfaces, enums, type aliases,
   * const/let/var bindings), class members (methods, properties, constructors, accessors),
   * and interface members (method signatures, property signatures) — the same lookup
   * {@link SpooledEcmaScriptArtifact.es_jsdoc} uses, so the two always agree on what a
   * name resolves to.
   */
  async es_signature(name: string): Promise<string> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    // Top-level declarations first, then nested class/interface members.
    const node = this.#findTopLevelDeclaration(ts, sf, name) ?? this.#findNestedMember(ts, sf, name)

    return node ? this.#extractSignatureText(ts, sf, node) : ''
  }

  /**
   * Return the JSDoc comment for a named declaration.
   * Searches top-level declarations (functions, classes, interfaces, enums, type aliases,
   * const/let/var bindings), class members (methods, properties, constructors, accessors),
   * and interface members (method signatures, property signatures) — the same lookup
   * {@link SpooledEcmaScriptArtifact.es_signature} uses, so the two always agree on what a
   * name resolves to.
   */
  async es_jsdoc(name: string): Promise<string> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    // Helper to extract JSDoc from a node
    const extractJSDoc = (target: any): string => {
      // A JSDoc block sits above the whole `const a = 1, b = 2` statement, so for a
      // variable binding read the comment off the enclosing VariableStatement — otherwise
      // only the first declarator would carry it.
      const node =
        ts.isVariableDeclaration(target) && target.parent?.parent ? target.parent.parent : target
      const comments = ts.getJSDocCommentsAndTags(node)
      if (comments && comments.length > 0) {
        const commentStrs: string[] = []
        for (const comment of comments) {
          const text = sf.text.substring(comment.getStart(sf), comment.getEnd())
          commentStrs.push(text)
        }
        return commentStrs.join('\n')
      }
      return ''
    }

    // Top-level declarations first, then nested class/interface members.
    const node = this.#findTopLevelDeclaration(ts, sf, name) ?? this.#findNestedMember(ts, sf, name)

    return node ? extractJSDoc(node) : ''
  }

  /**
   * Return every line where an identifier appears (syntactic scan only).
   */
  async es_references(name: string): Promise<IdentifierReference[]> {
    const ts = await SpooledEcmaScriptArtifact.#loadTypeScript()
    const sf = await this.#resolveSourceFile()

    const references: IdentifierReference[] = []

    const visit = (node: any): void | undefined => {
      if (ts.isIdentifier(node) && node.text === name) {
        const pos = node.getStart(sf)
        const lineChar = sf.getLineAndCharacterOfPosition(pos)
        references.push({
          line: lineChar.line,
          column: lineChar.character,
        })
      }

      ts.forEachChild(node, visit)
    }

    ts.forEachChild(sf, visit)
    return references
  }

  /**
   * Serialise this SpooledEcmaScriptArtifact into an encoder snapshot.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      reader: this.readerDescriptor(),
      fileName: this.#fileName,
      scriptKind: this.#scriptKind,
    }
  }

  /**
   * Reconstruct a SpooledEcmaScriptArtifact from an encoder snapshot.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): SpooledEcmaScriptArtifact {
    const snapshot = data as {
      reader: ReaderDescriptor
      fileName?: string
      scriptKind?: 'js' | 'jsx' | 'ts' | 'tsx'
    }
    return new SpooledEcmaScriptArtifact(resolveSpoolReader(snapshot.reader), {
      fileName: snapshot.fileName,
      scriptKind: snapshot.scriptKind,
    })
  }
}

/**
 * Battery exception re-export.
 */
export { E_TYPESCRIPT_PEER_MISSING }
