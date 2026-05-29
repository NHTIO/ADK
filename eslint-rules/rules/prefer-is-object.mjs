function flattenAnd(node, out) {
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    flattenAnd(node.left, out)
    flattenAnd(node.right, out)
  } else {
    out.push(node)
  }
}

function typeofObjectIdent(operand) {
  if (operand.type !== 'BinaryExpression') return null
  if (operand.operator !== '===' && operand.operator !== '==') return null
  let typeofSide = null
  let literalSide = null
  if (operand.left.type === 'UnaryExpression' && operand.left.operator === 'typeof') {
    typeofSide = operand.left
    literalSide = operand.right
  } else if (operand.right.type === 'UnaryExpression' && operand.right.operator === 'typeof') {
    typeofSide = operand.right
    literalSide = operand.left
  }
  if (!typeofSide || !literalSide) return null
  if (literalSide.type !== 'Literal' || literalSide.value !== 'object') return null
  if (typeofSide.argument.type !== 'Identifier') return null
  return typeofSide.argument.name
}

function nullCheckIdent(operand) {
  if (operand.type !== 'BinaryExpression') return null
  if (operand.operator !== '!==' && operand.operator !== '!=') return null
  let idSide = null
  let nullSide = null
  if (operand.left.type === 'Identifier') {
    idSide = operand.left
    nullSide = operand.right
  } else if (operand.right.type === 'Identifier') {
    idSide = operand.right
    nullSide = operand.left
  }
  if (!idSide || !nullSide) return null
  if (nullSide.type !== 'Literal' || nullSide.value !== null) return null
  return idSide.name
}

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "Inline object shape checks (`typeof x === 'object' && x !== null`) must use isObject(x) from src/lib/utils/guards.ts.",
    },
    schema: [],
    messages: {
      preferIsObject:
        'Inline object shape check. Use isObject({{ident}}) from src/lib/utils/guards.ts, or add an eslint-disable-next-line comment with the reason. See README.md §Prefer shared guards over inline type checks.',
    },
  },
  create(context) {
    return {
      LogicalExpression(node) {
        if (node.operator !== '&&') return
        // Avoid double-reporting on nested && chains — only inspect the top-level && expression.
        if (
          node.parent &&
          node.parent.type === 'LogicalExpression' &&
          node.parent.operator === '&&'
        )
          return
        const operands = []
        flattenAnd(node, operands)
        let typeofIdent = null
        let nullIdent = null
        for (const op of operands) {
          if (!typeofIdent) {
            const t = typeofObjectIdent(op)
            if (t) typeofIdent = t
          }
          if (!nullIdent) {
            const n = nullCheckIdent(op)
            if (n) nullIdent = n
          }
        }
        if (typeofIdent && nullIdent && typeofIdent === nullIdent) {
          context.report({ node, messageId: 'preferIsObject', data: { ident: typeofIdent } })
        }
      },
    }
  },
}

export default rule
