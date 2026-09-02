/** Pure extension-based MIME defaults for the sandbox file tools. */
import type { MimeResolver } from '@nhtio/adk/batteries/sandbox/contracts/mime_resolver'

/** The default prefix available to a custom resolver. */
export const DEFAULT_MIME_PEEK_BYTES = 512

/** Extension to MIME mappings used by the default resolver. */
export const SANDBOX_EXTENSION_MIME: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  rtf: 'application/rtf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  jsx: 'text/plain',
  mjs: 'text/plain',
  cjs: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  swift: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cc: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  php: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  zsh: 'text/plain',
  sql: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  lua: 'text/plain',
  pl: 'text/plain',
  r: 'text/plain',
  scala: 'text/plain',
  dart: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  css: 'text/plain',
  scss: 'text/plain',
  less: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
}

const extensionOf = (path: string): string | undefined => {
  const name = path.split(/[\\/?#]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return undefined
  return name.slice(dot + 1).toLowerCase()
}

/** Resolve a MIME type from a filename, without sniffing bytes. */
export const extensionMimeResolver: MimeResolver = ({ path, declared }) => {
  if (declared !== undefined && declared.trim() !== '') return declared
  return SANDBOX_EXTENSION_MIME[extensionOf(path) ?? '']
}

/** The default resolver, also exported under the concise name used by consumers. */
export const defaultMimeResolver = extensionMimeResolver

/**
 * Run a resolver and fall back to the extension resolver when it declines.
 * The callback supplied to consumer code is always bounded by `maxPeekBytes`.
 */
export const resolveMime = async (
  path: string,
  resolver?: MimeResolver,
  options: {
    declared?: string
    maxPeekBytes?: number
    peek?: (bytes: number) => Promise<Uint8Array>
  } = {}
): Promise<string | undefined> => {
  const maxPeekBytes = Math.max(0, Math.floor(options.maxPeekBytes ?? DEFAULT_MIME_PEEK_BYTES))
  const sourcePeek = options.peek ?? (async () => new Uint8Array(0))
  const peek = async (bytes: number): Promise<Uint8Array> =>
    sourcePeek(Math.min(maxPeekBytes, Math.max(0, Math.floor(bytes))))
  if (resolver !== undefined) {
    const detected = await resolver({
      path,
      declared: options.declared,
      peek: async (bytes) => peek(Math.min(maxPeekBytes, Math.max(0, Math.floor(bytes)))),
    })
    if (detected !== undefined) return detected
  }
  return extensionMimeResolver({ path, declared: options.declared, peek })
}
