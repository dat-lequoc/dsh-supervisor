import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enrichSettlementMessages,
  installSettlementDiagnostics,
  renderTerminalFailure,
  terminalFailureAt,
} from '../lib/settlement.js'

const quota = {
  message: '429: usage limit reached; resets at 21:10:39',
  code: 'QUOTA',
}

function event(type, time, data = {}) {
  return { type, time, data }
}

function settledMessage(id = 'notice-1', childId = 'child-1') {
  return Object.freeze({
    id,
    role: 'user',
    source: Object.freeze({
      kind: 'subagent-settled',
      form: 'notice',
      summary: `Background subagent ${childId} failed before it finished.`,
      senderSessionId: childId,
    }),
    content: Object.freeze([
      Object.freeze({ type: 'text', text: `Background subagent ${childId} failed before it finished.` }),
      Object.freeze({ type: 'text', text: 'It left no closing message.' }),
    ]),
  })
}

function parentFor(message, time = 30) {
  return {
    session: {
      events: [event('agent/inbox/spliced', time, { inserted: [message] })],
    },
  }
}

function logger() {
  const warnings = []
  return { warnings, warn: value => warnings.push(value) }
}

test('terminal QUOTA enriches the one final settlement notice', async () => {
  const message = settledMessage()
  const messages = [message]
  const parent = parentFor(message)
  const log = logger()
  const persistence = {
    inspect: async () => ({
      events: [
        event('turn/start', 10, { turn: 1 }),
        event('turn/end', 20, { turn: 1, reason: { kind: 'error', error: quota } }),
      ],
    }),
  }

  const result = await enrichSettlementMessages(
    persistence,
    parent,
    messages,
    new AbortController().signal,
    log,
  )

  assert.notEqual(result, messages)
  assert.equal(result[0].id, message.id)
  assert.equal(result[0].source, message.source)
  assert.deepEqual(result[0].content.map(block => block.text), [
    'Background subagent child-1 failed before it finished.',
    'Terminal failure [QUOTA]: 429: usage limit reached; resets at 21:10:39',
    'It left no closing message.',
  ])
  assert.equal(Object.isFrozen(result[0]), true)
  assert.equal(Object.isFrozen(result[0].content), true)
  assert.equal(Object.isFrozen(result[0].content[1]), true)
  assert.deepEqual(log.warnings, [])
})

test('a successful retry produces no failure diagnostic', async () => {
  const message = settledMessage()
  const messages = [message]
  const failure = terminalFailureAt([
    event('llm/retry', 10, { failure: { message: 'busy', code: 'RATE_LIMIT' } }),
    event('llm/retry-started', 11, { retry: 1 }),
    event('turn/end', 20, { turn: 1, reason: { kind: 'completed' } }),
  ], 30)
  assert.equal(failure, undefined)

  const result = await enrichSettlementMessages(
    { inspect: async () => ({ events: [event('turn/end', 20, { reason: { kind: 'completed' } })] }) },
    parentFor(message),
    messages,
    new AbortController().signal,
    logger(),
  )
  assert.equal(result, messages)
  assert.equal(result[0], message)
})

test('exhausted retries expose only the final terminal failure', () => {
  const final = { message: 'provider still busy', code: 'RATE_LIMIT', status: 429 }
  assert.equal(terminalFailureAt([
    event('llm/retry', 10, { retry: 1, failure: { message: 'first', code: 'RATE_LIMIT' } }),
    event('llm/retry', 12, { retry: 2, failure: { message: 'second', code: 'RATE_LIMIT' } }),
    event('turn/end', 20, { reason: { kind: 'error', error: final } }),
  ], 30), final)
  assert.equal(renderTerminalFailure(final), 'Terminal failure [RATE_LIMIT; HTTP 429]: provider still busy')
})

test('resume and notice boundaries prevent stale or later failures from leaking', () => {
  const old = { message: 'old quota', code: 'QUOTA' }
  const later = { message: 'later failure', code: 'SERVER' }
  const events = [
    event('turn/end', 5, { reason: { kind: 'error', error: old } }),
    event('session/end-seed', 10),
    event('turn/end', 20, { reason: { kind: 'completed' } }),
    // A later cold resume must not change the already-delivered notice.
    event('session/end-seed', 40),
    event('turn/end', 50, { reason: { kind: 'error', error: later } }),
  ]
  assert.equal(terminalFailureAt(events, 30), undefined)
  assert.equal(terminalFailureAt(events, 60), later)
})

test('ordinary messages and unavailable child logs remain unchanged', async () => {
  const ordinary = Object.freeze({
    id: 'user-1',
    role: 'user',
    source: Object.freeze({ kind: 'user' }),
    content: Object.freeze([Object.freeze({ type: 'text', text: 'hello' })]),
  })
  let inspections = 0
  const ordinaryMessages = [ordinary]
  const ordinaryResult = await enrichSettlementMessages(
    { inspect: async () => { inspections += 1; return { events: [] } } },
    { session: { events: [] } },
    ordinaryMessages,
    new AbortController().signal,
    logger(),
  )
  assert.equal(ordinaryResult, ordinaryMessages)
  assert.equal(inspections, 0)

  const settled = settledMessage()
  const settledMessages = [settled]
  const log = logger()
  const failedResult = await enrichSettlementMessages(
    { inspect: async () => { throw new Error('storage unavailable') } },
    parentFor(settled),
    settledMessages,
    new AbortController().signal,
    log,
  )
  assert.equal(failedResult, settledMessages)
  assert.match(log.warnings[0], /storage unavailable/)
})

test('teardown-only failure and an already enriched notice stay unchanged', async () => {
  const teardown = settledMessage()
  const teardownMessages = [teardown]
  const noTerminal = await enrichSettlementMessages(
    { inspect: async () => ({ events: [event('session/end-seed', 10)] }) },
    parentFor(teardown),
    teardownMessages,
    new AbortController().signal,
    logger(),
  )
  assert.equal(noTerminal, teardownMessages)

  const existing = Object.freeze({
    ...teardown,
    content: Object.freeze([
      teardown.content[0],
      Object.freeze({ type: 'text', text: 'Terminal failure [QUOTA]: already present' }),
      teardown.content[1],
    ]),
  })
  const existingMessages = [existing]
  const unchanged = await enrichSettlementMessages(
    { inspect: async () => { throw new Error('must not inspect') } },
    parentFor(existing),
    existingMessages,
    new AbortController().signal,
    logger(),
  )
  assert.equal(unchanged, existingMessages)
})

test('the pre-step hook enriches only after downstream accepts the final notice', async () => {
  const listeners = new Map()
  const message = settledMessage()
  const log = logger()
  const ctx = {
    logger: log,
    get: name => name === 'sessionPersistence'
      ? {
          inspect: async () => ({
            events: [event('turn/end', 20, { reason: { kind: 'error', error: quota } })],
          }),
        }
      : undefined,
    on: (name, listener) => listeners.set(name, listener),
  }
  installSettlementDiagnostics(ctx)
  const listener = listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function')
  let delegated = 0
  const decision = await listener({
    agent: parentFor(message),
    messages: [message],
    signal: new AbortController().signal,
  }, async () => {
    delegated += 1
    return { kind: 'enter', messages: [message] }
  })
  assert.equal(delegated, 1)
  assert.match(decision.messages[0].content[1].text, /^Terminal failure \[QUOTA\]/)

  const rejected = await listener({
    agent: parentFor(message),
    messages: [message],
    signal: new AbortController().signal,
  }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
})
