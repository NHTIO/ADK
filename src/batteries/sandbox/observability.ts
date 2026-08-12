/**
 * The single sandbox observability firehose.
 *
 * WP-A1 wires the callbacks from `createSandbox()` to `createSandboxObservability()`;
 * it must not emit parallel ad-hoc events.  Every path-bearing field is redacted here,
 * before it reaches an operator, logger, or audit sink.
 */
import type { PathTranslator } from './contracts/path_translator'

/** Typed records emitted by the sandbox's single audit firehose. */
export type SandboxEvent =
  | {
      readonly kind: 'bypass'
      readonly command: string
      readonly path?: string
      readonly loud: true
    }
  | {
      readonly kind: 'unsandboxed-fallback'
      readonly handleId: string
      readonly reason: string
      readonly path?: string
      readonly loud: true
    }
  | {
      readonly kind: 'drift-check'
      readonly outcome: 'passed' | 'failed' | 'skipped'
      readonly reason?: string
      readonly path?: string
      /** `skipped` is specifically the network-domain comparison, not adoption. */
      readonly comparison?: 'network-domains'
    }
  | {
      readonly kind: 'fs-node-version'
      readonly version: string
    }
  | { readonly kind: 'dependency-warnings'; readonly warnings: readonly string[] }

/** Consumer callback for sandbox audit events. */
export type SandboxEventSink = (event: SandboxEvent) => void

/** Dependencies used to create the redacting firehose. */
export interface SandboxObservabilityOptions {
  /** Translator used for every path-bearing event field. */
  readonly pathTranslator: PathTranslator
  /** Destination for already-redacted events. */
  readonly sink: SandboxEventSink
}

const redactEvent = (event: SandboxEvent, translator: PathTranslator): SandboxEvent => {
  if (event.kind === 'bypass') {
    return Object.freeze({
      ...event,
      command: translator.redact(event.command),
      ...(event.path === undefined ? {} : { path: translator.redact(event.path) }),
    })
  }
  if (event.kind === 'unsandboxed-fallback') {
    return Object.freeze({
      ...event,
      handleId: translator.redact(event.handleId),
      reason: translator.redact(event.reason),
      ...(event.path === undefined ? {} : { path: translator.redact(event.path) }),
    })
  }
  if (event.kind === 'drift-check') {
    return Object.freeze({
      ...event,
      ...(event.reason === undefined ? {} : { reason: translator.redact(event.reason) }),
      ...(event.path === undefined ? {} : { path: translator.redact(event.path) }),
    })
  }
  if (event.kind === 'dependency-warnings') {
    return Object.freeze({
      ...event,
      warnings: Object.freeze(event.warnings.map((warning) => translator.redact(warning))),
    })
  }
  return Object.freeze(event)
}

/** Build the one event surface consumed by WP-A1's sandbox handle. */
export const createSandboxObservability = (
  options: SandboxObservabilityOptions
): SandboxEventSink => {
  return (event) => options.sink(redactEvent(event, options.pathTranslator))
}

/** Emit a loud audit-only bypass report. */
export const emitBypass = (sink: SandboxEventSink, command: string, path?: string): void => {
  sink({ kind: 'bypass', command, ...(path === undefined ? {} : { path }), loud: true })
}

/** Emit the permanent loud report for an unsandboxed invocation. */
export const emitFallback = (
  sink: SandboxEventSink,
  handleId: string,
  reason: string,
  path?: string
): void => {
  sink({
    kind: 'unsandboxed-fallback',
    handleId,
    reason,
    ...(path === undefined ? {} : { path }),
    loud: true,
  })
}

/** Emit a drift result, including an explicit network-domain skip when requested. */
export const emitDriftCheck = (
  sink: SandboxEventSink,
  outcome: 'passed' | 'failed' | 'skipped',
  details?: {
    readonly reason?: string
    readonly path?: string
    readonly networkDomainsSkipped?: boolean
  }
): void => {
  sink({
    kind: 'drift-check',
    outcome,
    ...(details?.reason === undefined ? {} : { reason: details.reason }),
    ...(details?.path === undefined ? {} : { path: details.path }),
    ...(details?.networkDomainsSkipped ? { comparison: 'network-domains' as const } : {}),
  })
}

/** Emit the SRT version used by the in-process evaluator. */
export const emitFsNodeVersion = (sink: SandboxEventSink, version: string): void => {
  sink({ kind: 'fs-node-version', version })
}
