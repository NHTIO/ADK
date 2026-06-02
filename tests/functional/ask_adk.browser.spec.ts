// Ask ADK end-to-end eval — POINTER SPEC.
//
// The real eval lives in `bin/ask_adk_eval.ts`, NOT here. It cannot be a vitest
// browser spec: the demo's `AskAdkHarness` loads @nhtio/adk from a precompiled
// bundle served at `<origin>/repl/adk-repl.es.js`, spawns a WebGPU Web Worker,
// and uses OPFS — none of which the vitest browser server provides. Faithful
// verification needs the actual built site served (`vitepress preview`), which is
// exactly what the standalone Playwright runner does.
//
// Run the real eval (headed, real 3B WebLLM on WebGPU, ~1.6GB first-run download):
//   npm run document            # build dist + REPL bundle + docs site
//   npx jiti bin/ask_adk_eval.ts
//
// Pass criterion: >=10/12 questions satisfy their assertions AND both multi-turn
// questions pass. See bin/ask_adk_eval.ts for the question set and assertions.
//
// History: this file previously contained stub `it` bodies (`expect(true)`) that
// passed without ever loading the model — a no-op that read as a real eval. They
// have been removed in favour of the runner above so nothing here gives false
// confidence.

import { describe, it, expect } from 'vitest'

describe('Ask ADK end-to-end eval (pointer)', () => {
  it('documents where the real eval lives', () => {
    // This is a signpost, not the eval. The genuine end-to-end check is
    // bin/ask_adk_eval.ts (a Playwright runner against the built site).
    expect('bin/ask_adk_eval.ts').toBeTypeOf('string')
  })
})
