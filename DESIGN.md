# Always-On Supervisor Agent — Design Document

A 24/7 Main Agent that supervises parallel Dev Agents (subagents), built entirely as
DeepSeek Harness (DSH) agent presets + reusable Cordis plugins. Portable: point it at any
workspace; all state lives in a relative `.agi/` directory there.

Status: design locked after three interview rounds (decisions Q1–Q23, log at bottom),
then **amended after verifying the harness** (amendments A1–A6, §13), then **simplified
after user review** (simplifications S1–S4, §14). The feasibility spike is resolved on
paper — DSH natively ships most of the supervision loop.
Next step: build per `IMPLEMENTATION_PLAN.md` (M0 smoke test first).

---

## 1. Core concept

- **Main Agent** — one long-lived DSH session. Interviews the user until the goal is
  clear, locks it, then loops: spawn subagents → sleep → wake → inspect traces → steer /
  kill / continue → repeat. Communicates proactively with the user; never hard-blocked
  waiting on a human except at the goal-confirmation gate.
- **Dev Agent** — a generic worker with full tool access, personalized per spawn: the
  Main Agent authors each child's **role persona** (browser operator, researcher,
  implementer, …) and a complete, self-contained task — both travel in the spawn call;
  there are no brief files (S4). Multiple may run in parallel (default 1). It
  installs whatever task tooling it needs at runtime (e.g. Playwright); no task tools
  are pre-built. Realized as the custom `spawn_agent` tool in the `agi-spawn` host
  plugin (A6).
- **Files are the source of truth.** The Main Agent's session context is a cache, never
  the record. Goal, notes, progress, questions, changelog, and subagent artifacts are
  all on disk in `.agi/`, written as it goes. The UI renders those same files.

## 2. Composition split (where each piece lives)

| Piece | Kind | Notes |
|---|---|---|
| `main-agent` | agent preset | persona, supervision protocol |
| Dev Agent | `agi-spawn` host plugin (`spawn_agent` tool) | per-spawn role persona authored by the Main Agent; model + parallel limit in its row config (A6, S2, S3) |
| `tool-delay` | host plugin | deterministic delay between tool calls |
| `subagent-trace` | host plugin | auto-captures subagent activity to `trace.log` |
| `wait_for_agents` | host plugin (tool) | the sleep/wake primitive (the one custom loop piece — A5) |
| state service | host plugin | serves `.agi/` to the UI over a web route |
| schedule overlay | shipped rows | `dsh-schedule` + `dsh-time-context` for the question-patience timer |
| Progress Tab | client plugin | goal + event feed + question stack (display-only) |
| Subagents Tab | client plugin | run list + detail pane + kill/steer buttons |

Plugins are independent and reusable — never inlined into a preset. Promote a plugin
into the host composition proper only once proven. The shipped preset install is never
edited; authored presets live in their own directories under `.agent-presets/`.

## 3. Main Agent

### 3.1 Lifecycle
One long-lived session (Q1a). No special context machinery for v1 (Q12): normal
compaction suffices. No mandated wake ritual (S1): native session persistence is the
memory across restarts — a crash or restart resumes the session as-is. `.agi/` (goal,
notes, progress, subagent artifacts) remains the durable, human-inspectable record;
the agent consults and updates it as the work demands, not by ritual.

### 3.2 Sleep/wake loop (the heart of the system)
Driven by the `wait_for_agents` tool (Q11, Q21):

- **No arguments.** It blocks until a subagent settles (returns or reports
  blocked-on-a-question) **or** `wakeMinutes` elapses — whichever comes first. The
  timeout is read from meta-config at call time, never chosen by the agent.
- Spawning is always followed immediately by `wait_for_agents` — enforced by the
  supervisor protocol in the persona (v1) — so the Main Agent cannot forget to sleep.
