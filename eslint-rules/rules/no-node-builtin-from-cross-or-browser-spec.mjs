const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '*.cross.spec.ts and *.browser.spec.ts must not import from `node:*` (cross-env specs run in both node and browser projects).',
    },
    schema: [],
    messages: {
      noNodeBuiltin:
        'Cross-env and browser specs must not import from `node:*`. Move the test to a `*.node.spec.ts` (it will run only in the node project) or rewrite the test to avoid the node builtin.',
    },
  },
  create(context) {
    function check(node) {
      const source = node.source && node.source.value
      if (typeof source !== 'string') return
      if (source.startsWith('node:')) {
        context.report({ node: node.source, messageId: 'noNodeBuiltin' })
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
