/**
 * Repo-internal, file-glob-scoped sibling of the published `adk/require-string-empty-disposition`
 * rule (`src/eslint/rules/require_string_empty_disposition.ts`). Flags a `validator.string()`
 * chain that is `.optional()`/`.default(...)`-shaped but has no explicit empty-string disposition —
 * confirmed empirically against the actual installed `@nhtio/validation` package (Joi under the
 * hood): `validator.string()` rejects `""` regardless of `.optional()`/`.default()`/`.required()`
 * unless `.allow('')`/`.empty('')`/a `.valid(...)` enum is present. A model filling in a tool call
 * will often send `""` instead of omitting an unwanted optional parameter — without an explicit
 * disposition, that fails schema validation instead of degrading gracefully.
 *
 * Scope, deliberately broader than the published copy, and deliberately NOT the same detection
 * algorithm (the two copies are different implementations with different detection surfaces — see
 * the plan's Part 0 "Point 2"): this rule is scoped by FILE GLOB, in `eslint.config.mjs`'s own
 * config object for this rule (`src/batteries/tools/**`, `src/batteries/sandbox/**`,
 * `src/batteries/media/**`) — not to a literal `inputSchema` AST position. Within that file-glob
 * scope it recognizes exactly three shapes:
 *
 *   - Shape A — a simple chain: `validator.string()...` all in one expression, or a sequence of
 *     direct, unconditional `v = v.<chain>` reassignments to the same variable, outside any
 *     conditional/loop/switch/try context. A reassignment that is a ternary, a logical
 *     short-circuit used for value selection, re-rooted (a fresh `validator.string()` call, not
 *     `v.` anything), the result of an opaque function call, a destructuring assignment, or sits
 *     inside any conditional/loop/switch/try disqualifies the variable from Shape A entirely (not
 *     partially — fully out of scope, same as any other unrecognized shape).
 *   - Shape B — the bounded, single-`if`-with-no-`else` case: the ENTIRE function contains exactly
 *     one write to the tracked variable inside any conditional/loop/switch/try context at all, and
 *     that one write is a single `if` with no `else`/`else if`, whose test expression contains no
 *     assignment/update/write to the tracked variable, immediately following the variable's most
 *     recent Shape-A reassignment (no further reassignment of the variable after the `if`). If the
 *     pre-`if` (Shape-A) assignments are `.optional()`/`.default(...)`-shaped with no clearing
 *     method among THEM specifically, this is reportable — regardless of what the `if` body itself
 *     does, since the untaken/false path never executes it. A second qualifying-looking `if`
 *     anywhere else in the function disqualifies the variable from Shape B entirely (the rule
 *     reports nothing, rather than guess based on only the nearer `if`).
 *   - Shape C — the `ScrapperParamSpec`-shaped object-literal pattern: a `schema:` property inside
 *     an object literal that also has `key`/`wire`/`type`/`description` properties, where the
 *     `schema:` value is itself a bare `validator.string()`-rooted chain with no clearing method.
 *     Flagged directly at the object-literal site — this does NOT trace `spec.schema` through
 *     whatever helper function eventually calls `.optional()`/`.default()` on it (e.g.
 *     `buildScrapperSchema`); it pattern-matches the known shape instead, the same way
 *     `no-shadowed-engine` reasons from a hand-known factory summary rather than executing code.
 *     This is inherently a heuristic — it will not generalize to a spec object with a different
 *     property-naming convention.
 *
 * `switch` statements are PERMANENTLY, UNCONDITIONALLY out of scope — this rule does not attempt to
 * analyze them in any form. Three separate attempts at a bounded switch-handling shape (in earlier
 * drafts of the design this rule implements) were each shown unsound or factually wrong against
 * real code in this repository (`src/batteries/media/forge.ts`'s `granularSchemaFor`,
 * specifically) — the design deliberately abandons switch-handling entirely rather than risk a
 * fourth wrong attempt. A variable whose only string-rooted assignment lives inside a `switch` case
 * is not tracked at all, and the rule reports nothing for it — a known, permanent, deliberate
 * coverage gap, not a bug. (`granularSchemaFor`'s real bug is fixed manually, verified by direct
 * source reading, not caught by this rule.)
 *
 * Clearing methods (an unambiguous empty-string disposition — any one of these clears the rule for
 * the tracked assignments it applies to):
 *   - `.allow('')`  — only when a `''` string literal is among the call's arguments; `.allow(null)`
 *     alone does NOT clear it (confirmed empirically: `.allow(null)` still rejects `''`).
 *   - `.empty('')`  — same argument-literal check.
 *   - `.valid(...)` — ANY `.valid(...)` call clears the rule, regardless of whether `''` is among
 *     its arguments (Policy A: an explicit closed enum is sufficient, intentional disposition on
 *     its own).
 *   - `.forbidden()` — the value must be absent entirely; trivially clears.
 *
 * Opt-out (e.g. a deliberately strict optional/default string that should keep rejecting `''`):
 *   // eslint-disable-next-line adk/require-string-empty-disposition -- <reason>
 */

