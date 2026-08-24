#!/bin/sh
set -eu

tutorial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
venv_dir="$tutorial_dir/.venv"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it with your operating-system package manager." >&2
  exit 1
fi

create_venv() {
  python3 -m venv --clear "$venv_dir"
}

if [ ! -x "$venv_dir/bin/python" ] || ! "$venv_dir/bin/python" -m pip --version >/dev/null 2>&1; then
  echo "Creating the tutorial grader environment..."
  if ! create_venv >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "Python venv support is missing; installing python3-venv..."
      if [ "$(id -u)" -eq 0 ]; then
        apt-get update
        apt-get install -y python3-venv
      elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y python3-venv
      else
        echo "Run 'apt-get install python3-venv' as root, then retry." >&2
        exit 1
      fi
      create_venv
    else
      echo "Could not create a Python virtual environment." >&2
      echo "Install Python's venv module with your operating-system package manager, then retry." >&2
      exit 1
    fi
  fi
fi

echo "Installing grader dependencies into $venv_dir ..."
"$venv_dir/bin/python" -m pip install --disable-pip-version-check \
  --requirement "$tutorial_dir/requirements.txt"

echo "Starting the tutorial on an unused localhost port..."
exec "$venv_dir/bin/python" "$tutorial_dir/server.py" --host 127.0.0.1 --port 0
