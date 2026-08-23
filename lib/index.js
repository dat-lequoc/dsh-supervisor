/**
 * dsh-supervisor — host half.
 *
 * Responsibilities, one package (3–4 live on the nested web plugin):
 *
 * 1. PRESET INSTALL. The supervisor's core is an AGENT PRESET
 *    (agent-presets/main-agent in this package), and presets live in the user
 *    preset root, not in the plugin tree. At mount this plugin installs the
 *    bundled preset into `${DSH_HOME:-~/.dsh}/.agent-presets/main-agent` so
 *    the package works out of the box after `dsh plugin add`.
 *    Non-destructive: an existing preset directory is NEVER overwritten unless
 *    config says `syncPreset: 'always'` — user edits are user property.
 *
 * 2. FEED ROUTE. `GET /supervisor/feed?ws=<workspace>` serves the workspace's
 *    `.agi/` state (goal, progress, questions, changelog, notes, mission
 *    report, worker outcomes) as one JSON document. The browser half (the
 *    "Feed" view tab registered into the shipped `conversation.view` ring —
 *    see lib/client.js) polls it. Registered through a NESTED plugin injecting
 *    `webServer`, so the preset install never waits on the web stack and the
 *    package still mounts in profiles that have no web server at all.
 *
 * 3. FULL STOP. `GET /supervisor/stop?session=…` reports durable armed state;
 *    `POST` aborts the active turn and deletes every schedule reminder inside
 *    an exclusive maintenance window, so nothing re-wakes the agent (the
 *    native stop only aborts the turn).
 *
 * 4. MODELS CATALOG. `GET /supervisor/models` for the settings card dropdown.
 *
 * (The Shots tab lives in its own package, dsh-shots — it is generic browser-
 * daemon tooling, not supervisor logic.)
 *
 * Config (all optional):
 *   syncPreset: 'if-absent' (default) | 'always' | 'never'
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { fullStopAgent, sessionAgentPreset } from './full-stop.js'
import { RUNTIME_MODEL_KEY } from './worker-model-policy.js'

export const name = 'dsh-supervisor'
export const inject = []

/** The supervisor's meta-config: one settings namespace, editable in
 * `~/.dsh/settings.yaml` under `dsh-supervisor:` AND in the web UI
 * (Settings → Plugins → Supervisor; card in lib/client.js). Live values reach
 * the spawn tool (lib/spawn.js) through the `supervisorSettings` service. */
export const SETTINGS_NS = settingsNamespace('dsh-supervisor')

const SettingsSchema = z.object({
  /** Complete worker-model allowlist (`provider/model-id` or the explicit
   * runtime/current sentinel). Empty disables the guarded `subagent` tool. */
  workerModels: z.array(z.string()).default([RUNTIME_MODEL_KEY]),
  /** Max simultaneously ACTIVE workers per supervisor; 0 = unlimited.
   * Enforced by the spawn tool at call time. */
  maxParallelWorkers: z.number().step(1).min(0).default(3),
  /** How often the supervisor wakes to inspect running workers (minutes).
   * Arms a recurring schedule reminder; harness floor is 5. */
  wakeMinutes: z.number().step(1).min(5).default(5),
  /** How long the supervisor waits for an answer to a question (minutes)
   * before recording an assumption and continuing. */
  questionWaitMinutes: z.number().step(1).min(1).default(2),
})

const SETTINGS_DEFAULTS = {
  workerModels: [RUNTIME_MODEL_KEY],
  maxParallelWorkers: 3,
  wakeMinutes: 5,
  questionWaitMinutes: 2,
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_ID = 'main-agent'

/** Cap for raw text files in the feed payload (the UI shows a tail anyway). */
const TEXT_CAP = 64 * 1024
/** Cap for JSONL entries per file (newest kept). */
const JSONL_CAP = 300

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ syncPreset?: 'if-absent' | 'always' | 'never' }} [config]
 */
export function apply(ctx, config) {
  // Cordis contexts carry a logger; console remains the fallback for odd hosts.
  const log = ctx?.logger ?? console
  installPreset(log, config)

  // Meta-config: register the settings section and publish the live value as
  // the `supervisorSettings` service (spawn.js reads it at every tool call and
  // in its live prompt section, so edits apply mid-session with no restart).
  let source = () => SETTINGS_DEFAULTS
  const watchers = new Set()
  ctx.provide('supervisorSettings', {
    current: () => ({ ...SETTINGS_DEFAULTS, ...source() }),
    subscribe: (listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  })
  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, SETTINGS_DEFAULTS, {
    setSource: (current) => { source = current },
    onChange: () => {
      for (const listener of watchers) {
        try {
          listener()
        } catch (error) {
          log.warn(`dsh-supervisor: settings watcher failed: ${error?.message ?? error}`)
        }
      }
    },
  })

  // Nested fiber: waits for `webServer` on web profiles, never mounts elsewhere.
  ctx.plugin({
    name: 'dsh-supervisor-feed',
    inject: ['webServer', 'llm', 'agents', 'sessions'],
    apply: (feedCtx) => {
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/feed',
        handler: feedHandler,
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/models',
        handler: (req, res) => modelsHandler(feedCtx, req, res),
      }))
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/stop',
        handler: (req, res) => stopHandler(feedCtx, req, res),
      }))
      log.info('dsh-supervisor: routes registered at /supervisor/feed, /supervisor/models and /supervisor/stop')
    },
  })
}

