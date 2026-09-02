/** Whether a MIME type represents text that can be handled as markup or plain text. */
export const isTextual = (mime: string): boolean => {
  const normalized = mime.toLowerCase().split(';', 1)[0].trim()
  if (normalized.startsWith('text/')) return true
  if (normalized === 'application/json' || normalized === 'application/yaml') return true
  const subtype = normalized.split('/', 2)[1]
  return subtype === 'xml' || subtype?.endsWith('+xml') === true
}
