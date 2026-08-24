import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  currentRuntimeModel,
  resolveWorkerEffort,
  RUNTIME_MODEL_KEY,
  selectWorkerModel,
  WORKER_EFFORT_PROVIDER_DEFAULT,
  WORKER_DENIED_TOOLS,
  workerToolFilter,
  workerModelKey,
  workerModelLabel,
} from '../lib/worker-model-policy.js'

const allowed = [
  {
    provider: 'antigravity', id: 'gemini-3.7-flash', modalities: ['text', 'image'],
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  },
  { provider: 'zai', id: 'glm-5.3', modalities: ['text'] },
]

test('an exact settings-approved route produces explicit child agent options', () => {
  assert.equal(workerModelKey(allowed[0]), 'antigravity/gemini-3.7-flash')
  assert.equal(workerModelLabel(allowed[0]), 'antigravity/gemini-3.7-flash  [text,image; effort low/medium/high]')
  assert.deepEqual(selectWorkerModel('antigravity/gemini-3.7-flash', allowed), {
    key: 'antigravity/gemini-3.7-flash',
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    modalities: ['text', 'image'],
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  })
})

test('omission and bare ids cannot fall through to parent-model inheritance', () => {
  assert.throws(() => selectWorkerModel(undefined, allowed), /model is required/)
  assert.throws(() => selectWorkerModel('', allowed), /model is required/)
  assert.throws(
    () => selectWorkerModel('gemini-3.7-flash', allowed),
    /not on the user's worker allowlist/,
  )
})

test('a removed or otherwise unapproved route is rejected with only current choices', () => {
  assert.throws(
    () => selectWorkerModel('zai123/glm-5.3', [allowed[0]]),
    error => {
      assert.match(error.message, /zai123\/glm-5\.3.*not on the user's worker allowlist/s)
      assert.match(error.message, /antigravity\/gemini-3\.7-flash  \[text,image; effort low\/medium\/high\]/)
      assert.doesNotMatch(error.message, /zai\/glm-5\.3/)
      return true
    },
  )
})

test('an empty settings allowlist disables worker selection', () => {
  assert.throws(
    () => selectWorkerModel('antigravity/gemini-3.7-flash', []),
    /user allows no worker models/,
  )
})

test('runtime/current is an explicit allowlist choice resolved from the current request header', () => {
  const runtime = {
    provider: 'runtime',
    id: 'current',
    modalities: [],
    runtime: true,
  }
  assert.equal(RUNTIME_MODEL_KEY, 'runtime/current')
  assert.equal(
    workerModelLabel(runtime),
    'runtime/current  [current turn: model and capabilities resolved at call time]',
  )
  assert.deepEqual(selectWorkerModel(RUNTIME_MODEL_KEY, [runtime]), {
    key: RUNTIME_MODEL_KEY,
    runtime: true,
  })
  assert.deepEqual(currentRuntimeModel({
    options: { provider: 'stale', model: 'creation-model' },
    session: {
      requestHeader: () => ({
        config: { provider: 'antigravity', model: 'gemini-3.1-pro' },
      }),
    },
  }), {
    provider: 'antigravity',
    model: 'gemini-3.1-pro',
  })
})

test('worker effort supports only settings-owned provider default and fixed values', () => {
  const selected = selectWorkerModel('antigravity/gemini-3.7-flash', allowed)
  assert.equal(WORKER_EFFORT_PROVIDER_DEFAULT, 'provider/default')
  assert.deepEqual(resolveWorkerEffort(undefined, selected), {
    policy: WORKER_EFFORT_PROVIDER_DEFAULT,
    label: 'provider/default',
  })
  assert.deepEqual(resolveWorkerEffort(WORKER_EFFORT_PROVIDER_DEFAULT, selected), {
    policy: WORKER_EFFORT_PROVIDER_DEFAULT,
    label: 'provider/default',
  })
  assert.deepEqual(resolveWorkerEffort('medium', selected), {
    policy: 'medium',
    label: 'medium',
    reasoningEffort: 'medium',
  })
})

test('worker effort fails closed when the exact selected model does not advertise it', () => {
  const selected = selectWorkerModel('antigravity/gemini-3.7-flash', allowed)
  assert.throws(
    () => resolveWorkerEffort('max', selected),
    /effort "max".*not supported.*supported: low, medium, high/,
  )
  const noReasoning = selectWorkerModel('zai/glm-5.3', allowed)
  assert.throws(
    () => resolveWorkerEffort('high', noReasoning),
    /advertises no selectable reasoning efforts; use provider\/default/,
  )
})

test('current runtime route deliberately ignores the main request effort', () => {
  assert.deepEqual(currentRuntimeModel({
    session: { requestHeader: () => ({ config: {
      provider: 'antigravity', model: 'gemini-3.7-flash', reasoningEffort: 'high',
    } }) },
  }), {
    provider: 'antigravity', model: 'gemini-3.7-flash',
  })
})

test('runtime/current fails closed instead of using stale agent options', () => {
  assert.throws(
    () => currentRuntimeModel({
      options: { provider: 'zai123', model: 'glm-5.3' },
      session: { requestHeader: () => undefined },
    }),
    /never falls back to the session-creation model/,
  )
})

test('fresh-install settings and catalog include runtime/current by default', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /workerModels: \[RUNTIME_MODEL_KEY\]/)
  assert.match(source, /workerEfforts: \{ \[RUNTIME_MODEL_KEY\]: WORKER_EFFORT_PROVIDER_DEFAULT \}/)
  assert.doesNotMatch(source, /workerEffort:/)
  assert.match(source, /name: 'Current runtime model'/)
  assert.match(source, /dynamic: true/)
  assert.match(source, /resolveModelInfo\(model.provider, model.id\)/)
  assert.match(source, /reasoning: workerReasoningInfo\(resolved.reasoning\)/)
})

