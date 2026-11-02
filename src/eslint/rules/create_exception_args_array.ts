/**
 * @module @nhtio/adk/eslint/rules/create_exception_args_array
 *
 * Flags `new E_X(<non-array>)` where `E_X` is an exception class produced by
 * `createException<[…]>` with a NON-empty tuple — constructed with a non-array first argument,
 * e.g. `new E_FOO('detail')`.
 *
 * Why: the generated constructor accepts `args?: T | ExceptionOptions` and branches on
 * `Array.isArray(args)`. A bare value is silently taken as the SECOND parameter's shape
 * (`ExceptionOptions`); the payload is dropped, and the printf template keeps its literal `%s`, so
 * the thrown error reads `Invalid …: %s`. No type error at the shape level, no runtime error: just a
 * mangled message on every throw. The correct form is the array — `new E_FOO(['detail'])`.
 *
 * Detection:
 * - **Same-file declaration (no type checker needed).** A
 *   `const E_X = createException<[string, …]>(…)` (or `let`) whose tuple is non-empty binds the local
 *   name, and every `new E_X(<non-array>)` in the same file that resolves to THAT binding is
 *   reported. The factory itself is resolved through the file's imports, so
 *   `import { createException as ce } …; ce<[string]>(…)` and
 *   `import * as adk …; adk.createException<[string]>(…)` bind exactly like the bare form. Any other
 *   callee is ignored.
 * - **Everything else (type checker available).** When `parserServices.providesTypeInfo()` holds —
 *   the consumer runs typed linting — the rule resolves the callee to its class symbol (following an
 *   import alias) and requires BOTH: the class actually derives from the ADK exception base (see
 *   {@link derivesFromAdkException}), and one of its construct signatures carries the args shape — a
 *   first parameter that is a non-empty tuple with a sibling (options) parameter. That catches an
 *   exception class imported from another module and a namespace-member construction, while an
 *   unrelated class that merely HAS a tuple-taking overload is left alone. Without type info the
 *   rule checks same-file declarations only; it never guesses, and the docs say so.
 *
 * Resolving the CALLEE, not the name, is what makes both arms honest: a same-named binding in an
 * inner scope — a function parameter, or a locally-declared `class E_FOO` inside a block — is a
 * different variable, so it is neither the recorded same-file factory nor the typed class.
 *
 * A TypeScript expression wrapping the argument (`{ fatal: true } as X`,
 * `{ fatal: true } satisfies X`, `<X>{ fatal: true }`, `x!`, parens) is transparent: the value is
 * still the same non-array, so the wrapped form is checked exactly like the bare one.
 *
 * Opt-out:
 *   // eslint-disable-next-line adk/create-exception-args-array -- <reason>
 */

import { ASTUtils } from '@typescript-eslint/utils'
import { collectImportBindings, createRule, resolveCalleeName, unwrapExpression } from './common'
import type * as ts from 'typescript'
import type { ImportBindings } from './common'
import type { TSESTree } from '@typescript-eslint/utils'
import type { ParserServicesWithTypeInformation } from '@typescript-eslint/utils'

/**
 * `SymbolFlags.Alias` without importing the `typescript` compiler into this module: the value is
 * stable across every TypeScript release (`SymbolFlags.Alias === 2097152`), and the plugin's
 * `typescript` dependency is a peer of `@typescript-eslint/utils`, not of this package.
 */
const SYMBOL_FLAGS_ALIAS = 2097152

/**
 * `SymbolFlags.Class | SymbolFlags.Interface` (`32 | 64`) — the only symbol kinds whose DECLARED
 * type is a class/interface type, which is the only shape `Type.getBaseTypes()` answers on. A
 * function's or a call signature's anonymous `__type` symbol falls outside it. Spelled as the
 * numeric values for the same reason as {@link SYMBOL_FLAGS_ALIAS}.
 */
const SYMBOL_FLAGS_CLASS_OR_INTERFACE = 32 | 64

const isUndefinedValue = (node: TSESTree.Node): boolean =>
  node.type === 'Identifier' && node.name === 'undefined'

