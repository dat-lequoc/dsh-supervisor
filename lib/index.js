/**
 * dsh-supervisor — host half.
 *
 * Two responsibilities, one package:
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
 * Config (all optional):
 *   syncPreset: 'if-absent' (default) | 'always' | 'never'
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-supervisor'
export const inject = []

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
  // Nested fiber: waits for `webServer` on web profiles, never mounts elsewhere.
  ctx.plugin({
    name: 'dsh-supervisor-feed',
    inject: ['webServer'],
    apply: (feedCtx) => {
      feedCtx.effect(() => feedCtx.webServer.register({
        kind: 'exact',
        path: '/supervisor/feed',
        handler: feedHandler,
      }))
      log.info('dsh-supervisor: feed route registered at /supervisor/feed')
    },
  })
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
