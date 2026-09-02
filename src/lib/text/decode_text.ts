/** Decode text bytes as UTF-8 text, recognizing UTF-16 byte-order marks. */
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

export const decodeText = (bytes: Uint8Array): string => {
  let text: string
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2))
  else text = utf8Decoder.decode(bytes)
  return text.replace(/\r\n?/g, '\n')
}
