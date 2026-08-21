# Implementation Plan — Always-On Supervisor Agent on DeepSeek Harness

Companion to `DESIGN.md` (the locked design, decisions Q1–Q23). This plan maps every
deliverable onto verified DSH/Cordis mechanisms and breaks the build into milestones an
implementing agent can follow step by step without making design decisions.

How to use this plan:

- Work milestones **in order** (M0 → M8). Each has Goal / Steps / Verify. Do not start a
  milestone before the previous one's Verify passes.
- Code blocks marked **SKELETON** are structurally correct but written against documented
  APIs; every place the exact signature must be confirmed first is marked `VERIFY:` with
  the file to read. Read it before writing the code — never guess a signature.
- Before M4 (preset work), load the `editing-cordis-compositions` skill. Before any
  dynamic-plugin probing, load `cordis-plugin-development`.
- Everything here was checked against the checkout at `/root/deepseek-harness`
  (dsh 0.1.0-rc.7). If the deployment version changed, re-verify §1 first.

---

## 1. Ground truth (verified, with sources)

Read these before writing code. Line references are to the checkout.

| Fact | Source |
|---|---|
| Base host composition already mounts: `subagents` registry, `spawn` + `fork` providers, `tool-subagent` (spawn, **continuable**), `tool-subagent-fork` (fork, one-shot), `tool-subagent-control` (`send_message`, `interrupt_agent`), `list_agents`, **`tool-subagent-report`** (children get a `report` tool), `tool-jobs`, `goal` domain + `tool-goal`, `jobs-local`, `timer`, config-watching `hmr` | `packages/bundle/base/cordis.patch.yml` lines 292–383 |
| A continuable background spawn returns `{kind:'continuable', subagentId}` — it is **not** a job; `job_output` does not apply to it | `packages/subagent/tool-subagent/src/index.ts` lines 393–403 |
| A **one-shot** background spawn IS a job (`kind: 'subagent'`) — `job_output(wait:true, timeout_ms)` blocks on it; `jobs.wait(id, timeoutMs)` is the service-level call | same file lines 405–427; `docs/subsystems/jobs.md` (`JobRegistry.wait`) |
| When a continuable child's activation settles, the runtime **unconditionally delivers a notice to the parent** with the outcome and final assistant message — this is the native settle-wake | `docs/subsystems/subagent.md` (`SubagentSettledMessageSource`); tool description in `tool-subagent/src/index.ts` line 309 |
| `send_message` queues a message as the child's **next turn** (running child: after current turn; idle: wakes it; cold: resumes it) — this is the steer verb, natively | `docs/tool-catalog.md` `send_message`; `docs/subsystems/subagent.md` (`followup()` table) |
| `interrupt_agent` stops the child's current turn; the child stays resumable but does **no further work** (no token burn) until messaged again — this is kill | `docs/tool-catalog.md` `interrupt_agent`; `SubagentRuntime.interrupt` |
| Continuable in-process children automatically get a **`report`** tool (parent delivery `wakeup` by default) — the native blocked-question channel | base row `tool-subagent-report`; `docs/tool-catalog.md` §tool-subagent-report |
| `list_agents` enumerates children with status `running`/`idle`/`ready`, scope `descendants` walks the whole tree | `docs/tool-catalog.md` `list_agents` |
| Per-child model/persona/toolFilter are set on the **`tool-subagent` row config** (`agentOptions: {provider, model}`, `persona`, `toolFilter`), not per call — the tool's call schema is only `description`/`prompt`/`run_in_background` | `docs/config-catalog.md` §dsh-tool-subagent; source `Config` |
| `@deepseek-ai/dsh-schedule` (+ `dsh-time-context`) is NOT mounted by default; the shipped opt-in overlay is two insert rows | `examples/web-schedule/cordis.yml` |
| Schedule delivers reminders as ordinary later turns to the **same live session**; one-shot `after_seconds` has no minimum, recurring `every_seconds` min 300s | `docs/subsystems/schedule.md` |
| Tool pipeline waterfalls `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` can transform/delay any call — the delay hook point | `docs/tool-execution-pipeline.md` |
| Host firehose `'session/event'(session, event)` observes every session's durable events (`tool/call`, `tool/result`, …) — the trace-tap hook point | `docs/subsystems/session.md` line ~805 |
| `ctx.webServer.register(route)` adds a named HTTP route (disposer returned); `POST /api/session.prompt` injects a user message into any session | `docs/subsystems/web-server.md`; `dsh-plugin-experience.md` §6 |
| Presets: author under `${DSH_HOME}/.dsh/.agent-presets/<id>/`; create via `ctx.agentPresets.copy('standard', id)`; validate via `standingKeyFor(id)`; NEVER edit shipped presets; service rows need isolate realms | `editing-cordis-compositions` skill (shipped under `apps/cli/config/agent-presets/cordis/skills/`) |
| Live host-plugin mounting without restart: profile `cordis.patch.yml` is watched; `new-plugin.sh` scaffolds + hot-mounts from source with ESM cache-busting; a NEW client plugin needs one restart + one page reload, after which content edits HMR in ~1s | `/root/my-plugins/dsh-plugin-experience.md`, `new-plugin.sh` |
| A third conversation tab via the `conversation.view` slot is proven working (dsh-ui-banner v0.3) | `dsh-plugin-experience.md` §9 |