// ── Chain-walking primitives (mirrors require-validator-any-required.mjs's approach) ─────────────

// The base identifier a member/call chain roots at, e.g. `validator` in `validator.string()`.
const baseIdentifierName = (node) => {
  let cur = node
  while (cur) {
    if (cur.type === 'Identifier') return cur.name
    if (cur.type === 'MemberExpression') {
      cur = cur.object
      continue
    }
    if (cur.type === 'CallExpression') {
      cur = cur.callee
      continue
    }
    return undefined
  }
  return undefined
}

// `validator.string()` — the one root shape a tracked chain must start from, directly.
const isValidatorStringRootCall = (node) =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  node.callee.property.type === 'Identifier' &&
  node.callee.property.name === 'string' &&
  baseIdentifierName(node.callee.object) === 'validator'

const callMethodName = (call) =>
  call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier'
    ? call.callee.property.name
    : undefined

// Find the `validator.string()` CallExpression nested at the innermost root of `expr`'s
// member/call chain, if any (`expr` may itself already BE that call, or a longer chain built on
// top of it, e.g. `validator.string().optional()`).
const findValidatorStringRoot = (expr) => {
  let cur = expr
  while (cur) {
    if (cur.type === 'CallExpression') {
      if (isValidatorStringRootCall(cur)) return cur
      cur = cur.callee.type === 'MemberExpression' ? cur.callee.object : undefined
      continue
    }
    if (cur.type === 'MemberExpression') {
      cur = cur.object
      continue
    }
    return undefined
  }
  return undefined
}

// Collect every CallExpression from `rootCall` (a `validator.string()` call) out to the end of
// whatever chain it's embedded in, via `.parent` links (`v.string()` -> `.optional` -> `.optional()`).
const collectChainCallsFrom = (rootCall) => {
  const calls = [rootCall]
  let cur = rootCall
  for (;;) {
    const p = cur.parent
    if (!p) break
    if (p.type === 'MemberExpression' && p.object === cur) {
      cur = p
      continue
    }
    if (p.type === 'CallExpression' && p.callee === cur) {
      calls.push(p)
      cur = p
      continue
    }
    break
  }
  return calls
}

// Collect every CallExpression within `expr` itself (walking inward via `.object`/`.callee`,
// starting from `expr`'s own outermost point) — used for a fresh reassignment RHS expression,
// where we want just the calls written in THIS expression, not a `.parent`-walk (which would
// wander into whatever the reassignment's own enclosing statement happens to be).
const collectCallsWithinExpression = (expr) => {
  const calls = []
  let cur = expr
  while (cur) {
    if (cur.type === 'CallExpression') {
      calls.push(cur)
      cur = cur.callee.type === 'MemberExpression' ? cur.callee.object : undefined
      continue
    }
    if (cur.type === 'MemberExpression') {
      cur = cur.object
      continue
    }
    break
  }
  return calls
}

const chainHasMethod = (calls, name) => calls.some((c) => callMethodName(c) === name)

const isEmptyLiteralArg = (node) => node.type === 'Literal' && node.value === ''

