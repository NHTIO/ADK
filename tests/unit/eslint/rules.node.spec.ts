import { describe, test, afterAll } from 'vitest'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { default as noModelInToolHandler } from '../../../src/eslint/rules/no_model_in_tool_handler'
import { default as requireValidatorAnyRequired } from '../../../src/eslint/rules/require_validator_any_required'
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