---

## 2. Design → DSH mapping, and amendments to DESIGN.md

The feasibility spike (DESIGN.md §10) is **resolved by documentation**: all five answers
are native. That upgrades three design decisions — record these as amendments:

1. **Steer (Q22 amendment).** Native `send_message` IS "append a user message to the
   running agent's queue" — the exact Q15 wording, strictly better than the
   kill+fork-with-correction fallback. Steer = `send_message(child, correction)`,
   optionally preceded by `interrupt_agent(child)` when the current turn must not finish.
   Kill+respawn-fresh remains the poisoned-context fallback.
2. **Kill semantics.** There is no child "destroy". Kill = `interrupt_agent` + never
   message again: the child goes idle/cold and burns nothing. That satisfies the hard
   requirement (no orphan token burn). `job_kill` covers one-shot background children.
3. **Dev Agent is not a second preset.** In-process children share the parent's process
   composition; specialization is per-`tool-subagent`-row config (`persona`,
   `agentOptions.model`, `toolFilter`) plus the brief in the prompt. So "the dev-agent
   preset" is realized as a dedicated delegation row `spawn_dev_agent` inside the
   main-agent preset. Consequence: `subagentModel` is set in that row — user-editable,
   applied at next preset mount, which satisfies "set by user before the run" (Q10/Q16).
4. **Blocked questions (Q14 upgrade).** Children natively carry a `report` tool with
   wakeup delivery. A blocked child calls `report` with its question and simply stops
   working; the parent wakes, answers via `send_message`. No end-run/fork dance needed.

Everything else in DESIGN.md stands unchanged: `.agi/` state tree, file formats,
question lifecycle, changelog schema, goal ceremony, meta-config ownership, UI scope.

### Deliverable inventory (revised)

| # | Deliverable | Realized as | Milestone |
|---|---|---|---|
| 0 | Feasibility | resolved by §1 + one smoke test | M0 |
| 1 | `main-agent` preset | copy of `standard`, edited persona + delegation rows | M4–M5 |
| 2 | Dev Agent | `spawn_dev_agent` row in that preset (persona + model + brief protocol) | M4–M5 |
| 3 | `tool-delay` | repository host plugin, `tools/pre-execute` waterfall | M2 |
| 4 | `subagent-trace` | repository host plugin, `session/event` firehose → `trace.log` | M2 |
| 5 | `wait_for_agents` | repository host plugin (custom tool) + schedule rows as backstop | M2–M3 |
| 6 | State service | repository host plugin, `webServer` route `GET /agi/state` | M2 |
| 7–8 | Progress + Subagents tabs | one client plugin, two `conversation.view` tabs | M7 |

---

## 3. Paths and layout

