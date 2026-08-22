#!/usr/bin/env bash
# Manual (non-bundle) install of the Always-On Supervisor setup.
#
# Prefer the bundle path in the README (`dsh plugin --profile web add …`),
# which mounts the schedule rows and auto-installs the preset. This script is
# the fallback for deployments where editing the profile patch by hand is
# preferred. DO NOT use both: the schedule service registers once per process,
# so the bundle rows and these patch rows must not coexist.
#
# Idempotent and non-destructive: never overwrites an existing main-agent
# preset or a non-empty profile patch without --force.
#
# Usage:  ./install-manual.sh [workspace-dir]        (default: ~/agi-lab)
#         ./install-manual.sh --force [workspace-dir]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
FORCE=0
[ "${1:-}" = "--force" ] && { FORCE=1; shift; }
WS="${1:-$HOME/agi-lab}"

echo "DSH home:   $DSH_HOME"
echo "Workspace:  $WS"

# ── 1. the main-agent preset ────────────────────────────────────────────────
PRESET_DIR="$DSH_HOME/.agent-presets/main-agent"
if [ -e "$PRESET_DIR" ] && [ "$FORCE" != 1 ]; then
  echo "preset: $PRESET_DIR already exists — skipping (use --force to replace)"
else
  mkdir -p "$DSH_HOME/.agent-presets"
  rm -rf "$PRESET_DIR"
  cp -r "$REPO/agent-presets/main-agent" "$PRESET_DIR"
  echo "preset: installed main-agent"
fi

# ── 2. the schedule overlay (host-plane patch rows) ─────────────────────────
PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
mkdir -p "$(dirname "$PATCH")"
ROWS='- insert:
    - id: time-context
      name: '\''@deepseek-ai/dsh-time-context'\''
    - id: schedule
      name: '\''@deepseek-ai/dsh-schedule'\'''
if [ -f "$PATCH" ] && grep -q 'dsh-schedule' "$PATCH"; then
  echo "patch:  schedule overlay already present — skipping"
elif [ -f "$PATCH" ] && grep -qv '^\s*\(#\|\[\]\|$\)' "$PATCH" && [ "$FORCE" != 1 ]; then
  echo "patch:  $PATCH has existing content — append these rows yourself:"
  echo "$ROWS" | sed 's/^/        /'
else
  cp "$PATCH" "$PATCH.bak" 2>/dev/null || true
  printf '%s\n' "# Profile patch layer — live-watched. Schedule overlay for dsh-supervisor." "$ROWS" > "$PATCH"
  echo "patch:  schedule overlay installed (backup at $PATCH.bak if one existed)"
fi

# ── 3. the workspace .agi skeleton ──────────────────────────────────────────
mkdir -p "$WS/.agi/subagents"
[ -f "$WS/.agi/config.json" ] || cp "$REPO/agi-template/config.json" "$WS/.agi/config.json"
touch "$WS/.agi/NOTES.md" "$WS/.agi/progress.jsonl" \
      "$WS/.agi/questions.jsonl" "$WS/.agi/CHANGELOG.jsonl"
python3 -c "import json; json.load(open('$WS/.agi/config.json'))"
echo "agi:    $WS/.agi ready"

cat <<EOF

Done. Next:
  1. Start (or keep running) the web UI:   dsh web
  2. Open http://127.0.0.1:3080 -> new session -> workspace $WS
     -> preset "Main Agent (Supervisor)".
  3. Grade progress anytime:
       python3 $REPO/tests/grade.py all --ws $WS
EOF
