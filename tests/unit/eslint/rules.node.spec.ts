import { describe, test, afterAll } from 'vitest'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { default as noModelInToolHandler } from '../../../src/eslint/rules/no_model_in_tool_handler'
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
