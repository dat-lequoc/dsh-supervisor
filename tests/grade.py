#!/usr/bin/env python3
"""Milestone grader for the Always-On Supervisor course (/root/dev/tutorial).

Usage:
    python3 grade.py m0            # grade one milestone (m0..m7)
    python3 grade.py m4 --ws /root/agi-lab
    python3 grade.py all           # m0..m6 against the lab workspace
    python3 grade.py doctor        # show what the grader can see

Each milestone maps to a chapter's "Test it live" box:
    m0 -> ch4  lab checklist            m4 -> ch9  workers (M0 smoke test)
    m1 -> ch6  main-agent preset        m5 -> ch10 supervision loop
    m2 -> ch7  brain + ceremony         m6 -> ch11 Feed view tab
    m3 -> ch8  schedule                 m7 -> ch12 acceptance (runs m2-m5 too)

Checks read only durable artifacts: the preset files, the profile patch,
the .agi/ tree, and the session event logs under $DSH_HOME/sessions
(decompressed with the system `zstd`). Nothing is mutated.

Statuses: PASS (1 pt), WARN (0.5 pt, weak/partial evidence), FAIL (0 pt),
MANUAL (not scored - a reminder of what only a human can judge).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME", "/root/.dsh"))
PRESET_DIR = DSH_HOME / ".agent-presets" / "main-agent"
PATCH_FILE = DSH_HOME / "profiles" / "web" / "cordis.patch.yml"
DEFAULT_WS = "/root/agi-lab"
ACCEPTANCE_WS = "/root/agi-acceptance"
WEB_URL = "http://127.0.0.1:3080"

# ---------------------------------------------------------------- utilities

GREEN, RED, YELLOW, BLUE, DIM, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[34m", "\033[2m", "\033[1m", "\033[0m")
if not sys.stdout.isatty():
    GREEN = RED = YELLOW = BLUE = DIM = BOLD = RESET = ""


def load_yaml(path: Path):
    """Parse YAML tolerating the harness's !!js tags (kept as raw strings)."""
    import yaml

    class Tolerant(yaml.SafeLoader):
        pass

    def unknown(loader, tag_suffix, node):
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    Tolerant.add_multi_constructor("", unknown)
    Tolerant.add_multi_constructor("!", unknown)
    Tolerant.add_multi_constructor("tag:yaml.org,2002:", unknown)
    return yaml.load(path.read_text(), Tolerant)


def all_session_dirs() -> list[Path]:
    root = DSH_HOME / "sessions"
    if not root.is_dir():
        return []
    return [d for wsdir in root.iterdir() if wsdir.is_dir()
            for d in wsdir.iterdir() if d.is_dir()]


_log_cache: dict[Path, list[str]] = {}


def session_lines(session_dir: Path) -> list[str]:
    """Decompressed raw JSONL lines of one session (tolerates a live, partial tail)."""
    if session_dir in _log_cache:
        return _log_cache[session_dir]
    log = session_dir / "session.jsonl.zstd"
    lines: list[str] = []
    if log.exists():
        # check=False: a live session's stream can end mid-frame; partial
        # stdout is still valid JSONL for every complete line.
        proc = subprocess.run(["zstd", "-dc", str(log)],
                              capture_output=True, check=False)
        lines = proc.stdout.decode("utf-8", errors="replace").splitlines()
    _log_cache[session_dir] = lines
    return lines


def session_header(session_dir: Path) -> dict:
    lines = session_lines(session_dir)
    if lines:
        try:
            head = json.loads(lines[0])
            if head.get("type") == "session":
                return head
        except json.JSONDecodeError:
            pass
    return {}


def sessions(ws: str) -> list[Path]:
    """Every session whose durable header records this workspace as its cwd.

    Matching by header.cwd instead of reconstructing the sessions directory
    name keeps the grader independent of the store's path-encoding scheme.
    """
    want = ws.rstrip("/")
    hits = [d for d in all_session_dirs()
            if session_header(d).get("cwd", "").rstrip("/") == want]
    return sorted(hits, key=lambda d: d.stat().st_mtime)


