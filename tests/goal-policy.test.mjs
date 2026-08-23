import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  continuationToolDecision,
  goalConfirmationPhrase,
  goalDocumentHash,
  isCeremonySafeTool,
  isGoalConfirmation,
  isLongRunningContinuation,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from '../lib/goal-policy.js'

test('confirmation requires the exact proposal-specific phrase', () => {
  assert.equal(goalConfirmationPhrase('a1b2c3d4'), 'CONFIRM GOAL a1b2c3d4')
  assert.equal(isGoalConfirmation('CONFIRM GOAL a1b2c3d4', 'a1b2c3d4'), true)
  assert.equal(isGoalConfirmation('  confirm goal A1B2C3D4  ', 'a1b2c3d4'), true)
  assert.equal(isGoalConfirmation('yes, CONFIRM GOAL a1b2c3d4', 'a1b2c3d4'), false)
  assert.equal(isGoalConfirmation('CONFIRM GOAL wrong', 'a1b2c3d4'), false)
})

test('long-running continuation detection is narrow and ceremony tools stay read-only', () => {
  assert.equal(isLongRunningContinuation('continue our quest'), true)
  assert.equal(isLongRunningContinuation('resume', true), true)
  assert.equal(isLongRunningContinuation('continue reading this paragraph'), false)
  assert.equal(isLongRunningContinuation('what is the mission status?'), false)
  for (const name of ['get_goal', 'propose_goal', 'read', 'glob', 'grep', 'mnemon_recall']) {
    assert.equal(isCeremonySafeTool(name), true, name)
  }
  for (const name of ['bash', 'subagent', 'schedule_create', 'write', 'edit']) {
    assert.equal(isCeremonySafeTool(name), false, name)
  }
})

test('continuation tool policy enforces goal check and unarmed operation boundary', () => {
  const base = {
    text: 'continue our quest',
    hasDurableMission: true,
    goalPhase: undefined,
    goalChecked: false,
  }
  assert.equal(continuationToolDecision({ ...base, toolName: 'read' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'propose_goal' }), 'require-goal-check')
  assert.equal(continuationToolDecision({ ...base, goalChecked: true, toolName: 'propose_goal' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'bash' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, toolName: 'schedule_create' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'active', toolName: 'bash' }), 'unrestricted')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'paused', goalChecked: true, toolName: 'update_goal' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, text: 'read the status', toolName: 'bash' }), 'unrestricted')
})

test('GOAL.md renders every ceremony field in a stable canonical form', () => {
  const markdown = renderGoalMarkdown({
    objective: 'Ship a verified report.',
    constraints: ['No Harness edits.'],
    milestones: ['Inspect.', 'Verify.'],
    outOfScope: [],
    maxGoalRounds: 12,
  })
  assert.match(markdown, /^# Goal Proposal/)
  assert.match(markdown, /## Objective\n\nShip a verified report\./)
  assert.match(markdown, /## Constraints\n\n- No Harness edits\./)
  assert.match(markdown, /## Milestones\n\n- Inspect\.\n- Verify\./)
  assert.match(markdown, /## Out of scope\n\n- None specified\./)
  assert.match(markdown, /## Autonomous round limit\n\n12\n$/)
})

test('document hashes detect any post-proposal mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-goal-'))
  try {
    const path = join(directory, 'GOAL.md')
    await writeFile(path, '# Goal Proposal\n\nOriginal\n')
    const original = goalDocumentHash(await readFile(path, 'utf8'))
    await writeFile(path, '# Goal Proposal\n\nChanged\n')
    assert.notEqual(goalDocumentHash(await readFile(path, 'utf8')), original)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('goal inputs normalize safely and reject malformed values', () => {
  assert.equal(normalizedGoalText('  objective  ', 'objective'), 'objective')
  assert.deepEqual(normalizedGoalList([' one ', 'two'], 'milestones'), ['one', 'two'])
  assert.equal(normalizedRoundCap(undefined), 256)
  assert.equal(normalizedRoundCap(8), 8)
  assert.throws(() => normalizedGoalText(' ', 'objective'), /non-empty/)
  assert.throws(() => normalizedGoalList('one', 'milestones'), /must be an array/)
  assert.throws(() => normalizedGoalList([''], 'milestones'), /milestones\[0\]/)
  assert.throws(() => normalizedRoundCap(0), /positive safe integer/)
})

test('preset exposes only the supervisor-owned confirmed goal frontend', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  const goalSource = await readFile(new URL('../lib/goal.js', import.meta.url), 'utf8')
  assert.match(preset, /- id: tool-goal\n\s+name: dsh-supervisor\/goal/)
  assert.doesNotMatch(preset, /name: '@deepseek-ai\/dsh-tool-goal'/)
  assert.match(goalSource, /name: 'propose_goal'/)
  assert.match(goalSource, /name: 'confirm_goal'/)
  assert.match(goalSource, /ctx\.on\('tools\/pre-execute'/)
  assert.match(goalSource, /Operational tools and reminders cannot substitute for a confirmed native goal/)
  assert.doesNotMatch(goalSource, /name: 'create_goal'/)
  assert.doesNotMatch(goalSource, /enum: \['edit'/)
})

test('preset requires bounded recovery and a durable continuation path', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  assert.match(preset, /PERSISTENCE — a recoverable branch is not a blocker/)
  assert.match(preset, /Exhaust\n\s+a bounded ladder of distinct, safe recovery attempts/)
  assert.match(preset, /never bypass a security or approval boundary/)
  assert.match(preset, /A blocked branch does not stop the mission/)
  assert.match(preset, /leave at least one durable continuation path/)
  assert.match(preset, /legacy GOAL\.md\n\s+is context only, not autonomous execution authority/)
  assert.match(preset, /On every direct-human request to start, resume, or continue a\n\s+long-running mission, call get_goal before operational work/)
  assert.match(preset, /Do not emulate an always-on loop with reminders alone/)
  assert.match(preset, /schedule a bounded\n\s+later retry instead of ending inert/)
})