/**
 * Whether a declaration lives in one of the source files that carry the ADK exception contract:
 * `BaseException`'s class declaration (`src/lib/classes/base_exception.ts`), the `createException`
 * factory and the `CreatedException` type (`src/lib/utils/exceptions.ts`), the `@nhtio/adk/factories`
 * barrel that re-exports both (`src/factories.ts`), and the `@nhtio/adk/exceptions` barrel
 * (`src/exceptions.ts`).
 *
 * @remarks
 * Compared on the real `.ts` path, which is what a program built from source — this repo's own
 * typed spec, a consumer running the tsconfig `@nhtio/adk/*` alias or paths-mapped sources —
 * resolves to. This deliberately does NOT also accept the PUBLISHED declaration files: those emit
 * per-entry bundles under names outside any path shape (`dist/lib/classes/base_exception.d.ts` here,
 * a re-export stub like `dist/factories.d.ts` there), so a leaf-basename match would have to accept
 * arbitrary trees and would bind to whoever happened to own a file named like ours. An unresolvable
 * base is not a guess: the typed arm simply makes no report and the same-file detection — which is
 * all a source-less consumer ever had — still applies.
 */
const declaredInAdkExceptionModules = (declaration: ts.Declaration): boolean => {
  const path = declaration.getSourceFile().fileName.replace(/\\/g, '/')
  return (
    path.endsWith('/src/lib/classes/base_exception.ts') ||
    path.endsWith('/src/lib/utils/exceptions.ts') ||
    path.endsWith('/src/factories.ts') ||
    path.endsWith('/src/exceptions.ts')
  )
}

/** The non-empty tuple type argument of a `createException<[…]>` call, if it has one. */
const hasNonEmptyTupleTypeArgument = (node: TSESTree.CallExpression): boolean => {
  const params = node.typeArguments?.params
  if (!params || params.length === 0) return false
  // A tuple OF REST elements (`createException<[...string[]]>`) still demands an array first
  // argument, so it is in scope too; only the literal empty tuple is out.
  return params.some((param) => param.type === 'TSTupleType' && param.elementTypes.length > 0)
}

/**
 * Whether the class being constructed actually derives from the ADK exception base.
 *
 * @remarks
 * The signature scan alone cannot distinguish a real `CreatedException<T>` product from an
 * UNRELATED class whose overloads happen to include one taking a tuple as its first parameter (plus
 * a sibling second parameter) and another accepting a scalar: that is a legitimate constructor
 * design of its own, and flagging its valid scalar construction is a false positive. Derivation is
 * the contract the shape is standing in for.
 *
 * Two forms count:
 * - the `typeof BaseException & { new (args: T, options?) … }` intersection a `createException`
 *   product carries, where `BaseException` is a DIRECT intersection constituent;
 * - a hand-written `class X extends BaseException` chain, where the base sits in the ancestry of the
 *   DECLARED class type (`checker.getDeclaredTypeOfSymbol()`), because the constructor side of a
 *   class symbol is an anonymous `typeof` object whose own symbol carries no ancestry.
 *
 * `Type.getBaseTypes()` answers only on a class/interface type object — its own implementation
 * guard rejects anything else — so every hop re-enters through the symbol's declared type. An
 * abstract base answers as a small UNION of its concrete subclasses, so each hop unions members
 * before recursing. Identity against a declaration in this package's exception modules is what the
 * walk tests, never a name.
 *
 * @internal
 */
const derivesFromAdkException = (checker: ts.TypeChecker, declaredType: ts.Type): boolean => {
  const isAdkDeclaration = (declaration: ts.Declaration): boolean =>
    declaredInAdkExceptionModules(declaration)

  const constituents = declaredType.isIntersection?.() ? declaredType.types : [declaredType]
  if (
    constituents.some((part) => (part.getSymbol()?.getDeclarations() ?? []).some(isAdkDeclaration))
  ) {
    return true
  }

  const seen = new Set<ts.Type>()
  const walk = (type: ts.Type): boolean => {
    if (seen.has(type)) return false
    seen.add(type)
    const symbol = type.getSymbol()
    if (!symbol || (symbol.flags & SYMBOL_FLAGS_CLASS_OR_INTERFACE) === 0) return false
    if ((symbol.getDeclarations() ?? []).some(isAdkDeclaration)) return true
    const ownDeclaredType = checker.getDeclaredTypeOfSymbol(symbol)
    if (ownDeclaredType && ownDeclaredType !== type && walk(ownDeclaredType)) return true
    const bases = ownDeclaredType?.isClassOrInterface?.()
      ? (ownDeclaredType.getBaseTypes() ?? [])
      : []
    for (const base of bases) {
      const members = base.isUnion() ? base.types : [base]
      for (const member of members) {
        if (walk(member)) return true
      }
    }
    return false
  }
  return walk(declaredType)
}

/**
 * Whether a construct signature carries the `CreatedException` args shape: a first parameter typed
 * as a NON-empty tuple, with a sibling (options) parameter.
 *
 * @internal
 */