```
/root/deepseek-harness/            # checkout: docs + source of truth (read-only for us)
/root/my-plugins/                  # our working repo
  DESIGN.md                        # the locked design
  IMPLEMENTATION_PLAN.md           # this file
  agi-tool-delay/                  # M2 host plugin
  agi-subagent-trace/              # M2 host plugin
  agi-wait/                        # M2 host plugin (wait_for_agents)
  agi-state-route/                 # M2 host plugin (serves .agi/ as JSON)
  agi-tabs/                        # M7 client plugin (Progress + Subagents tabs)
  new-plugin.sh / add-plugin-live.sh / remove-plugin-live.sh / restart-web.sh  # existing kit
$DSH_HOME/profiles/web/cordis.patch.yml   # live-watched host-plane mount point
$DSH_HOME/.agent-presets/main-agent/      # M4 preset (agent.cordis.yml + preset.yml)
<target workspace>/.agi/                  # per-workspace state (DESIGN.md §7)
```

Host-plane additions go in the **web profile patch layer** (live-watched, no restart).
The preset carries only what one session contributes. This respects the plane rule.

### Meta-config mapping (`.agi/config.json`)

| Key | Consumed by | Read when |
|---|---|---|
| `toolDelaySeconds` | `agi-tool-delay` | every tool call (live) |
| `wakeMinutes` | `agi-wait` | every `wait_for_agents` call (live) |
| `maxParallelSubagents` | main-agent persona (checks `list_agents` before spawning) | every spawn |
| `subagentModel` | `spawn_dev_agent` row `agentOptions` in the preset | at preset mount — user edits the preset row, takes effect next session; the persona must state this so the agent proposes rather than expects live changes |
| `questionWaitMinutes` | main-agent persona (via `schedule_create`) | every stacked question |

---

## M0 — Preflight and smoke test (½ hour)

**Goal:** confirm the running deployment matches §1 before building anything.

**Steps:**
1. Confirm the server: `tmux capture-pane -t dsh -p | tail -5` shows a live `dsh web`;
   `curl -s http://127.0.0.1:3080/api/host.describe | head -c 200` answers.
   NEVER start a second `dsh` against the same `$DSH_HOME` (gotcha #1 in
   `dsh-plugin-experience.md` — it corrupts live session logs).
2. Confirm `echo $DSH_HOME` and that `$DSH_HOME/profiles/web/cordis.patch.yml` exists.
3. Smoke-test the native loop from any session (or headless:
   `dsh --profile web "..."` is NOT safe — use the existing web session): ask the agent to
   `subagent` a trivial background task ("count files in /tmp, background"), then confirm
   in the transcript: (a) it returned `started subagent <id>`, (b) a settle **notice**
   arrived when the child finished, (c) `list_agents` shows it, (d) `send_message` to it
   starts a new child turn, (e) `interrupt_agent` on a running child stops the turn.
4. Confirm the child session appears in the Web GUI sidebar / session list (this is the
   free "trajectory view" the Subagents tab will link to).

**Verify:** all five observations from step 3 seen in a real transcript. Record any
deviation in `NOTES.md` before proceeding — later milestones assume them.

---

## M1 — State directory contract (½ hour)

**Goal:** the `.agi/` tree exists and matches DESIGN.md §7 exactly.

**Steps:**
1. Pick the test workspace (any repo directory; the toy task in M6 uses it).
2. Create `.agi/` with: `config.json` (all five keys, defaults from DESIGN.md §6),
   empty `NOTES.md`, `progress.jsonl`, `questions.jsonl`, `CHANGELOG.jsonl`,
   `subagents/` directory. `GOAL.md` is created only by the ceremony — do not stub it.
3. Formats are normative in DESIGN.md §7.3–§7.4 — do not restate or reinvent them.

**Verify:** `python3 -c "import json; json.load(open('.agi/config.json'))"` passes.

---

## M2 — The four host plugins (1–2 days)

Scaffold each with `new-plugin.sh <name>` (hot-mounts from source, no restart; re-run
after every edit to bust the ESM cache). All four are ordinary repository plugins in the
field-notes format: ESM module exporting `name`, `inject`, `apply(ctx, config)`.

### M2a — `agi-tool-delay`