const chainHasEmptyStringClear = (calls) =>
  calls.some((c) => {
    const name = callMethodName(c)
    return (name === 'allow' || name === 'empty') && c.arguments.some(isEmptyLiteralArg)
  })

// Does this collected call list carry an explicit empty-string disposition (a clearing method)?
const chainHasClearingMethod = (calls) =>
  chainHasMethod(calls, 'forbidden') ||
  chainHasMethod(calls, 'valid') || // Policy A: any .valid(...) alone is sufficient
  chainHasEmptyStringClear(calls)

// Is this collected call list .optional()/.default(...)-shaped, with no clearing method among
// these same calls? (Shape A/B's trigger condition — a bare/`.required()`-only chain is a
// different contract this rule does not police.)
const isReportableChain = (calls) => {
  if (!chainHasMethod(calls, 'optional') && !chainHasMethod(calls, 'default')) return false
  return !chainHasClearingMethod(calls)
}

// ── Generic subtree walk, never crossing into nested function scopes ──────────────────────────

const isFunctionNode = (node) =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression'

const walkSkippingNestedFunctions = (node, visit) => {
  const recurse = (n, isRoot) => {
    if (!isRoot && isFunctionNode(n)) return
    visit(n)
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue
      const value = n[key]
      const children = Array.isArray(value) ? value : [value]
      for (const child of children) {
        if (!child || typeof child !== 'object' || typeof child.type !== 'string') continue
        recurse(child, false)
      }
    }
  }
  recurse(node, true)
}

// ── Control-flow containment ────────────────────────────────────────────────────────────────────

const CONTROL_FLOW_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'SwitchCase',
  'TryStatement',
  'CatchClause',
  'ConditionalExpression',
])

// Is `node` situated inside a conditional/loop/switch/try context, stopping the ancestor walk at
// `boundary` (the enclosing function/Program node)?
const isInsideControlFlow = (node, boundary) => {
  let cur = node.parent
  while (cur && cur !== boundary) {
    if (CONTROL_FLOW_TYPES.has(cur.type)) return true
    cur = cur.parent
  }
  return false
}

// ── Per-function event collection (declarators + plain-identifier assignments + if statements) ──

// The lexical BLOCK a `let`/`var`/`const` declaration belongs to. Two declarations of the same
// identifier in different blocks are different bindings and must never share an event list —
// grouping by name alone let a nested block's `schema` join the outer one's chain, where its
// re-root at `validator.string()` disqualified the outer variable and silently suppressed a real
// finding on it. Keying by (declaring block, name) keeps them independent.
//
// This is deliberately a lexical-block approximation rather than full scope-manager resolution:
// it is exact for the `let`/`var`/`const`-in-a-block shapes this rule claims to analyze, and the
// rule already reports nothing for anything more exotic.
const enclosingBlockOf = (node, stopAt) => {
  let cur = node.parent
  while (cur && cur !== stopAt.parent) {
    if (
      cur.type === 'BlockStatement' ||
      cur.type === 'Program' ||
      cur.type === 'StaticBlock' ||
      cur.type === 'ForStatement' ||
      cur.type === 'ForOfStatement' ||
      cur.type === 'ForInStatement' ||
      cur.type === 'SwitchStatement'
    ) {
      return cur
    }
    cur = cur.parent
  }
  return stopAt
}

