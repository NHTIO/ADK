import type { ArtifactClassLike, ArtifactMethodDescriptor } from './types'

/**
 * The effective, deduped set of artifact method descriptors reachable on a class, leaf-first up
 * the static prototype chain.
 *
 * WHY THE WALK IS NECESSARY — DO NOT "SIMPLIFY" THIS BACK TO `ctor.toolMethods`.
 *
 * Core's `static toolMethods` SHADOWS rather than concatenates. `spooled_artifact.ts:232-240`
 * states it outright: *"Each `toolMethods` array lists **only** its own class's descriptors —
 * subclasses do not concatenate inherited descriptors."* So `SpooledJsonArtifact.toolMethods` is
 * its seven JSON descriptors and nothing else; the base seven (`artifact_head`, `artifact_tail`,
 * `artifact_grep`, `artifact_cat`, `artifact_byte_length`, `artifact_line_count`,
 * `artifact_estimate_tokens`) live on `SpooledArtifact` and are composed at a DIFFERENT layer —
 * `SpooledJsonArtifact.forgeTools` calls `SpooledArtifact.forgeTools(ctx)` and merges registries.
 *
 * Reading the leaf static alone would therefore wrongly exclude the base methods: a consumer (or
 * freeze, or the transform runtime) that trusted `instance.constructor.toolMethods` would
 * advertise a vocabulary missing `artifact_head`/`_tail`/`_grep`/`_cat` on every JSON or Markdown
 * artifact, and would refuse a `transform` step that names one. There is no helper in core that
 * unions the chain, so this battery ships the one place the union is computed.
 *
 * The walk:
 *  1. Start at `ctor` and walk up via `Object.getPrototypeOf` until `Function.prototype` or null.
 *  2. At each class take ONLY its own `toolMethods`, via `Object.getOwnPropertyDescriptor` — an
 *     inherited static must not be collected twice.
 *  3. Collect leaf-first, deduping by descriptor `name` with NEAREST CLASS WINS (the first
 *     occurrence encountered wins). This matches the `Tool.onCollision = 'replace'` semantics core
 *     documents for the same overlap.
 *  4. A class with no `toolMethods` anywhere yields an empty array — never throw.
 *
 * Verified against the real classes: `effectiveToolMethods(SpooledJsonArtifact)` has 14 entries
 * and includes `artifact_head`; `SpooledMarkdownArtifact` has 15; `SpooledArtifact` itself has 7.
 *
 * @param ctor The artifact class whose effective descriptor set is wanted. Structural
 *   (`ArtifactClassLike`), so the battery never imports the core classes.
 * @returns A frozen, readonly array of descriptors, leaf-first, deduped by `name` with
 *   nearest-class-wins. Empty when no class in the chain declares `toolMethods`.
 */
export const effectiveToolMethods = (
  ctor: ArtifactClassLike
): readonly ArtifactMethodDescriptor[] => {
  const seen = new Set<string>()
  const out: ArtifactMethodDescriptor[] = []

  let c: unknown = ctor
  while (c !== null && c !== Function.prototype) {
    const own = Object.getOwnPropertyDescriptor(c, 'toolMethods')
    if (own && 'value' in own) {
      const value = own.value
      if (Array.isArray(value)) {
        for (const d of value) {
          if (
            d &&
            typeof d === 'object' &&
            typeof (d as ArtifactMethodDescriptor).name === 'string'
          ) {
            const name = (d as ArtifactMethodDescriptor).name
            if (!seen.has(name)) {
              seen.add(name)
              out.push(d as ArtifactMethodDescriptor)
            }
          }
        }
      }
      // A `toolMethods` value that is not an array is ignored defensively — never throw.
    }
    c = Object.getPrototypeOf(c)
  }

  return Object.freeze(out)
}
