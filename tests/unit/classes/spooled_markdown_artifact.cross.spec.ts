import { describe, expect, it } from 'vitest'
import { ArtifactTool } from '../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import { E_INVALID_TOOL_ARGS } from '../../../src/lib/exceptions/runtime'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../_fixtures/primitives'
import { SpooledMarkdownArtifact } from '../../../src/lib/classes/spooled_markdown_artifact'

const MD_WITH_FRONTMATTER = [
  '---',
  'title: hello',
  'tags:',
  '  - foo',
  '  - bar',
  '---',
  '',
  '# Top heading',
  '',
  'Some intro text with a [link](https://example.com).',
  '',
  '## Subsection',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '![alt text](https://example.com/img.png)',
  '',
  '# Another top heading',
  '',
  'More content.',
].join('\n')

const MD_NO_FRONTMATTER = [
  '# Title',
  '',
  'paragraph one',
  '',
  '## Section A',
  '',
  '```python',
  'print("hi")',
  '```',
  '',
  '## Section B',
  '',
  'paragraph two',
].join('\n')

const make = (content: string) => new SpooledMarkdownArtifact(new InMemorySpoolReader(content))

describe('SpooledMarkdownArtifact', () => {
  describe('md_frontmatter', () => {
    it('parses YAML frontmatter when present', async () => {
      const fm = await make(MD_WITH_FRONTMATTER).md_frontmatter()
      expect(fm).toBeDefined()
      expect((fm as { title: string }).title).toBe('hello')
      expect((fm as { tags: string[] }).tags).toEqual(['foo', 'bar'])
    })

    it('returns undefined when no frontmatter is present', async () => {
      const fm = await make(MD_NO_FRONTMATTER).md_frontmatter()
      expect(fm).toBeUndefined()
    })

    it('caches the parsed result across calls', async () => {
      const a = make(MD_WITH_FRONTMATTER)
      const first = await a.md_frontmatter()
      const second = await a.md_frontmatter()
      expect(first).toBe(second)
    })
  })

  describe('md_headings', () => {
    it('returns all headings in document order', async () => {
      const headings = await make(MD_NO_FRONTMATTER).md_headings()
      expect(headings.map((h) => h.text)).toEqual(['Title', 'Section A', 'Section B'])
    })

    it('filters by depth when provided', async () => {
      const headings = await make(MD_NO_FRONTMATTER).md_headings(2)
      expect(headings.map((h) => h.text)).toEqual(['Section A', 'Section B'])
      expect(headings.every((h) => h.depth === 2)).toBe(true)
    })

    it('skips content inside fenced code blocks (no false-positive ATX headings)', async () => {
      const headings = await make(MD_NO_FRONTMATTER).md_headings(1)
      expect(headings).toHaveLength(1)
    })

    it('records each heading start line as a 0-based index', async () => {
      const headings = await make(MD_NO_FRONTMATTER).md_headings()
      expect(headings[0].startLine).toBe(0)
    })
  })

  describe('md_code_blocks', () => {
    it('returns all fenced code block entries', async () => {
      const blocks = await make(MD_NO_FRONTMATTER).md_code_blocks()
      expect(blocks).toHaveLength(1)
      expect(blocks[0].lang).toBe('python')
    })

    it('filters by language identifier', async () => {
      const blocks = await make(MD_WITH_FRONTMATTER).md_code_blocks('ts')
      expect(blocks).toHaveLength(1)
    })

    it('returns empty array when language does not match', async () => {
      const blocks = await make(MD_NO_FRONTMATTER).md_code_blocks('rust')
      expect(blocks).toHaveLength(0)
    })
  })

  describe('md_sections', () => {
    it('returns line-range metadata only (no body content)', async () => {
      const sections = await make(MD_NO_FRONTMATTER).md_sections()
      expect(sections.length).toBeGreaterThan(0)
      const section = sections[0]
      expect(section.headingLine).toBe(0)
      expect(section.bodyStartLine).toBe(1)
      expect(section.bodyEndLine).toBeGreaterThan(0)
    })

    it('filters by depth when provided', async () => {
      const sections = await make(MD_NO_FRONTMATTER).md_sections(2)
      expect(sections.every((s) => s.depth === 2)).toBe(true)
    })
  })

  describe('md_links', () => {
    it('returns inline links across the document', async () => {
      const links = await make(MD_WITH_FRONTMATTER).md_links()
      expect(links.length).toBeGreaterThan(0)
      expect(links[0].url).toBe('https://example.com')
      expect(links[0].text).toBe('link')
    })

    it('respects line range bounds', async () => {
      const links = await make(MD_WITH_FRONTMATTER).md_links(0, 5)
      // Range is in the frontmatter — should not find any links
      expect(links).toHaveLength(0)
    })
  })

  describe('md_images', () => {
    it('returns image references with alt text and url', async () => {
      const images = await make(MD_WITH_FRONTMATTER).md_images()
      expect(images).toHaveLength(1)
      expect(images[0].alt).toBe('alt text')
      expect(images[0].url).toBe('https://example.com/img.png')
    })
  })

  describe('md_text', () => {
    it('returns plain text with markup stripped', async () => {
      const text = await make(MD_NO_FRONTMATTER).md_text()
      expect(text).toContain('paragraph one')
      expect(text).not.toContain('#')
    })
  })

  describe('md_ast', () => {
    it('returns the MDAST root for the full document by default', async () => {
      const ast = await make(MD_NO_FRONTMATTER).md_ast()
      expect(ast.type).toBe('root')
      expect(Array.isArray(ast.children)).toBe(true)
    })

    it('respects an explicit line range', async () => {
      const a = make(MD_NO_FRONTMATTER)
      const fullAst = await a.md_ast()
      const partialAst = await a.md_ast(0, 1)
      expect(partialAst.children.length).toBeLessThan(fullAst.children.length)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + md_* tools when the turn has a markdown artifact', () => {
      const mdArtifact = make(MD_NO_FRONTMATTER)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(mdArtifact, { id: 'tc-md' })],
      })
      const registry = SpooledMarkdownArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_md_frontmatter',
          'artifact_md_headings',
          'artifact_md_code_blocks',
          'artifact_md_sections',
          'artifact_md_links',
          'artifact_md_images',
          'artifact_md_text',
          'artifact_md_ast',
        ])
      )
      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('restricts artifact_md_* callId enum to markdown artifacts only', async () => {
      const mdArtifact = make(MD_NO_FRONTMATTER)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb\nc', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(mdArtifact, { id: 'tc-md' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledMarkdownArtifact.forgeTools(ctx)
      const mdHeadings = registry.get('artifact_md_headings')!
      const baseHead = registry.get('artifact_head')!
      const mdDump = JSON.stringify(mdHeadings.describe().inputSchema)
      const baseDump = JSON.stringify(baseHead.describe().inputSchema)
      expect(mdDump).toContain('tc-md')
      expect(mdDump).not.toContain('tc-base')
      expect(baseDump).toContain('tc-md')
      expect(baseDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_md_headings at validation time', async () => {
      const mdArtifact = make(MD_NO_FRONTMATTER)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(mdArtifact, { id: 'tc-md' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledMarkdownArtifact.forgeTools(ctx)
      const mdHeadings = registry.get('artifact_md_headings')!
      await expect(mdHeadings.validate({ callId: 'tc-base' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_md_* tools when no markdown artifacts are present', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('a', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledMarkdownArtifact.forgeTools(ctx)
      for (const n of registry.all().map((t) => t.name)) {
        expect(n).not.toMatch(/^artifact_md_/)
      }
    })
  })

  describe('SpooledMarkdownArtifact.isSpooledMarkdownArtifact', () => {
    it('returns true for SpooledMarkdownArtifact instances', () => {
      expect(SpooledMarkdownArtifact.isSpooledMarkdownArtifact(make(MD_NO_FRONTMATTER))).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledMarkdownArtifact.isSpooledMarkdownArtifact({})).toBe(false)
    })
  })
})
