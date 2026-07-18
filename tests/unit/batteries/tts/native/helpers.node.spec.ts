/**
 * Unit tests for the pure native-TTS invocation builders (`buildNativeTtsInvocation` +
 * `psSingleQuotedLiteral`). PURE: no mocks, no node builtins, no I/O — these functions are the
 * hermetic core the adapter shells out through.
 *
 * @module tests/unit/batteries/tts/native/helpers
 */

import { describe, expect, it } from 'vitest'
import {
  buildNativeTtsInvocation,
  psSingleQuotedLiteral,
} from '@nhtio/adk/batteries/tts/native/helpers'

describe('psSingleQuotedLiteral', () => {
  it('wraps a plain string in single quotes', () => {
    expect(psSingleQuotedLiteral('hello')).toBe("'hello'")
  })

  it('doubles every internal single quote', () => {
    expect(psSingleQuotedLiteral("it's")).toBe("'it''s'")
    expect(psSingleQuotedLiteral("'leading")).toBe("'''leading'")
    expect(psSingleQuotedLiteral("a'b'c")).toBe("'a''b''c'")
  })

  it('leaves backslashes and dollar signs verbatim (single-quoted literals are not interpolated)', () => {
    expect(psSingleQuotedLiteral('a\\b')).toBe("'a\\b'")
    expect(psSingleQuotedLiteral('$env:foo')).toBe("'$env:foo'")
    expect(psSingleQuotedLiteral('$(rm -rf)')).toBe("'$(rm -rf)'")
  })

  it('strips control characters (CR/LF/tab/etc.) before quoting', () => {
    expect(psSingleQuotedLiteral('a\tb\nc\rd')).toBe("'abcd'")
  })

  it('throws on a NUL byte', () => {
    expect(() => psSingleQuotedLiteral('a\u0000b')).toThrow(/NUL/)
  })

  it('throws on a non-string input', () => {
    expect(() => psSingleQuotedLiteral(42 as never)).toThrow(/must be a string/)
  })

  it('quotes the empty string', () => {
    expect(psSingleQuotedLiteral('')).toBe("''")
  })
})

describe('buildNativeTtsInvocation — darwin', () => {
  const outPath = '/tmp/adk-tts-x.wav'

  it('defaults to `say` with the WAV output flag, the LEI16@22050 data format, then the text', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'darwin',
      outPath,
      text: 'hello',
    })
    expect(cmd).toBe('say')
    expect(args).toEqual(['-o', outPath, '--data-format=LEI16@22050', 'hello'])
  })

  it('threads voice → -v and wordsPerMinute → -r before the text', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'darwin',
      outPath,
      text: 'hi',
      voice: 'Samantha',
      wordsPerMinute: 200,
    })
    expect(cmd).toBe('say')
    expect(args).toEqual([
      '-o',
      outPath,
      '--data-format=LEI16@22050',
      '-v',
      'Samantha',
      '-r',
      '200',
      'hi',
    ])
  })

  it('omits -v/-r when voice/wpm are absent', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'darwin',
      outPath,
      text: 'plain',
    })
    expect(args).not.toContain('-v')
    expect(args).not.toContain('-r')
  })

  it('threads extraArgs before the voice/rate flags', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'darwin',
      outPath,
      text: 'hi',
      extraArgs: ['--progress'],
      voice: 'Alex',
      wordsPerMinute: 175,
    })
    expect(cmd).toBe('say')
    expect(args).toEqual([
      '-o',
      outPath,
      '--data-format=LEI16@22050',
      '--progress',
      '-v',
      'Alex',
      '-r',
      '175',
      'hi',
    ])
  })

  it('honors a command override (executable only; the arg shape is unchanged)', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'darwin',
      outPath,
      text: 'hi',
      command: '/usr/local/bin/say',
    })
    expect(cmd).toBe('/usr/local/bin/say')
    expect(args).toEqual(['-o', outPath, '--data-format=LEI16@22050', 'hi'])
  })
})

describe('buildNativeTtsInvocation — linux', () => {
  const outPath = '/tmp/adk-tts-x.wav'

  it('defaults to `espeak-ng` with -w <outPath> then the text', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'linux',
      outPath,
      text: 'hello',
    })
    expect(cmd).toBe('espeak-ng')
    expect(args).toEqual(['-w', outPath, 'hello'])
  })

  it('threads voice → -v, wordsPerMinute → -s, pitch → -p before the text', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'linux',
      outPath,
      text: 'hi',
      voice: 'en-us',
      wordsPerMinute: 160,
      pitch: 50,
    })
    expect(cmd).toBe('espeak-ng')
    expect(args).toEqual(['-w', outPath, '-v', 'en-us', '-s', '160', '-p', '50', 'hi'])
  })

  it('omits -v/-s/-p when absent', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'linux',
      outPath,
      text: 'plain',
    })
    expect(args).not.toContain('-v')
    expect(args).not.toContain('-s')
    expect(args).not.toContain('-p')
  })

  it('threads extraArgs before the voice/rate/pitch flags', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'linux',
      outPath,
      text: 'hi',
      extraArgs: ['-g', '5'],
      voice: 'en',
      wordsPerMinute: 175,
      pitch: 40,
    })
    expect(args).toEqual(['-w', outPath, '-g', '5', '-v', 'en', '-s', '175', '-p', '40', 'hi'])
  })

  it('honors a command override (e.g. espeak)', () => {
    const { cmd } = buildNativeTtsInvocation({
      platform: 'linux',
      outPath,
      text: 'hi',
      command: 'espeak',
    })
    expect(cmd).toBe('espeak')
  })
})

