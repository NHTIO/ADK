import { describe, test, afterAll } from 'vitest'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { default as toolNameProviderSafe } from '../../../src/eslint/rules/tool_name_provider_safe'
import { default as noModelInToolHandler } from '../../../src/eslint/rules/no_model_in_tool_handler'
import { default as createExceptionArgsArray } from '../../../src/eslint/rules/create_exception_args_array'
import { default as requireValidatorAnyRequired } from '../../../src/eslint/rules/require_validator_any_required'
import { default as requireStringEmptyDisposition } from '../../../src/eslint/rules/require_string_empty_disposition'
import { default as thoughtPayloadRequiresReplayTag } from '../../../src/eslint/rules/thought_payload_requires_replay_tag'
import { default as tokenEncodingRequiresContextWindow } from '../../../src/eslint/rules/token_encoding_requires_context_window'
import { default as artifactToolForbidsArtifactConstructor } from '../../../src/eslint/rules/artifact_tool_forbids_artifact_constructor'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals).
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const ruleTester = new RuleTester()

ruleTester.run('require-validator-any-required', requireValidatorAnyRequired, {
  valid: [
    { code: 'const s = validator.any().required()' },
    { code: 'const s = validator.any().optional()' },
    { code: 'const s = validator.any().default(null)' },
    { code: 'const s = validator.any().forbidden()' },
    { code: 'const s = validator.any().required().valid(null)' },
    // disposition can appear nested in a chain
    { code: 'const s = validator.alternatives(validator.string(), validator.any().optional())' },
    // not the validator namespace -> ignored
    { code: 'expect.any(String)' },
    { code: 'const s = _.any(xs)' },
  ],
  invalid: [
    { code: 'const s = validator.any()', errors: [{ messageId: 'declareIntent' }] },
    { code: 'const s = validator.any().valid(null)', errors: [{ messageId: 'declareIntent' }] },
    {
      code: 'const s = validator.object({ x: validator.any() })',
      errors: [{ messageId: 'declareIntent' }],
    },
    {
      // enclosing .required() does NOT govern the inner .any()
      code: 'const s = validator.array().items(validator.any()).required()',
      errors: [{ messageId: 'declareIntent' }],
    },
  ],
})

ruleTester.run('require-string-empty-disposition', requireStringEmptyDisposition, {
  valid: [
    // Bare chain OUTSIDE any Tool/ArtifactTool inputSchema — e.g. a battery's own construction-
    // options validation.ts. Must NOT be flagged by the published copy (the repo-internal copy's
    // file-glob scope would flag this; that divergence is intentional and documented, not a bug).
    {
      code: 'const optionsSchema = validator.object({ baseURL: validator.string().optional() })',
    },
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().allow('') }) })",
    },
    // `.empty('')` is a SEPARATE documented clearing method with its own branch in
    // `chainHasEmptyStringClear` — it must be exercised independently of `.allow('')` so it cannot
    // regress on its own. (Joi treats `.empty('')` as "coerce '' to undefined", which is a real
    // disposition, not merely an alias for allowing the value through.)
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().empty('') }) })",
    },
    {
      code: "new ArtifactTool({ name: 't', inputSchema: validator.object({ q: validator.string().default('x').empty('') }) })",
    },
    // .required() with no .optional()/.default() is out of scope entirely, even inside inputSchema.
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().required() }) })",
    },
    // Policy A: an explicit .valid(...) enum is sufficient disposition on its own, '' or not.
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().valid('a', 'b') }) })",
    },
    // .forbidden() trivially clears — the value must be absent entirely.
    {
      code: "new ArtifactTool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().forbidden() }) })",
    },
    // A helper-function-internal cross-branch shape (media's actual bug shape) is out of scope for
    // the published copy even when it flows into an inputSchema — this copy only looks at the
    // literal chain shape written directly inside the inputSchema value.
    {
      code: "new Tool({ name: 't', inputSchema: buildScrapperSchema() })",
    },
  ],
  invalid: [
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional() }) })",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    {
      code: "new ArtifactTool({ name: 't', inputSchema: validator.object({ q: validator.string().default('x') }) })",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    // .allow(null) alone does not clear it — confirmed empirically it still rejects ''.
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().allow(null) }) })",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
    // The same argument check governs `.empty(...)`: only a bare `''` literal clears the rule, so
    // `.empty(null)` must still report. Pairs with the `.allow(null)` case above so neither
    // method's literal check can regress unnoticed.
    {
      code: "new Tool({ name: 't', inputSchema: validator.object({ q: validator.string().optional().empty(null) }) })",
      errors: [{ messageId: 'requireEmptyDisposition' }],
    },
  ],
})