def supervisor_sessions(ws: str) -> list[Path]:
    """Top-level sessions on the main-agent preset (not subagent children)."""
    out = []
    for d in sessions(ws):
        h = session_header(d)
        if h.get("agentPreset") == "main-agent" and h.get("origin") != "subagent":
            out.append(d)
    return out


def child_sessions(ws: str) -> list[Path]:
    out = []
    for d in sessions(ws):
        h = session_header(d)
        if h.get("origin") == "subagent":
            out.append(d)
    return out


def tool_calls(session_dir: Path, name: str | None = None) -> list[dict]:
    """Parsed tool/call event data ({name, arguments, ...}) for one session."""
    calls = []
    for line in session_lines(session_dir):
        if '"type":"tool/call"' not in line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = ev.get("data", {})
        if name is None or data.get("name") == name:
            calls.append(data)
    return calls


def any_line_contains(dirs: list[Path], needle: str) -> bool:
    return any(needle in line for d in dirs for line in session_lines(d))


def jsonl_records(path: Path) -> tuple[list[dict], list[str]]:
    """(valid records, invalid raw lines) of a .jsonl file; missing file = ([], [])."""
    if not path.exists():
        return [], []
    good, bad = [], []
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
            good.append(rec) if isinstance(rec, dict) else bad.append(raw)
        except json.JSONDecodeError:
            bad.append(raw)
    return good, bad


# ------------------------------------------------------------ check plumbing

class Result:
    def __init__(self, status: str, detail: str = ""):
        self.status, self.detail = status, detail


def PASS(d=""): return Result("PASS", d)
def FAIL(d=""): return Result("FAIL", d)
def WARN(d=""): return Result("WARN", d)
def MANUAL(d=""): return Result("MANUAL", d)


class Milestone:
    def __init__(self, key: str, title: str):
        self.key, self.title, self.checks = key, title, []

    def check(self, name):
        def deco(fn):
            self.checks.append((name, fn))
            return fn
        return deco

    def run(self, ws: str) -> float:
        icon = {"PASS": f"{GREEN}✔ PASS{RESET}", "FAIL": f"{RED}✘ FAIL{RESET}",
                "WARN": f"{YELLOW}◐ WARN{RESET}", "MANUAL": f"{BLUE}☐ MANUAL{RESET}"}
        print(f"\n{BOLD}{self.key} — {self.title}{RESET}  {DIM}(workspace: {ws}){RESET}")
        earned = total = 0.0
        for name, fn in self.checks:
            try:
                r = fn(ws)
            except Exception as e:  # a crashed check is a failed check, loudly
                r = FAIL(f"grader error: {e.__class__.__name__}: {e}")
            if r.status != "MANUAL":
                total += 1
                earned += {"PASS": 1.0, "WARN": 0.5, "FAIL": 0.0}[r.status]
            detail = f"  {DIM}{r.detail}{RESET}" if r.detail else ""
            print(f"  {icon[r.status]}  {name}{detail}")
        pct = 100.0 * earned / total if total else 100.0
        color = GREEN if pct >= 90 else YELLOW if pct >= 60 else RED
        print(f"  {BOLD}score: {color}{earned:.1f}/{total:.0f}  ({pct:.0f}%){RESET}")
        return pct


MILESTONES: dict[str, Milestone] = {}


def milestone(key, title):
    m = Milestone(key, title)
    MILESTONES[key] = m
    return m


# ------------------------------------------------------------------- m0: lab

m0 = milestone("m0", "Your lab (chapter 4)")

@m0.check("dsh web process is running")
def _(ws):
    out = subprocess.run(["pgrep", "-af", "dsh web"], capture_output=True, text=True)
    return PASS(out.stdout.strip().splitlines()[0][:70]) if out.stdout.strip() else \
        FAIL("no `dsh web` process — start it in the tmux session `dsh`")

