// Node assembler for the ADK runtime bundle — the same symbol set docs/.vitepress/repl/index.ts compiles
// into adk-repl.es.js for the browser, but imported directly from @nhtio/adk src (tsconfig paths map
// @nhtio/adk/* → src/*). Feed the result to agent_adk._initAgentRuntimeFromBundle() so the flagship's
// runtime holders are populated without the browser-only precompiled-bundle loader.
import * as adkModule from '@nhtio/adk'
import { validator } from '@nhtio/validation'
import { encode, decode } from '@nhtio/encoder'
import * as batteriesTools from '@nhtio/adk/batteries/tools'
import { OramaVectorStore } from '@nhtio/adk/batteries/vector/orama'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { formatTableTool } from '@nhtio/adk/batteries/tools/structured_data'
import { calculateTool, formatNumberTool, formatListTool } from '@nhtio/adk/batteries/tools'
import { registerAdkEncodables, registerSpoolReaderResolver } from '@nhtio/adk/batteries/encoding'
import {
  assembleCompactedTurns,
  summariseTurns,
  COMPACTION_SYSTEM_PROMPT,
} from '@nhtio/adk/batteries/context/compact'
import {
  subtractToFit,
  resolveBudget,
  stripPriorTurnThoughts,
  selectRelevantTurns,
  selectNaiveTurns,
  groupHistoryIntoTurns,
  scaledRelevanceFloor,
  contentTokens,
} from '@nhtio/adk/batteries/context/thrift'
import {
  Message,
  Memory,
  Retrievable,
  TurnRunner,
  Tokenizable,
  isError,
  Thought,
  Tool,
  ToolCall,
  ToolRegistry,
  SpooledJsonArtifact,
  DispatchRunner,
  Media,
  inMemoryMediaReader,
} from '@nhtio/adk'
import {
  LiteRtLmAdapter,
  renderArtifactHandleBody,
  looksLikeSpooledArtifact,
  renderToolsAsPromptText,
  renderLiteRtToolResult,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
} from '@nhtio/adk/batteries/llm/litert_lm'
import type { AdkRuntimeBundle } from '../../../docs/.vitepress/theme/components/quickstart_demo_runtime'

// Node has no WebGPU: TransformersJsAdapter/E_LLM_GPU_OUT_OF_MEMORY/probeGpuBudget and the OPFS spool store
// are never exercised by the Node harness (Ollama adapter + InMemorySpoolStore). Provide inert stand-ins so
// the bundle shape is complete. probeGpuBudget resolves "unavailable" so preload()'s probe fails soft.
const notInNode = (name: string) => () => {
  throw new Error(`${name} is browser-only; not available in the Node harness`)
}

export function buildNodeAdkBundle(): AdkRuntimeBundle {
  return {
    adkModule,
    validator,
    Message,
    Memory,
    Retrievable,
    Thought,
    Tool,
    ToolCall,
    ToolRegistry,
    Tokenizable,
    SpooledJsonArtifact,
    DispatchRunner,
    TurnRunner,
    // No WebGPU transformers.js / WebLLM path in Node; harness always injects the Ollama adapter factory.
    TransformersJsAdapter: notInNode('TransformersJsAdapter') as never,
    WebLLMChatCompletionsAdapter: notInNode('WebLLMChatCompletionsAdapter') as never,
    LiteRtLmAdapter,
    // Render helpers the worker-migration added to AdkRuntimeBundle (used by the LiteRT path's
    // measureToolResultAsText). Pure functions, importable in Node — provided so the bundle type is
    // complete even though the Node harness takes the injected-adapter path, not the LiteRT branch.
    renderLiteRtToolResult,
    defaultRenderUntrustedContent,
    defaultRenderTrustedContent,
    renderArtifactHandleBody,
    looksLikeSpooledArtifact,
    renderToolsAsPromptText,
    Media,
    inMemoryMediaReader,
    OramaVectorStore,
    // Harness injects InMemorySpoolStore via spoolStoreFactory; expose it as the OpfsSpoolStore slot so any
    // default-path construction still yields a working (in-memory) store rather than throwing.
    OpfsSpoolStore: InMemorySpoolStore as never,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the exported exception name from src
    E_LLM_GPU_OUT_OF_MEMORY: class E_LLM_GPU_OUT_OF_MEMORY extends Error {} as never,
    probeGpuBudget: (async () => ({ available: false, maxBufferBytes: 0 })) as never,
    isError,
    calculateTool,
    formatNumberTool,
    formatListTool,
    formatTableTool,
    batteriesTools,
    encode,
    decode,
    registerAdkEncodables,
    registerSpoolReaderResolver,
    // OPFS spool reader is browser-only; encoder rehydration of a persisted OPFS handle never happens in the
    // Node harness (fresh in-memory DB per run), so a throwing stand-in is safe.
    OpfsSpoolReader: notInNode('OpfsSpoolReader') as never,
    SPOOL_READER_TAG_OPFS: 'opfs' as never,
    // Context-management batteries (Token Thrift + Compact) — same real functions the browser bundle
    // exposes, imported directly from src (tsconfig paths map @nhtio/adk/* → src/*).
    subtractToFit,
    resolveBudget,
    stripPriorTurnThoughts,
    selectRelevantTurns,
    selectNaiveTurns,
    groupHistoryIntoTurns,
    scaledRelevanceFloor,
    contentTokens,
    assembleCompactedTurns,
    summariseTurns,
    COMPACTION_SYSTEM_PROMPT,
  }
}