/**
 * `GET /supervisor/models` — the explicit runtime/current choice followed by
 * the harness model catalog (provider/model-id + native input modalities) for
 * the settings card's "add model" dropdown.
 */
async function modelsHandler(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const models = [{
    provider: 'runtime',
    id: 'current',
    name: 'Current runtime model',
    modalities: [],
    dynamic: true,
  }]
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        if (`${model.provider}/${model.id}` === RUNTIME_MODEL_KEY) continue
        models.push({
          provider: model.provider,
          id: model.id,
          name: model.name,
          modalities: model.inputModalities ?? ['text'],
        })
      }
    } catch {
      // One adapter failing to enumerate must not empty the whole dropdown.
    }
  }
  const payload = JSON.stringify({ models })
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : payload)
}

/**
 * Install the bundled preset into the user preset root (idempotent, a
 * filesystem fact — an installed preset outliving the plugin is the point).
 */
function installPreset(log, config) {
  const mode = config?.syncPreset ?? 'if-absent'
  if (mode === 'never') return
  const source = join(PACKAGE_ROOT, 'agent-presets', PRESET_ID)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = join(home, '.agent-presets', PRESET_ID)
  try {
    if (!existsSync(join(source, 'agent.cordis.yml'))) {
      log.warn(`dsh-supervisor: packaged preset missing at ${source} — broken install`)
      return
    }
    if (existsSync(target) && mode !== 'always') {
      log.info(`dsh-supervisor: preset "${PRESET_ID}" already present at ${target} — leaving it untouched (syncPreset: 'always' to overwrite)`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
    log.info(`dsh-supervisor: installed preset "${PRESET_ID}" -> ${target}`)
  } catch (error) {
    // Never fail the boot over preset sync; the manual path (README) remains.
    log.warn(`dsh-supervisor: preset install failed: ${error?.message ?? error}`)
  }
}

/** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} */
function feedHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const ws = url.searchParams.get('ws')
  const send = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : payload)
  }
  if (ws === null || ws === '') return send(400, { error: 'missing ?ws=<workspace path>' })
  const root = resolve(ws)
  const agi = join(root, '.agi')
  let stats
  try {
    stats = statSync(agi)
  } catch {
    return send(404, { error: `no .agi directory under ${root}` })
  }
  if (!stats.isDirectory()) return send(404, { error: `${agi} is not a directory` })
  try {
    send(200, collectFeed(root, agi))
  } catch (error) {
    send(500, { error: String(error?.message ?? error) })
  }
}

/**
 * `GET /supervisor/stop?session=<sessionId>` reports whether a supervisor is
 * idle with no active reminders, including from a cold persisted Session.
 * `POST` FULL-stops one supervisor: aborts the active turn (clearing queued
 * work) and deletes every active schedule reminder, so nothing re-wakes the
 * agent later. Without this, the native stop square only aborts the current
 * turn — the recurring check-in reminder (`wakeMinutes`, floor 5 min) fires
 * again and the agent resumes.
 *
 * Safety: schedule deletes MUST NOT race the agent's own schedule operations —
 * a delete event targeting an id that is no longer active permanently poisons
 * the session's schedule fold (`ScheduleLogError` on every future replay).
 * The agent mutates schedules only from inside its own activity (tool calls
 * during turns; the schedule runtime dispatches inside `runMaintenance`), so
 * this handler cancels, waits for idle, and performs the fold + deletes inside
 * its own exclusive `runMaintenance` window — the same discipline the shipped
 * schedule runtime uses.
 *
 * The browser resolves a worker view to its root supervisor and resumes a cold
 * supervisor without sending a prompt before calling this route. Direct calls
 * against cold or non-supervisor sessions fail instead of reporting a false
 * success. Running workers are NOT killed: each may still wake the supervisor
 * once with its settle report, but with the reminders gone there is no
 * recurring wake.
 */
