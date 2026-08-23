# dsh-supervisor — an Always-On Supervisor Agent for DeepSeek Harness

A 24/7 **Main Agent** that locks a goal with you, then loops unattended: spawn a dev
subagent → sleep → wake on settle / report / timer / your message → inspect → steer,
kill, or continue. Built **native-first** on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh): the core is one agent preset, a persona, and two schedule rows — zero custom
loop machinery. This repo **is an installable dsh plugin bundle**: one command puts the
whole setup on any machine running dsh.

Tested end-to-end on `glm-5.3` (Z.AI): goal ceremony, grounded delegation, mid-flight
steering, a mid-turn kill + tighter respawn, the silent-question → recorded-assumption
flow, deliverable verification (it caught its own buggy link-checker and re-ran it),
and full process-restart resume. Grader scores: m0–m5 and m7 at 100%.

## Install (any PC with dsh)

Prerequisites: Node.js ≥ 22.19 and dsh (`npm i -g @deepseek-ai/dsh`), with a model
configured (web UI → Settings → Models; tested with Z.AI `glm-5.3`). For the graders:
Python 3 + PyYAML and `zstd`.

```sh
# from a git clone (or use github:you/dsh-supervisor directly):
git clone <this-repo> dsh-supervisor
dsh plugin --profile web add file:$PWD/dsh-supervisor

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
mkdir -p ~/agi-lab/.agi/subagents
cp dsh-supervisor/agi-template/config.json ~/agi-lab/.agi/config.json
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

What you should see, in order: it **grounds** (reads the target itself), writes
`.agi/GOAL.md` (confirm it, or state the mission imperatively and it proceeds),
records the goal, spawns a `spawn_dev_agent` worker with a complete structured task,
arms a recurring check-in reminder, and sleeps. It wakes on the worker's settle
notice, **verifies the deliverable with its own reads**, logs everything to
`.agi/CHANGELOG.jsonl`, and continues or finishes. You steer at any time by chatting;
workers are ordinary sessions in the sidebar — click one to watch it live.

User-owned knobs in `<workspace>/.agi/config.json` (the agent may propose changes but
never edits it): `wakeMinutes` (check-in cadence, ≥ 5 — the schedule floor) and
`questionWaitMinutes` (patience before it records an assumption and moves on).

## Meta-config (Settings → Plugins → Supervisor)

The supervisor's user-owned knobs live in one settings namespace,
**`dsh-supervisor`**, editable two ways with the same effect:

- **Web UI:** Settings → Plugins → *Supervisor* — the card has an
  add-from-catalog dropdown for models (each option tagged with its native
  input modalities) and number fields for the rest.
- **File:** the `dsh-supervisor:` block in `~/.dsh/settings.yaml`.

| Key | Meaning | Applies |
|---|---|---|
| `workerModels` | allowlist of `provider/model-id` the supervisor may pass to `spawn_dev_agent`'s `model` argument; empty = workers only inherit | next tool call (live) |
| `maxParallelWorkers` | max simultaneously open workers, **enforced** at spawn time; 0 = unlimited | next tool call (live) |
| `wakeMinutes` | how often the supervisor wakes to inspect workers (minutes; recurring schedule, ≥ 5) | next turn (live) |
| `questionWaitMinutes` | how long it waits for an answer to a question before recording an assumption and continuing | next turn (live) |

Changes are **live** — no restart, no new session: the spawn tool re-reads the
values on every call, and a `SUPERVISOR META-CONFIG` system-prompt section
re-renders them into every request, so the agent always sees the current
allowlist (with `[text]` / `[text,image]` modality tags), the enforced cap, and
the timing defaults. The agent never discovers model routes you did not approve
(models cost money). Vision routing: give a `[text,image]` model (shipped
example `zai/glm-5v-turbo`) and the supervisor sends image work (screenshots,
UI checks, figures) there; workers read files with `read_image`, which the
harness only allows on image-capable routes.

The spawn row's `models:` list in the preset remains as a fallback for
deployments without the settings namespace; settings win when non-empty.

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
| `package.json` + `cordis.patch.yml` + `lib/` | The dsh bundle: manifest (`dsh.bundle.patch` + `dsh.client`), the inserted rows, the setup plugin (preset install + feed/models/stop routes), and the browser half (`lib/client.js`: Feed tab, Full stop, settings card) |
| `agent-presets/main-agent/` | The supervisor preset: persona (grounding, ceremony, loop, questions) + the `spawn_dev_agent` worker row |
| `agi-template/` | The `.agi/config.json` template for a new workspace |
| `tutorial/` | A 15-chapter HTML course (open `tutorial/index.html`) teaching Cordis, the harness, and this build from scratch |
| `tests/grade.py` | Automated milestone graders (m0–m7); `tests/drive.py` drives sessions headlessly over the HTTP RPC |
| `scripts/install-manual.sh` | Non-bundle fallback installer |
| `DESIGN.md` / `IMPLEMENTATION_PLAN.md` | The design record (Q1–Q23, A1–A6, S1–S4, N1–N7, G1) and the v2 plan |

## Grade it

```sh
python3 tests/grade.py all --ws ~/agi-lab    # m0–m6 report with bar chart
python3 tests/grade.py m7 --ws ~/agi-lab     # acceptance + restart evidence
python3 tests/grade.py doctor                # what the grader can see
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

- The supervisor's protocol is prose-enforced; the graders + changelog are your audit
  surface. Read `.agi/CHANGELOG.jsonl` — it is the diary of every spawn/steer/kill/
  assumption.
- Decide the sandbox/approval posture deliberately before unattended missions with
  real credentials (this lab runs `danger-full-access`).
- One dsh per `$DSH_HOME`, ever. Never edit shipped presets or the harness checkout.