describe('buildNativeTtsInvocation — win32', () => {
  const outPath = 'C:\\tmp\\adk-tts-x.wav'

  it('defaults to powershell.exe with -NoProfile -NonInteractive -Command <script>', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hello',
    })
    expect(cmd).toBe('powershell.exe')
    expect(args).toHaveLength(4)
    expect(args[0]).toBe('-NoProfile')
    expect(args[1]).toBe('-NonInteractive')
    expect(args[2]).toBe('-Command')
    const script = args[3]
    expect(script).toContain('SetOutputToWaveFile')
    expect(script).toContain('System.Speech.Synthesis.SpeechSynthesizer')
    expect(script).toContain('Speak(')
    expect(script).toContain('Dispose()')
  })

  it('embeds the outPath via psSingleQuotedLiteral', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
    })
    const script = args[3]
    expect(script).toContain(psSingleQuotedLiteral(outPath))
    expect(script).toContain(psSingleQuotedLiteral('hi'))
  })

  it('embeds the voice via SelectVoice and psSingleQuotedLiteral', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
      voice: 'Microsoft David',
    })
    const script = args[3]
    expect(script).toContain('SelectVoice(')
    expect(script).toContain(psSingleQuotedLiteral('Microsoft David'))
  })

  it('sets $s.Rate from the resolved win32 rate (the `rate` field)', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
      rate: 5,
    })
    const script = args[3]
    expect(script).toContain('$s.Rate = 5;')
  })

  it('omits the SelectVoice line when voice is absent', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
    })
    expect(args[3]).not.toContain('SelectVoice')
  })

  it('quotes a voice containing an apostrophe safely (doubles internal quotes)', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: "it's",
      voice: "O'Brien",
    })
    const script = args[3]
    // The apostrophe in the text is doubled inside the literal.
    expect(script).toContain(psSingleQuotedLiteral("it's"))
    expect(script).toContain(psSingleQuotedLiteral("O'Brien"))
    // The doubling is present.
    expect(psSingleQuotedLiteral("it's")).toBe("'it''s'")
    expect(psSingleQuotedLiteral("O'Brien")).toBe("'O''Brien'")
  })

  it('contains a statement-shaped injection payload entirely inside the quoted literals', () => {
    // A payload crafted to break out of a single-quoted literal and inject a PowerShell statement.
    const payload = "x'); Start-Process calc; #"
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath: `C:\\tmp\\${payload}.wav`,
      text: payload,
      voice: payload,
    })
    const script = args[3]
    // Every interpolated value appears ONLY as the exact single-quoted literal passed to its call —
    // never as bare source. The literal doubles the payload's internal quote, neutralizing the break.
    const lit = psSingleQuotedLiteral(payload)
    expect(script).toContain(`$s.Speak(${lit})`)
    expect(script).toContain(`$s.SelectVoice(${lit})`)
    expect(script).toContain(
      `$s.SetOutputToWaveFile(${psSingleQuotedLiteral(`C:\\tmp\\${payload}.wav`)})`
    )
    // The breakout REQUIRES an un-doubled closing quote — `x');` — to end the literal early and start
    // a bare statement. Because every literal doubles `'` → `''`, the payload only ever appears as
    // `x'');` (quote doubled), so the un-doubled breakout sequence is absent. Its presence would mean
    // the quoting failed and `Start-Process calc` could execute.
    expect(script).not.toContain("x');")
    // The doubled form IS present (proving the payload was embedded, just neutralized).
    expect(script).toContain("x'');")
  })

  it('strips control characters from the embedded text literal', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'a\tb\nc',
    })
    const script = args[3]
    expect(script).toContain("'abc'")
  })

  it('wraps the body in try { ... } finally { $s.Dispose() }', () => {
    const { args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
    })
    const script = args[3]
    expect(script).toContain('try {')
    expect(script).toContain('finally {')
    expect(script).toMatch(/finally\s*\{\s*\$s\.Dispose\(\);\s*\}/)
  })

  it('honors a command override (executable only)', () => {
    const { cmd, args } = buildNativeTtsInvocation({
      platform: 'win32',
      outPath,
      text: 'hi',
      command: 'pwsh.exe',
    })
    expect(cmd).toBe('pwsh.exe')
    expect(args[0]).toBe('-NoProfile')
  })
})
