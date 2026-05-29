/**
 * Canonical `JSON.stringify` that sorts object keys recursively so that semantically-equal
 * objects produce identical strings.
 *
 * @remarks
 * Used wherever the ADK derives a stable identity from a structured value — for example,
 * `Tool.executor` computing the `callId` for `ToolExecutionStart`/`End` events, and the
 * `reportToolCall` executor helper computing the `checksum` field on `TurnToolCallContent`.
 * Both code paths hash `canonicalStringify({ tool, args })` so that argument key order does not
 * affect the resulting identifier.
 *
 * Arrays are serialised in their declared order (order is meaningful for an array). Object keys
 * are sorted with `Array.prototype.sort()`'s default lexicographic comparator.
 *
 * @param value - The value to serialise.
 * @returns A canonical JSON string representation of `value`.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalStringify(v)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}'
}
