import { describe, expect, test, afterAll } from 'vitest'
import { RuleTester } from '@typescript-eslint/rule-tester'
import {
  plugin as skillsPlugin,
  configs as skillsConfigs,
  rules as skillsRules,
} from '../../../../src/batteries/skills/lint'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals).
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const ruleTester = new RuleTester()

ruleTester.run('skills-require-gate', skillsRules['require-gate'], {
  valid: [
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ sources, gate })`,
    },
    ...['myGate', '() => true', 'makeGate()', 'class {}'].map((gate) => ({
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'\ncreateSkillManager({ sources, gate: ${gate} })`,
    })),
    // spread could supply the gate -> conservative
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ ...config })`,
    },
    // non-literal argument
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager(config)`,
    },
    // same-named local function is out of scope
    {
      code: `import { createSkillManager } from './local'
createSkillManager({ sources })`,
    },
    // a TS-wrapped literal that DOES carry a gate stays valid — unwrapping must not invent a finding
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ sources, gate } as SkillManagerConfig)`,
    },
    // an ALIASED import that DOES carry a gate is fine
    {
      code: `import { createSkillManager as csm } from '@nhtio/adk/batteries/skills'
csm({ sources, gate })`,
    },
    // a NAMESPACE import that DOES carry a gate is fine
    {
      code: `import * as skills from '@nhtio/adk/batteries/skills'
skills.createSkillManager({ sources, gate })`,
    },
    // a same-named import from another module is not the battery factory, in any spelling
    {
      code: `import { createSkillManager as csm } from 'acme-skills'
csm({ sources })`,
    },
    {
      code: `import * as acme from 'acme-skills'
acme.createSkillManager({ sources })`,
    },
    // a local object that happens to carry the name is not an import binding
    {
      code: `const skills = { createSkillManager: (x) => x }
