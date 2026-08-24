# dsh-supervisor — an Always-On Supervisor Agent for DeepSeek Harness

A 24/7 **Main Agent** that records a reviewable goal, then loops unattended: spawn a dev
subagent → sleep → wake on settle / report / timer / your message → inspect → steer,
kill, or continue. Built **native-first** on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh): the core is one agent preset, a persona, and one schedule-service row — zero custom
loop machinery. This repo **is an installable dsh plugin bundle**: one command puts the
whole setup on any machine running dsh.

Tested end-to-end on `glm-5.3` (Z.AI): goal setup, grounded delegation, mid-flight
steering, a mid-turn kill + tighter respawn, the silent-question → recorded-assumption
flow, deliverable verification (it caught its own buggy link-checker and re-ran it),
and full process-restart resume. Grader scores: m0–m5 and m7 at 100%.

## Run the local course on a new PC

Install Git and Python 3, clone this repository, then run its course launcher:

```sh
mkdir -p "$HOME/src"
git clone https://github.com/dat-lequoc/dsh-supervisor.git "$HOME/src/dsh-supervisor"
cd "$HOME/src/dsh-supervisor"
./setup-tutorial.sh
```

The launcher creates `.venv-tutorial`, installs the grader-only Python dependencies, selects
an unused `127.0.0.1` port, and prints the tutorial URL. Its local server powers the grade
buttons embedded in each milestone. It intentionally does not install dsh, clone DeepSeek Harness,
configure a model, or create workspaces; the setup chapter teaches those steps explicitly.

## Install the supervisor (chapter 6)

Prerequisites: Node.js 22.19+ in the 22.x line, or Node.js 24+, and dsh
(`npm i -g @deepseek-ai/dsh`), with a model configured (web UI → Settings → Models;
tested with Z.AI `glm-5.3`).

```sh
# When chapter 6 tells you to install the already-cloned package:
cd "$HOME/src/dsh-supervisor"
dsh plugin --profile web add "file:$PWD"

# restart dsh once (bundle layers compose at boot):
dsh web
```

That's the whole install. The one command registers the package as a **profile bundle**
(dependency + `dsh.profile.bundles` entry), and at boot the bundle:

1. mounts the schedule service (`dsh-schedule`) the supervisor's timers need
   (no `dsh-time-context` — it would inject a timestamp block into every request,
   and Schedule does not depend on it), and
2. runs this package's setup plugin (`lib/index.js`), which installs the bundled
   **`main-agent` preset** into `${DSH_HOME:-~/.dsh}/.agent-presets/` — only if absent,
   never clobbering your edits (row config `syncPreset: always | if-absent | never`).

Then create a workspace for the supervisor's state:

```sh
mkdir -p "$HOME/agi-lab/.agi/subagents"
cp "$HOME/src/dsh-supervisor/agi-template/config.json" "$HOME/agi-lab/.agi/config.json"
```

<details>
<summary>Alternative: manual install without the plugin manager</summary>

`./scripts/install-manual.sh ~/agi-lab` copies the preset into the user preset root
and writes the schedule rows into your profile's `cordis.patch.yml` instead. Use ONE
path, not both — the schedule service registers once per process, so the bundle rows
and manual patch rows must not coexist. If your profile already mounts
`dsh-schedule` from elsewhere, disable this bundle's copy with an id-targeted
`disabled: true` patch on `agi-schedule`.
</details>

## Run

Open http://127.0.0.1:3080 → new session → workspace `~/agi-lab` → preset
**Main Agent (Supervisor)** → give it a mission, e.g.:

> Goal: produce SUMMARY.md describing the layout of `<some docs dir>` — delegate the
> work, supervise, deliver.

What you should see, in order: it **grounds** by reading the durable mission state
and relevant workspace runbooks/scripts, calls `start_goal` to write `.agi/GOAL.md`
and arm the native goal immediately, then continues in the same turn. No generated
confirmation phrase or second human reply is required. It then calls the guarded
`subagent` tool with a complete structured task and an explicit Settings-approved model route,
arms a recurring check-in reminder, and sleeps. It wakes on the worker's settle
notice, **verifies the deliverable with its own reads**, logs everything to
`.agi/CHANGELOG.jsonl`, and continues or finishes. You steer at any time by chatting;
workers are ordinary sessions in the sidebar — click one to watch it live.

### Reviewable, non-blocking goal frontend

