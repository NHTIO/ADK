import { remark } from 'remark'
import { visit } from 'unist-util-visit'
import { load as yamlLoad } from 'js-yaml'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../utils/guards'
import { ArtifactTool } from './artifact_tool'
import { ToolRegistry } from './tool_registry'
import { default as remarkGfm } from 'remark-gfm'
import { toString as mdastToString } from 'mdast-util-to-string'
import { default as remarkFrontmatter } from 'remark-frontmatter'
import { SpooledArtifact, defaultSerialise } from './spooled_artifact'
import type { Root, Link, Image } from 'mdast'
import type { SpoolReader } from '../contracts/spool_reader'
import type { ToolMethodDescriptor } from './spooled_artifact'
import type { DispatchContext } from '../contracts/dispatch_context'

/**
 * A single heading entry in the document's structural index.
 *
 * @remarks
 * `startLine` is the 0-based line of the heading itself. `endLine` is the 0-based index of the
 * last line belonging to this section (inclusive) — the line immediately before the next heading
 * of equal or lesser depth, or the last line of the document.
 */
export interface MarkdownHeadingEntry {
  /** ATX heading depth: 1 (`#`) through 6 (`######`). */
  depth: 1 | 2 | 3 | 4 | 5 | 6
  /** The heading text with the leading `#` prefix stripped and trimmed. */
  text: string
  /** 0-based line index of the heading line itself. */
  startLine: number
  /** 0-based line index of the last line in this section (inclusive). */
  endLine: number
}

/**
 * A single fenced code block entry in the document's structural index.
 */
export interface MarkdownCodeEntry {
  /** The language identifier immediately after the opening fence, or `null` when absent. */
  lang: string | null
  /** 0-based line index of the opening fence line. */
  startLine: number
  /** 0-based line index of the closing fence line. */
  endLine: number
}

interface MarkdownIndex {
  headings: MarkdownHeadingEntry[]
  codeBlocks: MarkdownCodeEntry[]
}

/**
 * A section of a markdown document as returned by {@link SpooledMarkdownArtifact.md_sections}.
 *
 * @remarks
 * Contains only line-range metadata — no content is fetched until the caller explicitly
 * requests it via `cat(bodyStartLine, bodyEndLine + 1)`.
 */
export interface MarkdownSection {
  depth: 1 | 2 | 3 | 4 | 5 | 6
  /** The heading text. */
  heading: string
  /** 0-based line of the heading itself. */
  headingLine: number
  /** 0-based line of the first body line (heading line + 1). */
  bodyStartLine: number
  /** 0-based line of the last body line (inclusive). */
  bodyEndLine: number
}

/**
 * Returns a configured remark processor with frontmatter and GFM support.
 */
function processor() {
  return remark().use(remarkFrontmatter).use(remarkGfm)
}

/**
 * Parses a heading line (e.g. `## My Heading`) and returns `{ depth, text }`, or `null` when
 * the line is not an ATX heading.
 */
function parseHeadingLine(line: string): { depth: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line)
  if (!match) return null
  const depth = match[1].length as 1 | 2 | 3 | 4 | 5 | 6
  return { depth, text: match[2].trim() }
}

/**
 * Returns the length of a fence marker at the start of `line` (3+), or `0` if the line is not
 * a fence opener/closer. Handles both backtick (` ``` `) and tilde (`~~~`) fences.
 */