skills.createSkillManager({ sources })`,
    },
  ],
  invalid: [
    ...(['undefined', 'null', "'x'", '{}'] as const).map((gate) => ({
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'\ncreateSkillManager({ sources, gate: ${gate} })`,
      errors: [{ messageId: 'requireGate' as const }],
    })),
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ sources })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // unimported callee (snippet / re-export / global) is matched by name
    { code: `createSkillManager({ sources })`, errors: [{ messageId: 'requireGate' }] },
    // a TS expression wrapping the argument must not silence the rule — a gate is still absent
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ sources } as any)`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager({ sources } satisfies Partial<SkillManagerConfig>)`,
      errors: [{ messageId: 'requireGate' }],
    },
    {
      code: `import { createSkillManager } from '@nhtio/adk/batteries/skills'
createSkillManager(<SkillManagerConfig>{ sources })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // a TSNonNullExpression on the ARGUMENT (the literal, not the callee) is equally transparent
    {
      code: `createSkillManager(({ sources })!)`,
      errors: [{ messageId: 'requireGate' }],
    },
    // an ALIASED import names the same export
    {
      code: `import { createSkillManager as csm } from '@nhtio/adk/batteries/skills'
csm({ sources })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // a NAMESPACE import names it too
    {
      code: `import * as skills from '@nhtio/adk/batteries/skills'
skills.createSkillManager({ sources })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // ... from a deeper battery subpath as well
    {
      code: `import * as skills from '@nhtio/adk/batteries/skills/manager'
skills.createSkillManager({ sources })`,
      errors: [{ messageId: 'requireGate' }],
    },
    // the aliased form must still see `gate: undefined` as no gate
    {
      code: `import { createSkillManager as csm } from '@nhtio/adk/batteries/skills'
csm({ sources, gate: undefined })`,
      errors: [{ messageId: 'requireGate' }],
    },
  ],
})

ruleTester.run('skills-no-unsafe-opt-in', skillsRules['no-unsafe-opt-in'], {
  valid: [
    // a disabled/absent unsafe section is the safe default
    { code: `createSkillManager({ sources, gate, unsafe: {} })` },
    { code: `createSkillManager({ sources, gate })` },
    // an unsafe object UNRELATED to a skill config is out of scope
    { code: `const featureFlags = { unsafe: { ungatedSkillTools: true } }` },
    // dynamic value -> ignored
    { code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: flag } })` },
    // spread -> conservative
    { code: `createSkillManager({ sources, gate, unsafe: { ...unsafe } })` },
    // a falsy string is not an enablement
    { code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: '' } })` },
    // an unknown key inside unsafe is not one of the boundary-named controls
    { code: `createSkillManager({ sources, gate, unsafe: { somethingElse: true } })` },
    // an `unsafe` VALUE that is TS-wrapped around a bare identifier is unreadable -> conservative
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools } as SkillManagerConfig })`,
    },
  ],
  invalid: [
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    {
      code: `createSkillManager({ sources, gate, unsafe: { isolatedToolsInProcess: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // scriptsPermissivePolicy enabled as an object literal
    {
      code: `createSkillManager({ sources, gate, scripts, unsafe: { scriptsPermissivePolicy: { filesystem: {}, network: {} } } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // each enabled key reports SEPARATELY
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: true, isolatedToolsInProcess: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }, { messageId: 'unsafeOptIn' }],
    },
    // a truthy string is a literal enablement
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: 'yes' } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // a TS expression wrapping the unsafe SECTION must not silence the rule — the value is still a
    // statically-legible object literal, so the rule's own value test applies beneath the wrapper;
    // the sibling key (`gate`) still marks the outer literal as a skill config
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: { ...flags } } as UnsafeOptions })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // the ENABLED-VALUE wrapper is equally transparent
    {
      code: `createSkillManager({ sources, gate, unsafe: { ungatedSkillTools: (true as const) } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // `satisfies`/`<X>` on the unsafe section, and a `satisfies` on the config literal itself
    {
      code: `createSkillManager({ sources, gate, unsafe: { isolatedToolsInProcess: true } satisfies UnsafeOptions })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    {
      code: `createSkillManager(<SkillManagerConfig>{ sources, gate, unsafe: { ungatedSkillTools: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    // the config recognition is SIBLING-KEY based, not callee-name based: an aliased factory call
    // carrying an unsafe section is reported the same way
    {
      code: `import { createSkillManager as csm } from '@nhtio/adk/batteries/skills'
csm({ sources, gate, unsafe: { ungatedSkillTools: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
    {
      code: `import * as skills from '@nhtio/adk/batteries/skills'
skills.createSkillManager({ sources, gate, unsafe: { isolatedToolsInProcess: true } })`,
      errors: [{ messageId: 'unsafeOptIn' }],
    },
  ],
})

describe('adk-skills plugin assembly', () => {
  test('exports plugin, rules, and a recommended config with the stated severities', () => {
    expect(skillsPlugin.meta).toEqual({
      name: '@nhtio/adk/batteries/skills/lint',
      version: expect.any(String),
    })
    expect(Object.keys(skillsPlugin.rules ?? {})).toEqual(['require-gate', 'no-unsafe-opt-in'])
    expect(skillsConfigs.recommended.rules).toEqual({
      'adk-skills/require-gate': 'error',
      'adk-skills/no-unsafe-opt-in': 'warn',
    })
    expect(skillsConfigs.recommended.plugins['adk-skills']).toBe(skillsPlugin)
  })

  test('the plugin module is @module-tagged so the lint subpath reaches the published exports map', async () => {
    // The subpath IS the tag: getEntries derives the exports map purely from `@module` lines, so
    // losing the tag from src/batteries/skills/lint.ts silently unpublishes this plugin.
    const { getEntries } = await import('../../../../bin/utils/index')
    const { resolve } = await import('node:path')
    const entries = await getEntries(resolve(__dirname, '../../../..', 'src'), '@nhtio/adk')
    expect(entries['batteries/skills/lint']).toContain(
      resolve(__dirname, '../../../..', 'src/batteries/skills/lint.ts')
    )
  })
})
