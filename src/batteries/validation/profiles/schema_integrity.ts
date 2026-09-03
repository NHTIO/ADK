/**
 * A declared tool's input schema must be internally satisfiable.
 *
 * @remarks
 * MEASURED, and the most insidious failure in this catalog. A schema whose `required` list names a
 * key its `properties` does not define cannot be satisfied by ANY argument object. Nova answers
 * such a request with a normal HTTP 200 that simply omits the field — a production gateway records
 * 25 responses silently missing it, with no error at any layer.
 *
 * The usual source is a schema-sanitising pass that strips a keyword from `properties` without
 * pruning the matching entry from `required` — `title` is both a JSON Schema annotation and an
 * ordinary property name, so a blind strip removes the user's field and leaves the requirement.
 *
 * Unlike every other rule here, this one inspects the TOOL DECLARATION rather than turn state, so
 * it catches the defect before a single token is generated.
 */
import type { OrderingProfile } from '../types'

export const schemaIntegrity: OrderingProfile = {
  name: 'schema-integrity',
  description:
    'Every key in a tool schema `required` list must exist in `properties`; an unsatisfiable ' +
    'schema makes providers return a 200 that silently omits the field.',
  rules: [
    {
      type: 'schemaIntegrity',
      id: 'required-keys-must-exist-in-properties',
    },
  ],
}