The preset deliberately disables Harness's native model-facing
`@deepseek-ai/dsh-tool-goal` row. That frontend permits `create_goal` to infer
long-running intent without first checking durable mission state or workspace
runbooks. `dsh-supervisor/goal` replaces only that
frontend; the native `ctx.goals` service, session projection and race-fenced
goal-round driver remain installed on the host.

The replacement exposes `get_goal`, `start_goal`, and `update_goal`. `start_goal`
is available only to the root agent in a direct human turn and only after that
turn calls `get_goal`. It captures objective, constraints, milestones,
out-of-scope and the autonomous round cap in canonical `GOAL.md`, calls the native
goal service immediately, and returns to the same model turn so work continues.
The generated document is for visibility and steering, not an approval gate: the
human can inspect it and redirect, pause, or stop through ordinary chat.
`update_goal` deliberately omits `edit`; pause, resume, completion, blocking
thresholds, native revisions, projections and automatic continuation retain their
Harness behavior.

Worker failures are reported only when the native continuable child has actually
settled. The supervisor preserves that single wake and enriches it from the child's
durable final `turn/end`, for example `Terminal failure [QUOTA]: …`. Intermediate
`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, and empty-response hiccups stay silent
while Harness's retry policy owns them; a successful retry produces an ordinary
completion notice, while exhausted retries expose only their final cause. The stopped
child remains resumable through `send_message`.

Blocked workers likewise cannot strand a question inside their own session. The
guarded spawn frontend applies a native per-child tool restriction that removes
`ask_user_question` from both the worker's advertised schema and execution path.
The child-scoped `report` tool deliberately survives that restriction, so a question
arrives at the parent as a `subagent-report` message, wakes the supervisor, and can be
answered with `send_message`. A periodic reminder therefore remains a recovery check,
not the first place the supervisor discovers that a worker has been waiting for input.
The live prompt also forbids treating `list_agents: running` as evidence of progress.
Every check-in must compare a concrete report, artifact/log change, or completed step
with its prior `NOTES.md` checkpoint. The first unchanged check triggers a status probe;
the next unchanged check interrupts and recovers or respawns the worker. This policy is
rendered into every request, so the supervisor cannot legally loop on “still running.”

User-owned knobs in `<workspace>/.agi/config.json` (the agent may propose changes but
never edits it): `wakeMinutes` (check-in cadence, ≥ 5 — the schedule floor) and
`questionWaitMinutes` (patience before it records an assumption and moves on).

The preset treats recovery and continuity as explicit invariants. Before it
escalates a blocker, the supervisor must inspect repository-local runbooks and
scripts and try a bounded set of distinct safe recoveries; repeated hammering
and bypassing security or approval boundaries are forbidden. A human-only
dependency blocks only its branch: independent preparation and verification
continue. Every unfinished long-running turn must leave a durable wake-up path
(a running worker, an active native goal round, or a reminder), so a plain chat
promise to wait cannot silently strand the mission. A legacy `GOAL.md` remains
useful context but does not impersonate an armed native goal:
every direct request to start, resume, or continue long-running work must first
check `get_goal`; when no active native goal exists, the supervisor must inspect
the workspace's relevant runbooks/scripts and call `start_goal`. Reminders are
recovery aids, not a substitute for the goal driver.
This boundary is enforced by a plugin-owned pre-execution guard, not only by
persona text: an explicit long-running continuation may inspect durable state,
but operational tools remain closed until the current turn checks native goal
state and arms a reviewable goal. Once `start_goal` succeeds, the same turn may
immediately use the workspace's existing automation. If the workspace contains
a runbook, automation script, or source entry, `start_goal` is additionally
denied until the current turn successfully opens one outside `.agi`; a broad
listing or reading only GOAL.md/NOTES.md does not satisfy grounding.

## Meta-config (Settings → Plugins → Supervisor)

The supervisor's user-owned knobs live in one settings namespace,
**`dsh-supervisor`**, editable two ways with the same effect:

- **Web UI:** Settings → Plugins → *Supervisor* — the card has an
  add-from-catalog dropdown. A synthetic **Current runtime model** choice is
  enabled by default; fixed models are tagged with native input modalities and
  their model-advertised reasoning efforts. Every allowed model row owns its
  own effort selector, and the add flow asks for both route and effort.
- **File:** the `dsh-supervisor:` block in `~/.dsh/settings.yaml`.

| Key | Meaning | Applies |
|---|---|---|
| `workerModels` | complete allowlist for required `subagent.model`: `runtime/current` and/or exact `provider/model-id` routes; fresh install = `runtime/current`; empty = spawning disabled | next tool call and next tool schema (live) |
| `workerEfforts` | map from each allowed route to its user-selected effort; `provider/default` sends no explicit effort (fresh-install and missing-entry default), while fixed ids such as `high` come from the route's native catalog | next spawn and next tool description (live) |
| `maxParallelWorkers` | max simultaneously open workers, **enforced** at spawn time; 0 = unlimited | next tool call (live) |
| `wakeMinutes` | how often the supervisor wakes to inspect workers (minutes; recurring schedule, ≥ 5) | next turn (live) |
| `questionWaitMinutes` | how long it waits for an answer to a question before recording an assumption and continuing | next turn (live) |

Changes are **live** — no restart, no new session: the plugin re-resolves the
allowlist and remounts `subagent` so its `model` enum and capability labels show
only the current approved choices. Execution re-reads settings as well, closing
the race where a model is removed after a request receives its tool schema. A
`SUPERVISOR META-CONFIG` system-prompt section re-renders the same policy into
every request alongside the enforced cap and timing defaults.

Effort is a property of each settings-owned model row, not a tool-call choice.
The main agent receives a required model enum but no effort parameter. It also
cannot inherit effort from its own request: a missing legacy map entry becomes
`provider/default`. A fixed effort that the exact resolved worker route does
not advertise is refused before provider I/O; it is never clamped or silently
downgraded. For dynamic `runtime/current`, only the provider/model route follows
the calling turn; its effort still comes from `workerEfforts.runtime/current`.
The plugin reserves the continuable child's exact id (or
captures a foreground child's creation edge) and applies a one-use,
id-filtered request override before its first model call, making the choice part
of the child's durable `request/header`. Later warm steps and cold resumes both
recover the logged explicit effort. No Harness patch or custom continuation
descriptor is needed.

There is deliberately no preset model list and no implicit parent/default
inheritance. A fresh installation explicitly allows `runtime/current`: choosing
it reads the provider/model captured in the calling turn's durable request
header, resolves its capabilities, and forwards that exact route to the child.
It never reads the parent's creation-time options, so switching the main model
before a turn also switches what `runtime/current` means without reviving the
stale-route bug. Remove this entry in Settings if every child must use a pinned
route; remove every entry to disable spawning.

The shipped native spawn and fork frontends are absent from the preset because
they have no settings-guarded `model` argument and can inherit the main
session's route/effort. The plugin-owned `subagent` is the sole delegation
frontend. Every successful tool result names the selected
route, native modalities, and effective effort policy, e.g.
`antigravity/gemini-3.7-flash [text,image] effort=high`, so the hierarchy makes
the settings-owned choice visible. Vision routing: give
a `[text,image]` model and the supervisor sends image work (screenshots, UI
checks, figures) there; workers read files with `read_image`, which the harness
only allows on image-capable routes.

## The Feed tab

Every session's view ring (the tabs holding **Chat** and **Trajectory**) gains a
**Feed** entry: for a workspace with `.agi/` state it shows the whole run at a
glance — live goal card, workers (with `outcome.md`), progress timeline, question
stack, action changelog, notes, and the mission report, refreshing every ~5 s.
Ships in this bundle as a durable client plugin (`lib/client.js`, served via the
harness's client-modules scan) plus one host route (`GET /supervisor/feed?ws=…`)
reading the `.agi/` tree. No frontend rebuild, no dynamic-plugin approval.

### Full stop (the button in the Feed header)

The native stop square only aborts the current turn — the supervisor's recurring
check-in reminder (`wakeMinutes`, floor 5 min) is a durable schedule event, so
the agent re-runs by itself minutes later. The Feed header's **■ Full stop**
button ends that for real. From a worker's Feed it resolves the lineage back to
the root `main-agent`; if that supervisor is cold, the browser first resumes it
through Harness's existing-id `session.create` path without starting a turn.
`POST /supervisor/stop?session=…` then aborts the active turn, waits for idle,
flushes before folding, and deletes **every** active schedule reminder from
inside the agent's exclusive maintenance window, followed by a second
persistence flush. `GET` on the same route folds live or cold durable state, so
a successful stop replaces the button with its stopped status even after a page
refresh. Running workers are not killed — each may wake the supervisor once
with its settle report, but nothing recurs. A later manual prompt explicitly
resumes the supervisor, re-arms its recurring check-in when workers remain, and
makes the Full stop control available again.

Looking for the **Shots** tab (the screenshot player over a browser daemon's
`<workspace>/shots/` feed)? That is its own standalone plugin, **`dsh-shots`** —
generic browser-daemon tooling, deliberately not part of the supervisor.

## What's in this repo

| Path | What |
|---|---|
| `package.json` + `cordis.patch.yml` + `lib/` | The dsh bundle: manifest (`dsh.bundle.patch` + `dsh.client`), the inserted rows, setup/routes, non-blocking native-goal frontend, final-settlement diagnostics, and the browser half (`lib/client.js`: Feed tab, Full stop, settings card) |
| `agent-presets/main-agent/` | The supervisor preset: persona (grounding, non-blocking goal setup, loop, questions), plugin-owned goal frontend, and the sole settings-guarded `subagent` worker row |
| `agi-template/` | The `.agi/config.json` template for a new workspace |
| `tutorial/` | A 14-chapter HTML course (open `tutorial/index.html`) teaching Cordis, the harness, and this build from scratch |
| `tests/grade.py` | Automated milestone graders (m0–m7); `tests/drive.py` drives sessions headlessly over the HTTP RPC |
| `scripts/install-manual.sh` | Non-bundle fallback installer |
| `DESIGN.md` / `IMPLEMENTATION_PLAN.md` | The design record (Q1–Q23, A1–A6, S1–S4, N1–N7, G1) and the v2 plan |

## Grade it

```sh
./grade-tutorial.sh all --ws ~/agi-lab    # m0–m6 report with bar chart
./grade-tutorial.sh m7 --ws ~/agi-acceptance  # acceptance + restart evidence
./grade-tutorial.sh doctor                # what the grader can see
```

Graders read only durable artifacts (preset files, patch/bundle rows, `.agi/`, session
event logs) — nothing is executed in your agents. `tests/README.md` documents every
check.

## Drive it headlessly (optional)

```sh
S=$(python3 tests/drive.py create --cwd ~/agi-lab)          # new supervisor session
python3 tests/drive.py send "$S" "your mission here"        # prompt + wait + tail
python3 tests/drive.py tail "$S"                             # readable event tail
```

## Learn it from scratch

Open `tutorial/index.html`. Part I teaches Cordis and the harness from zero (no
TypeScript assumed); Part II builds everything in this repo milestone by milestone,
each with a live test and a grader; Part III covers packaged-plugin extensions —
the very pattern this repo uses — and troubleshooting.

## Publishing & the plugin ecosystem

How this package reaches other people, in ascending order of effort:

1. **GitHub + the `dsh-plugin` topic.** Tag the repo with the
   [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic (the harness README's
   official discoverability channel) and write a crisp one-line repo description — the
   community indexes scrape exactly that line. Users then install straight from git:
   `dsh plugin --profile web add "github:you/dsh-supervisor"`.
2. **The aggregators pick it up automatically**: the awesome-lists
   (e.g. `vvlife/awesome-deepseek-harness-plugins` regenerates its `PLUGINS.md` daily
   from the topic) and topic-driven marketplaces (e.g. WhaleHub, a visual market with
   one-click install commands). A PR to a curated list adds human placement.
3. **npm publish** (optional): `dsh plugin` forwards to pnpm, so a published package
   installs by name. The `files` list in `package.json` already scopes the payload
   (`lib`, `cordis.patch.yml`, `agent-presets`, `agi-template`).

Packaging notes for preset-shipping plugins, learned from the ecosystem
(`dsh-minimal-msys2` ships presets with this same copy-at-boot pattern;
`dsh-preset-qa-mode` ships script-only; `dsh-preset-scaffold` additionally registers
its packaged `skills/` as a skill root via `dsh-skill-filesystem`):

- Copy-at-boot into `${DSH_HOME}/.agent-presets/` is the established pattern — preset
  discovery re-reads roots on every call, so no restart is needed after the copy, and
  removing the plugin deliberately does not delete installed presets.
- The roster also supports deployment-configured extra preset `roots` (see
  `dsh-agent-presets` Config), but a bundle cannot append to the shipped row's config
  without restating it wholesale — which is why the copy pattern won in practice.

## Safety notes

- Most supervisor protocol remains prose plus audit, but goal creation and worker-model
  routing are hard-enforced by plugin-owned frontends. Read `.agi/CHANGELOG.jsonl` —
  it is the diary of every spawn/steer/kill/assumption.
- Decide the sandbox/approval posture deliberately before unattended missions with
  real credentials (this lab runs `danger-full-access`).
- One dsh per `$DSH_HOME`, ever. Never edit shipped presets or the harness checkout.