function fenceLength(line: string): number {
  const trimmed = line.trimStart()
  const match = /^(`{3,}|~{3,})/.exec(trimmed)
  return match ? match[1].length : 0
}

/**
 * Extracts the language identifier from a fence opener line (e.g. ` ```ts ` → `'ts'`), or
 * `null` when none is present.
 */
function fenceLang(line: string): string | null {
  const trimmed = line.trimStart()
  const match = /^(?:`{3,}|~{3,})(\S+)/.exec(trimmed)
  return match ? match[1] : null
}

/**
 * A {@link @nhtio/adk!SpooledArtifact} specialisation that adds markdown-aware structural queries.
 *
 * @remarks
 * Designed for large markdown documents where loading the full content into memory is
 * impractical. The structural index (heading positions, code block positions) is built by a
 * single line-by-line scan of the {@link @nhtio/adk!SpoolReader} without retaining any content. Only the
 * tiny metadata index and the parsed frontmatter object are cached.
 *
 * Content retrieval is always bounded — use `cat(start, end)` or the `startLine`/`endLine`
 * parameters on inline methods to fetch only the lines you need.
 *
 * Inline methods (`md_links`, `md_images`, `md_text`, `md_ast`) accept optional line-range
 * arguments. Without a range they read the full document — documented trade-off, caller
 * responsibility to bound the range for large documents.
 *
 * The processor always applies `remark-gfm` (tables, task lists, strikethrough, autolinks)
 * in addition to standard CommonMark and YAML frontmatter.
 */
export class SpooledMarkdownArtifact extends SpooledArtifact {
  #index: MarkdownIndex | undefined
  #frontmatter: Record<string, unknown> | null | undefined

  /**
   * @param reader - The backing store to read from.
   */
  constructor(reader: SpoolReader) {
    super(reader)
  }

  /**
   * Returns `true` if `value` is a {@link SpooledMarkdownArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard: `instanceof` first, then
   * `Symbol.hasInstance`, then a `constructor.name` fallback. Matches the pattern used by every
   * other class guard in the ADK; safe against the dual-module-copy case where two distinct
   * `SpooledMarkdownArtifact` classes coexist in the same realm.
   */
  public static isSpooledMarkdownArtifact(value: unknown): value is SpooledMarkdownArtifact {
    return isInstanceOf(value, 'SpooledMarkdownArtifact', SpooledMarkdownArtifact)
  }

  /**
   * The markdown-specific artifact-query descriptors this class adds on top of the base set.
   *
   * @remarks
   * Lists `artifact_md_frontmatter`, `artifact_md_headings`, `artifact_md_code_blocks`,
   * `artifact_md_sections`, `artifact_md_links`, `artifact_md_images`, `artifact_md_text`,
   * `artifact_md_ast`. The base seven descriptors (`artifact_head`, etc.) are NOT included
   * here — they are forged separately by {@link SpooledMarkdownArtifact.forgeTools}, which
   * calls `SpooledArtifact.forgeTools(ctx)` to produce the base-narrowed tools and then
   * registers its own markdown tools on the result. Downstream consumers building custom
   * subclasses should follow the same pattern: own only your own descriptors; override
   * `forgeTools` to compose with the base output.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_md_frontmatter',
      method: 'md_frontmatter',
      description:
        'Return parsed YAML frontmatter (or undefined) from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_md_headings',
      method: 'md_headings',
      description:
        'Return all headings, optionally filtered by depth, from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        depth: validator
          .number()
          .integer()
          .min(1)
          .max(6)
          .optional()
          .description('ATX heading depth (1-6).'),
      }),
    },
    {
      name: 'artifact_md_code_blocks',
      method: 'md_code_blocks',
      description:
        'Return all fenced code block entries, optionally filtered by language, from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        lang: validator
          .string()
          .optional()
          .description('Language identifier. Pass empty string to match blocks with no lang.'),
      }),
    },
    {
      name: 'artifact_md_sections',
      method: 'md_sections',
      description:
        'Return document sections (line-range metadata only) from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        depth: validator
          .number()
          .integer()
          .min(1)
          .max(6)
          .optional()
          .description('ATX heading depth (1-6).'),
      }),
    },
    {
      name: 'artifact_md_links',
      method: 'md_links',
      description:
        'Return all inline and reference links within the given line range from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        startLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('Start line (inclusive).'),
        endLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('End line (exclusive).'),
      }),
    },
    {
      name: 'artifact_md_images',
      method: 'md_images',
      description:
        'Return all images within the given line range from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        startLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('Start line (inclusive).'),
        endLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('End line (exclusive).'),
      }),
    },
    {
      name: 'artifact_md_text',
      method: 'md_text',
      description:
        'Return plain text with markup stripped, for the given line range, from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        startLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('Start line (inclusive).'),
        endLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('End line (exclusive).'),
      }),
    },
    {
      name: 'artifact_md_ast',
      method: 'md_ast',
      description:
        'Return the full MDAST Root for the specified line range from a markdown artifact produced earlier in this turn.',
      argsSchema: validator.object({
        startLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('Start line (inclusive).'),
        endLine: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('End line (exclusive).'),
      }),
    },
  ])

  /**
   * Forges base-class tools plus markdown-specific tools narrowed to
   * {@link SpooledMarkdownArtifact}.
   *
   * @remarks
   * Standard subclass extension pattern: call `SpooledArtifact.forgeTools(ctx)` to produce
   * the base seven `artifact_*` tools narrowed to any `SpooledArtifact` in the turn, then
   * register one `ArtifactTool` per markdown-specific descriptor narrowed to markdown
   * artifacts. Downstream consumers building their own subclasses should follow the same
   * shape.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledMarkdownArtifact
    const compatibleIds = [...ctx.turnToolCalls]
      .filter((tc) => !tc.fromArtifactTool && isInstanceOf(tc.results, requires.name, requires))
      .map((tc) => tc.id)
    if (compatibleIds.length === 0) return registry

    for (const descriptor of this.toolMethods) {
      const callIdSchema = validator
        .string()
        .valid(...compatibleIds)
        .required()
        .description('ToolCall id of the artifact to query.')

      const argsSchema = (
        descriptor.argsSchema ?? validator.object<Record<string, never>>({})
      ).append({
        callId: callIdSchema,
      })

      const tool = new ArtifactTool({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: argsSchema,
        ephemeral: true,
        onCollision: 'replace',
        handler: async (rawArgs, ctxInner) => {
          const args = rawArgs as Record<string, unknown> & { callId: string }
          const tc = [...ctxInner.turnToolCalls].find((t) => t.id === args.callId)
          if (!tc) {
            return `Error: no tool call with id ${args.callId} in this turn`
          }
          const artifact = tc.results
          if (!isInstanceOf(artifact, requires.name, requires)) {
            return `Error: tool call ${args.callId} results are not a ${requires.name} instance`
          }
          const methodArgs: unknown[] = []
          if (descriptor.method === 'md_headings' || descriptor.method === 'md_sections') {
            methodArgs.push(args.depth as number | undefined)
          } else if (descriptor.method === 'md_code_blocks') {
            methodArgs.push(args.lang as string | undefined)
          } else if (
            descriptor.method === 'md_links' ||
            descriptor.method === 'md_images' ||
            descriptor.method === 'md_text' ||
            descriptor.method === 'md_ast'
          ) {
            methodArgs.push(
              args.startLine as number | undefined,
              args.endLine as number | undefined
            )
          }
          const fn = (artifact as unknown as Record<string, (...a: unknown[]) => unknown>)[
            descriptor.method
          ]
          if (typeof fn !== 'function') {
            return `Error: artifact has no method ${descriptor.method}`
          }
          const result = await Promise.resolve(fn.apply(artifact, methodArgs))
          const serialise = descriptor.serialise ?? defaultSerialise
          return serialise(result)
        },
      })
      registry.register(tool)
    }
    return registry
  }

  /**
   * Builds the structural index in a single top-to-bottom pass, retaining only metadata.
   */
  async #resolveIndex(): Promise<MarkdownIndex> {
    if (this.#index !== undefined) return this.#index

    const count = await this.lineCount()
    const headingsRaw: Array<{ depth: 1 | 2 | 3 | 4 | 5 | 6; text: string; startLine: number }> = []
    const codeBlocks: MarkdownCodeEntry[] = []

    let inFrontmatter = false
    let frontmatterClosed = false
    let inCodeBlock = false
    let openFenceLen = 0
    let openFenceStartLine = 0
    let openFenceLang: string | null = null

    for (let i = 0; i < count; i++) {
      const rawLine = await this.line(i)
      const l = rawLine ?? ''

      // Handle frontmatter block at the top of the document
      if (i === 0 && l.trim() === '---') {
        inFrontmatter = true
        continue
      }
      if (inFrontmatter) {
        if (l.trim() === '---') {
          inFrontmatter = false
          frontmatterClosed = true
        }
        continue
      }
      if (!frontmatterClosed && i === 0) {
        // No frontmatter — treat as normal document from the start
      }

      // Handle fenced code blocks
      const fLen = fenceLength(l)
      if (!inCodeBlock && fLen >= 3) {
        inCodeBlock = true
        openFenceLen = fLen
        openFenceStartLine = i
        openFenceLang = fenceLang(l)
        continue
      }
      if (inCodeBlock) {
        // A closing fence must use the same fence character (` or ~) and be at least as long.
        if (fLen >= openFenceLen) {
          const openLine = (await this.line(openFenceStartLine)) ?? ''
          const openChar = openLine.trimStart()[0]
          const closeChar = l.trimStart()[0]
          if (closeChar === openChar) {
            codeBlocks.push({ lang: openFenceLang, startLine: openFenceStartLine, endLine: i })
            inCodeBlock = false
            openFenceLen = 0
          }
        }
        continue
      }

      // Detect ATX headings (not inside code blocks, not in frontmatter)
      const heading = parseHeadingLine(l)
      if (heading) {
        headingsRaw.push({ ...heading, startLine: i })
      }
    }

    // Unclosed code block — record it anyway
    if (inCodeBlock) {
      codeBlocks.push({ lang: openFenceLang, startLine: openFenceStartLine, endLine: count - 1 })
    }

    // Post-process heading endLine values
    const headings: MarkdownHeadingEntry[] = headingsRaw.map((h, idx) => {
      const nextBoundary = headingsRaw.slice(idx + 1).find((n) => n.depth <= h.depth)
      const endLine = nextBoundary ? nextBoundary.startLine - 1 : count - 1
      return { ...h, endLine }
    })

    this.#index = { headings, codeBlocks }
    return this.#index
  }

  // ── Frontmatter ───────────────────────────────────────────────────────────

  /**
   * Returns the parsed YAML frontmatter, or `undefined` when no frontmatter block is present.
   *
   * @remarks
   * Short-circuits after reading the frontmatter block — never reads the document body. Caches
   * the result so subsequent calls are free. The result is `undefined` (not an empty object)
   * when no frontmatter is found, distinguishing "no frontmatter" from "empty frontmatter".
   */
  async md_frontmatter(): Promise<Record<string, unknown> | undefined> {
    if (this.#frontmatter !== undefined) return this.#frontmatter ?? undefined

    const firstLine = await this.line(0)
    if (firstLine?.trim() !== '---') {
      this.#frontmatter = null
      return undefined
    }

    const maxScan = Math.min(await this.lineCount(), 200)
    const yamlLines: string[] = []
    let closed = false
    for (let i = 1; i < maxScan; i++) {
      const l = await this.line(i)
      if (l?.trim() === '---') {
        closed = true
        break
      }
      yamlLines.push(l ?? '')
    }

    if (!closed) {
      this.#frontmatter = null
      return undefined
    }

    this.#frontmatter = yamlLoad(yamlLines.join('\n')) as Record<string, unknown>
    return this.#frontmatter
  }

  // ── Structural index queries ──────────────────────────────────────────────

  /**
   * Returns all headings in document order, optionally filtered by depth.
   *
   * @remarks
   * Uses the cached structural index — no content is fetched from the {@link @nhtio/adk!SpoolReader}.
   *
   * @param depth - When provided, only headings at this ATX depth (1–6) are returned.
   */
  async md_headings(depth?: 1 | 2 | 3 | 4 | 5 | 6): Promise<MarkdownHeadingEntry[]> {
    const index = await this.#resolveIndex()
    if (depth === undefined) return index.headings.slice()
    return index.headings.filter((h) => h.depth === depth)
  }

  /**
   * Returns all fenced code block entries, optionally filtered by language identifier.
   *
   * @remarks
   * Returns line-range metadata only — no content is fetched. Use `cat(entry.startLine + 1,
   * entry.endLine)` to retrieve the code body (excluding fence lines).
   *
   * @param lang - When provided, only blocks with this exact lang identifier are returned.
   *   Pass an empty string to match blocks with no lang identifier.
   */
  async md_code_blocks(lang?: string): Promise<MarkdownCodeEntry[]> {
    const index = await this.#resolveIndex()
    if (lang === undefined) return index.codeBlocks.slice()
    const target = lang === '' ? null : lang
    return index.codeBlocks.filter((b) => b.lang === target)
  }

  /**
   * Returns document sections derived from the structural index.
   *
   * @remarks
   * Returns only line-range metadata — body content is never fetched. To retrieve the body of a
   * section, call `cat(section.bodyStartLine, section.bodyEndLine + 1)`.
   *
   * When `depth` is provided, only sections introduced by a heading at that depth are returned;
   * deeper headings become part of the body.
   *
   * @param depth - When provided, only sections at this ATX depth (1–6) are returned.
   */
  async md_sections(depth?: 1 | 2 | 3 | 4 | 5 | 6): Promise<MarkdownSection[]> {
    const index = await this.#resolveIndex()
    const headings =
      depth !== undefined ? index.headings.filter((h) => h.depth === depth) : index.headings
    return headings.map((h) => ({
      depth: h.depth,
      heading: h.text,
      headingLine: h.startLine,
      bodyStartLine: h.startLine + 1,
      bodyEndLine: h.endLine,
    }))
  }

  // ── Inline queries (bounded) ──────────────────────────────────────────────

  /**
   * Returns the full MDAST Root for the specified line range.
   *
   * @remarks
   * Without a range, reads the full document — for large documents, use
   * {@link SpooledMarkdownArtifact.md_sections} to locate sections and pass
   * bounded line ranges here.
   *
   * @param startLine - 0-based start line (inclusive). Defaults to `0`.
   * @param endLine - 0-based end line (exclusive). Defaults to `lineCount()`.
   */
  async md_ast(startLine?: number, endLine?: number): Promise<Root> {
    const lines = await this.cat(startLine, endLine)
    return processor().parse(lines.join('\n')) as Root
  }

  /**
   * Returns all inline and reference links in the specified line range.
   *
   * @param startLine - 0-based start line (inclusive). Defaults to `0`.
   * @param endLine - 0-based end line (exclusive). Defaults to `lineCount()`.
   */
  async md_links(
    startLine?: number,
    endLine?: number
  ): Promise<Array<{ text: string; url: string; title?: string }>> {
    const lines = await this.cat(startLine, endLine)
    const ast = processor().parse(lines.join('\n'))
    const results: Array<{ text: string; url: string; title?: string }> = []
    visit(ast, 'link', (node: Link) => {
      results.push({
        text: mdastToString(node),
        url: node.url,
        title: node.title ?? undefined,
      })
    })
    return results
  }

  /**
   * Returns all images in the specified line range.
   *
   * @param startLine - 0-based start line (inclusive). Defaults to `0`.
   * @param endLine - 0-based end line (exclusive). Defaults to `lineCount()`.
   */
  async md_images(
    startLine?: number,
    endLine?: number
  ): Promise<Array<{ alt: string; url: string; title?: string }>> {
    const lines = await this.cat(startLine, endLine)
    const ast = processor().parse(lines.join('\n'))
    const results: Array<{ alt: string; url: string; title?: string }> = []
    visit(ast, 'image', (node: Image) => {
      results.push({
        alt: node.alt ?? '',
        url: node.url,
        title: node.title ?? undefined,
      })
    })
    return results
  }

  /**
   * Returns all document text with markup stripped, for the specified line range.
   *
   * @remarks
   * Uses `mdast-util-to-string` to extract plain text from the AST — code, link text, and
   * alt text are included; markdown syntax is removed.
   *
   * @param startLine - 0-based start line (inclusive). Defaults to `0`.
   * @param endLine - 0-based end line (exclusive). Defaults to `lineCount()`.
   */
  async md_text(startLine?: number, endLine?: number): Promise<string> {
    const lines = await this.cat(startLine, endLine)
    const ast = processor().parse(lines.join('\n'))
    return mdastToString(ast)
  }
}
