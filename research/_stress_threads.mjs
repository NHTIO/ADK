// STRESS-TEST corpus for the Token Thrift flagship agent — breadth (>=1 Q per authored doc page, ~112 pages)
// woven into MULTI-TURN threads (coref + follow-ups) so it exercises BOTH knowledge breadth AND the
// multi-turn context-window management that is the entire token-thrift thesis. Each thread is a fresh
// conversation; turns within a thread build on each other. ~14 threads, ~112 turns total.
export const STRESS_THREADS = [
  {
    name: 'T1: the loop — one turn, stages, budgets, thrift',
    turns: [
      'What are the five stages of one turn from start to finish, and where does my code plug into each one?',
      'How does an agent loop actually work under the hood, from user input to final response?',
      'Should I send my entire conversation history in every dispatch, or trim it to a focused slice per call?',
      'How do I reduce that context window dynamically without losing the important context?',
      'And how do I stop a large tool output from overflowing the window or blowing up memory?',
      'What actually makes that dispatch loop stop iterating — is there a built-in iteration limit?',
    ],
  },
  {
    name: 'T2: turn runner + pipelines',
    turns: [
      'Why does runner.run() return void instead of the final assistant message?',
      'What four invariants guarantee that turnEnd fires even when something goes wrong in my pipeline?',
      'Why do I have four middleware pipelines instead of just named callbacks?',
      'What convention decides whether retrieval belongs in the turn-input or the dispatch-input pipeline?',
      'Why do my dispatch-scoped middlewares run ten times for a ten-iteration dispatch?',
      'If a middleware forgets to call next(), what happens to the ones that haven’t run yet?',
      'And if middleware throws, do the post-step cleanups still run afterward?',
      'How do I pass state between middlewares without a closure leak, and how is turn stash different from dispatch stash?',
      'How do I intentionally refuse to process a turn without emitting an error event?',
    ],
  },
  {
    name: 'T3: llm-dispatch + executor seam + signalling',
    turns: [
      'Where exactly should I invoke my tool handlers — inside the executor during dispatch, or in middleware afterward?',
      'Why does calling ctx.ack() twice throw instead of being silently idempotent?',
      'What’s the difference between ctx.ack() and ctx.nack(), and why does abort behave differently from an error?',
      'How do errors from my executor callback surface differently standalone vs inside a turn?',
      'Why does reportMessage() without storeMessage() create a message the UI sees but storage doesn’t?',
    ],
  },
  {
    name: 'T4: gates',
    turns: [
      'How do I add a human approval step before a tool executes?',
      'What are the canonical ways gates get used in real agents?',
      'If I open one of those gates and nothing resolves it, will the turn hang forever?',
      'Why did my agent lose a pending approval when the process restarted, and how do I persist gates across deployments?',
      'Can I serialize and deserialize a live gate that’s currently awaiting resolution?',
      'Why doesn’t the ADK just provide a built-in permission check, and where should safety logic actually live?',
    ],
  },
  {
    name: 'T5: primitives',
    turns: [
      'What are the core data primitives the ADK threads through every turn, and what mistake does each prevent?',
      'Can I use a Message primitive for tool results, system instructions, or reasoning traces?',
      'How do I store and replay the model’s reasoning separately from dialogue, including vendor-specific payloads?',
      'How can I know exactly how many tokens a piece of content is worth without calling the provider’s tokenizer API?',
      'What goes into the results field of a tool call, and why does the checksum matter?',
      'How do I keep my internal user IDs separate from the display names the model actually sees?',
      'Why does the framework require confidence and importance scores on memories, and who sets them?',
      'How do I declare where retrieved content came from so the model knows how much to trust it?',
      'And how should I handle images, audio, or documents a tool produces or a user attaches?',
    ],
  },
  {
    name: 'T6: tools',
    turns: [
      'How do I build a tool the model can call, and what’s the difference between returning a string, bytes, or Media?',
      'When should my tool return a string artifact versus Media?',
      'Why does the framework hash my tool arguments before the handler runs, and what breaks if I pass BigInt or undefined?',
      'How do I manage tool visibility so the model discovers tools dynamically instead of seeing the whole list upfront?',
      'What does the trusted flag on a tool do, and why doesn’t it apply to Media results?',
    ],
  },
  {
    name: 'T7: trust tiers + injection defense',
    turns: [
      'How do I prevent prompt-injection attacks coming through retrieved data, tool results, and reasoning traces?',
      'How does the framework use nonce-keyed XML tags to stop an attacker escaping out of content boundaries?',
      'How do I stop someone spoofing another participant’s identity, and protect the model’s reasoning from hijacking?',
      'Why do images and audio need two separate trust dimensions?',
      'How does it defend against an injection that gets into memory or retrieval and only detonates months later?',
    ],
  },
  {
    name: 'T8: artifacts',
    turns: [
      'How do I keep the model from accidentally filling the context window with a massive tool output?',
      'What are the basic query methods on a SpooledArtifact, and when should I use it instead of Media?',
      'How do I create a custom SpooledArtifact subclass with its own query tools?',
      'Why does the callId enum for artifact-query tools go stale between iterations, and how do I prevent capability leaks?',
      'How do those forged artifact-query tools get cleaned up after a dispatch, and what happens if I forget bindContext?',
    ],
  },
  {
    name: 'T9: LLM batteries',
    turns: [
      'Which LLM battery should I use if my model runs in a local Ollama daemon speaking the native /api/chat endpoint?',
      'What generation parameters do I configure differently there versus the OpenAI wire format?',
      'How do I point the OpenAI Chat Completions adapter at a self-hosted proxy instead of the cloud API?',
      'How do I run Gemma on-device in the browser with LiteRT-LM and WebGPU — and what’s the limitation before I try other model families?',
      'What does the shared chat_common contract do to make LiteRT-LM and transformers.js behave identically?',
      'How can I run the same ONNX model in both Node and the browser without rewriting code?',
      'And what’s the hard context-window limit I have to budget against for Llama-3.2-3B under WebLLM?',
    ],
  },
  {
    name: 'T10: vector batteries',
    turns: [
      'How can I write the exact same vector query whether I’m on Postgres pgvector, an in-memory index, or Pinecone?',
      'How many vector backends does the battery support, and what env vars run the integration tests?',
      'What happens if I use transactions on a store that isn’t ACID — does it fake it?',
      'What’s the minimum I implement to add a brand-new backend it doesn’t already ship?',
      'How do I plug my own embedding model in so .nearText() can turn text into vectors?',
      'What does it mean if I leave out the .near*() clause — error, or a different kind of query?',
      'How do I turn a vector store into the four Retrievable callbacks the TurnRunner needs for RAG?',
      'And how do I create a collection and run migrations with the same knex-style API I’d use for SQL?',
    ],
  },
  {
    name: 'T11: media batteries',
    turns: [
      'What’s the core principle behind how the media pipeline handles processing — where do files get processed by default?',
      'What grammar do I teach the model so it can write a pipe statement like select | redact | replace?',
      'If the model makes a mistake in a pipe statement, what does the error tell it so it can self-correct?',
      'How does the pipeline decide which engine to use when several can do the same operation?',
      'Why are mutate and edit separate capabilities instead of one?',
      'Can I let the model pick between a single composite tool and granular multi-tools, and which does the kit recommend?',
      'How do I create brand-new media files from nothing instead of only modifying existing ones?',
      'What’s the difference between visual and content-level PDF redaction, and why can’t you guarantee the SSN is really gone?',
    ],
  },
  {
    name: 'T12: assembly + BYO',
    turns: [
      'How do I get a working ADK agent streaming from OpenAI in just three files?',
      'What does ADK own, and what do I have to provide myself?',
      'How do I write a custom executor to call my own model or provider?',
      'How do I implement the storage callbacks to persist messages and state to my own database — how many are there?',
      'How do I store and retrieve facts the agent learns across conversations?',
      'How do I inject external documents so the model can answer from them?',
      'How do I change the LLM adapter options for a single iteration without recreating the runner?',
      'And where should I actually persist artifact bytes that tools generate, in production?',
    ],
  },
  {
    name: 'T13: tooling batteries + dev tools + showcase',
    turns: [
      'Why use Scrapper instead of driving a real browser myself or just doing a plain HTTP fetch?',
      'How do I configure SearXNG so the model can choose normalized vs raw JSON on each search?',
      'What pre-built tools ship for math, text, data, and time?',
      'How do I give a coding agent access to ADK docs while it helps me build?',
      'What lint rules catch ADK wiring mistakes that TypeScript doesn’t?',
      'Which on-device models actually work with the batteries, and how were they tested?',
      'And how does a 3-billion-parameter model answer questions about ADK from a browser tab?',
    ],
  },
  {
    name: 'T14: coref + capacity stress (deep multi-turn)',
    turns: [
      'What is the core thesis of ADK?',
      'You mentioned trust tiers earlier — remind me how many there are and what the top one protects against?',
      'Between the Ollama battery and the LiteRT one you can run in the browser, which needs a running daemon?',
      'Go back to the four pipelines — which one owns retrieval, and why not the others?',
      'Now tie it together: how do token thrift, artifacts, and the context-window budget all cooperate to keep a small model from overflowing?',
      'Given everything we’ve covered, be exhaustive: walk every trust tier and every battery category with an example each.',
    ],
  },
]
