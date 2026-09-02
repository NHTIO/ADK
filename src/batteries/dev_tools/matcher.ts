/** Small, case-sensitive matcher for the dev-tools path grammar. */
export const isPattern = (s: string): boolean => s.includes('*')

/** Validate and normalize one dev-tools path pattern. */
export const validatePattern = (input: string): string => {
  const parts = input.trim().replaceAll('\\', '/').split('/').filter(Boolean)
  for (const part of parts) {
    if (part.includes('**') && part !== '**') throw new Error(`invalid glob segment "${part}"`)
    if (/[?\[\]{}!^]/.test(part)) throw new Error(`unsupported glob syntax in "${part}"`)
  }
  const out: string[] = []
  for (const part of parts) if (part !== '**' || out[out.length - 1] !== '**') out.push(part)
  return out.join('/')
}

const segment = (pattern: string, name: string): boolean => {
  let p = 0
  let n = 0
  let star = -1
  let mark = 0
  while (n < name.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === name[n]) {
      p++
      n++
      continue
    }
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = n
      continue
    }
    if (star >= 0) {
      p = star + 1
      n = ++mark
      continue
    }
    return false
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** Match a normalized glob against a workspace-relative path. */
export const globMatches = (pattern: string, path: string): boolean => {
  const patterns = pattern.split('/')
  const paths = path.split('/')
  const go = (i: number, j: number): boolean => {
    if (i === patterns.length) return j === paths.length
    if (patterns[i] === '**') {
      if (go(i + 1, j)) return true
      return j < paths.length && !paths[j].startsWith('.') && go(i, j + 1)
    }
    if (j === paths.length) return false
    if (paths[j].startsWith('.') && !patterns[i].startsWith('.')) return false
    return segment(patterns[i], paths[j]) && go(i + 1, j + 1)
  }
  return go(0, 0)
}

/** Match either a literal path or a glob path. */
export const pathMatches = (pattern: string, path: string): boolean =>
  isPattern(pattern) ? globMatches(pattern, path) : pattern === path

/** Return the extension after the final dot, excluding dot-leading names. */
export const extensionOf = (path: string): string => {
  const name = path.split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

const segmentOverlap = (a: string, b: string): boolean => {
  const chars = new Set([...a, ...b].filter((char) => char !== '*'))
  chars.add('a')
  const queue: Array<[number, number]> = [[0, 0]]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const [i, j] = queue.shift()!
    const key = `${i},${j}`
    if (seen.has(key)) continue
    seen.add(key)
    if (i === a.length && j === b.length) return true
    if (i < a.length && a[i] === '*') queue.push([i + 1, j])
    if (j < b.length && b[j] === '*') queue.push([i, j + 1])
    if (i >= a.length || j >= b.length) continue
    if (a[i] === '*' && b[j] === '*') {
      queue.push([i + 1, j], [i, j + 1])
      continue
    }
    if (a[i] === '*') {
      if (b[j] !== '*') queue.push([i, j + 1], [i + 1, j])
      continue
    }
    if (b[j] === '*') {
      queue.push([i + 1, j], [i, j + 1])
      continue
    }
    if (a[i] === b[j]) queue.push([i + 1, j + 1])
  }
  return false
}

/** Determine whether two normalized patterns have a common matching path. */
export const patternsOverlap = (a: string, b: string): boolean => {
  const aa = a.split('/')
  const bb = b.split('/')
  const go = (i: number, j: number): boolean => {
    if (i === aa.length && j === bb.length) return true
    if (i === aa.length) return j < bb.length && bb[j] === '**' && go(i, j + 1)
    if (j === bb.length) return i < aa.length && aa[i] === '**' && go(i + 1, j)
    if (aa[i] === '**') {
      // ** may consume only non-dot path segments.
      return go(i + 1, j) || (bb[j] !== '**' && !bb[j].startsWith('.') && go(i, j + 1))
    }
    if (bb[j] === '**') return go(i, j + 1) || (!aa[i].startsWith('.') && go(i + 1, j))
    if (aa[i].startsWith('.') !== bb[j].startsWith('.')) return false
    return segmentOverlap(aa[i], bb[j]) && go(i + 1, j + 1)
  }
  return go(0, 0)
}

/** Determine whether a directory prefix can still contain a path matching a pattern. */
export const patternCanContinue = (pattern: string, prefix: string): boolean => {
  const parts = pattern.split('/').filter(Boolean)
  const prefixParts = prefix.split('/').filter(Boolean)
  const walk = (i: number, j: number): boolean => {
    if (j === prefixParts.length) return i < parts.length
    if (i === parts.length) return false
    if (parts[i] === '**') {
      return walk(i + 1, j) || (!prefixParts[j].startsWith('.') && walk(i, j + 1))
    }
    if (prefixParts[j].startsWith('.') && !parts[i].startsWith('.')) return false
    return segment(parts[i], prefixParts[j]) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}
