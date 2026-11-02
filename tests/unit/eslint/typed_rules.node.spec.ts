/**
 * TYPED tests for `adk/create-exception-args-array`'s type-checker path (+ the typed-program
 * behaviour of the same-file declaration path).
 *
 * @remarks
 * The untyped RuleTester run in `rules.node.spec.ts` cannot exercise the type-aware arm: a real
 * TypeScript project is what makes the checker resolve an IMPORTED exception class. So this spec
 * copies the checked-in fixture project `tests/unit/eslint/fixtures/typed_exceptions/` into a temp
 * dir, points `parserOptions.project` at the copy, and writes one scratch consumer file per case
 * inside it. Linting only ever sees the temp copy; the fixture sources are read, never modified.
 *
 * EVERY scratch file is written by {@link makeTempProject}, before the first `lintCase` call — not
 * lazily inside each test. `parserOptions.project` makes `@typescript-eslint/parser` build (and
 * cache, keyed by tsconfig path) a program for the project, and in a "single run" context — which
 * it INFERS from `CI=true` or an `eslint`/`vitest`-style argv — that program is compiled once, up
 * front, from the tsconfig's `include` globs. A file materialised after that point is not in the
 * cached program's source-file list, so the parser rejects it with "The file was not found in any
 * of the provided project(s)". That is exactly how the 4 typed cases passed locally and failed on
 * a fresh CI runner; writing all files first removes the ordering dependency entirely.
 */
import { Linter } from 'eslint'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parser as tsParser } from 'typescript-eslint'
import { describe, expect, test, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { default as createExceptionArgsArray } from '../../../src/eslint/rules/create_exception_args_array'

const FIXTURE_PROJECT = resolve(__dirname, 'fixtures/typed_exceptions')

interface TypedCase {
  /** The case label; asserted by `it`, so a rename is a visible diff. */
  readonly label: string
  /** The imports the scratch consumer starts with. */
  readonly importLine: string
  /** The construction under test. */
  readonly construction: string
  /** Whether `adk/create-exception-args-array` must fire on the construction. */
  readonly expectFinding: boolean
}

const TYPED_CASES: readonly TypedCase[] = [
  {
    label: 'imported class flagged',
    importLine: "import { E_QUOTA } from './exceptions'",
    construction: "throw new E_QUOTA('detail')",
    expectFinding: true,
  },
  {
    label: 'namespace-imported flagged',
    importLine: "import * as exc from './exceptions'",
    construction: "throw new exc.E_QUOTA('detail')",
    expectFinding: true,
  },
  {
    label: 'imported empty-tuple class with a bare string not flagged',
    importLine: "import { E_FIXED } from './exceptions'",
    construction: "throw new E_FIXED('plain message')",
    expectFinding: false,
  },
  {
    label: 'imported class with the correct array arg not flagged',
    importLine: "import { E_QUOTA } from './exceptions'",
    construction: "throw new E_QUOTA(['detail', 3])",
    expectFinding: false,
  },
  {
    label: 'same-file declaration still flagged in a typed program',
    importLine:
      "import { createException } from '@nhtio/adk/factories'\nconst E_LOCAL = createException<[string]>('E_LOCAL', 'local %s', 'E_LOCAL')",
    construction: "throw new E_LOCAL('local-detail')",
    expectFinding: true,
  },
  {
    // An unrelated class whose overloads include a `(tuple, options?)` signature AND a scalar one
    // carries the args SHAPE but not the exception CONTRACT. The scalar construction below is a
    // valid overload of that class, so the typed path must stay silent — even though the
    // signature scan alone matches it.
    label: 'unrelated class with a tuple overload not flagged',
    importLine: "import { UnrelatedBatch } from './unrelated'",
    construction: "throw new UnrelatedBatch('batch-label')",
    expectFinding: false,
  },
  {
    // ... and the tuple overload itself is equally fine on that class: no exception, no report.
    label: 'unrelated class tuple overload not flagged',
    importLine: "import { UnrelatedBatch } from './unrelated'",
    construction: "throw new UnrelatedBatch(['a', 'b'], { keep: true })",
    expectFinding: false,
  },
]

/** The scratch consumer file a case is linted from, plus the project it lives in. */
interface TempProject {
  /** The temp copy's root; also the parser's `tsconfigRootDir`/`cwd`. */
  readonly dir: string
  /** One pre-written `src/case_<N>_under_test.ts` per `TYPED_CASES` entry, in case order. */
  readonly caseFiles: readonly string[]
}

/**
 * The temp copy of the fixture project: `src/` (the supplier modules AND every case's scratch
 * consumer) plus a `tsconfig.json` whose `@nhtio/adk` path mapping is rewritten to ABSOLUTE repo
 * paths, so the copy does not depend on its depth relative to `src/`.
 *
 * @remarks
 * The case files are written HERE, before the tsconfig, so they are on disk before any program can
 * be built from the tsconfig's `include` glob over `src/` — see the file docblock for why that
 * ordering is what keeps the typed path working under CI's inferred single-run program cache.
 */
const makeTempProject = (typedCases: readonly TypedCase[]): TempProject => {
  const projectDir = mkdtempSync(join(tmpdir(), 'adk-typed-rule-'))
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  const srcDir = join(FIXTURE_PROJECT, 'src')
  for (const entry of readdirSync(srcDir)) {
    writeFileSync(join(projectDir, 'src', entry), readFileSync(join(srcDir, entry)))
  }
  const caseFiles = typedCases.map((typedCase, index) => {
    const filePath = join(projectDir, 'src', `case_${index}_under_test.ts`)
    writeFileSync(filePath, `${typedCase.importLine}\n${typedCase.construction}\n`)
    return filePath
  })
  const repoRoot = resolve(__dirname, '../../..')
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: {
        '@nhtio/adk': [join(repoRoot, 'src/index.ts')],
        '@nhtio/adk/*': [join(repoRoot, 'src/*.ts')],
      },
    },
    include: ['src/**/*.ts'],
  }
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
  return { dir: projectDir, caseFiles }
}

