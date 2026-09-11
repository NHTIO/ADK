import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ToolCall } from '../../../../../src/lib/classes/tool_call'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { renderOllamaToolCallResult } from '../../../../../src/batteries/llm/ollama/helpers'
import { SpooledMarkdownArtifact } from '../../../../../src/lib/classes/spooled_markdown_artifact'

const names = [
  'artifact_md_frontmatter',
  'artifact_md_headings',
  'artifact_md_code_blocks',
  'artifact_md_sections',
  'artifact_md_links',
  'artifact_md_images',
  'artifact_md_text',
  'artifact_md_ast',
  'artifact_head',
  'artifact_tail',
  'artifact_grep',
  'artifact_cat',
  'artifact_byte_length',
  'artifact_line_count',
  'artifact_estimate_tokens',
]

describe('Ollama artifact handle renderer', () => {
  it('advertises markdown methods and all seven base readers', async () => {
    const call = new ToolCall({
      id: 'ollama-md',
      tool: 'read_file',
      args: {},
      checksum: 'ollama-md',
      isComplete: true,
      isError: false,
      results: new SpooledMarkdownArtifact(new InMemorySpoolReader('# heading')),
      inline: false,
      createdAt: DateTime.utc(),
      updatedAt: DateTime.utc(),
      completedAt: DateTime.utc(),
    })
    const body = await renderOllamaToolCallResult({
      toolCall: call,
      results: call.results,
      tool: undefined,
      renderUntrustedContent: (text) => text,
      renderTrustedContent: (text) => text,
      unsupportedMediaPolicy: 'synthetic-description',
    })
    for (const name of names) expect(body).toContain(name)
  })
})
