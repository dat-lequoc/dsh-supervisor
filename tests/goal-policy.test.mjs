import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  continuationToolDecision,
  isGoalSetupSafeTool,
  isLongRunningContinuation,
  isWorkspaceGroundingPath,
  normalizedGoalList,
  normalizedGoalText,
  normalizedRoundCap,
  renderGoalMarkdown,
} from '../lib/goal-policy.js'

test('long-running continuation detection is narrow and setup tools stay read-only', () => {
  assert.equal(isLongRunningContinuation('continue our quest'), true)
  assert.equal(isLongRunningContinuation('resume', true), true)
  assert.equal(isLongRunningContinuation('continue reading this paragraph'), false)
  assert.equal(isLongRunningContinuation('what is the mission status?'), false)
  for (const name of ['get_goal', 'start_goal', 'read', 'glob', 'grep', 'mnemon_recall']) {
    assert.equal(isGoalSetupSafeTool(name), true, name)
  }
  for (const name of ['bash', 'subagent', 'schedule_create', 'write', 'edit']) {
    assert.equal(isGoalSetupSafeTool(name), false, name)
  }
})

test('workspace grounding recognizes runbooks and scripts but excludes generated state', () => {
  assert.equal(isWorkspaceGroundingPath('browser/BROWSER_TOOL.md'), true)
  assert.equal(isWorkspaceGroundingPath('scripts/recover.sh'), true)
  assert.equal(isWorkspaceGroundingPath('src/operator.ts'), true)
  assert.equal(isWorkspaceGroundingPath('README.md'), true)
  assert.equal(isWorkspaceGroundingPath('.agi/OPERATOR_BRIEF.md'), false)
  assert.equal(isWorkspaceGroundingPath('browser/profile/recovery.js'), false)
  assert.equal(isWorkspaceGroundingPath('browser/.venv/bin/activate.py'), false)
})

test('continuation tool policy enforces goal check and unarmed operation boundary', () => {
  const base = {
    text: 'continue our quest',
    hasDurableMission: true,
    goalPhase: undefined,
    goalChecked: false,
  }
  assert.equal(continuationToolDecision({ ...base, toolName: 'read' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'start_goal' }), 'require-goal-check')
  assert.equal(continuationToolDecision({ ...base, goalChecked: true, toolName: 'start_goal' }), 'allow')
  assert.equal(continuationToolDecision({
    ...base,
    goalChecked: true,
    toolName: 'start_goal',
    workspaceGroundingRequired: true,
  }), 'require-workspace-grounding')
  assert.equal(continuationToolDecision({
    ...base,
    goalChecked: true,
    toolName: 'start_goal',
    workspaceGroundingRequired: true,
    workspaceGrounded: true,
  }), 'allow')
  assert.equal(continuationToolDecision({ ...base, toolName: 'bash' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, toolName: 'schedule_create' }), 'deny-unarmed')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'active', toolName: 'bash' }), 'unrestricted')
  assert.equal(continuationToolDecision({ ...base, goalPhase: 'paused', goalChecked: true, toolName: 'update_goal' }), 'allow')
  assert.equal(continuationToolDecision({ ...base, text: 'read the status', toolName: 'bash' }), 'unrestricted')
})

test('GOAL.md renders every setup field in a stable canonical form', () => {
  const markdown = renderGoalMarkdown({
    objective: 'Ship a verified report.',
    constraints: ['No Harness edits.'],
    milestones: ['Inspect.', 'Verify.'],
    outOfScope: [],
    maxGoalRounds: 12,
  })
  assert.match(markdown, /^# Goal/)
  assert.match(markdown, /## Objective\n\nShip a verified report\./)
  assert.match(markdown, /## Constraints\n\n- No Harness edits\./)
  assert.match(markdown, /## Milestones\n\n- Inspect\.\n- Verify\./)
  assert.match(markdown, /## Out of scope\n\n- None specified\./)
  assert.match(markdown, /## Autonomous round limit\n\n12\n$/)
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

test('preset exposes only the supervisor-owned non-blocking goal frontend', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  const goalSource = await readFile(new URL('../lib/goal.js', import.meta.url), 'utf8')
  assert.match(preset, /- id: tool-goal\n\s+name: dsh-supervisor\/goal/)
  assert.doesNotMatch(preset, /name: '@deepseek-ai\/dsh-tool-goal'/)
  assert.match(goalSource, /name: 'start_goal'/)
  assert.match(goalSource, /ctx\.on\('tools\/pre-execute'/)
  assert.match(goalSource, /continue operational work in this same turn without asking for confirmation/)
  assert.match(goalSource, /Listing files or reading only GOAL\.md\/NOTES\.md is not an operational check/)
  assert.doesNotMatch(goalSource, /name: 'create_goal'/)
  assert.doesNotMatch(goalSource, /name: 'propose_goal'/)
  assert.doesNotMatch(goalSource, /name: 'confirm_goal'/)
  assert.doesNotMatch(goalSource, /CONFIRM GOAL/)
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
  assert.match(preset, /legacy GOAL\.md is context,\n\s+not proof that the runtime loop is armed/)
  assert.match(preset, /On every direct-human request to start, resume, or continue a\n\s+long-running mission, call get_goal before operational work/)
  assert.match(preset, /First inspect relevant runbooks and scripts/)
  assert.match(preset, /never ask for a confirmation phrase or stop/)
  assert.match(preset, /proceed directly into\n\s+THE LOOP/)
  assert.match(preset, /Do not emulate an always-on loop\n\s+with reminders alone/)
  assert.match(preset, /schedule a bounded\n\s+later retry instead of ending inert/)
})
