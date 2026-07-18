/**
 * Pure invocation builders for the OS-native TTS adapter — the platform-specific argument arrays the
 * adapter shells out with. This module is the hermetic, unit-tested core: NO node builtins, NO I/O.
 *
 * @module @nhtio/adk/batteries/tts/native/helpers
 *
 * @remarks
 * `buildNativeTtsInvocation` is the pure function that turns a resolved platform + text + output
 * path + optional voice/rate/pitch into the `{ cmd, args }` pair the executor runs, per platform:
 *
 * - **darwin**: `say -o <outPath> --data-format=LEI16@22050 [...extraArgs] [-v <voice>] [-r <wpm>] <text>`.
 *   `--data-format=LEI16@22050` makes `say` emit real 16-bit little-endian PCM WAV at 22050 Hz rather
 *   than its default AIFF, so the adapter can assert the RIFF/WAVE magic on every byte payload.
 * - **linux**: `espeak-ng -w <outPath> [...extraArgs] [-v <voice>] [-s <wpm>] [-p <pitch>] <text>`.
 * - **win32**: `powershell.exe -NoProfile -NonInteractive -Command <script>`, where `<script>` drives
 *   `System.Speech.Synthesis.SpeechSynthesizer` to write a WAV file, with every interpolated value
 *   (text, voice, outPath) passed through {@link psSingleQuotedLiteral} so an apostrophe in the text
 *   can never break out of the PowerShell string literal. The rate is a `-10..10` integer (NOT a
 *   wpm) computed by the adapter and passed in as `win32Rate`.
 *
 * The adapter computes the **resolved** values (words-per-minute, win32 rate int) and passes them
 * in; this helper does NOT recompute rate policy — it only threads the numbers onto the right flag
 * for the platform.
 */

import type { NativeTtsPlatform } from './types'

/**
 * Encode `s` as a single-quoted PowerShell string literal: wrap in single quotes and double every
 * internal single quote (`'` → `''`). PowerShell single-quoted literals are verbatim — no variable
 * interpolation, no escape sequences — so this is the only quoting rule needed.
 *
 * @remarks
 * Before quoting, NUL and all C0/`Cc` control characters are stripped (and a stray NUL rejected)
 * so an adversarial text/voice/outPath cannot inject a control character that PowerShell or the
 * underlying console might interpret. This is a defensive guard, not a complete PowerShell fuzzer:
 * it rejects the byte values that are unsafe inside ANY string context (NUL and control codes),
 * and lets everything else through verbatim inside the single-quoted literal.
 *
 * @param s - The string to quote. Must be a finite string.
 * @returns The single-quoted PowerShell literal of `s`.
 * @throws {Error} when `s` is not a string or contains a NUL byte (`\0`).
 */
export const psSingleQuotedLiteral = (s: string): string => {
  if (typeof s !== 'string') {
    throw new Error('psSingleQuotedLiteral: input must be a string')
  }
  if (s.includes('\u0000')) {
    throw new Error('psSingleQuotedLiteral: input contains a NUL byte')
  }
  // Strip every C0 control character (0x00–0x1F) and DEL (0x7F). NUL was already rejected above; the
  // rest are rejected as injection vectors (newline/tab could terminate a console arg, etc.).
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the security purpose here
  const sanitized = s.replace(/[\u0000-\u001F\u007F]/g, '')
  return `'${sanitized.replace(/'/g, "''")}'`
}

/** Builds the PowerShell `System.Speech` script body for win32. Pure. */
const buildWin32Script = (input: {
  outPath: string
  text: string
  voice?: string
  win32Rate?: number
}): string => {
  const outLiteral = psSingleQuotedLiteral(input.outPath)
  const textLiteral = psSingleQuotedLiteral(input.text)
  const voiceLine =
    input.voice !== undefined ? `$s.SelectVoice(${psSingleQuotedLiteral(input.voice)});` : ''
  const rateLine = input.win32Rate !== undefined ? `$s.Rate = ${Math.trunc(input.win32Rate)};` : ''
  return [
    '$ErrorActionPreference = "Stop";',
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `try { $s.SetOutputToWaveFile(${outLiteral}); ${voiceLine} ${rateLine} $s.Speak(${textLiteral}); }`,
    'finally { $s.Dispose(); }',
  ].join(' ')
}

/**
 * Build the `{ cmd, args }` invocation for one native TTS synthesis call. Pure and side-effect-free.
 *
 * @remarks
 * The caller (the adapter) resolves every policy decision BEFORE calling this:
 *
 * - `wordsPerMinute` is the already-resolved wpm for `say`/`espeak-ng` (the adapter computes
 *   `wordsPerMinute ?? clamp(round(175 * (rate ?? 1)), 80, 500)`).
 * - `rate` is the already-resolved `-10..10` integer for PowerShell's `SpeechSynthesizer.Rate`
 *   (the adapter computes `clamp(round(((rate ?? 1) - 1) * 10), -10, 10)`). It is used ONLY on
 *   win32 and ignored on darwin/linux — the helper does NOT recompute it.
 * - `pitch` is the espeak-ng `-p` value (0–99); ignored on darwin/win32.
 *
 * On every platform, `command` (when supplied) overrides only the executable; the platform's own
 * argument/script shape is still built around it. `extraArgs` are inserted before the
 * voice/rate/pitch/text flags on darwin/linux; they are IGNORED on win32, where the entire
 * synthesis is expressed as a single `-Command` PowerShell script (there is no positional-flag slot
 * to forward them into safely).
 *
 * @param input.platform - The target platform.
 * @param input.outPath - The scratch WAV output path the binary writes to.
 * @param input.text - The text to synthesize.
 * @param input.command - Optional executable override (default: `say`/`espeak-ng`/`powershell.exe`).
 * @param input.voice - Optional voice name.
 * @param input.wordsPerMinute - Optional resolved wpm for `say`/`espeak-ng`.
 * @param input.pitch - Optional espeak-ng pitch (0–99).
 * @param input.rate - Optional resolved `-10..10` rate for PowerShell (win32 only).
 * @param input.extraArgs - Optional extra args inserted before the platform-specific flags.
 * @returns The `{ cmd, args }` pair to hand to the executor.
 */
export const buildNativeTtsInvocation = (input: {
  platform: NativeTtsPlatform
  outPath: string
  text: string
  command?: string
  voice?: string
  wordsPerMinute?: number
  pitch?: number
  rate?: number
  extraArgs?: string[]
}): { cmd: string; args: string[] } => {
  const { platform, outPath, text, command, voice, wordsPerMinute, pitch, rate, extraArgs } = input
  const extra = extraArgs ?? []

  if (platform === 'darwin') {
    const cmd = command ?? 'say'
    const args = [
      '-o',
      outPath,
      '--data-format=LEI16@22050',
      ...extra,
      ...(voice !== undefined ? ['-v', voice] : []),
      ...(wordsPerMinute !== undefined ? ['-r', String(wordsPerMinute)] : []),
      text,
    ]
    return { cmd, args }
  }

  if (platform === 'linux') {
    const cmd = command ?? 'espeak-ng'
    const args = [
      '-w',
      outPath,
      ...extra,
      ...(voice !== undefined ? ['-v', voice] : []),
      ...(wordsPerMinute !== undefined ? ['-s', String(wordsPerMinute)] : []),
      ...(pitch !== undefined ? ['-p', String(pitch)] : []),
      text,
    ]
    return { cmd, args }
  }

  // win32
  const cmd = command ?? 'powershell.exe'
  const script = buildWin32Script({ outPath, text, voice, win32Rate: rate })
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  return { cmd, args }
}