const collectFunctionEvents = (fnNode, body) => {
  const events = [] // { name, bindingKey, rhs, node, insideControlFlow }
  const ifStatements = []
  // Declaring block per identifier, in walk (source) order. An ASSIGNMENT is attributed to the
  // innermost declaration that already introduced that name, mirroring ordinary lexical lookup.
  const declaredBlocks = new Map() // name -> Set<blockNode>

  walkSkippingNestedFunctions(body, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      // `var` is FUNCTION-scoped: it hoists out of whatever block it is written in, so every `var`
      // declaration and every write to that name share ONE binding keyed to the function body.
      // Only `let`/`const` create a per-block binding. Keying a `var` to its literal block would
      // split one binding in two and lose a clearing method applied in a different block.
      const isVar = node.parent?.type === 'VariableDeclaration' && node.parent.kind === 'var'
      const block = isVar ? body : enclosingBlockOf(node, body)
      if (!declaredBlocks.has(node.id.name)) declaredBlocks.set(node.id.name, new Set())
      declaredBlocks.get(node.id.name).add(block)
      events.push({
        name: node.id.name,
        bindingKey: block,
        rhs: node.init,
        node,
        insideControlFlow: isInsideControlFlow(node, fnNode),
      })
    } else if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left.type === 'Identifier'
    ) {
      // Walk outward from the assignment to the first block that declares this name; that is the
      // binding it writes to.
      const declared = declaredBlocks.get(node.left.name)
      let bindingKey = body
      if (declared) {
        let cur = node.parent
        while (cur && cur !== body.parent) {
          if (declared.has(cur)) {
            bindingKey = cur
            break
          }
          cur = cur.parent
        }
      }
      events.push({
        name: node.left.name,
        bindingKey,
        rhs: node.right,
        node,
        insideControlFlow: isInsideControlFlow(node, fnNode),
      })
    } else if (node.type === 'IfStatement') {
      ifStatements.push(node)
    }
  })

  return { events, ifStatements }
}

// Is `rhs` a reassignment shape that Shape A disqualifies outright (ternary, or a logical
// short-circuit used for value selection)? Anything else (a plain member/call chain, a fresh
// re-root, an opaque call, whatever) is handled by the caller's own rooted-in-identifier check.
const isDisqualifyingRhsShape = (rhs) =>
  rhs.type === 'ConditionalExpression' || rhs.type === 'LogicalExpression'

// Does `rhs`'s chain root DIRECTLY in a bare reference to identifier `name` (zero or more member/
// call steps on top, applying zero or more Joi builder methods)?
const chainRootsAtIdentifier = (rhs, name) => {
  let cur = rhs
  while (cur) {
    if (cur.type === 'Identifier') return cur.name === name
    if (cur.type === 'MemberExpression') {
      cur = cur.object
      continue
    }
    if (cur.type === 'CallExpression') {
      cur = cur.callee
      continue
    }
    return false
  }
  return false
}

// Build the Shape-A straight-line chain-call union for one variable, given its ordered
// straight-line (non-control-flow) events. Returns:
//   { rooted: false }                                             — never rooted in this prefix
//   { rooted: true, disqualified: true }                          — grammar violated, fully out
//   { rooted: true, disqualified: false, calls, rootCall }        — a straight-line chain to check
const buildShapeAStraightLineChain = (name, straightLineEvents) => {
  let calls = []
  let rootCall
  let rooted = false

  for (const ev of straightLineEvents) {
    if (!ev.rhs) continue // `let schema` with no initializer — nothing to root on at this event
    if (!rooted) {
      const root = findValidatorStringRoot(ev.rhs)
      if (!root) continue // not yet rooted, and this event isn't validator.string()-rooted either
      calls = collectCallsWithinExpression(ev.rhs)
      rootCall = root
      rooted = true
      continue
    }
    // Already rooted: this reassignment must be a plain, unconditional `v = v.<chain>` continuing
    // the SAME chain, or the variable is fully disqualified from Shape A (not partially).
    if (isDisqualifyingRhsShape(ev.rhs) || !chainRootsAtIdentifier(ev.rhs, name)) {
      return { rooted: true, disqualified: true }
    }
    // APPEND, never overwrite. Each reassignment continues the same chain rooted at the original
    // `validator.string()`, so the modifiers it applies are additive to everything applied before
    // it. Overwriting here made an earlier assignment's clearing method invisible — e.g.
    // `let s = validator.string().allow(''); s = s.optional()` reported a false positive, and the
    // mirror case could miss a genuinely undisposed schema.
    calls.push(...collectCallsWithinExpression(ev.rhs))
  }

  if (!rooted) return { rooted: false }
  return { rooted: true, disqualified: false, calls, rootCall }
}

