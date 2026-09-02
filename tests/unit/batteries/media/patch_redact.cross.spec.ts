import { default as JSZip } from 'jszip'
import { describe, expect, it } from 'vitest'
import { createMediaPipeline, MIME } from '../../../../src/batteries/media'
import {
  parseStructuredPatch,
  applyUpdateHunks,
  normalizeWorkspacePath,
} from '../../../../src/lib/patch'
import type { StepPayload } from '../../../../src/batteries/media'

/**
 * The structured apply_patch envelope (the GitHub Copilot dialect), the diff↔apply_patch
 * round-trip contract, and ODF redact/update_text — all in-memory, both projects.
 */

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const textPayload = (content: string, filename = 'note.txt'): StepPayload => ({
  bytes: encode(content),
  mimeType: MIME.TXT,
  filename,
})

describe('structured apply_patch — parser', () => {
  it('parses Add/Delete/Update(+Move) operations', () => {
    const parsed = parseStructuredPatch(
      [
        '*** Begin Patch',
        '*** Add File: docs/new.md',
        '+# Title',
        '+Body',
        '*** Delete File: old.txt',
        '*** Update File: src/index.ts',
        '*** Move to: src/main.ts',
        '@@',
        ' context',
        '-removed',
        '+added',
        '*** End Patch',
      ].join('\n')
    )
    expect(parsed.operations.map((o) => o.type)).toEqual(['add', 'delete', 'update'])
    expect(parsed.added).toBe(3)
    expect(parsed.removed).toBe(1)
    const update = parsed.operations[2] as { movePath?: string }
    expect(update.movePath).toBe('src/main.ts')
  })

  it('rejects traversal paths (absolute, .., empty segments)', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(/relative/)
    expect(() => normalizeWorkspacePath('a/../b')).toThrow(/invalid segment/)
    expect(() => normalizeWorkspacePath('a//b')).toThrow(/invalid segment/)
  })

  it('rejects ambiguous hunk context rather than guessing', () => {
    const text = 'dup\nx\ndup\nx\n'
    expect(() =>
      applyUpdateHunks(text, [
        { oldLines: ['dup', 'x'], newLines: ['edited'], added: 1, removed: 2 },
      ])
    ).toThrow(/ambiguous/)
  })

  it('rejects a hunk that does not apply', () => {
    expect(() =>
      applyUpdateHunks('a\nb\n', [{ oldLines: ['zzz'], newLines: ['y'], added: 1, removed: 1 }])
    ).toThrow(/could not be applied cleanly/)
  })

  // A localized edit must not rewrite every line of a CRLF file. Without the convention-aware
  // join this returns all-LF text, so a one-line change reads as a whole-file diff.
  it('preserves the CRLF convention of the file it edits', () => {
    const out = applyUpdateHunks('a\r\nb\r\nc\r\n', [
      { oldLines: ['b'], newLines: ['edited'], added: 1, removed: 1 },
    ])
    expect(out).toBe('a\r\nedited\r\nc\r\n')
    expect(out).not.toContain('\n\n')
  })

  it('leaves an LF file on LF', () => {
    expect(
      applyUpdateHunks('a\nb\nc\n', [
        { oldLines: ['b'], newLines: ['edited'], added: 1, removed: 1 },
      ])
    ).toBe('a\nedited\nc\n')
  })
})

