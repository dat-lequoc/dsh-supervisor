#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python="$repo_dir/.venv-tutorial/bin/python"

if [ ! -x "$python" ]; then
  echo "Tutorial grader environment is missing. Run ./setup-tutorial.sh first." >&2
  exit 1
fi

exec "$python" "$repo_dir/tests/grade.py" "$@"