// Does `testNode`'s subtree contain any assignment, update, or destructuring write to `name`?
const testExpressionWritesTo = (testNode, name) => {
  let found = false
  const patternHasName = (pat) => {
    if (!pat) return false
    if (pat.type === 'Identifier') return pat.name === name
    if (pat.type === 'ObjectPattern') {
      return pat.properties.some((p) => patternHasName(p.value ?? p.argument))
    }
    if (pat.type === 'ArrayPattern') return pat.elements.some((el) => patternHasName(el))
    if (pat.type === 'AssignmentPattern') return patternHasName(pat.left)
    if (pat.type === 'RestElement') return patternHasName(pat.argument)
    return false
  }
  walkSkippingNestedFunctions(testNode, (node) => {
    if (found) return
    if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'Identifier' ? node.left.name === name : patternHasName(node.left)) {
        found = true
      }
      return
    }
    if (
      node.type === 'UpdateExpression' &&
      node.argument.type === 'Identifier' &&
      node.argument.name === name
    ) {
      found = true
    }
  })
  return found
}

// Does `body` (an `if` consequent) contain a plain-identifier assignment to `name`?
const bodyAssignsTo = (body, name) => {
  let found = false
  walkSkippingNestedFunctions(body, (node) => {
    if (found) return
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left.type === 'Identifier' &&
      node.left.name === name
    ) {
      found = true
    }
  })
  return found
}

const isNodeWithin = (node, ancestor) => {
  let cur = node
  while (cur) {
    if (cur === ancestor) return true
    cur = cur.parent
  }
  return false
}

// Find every `if` statement in the function that qualifies as a Shape-B candidate for `name`: no
// `else`/`else if`, test expression doesn't write to `name`, and the consequent assigns `name`.
const findQualifyingShapeBIfs = (name, allIfStatements) =>
  allIfStatements.filter(
    (ifNode) =>
      !ifNode.alternate &&
      !testExpressionWritesTo(ifNode.test, name) &&
      bodyAssignsTo(ifNode.consequent, name)
  )

// Analyze one tracked variable's full ordered event sequence within one function scope, reporting
// via `reportChain` if a Shape A or Shape B finding applies. Scope isolation is structural: this is
// invoked once per (function, variable-name) pair, from `analyzeFunctionScope`, which itself is
// invoked once per function node — nothing here is keyed only by name across functions.
const analyzeTrackedVariable = (name, orderedEvents, allIfStatements, reportChain) => {
  const straightLine = []
  for (const ev of orderedEvents) {
    if (ev.insideControlFlow) break
    straightLine.push(ev)
  }

  const shapeA = buildShapeAStraightLineChain(name, straightLine)
  if (!shapeA.rooted) return // never rooted at validator.string() in this scope at all
  if (shapeA.disqualified) return // Shape A grammar violated -> fully out of scope

  const remaining = orderedEvents.slice(straightLine.length)
  const hasControlFlowEvent = remaining.some((ev) => ev.insideControlFlow)

  if (!hasControlFlowEvent) {
    // Pure Shape A (no control-flow event for this variable at all in this function).
    if (isReportableChain(shapeA.calls)) reportChain(shapeA.rootCall)
    return
  }

  // At least one in-control-flow write exists for this variable. Shape B applies only when the
  // WHOLE function contains exactly one qualifying conditional write for it.
  const qualifyingIfs = findQualifyingShapeBIfs(name, allIfStatements)
  if (qualifyingIfs.length !== 1) return // zero, or two-or-more -> disqualified entirely

  const qualifyingIf = qualifyingIfs[0]

  // Every in-control-flow event for this variable must live inside exactly this `if`'s body (not
  // its test, not some other conditional/loop/switch/try elsewhere), and nothing after it.
  const allControlFlowEventsAreInsideQualifyingIfBody = remaining.every(
    (ev) => ev.insideControlFlow && isNodeWithin(ev.node, qualifyingIf.consequent)
  )
  if (!allControlFlowEventsAreInsideQualifyingIfBody) return

  // Reportability depends only on the pre-if (Shape-A) assignments, never on the if body's own
  // chain — the untaken/false path never executes the if body, so the if body's own disposition
  // (or lack of one) is irrelevant to whether the falsy path is missing a disposition.
  if (isReportableChain(shapeA.calls)) reportChain(shapeA.rootCall)
}