**Goal:** deterministic delay before every tool execution, read live from config (Q7).

**VERIFY first:** the exact `tools/pre-execute` listener signature in
`docs/subsystems/tools.md` (it is a waterfall — the listener MUST call and return
`next()`; a dropped `next()` silently blocks every tool in the process).

**SKELETON** (`agi-tool-delay/index.js`):

```js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'agi-tool-delay'
export const inject = ['tools']            // VERIFY: which service owns the waterfall

function delaySeconds(cwd) {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, '.agi', 'config.json'), 'utf8'))
    return Number(cfg.toolDelaySeconds) || 0
  } catch { return 0 }                     // no .agi/config.json => no delay (scopes
}                                          // the throttle to supervised workspaces)

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (call, next) => {   // VERIFY exact params
    const cwd = call?.agent?.session?.cwd ?? process.cwd() // VERIFY cwd access path
    const s = delaySeconds(cwd)
    if (s > 0) await new Promise(r => setTimeout(r, s * 1000))
    return next()
  })
}
```

Notes: the `.agi`-presence guard means the cordis/dev sessions stay snappy while every
agent working in a supervised workspace (main + children share the workspace cwd) is
throttled. `setTimeout` is fine in a repository plugin (Node realm — the "query the
timer service" rule binds dynamic plugins, not repo plugins; see `new-plugin.sh`'s
scaffold which uses plain Node APIs).

**Verify:** with `toolDelaySeconds: 2`, a tool call in a session whose cwd has `.agi/`
visibly lags ~2s (compare timestamps of `tool/call`→`tool/result` in the session log);
a session elsewhere does not.

### M2b — `agi-subagent-trace`

**Goal:** automatic append-only `trace.log` per child run (Q13b) — the tail/grep surface.

**SKELETON:**

```js
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'agi-subagent-trace'
export const inject = []

export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    // VERIFY field names on the Session object: header.origin, header.parentSession,
    // cwd/workspace — read docs/subsystems/session.md "SessionHeader".
    if (session.header?.origin !== 'subagent') return
    if (event.type !== 'tool/call' && event.type !== 'tool/result'
        && event.type !== 'assistant/message') return
    const cwd = session.cwd                      // VERIFY
    const dir = join(cwd, '.agi', 'subagents', String(session.id))
    try {
      mkdirSync(dir, { recursive: true })
      // Smallest owned JSON — never serialize the live event object wholesale.
      const line = {
        ts: new Date().toISOString(),
        type: event.type,
        summary: summarize(event),               // implement: tool name + first 200
      }                                          // chars of args/result text
      appendFileSync(join(dir, 'trace.log'), JSON.stringify(line) + '\n')
    } catch { /* tracing must never break the harness */ }
  })
}
```

Rules that matter here: extract **leaf fields only** (tool name, truncated text) — no
`JSON.stringify(event)` of live objects; wrap all I/O in try/catch; the listener is on
the hot path of every session, so return fast for non-children.

**Verify:** run M0's smoke spawn again in the M1 workspace → `trace.log` appears under
`.agi/subagents/<child-session-id>/` and contains one line per child tool call.

### M2c — `agi-wait` (the `wait_for_agents` tool)

**Goal:** Q21 exactly — no arguments; blocks until a child of the **calling agent**
settles/goes inactive OR `wakeMinutes` (from config, never model-chosen) elapses.

**VERIFY first:** (1) `defineTool` execute's `exec.agent` gives the calling agent and
`exec.signal` its abort signal (see `tool-subagent/src/index.ts` lines 374–379 as the
canonical example); (2) `ctx.subagents.listChildren(parentSessionId)` entry shape —
`activity: 'running' | 'inactive'` per `docs/subsystems/subagent.md` §Durable
enumeration; (3) whether `@deepseek-ai/dsh-tool-call-timeout-policy` (mounted in base)
caps long tool executions — if it does, either configure its row above `wakeMinutes` or
have the tool return early at the cap with a "call me again" result.

