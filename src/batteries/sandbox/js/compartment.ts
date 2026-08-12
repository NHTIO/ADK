import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { E_SES_LOCKDOWN_REQUIRED, E_SES_EVALUATION_TIMEOUT } from './exceptions'
import type { GuestOutcome, GuestLimits } from '../types'

const cut = (text: string, bytes: number): { text: string; truncated: boolean } => {
  const suffix = '… [cut]'
  if (new TextEncoder().encode(text).byteLength <= bytes) return { text, truncated: false }
  let value = text
  while (new TextEncoder().encode(`${value}${suffix}`).byteLength > bytes)
    value = value.slice(0, -1)
  return { text: `${value}${suffix}`, truncated: true }
}
const render = (value: unknown): { value: unknown; encoding: 'encoder' | 'partial' } => {
  try {
    return {
      value: JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))),
      encoding: 'encoder',
    }
  } catch {
    return { value: `[unrepresentable ${typeof value}]`, encoding: 'partial' }
  }
}
/** Construct a minimal SES-backed in-process guest. The runtime boundary is intentionally explicit. */
export const createCompartmentRuntime = async (
  globals: Record<string, (...args: unknown[]) => unknown>,
  limits: GuestLimits,
  modules: Record<string, unknown> = {}
) => {
  await import('ses')
  const realm = globalThis as typeof globalThis & {
    lockdown?: () => void
    Compartment?: new (
      endowments?: Record<string, unknown>,
      modules?: unknown
    ) => {
      evaluate: (source: string) => unknown
    }
  }
  if (typeof realm.lockdown !== 'function' || typeof realm.Compartment !== 'function')
    throw new E_SES_LOCKDOWN_REQUIRED(['SES lockdown() and Compartment are required'])
  // SES is process-global in Node. The first guest bootstrap hardens this realm; subsequent
  // in-process evaluations must verify the already-hardened realm rather than invoking lockdown()
  // a second time (SES deliberately throws SES_ALREADY_LOCKED_DOWN).
  if (!(realm as typeof realm & { __adkSesLocked?: boolean }).__adkSesLocked) {
    try {
      realm.lockdown()
    } catch (error) {
      if (
        !(
          isInstanceOf(error, 'TypeError', TypeError) &&
          String(error).includes('SES_ALREADY_LOCKED_DOWN')
        )
      )
        throw error
    }
    ;(realm as typeof realm & { __adkSesLocked?: boolean }).__adkSesLocked = true
  }
  const C = realm.Compartment
  return {
    async evaluate(source: string, o: { timeoutMs: number }): Promise<GuestOutcome> {
      const started = performance.now()
      let seq = 0
      let capped = false
      const logs: { seq: number; text: string; truncated: boolean }[] = []
      const consoleLike = {
        log: (...a: unknown[]) => {
          if (logs.length >= limits.maxLogEvents) {
            capped = true
            return
          }
          const text = cut(a.map(String).join(' '), limits.maxLogEventBytes)
          logs.push({ seq: ++seq, ...text })
        },
      }
      const end = (): number => Math.max(0, performance.now() - started)
      const timer = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new E_SES_EVALUATION_TIMEOUT(['evaluation exceeded timeout'])),
          o.timeoutMs
        )
      )
      try {
        const compartment = new C({ console: consoleLike, ...globals }, modules)
        const result = await Promise.race([
          Promise.resolve(compartment.evaluate(`(async()=>(${source}))()`)),
          timer,
        ])
        const rendered = render(result)
        return {
          ok: true,
          result: rendered.value,
          encoding: rendered.encoding,
          durationMs: end(),
          logs,
          logsCapped: capped,
          logsComplete: true,
        }
      } catch (error) {
        if (isInstanceOf(error, 'E_SES_EVALUATION_TIMEOUT', E_SES_EVALUATION_TIMEOUT)) throw error
        const thrown = isError(error)
          ? { kind: 'error' as const, message: error.message, stack: error.stack }
          : { kind: 'opaque' as const }
        return {
          ok: false,
          thrown,
          durationMs: end(),
          logs,
          logsCapped: capped,
          logsComplete: true,
        }
      }
    },
    async kill(): Promise<void> {
      /* Compartment cannot be forcibly killed; production adapters must use a worker. */
    },
  }
}