const analyzeFunctionScope = (fnNode) => {
  const body = fnNode.type === 'Program' ? fnNode : fnNode.body
  if (!body) return null
  return collectFunctionEvents(fnNode, body)
}

// ── Shape C: ScrapperParamSpec-shaped object literal ──────────────────────────────────────────

const literalKey = (prop) => {
  if (prop.type !== 'Property' || prop.computed) return undefined
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return undefined
}

// Is `stringCallNode` (a `validator.string()` root call) reached, as the FULL chain's terminal
// value, as the RHS of a plain-identifier `let`/`var` declarator or assignment expression? If so,
// the per-function Shape A/B analysis owns reporting for this call, and the generic top-level scan
// must not double-report it.
const isReassignmentTargetRhs = (stringCallNode) => {
  let cur = stringCallNode
  for (;;) {
    const p = cur.parent
    if (!p) return false
    if (p.type === 'MemberExpression' && p.object === cur) {
      cur = p
      continue
    }
    if (p.type === 'CallExpression' && p.callee === cur) {
      cur = p
      continue
    }
    break
  }
  const p = cur.parent
  if (!p) return false
  if (p.type === 'VariableDeclarator' && p.init === cur && p.id.type === 'Identifier') return true
  if (
    p.type === 'AssignmentExpression' &&
    p.operator === '=' &&
    p.right === cur &&
    p.left.type === 'Identifier'
  ) {
    return true
  }
  return false
}

