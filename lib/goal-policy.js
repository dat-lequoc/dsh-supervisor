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

const CONTINUATION_ACTION = /\b(?:start|resume|continue|restart|proceed|carry\s+on|keep\s+(?:going|working))\b/i
const CONTINUATION_MISSION = /\b(?:goal|mission|quest|campaign|operation|operator|always[- ]on|continuous(?:ly)?|24\s*\/\s*7|long[- ]running)\b/i

/** Recognize an explicit request to (re)enter a long-running execution loop. */
export function isLongRunningContinuation(text, hasDurableMission = false) {
  if (typeof text !== 'string' || !CONTINUATION_ACTION.test(text)) return false
  return hasDurableMission || CONTINUATION_MISSION.test(text)
}

const CEREMONY_SAFE_TOOLS = new Set([
  'get_goal',
  'propose_goal',
  'read',
  'glob',
  'grep',
  'mnemon_document_search',
  'mnemon_memory_bodies',
  'mnemon_recall',
  'mnemon_status',
])

/** Tools allowed while a continuation request still lacks confirmed authority. */
export function isCeremonySafeTool(name) {
  return CEREMONY_SAFE_TOOLS.has(name)
}

/** Deterministic tool policy for one explicit continuation request. */
export function continuationToolDecision({
  text,
  hasDurableMission,
  goalPhase,
  toolName,
  goalChecked,
}) {
  if (!isLongRunningContinuation(text, hasDurableMission) || goalPhase === 'active') {
    return 'unrestricted'
  }
  if (isCeremonySafeTool(toolName)) {
    if (toolName !== 'propose_goal' || goalChecked) return 'allow'
    return 'require-goal-check'
  }
  if (goalPhase === 'paused' && toolName === 'update_goal') {
    return goalChecked ? 'allow' : 'require-goal-check'
  }
  return 'deny-unarmed'
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
