import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  selectWorkerModel,
  workerModelKey,
  workerModelLabel,
} from '../lib/worker-model-policy.js'

const allowed = [
  { provider: 'antigravity', id: 'gemini-3.7-flash', modalities: ['text', 'image'] },
  { provider: 'zai', id: 'glm-5.3', modalities: ['text'] },
]

test('an exact settings-approved route produces explicit child agent options', () => {
  assert.equal(workerModelKey(allowed[0]), 'antigravity/gemini-3.7-flash')
  assert.equal(workerModelLabel(allowed[0]), 'antigravity/gemini-3.7-flash  [text,image]')
  assert.deepEqual(selectWorkerModel('antigravity/gemini-3.7-flash', allowed), {
    key: 'antigravity/gemini-3.7-flash',
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    modalities: ['text', 'image'],
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
      assert.match(error.message, /antigravity\/gemini-3\.7-flash  \[text,image\]/)
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
  assert.doesNotMatch(preset, /toolName: spawn_dev_agent/)
  assert.doesNotMatch(preset, /\n\s+models:\n/)
})