let project: TempProject | undefined

beforeAll(() => {
  project = makeTempProject(TYPED_CASES)
})

afterAll(() => {
  if (project) rmSync(project.dir, { recursive: true, force: true })
})

const lintCase = (typedCase: TypedCase, index: number): Linter.LintMessage[] => {
  if (!project) throw new Error('temp project was not created')
  const filePath = project.caseFiles[index]
  if (!filePath) throw new Error(`no scratch file for case ${index} (${typedCase.label})`)
  // Read the file back so the linted text is byte-for-byte the file the program was built from.
  const code = readFileSync(filePath, 'utf8')
  const linter = new Linter({ configType: 'flat', cwd: project.dir })
  // The third argument is what names the file — the parser needs it on disk and inside the project
  // for `parserOptions.project` to attach type information.
  const cfg = {
    files: ['**/*.ts'],
    plugins: {
      adk: {
        meta: { name: 'adk-typed-test', version: '0.0.0' },
        rules: { 'create-exception-args-array': createExceptionArgsArray },
      },
    },
    rules: { 'adk/create-exception-args-array': 'error' },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: join(project.dir, 'tsconfig.json'),
        tsconfigRootDir: project.dir,
      },
    },
    // `as any`: the plugin object below is a deliberately minimal stand-in for FlatConfig.Plugin's
    // full shape (no `configs`, no rule metadata typing), which the flat-config type requires.
  } as any
  return linter.verify(code, cfg, filePath)
}

describe('create-exception-args-array (typed path)', () => {
  for (const typedCase of TYPED_CASES) {
    test(typedCase.label, () => {
      const messages = lintCase(typedCase, TYPED_CASES.indexOf(typedCase))
      const fatal = messages.filter((m) => m.fatal)
      expect(fatal, `parse/type failure: ${JSON.stringify(messages)}`).toHaveLength(0)
      const findings = messages.filter((m) => m.ruleId === 'adk/create-exception-args-array')
      if (typedCase.expectFinding) {
        expect(findings, `expected a finding for: ${typedCase.construction}`).toHaveLength(1)
        expect(findings[0]?.message).toContain('ExceptionOptions')
      } else {
        expect(
          findings,
          `expected NO finding for: ${typedCase.construction} — got ${JSON.stringify(messages)}`
        ).toHaveLength(0)
      }
    })
  }
})
