/**
 * dsh-supervisor — confirmed goal frontend.
 *
 * The Harness goal service and round driver remain authoritative for durable
 * state, projections, continuation, cancellation, and race fencing. This
 * plugin replaces only the model-facing frontend so an imperative human
 * request cannot silently become an autonomous goal.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HarnessError, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  continuationToolDecision,
  goalConfirmationPhrase,
  goalDocumentHash,
  isGoalConfirmation,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from './goal-policy.js'

export const name = 'dsh-supervisor-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt']

const PROPOSAL_VERSION = 1
const DEFAULT_MAX_GOAL_ROUNDS = 256
const BLOCKED_AFTER_ROUNDS = 3

const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { goal: { type: 'null', required: true } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
            roundsStarted: { type: 'integer', required: true },
            maxGoalRounds: { type: 'integer', required: true },
            blockedReason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
      },
    },
  ],
}

const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function goalValue(goal) {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    },
    activation: goal.activation,
  }
}

function reject(message, code = 'SUPERVISOR_GOAL_POLICY') {
  throw new HarnessError(message, code)
}

/** Authenticate the exact live caller and return its current open turn. */
function goalExecution(ctx, exec) {
  const agent = exec.agent
  if (agent === undefined) reject('goal tools require a calling agent', 'SUPERVISOR_GOAL_AGENT_REQUIRED')
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    reject('goal tools require the exact live calling agent inside its active driver', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
  }
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') reject('goal tools require an open model turn', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
    if (boundary?.type === 'turn/start') {
      return { agent, start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('goal tools require an open model turn', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
}

function humanMessages(ctx, execution) {
  if (!ctx.agents.roots().includes(execution.agent)) return []
  return execution.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
}

function requireDirectHuman(ctx, execution) {
  const messages = humanMessages(ctx, execution)
  if (messages.length === 0) reject('this goal operation requires a direct human turn on a top-level agent')
  return messages
}

function isMatchingGoalRound(execution, goal) {
  return execution.events.some(event => event.type === 'user/message'
    && event.data?.source?.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

function completionAuthority(ctx, execution) {
  if (humanMessages(ctx, execution).length > 0) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) return { kind: 'goal-round', goal }
  return reject('complete and blocked require a direct human turn or the current goal round')
}

function proposalPaths(agent) {
  const cwd = resolve(agent.session.header.cwd)
  const agi = join(cwd, '.agi')
  const sessionId = String(agent.id)
  return {
    agi,
    goal: join(agi, 'GOAL.md'),
    proposal: join(agi, 'goal-proposals', `${sessionId}.json`),
    archive: join(agi, 'goals'),
  }
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
}

function readProposal(path) {
  if (!existsSync(path)) return undefined
  let proposal
  try {
    proposal = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return reject(`stored goal proposal is unreadable: ${error?.message ?? error}`, 'SUPERVISOR_GOAL_PROPOSAL_CORRUPT')
  }
  if (proposal?.version !== PROPOSAL_VERSION || typeof proposal.id !== 'string'
    || typeof proposal.objective !== 'string' || typeof proposal.goalDocumentHash !== 'string'
    || !Number.isSafeInteger(proposal.createdTurn) || !Number.isSafeInteger(proposal.maxGoalRounds)) {
    return reject('stored goal proposal is malformed', 'SUPERVISOR_GOAL_PROPOSAL_CORRUPT')
  }
  return proposal
}

function archiveLockedGoal(paths) {
  if (!existsSync(paths.goal)) return
  mkdirSync(paths.archive, { recursive: true })
  const archive = join(paths.archive, `GOAL-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.md`)
  renameSync(paths.goal, archive)
}

function currentTurnNumber(execution) {
  const turn = execution.start.data?.turn
  if (!Number.isSafeInteger(turn)) reject('current turn has no valid number', 'SUPERVISOR_GOAL_DRIVER_REQUIRED')
  return turn
}

function confirmationText(message) {
  return (message.data?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function goalRef(args) {
  if (typeof args.goal_id !== 'string' || args.goal_id.trim().length === 0
    || !Number.isSafeInteger(args.revision) || args.revision < 1) {
    reject('goal_id and revision must be the exact values returned by get_goal', 'SUPERVISOR_GOAL_INVALID_UPDATE')
  }
  return { id: args.goal_id, revision: args.revision }
}

function deferWrapup(exec, objective, blocker) {
  if (typeof exec.deferContext !== 'function') return
  const text = blocker === undefined
    ? `The confirmed goal is complete: ${objective}. Give the human a concise evidence-backed final report.`
    : `The confirmed goal is blocked: ${objective}. Explain the concrete blocker to the human: ${blocker}`
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-supervisor',
      form: 'notice',
      summary: boundContextSummary(text),
    },
  }))
}

export function apply(ctx) {
  const checkedTurn = new WeakMap()

  ctx.systemPrompt.section({
    name: 'dsh-supervisor:goal',
    order: 115,
    text: 'Goals in this supervisor require a human-confirmed ceremony. Never infer permission to start one, even from an imperative or “work nonstop” request. Interview until objective, constraints, milestones, and out-of-scope are clear; then call propose_goal. Show the resulting GOAL.md and exact confirmation phrase to the human and end the turn. Only after the human sends that exact phrase in a later turn may you call confirm_goal. GOAL.md is locked after confirmation. Use get_goal before update_goal; objective edits are deliberately unavailable and require a new confirmed ceremony.',
  })

  // Persona text is guidance, not enforcement: a weaker model can acknowledge
  // the ceremony and still start operational tools immediately. On an explicit
  // long-running continuation, close mutation and external actions until the
  // model checks native goal state and proposes a reviewable goal. Read-only
  // grounding remains available so legacy mission state can seed the proposal.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent === undefined || !ctx.agents.roots().includes(exec.agent)) return next()
    let execution
    try {
      execution = goalExecution(ctx, exec)
    } catch {
      return next()
    }
    const latest = humanMessages(ctx, execution).at(-1)
    if (latest === undefined) return next()
    const current = ctx.goals.get(execution.agent)
    const decision = continuationToolDecision({
      text: confirmationText(latest),
      hasDurableMission: existsSync(proposalPaths(execution.agent).goal),
      goalPhase: current?.phase,
      toolName: exec.name,
      goalChecked: checkedTurn.get(execution.agent) === currentTurnNumber(execution),
    })
    if (decision === 'unrestricted' || decision === 'allow') return next()
    if (decision === 'require-goal-check') {
      return Promise.resolve({
        kind: 'deny',
        reason: 'Long-running continuation requires a current native-goal check. Call get_goal first.',
      })
    }
    return Promise.resolve({
      kind: 'deny',
      reason: 'Long-running continuation is not armed. Call get_goal, inspect durable mission state with read-only tools, then call propose_goal and end the turn for exact human confirmation. Operational tools and reminders cannot substitute for a confirmed native goal.',
    })
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: 'Read the native persisted same-session goal and its exact id/revision, phase, round count, cap, and activation.',
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      const execution = goalExecution(ctx, exec)
      checkedTurn.set(execution.agent, currentTurnNumber(execution))
      return Promise.resolve(goalValue(ctx.goals.get(execution.agent)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'propose_goal',
    description: 'Write a reviewable GOAL.md proposal after interviewing the human. This does not create or arm a native goal. Return the exact confirmation phrase, show it to the human, and end the turn.',
    parameters: {
      objective: { type: 'string', required: true },
      constraints: { type: 'array', required: true, items: { type: 'string' } },
      milestones: { type: 'array', required: true, items: { type: 'string' } },
      out_of_scope: { type: 'array', required: true, items: { type: 'string' } },
      max_goal_rounds: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposalId: { type: 'string', required: true },
          confirmationPhrase: { type: 'string', required: true },
          goalFile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Goal proposal written to ${value.goalFile}. Ask the human to reply exactly: ${value.confirmationPhrase}`,
      }],
    },
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const current = ctx.goals.get(execution.agent)
      if (current !== undefined && current.phase !== 'complete') {
        reject(`cannot propose a new goal while goal ${current.id} is ${current.phase}`)
      }
      const objective = normalizedGoalText(args.objective, 'objective')
      const constraints = normalizedGoalList(args.constraints, 'constraints')
      const milestones = normalizedGoalList(args.milestones, 'milestones')
      const outOfScope = normalizedGoalList(args.out_of_scope, 'out_of_scope')
      const maxGoalRounds = normalizedRoundCap(args.max_goal_rounds, DEFAULT_MAX_GOAL_ROUNDS)
      const proposalId = randomUUID().slice(0, 8)
      const markdown = renderGoalMarkdown({ objective, constraints, milestones, outOfScope, maxGoalRounds })
      const paths = proposalPaths(execution.agent)
      const previous = readProposal(paths.proposal)
      if (previous === undefined || previous.status === 'confirmed') archiveLockedGoal(paths)
      atomicWrite(paths.goal, markdown)
      atomicWrite(paths.proposal, `${JSON.stringify({
        version: PROPOSAL_VERSION,
        id: proposalId,
        status: 'pending',
        objective,
        maxGoalRounds,
        goalDocumentHash: goalDocumentHash(markdown),
        createdTurn: currentTurnNumber(execution),
        createdAt: Date.now(),
      }, null, 2)}\n`)
      return Promise.resolve({
        proposalId,
        confirmationPhrase: goalConfirmationPhrase(proposalId),
        goalFile: paths.goal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'confirm_goal',
    description: 'Create and arm the native goal only after the human sends the proposal’s exact confirmation phrase in a later turn. Takes no objective: the locked proposal is authoritative.',
    parameters: {
      proposal_id: { type: 'string', required: true },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      const directMessages = requireDirectHuman(ctx, execution)
      const paths = proposalPaths(execution.agent)
      const proposal = readProposal(paths.proposal)
      if (proposal === undefined || proposal.status !== 'pending') reject('no pending goal proposal exists; call propose_goal first')
      if (args.proposal_id !== proposal.id) reject('proposal_id does not match the pending proposal')
      if (currentTurnNumber(execution) <= proposal.createdTurn) {
        reject('goal confirmation must arrive in a later human turn')
      }
      if (!directMessages.some(message => isGoalConfirmation(confirmationText(message), proposal.id))) {
        reject(`the current human message must be exactly: ${goalConfirmationPhrase(proposal.id)}`)
      }
      if (!existsSync(paths.goal)) reject('GOAL.md disappeared after proposal; propose it again')
      const markdown = readFileSync(paths.goal, 'utf8')
      if (goalDocumentHash(markdown) !== proposal.goalDocumentHash) {
        reject('GOAL.md changed after proposal; propose the revised document and obtain confirmation again')
      }
      const goal = ctx.goals.create(execution.agent, {
        objective: proposal.objective,
        maxGoalRounds: proposal.maxGoalRounds,
      })
      atomicWrite(paths.proposal, `${JSON.stringify({
        ...proposal,
        status: 'confirmed',
        confirmedAt: Date.now(),
        nativeGoalId: goal.id,
        nativeGoalRevision: goal.revision,
      }, null, 2)}\n`)
      return Promise.resolve(goalValue(goal))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: 'Update the exact confirmed native goal revision. pause and resume require a direct human turn. complete and blocked require a direct human turn or the current admitted goal round. Objective edits are intentionally unavailable; changed scope requires a new confirmed proposal after completion.',
    parameters: {
      goal_id: { type: 'string', required: true },
      revision: { type: 'number', required: true },
      action: { type: 'string', required: true, enum: ['pause', 'resume', 'complete', 'blocked'] },
      blocked_reason: { type: 'string' },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      const ref = goalRef(args)
      if (args.action === 'pause' || args.action === 'resume') {
        requireDirectHuman(ctx, execution)
        if (typeof args.blocked_reason === 'string' && args.blocked_reason.length > 0) {
          reject('blocked_reason is valid only with action blocked', 'SUPERVISOR_GOAL_INVALID_UPDATE')
        }
        const goal = args.action === 'pause'
          ? ctx.goals.pause(execution.agent, ref)
          : ctx.goals.resume(execution.agent, ref)
        return Promise.resolve(goalValue(goal))
      }
      const authority = completionAuthority(ctx, execution)
      if (args.action === 'complete' && typeof args.blocked_reason === 'string' && args.blocked_reason.length > 0) {
        reject('blocked_reason is valid only with action blocked', 'SUPERVISOR_GOAL_INVALID_UPDATE')
      }
      if (args.action === 'blocked'
        && (typeof args.blocked_reason !== 'string' || args.blocked_reason.trim().length === 0)) {
        reject('blocked_reason is required with action blocked', 'SUPERVISOR_GOAL_INVALID_UPDATE')
      }
      if (args.action === 'blocked' && authority.kind === 'goal-round'
        && authority.goal.roundsStarted < BLOCKED_AFTER_ROUNDS) {
        reject(`blocked requires at least ${BLOCKED_AFTER_ROUNDS} consecutive goal rounds; current round is ${authority.goal.roundsStarted}`)
      }
      const goal = args.action === 'complete'
        ? ctx.goals.complete(execution.agent, ref)
        : ctx.goals.block(execution.agent, ref, {
          code: 'model-reported',
          message: args.blocked_reason.trim(),
        })
      if (authority.kind === 'goal-round') deferWrapup(exec, goal.objective, args.action === 'blocked' ? args.blocked_reason.trim() : undefined)
      return Promise.resolve(goalValue(goal))
    },
  }))
}