ruleTester.run('thought-payload-requires-replay-tag', thoughtPayloadRequiresReplayTag, {
  valid: [
    { code: 'new Thought({ id: "t", content: "c", createdAt: now, updatedAt: now })' },
    {
      code: 'new Thought({ id: "t", content: "c", payload: blob, replayCompatibility: "wire-v1", createdAt: now, updatedAt: now })',
    },
    // payload explicitly undefined == absent
    { code: 'new Thought({ id: "t", content: "c", payload: undefined })' },
    // spread could supply the tag -> conservative, no flag
    { code: 'new Thought({ ...base, payload: blob })' },
    // not a Thought
    { code: 'new Widget({ payload: blob })' },
  ],
  invalid: [
    {
      code: 'new Thought({ id: "t", content: "c", payload: blob, createdAt: now, updatedAt: now })',
      errors: [{ messageId: 'requireReplayTag' }],
    },
    {
      code: 'new Thought({ payload: blob, replayCompatibility: undefined })',
      errors: [{ messageId: 'requireReplayTag' }],
    },
  ],
})

ruleTester.run('token-encoding-requires-context-window', tokenEncodingRequiresContextWindow, {
  valid: [
    { code: 'new OpenAIChatCompletionsAdapter({ model: "m" })' },
    { code: 'new OpenAIChatCompletionsAdapter({ model: "m", tokenEncoding: null })' },
    {
      code: 'new OpenAIChatCompletionsAdapter({ model: "m", tokenEncoding: "cl100k_base", contextWindow: 8192 })',
    },
    {
      code: 'new WebLLMChatCompletionsAdapter({ model: "m", tokenEncoding: "cl100k_base", contextWindow: 4096 })',
    },
    // spread could supply contextWindow -> conservative, no flag
    { code: 'new OpenAIChatCompletionsAdapter({ ...opts, tokenEncoding: "cl100k_base" })' },
    // not an adapter
    { code: 'new Foo({ tokenEncoding: "cl100k_base" })' },
  ],
  invalid: [
    {
      code: 'new OpenAIChatCompletionsAdapter({ model: "m", tokenEncoding: "cl100k_base" })',
      errors: [{ messageId: 'requireContextWindow' }],
    },
    {
      code: 'new WebLLMChatCompletionsAdapter({ model: "m", tokenEncoding: "o200k_base" })',
      errors: [{ messageId: 'requireContextWindow' }],
    },
  ],
})

ruleTester.run(
  'artifact-tool-forbids-artifact-constructor',
  artifactToolForbidsArtifactConstructor,
  {
    valid: [
      { code: 'new ArtifactTool({ name: "q", description: "d", inputSchema: s, handler: h })' },
      { code: 'new ArtifactTool({ name: "q", artifactConstructor: undefined })' },
      // base Tool legitimately accepts artifactConstructor
      { code: 'new Tool({ name: "t", artifactConstructor: MyArtifact })' },
    ],
    invalid: [
      {
        code: 'new ArtifactTool({ name: "q", artifactConstructor: MyArtifact })',
        errors: [{ messageId: 'forbidArtifactConstructor' }],
      },
    ],
  }
)

ruleTester.run('no-model-in-tool-handler', noModelInToolHandler, {
  valid: [
    // plain handler doing real work
    {
      code: 'new Tool({ name: "t", handler: async (ctx, args) => { return compute(args) } })',
    },
    // sub-agent exception: handler wraps its own TurnRunner
    {
      code: 'new Tool({ name: "t", handler: async (ctx) => { const r = new TurnRunner(cfg); return r.run(ctx) } })',
    },
    // sub-agent exception: handler runs the lower-level DispatchRunner.dispatch
    {
      code: 'new Tool({ name: "t", handler: async () => { return DispatchRunner.dispatch(input) } })',
    },
    // model call OUTSIDE a tool handler is none of this rule's business
    { code: 'const out = await openai.chat.completions.create({ model: "m" })' },
    // non-LLM .create() is fine
    { code: 'new Tool({ name: "t", handler: async () => db.records.create({ x: 1 }) })' },
  ],
  invalid: [
    {
      code: 'new Tool({ name: "t", handler: async () => { return openai.chat.completions.create({ model: "m" }) } })',
      errors: [{ messageId: 'noModelInHandler' }],
    },
    {
      code: 'new ArtifactTool({ name: "q", handler: async () => { const c = new OpenAI(); return c } })',
      errors: [{ messageId: 'noModelInHandler' }],
    },
    {
      code: 'new Tool({ name: "t", handler: async () => anthropic.messages.create({ model: "m" }) })',
      errors: [{ messageId: 'noModelInHandler' }],
    },
  ],
})