**SKELETON:**

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'agi-wait'
export const inject = ['tools', 'subagents']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'wait_for_agents',
    description: 'Sleep until one of your subagents settles or the configured wake '
      + 'interval elapses, whichever is first. Takes no arguments; the interval comes '
      + 'from .agi/config.json (wakeMinutes). Returns which children changed state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('wait_for_agents requires a calling agent')
      const cwd = parent.session.cwd                       // VERIFY
      let wakeMinutes = 5
      try {
        wakeMinutes = JSON.parse(readFileSync(join(cwd, '.agi/config.json'), 'utf8')).wakeMinutes ?? 5
      } catch {}
      const deadline = Date.now() + wakeMinutes * 60_000
      const before = await ctx.subagents.listChildren(parent.session.id)
      const wasRunning = new Set(before.filter(e => e.activity === 'running').map(e => String(e.id)))
      if (wasRunning.size === 0) return 'no running subagents; nothing to wait for'
      while (Date.now() < deadline) {
        if (exec.signal.aborted) return 'wait cancelled'
        await new Promise(r => setTimeout(r, 5000))
        const now = await ctx.subagents.listChildren(parent.session.id)
        const settled = now.filter(e => wasRunning.has(String(e.id)) && e.activity !== 'running')
        if (settled.length > 0) {
          return `woke early: settled/idle: ${settled.map(e => `${e.id} (${e.label ?? ''})`).join(', ')}`
        }
      }
      return `wake interval (${wakeMinutes} min) elapsed; children still running — inspect traces, then wait again or steer`
    },
  }))
}
```

Design subtleties preserved: the timeout is config-read at call time (Q21 — retunable
live); a settle **notice** from the runtime may additionally arrive as queued context
right after this tool returns — that is fine and complementary; when a child used
`report` (wakeup), the parent turn was already woken and this tool simply isn't running.

**Verify:** in a test session: spawn a slow child (`sleep`-heavy prompt), call
`wait_for_agents` → returns early when the child settles; with a long child it returns
at `wakeMinutes`. Confirm the settle notice still arrives.

### M2d — `agi-state-route`

**Goal:** serve `.agi/` state to the browser tabs (Q2c) — read-only JSON.

**VERIFY first:** `WebRoute` shape (`kind`, `path`, handler signature) in
`docs/subsystems/web-server.md`, and how a repo plugin injects `webServer`.

**SKELETON:** register `GET /agi/state?ws=<workspace-path>` returning
`{ config, goal, goalAmendments, notes, progress: [...last 200 lines],
questions: [...], changelog: [...last 200], subagents: [{id, brief, traceTail, outcome}] }`
by reading the files fresh per request (no caching, no watching — poll-driven UI keeps
v1 simple). Path-validate `ws` (must be an absolute existing directory containing
`.agi/`) — this route runs unauthenticated on localhost.

**Verify:** `curl -s 'http://127.0.0.1:3080/agi/state?ws=<workspace>' | python3 -m json.tool`
returns the M1 scaffold.

---

## M3 — Schedule rows (½ hour)

**Goal:** timed self-wakes for the question-patience window (Q9) and as `wait_for_agents`
backstop.

**Steps:** append to `$DSH_HOME/profiles/web/cordis.patch.yml` (live-watched — mind the
existing insert structure and duplicate-id fatality):

```yaml
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
```

(Exactly the shipped `examples/web-schedule/cordis.yml` overlay.)

**Verify:** next turn in any session, `schedule_create`/`schedule_list`/`schedule_delete`
are in the tool list; create a 60s one-shot reminder and see it arrive as a later turn.
Note: reminders are session-local and live-session-only — acceptable, the Main Agent
session is by definition the live one.

---

## M4 — The `main-agent` preset (1 day)

**Goal:** the supervisor's composition. Load `editing-cordis-compositions` first and
follow it to the letter; the summary below is the task-specific delta.

**Steps:**
1. From a cordis-preset session: mount the roster probe (skill §"The roster service"),
   then `agentPresets.copy('standard', 'main-agent', 'Main Agent (Supervisor)')`.
   `resolve('main-agent')` reports the created `agent.cordis.yml` path — edit that path,
   never a guessed one.
2. Write `preset.yml` `name`/`description` if the copy left them empty.
3. Edit `agent.cordis.yml`:
   - **persona row**: replace with the supervisor persona (M5 text).
   - **delegation group**: keep the copied rows; ADD inside the same group:

```yaml
    - id: tool-subagent-dev
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: spawn_dev_agent
        backgroundMode: continuable
        persona: |
          <dev persona from M5>
        agentOptions:
          provider: deepseek-official     # user-owned: subagentModel lives HERE
          model: deepseek-v4-flash        # (meta-config key maps to this row)
