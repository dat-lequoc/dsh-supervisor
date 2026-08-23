# Milestone graders for the Supervisor course

One command per milestone, run after finishing each chapter's "Test it live" box:

```sh
python3 /root/dev/tests/grade.py m1               # after chapter 6
python3 /root/dev/tests/grade.py m4 --ws /root/agi-lab
python3 /root/dev/tests/grade.py all              # m0–m6 in one report
python3 /root/dev/tests/grade.py m7               # acceptance (also re-runs m2–m5
                                                  # against /root/agi-acceptance)
python3 /root/dev/tests/grade.py doctor           # what the grader can see
```

| Milestone | Chapter | What it grades |
|---|---|---|
| m0 | 4  | dsh running, web UI up, patch file parses, workspace exists |
| m1 | 6  | preset files, persona row, sole plugin-owned `subagent` row (settings-only model policy with explicit `runtime/current`, worker persona, group placement), sessions mounted |
| m2 | 7  | `.agi/` skeleton, config keys, all protocol markers in the persona, GOAL.md, plugin-owned non-blocking `start_goal` call, JSONL validity, amendment discipline |
| m3 | 8  | schedule rows in the patch **and** in the composed tree, `schedule_create` called, reminder delivered, an `assumed` question |
| m4 | 9  | child sessions parented to the supervisor; spawn/steer/kill calls; `subagent-settled` and `subagent-report` messages; a child `report`; `outcome.md` |
| m5 | 10 | CHANGELOG covers spawn+steer+kill, assumption logged, NOTES verdicts, progress feed, deliverable, ≥2 workers, timer hygiene |
| m6 | 11 | pill defined/run in a Creator session, inspect-before-code discipline |
| m7 | 12 | restart resume marker, amendment after completion — plus m2–m5 re-run on the acceptance workspace |

## How it works

Everything is graded from durable artifacts only — nothing is executed in your agent and
nothing is mutated:

- **Preset & patch**: parsed from `~/.dsh/.agent-presets/main-agent/` and
  `~/.dsh/profiles/web/cordis.patch.yml` (YAML loader tolerates `!!js` tags).
- **Behavior**: read from the session event logs
  (`~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd`, decompressed with the
  system `zstd`; live half-written logs are handled). Tool calls are matched by the
  `tool/call` event's `data.name`; settle/report/schedule wakes by their message
  `source.kind`.
- **State**: your workspace's `.agi/` files.

Scoring: PASS = 1, WARN = 0.5 (weak or partial evidence — read the hint), FAIL = 0.
MANUAL lines are reminders of things only a human can judge (visuals, transcript
quality); they never affect the score. A milestone "passes" at ≥ 90%, which is also the
process exit code (0/1), so you can chain it in scripts.

Requirements: python3 with PyYAML (present on this machine), `zstd` CLI (present).

## Honest limitations

- The grader proves *evidence exists*, not that it is good. It can see that
  `send_message` was called; whether the correction was sensible is your read of the
  transcript. MANUAL lines mark exactly these spots.
- m1's "second session mounts cleanly" is a proxy (two session dirs), not a live
  realm-collision test — `standingKeyFor` can only be called from inside the runtime
  (chapter 6 step 4 does it properly).
- m3's "reminder delivered" searches for schedule-sourced messages or the literal
  `patience-test` prompt from the chapter's script; a custom prompt may need the
  `--ws` workspace's logs read by hand if it WARNs.
- Logs are scanned across **all** sessions in the workspace, so a check once passed
  stays passed (evidence is append-only). Use a fresh workspace (`--ws`) when you want
  a clean slate — exactly what chapter 12 does with `/root/agi-acceptance`.
