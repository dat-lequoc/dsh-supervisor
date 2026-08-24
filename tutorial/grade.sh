#!/bin/sh
set -eu

tutorial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python="$tutorial_dir/.venv/bin/python"

if [ ! -x "$python" ]; then
  echo "Tutorial grader environment is missing. Run ./tutorial/setup.sh first." >&2
  exit 1
fi

exec "$python" "$tutorial_dir/grade.py" "$@"
