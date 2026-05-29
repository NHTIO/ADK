const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Bare `value instanceof Error` must be replaced with isError(value) from src/lib/utils/guards.ts.',
    },
    schema: [],
    messages: {
      preferIsError:
        "Use isError({{lhs}}) from src/lib/utils/guards.ts instead of 'instanceof Error', or add an eslint-disable-next-line comment with the reason. See README.md §Prefer shared guards over inline type checks.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    return {
      BinaryExpression(node) {
        if (node.operator !== 'instanceof') return
        if (!node.right || node.right.type !== 'Identifier' || node.right.name !== 'Error') return
        const lhs = sourceCode.getText(node.left)
        context.report({ node, messageId: 'preferIsError', data: { lhs } })
      },
    }
  },
}

export default rule