ruleTester.run('tool-name-provider-safe', toolNameProviderSafe, {
  valid: [
    // plain conforming names
    { code: 'new Tool({ name: "run_shell_command" })' },
    { code: 'new Tool({ name: "a" })' },
    { code: 'new Tool({ name: "_private1" })' },
    // template literal with no expressions counts as static -> conforming passes
    { code: 'new Tool({ name: `stage_file` })' },
    // dynamic names are deliberately ignored
    { code: 'new Tool({ name })' },
    { code: 'new Tool({ name: `tool_${kind}` })' },
    { code: 'new Tool({ name: buildName(prefix) })' },
    // spread could supply name -> out of scope
    { code: 'new Tool({ ...opts })' },
    // no name property at all
    { code: 'new Tool({ handler: h })' },
    // not a Tool construction
    { code: 'new Widget({ name: "9bad name." })' },
    // 64-char name is the boundary and is legal
    {
      code: 'new Tool({ name: "' + 'a'.repeat(64) + '" })',
    },
    // the 65-character over-limit name lives in the INVALID list below, spelled as the static
    // literal the docs' example shows ('a'.repeat(65) is a call expression and is ignored)
    // a `Tool` imported from ANOTHER module is another library's class — its wire contract is not
    // this one, so an out-of-shape name there is none of the rule's business
    {
      code: `import { Tool } from 'some-other-lib'
new Tool({ name: '2bad' })`,
    },
    {
      code: `import { Tool as ForeignTool } from 'some-other-lib'
new ForeignTool({ name: '2bad' })`,
    },
    // a foreign namespace's `Tool` is out of scope too
    {
      code: `import * as other from 'some-other-lib'
new other.Tool({ name: '2bad' })`,
    },
    // a local object named like a namespace is not an import binding -> not resolved
    {
      code: `const ns = { Tool: class {} }
new ns.Tool({ name: '2bad' })`,
    },
    // conforming names through the adk barrels the class is published from
    {
      code: `import { Tool } from '@nhtio/adk/common'
new Tool({ name: 'run_shell_command' })`,
    },
  ],
  invalid: [
    // a digit prefix is exactly what Gemini's functionDeclarations reject
    {
      code: 'new Tool({ name: "2fa_check" })',
      errors: [{ messageId: 'unsafeName' }],
    },
    // dots are accepted by no wire's tool-name channel
    {
      code: 'new Tool({ name: "vault.read" })',
      errors: [{ messageId: 'unsafeName' }],
    },
    // spaces and punctuation
    {
      code: 'new Tool({ name: "web search!" })',
      errors: [{ messageId: 'unsafeName' }],
    },
    // 65 chars -> one past the boundary, spelled as exactly the static literal the docs' example
    // shows (the dynamic 'a'.repeat(65) spelling is deliberately ignored by the rule)
    {
      code: 'new Tool({ name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })',
      errors: [{ messageId: 'unsafeName' }],
    },
    // zero-length name
    { code: 'new Tool({ name: "" })', errors: [{ messageId: 'unsafeName' }] },
    // non-expression template literal is still checked for shape
    {
      code: 'new Tool({ name: `9lives` })',
      errors: [{ messageId: 'unsafeName' }],
    },
    // a TS expression wrapping the argument must not silence the rule
    // (regression: `createSkillManager({ sources } as SkillManagerConfig)` slipped through)
    { code: 'new Tool({ name: "2fa_check" } as any)', errors: [{ messageId: 'unsafeName' }] },
    {
      code: 'new Tool({ name: "2fa_check" } satisfies ToolOptions)',
      errors: [{ messageId: 'unsafeName' }],
    },
    { code: 'new Tool(<any>{ name: "2fa_check" })', errors: [{ messageId: 'unsafeName' }] },
    { code: 'new Tool({ name: ("2fa_check") })', errors: [{ messageId: 'unsafeName' }] },
    { code: 'new Tool((({ name: "2fa_check" })!))', errors: [{ messageId: 'unsafeName' }] },
    { code: 'new Tool({ name: "2fa_check" } as const)', errors: [{ messageId: 'unsafeName' }] },
    // a TS expression wrapping the property VALUE is equally transparent
    { code: 'new Tool({ name: ("2fa_check" as const) })', errors: [{ messageId: 'unsafeName' }] },
    // an ALIASED import of this package's Tool is still this package's Tool
    {
      code: `import { Tool as AdkTool } from '@nhtio/adk'
new AdkTool({ name: '2bad' })`,
      errors: [{ messageId: 'unsafeName' }],
    },
    // so is the class reached through a namespace import of a Tool-publishing subpath
    {
      code: `import * as adk from '@nhtio/adk'
new adk.Tool({ name: '2bad' })`,
      errors: [{ messageId: 'unsafeName' }],
    },
    {
      code: `import * as adk from '@nhtio/adk/common'
new adk.Tool({ name: '2bad' })`,
      errors: [{ messageId: 'unsafeName' }],
    },
  ],
})

