import { describe, expect, it } from 'vitest'
import { Tokenizable, SpooledArtifact } from '@nhtio/adk'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { scriptStep } from '../../../_fixtures/scripted_executor'
import { toonToJsonTool } from '@nhtio/adk/batteries/artifacts/toon'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { yamlToJsonTool, jsonToYamlTool } from '@nhtio/adk/batteries/artifacts/yaml'
import type { DispatchContext, DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk'

// Test YAML document with structured content
const YAML_SOURCE = `
user:
  name: Alice
  email: alice@example.com
  roles:
    - admin
    - developer
config:
  debug: true
  timeout: 3600
`

const TOON_SOURCE = `
version: 1.0
config:
  debug: true
  name: 'test-config'
`

describe('TurnRunner: converter round-trip — forge-and-query chain', () => {
  it('yaml_to_json converter returns a queryable JSON artifact, then forged json_* tools can query it', async () => {
    const store = new InMemorySpoolStore()

    type Captured = {
      converterCallId?: string
      converterResultClass?: string
      converterResultContent?: string
      forgedJsonToolsPresent?: string[]
      jsonGetCallId?: string
      jsonGetFromArtifactTool?: boolean
      jsonGetResults?: string
    }
    const captured: Captured = {}

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: invoke yaml_to_json converter with inline YAML text
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'yaml_to_json',
                args: { text: YAML_SOURCE, call_id: '' },
              },
            ],
          },
          store
        )(ctx, helpers)
        return
      }

      if (ctx.iteration === 1) {
        // Capture the converter's ToolCall result
        const converterCalls = [...ctx.turnToolCalls].filter((tc) => tc.tool === 'yaml_to_json')
        if (converterCalls.length > 0) {
          const converterCall = converterCalls[0]
          captured.converterCallId = converterCall.id
          captured.converterResultClass = converterCall.results?.constructor.name
          if (SpooledArtifact.isSpooledArtifact(converterCall.results)) {
            captured.converterResultContent = await (
              converterCall.results as SpooledArtifact
            ).asString()
          }
        }

        // DispatchRunner has already forged artifact-specific tools and registered them in
        // ctx.tools before this executor runs. Read from ctx.tools directly to verify the
        // dispatcher's integration.
        captured.forgedJsonToolsPresent = ctx.tools
          .all()
          .filter((t) => t.name.startsWith('artifact_json_'))
          .map((t) => t.name)
          .sort()

        // Invoke artifact_json_get against the converter's result with a JSONPath.
        // Use the tool from ctx.tools (populated by the dispatcher's #forgeArtifactTools)
        const [converterTc] = converterCalls
        if (converterTc) {
          await scriptStep(
            {
              toolCalls: [
                {
                  tool: 'artifact_json_get',
                  args: { callId: converterTc.id, path: '$.user.name' },
                },
              ],
            },
            store
          )(ctx, helpers)
        }

        // Capture the forged tool's invocation
        const jsonGetCalls = [...ctx.turnToolCalls].filter((tc) => tc.tool === 'artifact_json_get')
        if (jsonGetCalls.length > 0) {
          const jsonGetCall = jsonGetCalls[0]
          captured.jsonGetCallId = jsonGetCall.id
          captured.jsonGetFromArtifactTool = jsonGetCall.fromArtifactTool
          if (Tokenizable.isTokenizable(jsonGetCall.results)) {
            captured.jsonGetResults = jsonGetCall.results.toString()
          }
        }

        ctx.ack()
        return
      }

      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [yamlToJsonTool],
    })

    await run()

    // The converter must return a real SpooledJsonArtifact, not null/empty/string
    expect(captured.converterResultClass).toBe('SpooledJsonArtifact')
    expect(captured.converterResultContent).toBeDefined()
    expect(captured.converterResultContent).not.toEqual('')
    // The converter's result must contain the converted JSON structure
    const convertedJson = JSON.parse(captured.converterResultContent!)
    expect(convertedJson.user.name).toBe('Alice')
    expect(convertedJson.config.debug).toBe(true)

    // On iteration 1, forged tools must include the JSON artifact-specific tools
    expect(captured.forgedJsonToolsPresent).toContain('artifact_json_get')
    expect(captured.forgedJsonToolsPresent).toContain('artifact_json_keys')

    // The forged tool's ToolCall must be marked fromArtifactTool = true
    expect(captured.jsonGetFromArtifactTool).toBe(true)

    // The forged tool must return real data from the artifact, not null/empty/object placeholder
    expect(captured.jsonGetResults).toBeDefined()
    expect(captured.jsonGetResults).not.toEqual('')
    // defaultSerialise returns string representation of the result
    // For a JSONPath that matches $.user.name, the result is an array with "Alice"
    // and when serialised, it becomes a string representation
    expect(captured.jsonGetResults).toContain('Alice')
  })

  it('json_to_yaml converter returns a queryable YAML artifact, then forged yaml_* tools can query it', async () => {
    const store = new InMemorySpoolStore()

    type Captured = {
      converterCallId?: string
      converterResultClass?: string
      converterResultContent?: string
      forgedYamlToolsPresent?: string[]
      yamlKeysCallId?: string
      yamlKeysFromArtifactTool?: boolean
      yamlKeysResults?: string
    }
    const captured: Captured = {}

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: invoke json_to_yaml converter with inline JSON text
        const jsonData = { app: 'test', version: '1.0', features: ['a', 'b'] }
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'json_to_yaml',
                args: { text: JSON.stringify(jsonData), call_id: '' },
              },
            ],
          },
          store
        )(ctx, helpers)
        return
      }

      if (ctx.iteration === 1) {
        // Capture the converter's ToolCall result
        const converterCalls = [...ctx.turnToolCalls].filter((tc) => tc.tool === 'json_to_yaml')
        if (converterCalls.length > 0) {
          const converterCall = converterCalls[0]
          captured.converterCallId = converterCall.id
          captured.converterResultClass = converterCall.results?.constructor.name
          if (SpooledArtifact.isSpooledArtifact(converterCall.results)) {
            captured.converterResultContent = await (
              converterCall.results as SpooledArtifact
            ).asString()
          }
        }

        // DispatchRunner has already forged artifact-specific tools and registered them in
        // ctx.tools before this executor runs. Read from ctx.tools directly.
        captured.forgedYamlToolsPresent = ctx.tools
          .all()
          .filter((t) => t.name.startsWith('artifact_yaml_'))
          .map((t) => t.name)
          .sort()

        // Invoke artifact_yaml_keys against the converter's result.
        // Use the tool from ctx.tools (populated by the dispatcher's #forgeArtifactTools)
        const [converterTc] = converterCalls
        if (converterTc) {
          await scriptStep(
            {
              toolCalls: [
                {
                  tool: 'artifact_yaml_keys',
                  args: { callId: converterTc.id },
                },
              ],
            },
            store
          )(ctx, helpers)
        }

        // Capture the forged tool's invocation
        const yamlKeysCalls = [...ctx.turnToolCalls].filter(
          (tc) => tc.tool === 'artifact_yaml_keys'
        )
        if (yamlKeysCalls.length > 0) {
          const yamlKeysCall = yamlKeysCalls[0]
          captured.yamlKeysCallId = yamlKeysCall.id
          captured.yamlKeysFromArtifactTool = yamlKeysCall.fromArtifactTool
          if (Tokenizable.isTokenizable(yamlKeysCall.results)) {
            captured.yamlKeysResults = yamlKeysCall.results.toString()
          }
        }

        ctx.ack()
        return
      }

      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [jsonToYamlTool],
    })

    await run()

    // The converter must return a real SpooledYamlArtifact, not null/empty/string
    expect(captured.converterResultClass).toBe('SpooledYamlArtifact')
    expect(captured.converterResultContent).toBeDefined()
    expect(captured.converterResultContent).not.toEqual('')
    // The converter's result must contain YAML-formatted output
    expect(captured.converterResultContent).toContain('app:')
    expect(captured.converterResultContent).toContain('version:')

    // On iteration 1, forged tools must include the YAML artifact-specific tools
    expect(captured.forgedYamlToolsPresent).toContain('artifact_yaml_keys')
    expect(captured.forgedYamlToolsPresent).toContain('artifact_yaml_type')

    // The forged tool's ToolCall must be marked fromArtifactTool = true
    expect(captured.yamlKeysFromArtifactTool).toBe(true)

    // The forged tool must return real data from the artifact
    expect(captured.yamlKeysResults).toBeDefined()
    expect(captured.yamlKeysResults).not.toEqual('')
    expect(captured.yamlKeysResults).not.toContain('null')
    // Keys should be present in the result string representation
    expect(captured.yamlKeysResults).toContain('app')
    expect(captured.yamlKeysResults).toContain('version')
    expect(captured.yamlKeysResults).toContain('features')
  })

  it('toon_to_json converter preserves round-trip fidelity via forged json tools', async () => {
    const store = new InMemorySpoolStore()

    type Captured = {
      converterCallId?: string
      converterResultClass?: string
      converterResultContent?: string
      jsonKeysCallId?: string
      jsonKeysResults?: string
    }
    const captured: Captured = {}

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: invoke toon_to_json converter with inline TOON text
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'toon_to_json',
                args: { text: TOON_SOURCE, call_id: '' },
              },
            ],
          },
          store
        )(ctx, helpers)
        return
      }

      if (ctx.iteration === 1) {
        // Capture the converter's ToolCall result
        const converterCalls = [...ctx.turnToolCalls].filter((tc) => tc.tool === 'toon_to_json')
        if (converterCalls.length > 0) {
          const converterCall = converterCalls[0]
          captured.converterCallId = converterCall.id
          captured.converterResultClass = converterCall.results?.constructor.name
          if (SpooledArtifact.isSpooledArtifact(converterCall.results)) {
            captured.converterResultContent = await (
              converterCall.results as SpooledArtifact
            ).asString()
          }
        }

        // DispatchRunner has already forged artifact-specific tools and registered them in
        // ctx.tools before this executor runs. Use the tool from ctx.tools.
        const [converterTc] = converterCalls
        if (converterTc) {
          await scriptStep(
            {
              toolCalls: [
                {
                  tool: 'artifact_json_keys',
                  args: { callId: converterTc.id },
                },
              ],
            },
            store
          )(ctx, helpers)
        }

        // Capture the result
        const jsonKeysCalls = [...ctx.turnToolCalls].filter(
          (tc) => tc.tool === 'artifact_json_keys'
        )
        if (jsonKeysCalls.length > 0) {
          const jsonKeysCall = jsonKeysCalls[0]
          captured.jsonKeysCallId = jsonKeysCall.id
          if (Tokenizable.isTokenizable(jsonKeysCall.results)) {
            captured.jsonKeysResults = jsonKeysCall.results.toString()
          }
        }

        ctx.ack()
        return
      }

      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [toonToJsonTool],
    })

    await run()

    // The converter must return a real SpooledJsonArtifact
    expect(captured.converterResultClass).toBe('SpooledJsonArtifact')
    expect(captured.converterResultContent).toBeDefined()
    // The TOON source contains 'version' and 'config' — both must be in the JSON
    const convertedJson = JSON.parse(captured.converterResultContent!)
    expect(convertedJson).toHaveProperty('version')
    expect(convertedJson).toHaveProperty('config')
    expect(convertedJson.config.debug).toBe(true)

    // Forged tools must return the keys from the converted structure
    expect(captured.jsonKeysResults).toBeDefined()
    expect(captured.jsonKeysResults).toContain('version')
    expect(captured.jsonKeysResults).toContain('config')
  })
})
