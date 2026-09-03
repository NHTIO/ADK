/**
 * A ToolCall identifier must satisfy the provider's format constraints.
 *
 * @remarks
 * MEASURED. Two constraints, both hard rejections that name neither the field nor the offending
 * character, and both failing on EVERY credential — so a violation exhausts a provider pool rather
 * than degrading gracefully:
 *
 *  - OpenAI Codex 400s an id longer than 64 characters. A production gateway's own translator names
 *    an ADK-generated id embedding a UUID plus an iteration counter as the trigger.
 *  - Bedrock Converse rejects a `toolUseId` outside `[A-Za-z0-9_-]`.
 *
 * The ADK's own uuidv6 ids satisfy both, so this guards CONSUMER-supplied ids — a caller
 * correlating tool calls by a composite key is the realistic case.
 */
import type { OrderingProfile } from '../types'

/**
 * @param maxLength - Identifier cap. 64 matches both Codex and Converse.
 * @param allowedPattern - Character class, anchored by the evaluator.
 */
export const toolCallIdFormat = (
  maxLength: number = 64,
  allowedPattern: string = '[A-Za-z0-9_-]'
): OrderingProfile => ({
  name: 'tool-call-id-format',
  description:
    `ToolCall ids must be at most ${maxLength} characters and match ${allowedPattern}; ` +
    'a violation is a hard rejection on every credential.',
  rules: [
    {
      type: 'identifierFormat',
      id: 'tool-call-id-format',
      kind: 'toolCall',
      maxLength,
      allowedPattern,
    },
  ],
})
