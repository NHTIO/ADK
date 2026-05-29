const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Functional tests must import from public barrels (@nhtio/adk/*) only, not from src/lib/.',
    },
    schema: [],
    messages: {
      publicBarrelOnly:
        'Functional tests must import from public barrels (src/*.ts or @nhtio/adk/*) only, not from src/lib/. Move the symbol to a public barrel if it is genuinely needed in a functional test.',
    },
  },
  create(context) {
    function check(node) {
      const source = node.source && node.source.value
      if (typeof source !== 'string') return
      if (source.includes('src/lib/')) {
        context.report({ node: node.source, messageId: 'publicBarrelOnly' })
      }
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    }
  },
}

export default rule
