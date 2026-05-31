#!/usr/bin/env node
import { z } from 'zod/v4'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { assemblyGuidance, findDocument, loadCorpus, searchCorpus } from './corpus'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpCorpusDocument } from './corpus'

const corpus = loadCorpus()

const text = (value: string) => ({
  content: [
    {
      type: 'text' as const,
      text: value,
    },
  ],
})

const resourceContents = (document: McpCorpusDocument) => ({
  contents: [
    {
      uri: document.uri,
      name: document.title,
      title: document.title,
      mimeType: 'text/markdown',
      text: document.content,
    },
  ],
})

const renderSearchResults = (query: string, results: ReturnType<typeof searchCorpus>) => {
  if (!results.length) return `No ADK documentation matches found for: ${query}`
  return results
    .map(({ document, score, excerpt }, index) =>
      [
        `## ${index + 1}. ${document.title}`,
        `- id: ${document.id}`,
        `- uri: ${document.uri}`,
        `- kind: ${document.kind}`,
        `- path: ${document.path}`,
        `- score: ${score}`,
        '',
        excerpt,
      ].join('\n')
    )
    .join('\n\n')
}

const reviewAssembly = (input: string) => {
  const checks = [
    {
      label: 'TurnRunner configured',
      pass: /TurnRunner|createTurnRunner|runner\.run/u.test(input),
      advice:
        'Create a TurnRunner with explicit storage callbacks, executor, pipelines, and listeners.',
    },
    {
      label: 'Executor terminal signal',
      pass: /\.ack\(|\.nack\(/u.test(input),
      advice: 'Every custom executor must call exactly one of ctx.ack() or ctx.nack(error).',
    },
    {
      label: 'Storage callback surface',
      pass: /fetchMessagesCallback/u.test(input) && /writeMessageCallback/u.test(input),
      advice:
        'Provide the complete storage callback surface, even when callbacks are no-ops for a prototype.',
    },
    {
      label: 'Message hydration',
      pass: /turnInputPipeline|hydrate/i.test(input),
      advice:
        'Hydrate prior messages in turnInputPipeline; RawTurnContext should not carry history directly.',
    },
    {
      label: 'Tool registry wiring',
      pass: /ToolRegistry|tools\s*:/u.test(input),
      advice:
        'Register tools through ToolRegistry or the runner config; do not invent ToolRegistry.fromTools.',
    },
    {
      label: 'Iteration guard',
      pass: /iteration/u.test(input),
      advice: 'Add a dispatch/turn pipeline guard when tool calls or recursive dispatch can loop.',
    },
  ]
  const lines = ['# ADK Assembly Review', '']
  for (const check of checks) {
    lines.push(
      `- ${check.pass ? '✅' : '⚠️'} ${check.label}: ${check.pass ? 'found' : check.advice}`
    )
  }
  lines.push(
    '',
    '## Relevant Guidance',
    '',
    assemblyGuidance(corpus, 'assembly storage executor pipelines')
  )
  return lines.join('\n')
}

const server = new McpServer(
  {
    name: '@nhtio/adk',
    version: corpus.packageVersion,
  },
  {
    instructions:
      'Portable ADK assembly guidance and offline documentation search for @nhtio/adk. Use the tools to search docs, read resources, inspect API markdown, and review pasted ADK assembly code.',
  }
)

server.registerResource(
  'adk-documents',
  new ResourceTemplate('adk://{section}/{path*}', {
    list: () => ({
      resources: corpus.documents.map((document) => ({
        uri: document.uri,
        name: document.id,
        title: document.title,
        description: `${document.kind}: ${document.path}`,
        mimeType: 'text/markdown',
      })),
    }),
  }),
  {
    title: 'ADK Packaged Documentation',
    description:
      'Version-aligned @nhtio/adk skill, docs, API, and changelog markdown packaged with npm.',
    mimeType: 'text/markdown',
  },
  (uri) => {
    const document = findDocument(corpus, uri.toString())
    if (!document) throw new Error(`Unknown ADK resource: ${uri.toString()}`)
    return resourceContents(document)
  }
)

server.registerTool(
  'get_adk_assembly_guidance',
  {
    title: 'Get ADK Assembly Guidance',
    description: 'Return curated ADK assembly Skill guidance, optionally focused by topic.',
    inputSchema: {
      topic: z
        .string()
        .optional()
        .describe(
          'Optional topic such as storage, executor, pipelines, tools, memory, or first integration.'
        ),
    },
  },
  ({ topic }) => text(assemblyGuidance(corpus, topic))
)

server.registerTool(
  'search_adk_docs',
  {
    title: 'Search ADK Docs',
    description:
      'Lexically search packaged @nhtio/adk skill, documentation, API markdown, and changelog.',
    inputSchema: {
      query: z.string().min(2),
      limit: z.number().int().min(1).max(25).optional(),
      kind: z.enum(['all', 'skill', 'skill-reference', 'doc', 'api', 'changelog']).optional(),
    },
  },
  ({ query, limit, kind }) =>
    text(renderSearchResults(query, searchCorpus(corpus, query, limit ?? 8, kind)))
)

server.registerTool(
  'read_adk_doc',
  {
    title: 'Read ADK Doc',
    description: 'Read a packaged ADK document by id, URI, or repository-relative path.',
    inputSchema: {
      id: z.string().describe('Document id, adk:// URI, or path such as docs/quickstart.md.'),
    },
  },
  ({ id }) => {
    const document = findDocument(corpus, id)
    if (!document) return text(`Unknown ADK document: ${id}`)
    return text(`# ${document.title}\n\n${document.content}`)
  }
)

server.registerTool(
  'lookup_adk_api',
  {
    title: 'Lookup ADK API',
    description: 'Search generated TypeDoc API markdown packaged with @nhtio/adk.',
    inputSchema: {
      symbol: z.string().min(1).describe('API symbol or concept to find.'),
      limit: z.number().int().min(1).max(15).optional(),
    },
  },
  ({ symbol, limit }) =>
    text(renderSearchResults(symbol, searchCorpus(corpus, symbol, limit ?? 6, 'api')))
)

server.registerTool(
  'review_adk_assembly',
  {
    title: 'Review ADK Assembly',
    description:
      'Review pasted ADK assembly/configuration code against the ADK assembly checklist.',
    inputSchema: {
      code: z
        .string()
        .min(1)
        .describe('Pasted ADK setup, TurnRunner config, executor, or related code.'),
    },
  },
  ({ code }) => text(reviewAssembly(code))
)

server.registerPrompt(
  'assemble-adk-agent',
  {
    title: 'Assemble an ADK Agent',
    description: 'Guide an LLM through creating a minimal, correct @nhtio/adk integration.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Use get_adk_assembly_guidance first, then help assemble a minimal @nhtio/adk TurnRunner integration with storage callbacks, hydration, executor, and a smoke test.',
        },
      },
    ],
  })
)

server.registerPrompt(
  'review-adk-agent',
  {
    title: 'Review an ADK Agent',
    description: 'Review pasted ADK integration code for assembly mistakes.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Ask for the ADK assembly code, then call review_adk_assembly and explain the highest-risk issues first.',
        },
      },
    ],
  })
)

server.registerPrompt(
  'debug-adk-assembly',
  {
    title: 'Debug ADK Assembly',
    description: 'Debug common @nhtio/adk wiring failures.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Use search_adk_docs for the observed error, then check storage callback arity, ack/nack behavior, hydration, pipeline placement, and tool registry wiring.',
        },
      },
    ],
  })
)

const main = async () => {
  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