test('workers cannot open a child-local user question that the supervisor cannot observe', async () => {
  assert.deepEqual(WORKER_DENIED_TOOLS, ['ask_user_question'])
  assert.deepEqual(workerToolFilter(), { deny: ['ask_user_question'] })

  // Return a fresh request payload: the native descriptor snapshots this
  // restriction for cold resume, so callers must not share mutable state.
  const first = workerToolFilter()
  const second = workerToolFilter()
  assert.notStrictEqual(first, second)
  assert.notStrictEqual(first.deny, second.deny)

  const spawnSource = await readFile(new URL('../lib/spawn.js', import.meta.url), 'utf8')
  assert.match(spawnSource, /toolFilter: workerToolFilter\(\)/)
  assert.match(spawnSource, /ctx\.root\.on\('agent\/created'/)
  assert.match(spawnSource, /ctx\.root\.on\('agent\/request'/)
  assert.match(spawnSource, /ctx\.root\.on\('session\/event'/)
  assert.match(spawnSource, /event\.type === 'request\/header'/)
  assert.match(spawnSource, /pendingEfforts\.set\(childId, effort\.reasoningEffort\)/)
  assert.match(spawnSource, /childId,\n\s+request,/)
  assert.match(spawnSource, /effort: effort\.label/)
  assert.match(spawnSource, /status `running` proves only that a driver is open, NOT that useful progress/)
  assert.match(spawnSource, /Never repeat a bare .*still running \/ continue monitoring.* verdict/)
  assert.match(spawnSource, /If the next check-in is still unchanged after that probe, `interrupt_agent`/)

  // The main-facing schema may choose only an allowed route. Effort appears in
  // the result for observability, but never in the input parameter block.
  const parameterBlock = spawnSource.slice(
    spawnSource.indexOf('parameters: {'),
    spawnSource.indexOf('\n      output: {'),
  )
  assert.doesNotMatch(parameterBlock, /\beffort\s*:/)
  assert.match(spawnSource, /The tool exposes no effort argument/)
  assert.doesNotMatch(spawnSource, /reasoningEffort === 'string'/)
})

test('the bundled preset has one guarded spawn frontend and no native fallback row', async () => {
  const preset = await readFile(
    new URL('../agent-presets/main-agent/agent.cordis.yml', import.meta.url),
    'utf8',
  )

  assert.match(preset, /- id: tool-subagent\n\s+name: dsh-supervisor\/spawn/)
  assert.match(preset, /name: dsh-supervisor\/spawn\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent/)
  assert.doesNotMatch(
    preset,
    /name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent/,
  )
  assert.doesNotMatch(
    preset,
    /name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: fork/,
  )
  assert.doesNotMatch(preset, /toolName: subagent_fork/)
  assert.doesNotMatch(preset, /toolName: spawn_dev_agent/)
  assert.doesNotMatch(preset, /\n\s+models:\n/)
  assert.match(preset, /You have no direct user-question channel/)
  assert.match(preset, /The report tool is your\s+ask-supervisor channel/)
  assert.match(preset, /call report with the precise question/)
  assert.match(preset, /status `running`\s+proves only that a driver is open, NOT that useful progress is\s+happening/)
  assert.match(preset, /Never repeat a bare "still running \/ continue\s+monitoring" verdict/)
  assert.match(preset, /Still unchanged at the next check-in after the\s+probe: interrupt_agent/)
})