const hasNonEmptyTupleFirstParameter = (
  checker: ts.TypeChecker,
  signature: ts.Signature,
  declaration: ts.Declaration
): boolean => {
  const [first, second] = signature.parameters
  if (!first || !second) return false
  const parameterType = checker.getTypeOfSymbolAtLocation(first, declaration)
  if (!checker.isTupleType(parameterType)) return false
  // `createException<[]>` takes `(options?: ExceptionOptions)` — no tuple signature at all, so a
  // string there is out of scope (the documented form of an argument-less exception).
  const elements = (parameterType as { typeArguments?: readonly unknown[] }).typeArguments
  return elements !== undefined && elements.length > 0
}

/** ESLint rule: flags `new CreatedException(nonArray)` for non-empty-tuple exception factories. */
const createExceptionArgsArrayRule = createRule({
  name: 'create-exception-args-array',
  meta: {
    type: 'problem',
    docs: {
      description:
        "Constructing a `createException<[…]>` exception with a non-array first argument is silently treated as `ExceptionOptions` — the payload is dropped and the thrown message prints a literal `%s`. Pass the args array: `new E_X(['detail'])`.",
    },
    schema: [],
    messages: {
      nonArrayArgs:
        'This exception comes from `createException` with a non-empty args tuple, so its first constructor argument must be the ARRAY of interpolation values. A bare value here is read as `ExceptionOptions` instead: the payload is dropped and the message prints a literal `%s` where it belongs. Wrap it: `new {{name}}([…])`. Opt out with an eslint-disable-next-line adk/create-exception-args-array comment + reason.',
    },
  },
  defaultOptions: [],
  create(context) {
    // `parserServices` is `{}`-shaped when the consumer lints without type information — both the
    // map and the program only exist on the typed variant. (`providesTypeInfo`, the documented
    // probe, is not guaranteed to be present — the presence of the map + program is the same
    // signal, and the map is the only thing the rule reads.)
    const services = context.sourceCode.parserServices as
      | Partial<ParserServicesWithTypeInformation>
      | undefined
    const tsNodeMap = services?.esTreeNodeToTSNodeMap
    const checker = tsNodeMap ? services?.program?.getTypeChecker() : undefined

    /**
     * Same-file `const|let E_X = createException<[non-empty tuple]>(…)` bindings, by local name,
     * alongside the DECLARATOR node each name was recorded from.
     *
     * @remarks
     * The declarator is what makes a shadowing binding distinguishable: `new` reports only when the
     * callee identifier RESOLVES to that same declarator (see {@link constructsRecordedDeclarator}).
     */
    const localNonEmptyTuple = new Map<string, TSESTree.VariableDeclarator>()
    let bindings: ImportBindings = new Map()

    /**
     * The declared type of the class the `new` callee denotes, or `undefined` when the checker
     * cannot resolve one.
     *
     * @remarks
     * The callee's OWN symbol is taken from the AST node (`getSymbolAtLocation(node.callee)`), never
     * from a name lookup, so a shadowing binding resolves to itself and is judged on its own type.
     */
    const declaredTypeOfCallee = (
      node: TSESTree.NewExpression
    ): { type: ts.Type; declaration: ts.Declaration } | undefined => {
      if (!checker || !tsNodeMap) return undefined
      const tsCallee = tsNodeMap.get(node.callee)
      if (!tsCallee) return undefined
      const symbol = checker.getSymbolAtLocation(tsCallee)
      if (!symbol) return undefined
      // An import binding is an ALIAS symbol: follow it, or the declaration list is the import
      // statement and the class's own signatures are never reached.
      const target =
        (symbol.flags & SYMBOL_FLAGS_ALIAS) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
      const declaration = target.getDeclarations()?.[0]
      if (!declaration) return undefined
      return { type: checker.getTypeOfSymbolAtLocation(target, declaration), declaration }
    }

    /**
     * Whether the callee resolves to the same-file `createException` DECLARATOR this rule recorded.
     *
     * @remarks
     * A name match alone flags a shadowing binding — a function parameter, or a locally-declared
     * `class E_FOO` inside a block — that merely reuses the recorded name. Resolving the identifier
     * through ESLint's scope analysis and comparing the DECLARATOR node identity reports only a
     * construction of the recorded factory itself. A callee that resolves to no variable at all
     * (the snippet / global / re-export case) keeps the recorded-name behaviour, which is the same
     * conservative convention the rule's import handling already follows.
     */
    const constructsRecordedDeclarator = (node: TSESTree.NewExpression): boolean => {
      if (node.callee.type !== 'Identifier') return false
      const recorded = localNonEmptyTuple.get(node.callee.name)
      if (!recorded) return false
      const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), node.callee)
      if (!variable) return true
      for (const definition of variable.defs) {
        if (definition.name.type !== 'Identifier') continue
        const declarator = definition.name.parent
        if (declarator?.type !== 'VariableDeclarator') continue
        return declarator === recorded
      }
      // The variable resolved to some other binding (an import, a parameter, a class name) — a
      // different declaration wearing the recorded name.
      return false
    }

    /**
     * Whether the callee's class carries a `CreatedException`-shaped construct signature — AND
     * actually derives from the ADK exception base.
     *
     * @remarks
     * Every constructor signature is scanned rather than `getConstructSignatures()[0]`: the
     * `CreatedException<T>` type is `typeof BaseException & { new (args: T, options?) … }`, so the
     * FIRST signature is always the inherited `new (message?: string | Error, options?)` overload and
     * the args-tuple one sits after it. `getResolvedSignature()` is not used because it answers with
     * the overload TypeScript picked for THIS argument — for the footgun itself (a bare string) that
     * is the inherited message overload, which is exactly the signature that cannot be recognised.
     */
    const hasTupleArgsConstructor = (node: TSESTree.NewExpression): boolean => {
      if (!checker) return false
      const resolved = declaredTypeOfCallee(node)
      if (!resolved) return false
      if (!derivesFromAdkException(checker, resolved.type)) return false
      return resolved.type
        .getConstructSignatures()
        .some((signature) =>
          hasNonEmptyTupleFirstParameter(checker, signature, resolved.declaration)
        )
    }

    return {
      // Collect declarations BEFORE any `new` is visited: ESLint traverses the tree depth-first, so
      // a `new E_X(…)` can lexically precede the `const E_X = createException(…)` it refers to.
      Program(node: TSESTree.Program): void {
        bindings = collectImportBindings(node)
        const walk = (current: TSESTree.Node): void => {
          if (current.type === 'VariableDeclarator' && current.id.type === 'Identifier') {
            const kind = current.parent?.kind
            // `let` too: a `let`-bound exception class is the same footgun, and hoisting a `const`
            // over to `let` must not silence the rule.
            if (
              (kind === 'const' || kind === 'let') &&
              current.init?.type === 'CallExpression' &&
              hasNonEmptyTupleTypeArgument(current.init)
            ) {
              const factory = resolveCalleeName(bindings, current.init.callee)
              // A `createException` bound by an import from this package — or a bare name the file
              // never imports (a snippet, a re-export, a global) — is the factory. A same-named
              // import from a foreign module is provably something else.
              if (
                factory &&
                factory.name === 'createException' &&
                !(factory.imported && !factory.fromAdk)
              ) {
                localNonEmptyTuple.set(current.id.name, current)
              }
            }
          }
          for (const key of Object.keys(current)) {
            if (key === 'parent') continue
            const value = (current as unknown as Record<string, unknown>)[key]
            const children = Array.isArray(value) ? value : [value]
            for (const child of children) {
              if (!child || typeof child !== 'object') continue
              const childNode = child as TSESTree.Node
              if (typeof childNode.type === 'string') walk(childNode)
            }
          }
        }
        walk(node)
      },

      NewExpression(node: TSESTree.NewExpression) {
        const arg = node.arguments[0]
        if (!arg) return
        // A TS expression wrapping the argument (`as X`, `satisfies X`, `<X>`, `!`, parens) is
        // transparent: `{ fatal: true } as X` is the same misdirected ExceptionOptions shape as a
        // bare `{ fatal: true }`. An array is the correct form under either spelling.
        const unwrapped = unwrapExpression(arg)
        if (unwrapped.type === 'ArrayExpression') return
        if (unwrapped.type === 'SpreadElement') return
        if (isUndefinedValue(unwrapped)) return
        const name =
          node.callee.type === 'Identifier'
            ? node.callee.name
            : node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier'
              ? node.callee.property.name
              : undefined
        if (!name) return
        // The same-file arm reports a construction of the RECORDED binding, not of any binding
        // wearing its name; the typed arm is name-independent and judges the callee's own type.
        if (constructsRecordedDeclarator(node) || hasTupleArgsConstructor(node)) {
          context.report({ node: unwrapped, messageId: 'nonArrayArgs', data: { name } })
        }
      },
    }
  },
})

export default createExceptionArgsArrayRule