```

   - Keep `tool-goal`, `tool-jobs`, delegation controls — they are already in the copy
     and are load-bearing (goal = the 24/7 objective; controls = steer/kill verbs).
   - Do NOT add `agi-*` plugin rows here — they are host-plane (already mounted via the
     profile patch) precisely so every session and child shares one instance. A service
     row loose in a preset is the classic mount-rejection (skill §"The rule that catches
     people").
4. Validate: `standingKeyFor('main-agent')` returns clean. Fix exactly what the
   rejection names; re-validate.

**Verify:** start a real session on `main-agent` in the M1 workspace; confirm the tool
list contains `spawn_dev_agent`, `wait_for_agents`, `send_message`, `interrupt_agent`,
`list_agents`, `schedule_create`, goal tools. Then the one open question from §2.3:
spawn a dev child and confirm **the child's persona is the dev persona, not the
supervisor's** (the spawn row's `persona` config shadows per child — verify it wins over
the preset persona; if it does not, the preset persona must move into guarded prose:
"if you are a spawned child, follow your brief" — decide only on evidence).

---

## M5 — Personas (½ day; iterate during M6)

Full drafts. Keep them in the preset file; every later edit is a changelog entry once
the system supervises itself (Q4).

### Supervisor persona (main-agent preset, `persona` row)

```
You are the Main Agent: an always-on supervisor powered by {{model}}, working in {{cwd}}.
You supervise dev subagents; you do not do implementation work yourself.

STATE — files are the truth, your context is a cache:
- All durable state lives in {{cwd}}/.agi/. On every wake: read NOTES.md and any file
  a notice points at BEFORE acting. Before every sleep: write everything important
  (progress.jsonl event, NOTES.md update). A restart must cost nothing.
- .agi/config.json is USER-ONLY. Never edit it; propose changes as questions.
  The subagent model is fixed in your preset by the user; propose, never expect, changes.
- Append every consequential action (spawn/steer/kill/self-evolution/assumption) to
  .agi/CHANGELOG.jsonl: {"ts","actor":"main-agent","action","summary","detail"}.
- Summarize milestones and key ideas as {"ts","text"} lines in .agi/progress.jsonl —
  the user reads these to follow you at a glance.

THE LOOP:
1. Ensure a locked GOAL.md exists (see CEREMONY). 2. Plan the next work unit.
3. Check maxParallelSubagents in config.json against list_agents before spawning.
4. Spawn: write .agi/subagents/<id-or-slug>/brief.md first (template in NOTES.md),
   then spawn_dev_agent with a prompt that says: read this brief file, follow its
   protocol. After the tool returns the child id, rename/link the brief dir to that id.
5. Sleep: call wait_for_agents (no arguments — the interval is configured).
6. Wake and triage:
   - settle notice / report from a child: read it, read the child's outcome.md and
     trace.log tail, then answer (send_message), close out, or spawn the next unit.
   - wait timeout: tail .agi/subagents/<id>/trace.log. On track => wait_for_agents
     again. Drifting => steer: send_message with a concrete correction (it becomes the
     child's next turn; use interrupt_agent first only if the current turn must stop
     now). Poisoned context => interrupt_agent, log the kill, spawn fresh with a
     revised brief.
   - user message: it overrides everything else; it is steering.
7. Repeat until the goal's milestones are met; keep the goal tool's state current.

QUESTIONS (to the user):
- Ask in chat AND append to .agi/questions.jsonl as {"ts","id","status":"pending","q"}.
- Immediately schedule_create a one-shot reminder for questionWaitMinutes from
  config.json, then continue any work that does not depend on the answer.