- **Timeout wake:** tail/grep the subagent's `trace.log`, judge progress. If on track →
  call `wait_for_agents` again (one short, bounded turn — that's the supervision cost,
  tuned via `wakeMinutes`). If drifting → steer or kill (§5).
- **Settle wake:** the native settle notice (or a child's `report`) wakes the parent
  turn. Read `outcome.md`; answer a blocked question via `send_message` (A4), or
  process the result and plan the next spawn.

Rationale: pure blocking would make the Main Agent blind mid-flight and silently delete
the steering requirement; pure polling wastes tokens. This is settle-or-timeout, the
cheapest loop that still supervises. Note (A5): continuable children are *not* jobs, so
`job_output(wait: true)` cannot replace this tool — it stays custom.

### 3.3 Question protocol (user ↔ Main Agent) (Q9, Q18)
- Behaves like a normal agent first: asks in chat and waits.
- If no reply within `questionWaitMinutes` (default 5): record the question as
  `assumed` in `questions.jsonl` with the assumption taken, log it, continue on
  unblocked work. Never idle-block on a human. The patience timer is a native
  `schedule_create` one-shot reminder (shipped schedule overlay), not custom machinery.
- A late reply is **fresh steering**, not automatic retroactive rework: the agent states
  what it assumed and what it already did; the user decides if rework is worth it.
- The agent may **withdraw** its own stacked questions with a reason when it
  self-resolves them (e.g. asked for a file, then found it by searching).
- All human input flows through the Main Agent chat. The Progress Tab is display-only.
  A user chat message is itself a wake-up (a turn), so chat is also how the user steers
  the Main Agent.

### 3.4 Self-evolution (Q4)
Allowed to modify, on its own:
- its `.agi/` state files and role personas (trivially);
- its **own preset** and the **`agi-spawn` plugin** (add tools, rewrite subagent setup
  instructions and default persona fragments, tune prompt sections);
- **dynamic Cordis plugins** at runtime (new tools/UI; temporary until persisted into a
  preset).

Never the host composition (a bad edit bricks the harness).

Rules:
- **Every action logged** to `CHANGELOG.jsonl` — this is non-negotiable; the log is how
  the user knows what truly happened.
- Tool additions apply immediately (restart itself if needed); **persona/instruction
  rewrites are queued for user review** — persona drift is the dangerous failure mode.
- Preset edits are announced in the Progress Tab feed.
- May *propose* `config.json` changes as questions, never edit it (§6).

### 3.5 Goal ceremony (Q19)
Lightweight: interview over several turns (as many as the situation needs) → write
`GOAL.md` (objective, constraints, milestones, out-of-scope) → user accepts or keeps
chatting → on acceptance, mark locked. After locking, `GOAL.md` is never edited;
changes are append-only entries in `GOAL_AMENDMENTS.md`, each user-confirmed. This
acceptance gate is the one legitimately blocking question in the system. Planning is
also when the agent asks the user for anything only they can provide (credentials,
cookies, accounts — see §9).

## 4. Dev Agent

- **A custom spawn tool — not a second preset, and not the shipped delegation row
  (A3 + A6).** In-process children share the parent's process composition, so a second
  preset buys nothing (A3). The shipped `tool-subagent` row is also out: it fixes one
  persona per composition row, too rigid for personalization (A6). One layer down, the
  `ctx.subagents` service accepts **persona and tool filter per request** ("in-process
  backends scope filters and personas to child creation" — `docs/subsystems/subagent.md`),
  and a continuable child's descriptor snapshots the resolved persona and model for cold
  resume. The Dev Agent is therefore the `agi-spawn` host plugin registering
  `spawn_agent(description, role, persona, prompt)`, a thin wrapper over
  `ctx.subagents.startContinuable()`.
- **Per-spawn personalization:** the Main Agent authors each child's persona at spawn
  time; the `prompt` argument carries the complete, self-contained task (S4),
  structured per §7.2. Persona says who the child *is*; the task says what it must *do*.
- **Parallel limit enforced by the tool (S3):** `spawn_agent` counts running children
  and rejects the call with a clear error at `maxParallelSubagents`. The limit is also
  injected into the tool's description at mount, so the agent knows it up front — but
  the tool, not the persona, is the enforcement.
- Full tools/MCPs/skills. Installs additional tooling at runtime as the task demands.
- **Stays focused on the task**: no self-logging duty — the `subagent-trace` plugin
  captures its activity automatically (Q13b), so a confused subagent can't "forget" to
  leave a trail.
- **Blocked-question protocol (Q14a, amended A4):** if blocked on information only the
  supervisor or user has, it calls its native `report` tool with the question and stops
  working. Report delivery (wakeup) opens a parent turn; the Main Agent answers via
  `send_message`, and the answer arrives as the child's next turn — context preserved,
  no fork needed.
- On completion it writes `outcome.md` (what it did, what it verified, what remains),
  then reports a one-paragraph summary.
- **Model:** `subagentModel` is set in the `agi-spawn` row config (S2) — user-owned;
  the agent may propose changes, the user edits the composition. The row lives in the
  live-watched profile patch layer, so a change still applies without a session remount.
- Pacing is deliberately absent from tasks — the delay plugin enforces it; tasks never
  repeat what infrastructure guarantees.

## 5. Supervision & steering (Q5, Q6, Q15, Q22 — amended A1/A2)

Exactly three verbs, each writing a `CHANGELOG.jsonl` entry:

| Verb | Mechanics |
|---|---|
| **spawn** | `spawn_agent` with the role persona and a complete, self-contained task (S4) — continuable background child; returns a durable child id. Rejected with a clear error at the parallel limit (S3). |
| **kill** | native `interrupt_agent` + no further messages (A2): the current turn stops and an unmessaged child burns zero tokens. `job_kill` covers one-shot background children. The kill-reliability hard requirement is satisfied natively. |
| **steer** | native `send_message` (A1): queues the correction as the running child's next turn — the exact Q15 wording, shipped. Prepend `interrupt_agent` only when the current turn must stop *now*. Also how blocked questions are answered. |

Native DSH mechanics only (per Q22) — and better than the planned kill+fork fallback:
mid-flight message injection is shipped. Kill + respawn-*fresh* (new spawn, revised
task and persona) remains the fallback when the child's context itself is poisoned.

**Trace capture (Q13b):** the `subagent-trace` host plugin taps the native
`session/event` firehose (A5) and appends every tool call + result summary to
`subagents/<run-id>/trace.log`. Deterministic; enables the tail/grep inspection loop
in §3.2 and feeds the Subagents Tab.

## 6. Meta-configuration (Q7, Q16)

`.agi/config.json` — **user-only**. The Main Agent may propose changes as questions but
never edits it. Read live: every sleep re-reads it, so the user can retune a running
system without restarting anything.

```json
{
  "toolDelaySeconds": 2,
  "wakeMinutes": 5,
  "questionWaitMinutes": 5
}
```

- `toolDelaySeconds` — enforced by the `tool-delay` host plugin intercepting tool
  execution: deterministic, uniform, applies to every agent. A dev-time throttle against
  rate limits / cost explosion; **removed once the system is proven** (kept simplistic
  on purpose — no per-preset overrides, no budgets).
- `wakeMinutes` — the `wait_for_agents` timeout (§3.2).
- `questionWaitMinutes` — patience window before a question is stacked as `assumed`.

`maxParallelSubagents` and `subagentModel` are **not** here: they live in the
`agi-spawn` row config (S2, S3) — still user-owned (the agent proposes, the user edits
the composition). The parallel limit is enforced by `spawn_agent` itself and stated in
its description. The Main Agent must still handle >1 children (multiple live child ids,
interleaved settle notices) when the user raises the limit.

## 7. State directory `.agi/` (Q2c, Q23)

Relative to the target workspace — the whole setup (preset + plugins) is workspace-
agnostic and runs on any repo. Plain files: human-inspectable, grep-able,
git-versionable. Written by the Main Agent (except `config.json`); the state service
merely reads and serves them to the UI.

### 7.1 Tree

```
.agi/
  config.json              # user-only meta-config (§6)
  GOAL.md                  # locked after ceremony, never edited
  GOAL_AMENDMENTS.md       # append-only, each entry user-confirmed
  NOTES.md                 # Main Agent free-form working memory
  progress.jsonl           # event feed rendered by the Progress Tab
  questions.jsonl          # question stack (§7.4)
  CHANGELOG.jsonl          # every self-evolution + steering action (§7.3)
  subagents/
    <run-id>/
      trace.log            # automatic capture (subagent-trace plugin)
      outcome.md           # final report, or blocked-question payload
```

### 7.2 Task structure (the `spawn_agent` prompt) (S4)

The same structure v1 kept in a per-run `brief.md`, now carried entirely in the spawn
call — no file:

```markdown
# Role
One paragraph: who you are for this task.

# Objective
What done looks like, concretely and verifiably.

# Scope
In: ...   Out: ... (touch nothing outside this)

# Context
Pointers to relevant files/URLs/prior outcomes — not prose dumps.

# Protocol
- Blocked on info only the supervisor/user has → call the report tool with the
  precise question, then stop; the answer arrives as your next turn (A4).
- On completion → write outcome.md (done / verified / remaining) under
  .agi/subagents/<run-id>/, then report a one-paragraph summary.

# Constraints
Task-specific rules (e.g. "draft, never post without confirmation").
```

### 7.3 Changelog entry (one JSON object per line)

```json
{"ts": "...", "actor": "main-agent",
 "action": "preset-edit | plugin-define | spawn | kill | steer | config-proposal",
 "summary": "one sentence", "detail": "path, diff pointer, or run-id"}
```

### 7.4 Question lifecycle (`questions.jsonl`)

`pending` (asked in chat simultaneously)
→ `assumed` (after `questionWaitMinutes`; assumption recorded; work continues)
→ `answered` (user replied; late answers = fresh steering, §3.3)
or → `withdrawn` (agent self-resolved it; reason recorded).

## 8. UI (Q8, Q17, Q18)

One client plugin registering two `conversation.view` tabs, rendering `.agi/` via the
state service route. **Display-only** — every answer/instruction goes through the Main
Agent chat (buttons may pre-compose a chat message to the Main session, never act
directly).

- **Progress Tab:** (1) locked Goal + amendments, (2) reverse-chronological feed from
  `progress.jsonl` (Main Agent summaries and key ideas, so the user always has the
  high-level picture), (3) question stack — `pending` and `assumed` shown prominently.
- **Subagents Tab:** one stable tab (not per-run tabs — they'd pile up on a 24/7
  system): run list with live runs pinned on top; detail pane with status, the spawn
  task, live trace tail, and kill/steer buttons. Child sessions are ordinary sessions
  in the Web GUI (A5), so each run links to its native session view for the full
  trajectory; `trace.log` remains the grep-able summary surface.

## 9. First test: X.com growth automation

A deliberately open-ended long-horizon exercise. The agent acts on the user's behalf.

1. User gives full instructions → goal ceremony (§3.5). During planning the Main Agent
   asks the user for credentials / cookies / anything only the user can provide.
2. Main Agent spawns a Dev Agent with a browser-operator persona and a complete
   automation task. The subagent sets up its own tooling at runtime (e.g. Playwright)
   and runs a multimodal loop: screen → action → new screen → …
3. Main Agent supervises on the §3.2 loop: wake every `wakeMinutes`, check the trace,
   steer or evolve the setup (better tools, revised persona/task) as it learns what
   works.
4. Milestones: first 10 followers, then 100 — via posting / reposting / sharing
   strategies.

## 10. Feasibility caveats — RESOLVED (A5)

All five spike questions are answered natively by the harness (sources in
`IMPLEMENTATION_PLAN.md` §1); M0 smoke-tests them once before building:

1. **Settle notifications** — native: a continuable child's settlement unconditionally
   delivers a notice (outcome + final message) to the parent.
2. **Fork-with-correction** — superseded: native `send_message` injects a correction
   as the running child's next turn (A1); fork is not needed for steering.
3. **Reliable kill** — native `interrupt_agent`; an unmessaged child does no further
   work and burns no tokens (A2).
4. **Trajectory access** — child sessions appear as ordinary sessions in the Web GUI;
   the Subagents Tab links to them; `trace.log` is the grep surface.
5. **Event tap** — native: the host `session/event` firehose is observable from an
   ordinary host plugin.

## 11. Build order (revised per amendments)

| # | Deliverable | Kind |
|---|---|---|
| 0 | M0 smoke test of the native loop (§10) | spike |
| 1 | `main-agent` preset (persona, supervision protocol) | agent preset |
| 2 | `agi-spawn` host plugin (`spawn_agent` = the Dev Agent, A6; limit enforcement S3) | plugin |
| 3 | schedule overlay rows (question-patience timer) | shipped rows |
| 4 | `tool-delay` host plugin | plugin |
| 5 | `subagent-trace` host plugin | plugin |
| 6 | `wait_for_agents` tool | plugin |
| 7 | State service (web route over `.agi/`) | host plugin |
| 8 | Progress Tab | client plugin |
| 9 | Subagents Tab | client plugin |

Sequence: 0 → 1–6 as the **headless core**, proven end-to-end on a toy task (e.g.
"summarize a repo") exercising the full spawn → sleep → wake → trace-check → settle →
outcome loop, including one forced steer, one forced kill, and one blocked question →
then 7–9 (the UI reads state that already exists) → goal-ceremony dry-run → X.com test.
Milestone detail, code skeletons, and verification steps live in
`IMPLEMENTATION_PLAN.md`.

## 12. Decision log

| Q | Decision |
|---|---|
| Q1 | (a) one long-lived session; goal/notes/memory files always maintained |
| Q2 | (c) files are truth; thin service serves UI; agent writes & inspects itself |
| Q3 | (b) preset split — *amended A3/A6: dev agent is the custom `agi-spawn` spawn tool, not a second preset* |
| Q4 | (b+c) may edit own preset + dynamic plugins, never host composition; everything logged; tool adds immediate, persona rewrites queued for review |
| Q5 | sleep → wake after `wakeMinutes` → inspect via tail/grep on trace log; early wake on question/return |
| Q6 | steering both directions: user→main via chat; main→subagent via steer verb |
| Q7 | (b) deterministic tool delay (2s) via host plugin; dev-time only, uniform, simplistic |
| Q8 | Progress Tab + single Subagents Tab with run views |
| Q9 | ask normally; stack as `assumed` after 5 min silence; continue; agent may withdraw |
| Q10 | meta-config incl. subagent model (read live at spawn, A6); all task tooling made/installed at runtime |
| Q11 | `wait_for_agents` tool; spawn is always followed by it when parallelism = 1 |
| Q12 | no context machinery; compaction + on-disk files |
| Q13 | (b) automatic trace capture by host plugin; dev agent stays task-focused |
| Q14 | (a) blocked child asks and pauses — *amended A4: native `report` tool, answered via `send_message`; no fork* |
| Q15 | verbs: spawn / kill / steer only; no nudge |
| Q16 | (a) config.json user-only, applies to both agents; agent may only propose |
| Q17 | single Subagents tab; native session views linked per run (A5) |
| Q18 | all input via Main Agent chat; tabs display-only; late answers = fresh steering; agent may erase self-resolved questions |
| Q19 | lightweight goal ceremony; locked GOAL.md + append-only amendments |
| Q20 | credentials/cookies requested from user during planning |
| Q21 | (b) settle-or-timeout; timeout from meta-config, no tool argument |
| Q22 | follow DSH natives — *amended A1/A2: steer = `send_message`, kill = `interrupt_agent` + silence; kill reliability native* |
| Q23 | state in relative `.agi/` per workspace — portable to any repo |

Entries above are the historical record; where a §14 simplification conflicts with one
(e.g. Q10's config placement), §14 wins.

## 13. Amendments after harness verification

Checked against the DSH checkout (`/root/deepseek-harness`, dsh 0.1.0-rc.7); exact
source references in `IMPLEMENTATION_PLAN.md` §1. A1–A5 delete planned custom machinery
in favor of shipped native mechanisms; A6 rebuilds one piece custom on purpose, for
personalization.

| A | Supersedes | Amendment |
|---|---|---|
| A1 | Q22/§5 steer | Steer is native `send_message`: it queues a message as the running child's next turn — the original Q15 wording, strictly better than the kill+fork fallback we designed. `interrupt_agent` first only when the current turn must stop immediately. |
| A2 | §5 kill | Kill is native `interrupt_agent` + no further messages: the child goes idle and burns zero tokens. `job_kill` covers one-shot background children. The hard reliability requirement is met without custom code. |
| A3 | Q3/§2/§4 | No second preset. In-process children share the parent's composition; the Dev Agent's specialization travels with the spawn call instead. (First realized as a shipped `spawn_dev_agent` delegation row; that placement is superseded by A6.) |
| A4 | Q14/§4/§7.2 | Continuable children natively carry a `report` tool with wakeup delivery: a blocked child reports its question and stops; the parent answers via `send_message`. The end-run-blocked + fork-resume dance is deleted. |
| A5 | §10 spike | The feasibility spike is resolved by documentation plus one M0 smoke test: settle notices, mid-flight steering, kill, the `session/event` tap, and per-child session views in the GUI are all native. Only `wait_for_agents` remains custom (continuable children are not jobs, so `job_output(wait)` cannot substitute). |
| A6 | A3/Q10/§4 | Per-spawn personalization. The shipped `tool-subagent` row fixes one persona per composition row, but the underlying `ctx.subagents` service accepts persona and tool filter per request, and the child descriptor snapshots them for cold resume. The Dev Agent is therefore the custom `agi-spawn` host plugin: a `spawn_agent(description, role, persona, prompt)` tool wrapping `startContinuable()`. The Main Agent authors each child's persona; model placement is superseded by S2. |

## 14. Simplifications after user review

Targeted cuts only — everything else in this document stands as designed.

| S | Supersedes | Simplification |
|---|---|---|
| S1 | §2/§3.1 wake ritual | No mandated wake ritual. Native session persistence is the memory across restarts; `.agi/` files remain the durable record, consulted and updated as the work demands rather than by a read-on-wake / write-before-sleep ritual. |
| S2 | Q10/A6/§6 | `subagentModel` lives in the `agi-spawn` row config, not `.agi/config.json` — still user-only; the agent proposes, the user edits the composition. The row sits in the live-watched profile patch layer, so changes apply without a remount. |
| S3 | §6 `maxParallelSubagents` | The parallel limit is enforced by `spawn_agent` itself: hard reject with a clear error at the limit, limit injected into the tool description at mount, configured on the same `agi-spawn` row. The persona no longer carries the check. |
| S4 | §7.1/§7.2 `brief.md` | No brief files. The role persona and a complete, self-contained task travel in the spawn call; §7.2 now describes the task text's structure. `trace.log` and `outcome.md` remain per run. |

Unchanged by review: the rest of the `.agi/` state model and file formats (§7),
question lifecycle (§7.4), goal ceremony (§3.5), `config.json` ownership (§6),
self-evolution rules (§3.4), supervision verbs (§5), and the UI scope (§8).
