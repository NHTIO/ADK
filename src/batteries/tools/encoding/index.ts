/**
 * Pre-constructed tools for common text encodings and decoding operations.
 *
 * @module @nhtio/adk/batteries/tools/encoding
 *
 * @remarks
 * Pre-constructed bundled tools for the `encoding` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'

const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

const base64ToUtf8 = (b64: string): string => {
  const binary = globalThis.atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Convert a numeric HTML-entity code point to its string, handling astral characters correctly.
 * Returns the original entity text `fallback` for code points outside the valid Unicode range
 * (0 – 0x10FFFF) so `String.fromCodePoint` never throws a RangeError.
 */
const codePointToString = (cp: number, fallback: string): string => {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return fallback
  return String.fromCodePoint(cp)
}

/**
 * Encode or decode text using common schemes: base64, url (percent-encoding), html_entities.
 *
 * @remarks
 * `base64` uses the portable `globalThis.btoa`/`atob` pair so the tool works in browsers, Node,
 * and edge runtimes. Encoding/decoding errors are returned as `Error:` strings rather than
 * thrown so the model can react in-line.
 */
export const encodeTextTool = new Tool({
  name: 'encode_text',
  description:
    'Encode or decode text using common schemes: base64, url (percent-encoding), html_entities. Specify direction: encode or decode.',
  inputSchema: validator.object({
    text: validator.string().required().description('Text to encode or decode'),
    scheme: validator
      .string()
      .valid('base64', 'url', 'html_entities')
      .required()
      .description('Encoding scheme'),
    direction: validator
      .string()
      .valid('encode', 'decode')
      .default('encode')
      .description('Whether to encode or decode (default: encode)'),
  }),
  handler: async (args) => {
    const { text, scheme, direction } = args as {
      text: string
      scheme: string
      direction: string
    }

    try {
      if (scheme === 'base64') {
        if (direction === 'encode') return utf8ToBase64(text)
        return base64ToUtf8(text)
      }

      if (scheme === 'url') {
        if (direction === 'encode') return encodeURIComponent(text)
        return decodeURIComponent(text)
      }

      if (scheme === 'html_entities') {
        if (direction === 'encode') {
          return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
        }
        return (
          text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            // Use fromCodePoint, not fromCharCode: a numeric entity above U+FFFF (e.g. an emoji like
            // &#127881; = 🎉) is an astral code point. fromCharCode truncates to 16 bits and yields a
            // broken/empty character; fromCodePoint produces the correct surrogate pair. Out-of-range
            // code points (> U+10FFFF) are left as-is rather than throwing.
            .replace(/&#(\d+);/g, (m, code: string) =>
              codePointToString(Number.parseInt(code, 10), m)
            )
            .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) =>
              codePointToString(Number.parseInt(hex, 16), m)
            )
        )
      }

      return `Error: Unknown scheme "${scheme}".`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Escape or unescape special characters for a target context.
 *
 * @remarks
 * Supports `json_string`, `regex`, `csv_field`, `sql_like`, and `markdown` targets. Returns
 * an error string for unknown targets rather than throwing.
 */
export const textEscapeTool = new Tool({
  name: 'text_escape',
  description:
    'Escape or unescape special characters for a target context: json_string, regex, csv_field, sql_like, markdown.',
  inputSchema: validator.object({
    text: validator.string().required().description('Text to escape or unescape'),
    target: validator
      .string()
      .valid('json_string', 'regex', 'csv_field', 'sql_like', 'markdown')
      .required()
      .description('Target context for escaping'),
    direction: validator
      .string()
      .valid('escape', 'unescape')
      .default('escape')
      .description('Whether to escape or unescape (default: escape)'),
  }),
  handler: async (args) => {
    const { text, target, direction } = args as {
      text: string
      target: string
      direction: string
    }

    try {
      if (target === 'json_string') {
        if (direction === 'escape') return JSON.stringify(text).slice(1, -1)
        return JSON.parse(`"${text}"`) as string
      }

      if (target === 'regex') {
        if (direction === 'escape') return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return text.replace(/\\([.*+?^${}()|[\]\\])/g, '$1')
      }

      if (target === 'csv_field') {
        if (direction === 'escape') {
          if (/[,"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
          return text
        }
        if (text.startsWith('"') && text.endsWith('"')) {
          return text.slice(1, -1).replace(/""/g, '"')
        }
        return text
      }

      if (target === 'sql_like') {
        if (direction === 'escape') return text.replace(/[%_\\]/g, '\\$&')
        return text.replace(/\\([%_\\])/g, '$1')
      }

      if (target === 'markdown') {
        const mdChars = /[\\`*_{}[\]()#+\-.!|]/g
        if (direction === 'escape') return text.replace(mdChars, '\\$&')
        return text.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
      }

      return `Error: Unknown target "${target}".`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Normalize Unicode text or extract code points.
 *
 * @remarks
 * Operations: NFC, NFD, NFKC, NFKD Unicode normalization forms (via `String.prototype.normalize`),
 * `strip_accents` (NFD-decompose, remove combining diacritics, re-compose to NFC), or
 * `code_points` (one `U+HHHH (char)` per line).
 */
export const unicodeNormalizeTool = new Tool({
  name: 'unicode_normalize',
  description:
    'Normalize Unicode text (NFC, NFD, NFKC, NFKD), strip accents/diacritics, or get Unicode code points for each character.',
  inputSchema: validator.object({
    text: validator.string().required().description('Text to process'),
    operation: validator
      .string()
      .valid('nfc', 'nfd', 'nfkc', 'nfkd', 'strip_accents', 'code_points')
      .required()
      .description(
        'Operation: NFC/NFD/NFKC/NFKD normalization, strip_accents (remove diacritics), or code_points (list hex values)'
      ),
  }),
  handler: async (args) => {
    const { text, operation } = args as { text: string; operation: string }

    try {
      if (operation === 'strip_accents') {
        return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
      }

      if (operation === 'code_points') {
        return [...text]
          .map((ch) => {
            const cp = ch.codePointAt(0)!
            const hex = cp.toString(16).toUpperCase().padStart(4, '0')
            return `U+${hex} (${ch})`
          })
          .join('\n')
      }

      const formMap: Record<string, string> = { nfc: 'NFC', nfd: 'NFD', nfkc: 'NFKC', nfkd: 'NFKD' }
      const form = formMap[operation]
      if (!form) return `Error: Unknown operation "${operation}".`
      return text.normalize(form)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})