- Reminder fires with no reply: set status "assumed", record the assumption, log it,
  proceed. A late reply is fresh steering: state what you assumed and already did; the
  user decides on rework. If you resolve a question yourself, set status "withdrawn"
  with the reason and delete any pending reminder.

CEREMONY (once per goal): interview the user until the objective, constraints,
milestones, and out-of-scope are unambiguous; write GOAL.md; get explicit confirmation
(this is the one blocking question); create the goal via the goal tool; never edit
GOAL.md afterward — user-confirmed changes append to GOAL_AMENDMENTS.md. Ask during
planning for anything only the user can provide (credentials, cookies, accounts).

SELF-EVOLUTION: you may edit your own preset and the dev spawn row (tools,
instructions) and define dynamic plugins. Log every change to CHANGELOG.jsonl first.
Persona/instruction rewrites: write the diff, queue it as a question for user review —
do not apply silently. Never touch the host composition or the shipped presets.
```

### Dev persona (`tool-subagent-dev` row, `persona` config)

```
You are a dev agent under a supervisor. Your first action: read the brief file named
in your prompt ({{cwd}}/.agi/subagents/<run>/brief.md); it defines your role, scope,
and protocol — stay strictly inside its scope.
- Blocked on information only the supervisor or user has: call the report tool with
  the precise question, then stop working until the answer arrives as your next turn.
- On completion: write outcome.md next to your brief (what you did, what you verified,
  what remains), then report a one-paragraph summary.
- Supervisor messages arriving mid-task are course corrections: comply immediately.
- Do not spawn your own subagents unless the brief allows it.
```

The brief template stays as DESIGN.md §7.2 (protocol section updated to name `report`
instead of end-run-blocked — amendment §2.4).

---

## M6 — Headless-core acceptance test (1 day)

**Goal:** prove the full loop end-to-end on a toy task before any UI exists.

**Script** (drive as the user, in the M1 workspace, session on `main-agent`):
1. Give a small real task: "Goal: produce SUMMARY.md describing the layout of
   /root/deepseek-harness/docs — delegate the work, supervise, deliver."
2. Ceremony happens: interview → `GOAL.md` → confirm → goal created.
3. Observe in order, and record each in `NOTES.md` as pass/fail:
   - brief written → `spawn_dev_agent` → `wait_for_agents` called without arguments;
   - `trace.log` filling under `.agi/subagents/<id>/` (M2b working under load);
   - tool calls in the child lagging `toolDelaySeconds` (M2a);
   - **forced steer:** while the child runs, tell the Main Agent "have it also count
     the .zh.md files" → it must `send_message`, not respawn;
   - **forced question:** stay silent when the Main Agent asks something (seed the task
     with an ambiguity, e.g. don't say where SUMMARY.md goes) → after
     `questionWaitMinutes` it must record an assumption and proceed;
   - **forced kill:** tell it "that child is off the rails, kill it and restart with a
     tighter brief" → `interrupt_agent` + changelog entry + fresh spawn;
   - settle notice → `outcome.md` read → progress.jsonl updated → goal completed.
4. Restart resilience: `restart-web.sh`, reopen the session, say "continue" — the agent
   must rehydrate from `.agi/` (per its wake ritual) without re-asking settled things.

**Exit criterion:** every bullet passes twice in a row. Fix persona wording (M5) — not
machinery — first when a step fails; the machinery has its own M2 verifies.

---

## M7 — The two tabs (1–2 days)

**Goal:** Progress Tab + Subagents Tab (DESIGN.md §8), display-only, reading
`GET /agi/state`.

**Steps:**
1. One client plugin `agi-tabs`, built in the field-notes dual-face format
   (`dsh-plugin-experience.md` §4): host half no-op, `client.js`

<!-- NOTE: v1 tail lost. The remainder of M7 and all of M8 (~54 lines) were
     overwritten before this file was placed under version control; this baseline
     commit reconstructs v1 from the session's read history, which was truncated
     at this point. The v2 rewrite in the next commit supersedes this plan. -->