describe('structured apply_patch — through the pipeline', () => {
  // Multi-line patch content rides the structured ops form (pipe strings exclude raw
  // newlines by grammar — exactly how a model passes a patch through the ops arg too).
  const applyPatch = (mp: Awaited<ReturnType<typeof createMediaPipeline>>) => {
    return (payload: StepPayload, patch: string) =>
      mp.ops(payload, [{ verb: 'apply_patch', args: { patch } }])
  }

  it('updates the primary media in place', async () => {
    const mp = await createMediaPipeline()
    const patch = [
      '*** Begin Patch',
      '*** Update File: note.txt',
      '@@',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n')
    const result = await applyPatch(mp)(textPayload('old line\nkeep\n'), patch)
    expect(result.kind).toBe('media')
    expect(decode((result as { payload: StepPayload }).payload.bytes)).toBe('new line\nkeep\n')
  })

  it('Add File yields a media-list (primary + added)', async () => {
    const mp = await createMediaPipeline()
    const patch = ['*** Begin Patch', '*** Add File: extra.md', '+# Added', '*** End Patch'].join(
      '\n'
    )
    const result = await applyPatch(mp)(textPayload('keep\n'), patch)
    expect(result.kind).toBe('media-list')
    const payloads = (result as { payloads: StepPayload[] }).payloads
    expect(payloads.map((p) => p.filename).sort()).toEqual(['extra.md', 'note.txt'])
    const added = payloads.find((p) => p.filename === 'extra.md')!
    expect(decode(added.bytes)).toBe('# Added')
    expect(added.mimeType).toBe(MIME.MD)
  })

  it('the unified-diff path is untouched (legacy patches keep applying)', async () => {
    const mp = await createMediaPipeline()
    const patch = [
      '--- note.txt',
      '+++ note.txt',
      '@@ -1,1 +1,1 @@',
      '-line one',
      '+line two',
      '',
    ].join('\n')
    const result = await applyPatch(mp)(textPayload('line one\n'), patch)
    expect(decode((result as { payload: StepPayload }).payload.bytes)).toBe('line two\n')
  })

  it('empty:txt | apply_patch — create-then-patch through the data engine', async () => {
    const { dataEngine } = await import('../../../../src/batteries/media/engines/data')
    const mp = await createMediaPipeline({ engines: [dataEngine()] })
    const minted = await mp.capabilities.convert({
      bytes: new Uint8Array(0),
      mimeType: 'application/x-adk-empty',
      filename: 'untitled',
      to: 'txt',
    })
    const patch = [
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+from nothing',
      '*** End Patch',
    ].join('\n')
    const result = await applyPatch(mp)(
      {
        bytes: minted.outputs[0].bytes,
        mimeType: minted.outputs[0].mimeType,
        filename: 'untitled.txt',
      },
      patch
    )
    expect(result.kind).toBe('media-list')
  })
})

describe('diff ↔ apply_patch round-trip contract', () => {
  it.each([
    ['txt', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\ndelta\n'],
    ['md', '# One\n\ntext\n', '# One\n\nrewritten\n'],
    ['json', '{\n  "a": 1\n}\n', '{\n  "a": 2\n}\n'],
  ])('diff A with=@B → apply_patch on A reproduces B (%s)', async (ext, a, b) => {
    const mp = await createMediaPipeline()
    const payloadA = textPayload(a, `a.${ext}`)
    const payloadB = textPayload(b, `b.${ext}`)
    const diffed = await mp.query(payloadA, 'diff with=@other', {
      resolveRef: async () => payloadB,
    })
    expect(diffed.kind).toBe('data')
    const patch = (diffed as { data: { patch: string } }).data.patch
    const applied = await mp.ops(payloadA, [{ verb: 'apply_patch', args: { patch } }])
    expect(decode((applied as { payload: StepPayload }).payload.bytes)).toBe(b)
  })

  it('a doctored patch fails with the readable context-mismatch error', async () => {
    const mp = await createMediaPipeline()
    const patch = [
      '--- a.txt',
      '+++ b.txt',
      '@@ -1,1 +1,1 @@',
      '-not the actual content',
      '+x',
      '',
    ].join('\n')
    await expect(
      mp.ops(textPayload('real content\n'), [{ verb: 'apply_patch', args: { patch } }])
    ).rejects.toThrow(/context mismatch/)
  })
})

describe('ODF redact + update_text (content.xml in-place)', () => {
  /** Mint a minimal valid ODT container in memory. */
  const makeOdt = async (paragraphs: string[]): Promise<StepPayload> => {
    const zip = new JSZip()
    const body = paragraphs.map((p) => `<text:p>${p}</text:p>`).join('')
    zip.file(
      'content.xml',
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>`
    )
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    return { bytes, mimeType: MIME.ODT, filename: 'doc.odt' }
  }

  const contentOf = async (payload: StepPayload): Promise<string> => {
    const zip = await JSZip.loadAsync(payload.bytes)
    return zip.file('content.xml')!.async('text')
  }

  it('redact replaces matches and keeps the container valid', async () => {
    const mp = await createMediaPipeline()
    const odt = await makeOdt(['Account 123-45-6789 active', 'No secrets here'])
    const result = await mp.query(odt, 'redact match=/\\d{3}-\\d{2}-\\d{4}/ replace="[SSN]"')
    expect(result.kind).toBe('media')
    const out = (result as { payload: StepPayload }).payload
    expect(out.mimeType).toBe(MIME.ODT)
    const xml = await contentOf(out)
    expect(xml).toContain('[SSN]')
    expect(xml).not.toContain('123-45-6789')
    expect(xml).toContain('No secrets here')
  })

  it('redact spans formatting splits (span aggregation)', async () => {
    const mp = await createMediaPipeline()
    const odt = await makeOdt(['prefix <text:span>123-45</text:span><text:span>-6789</text:span>'])
    const result = await mp.query(odt, 'redact match=/\\d{3}-\\d{2}-\\d{4}/ replace="[X]"')
    const xml = await contentOf((result as { payload: StepPayload }).payload)
    expect(xml).toContain('[X]')
    expect(xml).not.toContain('-6789')
  })

  it('update_text replaces the anchor and reports a missing anchor', async () => {
    const mp = await createMediaPipeline()
    const odt = await makeOdt(['The old phrasing stands'])
    const result = await mp.query(odt, 'update_text anchor="old phrasing" replace="new wording"')
    const xml = await contentOf((result as { payload: StepPayload }).payload)
    expect(xml).toContain('new wording')
    await expect(
      mp.query(await makeOdt(['text']), 'update_text anchor="absent" replace="x"')
    ).rejects.toThrow(/anchor text not found/)
  })

  it('ods and odp route through the same content.xml path', async () => {
    const mp = await createMediaPipeline()
    const odt = await makeOdt(['shared secret'])
    for (const mimeType of [MIME.ODS, MIME.ODP]) {
      const result = await mp.query(
        { ...odt, mimeType, filename: 'f' },
        'redact match="shared secret" replace="[gone]"'
      )
      const xml = await contentOf((result as { payload: StepPayload }).payload)
      expect(xml).toContain('[gone]')
    }
  })
})
