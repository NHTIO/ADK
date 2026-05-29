const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Bare `value instanceof Class` is cross-realm fragile; use isInstanceOf(value, 'Class', Class) from src/lib/utils/guards.ts, or add a tactical disable comment with a reason.",
    },
    schema: [],
    messages: {
      preferIsInstanceOf:
        "Bare 'instanceof {{name}}' is cross-realm fragile. Use isInstanceOf(value, '{{name}}', {{name}}) (import from src/lib/utils/guards.ts), or add an eslint-disable-next-line comment with the reason this site is exempt. See CONTRIBUTING.md §Class identity guards.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== 'instanceof') return
        if (!node.right || node.right.type !== 'Identifier') return
        // Coordinated handoff: `instanceof Error` is owned by adk/prefer-is-error,
        // which delivers the more specific guidance (isError, not isInstanceOf).
        if (node.right.name === 'Error') return
        context.report({
          node,
          messageId: 'preferIsInstanceOf',
          data: { name: node.right.name },
        })
      },
    }
  },
}

export default rule