// Is `stringCallNode`'s full chain the value of a `schema:` property inside a
// ScrapperParamSpec-shaped object literal (has `key`/`wire`/`type`/`description` siblings)? The
// dedicated Shape-C ObjectExpression visitor owns reporting for this value — it must not also be
// evaluated (and potentially double-reported, or under-reported since Shape C's own gate doesn't
// require `.optional()`/`.default()`) by the generic chain scan.
const isParamSpecSchemaValue = (stringCallNode) => {
  let cur = stringCallNode
  for (;;) {
    const p = cur.parent
    if (!p) return false
    if (p.type === 'MemberExpression' && p.object === cur) {
      cur = p
      continue
    }
    if (p.type === 'CallExpression' && p.callee === cur) {
      cur = p
      continue
    }
    break
  }
  const p = cur.parent
  if (!p || p.type !== 'Property' || p.value !== cur) return false
  if (literalKey(p) !== 'schema') return false
  const obj = p.parent
  if (!obj || obj.type !== 'ObjectExpression') return false
  const propNames = new Set(obj.properties.map(literalKey).filter(Boolean))
  return (
    propNames.has('key') &&
    propNames.has('wire') &&
    propNames.has('type') &&
    propNames.has('description')
  )
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A `validator.string()` chain that is `.optional()`/`.default(…)`-shaped must carry an explicit empty-string disposition (`.allow('')`, `.empty('')`, a `.valid(...)` enum, or `.forbidden()`). File-glob scoped (tool-schema-bearing battery families); also traces a straight-line reassigned variable, one bounded if-with-no-else, and the ScrapperParamSpec-shaped object-literal pattern. Never analyzes `switch` statements. Opt out with an eslint-disable-next-line adk/require-string-empty-disposition -- <reason> comment.",
    },
    schema: [],
    messages: {
      requireEmptyDisposition:
        "`validator.string()` combined with `.optional()`/`.default(...)` still rejects an empty string unless you also add `.allow('')` (or `.empty('')`, or a `.valid(...)` enum). A model filling in a tool call will often send `\"\"` instead of omitting an unwanted optional parameter — without an explicit disposition, that fails schema validation instead of degrading gracefully. If empty input should genuinely be rejected here, add `// eslint-disable-next-line adk/require-string-empty-disposition -- <reason>`.",
    },
  },
  create(context) {
    const reported = new Set()
    const reportChain = (rootCall) => {
      if (reported.has(rootCall)) return
      reported.add(rootCall)
      const reportNode =
        rootCall.callee.type === 'MemberExpression' ? rootCall.callee.property : rootCall
      context.report({ node: reportNode, messageId: 'requireEmptyDisposition' })
    }

    return {
      // Shape A's degenerate, single-expression case: any bare `validator.string()...` chain that
      // is NOT the RHS of a plain-identifier declarator/assignment (those are owned by the
      // per-function Shape A/B analysis below), and not a Shape-C param-spec `schema:` value
      // (handled separately, since Shape C's own trigger condition doesn't require
      // .optional()/.default() to already be present on the spec's own bare schema) — covers any
      // nested `validator.string()` inside `validator.object({...})`.
      'CallExpression'(node) {
        if (!isValidatorStringRootCall(node)) return
        if (isReassignmentTargetRhs(node)) return
        if (isParamSpecSchemaValue(node)) return
        const calls = collectChainCallsFrom(node)
        if (isReportableChain(calls)) reportChain(node)
      },

      // Shape C: a `schema:` property inside an object literal that also has
      // `key`/`wire`/`type`/`description` properties (the `ScrapperParamSpec` shape) — a bare
      // `validator.string()`-rooted value there, with no clearing method, is flagged directly at
      // the object-literal site, regardless of whether `.optional()`/`.default()` appear on the
      // spec's own schema (they're layered on later by a helper this rule does not trace).
      'ObjectExpression'(node) {
        const propNames = new Set(node.properties.map(literalKey).filter(Boolean))
        if (
          !propNames.has('key') ||
          !propNames.has('wire') ||
          !propNames.has('type') ||
          !propNames.has('description')
        ) {
          return
        }
        const schemaProp = node.properties.find((p) => literalKey(p) === 'schema')
        if (!schemaProp) return
        const rootCall = findValidatorStringRoot(schemaProp.value)
        if (!rootCall) return
        const calls = collectChainCallsFrom(rootCall)
        if (!chainHasClearingMethod(calls)) reportChain(rootCall)
      },

      // Shape A/B: per-function-scope variable tracking, scope-isolated by construction (each
      // function node is visited and analyzed independently).
      ':function'(fnNode) {
        const collected = analyzeFunctionScope(fnNode)
        if (!collected) return
        const { events, ifStatements } = collected
        // Group by BINDING (declaring block + name), never by name alone — see
        // `collectFunctionEvents`. Two same-named bindings in different blocks are independent.
        const byBinding = new Map()
        for (const ev of events) {
          let perBlock = byBinding.get(ev.bindingKey)
          if (!perBlock) {
            perBlock = new Map()
            byBinding.set(ev.bindingKey, perBlock)
          }
          if (!perBlock.has(ev.name)) perBlock.set(ev.name, [])
          perBlock.get(ev.name).push(ev)
        }
        for (const perBlock of byBinding.values()) {
          for (const [name, ordered] of perBlock) {
            analyzeTrackedVariable(name, ordered, ifStatements, reportChain)
          }
        }
      },

      // Module-scope (top-level) `let`/`var` reassignment chains use the same analysis, with the
      // Program node as the function boundary.
      'Program:exit'(programNode) {
        const collected = analyzeFunctionScope(programNode)
        if (!collected) return
        const { events, ifStatements } = collected
        // Group by BINDING (declaring block + name), never by name alone — see
        // `collectFunctionEvents`. Two same-named bindings in different blocks are independent.
        const byBinding = new Map()
        for (const ev of events) {
          let perBlock = byBinding.get(ev.bindingKey)
          if (!perBlock) {
            perBlock = new Map()
            byBinding.set(ev.bindingKey, perBlock)
          }
          if (!perBlock.has(ev.name)) perBlock.set(ev.name, [])
          perBlock.get(ev.name).push(ev)
        }
        for (const perBlock of byBinding.values()) {
          for (const [name, ordered] of perBlock) {
            analyzeTrackedVariable(name, ordered, ifStatements, reportChain)
          }
        }
      },
    }
  },
}

export default rule
