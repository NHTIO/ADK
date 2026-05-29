/**
 * Factory helpers for creating configured runtime values and exception classes.
 *
 * @module @nhtio/adk/factories
 *
 * @remarks
 * Public factory surface for the ADK. A "factory" here means a function that produces a
 * configured runtime value — typically a class or a class instance — rather than a value
 * primitive. The ADK's data primitives (value classes plus their `Raw*` companion types)
 * live in `@nhtio/adk/common`; the ADK's exception classes that are part of the core
 * contract live in `@nhtio/adk/exceptions`. This barrel hosts the factory helpers that
 * downstream consumers (including in-tree batteries) use to mint their own configured
 * runtime values.
 *
 * Today the only factory exposed here is {@link @nhtio/adk/factories!createException}, which mints a named
 * {@link @nhtio/adk!BaseException} subclass with a fixed printf-style message template, error code,
 * HTTP status, and fatality flag. The `BaseException` class itself is re-exported so
 * consumers writing patterns the factory does not cover (e.g. richer constructor signatures
 * carrying structured context payloads) can extend it directly.
 *
 * Battery-scoped exceptions belong in their own battery's barrel — `createException`
 * imported from here is what battery code calls to mint them. The ADK's core exception
 * module (`@nhtio/adk/exceptions`) does not grow a new symbol every time a battery is added.
 *
 * Future factories (middleware factories, helper-builder factories, etc.) will be added
 * here as they appear.
 */

/**
 * @primaryExport
 */
export { createException } from './lib/utils/exceptions'
/**
 * @primaryExport
 */
export { BaseException } from './lib/classes/base_exception'
/**
 * @primaryExport
 */
export type { ExceptionOptions, CreatedException } from './lib/utils/exceptions'
