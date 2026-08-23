import { createHash } from 'node:crypto'

/** Stable phrase a human must send in a later turn to approve a proposal. */
export function goalConfirmationPhrase(proposalId) {
  return `CONFIRM GOAL ${proposalId}`
}

/** Exact, case-insensitive confirmation; surrounding prose never counts. */
export function isGoalConfirmation(text, proposalId) {
  return typeof text === 'string'
    && text.trim().toUpperCase() === goalConfirmationPhrase(proposalId).toUpperCase()
}

/** Canonical user-reviewable goal document written before confirmation. */
export function renderGoalMarkdown({ objective, constraints, milestones, outOfScope, maxGoalRounds }) {
  const list = values => values.length === 0 ? '- None specified.' : values.map(value => `- ${value}`).join('\n')
  return [
    '# Goal Proposal',
    '',
    '## Objective',
    '',
    objective,
    '',
    '## Constraints',
    '',
    list(constraints),
    '',
    '## Milestones',
    '',
    list(milestones),
    '',
    '## Out of scope',
    '',
    list(outOfScope),
    '',
    '## Autonomous round limit',
    '',
    String(maxGoalRounds),
    '',
  ].join('\n')
}

export function goalDocumentHash(markdown) {
  return createHash('sha256').update(markdown).digest('hex')
}

export function normalizedGoalText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

export function normalizedGoalList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => normalizedGoalText(item, `${field}[${index}]`))
}

export function normalizedRoundCap(value, fallback = 256) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError('max_goal_rounds must be a positive safe integer')
  }
  return resolved
}
