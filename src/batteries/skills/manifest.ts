import { default as yaml } from 'js-yaml'
import { isError } from '@nhtio/adk/guards'
import { E_SKILL_MANIFEST_INVALID } from './exceptions'

/**
 * Parse an agentskills.io-shaped SKILL.md for source authors. The manager's load path never calls
 * this helper: sources own descriptor and body authority. Malformed frontmatter degrades to an
 * empty object when it is not a delimited YAML block; malformed YAML is a manifest error.
 */
export const parseSkillMd = (
  text: string
): { frontmatter: Record<string, unknown>; body: string } => {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { frontmatter: {}, body: text }
  let parsed: unknown
  try {
    parsed = yaml.load(match[1])
  } catch (error) {
    throw new E_SKILL_MANIFEST_INVALID([isError(error) ? error.message : String(error)])
  }
  if (parsed === undefined || parsed === null) {
    throw new E_SKILL_MANIFEST_INVALID(['frontmatter must include name and description'])
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new E_SKILL_MANIFEST_INVALID(['frontmatter must be a mapping'])
  }
  const source = parsed as Record<string, unknown>
  if (!('name' in source) || typeof source.name !== 'string') {
    throw new E_SKILL_MANIFEST_INVALID(['frontmatter name must be a string'])
  }
  if (!('description' in source) || typeof source.description !== 'string') {
    throw new E_SKILL_MANIFEST_INVALID(['frontmatter description must be a string'])
  }
  const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']
  const frontmatter: Record<string, unknown> = {}
  for (const key of allowed) if (key in source) frontmatter[key] = source[key]
  return { frontmatter, body: text.slice(match[0].length) }
}