ruleTester.run('create-exception-args-array', createExceptionArgsArray, {
  valid: [
    // the correct array form
    { code: "const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X(['detail'])" },
    // empty-tuple factory takes ExceptionOptions, so a bare options object is correct
    {
      code: "const E_NO_ARGS = createException<[ ]>('E_NO_ARGS', 'bad', 'E_NO_ARGS')\nnew E_NO_ARGS({ code: 'E_NO_ARGS' })",
    },
    // no type argument at all -> T defaults to [] -> options shape is correct
    {
      code: "const E_BARE = createException('E_BARE', 'bad', 'E_BARE')\nnew E_BARE({ code: 'E_BARE' })",
    },
    // undefined first argument is the absent-first-arg form, not a misdirected message value
    { code: "const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X(undefined)" },
    // unrelated constructor with a string argument is out of scope
    { code: "class Other { constructor(a: string) {} }\nnew Other('detail')" },
    // `let`-bound declarations are NOT an escape hatch (see the invalid cases) — but a `let` whose
    // factory is a foreign `createException` is provably not this package's factory
    {
      code: `import { createException } from 'some-other-lib'\nlet E_X = createException<[string]>('E_X', 'x %s', 'E_X')\nnew E_X('x')`,
    },
    // a factory imported under an alias from a foreign module is the same story
    {
      code: `import { createException as ce } from 'some-other-lib'\nconst E_X = ce<[string]>('E_X', 'x %s', 'E_X')\nnew E_X('x')`,
    },
    // An inner-scope SHADOW of a recorded exception class: a function parameter, or a
    // locally-declared class inside a block, reusing the recorded NAME is a different binding —
    // the recorded declarator's constructor is untouched and its bare-string construction is
    // still the only thing the same-file arm is allowed to flag. (Name-only matching flagged
    // both of these.)
    {
      code: `const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nfunction run(E_X: { new (a: string): unknown }): void { new E_X('detail') }\nrun(cls)`,
    },
    {
      code: `const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\n{\n  class E_X { constructor(a: string) { void a } }\n  new E_X('detail')\n}`,
    },
  ],
  invalid: [
    // the classic footgun: bare string silently read as ExceptionOptions, '%s' thrown verbatim
    {
      code: "const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X('detail')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // numbers are equally misdirected
    {
      code: "const E_ID = createException<[string]>('E_ID', 'no id: %s', 'E_ID')\nnew E_ID(42)",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // a boolean
    {
      code: "const E_STRICT = createException<[boolean]>('E_STRICT', 'strict: %s', 'E_STRICT')\nnew E_STRICT(true)",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // object-shaped first argument is STILL the footgun: no args tuple is supplied, so the
    // `%s` stays literal — the same silent misdirection as a bare string.
    {
      code: "const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X({ fatal: true })",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // `new` before the lexical declaration still binds (hoisted pass order)
    {
      code: "if (v) { new E_LATE('x') }\nconst E_LATE = createException<[string]>('E_LATE', 'late: %s', 'E_LATE')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // a TS expression wrapping the argument must not silence the rule
    {
      code: "const E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X({ fatal: true } as XOptions)",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // `let`-bound declarations are the same footgun as `const`-bound ones
    {
      code: "let E_X = createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X('detail')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // the factory imported under a local alias still binds the exception class
    {
      code: "import { createException as ce } from '@nhtio/adk/factories'\nconst E_X = ce<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X('detail')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // ... and so does the factory reached through a namespace import
    {
      code: "import * as adk from '@nhtio/adk/factories'\nconst E_X = adk.createException<[string]>('E_X', 'bad: %s', 'E_X')\nnew E_X('detail')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
    // a bare (never-imported) factory name is matched conservatively, as before
    {
      code: "const E_UNIMPORTED = createException<[string]>('E_UNIMPORTED', 'bad: %s', 'E_UNIMPORTED')\nnew E_UNIMPORTED('detail')",
      errors: [{ messageId: 'nonArrayArgs' }],
    },
  ],
})
