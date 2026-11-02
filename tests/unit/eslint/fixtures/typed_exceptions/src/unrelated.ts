/**
 * An UNRELATED class whose overloads merely LOOK like the `CreatedException<T>` args shape: one
 * constructor overload takes a non-empty TUPLE as its first parameter (with a sibling second
 * parameter) and another accepts a scalar — exactly the two-signature silhouette the typed path's
 * signature scan was matching on its own.
 *
 * @remarks
 * This class derives from `Error`, never from the ADK exception base. Its scalar construction is a
 * legitimate overload of its own — the typed arm must NOT flag it merely because the shape fits
 * (`derivesFromAdkException` is the gate that keeps the signature scan from firing here).
 */
export class UnrelatedBatch {
  constructor(items: [string, string], options?: { keep?: boolean })
  constructor(items: string)
  constructor(items: string | [string, string], options?: { keep?: boolean }) {
    void items
    void options
  }
}
