/**
 * dsh-supervisor — reviewable, non-blocking goal frontend.
 *
 * The Harness goal service and round driver remain authoritative for durable
 * state, projections, continuation, cancellation, and race fencing. This
 * plugin replaces only the model-facing frontend so every autonomous mission
 * gets a durable GOAL.md without forcing a second human confirmation turn.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { HarnessError, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  continuationToolDecision,
  isWorkspaceGroundingPath,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from './goal-policy.js'

export const name = 'dsh-supervisor-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt']

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

function goalPaths(agent) {
  const cwd = resolve(agent.session.header.cwd)
  const agi = join(cwd, '.agi')
  return {
    goal: join(agi, 'GOAL.md'),
    archive: join(agi, 'goals'),
  }
}

function workspaceRelativePath(agent, filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return undefined
  const cwd = resolve(agent.session.header.cwd)
  const absolute = resolve(cwd, filePath)
  const candidate = relative(cwd, absolute)
  if (candidate === '' || candidate === '..' || candidate.startsWith('../') || candidate.startsWith('..\\')) {
    return undefined
  }
  return candidate
}

function isGroundingRead(agent, exec) {
  if (exec.name !== 'read' || typeof exec.arguments !== 'object' || exec.arguments === null) return false
  const candidate = workspaceRelativePath(agent, exec.arguments.file_path)
  return candidate !== undefined && isWorkspaceGroundingPath(candidate)
}

/** Bounded discovery only decides whether a relevant file exists; the model must still open it. */
function workspaceHasGroundingMaterial(agent) {
  const cwd = resolve(agent.session.header.cwd)
  const pending = [{ absolute: cwd, relative: '', depth: 0 }]
  let visited = 0
  while (pending.length > 0 && visited < 5000) {
    const current = pending.pop()
    let entries
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      const candidate = current.relative === '' ? entry.name : join(current.relative, entry.name)
      if (entry.isFile() && isWorkspaceGroundingPath(candidate)) return true
      if (entry.isDirectory() && current.depth < 4 && isWorkspaceGroundingPath(join(candidate, 'probe.js'))) {
        pending.push({ absolute: join(current.absolute, entry.name), relative: candidate, depth: current.depth + 1 })
      }
      if (visited >= 5000) break
    }
  }
  return false
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
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

function messageText(message) {
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
    ? `The goal is complete: ${objective}. Give the human a concise evidence-backed final report.`
    : `The goal is blocked: ${objective}. Explain the concrete blocker to the human: ${blocker}`
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
  const groundedTurn = new WeakMap()

  ctx.systemPrompt.section({
    name: 'dsh-supervisor:goal',
    order: 115,
    text: 'Long-running goals in this supervisor are reviewable but non-blocking. On a direct human request to start, resume, or continue a mission, call get_goal first. If no active native goal exists, inspect durable mission state and relevant workspace runbooks/scripts, then call start_goal with the best grounded objective, constraints, milestones, out-of-scope, and round cap. start_goal writes GOAL.md, immediately arms the native goal, and returns control to the same turn: continue operational work instead of asking for confirmation or ending. The human may inspect GOAL.md and steer, pause, or stop at any time. Use get_goal before update_goal; objective edits remain unavailable while a goal is active.',
  })

  // Persona text is guidance, not enforcement. On an explicit long-running
  // continuation, close mutation and external actions only until the model has
  // checked native goal state and started a reviewable native goal. Read-only
  // grounding remains available so existing runbooks, scripts, and mission
  // state can inform the goal without introducing a human confirmation stop.
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
      text: messageText(latest),
      hasDurableMission: existsSync(goalPaths(execution.agent).goal),
      goalPhase: current?.phase,
      toolName: exec.name,
      goalChecked: checkedTurn.get(execution.agent) === currentTurnNumber(execution),
      workspaceGroundingRequired: exec.name === 'start_goal' && workspaceHasGroundingMaterial(execution.agent),
      workspaceGrounded: groundedTurn.get(execution.agent) === currentTurnNumber(execution),
    })
    if (decision === 'unrestricted' || decision === 'allow') return next()
    if (decision === 'require-goal-check') {
      return Promise.resolve({
        kind: 'deny',
        reason: 'Long-running continuation requires a current native-goal check. Call get_goal first.',
      })
    }
    if (decision === 'require-workspace-grounding') {
      return Promise.resolve({
        kind: 'deny',
        reason: 'Before start_goal, open at least one relevant workspace runbook, automation script, or source file outside .agi in this turn. Listing files or reading only GOAL.md/NOTES.md is not an operational check.',
      })
    }
    return Promise.resolve({
      kind: 'deny',
      reason: 'Long-running continuation is not armed. Call get_goal, inspect durable mission state and relevant runbooks/scripts with read-only tools, then call start_goal. It arms the native goal immediately; continue operational work in this same turn without asking for confirmation.',
    })
  }, { prepend: true })

  ctx.on('tools/post-execute', (exec, result, next) => {
    if (!result.isError && exec.agent !== undefined && ctx.agents.roots().includes(exec.agent)
      && isGroundingRead(exec.agent, exec)) {
      try {
        const execution = goalExecution(ctx, exec)
        groundedTurn.set(execution.agent, currentTurnNumber(execution))
      } catch {
        // A read that settles after its turn boundary cannot ground a later turn.
      }
    }
    return next()
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
    name: 'start_goal',
    description: 'Write a reviewable GOAL.md and immediately create and arm the native same-session goal. Use after get_goal on a direct human start/resume/continue request. Do not ask for a separate confirmation and do not end the turn after this succeeds; continue the mission using the workspace’s existing runbooks and scripts.',
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
          goal: GOAL_VALUE_SCHEMA.oneOf[1].properties.goal,
          activation: { type: 'string', required: true, enum: ['armed'] },
          goalFile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Goal written to ${value.goalFile} and armed as native goal ${value.goal.id}. Continue the mission now; no confirmation turn is required.`,
      }],
    },
    execute(args, exec) {
      const execution = goalExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const current = ctx.goals.get(execution.agent)
      if (current !== undefined && current.phase !== 'complete') {
        reject(`cannot start a new goal while goal ${current.id} is ${current.phase}`)
      }
      const objective = normalizedGoalText(args.objective, 'objective')
      const constraints = normalizedGoalList(args.constraints, 'constraints')
      const milestones = normalizedGoalList(args.milestones, 'milestones')
      const outOfScope = normalizedGoalList(args.out_of_scope, 'out_of_scope')
      const maxGoalRounds = normalizedRoundCap(args.max_goal_rounds, DEFAULT_MAX_GOAL_ROUNDS)
      const markdown = renderGoalMarkdown({ objective, constraints, milestones, outOfScope, maxGoalRounds })
      const paths = goalPaths(execution.agent)
      archiveLockedGoal(paths)
      atomicWrite(paths.goal, markdown)
      const goal = ctx.goals.create(execution.agent, {
        objective,
        maxGoalRounds,
      })
      return Promise.resolve({
        ...goalValue(goal),
        goalFile: paths.goal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: 'Update the exact native goal revision. pause and resume require a direct human turn. complete and blocked require a direct human turn or the current admitted goal round. Objective edits are intentionally unavailable while a goal is active; changed scope can start a new goal after completion.',
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