async function stopHandler(ctx, req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId === '') return send(400, { error: 'missing ?session=<sessionId>' })

  let foldScheduleEvents
  try {
    ({ foldScheduleEvents } = await import('@deepseek-ai/dsh-schedule'))
  } catch {
    return send(500, { error: 'schedule package not available in this profile' })
  }

  const agent = ctx.agents.get(sessionId)
  if (req.method === 'GET') {
    let session
    if (agent !== undefined) {
      try {
        await ctx.sessions.flush(agent.session)
      } catch {
        return send(503, { error: 'could not establish durable schedule state' })
      }
      session = agent.session
    } else {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return send(503, { error: 'session persistence is unavailable' })
      try {
        const inspected = await persistence.inspect(sessionId)
        session = { header: inspected.meta, events: inspected.events }
      } catch {
        return send(404, { error: 'session was not found' })
      }
    }
    if (session.header.origin === 'subagent' || sessionAgentPreset(session) !== PRESET_ID) {
      return send(409, { error: 'session is not a root main-agent supervisor' })
    }
    let folded
    try {
      folded = foldScheduleEvents(session.events, session.header.seedLength ?? 0)
    } catch {
      return send(500, { error: 'schedule log could not be folded' })
    }
    const reminders = folded.active.map(record => record.id)
    const running = agent?.status === 'running'
    return send(200, { stopped: !running && reminders.length === 0, running, reminders })
  }

  if (agent === undefined) {
    return send(409, { error: 'session is not live; resume the supervisor and retry' })
  }
  if (agent.session.header.origin === 'subagent'
    || sessionAgentPreset(agent.session) !== PRESET_ID) {
    return send(409, { error: 'session is not a root main-agent supervisor' })
  }

  const outcome = await fullStopAgent(
    agent,
    session => ctx.sessions.flush(session),
    foldScheduleEvents,
  )
  if (outcome.kind === 'stopped') {
    return send(200, {
      live: true,
      cancelled: true,
      durable: true,
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
    })
  }
  if (outcome.kind === 'postflight-failed') {
    return send(200, {
      live: true,
      cancelled: true,
      durable: false,
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
      note: 'flush uncertain — deletes applied in memory',
    })
  }
  if (outcome.kind === 'idle-timeout') {
    return send(504, { error: 'agent did not reach idle within 15s; reminders not touched — retry' })
  }
  if (outcome.kind === 'preflight-failed') {
    return send(503, { error: 'could not establish durable schedule state; reminders not touched — retry' })
  }
  if (outcome.kind === 'fold-failed') {
    return send(500, { error: 'schedule log could not be folded; reminders not touched' })
  }
  if (outcome.kind === 'append-failed') {
    return send(500, {
      error: 'could not append every reminder deletion; retry',
      remindersDeleted: outcome.ids.length,
      ids: outcome.ids,
    })
  }
  if (outcome.kind === 'busy') {
    return send(503, { error: 'agent stayed busy; reminders not touched — retry' })
  }
  return send(500, { error: 'full-stop maintenance failed; retry' })
}


/** Assemble the whole feed document from the workspace's .agi tree. */
function collectFeed(root, agi) {
  return {
    ws: root,
    generatedAt: Date.now(),
    goal: text(join(agi, 'GOAL.md')),
    amendments: text(join(agi, 'GOAL_AMENDMENTS.md')),
    notes: text(join(agi, 'NOTES.md')),
    missionReport: text(join(agi, 'MISSION_REPORT.md')),
    config: jsonFile(join(agi, 'config.json')),
    progress: jsonl(join(agi, 'progress.jsonl')),
    questions: jsonl(join(agi, 'questions.jsonl')),
    changelog: jsonl(join(agi, 'CHANGELOG.jsonl')),
    subagents: subagentDirs(join(agi, 'subagents')),
  }
}

/** Text file as { text, mtime } (tail-capped), or null when absent. */
function text(path) {
  try {
    const stat = statSync(path)
    let value = readFileSync(path, 'utf8')
    if (value.length > TEXT_CAP) value = value.slice(-TEXT_CAP)
    return { text: value, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Parsed JSON file, or null when absent/malformed. */
function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** JSONL entries (newest JSONL_CAP kept; malformed lines skipped), or []. */
function jsonl(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // A half-written trailing line during an append is normal; skip it.
    }
  }
  return entries.slice(-JSONL_CAP)
}

/** Per-worker artifact inventory: outcome.md content and extra file names. */
function subagentDirs(path) {
  let names
  try {
    names = readdirSync(path)
  } catch {
    return []
  }
  const out = []
  for (const dirName of names) {
    const dir = join(path, dirName)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let files = []
    try {
      files = readdirSync(dir)
    } catch { /* unreadable worker dir: report it empty */ }
    out.push({
      name: dirName,
      outcome: text(join(dir, 'outcome.md')),
      files,
    })
  }
  return out
}
