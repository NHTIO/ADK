/**
 * A replayed tool result must name a tool the request actually declares.
 *
 * @remarks
 * MEASURED, not documented — this rule exists because of a root cause found in a production
 * gateway, not because a vendor wrote it down.
 *
 * Gemini matches `functionResponse.name` against the request's `functionDeclarations`. A name that
 * resolves to nothing — an opaque call id used in place of the tool name, or a tool that is no
 * longer offered this turn — makes it return an empty candidate (`parts: [{text: ''}]`, `STOP`, no
 * `candidatesTokenCount`) a large fraction of the time. A gateway then forwards that as an ordinary
 * `finish_reason: stop` with `content: null` and NO error, so the caller records a successful turn
 * that produced nothing and loops.
 *
 * That silence is what makes it worth a rule: there is no status code to catch, no error body to
 * classify, and the failure is intermittent rather than deterministic. Advisory by default like the
 * rest of the catalog — but this is a strong candidate for `blocking` on any Gemini-family target.
 */
import type { OrderingProfile } from '../types'

export const toolIdentity: OrderingProfile = {
  name: 'tool-identity',
  description:
    'Every replayed ToolCall must name a tool this request declares; an unresolvable name makes ' +
    'name-matching providers return an empty generation with no error.',
  rules: [
    {
      type: 'toolIdentity',
      id: 'tool-result-names-a-declared-tool',
    },
  ],
}
