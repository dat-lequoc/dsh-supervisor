# Implementation Plan v2 — Always-On Supervisor, native-first

Companion to `DESIGN.md` (Q1–Q23 + A1–A6 + S1–S4 + **N1–N7 + G1**). This v2 supersedes
the v1 custom-build plan (preserved in git history: commits `1f9a480` and `4957d66`);
where they disagree, v2 and DESIGN §15–16 win.

**The step-by-step no longer lives here.** It lives in the 15-chapter course at
`tutorial/` (open `tutorial/index.html`), where every milestone ends in a live test,
and in the automated graders at `tests/grade.py` (see `tests/README.md`). This file is
the index: what to build, in what order, where it is taught, and how it is graded.

Build shape after DESIGN §15: **one authored preset + a persona + two host-plane config
rows + the `.agi/` file convention. Zero custom plugins in the core.** Custom code
appears only in the optional extensions (§4).

---

## 1. Ground truth (verified in source this round)

Everything below was read from the checkout at `/root/deepseek-harness`
(dsh 0.1.0-rc.7) or the live deployment during the native-first rebuild. If the
deployment version changes, re-verify this table first.

| Fact | Source |
|---|---|
| The Cordis toolset is SEVEN tools with a define/run lifecycle (`cordis_inspect_list/_query/_self`, `cordis_define`, `cordis_run`, `cordis_stop`, `cordis_undefine`); the `editing-cordis-compositions` skill's `cordis_mount`/`cordis_unmount`/`cordis_inspect` verbs no longer exist | `packages/extensions/tool-cordis/src/index.ts` lines 42/61/97/149/241/330/352; stale names in `apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md` |
| Sandbox builtins for dynamic host halves: `harness.handle`, `harness.defineTool`, `harness.registerTool(ctx, tool)`, guarded `ctx.get/on/provide/effect` | `packages/extensions/cordis-host-runner/src/sandbox.ts` lines 18–36 |
| The shipped subagent tool row supports per-row `persona` (child-shadowing), `toolFilter`, `agentOptions{provider,model}`; the model-facing call schema is only `{description, prompt, run_in_background}` | `packages/subagent/tool-subagent/src/index.ts` — `Config.persona` lines 54–57, passed at 384 |
| The `spawn` provider declares every capability: `{outputSchema, depthLimit, toolFilter, persona} = true`; children start fresh (no parent history) | `packages/subagent/subagent-spawn-in-process/src/index.ts` line 42 |
| A settling continuable child delivers ONE unconditional notice to its direct parent (`source.kind: "subagent-settled"`, with summary + final content) | `docs/subsystems/subagent.md` (SubagentSettledMessageSource); observed in real logs |
| `send_message` routing: running → enqueue after current turn; waiting → wake; no Activation → cold-resume. `interrupt_agent` = fire-and-return cancel; un-messaged child burns nothing; no destroy exists | `docs/subsystems/subagent.md` (followup table, interrupt) |
| Every continuable child gets the `report` tool via a host-plane continuable setup (wakeup delivery default) | `packages/bundle/base/cordis.patch.yml` rows 331–333; `docs/subsystems/subagent.md` reportFrom |
| `listChildren()` entries are a tagged union: `{kind:'child', id, mode, activity:'running'\|'inactive', hasChildren, label?}` vs `{kind:'diagnostic', id, reason}` — diagnostics have NO `activity` field | `packages/subagent/subagent/src/list-children.ts` lines 44–57 |
| Schedule: one-shot `after_seconds` has no minimum; recurring `every_seconds` floor is **300 s** (⇒ `wakeMinutes ≥ 5`); reminders are durable session events delivered to the original session as ordinary turns; NOT mounted by default — the overlay is two insert rows | `docs/subsystems/schedule.md`; `examples/web-schedule/cordis.yml` |
| Tool pipeline: `'tools/pre-execute'(exec, next)` is a waterfall returning `PreToolDecision` (`allow`/`deny`/`ask`); `next()` delegates to allow | `docs/subsystems/tools.md` line 693 |
| Session storage: `~/.dsh/sessions/<ws-dashed>/<session-id>/session.jsonl.zstd`; first line is the header (`cwd`, `agentPreset`, and for children `origin:"subagent"` + `parentSession`); `tool/call` events carry `data.name` + stringified `data.arguments`; resume leaves a `session/end-seed` marker | observed in live logs (`--root-agi-acc5--` et al.) |
| Out-of-tree plugin install pattern: npm package with `dsh.bundle.patch` manifest + one-row `cordis.patch.yml`, added to the profile's `package.json` as a `file:` dependency AND to `dsh.profile.bundles`; bundle layers compose at boot (one restart) while the profile patch file is live-watched | `packages/boot/app-boot/README.md` (Profiles); working example `/root/dsh-subagent-agy` installed in `/root/.dsh/profiles/web/package.json` |
| Preset roster: `list/resolve/read/copy/remove/standingKeyFor`; `copy()` is the authoring write, `standingKeyFor()` is the real mount validation | `packages/preset/agent-presets/src/index.ts` |
| Client slots for the optional pill / future tabs: `shell.overlay` (additive frame-wide layer, "a status pill belongs here") and `conversation.view` (one entry per view tab) | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` |

## 2. Deliverables → chapters → graders

| # | Deliverable | Realized as | Tutorial | Grader |
|---|---|---|---|---|
| 0 | Lab sanity (process, UI, patch layer, workspace) | nothing to build | ch. 4 (+1–3, 5 for concepts) | `grade.py m0` |
| 1 | `main-agent` preset | `agentPresets.copy('standard', …)` + `preset.yml` + one plugin-owned `subagent` row (N14) in the delegation group | ch. 6 | `grade.py m1` |
| 2 | Supervisor brain | persona (GROUNDING/STATE/GOAL SETUP/LOOP/QUESTIONS/LIMITS per DESIGN §3, §15, §16) + `.agi/` skeleton (`config.json` = `wakeMinutes`, `questionWaitMinutes` only — N3) | ch. 7 | `grade.py m2` |
| 3 | Time | schedule overlay: two insert rows in `profiles/web/cordis.patch.yml` (N6); patience = one-shot, check-in = recurring (N2) | ch. 8 | `grade.py m3` |
| 4 | Workers | native loop exercised by hand: spawn / steer (`send_message`) / kill (`interrupt_agent`) / `report` / settle notice — the old M0 smoke test, five observations | ch. 9 | `grade.py m4` |
| 5 | The supervision loop | persona refinements (timer discipline, log-tail inspection, verdicts) + full-loop rehearsal with forced steer/kill/silent-question | ch. 10 | `grade.py m5` |
| 6 | UI | native surfaces + tmux tail dashboard; optional dynamic status pill in `shell.overlay` (N5) | ch. 11 | `grade.py m6` |
| 7 | Acceptance | scripted end-to-end mission on a virgin workspace + restart drill; exit criterion: every step passes twice in a row | ch. 12 | `grade.py m7` (re-runs m2–m5 on `/root/agi-acceptance`) |

Work milestones in order; do not start one before the previous grader passes (≥90%,
exit code 0). MANUAL lines in the grader output are the human-judgment steps — do them.

## 3. Milestone index (one line each; the chapters hold the detail)

- **M0 — Lab** (ch. 4): verify the running `dsh web` (tmux `dsh`, port 3080), the empty
  profile patch, session storage on disk; create `/root/agi-lab`. Never run a second
  dsh on the same home; never edit shipped presets or the checkout.
- **M1 — Preset** (ch. 6): from a Creator-mode session, `copy('standard','main-agent')`;
  write `preset.yml`; replace the native spawn frontend with the settings-guarded
  `subagent` row (worker-protocol persona on the row; required explicit choice,
  with fresh installs allowing `runtime/current` from the Settings dropdown);
  validate with `standingKeyFor`; start two sessions (realm check).
- **M2 — Brain** (ch. 7): scaffold `.agi/`; write the supervisor persona; run
  non-blocking goal setup (`get_goal` → inspect durable state and relevant
  runbooks/scripts → `start_goal`/`GOAL.md` → same-turn execution); test amendment and
  config-refusal discipline; grounding check (a discoverable fact must be looked up,
  not asked or delegated).
- **M3 — Time** (ch. 8): add the two overlay rows (live reload — watch tmux for
  `hmr/config-update-failed`); test 60 s one-shot delivery; test the patience flow to an
  `assumed` question; know the 300 s recurring floor.
- **M4 — Workers** (ch. 9): drive all five observations by hand; verify the child's
  persona took and `outcome.md` landed under `.agi/subagents/<id>/`.
- **M5 — Loop** (ch. 10): add timer-discipline + inspection persona text; run one small
  real mission end-to-end with every branch forced once; grade the CHANGELOG as a diary.
- **M6 — UI** (ch. 11): adopt the native surfaces; optionally define/run the pill
  (client half needs one approval; dynamic = dies with the process, re-run is two calls).
- **M7 — Acceptance** (ch. 12): virgin `/root/agi-acceptance`, scripted lines only, no
  coaching; then the restart drill (`session/end-seed` marker proves resume). Keep the
  ledger next to this file; two clean runs = done.

## 4. Optional extensions (only when native stops being enough)

Triggers and corrected designs live in tutorial ch. 13. One package
(`/root/agi-extras`, pattern copied from `/root/dsh-subagent-agy`), one bundle row per
feature so each is individually disable-able from the profile patch:

| Extension | Build when | Key contract (verified) |
|---|---|---|
| `agi-wait` (`wait_for_agents`) | supervision cadence < 5 min needed | `defineTool` + `listChildren` tagged union (§1); mind `dsh-tool-call-timeout-policy` |
| `agi-subagent-trace` | grep-able per-child `trace.log` wanted over session logs | `'session/event'(session, event)` firehose; children have `header.origin === 'subagent'`; leaf fields only, try/catch everything |
| `agi-tool-delay` | rate-limit/cost throttle wanted | `tools/pre-execute` waterfall; ALWAYS `return next()`; re-adds `toolDelaySeconds` to `config.json` |
| `agi-state-route` | external dashboard wanted | `ctx.webServer.register({kind,path,handler})`; path-validate `?ws=` (unauthenticated localhost) |
| hard spawn-limit / per-spawn persona tool | prose limit drifts, or per-spawn personas genuinely needed (restores S3/A6) | wrap `ctx.subagents.startContinuable()`; count via `listChildren` |

Install: build `lib/`, add `file:` dep + bundle name to the profile `package.json`,
`pnpm install` in the profile dir, one dsh restart. Disable a row live via an
id-targeted `disabled: true` patch.

## 5. Risk watchlist (carry into the first real mission)

1. **Prose-enforced protocol** — workspace-grounding quality, changelog completeness, the parallel
   limit are persona sentences. Compensating control: the graders + the acceptance
   ledger; fix order is persona wording → machinery. Watch: does the CHANGELOG stay
   truthful when nobody forces it?
2. **Context over weeks** — Q12 ("compaction suffices") is unproven at week scale;
   `.agi/` files are the real memory. Watch NOTES.md quality after compactions.
3. **Unattended trust posture** — earlier lab runs used `danger-full-access` +
   `approval: never`. Before a credentialed 24/7 mission (X.com), decide the
   sandbox/approval posture deliberately; scope workers with per-row `toolFilter`.
4. **Session-local timers** — reminders belong to the session that created them; resume
   the supervisor session, don't start a fresh one. Persona re-arms check-ins on spawn.
5. **Dynamic UI is ephemeral** — the pill dies with the process; re-run or promote.

## 6. First real mission (unchanged from DESIGN §9)

X.com growth automation, after M7 passes twice: goal setup reuses existing scripts
and requests credentials only when they are genuinely unavailable;
browser-operator workers install their own tooling (Playwright) at runtime; milestones
10 → 100 followers. The loop does not change — only the goal and the worker roles do.
