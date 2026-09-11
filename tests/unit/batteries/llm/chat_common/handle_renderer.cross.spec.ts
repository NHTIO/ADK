import { describe, expect, it } from 'vitest'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { renderArtifactHandleBody } from '../../../../../src/batteries/llm/chat_common/helpers'
import { SpooledMarkdownArtifact } from '../../../../../src/lib/classes/spooled_markdown_artifact'

const expectedNames = [
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

describe('chat-common artifact handle renderer', () => {
  it('advertises markdown methods and all seven base readers', () => {
    const body = renderArtifactHandleBody({
      callId: 'chat-common-md',
      artifact: new SpooledMarkdownArtifact(new InMemorySpoolReader('# heading')),
      byteLength: 9,
      lineCount: 1,
    })
    expect(body.match(/- (artifact_[a-z_]+)/g)).toEqual(
      expect.arrayContaining(expectedNames.map((name) => `- ${name}`))
    )
  })
})
