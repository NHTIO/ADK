import { E_INVALID_SANDBOX_CONFIG } from './exceptions'

/** Shells for which SRT's POSIX quote() and the `-c` invocation contract agree. */
export const POSIX_SHELLS = ['sh', 'bash', 'dash', 'zsh', 'ksh'] as const

/** Binaries for which passing `--` terminates option parsing. */
// Verified against the installed GNU/BSD implementations. In particular, ls is
// intentionally absent: it has no portable `--` terminator, and find is not
// treated as an argv-parser boundary by this table.
export const DOUBLE_DASH_BINARIES = ['cp', 'rg'] as const

/**
 * Flags emitted by the sandbox's own ripgrep adapter.
 *
 * @remarks
 * EVERY flag the adapter actually emits must appear here, or the adapter rejects its own argv and the
 * capability fails for every invocation. `--json` is `searchContent`'s output format and is exactly such
 * a flag; omitting it made content search unusable while name search (which does not use it) worked.
 * The argv TERMINATOR `--` is deliberately absent: it is not a flag, and it is filtered out before
 * validation rather than admitted here, so this list stays a list of flags.
 */
export const ALLOWED_RIPGREP_FLAGS = [
  '--files',
  '--hidden',
  '--follow',
  '--no-ignore',
  '--glob',
  '--iglob',
  '--max-depth',
  '--json',
] as const

const allowedShellText = POSIX_SHELLS.join(', ')

/** Validate the shell selected by the Node SRT adapter. */
export const validateBinShell = (value = '/bin/bash'): string => {
  if (!value.startsWith('/')) {
    throw new E_INVALID_SANDBOX_CONFIG([
      `binShell ${JSON.stringify(value)} must be an absolute path; allowed shell basenames: ${allowedShellText}`,
    ])
  }
  const basename = value.slice(value.lastIndexOf('/') + 1)
  if (!(POSIX_SHELLS as readonly string[]).includes(basename)) {
    throw new E_INVALID_SANDBOX_CONFIG([
      `binShell ${JSON.stringify(value)} is not allowed; allowed shell basenames: ${allowedShellText}`,
    ])
  }
  return value
}

/** Alias used by the SRT adapter at construction time. */
export const assertPosixBinShell = validateBinShell

/** Reject an argv value which would otherwise be interpreted as an option. */
export const assertArgvValue = (value: string): string => {
  if (value.startsWith('-')) {
    throw new E_INVALID_SANDBOX_CONFIG([
      `argv value ${JSON.stringify(value)} must not begin with '-'`,
    ])
  }
  if (value.includes('\0')) {
    throw new E_INVALID_SANDBOX_CONFIG([`argv value ${JSON.stringify(value)} contains NUL`])
  }
  return value
}

/** Whether a binary in the table can receive the argv terminator. */
export const binaryHonorsDoubleDash = (binary: string): boolean => {
  const basename = binary.slice(binary.lastIndexOf('/') + 1)
  return (DOUBLE_DASH_BINARIES as readonly string[]).includes(basename)
}

/** Validate a flag emitted by a trusted adapter, not a model-supplied value. */
export const assertAllowedRipgrepFlag = (flag: string): string => {
  const name = flag.includes('=') ? flag.slice(0, flag.indexOf('=')) : flag
  if (!(ALLOWED_RIPGREP_FLAGS as readonly string[]).includes(name)) {
    throw new E_INVALID_SANDBOX_CONFIG([
      `unsupported rg flag ${JSON.stringify(flag)}; allowed flags: ${ALLOWED_RIPGREP_FLAGS.join(', ')}`,
    ])
  }
  return flag
}

/**
 * Quote argv using SRT's maintained POSIX implementation.
 *
 * The import is deliberately lazy: SRT is an optional peer and is ESM-only.
 */
export const quoteShellArgs = async (args: readonly string[]): Promise<string> => {
  const nulIndex = args.findIndex((arg) => arg.includes('\0'))
  if (nulIndex >= 0) {
    throw new E_INVALID_SANDBOX_CONFIG([
      `argv value at index ${nulIndex} contains NUL (reason: nul)`,
    ])
  }
  const moduleName = '@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js'
  const module = (await import(moduleName)) as { quote: (items: string[]) => string }
  return module.quote([...args])
}

/** Quote one command string as one shell argument. */
export const quoteShellValue = async (value: string): Promise<string> => quoteShellArgs([value])

/** Compatibility alias for consumers that describe this operation as escaping. */
export const escapeShellArgs = quoteShellArgs
/** Compatibility alias for consumers that describe this operation as escaping. */
export const escapeShellValue = quoteShellValue
