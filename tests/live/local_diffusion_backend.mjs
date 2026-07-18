// A real protocol-speaking local-diffusion backend (Node) — proves the ADK adapter's live subprocess
// transport (spawn + stdin/stdout pipes + byte framing) end-to-end WITHOUT a torch/diffusers stack.
// It speaks the DiffusionBee-compatible default protocol: reads `b2py <op> <rid> <json>` on stdin,
// emits `sdbk ...` frames on stdout. On t2im/im2im it streams progress then returns a REAL 1x1 PNG.
import { createInterface } from 'node:readline'

// A genuine, valid 1x1 PNG (magic bytes \x89PNG\r\n\x1a\n ... IEND). Base64 of the smallest valid PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const out = (line) => process.stdout.write(line + '\n')

// Startup: model-load progress then ready.
out('sdbk mdld 0.5')
out('sdbk mdld 1')
out('sdbk rdy')

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const m = /^b2py\s+(\S+)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/.exec(line)
  if (!m) return
  const [, op, ridStr] = m
  if (op === '__shutdown__') {
    process.exit(0)
  }
  if (op === '__stop__') {
    // advisory — this backend completes fast, nothing to cancel
    return
  }
  const rid = Number(ridStr)
  if (op === 't2im' || op === 'im2im') {
    // stream a couple of progress frames, then one image + done.
    out(`sdbk dnpr ${rid} 0.33`)
    out(`sdbk dnpr ${rid} 0.66`)
    out(`sdbk dnpr ${rid} 1`)
    out(`sdbk nwim ${rid} ${JSON.stringify({ b64: PNG_B64, mimeType: 'image/png' })}`)
    out(`sdbk done ${rid}`)
  }
})
