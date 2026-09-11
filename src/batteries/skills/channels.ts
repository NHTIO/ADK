import { v6 as uuidv6 } from 'uuid'
import { Retrievable, SpooledMarkdownArtifact } from '@nhtio/adk/common'
import { autoSpoolRetrievable } from '../../lib/utils/retrievable_spool'
import type { SkillDescriptor } from './types'
import type { SkillLoadChannel, SkillRef } from './contracts'
import type { DispatchContext, TurnContext } from '@nhtio/adk/types'

/** Resolve the per-skill projection channel. */
export const resolveSkillChannel = (
  descriptor: SkillDescriptor,
  defaultChannel: SkillLoadChannel | undefined
): SkillLoadChannel => descriptor.channel ?? defaultChannel ?? 'handle'

/** Spool a skill body exactly once for a loaded record. */
export const spoolSkillBody = async (
  ctx: DispatchContext | TurnContext,
  ref: SkillRef,
  descriptor: SkillDescriptor,
  body: string,
  channel: SkillLoadChannel
): Promise<Retrievable> => {
  const now = new Date().toISOString()
  return autoSpoolRetrievable(
    ctx,
    new Retrievable({
      id: uuidv6(),
      content: body,
      artifactConstructor: () => SpooledMarkdownArtifact,
      trustTier: descriptor.trustTier ?? 'third-party-public',
      inline: channel === 'inline',
      source: `${ref.sourceId}:${ref.id}`,
      kind: 'skill',
      createdAt: now,
      updatedAt: now,
    })
  )
}
