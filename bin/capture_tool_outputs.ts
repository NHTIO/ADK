// Capture REAL tool-call / reasoning output from hosted big-only models (via any OpenAI-compatible
// proxy) → committed parser fixtures. The big-only families (`qwen3_coder` per-param XML,
// `gpt_oss`/`harmony_analysis`, `mistral`, large `nemotron`) have no small e2e model in the matrix;
// instead of hand-written synthetic fixtures, we capture the model's RAW assistant text (native
// format, PRE-parse) and bake it into tests/_fixtures/captured_tool_outputs.
//
// NOT run in CI — a dev tool to refresh fixtures. No hard-coded creds or base URL: pass --base-url and
// --api-key (or env CAPTURE_BASE_URL / CAPTURE_API_KEY). The committed captures are the offline test
// inputs that `tool_parsers.cross.spec.ts` runs the relevant parser against.
//
//   npx jiti bin/capture_tool_outputs.ts --model qwen3-coder-next --family qwen3_coder \
//     --base-url https://your-proxy.example/v1 --api-key "$CAPTURE_API_KEY"
//   npx jiti bin/capture_tool_outputs.ts --model gpt-oss --family gpt_oss --capture reasoning

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { input } from '@inquirer/prompts'
import { isError } from '../src/lib/utils/guards'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

interface Flags {
  model?: string
  family?: string
  capture: 'tool' | 'reasoning'
  baseUrl?: string
  apiKey?: string
  out?: string
  prompt?: string
  help?: boolean
}

const parse = (): Flags => {
  const { values } = parseArgs({
    options: {
      'model': { type: 'string' },
      'family': { type: 'string' },
      'capture': { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      'out': { type: 'string' },
      'prompt': { type: 'string' },
      'help': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return {
    model: values.model as string | undefined,
    family: values.family as string | undefined,
    capture: ((values.capture as string) ?? 'tool') as 'tool' | 'reasoning',
    baseUrl: (values['base-url'] as string) ?? process.env.CAPTURE_BASE_URL,
    apiKey: (values['api-key'] as string) ?? process.env.CAPTURE_API_KEY,
    out: values.out as string | undefined,
    prompt: values.prompt as string | undefined,
    help: values.help as boolean | undefined,
  }
}

const HELP = `capture_tool_outputs — bake REAL big-model output into parser fixtures

  --model    <id>              Hosted model id on the proxy (required)
  --family   <name>            Parser family tag (qwen3_coder|gpt_oss|mistral|nemotron|…) (required)
  --capture  <tool|reasoning>  What to elicit (default: tool)
  --base-url <url>             Proxy base URL (or env CAPTURE_BASE_URL) — OpenAI-compatible /v1
  --api-key  <key>             API key (or env CAPTURE_API_KEY)
  --prompt   <text>            Override the eliciting prompt
  --out      <file>            Output JSON (default: tests/_fixtures/captured_tool_outputs/<family>.json)
  --help                       This help

No creds or URL are hard-coded. The committed JSON is the offline test input.
`

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'The city name.' } },
        required: ['city'],
      },
    },
  },
]

const toolPrompt = 'What is the weather in Paris right now? Use the get_weather tool to find out.'
const reasoningPrompt =
  'Think step by step and show your full reasoning before answering: a train travels 60 km in 45 minutes — what is its speed in km/h?'

const main = async (): Promise<void> => {
  const flags = parse()
  if (flags.help) {
    console.log(HELP)
    return
  }

  const model = flags.model ?? (await input({ message: 'Hosted model id:' }))
  const family = flags.family ?? (await input({ message: 'Parser family tag:' }))
  const baseUrl =
    flags.baseUrl ?? (await input({ message: 'Proxy base URL (OpenAI-compatible /v1):' }))
  const apiKey = flags.apiKey ?? (await input({ message: 'API key:' }))

  if (!model || !family || !baseUrl || !apiKey) {
    console.error('✗ --model, --family, --base-url and --api-key are all required.')
    process.exit(1)
  }

  const isTool = flags.capture === 'tool'
  const prompt = flags.prompt ?? (isTool ? toolPrompt : reasoningPrompt)

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
    temperature: 0,
    // For tool capture, include tool defs so the model emits its NATIVE tool-call format. We read the
    // RAW message content (+ any structured tool_calls) and store both — the parser is tested against
    // whichever carries the native text.
    ...(isTool ? { tools: TOOL_DEFS } : {}),
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  console.log(`→ POST ${url}  (model=${model}, capture=${flags.capture})`)

  let json: Record<string, unknown>
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.error(`✗ HTTP ${res.status}: ${await res.text()}`)
      process.exit(1)
    }
    json = (await res.json()) as Record<string, unknown>
  } catch (err) {
    console.error(`✗ request failed: ${isError(err) ? err.message : String(err)}`)
    process.exit(1)
  }

  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const rawText = (message?.content as string | null) ?? ''
  const structuredToolCalls = message?.tool_calls ?? null
  const reasoning = (message?.reasoning ?? message?.reasoning_content ?? null) as string | null

  const outPath = resolve(flags.out ?? `tests/_fixtures/captured_tool_outputs/${family}.json`)
  mkdirSync(resolve(outPath, '..'), { recursive: true })

  // Merge into an existing file if present (one file may hold tool + reasoning captures).
  const prior = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>)
    : {}

  const record = {
    ...prior,
    family,
    model,
    captures: {
      ...((prior.captures as Record<string, unknown> | undefined) ?? {}),
      [flags.capture]: {
        prompt,
        rawText,
        structuredToolCalls,
        reasoning,
        capturedFrom: 'openai-compatible-proxy',
      },
    },
  }

  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`✓ wrote ${outPath}`)
  console.log(`  rawText (first 300): ${JSON.stringify(rawText).slice(0, 300)}`)
  if (structuredToolCalls) console.log(`  + structured tool_calls captured`)
  if (reasoning) console.log(`  + reasoning field captured`)
}

main().catch((err: unknown) => {
  console.error(`✗ capture_tool_outputs failed: ${isError(err) ? err.message : String(err)}`)
  process.exit(1)
})
