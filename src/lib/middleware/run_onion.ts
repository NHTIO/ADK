import { Middleware } from '@nhtio/middleware'
import type { NextFn } from '@nhtio/middleware'

/**
 * Execute an asynchronous middleware onion around a terminal operation.
 *
 * A fresh runner is deliberately created for each invocation: middleware runners are single-use.
 * Errors are captured and re-thrown unchanged — including a thrown `undefined`, which a
 * value-based sentinel would silently swallow — while a chain that stops without invoking its
 * terminal operation is reported through `onNoNext`.
 */
export const runOnion = async <Ctx, Res>(
  ctx: Ctx,
  use: readonly ((ctx: Ctx, next: NextFn) => void | Promise<void>)[],
  core: () => Promise<Res>,
  onNoNext: () => never
): Promise<Res> => {
  if (use.length === 0) return core()

  const middleware = new Middleware<(ctx: Ctx, next: NextFn) => void | Promise<void>>()
  for (const fn of use) middleware.add(fn)

  let result!: Res
  let terminalInvoked = false
  let caught: unknown
  // `didCatch` rather than testing `caught !== undefined`: `throw undefined` is legal JS, and a
  // value test cannot tell it from "nothing was thrown" — the chain would resolve as a success.
  let didCatch = false
  await middleware
    .runner()
    .errorHandler(async (error: unknown) => {
      didCatch = true
      caught = error
    })
    .finalHandler(async () => {
      terminalInvoked = true
      result = await core()
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (didCatch) throw caught
  if (!terminalInvoked) return onNoNext()
  return result
}
