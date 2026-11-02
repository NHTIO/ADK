import { describe, expect, test, afterAll } from 'vitest'
import { RuleTester } from '@typescript-eslint/rule-tester'
import {
  plugin as sandboxPlugin,
  configs as sandboxConfigs,
  rules as sandboxRules,
} from '../../../../src/batteries/sandbox/lint'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals).
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const ruleTester = new RuleTester()

ruleTester.run('sandbox-require-gate', sandboxRules['require-gate'], {
  valid: [
    // the required shape: a gate is present
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool({ sandbox: enforcer, policy, translator, gate })`,
    },
    // spread could supply the gate -> conservative, no flag
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool({ ...options })`,
    },
    // non-literal argument: nothing to inspect
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool(options)`,
    },
    ...['myGate', '() => true', 'makeGate()', 'class {}'].map((gate) => ({
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'\ncreateRunShellCommandTool({ sandbox: enforcer, policy, translator, gate: ${gate} })`,
    })),
    // a same-named function imported from somewhere else is out of scope
    {
      code: `import { createRunShellCommandTool } from './local'
createRunShellCommandTool({ sandbox: enforcer, policy, translator })`,
    },
    // a TS-wrapped literal that DOES carry a gate stays valid — unwrapping must not invent a finding
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool({ sandbox: enforcer, policy, translator, gate } as ShellConfig)`,
    },
    // an ALIASED import of a gated factory that DOES carry a gate is fine
    {
      code: `import { createRunShellCommandTool as mkShell } from '@nhtio/adk/batteries/sandbox'
mkShell({ sandbox: enforcer, policy, translator, gate })`,
    },
    // a NAMESPACE import that DOES carry a gate is fine
    {
      code: `import * as tools from '@nhtio/adk/batteries/sandbox/tools'
tools.createRunShellCommandTool({ sandbox: enforcer, policy, translator, gate })`,
    },
    // a same-named import from another module is not the battery factory, in any spelling
    {
      code: `import { createRunShellCommandTool as mkShell } from 'acme-sandbox'
mkShell({ sandbox: enforcer, policy, translator })`,
    },
    {
      code: `import * as acme from 'acme-sandbox'
acme.createRunShellCommandTool({ sandbox: enforcer, policy, translator })`,
    },
    // a local object that happens to carry the name is not an import binding
    {
      code: `const tools = { createRunShellCommandTool: (x) => x }
tools.createRunShellCommandTool({ sandbox: enforcer, policy, translator })`,
    },
  ],
  invalid: [
    ...(['undefined', 'null', "'x'", '{}'] as const).map((gate) => ({
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'\ncreateRunShellCommandTool({ sandbox: enforcer, policy, translator, gate: ${gate} })`,
      errors: [{ messageId: 'requireGate' as const }],
    })),
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox/tool'
createRunShellCommandTool({ sandbox: enforcer, policy, translator })`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `import { createEvaluateJavascriptTool } from '@nhtio/adk/batteries/sandbox'
createEvaluateJavascriptTool({ runtime, globals, limits })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // An unimported callee (a snippet, a re-export, a global) is matched by name — the rule does
    // not need to see the import to know the contract.
    {
      code: `createEvaluateJavascriptTool({ runtime, globals, limits })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // a TS expression wrapping the argument must not silence the rule — a gate is still absent
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool({ sandbox: enforcer, policy, translator } as any)`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool({ sandbox: enforcer, policy, translator } satisfies Cfg)`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `import { createRunShellCommandTool } from '@nhtio/adk/batteries/sandbox'
createRunShellCommandTool(<ShellConfig>{ sandbox: enforcer, policy, translator })`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `createRunShellCommandTool((({ sandbox: enforcer, policy, translator })!))`,
      errors: [{ messageId: 'requireGate' }],
    },
    // an ALIASED import of the battery factory names the same export
    {
      code: `import { createRunShellCommandTool as mkShell } from '@nhtio/adk/batteries/sandbox/tools'
mkShell({ sandbox: enforcer, policy, translator })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // a NAMESPACE import names it too
    {
      code: `import * as tools from '@nhtio/adk/batteries/sandbox/tools'
tools.createEvaluateJavascriptTool({ runtime, globals, limits })`,
      errors: [{ messageId: 'requireGate' }],
    },
  ],
})