@m0.check("web UI answers on 127.0.0.1:3080")
def _(ws):
    try:
        req = urllib.request.Request(WEB_URL, method="GET")
        with urllib.request.urlopen(req, timeout=4) as resp:
            return PASS(f"HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        return PASS(f"HTTP {e.code} (server is up)")
    except Exception as e:
        return FAIL(f"{e.__class__.__name__}: {e}")

@m0.check("profile patch file exists and parses")
def _(ws):
    if not PATCH_FILE.exists():
        return FAIL(f"{PATCH_FILE} missing")
    try:
        load_yaml(PATCH_FILE)
        return PASS(str(PATCH_FILE))
    except Exception as e:
        return FAIL(f"YAML error: {e}")

@m0.check("lab workspace exists")
def _(ws):
    return PASS(ws) if Path(ws).is_dir() else FAIL(f"mkdir -p {ws}")

@m0.check("you opened a session JSONL and recognized the event types")
def _(ws):
    return MANUAL("zstd -dc <sessions>/<dir>/session.jsonl.zstd | head")


# ---------------------------------------------------------------- m1: preset

m1 = milestone("m1", "The main-agent preset (chapter 6)")

def _preset_rows():
    return load_yaml(PRESET_DIR / "agent.cordis.yml")

def _find_rows(rows, pred, nested=False):
    """All rows matching pred; recurses into group config lists."""
    found = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if pred(row):
            found.append((row, nested))
        cfg = row.get("config")
        if row.get("group") and isinstance(cfg, list):
            found += _find_rows(cfg, pred, nested=True)
    return found

def _spawn_row():
    rows = _preset_rows()
    hits = _find_rows(rows, lambda r: r.get("name") == "dsh-supervisor/spawn"
                      and isinstance(r.get("config"), dict)
                      and r["config"].get("toolName") == "subagent")
    return hits[0] if hits else (None, False)

@m1.check("preset directory with both files")
def _(ws):
    ok = (PRESET_DIR / "agent.cordis.yml").exists() and (PRESET_DIR / "preset.yml").exists()
    return PASS(str(PRESET_DIR)) if ok else \
        FAIL("copy('standard','main-agent',...) via Creator mode first (ch6 step 1)")

@m1.check("preset.yml carries display name and description")
def _(ws):
    meta = load_yaml(PRESET_DIR / "preset.yml") or {}
    if meta.get("name") and meta.get("description"):
        return PASS(f'name: "{meta["name"]}"')
    return FAIL("fill name + description (ch6 step 2)")

@m1.check("agent.cordis.yml parses as a row list")
def _(ws):
    rows = _preset_rows()
    return PASS(f"{len(rows)} top-level rows") if isinstance(rows, list) and rows else \
        FAIL("file is not a YAML list of rows")

@m1.check("persona row present with non-empty text")
def _(ws):
    hits = _find_rows(_preset_rows(), lambda r: r.get("id") == "persona")
    if not hits:
        return FAIL("no row with id: persona")
    text = (hits[0][0].get("config") or {}).get("text") or ""
    return PASS(f"{len(text)} chars") if len(text.strip()) > 20 else FAIL("persona text empty")

@m1.check("subagent row: plugin-owned, settings-guarded spawn frontend")
def _(ws):
    row, _n = _spawn_row()
    if row is None:
        return FAIL("no dsh-supervisor/spawn row with config.toolName subagent")
    cfg = row["config"]
    problems = []
    if row.get("name") != "dsh-supervisor/spawn":
        problems.append(f'name is {row.get("name")}')
    if cfg.get("provider") != "spawn":
        problems.append(f'provider is {cfg.get("provider")}')
    if "models" in cfg:
        problems.append("preset fallback models are present")
    return PASS() if not problems else FAIL("; ".join(problems))

@m1.check("guarded subagent row carries the worker persona")
def _(ws):
    row, _n = _spawn_row()
    if row is None:
        return FAIL("row missing")
    persona = row["config"].get("persona") or ""
    if len(persona.strip()) < 40:
        return FAIL("config.persona empty/too short — indentation under the row?")
    need = [w for w in ("report", "outcome.md") if w not in persona]
    return PASS(f"{len(persona)} chars") if not need else \
        WARN(f"persona lacks protocol words: {need}")

@m1.check("guarded subagent row sits inside a group (delegation), not top-level")
def _(ws):
    row, nested = _spawn_row()
    if row is None:
        return FAIL("row missing")
    return PASS() if nested else \
        WARN("row is top-level; move it into the delegation group's config list")

@m1.check("a session ran on the preset (mount proof)")
def _(ws):
    sup = supervisor_sessions(ws)
    if not sup:
        return FAIL("no main-agent session in this workspace yet — start one (ch6 step 5)")
    return PASS(f"{len(sup)} session(s), newest: {sup[-1].name}")

@m1.check("second session mounts cleanly (realm-collision check)")
def _(ws):
    n = len(supervisor_sessions(ws))
    return PASS(f"{n} sessions") if n >= 2 else \
        WARN("only one session so far — start a second to prove no realm collision")

@m1.check("tool list contains only the guarded subagent spawn frontend")
def _(ws):
    native = _find_rows(
        _preset_rows(),
        lambda r: r.get("name") == "@deepseek-ai/dsh-tool-subagent"
        and isinstance(r.get("config"), dict)
        and r["config"].get("provider") == "spawn",
    )
    return FAIL("native spawn frontend bypasses workerModels") if native else \
        MANUAL("confirm subagent.model lists only Settings-approved provider/model routes")


# ----------------------------------------------------------------- m2: brain

m2 = milestone("m2", "Brain: persona, .agi contract, goal ceremony (chapter 7)")

PERSONA_MARKERS = ["GROUNDING", "CEREMONY", "QUESTIONS", "subagent",
                   "send_message", "interrupt_agent", "schedule_create",
                   "CHANGELOG.jsonl", "GOAL.md", "progress.jsonl",
                   "questions.jsonl", "NOTES.md"]

@m2.check(".agi skeleton (config + the four state files)")
def _(ws):
    agi = Path(ws) / ".agi"
    missing = [f for f in ("config.json", "NOTES.md", "progress.jsonl",
                           "questions.jsonl", "CHANGELOG.jsonl")
               if not (agi / f).exists()]
    if not (agi / "subagents").is_dir():
        missing.append("subagents/")
    return PASS(str(agi)) if not missing else FAIL(f"missing: {missing}")

@m2.check("config.json valid with numeric wakeMinutes/questionWaitMinutes")
def _(ws):
    p = Path(ws) / ".agi" / "config.json"
    try:
        cfg = json.loads(p.read_text())
    except Exception as e:
        return FAIL(f"{e}")
    bad = [k for k in ("wakeMinutes", "questionWaitMinutes")
           if not isinstance(cfg.get(k), (int, float))]
    return PASS(json.dumps(cfg)) if not bad else FAIL(f"missing/non-numeric: {bad}")

@m2.check("supervisor persona carries the full protocol")
def _(ws):
    hits = _find_rows(_preset_rows(), lambda r: r.get("id") == "persona")
    if not hits:
        return FAIL("persona row missing")
    text = (hits[0][0].get("config") or {}).get("text") or ""
    missing = [m for m in PERSONA_MARKERS if m not in text]
    if not missing:
        return PASS(f"all {len(PERSONA_MARKERS)} protocol markers present")
    return FAIL(f"persona never mentions: {missing}")

@m2.check("GOAL.md written by the ceremony")
def _(ws):
    p = Path(ws) / ".agi" / "GOAL.md"
    if not p.exists():
        return FAIL("run the ceremony (ch7 test, steps 1-4)")
    return PASS(f"{p.stat().st_size} bytes") if p.stat().st_size > 80 else \
        WARN("suspiciously short for objective+constraints+milestones+out-of-scope")

@m2.check("goal recorded via the native goal tool")
def _(ws):
    for d in supervisor_sessions(ws):
        if tool_calls(d, "create_goal") or tool_calls(d, "update_goal"):
            return PASS(f"in {d.name}")
    return FAIL("no create_goal/update_goal call in any main-agent session")

@m2.check("progress.jsonl: valid lines with ts+text")
def _(ws):
    good, bad = jsonl_records(Path(ws) / ".agi" / "progress.jsonl")
    if bad:
        return FAIL(f"{len(bad)} invalid line(s)")
    shaped = [r for r in good if "ts" in r and "text" in r]
    return PASS(f"{len(shaped)} entries") if shaped else FAIL("no {ts,text} entries yet")

@m2.check("questions.jsonl / CHANGELOG.jsonl are valid JSONL")
def _(ws):
    agi = Path(ws) / ".agi"
    _q, qbad = jsonl_records(agi / "questions.jsonl")
    ch, cbad = jsonl_records(agi / "CHANGELOG.jsonl")
    if qbad or cbad:
        return FAIL(f"invalid lines: questions={len(qbad)} changelog={len(cbad)}")
    noact = [r for r in ch if "action" not in r]
    return PASS() if not noact else WARN(f"{len(noact)} changelog line(s) lack `action`")

@m2.check("amendment discipline: GOAL_AMENDMENTS.md, GOAL.md untouched")
def _(ws):
    agi = Path(ws) / ".agi"
    am = agi / "GOAL_AMENDMENTS.md"
    if not am.exists() or am.stat().st_size == 0:
        return WARN("no amendment yet — ch7 test step 5 exercises this")
    goal, amend = (agi / "GOAL.md").stat().st_mtime, am.stat().st_mtime
    return PASS() if goal <= amend else FAIL("GOAL.md modified after the amendment")

@m2.check("config-edit refusal (say: 'set questionWaitMinutes to 2 for me')")
def _(ws):
    return MANUAL("expect refusal + a config-proposal line, never an edit (ch7 step 6)")


# -------------------------------------------------------------- m3: schedule

m3 = milestone("m3", "Time: the schedule overlay (chapter 8)")

@m3.check("dsh-schedule is inserted (profile patch or an installed bundle)")
def _(ws):
    # dsh-time-context is deliberately NOT required (nor wanted): it injects a
    # per-step timestamp block into every request, and Schedule doesn't need it.
    need = {"@deepseek-ai/dsh-schedule"}

    def inserted_names(path: Path) -> set:
        try:
            patches = load_yaml(path) or []
        except Exception:
            return set()
        names = set()
        for entry in patches if isinstance(patches, list) else []:
            for row in (entry or {}).get("insert") or []:
                if isinstance(row, dict):
                    names.add(row.get("name"))
        return names

    if not need - inserted_names(PATCH_FILE):
        return PASS("via the profile patch layer")
    # Bundle path (the dsh-supervisor package route): every profile bundle's
    # own cordis.patch.yml is a layer too.
    profile_dir = PATCH_FILE.parent
    try:
        manifest = json.loads((profile_dir / "package.json").read_text())
        bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles", [])
    except Exception:
        bundles = []
    for bundle in bundles:
        bundle_patch = profile_dir / "node_modules" / bundle / "cordis.patch.yml"
        if bundle_patch.exists() and not need - inserted_names(bundle_patch):
            return PASS(f"via installed bundle {bundle}")
    return FAIL("rows in neither the profile patch nor any installed bundle (ch8 / README)")

@m3.check("composed tree contains the schedule row (dump-config)")
def _(ws):
    try:
        out = subprocess.run(["dsh", "--profile", "web", "--dump-config"],
                             capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        return WARN("dsh CLI not on PATH for this shell — skipped")
    except subprocess.TimeoutExpired:
        return WARN("dump-config timed out — check manually")
    ok = "dsh-schedule" in out.stdout
    return PASS() if ok else FAIL("row absent from the composed tree — YAML typo? watch tmux for hmr/config-update-failed")

@m3.check("schedule_create was actually called by the supervisor")
def _(ws):
    for d in supervisor_sessions(ws):
        if tool_calls(d, "schedule_create"):
            return PASS(f"in {d.name}")
    return FAIL("no schedule_create in any main-agent session (ch8 tests 2-3)")

@m3.check("a reminder was delivered back as a turn")
def _(ws):
    sup = supervisor_sessions(ws)
    # Verified framing: a firing reminder arrives as a plugin-sourced message
    # whose text opens with "[SCHEDULE REMINDER]" and carries the prompt as
    # untrusted reminder content (observed live, 2026-08-21).
    if any_line_contains(sup, "[SCHEDULE REMINDER]"):
        return PASS("[SCHEDULE REMINDER] delivery observed")
    if any_line_contains(sup, "patience-test"):
        return PASS("'patience-test' reminder observed")
    return WARN("no delivery evidence found in logs — did you wait the 60s (ch8 test 2)?")

@m3.check("patience flow produced an `assumed` question")
def _(ws):
    good, _bad = jsonl_records(Path(ws) / ".agi" / "questions.jsonl")
    hits = [r for r in good if r.get("status") == "assumed"]
    return PASS(f"{len(hits)} assumed") if hits else \
        FAIL("no assumed entry — ch8 test 3 (stay silent past questionWaitMinutes)")

@m3.check("recurring floor: every_seconds < 300 must be refused")
def _(ws):
    return MANUAL("ch8 test 4 — ask for a 60s recurring reminder, expect refusal")


# --------------------------------------------------------------- m4: workers

m4 = milestone("m4", "Workers: spawn, steer, kill, report (chapter 9)")

@m4.check("child sessions exist (origin: subagent, parented to the supervisor)")
def _(ws):
    kids = child_sessions(ws)
    if not kids:
        return FAIL("no subagent-origin sessions in this workspace")
    parents = {session_header(d).get("parentSession") for d in kids}
    sup = {session_header(d).get("id") for d in supervisor_sessions(ws)}
    linked = parents & sup
    return PASS(f"{len(kids)} children, {len(linked)} linked to supervisor sessions") \
        if linked else WARN(f"{len(kids)} children but none parented to a main-agent session")

@m4.check("spawn: guarded subagent called with an explicit model")
def _(ws):
    calls = [call for d in supervisor_sessions(ws) for call in tool_calls(d, "subagent")]
    explicit = []
    for call in calls:
        arguments = call.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = None
        if isinstance(arguments, dict) and arguments.get("model"):
            explicit.append(call)
    if explicit:
        return PASS(f"{len(explicit)} explicit-model call(s)")
    return FAIL("no subagent call carrying a required settings-approved model choice")

@m4.check("steer: send_message called")
def _(ws):
    n = sum(len(tool_calls(d, "send_message")) for d in supervisor_sessions(ws))
    return PASS(f"{n} call(s)") if n else FAIL("no send_message call (ch9 observation 2)")

@m4.check("kill: interrupt_agent called")
def _(ws):
    n = sum(len(tool_calls(d, "interrupt_agent")) for d in supervisor_sessions(ws))
    return PASS(f"{n} call(s)") if n else FAIL("no interrupt_agent call (ch9 observation 5)")

@m4.check("settle notice reached the supervisor")
def _(ws):
    ok = any_line_contains(supervisor_sessions(ws), '"kind":"subagent-settled"')
    return PASS() if ok else FAIL("no subagent-settled notice in supervisor logs")

@m4.check("a blocked worker used report")
def _(ws):
    for d in child_sessions(ws):
        if tool_calls(d, "report"):
            return PASS(f"in child {d.name}")
    return FAIL("no report call in any child (ch9 observation 4)")

@m4.check("the report arrived as a subagent-report message")
def _(ws):
    ok = any_line_contains(supervisor_sessions(ws), '"kind":"subagent-report"')
    return PASS() if ok else WARN("no subagent-report-sourced message in supervisor logs")

@m4.check("a worker wrote outcome.md")
def _(ws):
    hits = list((Path(ws) / ".agi" / "subagents").glob("*/outcome.md"))
    return PASS(f"{len(hits)} outcome file(s)") if hits else \
        FAIL("no .agi/subagents/*/outcome.md — worker protocol not followed")

@m4.check("worker persona took (child behaves per the row's persona)")
def _(ws):
    return MANUAL("open a child session in the UI: it should report a summary at the end")


# ------------------------------------------------------------------ m5: loop

m5 = milestone("m5", "The supervision loop (chapter 10)")

def _changelog_actions(ws):
    good, _bad = jsonl_records(Path(ws) / ".agi" / "CHANGELOG.jsonl")
    return [str(r.get("action", "")) for r in good]

@m5.check("CHANGELOG covers spawn, steer, and kill")
def _(ws):
    actions = set(_changelog_actions(ws))
    missing = {"spawn", "steer", "kill"} - actions
    return PASS(f"actions seen: {sorted(actions)}") if not missing else \
        FAIL(f"never logged: {sorted(missing)}")

@m5.check("an assumption was logged (silent-question branch)")
def _(ws):
    good, _b = jsonl_records(Path(ws) / ".agi" / "questions.jsonl")
    if any(r.get("status") == "assumed" for r in good):
        return PASS()
    if any(a == "assumption" for a in _changelog_actions(ws)):
        return PASS("via CHANGELOG")
    return FAIL("no assumed question / assumption entry")

@m5.check("NOTES.md holds check-in verdicts")
def _(ws):
    p = Path(ws) / ".agi" / "NOTES.md"
    return PASS(f"{p.stat().st_size} bytes") if p.exists() and p.stat().st_size > 40 else \
        FAIL("empty NOTES.md — the timer-wake verdict rule (ch10) never ran?")

@m5.check("progress.jsonl narrates the mission (>= 3 entries)")
def _(ws):
    good, _b = jsonl_records(Path(ws) / ".agi" / "progress.jsonl")
    return PASS(f"{len(good)} entries") if len(good) >= 3 else \
        WARN(f"only {len(good)} entries")

@m5.check("mission deliverable exists (SUMMARY.md)")
def _(ws):
    p = Path(ws) / "SUMMARY.md"
    if p.exists():
        return PASS(f"{p.stat().st_size} bytes")
    return WARN("no SUMMARY.md — fine if your mission's deliverable differs; check it by hand")

@m5.check(">= 2 workers over the mission (kill+respawn implies two)")
def _(ws):
    n = len(child_sessions(ws))
    return PASS(f"{n} children") if n >= 2 else WARN(f"only {n} child session(s)")

@m5.check("timer hygiene: schedule_delete after work finished")
def _(ws):
    n = sum(len(tool_calls(d, "schedule_delete")) for d in supervisor_sessions(ws))
    return PASS(f"{n} call(s)") if n else \
        WARN("no schedule_delete seen — check schedule_list shows no leftover reminder")


# -------------------------------------------------------------------- m6: ui

m6 = milestone("m6", "UI: the Feed view tab (chapter 11)")

BASE_URL = os.environ.get("DSH_URL", "http://127.0.0.1:3080")

def _http(path: str):
    """GET BASE_URL+path -> (status, body-bytes) or (None, reason)."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=10) as resp:
            return resp.status, resp.read()
    except Exception as e:  # noqa: BLE001 - grading, not serving
        return None, str(e).encode()

@m6.check("the installed bundle ships a client half (dsh.client + lib/client.js)")
def _(ws):
    profile_dir = PATCH_FILE.parent
    pkg_dir = profile_dir / "node_modules" / "dsh-supervisor"
    try:
        manifest = json.loads((pkg_dir / "package.json").read_text())
    except Exception:
        return FAIL("dsh-supervisor is not installed in the web profile")
    if (manifest.get("dsh", {}).get("client", {}).get("platform")) != "web":
        return FAIL("package.json lacks dsh.client { platform: web }")
    if not (pkg_dir / "lib" / "client.js").exists():
        return FAIL("lib/client.js missing from the installed package")
    return PASS()

@m6.check("boot graph carries the dsh-supervisor row (client-modules scan)")
def _(ws):
    status, body = _http("/")
    if status is None:
        return WARN(f"dsh web not reachable at {BASE_URL} — {body.decode()[:80]}")
    ok = b"__DSH_BOOT__" in body and b"dsh-supervisor" in body
    return PASS() if ok else FAIL("index page's __DSH_BOOT__ graph has no dsh-supervisor row — restart after install?")

@m6.check("the client bundle is served")
def _(ws):
    status, _body = _http("/plugins/dsh-supervisor/client.js")
    if status is None:
        return WARN(f"dsh web not reachable at {BASE_URL}")
    return PASS() if status == 200 else FAIL(f"/plugins/dsh-supervisor/client.js answered {status}")

@m6.check("the feed route serves the workspace's .agi state")
def _(ws):
    status, body = _http(f"/supervisor/feed?ws={ws}")
    if status is None:
        return WARN(f"dsh web not reachable at {BASE_URL}")
    if status != 200:
        return FAIL(f"/supervisor/feed answered {status}: {body.decode()[:120]}")
    try:
        doc = json.loads(body)
    except Exception:
        return FAIL("feed route returned non-JSON")
    need = {"goal", "progress", "questions", "changelog", "subagents"}
    missing = need - doc.keys()
    return PASS() if not missing else FAIL(f"feed document lacks {sorted(missing)}")

@m6.check("Feed tab renders goal/workers/progress in the session view")
def _(ws):
    return MANUAL("open a main-agent session -> view ring -> Feed: goal card, workers, progress timeline")


# ------------------------------------------------------------ m7: acceptance

m7 = milestone("m7", "Acceptance run (chapter 12)")

@m7.check("restart resilience: session resumed after a process restart")
def _(ws):
    for d in supervisor_sessions(ws):
        if any('"type":"session/end-seed"' in ln or "end-seed" in ln
               for ln in session_lines(d)):
            return PASS(f"resume marker in {d.name}")
    return FAIL("no resume marker — the restart drill (ch12) hasn't happened")

@m7.check("goal amendment exercised after completion")
def _(ws):
    am = Path(ws) / ".agi" / "GOAL_AMENDMENTS.md"
    return PASS() if am.exists() and am.stat().st_size > 0 else \
        FAIL("no amendment entry (script step 8)")

@m7.check("no re-interview after restart; no duplicate workers")
def _(ws):
    return MANUAL("judge from the transcript: 'continue' must not re-run the ceremony")

@m7.check("exit criterion: every step passed twice in a row")
def _(ws):
    return MANUAL("keep the ledger next to DESIGN.md; two clean runs = done")


# ----------------------------------------------------------------------- cli

def doctor():
    print(f"{BOLD}grader doctor{RESET}")
    print(f"  DSH_HOME:        {DSH_HOME}  {'(ok)' if DSH_HOME.is_dir() else '(MISSING)'}")
    print(f"  preset dir:      {PRESET_DIR}  {'(ok)' if PRESET_DIR.is_dir() else '(absent)'}")
    print(f"  profile patch:   {PATCH_FILE}  {'(ok)' if PATCH_FILE.exists() else '(MISSING)'}")
    z = subprocess.run(["which", "zstd"], capture_output=True, text=True).stdout.strip()
    print(f"  zstd:            {z or 'MISSING (required)'}")
    try:
        import yaml  # noqa: F401
        print("  PyYAML:          ok")
    except ImportError:
        print("  PyYAML:          MISSING (pip install pyyaml)")
    root = DSH_HOME / "sessions"
    for wsdir in sorted(root.iterdir()) if root.is_dir() else []:
        dirs = [d for d in wsdir.iterdir() if d.is_dir()]
        presets = {}
        for d in dirs:
            h = session_header(d)
            key = (h.get("agentPreset", "?"), h.get("origin", "top"))
            presets[key] = presets.get(key, 0) + 1
        print(f"  {wsdir.name}: {len(dirs)} sessions {dict(sorted(presets.items()))}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", choices=[*MILESTONES.keys(), "all", "doctor"])
    ap.add_argument("--ws", help=f"workspace (default {DEFAULT_WS}; m7 default {ACCEPTANCE_WS})")
    args = ap.parse_args()

    if args.target == "doctor":
        doctor()
        return

    if args.target == "all":
        keys = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]
        ws = args.ws or DEFAULT_WS
        scores = [(k, MILESTONES[k].run(ws)) for k in keys]
        print(f"\n{BOLD}=== overall ==={RESET}")
        for k, s in scores:
            bar = "█" * int(s / 10) + "░" * (10 - int(s / 10))
            print(f"  {k}  {bar}  {s:.0f}%")
        sys.exit(0 if all(s >= 90 for _k, s in scores) else 1)

    if args.target == "m7":
        ws = args.ws or ACCEPTANCE_WS
        print(f"{DIM}m7 re-runs m2-m5 against the acceptance workspace first:{RESET}")
        scores = [MILESTONES[k].run(ws) for k in ("m2", "m3", "m4", "m5")]
        scores.append(MILESTONES["m7"].run(ws))
        sys.exit(0 if all(s >= 90 for s in scores) else 1)

    score = MILESTONES[args.target].run(args.ws or DEFAULT_WS)
    sys.exit(0 if score >= 90 else 1)


if __name__ == "__main__":
    main()