ruleTester.run('sandbox-no-network-disabled', sandboxRules['no-network-disabled'], {
  valid: [
    // deny-all is the CORRECT spelling: an empty network section
    {
      code: `const policy = {
  filesystem: { allowRead: ['/workspace'], allowWrite: ['/workspace/out'] },
  network: {},
}`,
    },
    // an allow-list is fine
    {
      code: `const policy = {
  filesystem: { denyRead: ['/'] },
  network: { allowedDomains: ['api.example.test'] },
}`,
    },
    // disabled:true WITHOUT a sibling filesystem and without an annotation -> unrelated object,
    // not an ADK policy; conservatively unflagged
    {
      code: `const netOptions = { network: { disabled: true }, retries: 3 }`,
    },
    // disabled: false is not the footgun
    {
      code: `const policy = {
  filesystem: { allowRead: ['/workspace'] },
  network: { disabled: false, allowedDomains: ['api.example.test'] },
}`,
    },
    // spread could carry anything -> conservative
    {
      code: `const policy = { ...base, network: { disabled: true } }`,
    },
    // dynamic disabled value -> ignored
    {
      code: `const policy = {
  filesystem: { allowRead: ['/w'] },
  network: { disabled: isDisabled },
}`,
    },
  ],
  invalid: [
    // the footgun itself: looks like network off, is network UNRESTRICTED
    {
      code: `const handle = await createSandbox({
  policy: {
    filesystem: { allowRead: ['/workspace'], allowWrite: ['/workspace/out'] },
    network: { disabled: true },
  },
})`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
    // annotated SandboxPolicy with no sibling filesystem key
    {
      code: `const policy: SandboxPolicy = { network: { disabled: true } }`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
    // a TS expression wrapping the `disabled` VALUE must not silence the rule
    {
      code: `const policy = {
  filesystem: { allowRead: ['/w'] },
  network: { disabled: true as const },
}`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
    // nor does one wrapping the nested `network` SECTION
    {
      code: `const policy = {
  filesystem: { allowRead: ['/w'] },
  network: { disabled: true } as const,
}`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
    // nor a `satisfies` on the whole policy
    {
      code: `const policy = {
  filesystem: { allowRead: ['/w'] },
  network: { disabled: true },
} satisfies SandboxPolicy`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
    // INTENDED overlap with the skills battery: a `SandboxPolicy`-shaped literal nested in a skills
    // config (the `unsafe.scriptsPermissivePolicy` value) is a real sandbox policy at runtime and is
    // reported here as well as by `adk-skills/no-unsafe-opt-in`.
    {
      code: `createSkillManager({
  sources: [],
  gate,
  unsafe: { scriptsPermissivePolicy: { filesystem: {}, network: { disabled: true } } },
})`,
      errors: [{ messageId: 'disabledMeansUnrestricted' }],
    },
  ],
})

ruleTester.run(
  'sandbox-filesystem-read-default-allow',
  sandboxRules['filesystem-read-default-allow'],
  {
    valid: [
      // the narrow-read idiom: a broad root deny, then re-permit within it
      {
        code: `const policy = {
  filesystem: { denyRead: ['/'], allowRead: ['/workspace'] },
  network: {},
}`,
      },
      // denyRead-only: the battery's documented way to hide specific paths on a host you accept is
      // otherwise readable. It makes no confinement claim, so the rule does not report it.
      {
        code: `const policy = {
  filesystem: { denyRead: ['/etc', '/home'] },
  network: {},
}`,
      },
      // writes only, no read axis configured -> reads are out of scope here
      {
        code: `const policy = {
  filesystem: { allowWrite: ['/workspace/out'] },
  network: {},
}`,
      },
      // kill switch: rules are off entirely
      {
        code: `const policy = {
  filesystem: { disabled: true, allowRead: ['/workspace'] },
  network: {},
}`,
      },
      // broad deny arrives through a spread -> conservative
      {
        code: `const policy = { filesystem: { ...readRules, allowRead: ['/workspace'] } }`,
      },
      // dynamic entries -> ignored
      {
        code: `const policy = { filesystem: { denyRead, allowRead: ['/workspace'] } }`,
      },
      // unannotated literal with no filesystem key is not recognizably a policy
      { code: `const options = { denyRead: ['/etc/passwd'] }` },
      // a section whose spread may carry the broad deny — unwrapping the `as` does not make the
      // spread readable, so the rule stays conservative
      {
        code: `const policy = { filesystem: { ...readRules } as ReadSection, allowRead: ['/w'] }`,
      },
    ],
    invalid: [
      // allowRead with no deny at all: everything not mandatory-denied is still readable
      {
        code: `const policy = {
  filesystem: { allowRead: ['/workspace'], allowWrite: ['/workspace/out'] },
  network: {},
}`,
        errors: [{ messageId: 'readDefaultsToAllow' }],
      },
      // a subtree-only denyRead confines only its own subtrees — the rest of the host is readable
      {
        code: `const policy = {
  filesystem: { denyRead: ['/workspace/.env'], allowRead: ['/workspace'] },
  network: { disabled: false },
}`,
        errors: [{ messageId: 'readDefaultsToAllow' }],
      },
      // annotated policy, no sibling filesystem key needed
      {
        code: `const policy: SandboxPolicy = { filesystem: { allowRead: ['/srv'] }, network: {} }`,
        errors: [{ messageId: 'readDefaultsToAllow' }],
      },
      // a TS expression wrapping the section must not silence the rule
      {
        code: `const policy = { filesystem: { allowRead: ['/workspace'] } as ReadSection, network: {} }`,
        errors: [{ messageId: 'readDefaultsToAllow' }],
      },
      // a broad deny whose list is TS-wrapped is still statically readable — and a subtree deny
      // wrapped the same way is exactly as much of a lone `allowRead` footgun as its bare twin
      {
        code: `const policy = {
  filesystem: { denyRead: (['/workspace/.env'] as const), allowRead: ['/workspace'] },
  network: {},
}`,
        errors: [{ messageId: 'readDefaultsToAllow' }],
      },
    ],
  }
)

describe('adk-sandbox plugin assembly', () => {
  test('exports plugin, rules, and a recommended config with the stated severities', () => {
    expect(sandboxPlugin.meta).toEqual({
      name: '@nhtio/adk/batteries/sandbox/lint',
      version: expect.any(String),
    })
    expect(Object.keys(sandboxPlugin.rules ?? {})).toEqual([
      'no-network-disabled',
      'filesystem-read-default-allow',
      'require-gate',
    ])
    expect(sandboxConfigs.recommended.rules).toEqual({
      'adk-sandbox/no-network-disabled': 'warn',
      'adk-sandbox/filesystem-read-default-allow': 'warn',
      'adk-sandbox/require-gate': 'error',
    })
    expect(sandboxConfigs.recommended.plugins['adk-sandbox']).toBe(sandboxPlugin)
  })

  test('the plugin module is @module-tagged so the lint subpath reaches the published exports map', async () => {
    // The subpath IS the tag: getEntries derives the exports map purely from `@module` lines, so
    // losing the tag from src/batteries/sandbox/lint.ts silently unpublishes this plugin.
    const { getEntries } = await import('../../../../bin/utils/index')
    const { resolve } = await import('node:path')
    const entries = await getEntries(resolve(__dirname, '../../../..', 'src'), '@nhtio/adk')
    expect(entries['batteries/sandbox/lint']).toContain(
      resolve(__dirname, '../../../..', 'src/batteries/sandbox/lint.ts')
    )
  })
})
