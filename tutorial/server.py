#!/usr/bin/env python3
"""Serve the tutorial and expose its read-only milestone grader on localhost."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


TUTORIAL_ROOT = Path(__file__).resolve().parent
GRADER = TUTORIAL_ROOT / "grade.py"
TARGETS = {"doctor", "all", *(f"m{i}" for i in range(8))}


class TutorialHandler(SimpleHTTPRequestHandler):
    server_version = "DSHSupervisorTutorial/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(TUTORIAL_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path != "/api/grade":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16_384:
                raise ValueError("request body is too large")
            payload = json.loads(self.rfile.read(length) or b"{}")
            target = payload.get("target")
            workspace = payload.get("workspace")
            if target not in TARGETS:
                raise ValueError("unknown grader target")
            if workspace is not None and not isinstance(workspace, str):
                raise ValueError("workspace must be a string")
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})
            return

        command = [sys.executable, str(GRADER), target]
        if workspace and target != "doctor":
            expanded = os.path.expandvars(workspace)
            command.extend(["--ws", str(Path(expanded).expanduser())])
        try:
            result = subprocess.run(
                command,
                cwd=TUTORIAL_ROOT,
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            output = (exc.stdout or "") + (exc.stderr or "")
            self._json(504, {"ok": False, "exitCode": None, "output": output,
                             "error": "grader timed out after 180 seconds"})
            return

        output = result.stdout + result.stderr
        self._json(200, {"ok": result.returncode == 0,
                         "exitCode": result.returncode, "output": output})

    def _json(self, status: int, document: dict) -> None:
        body = json.dumps(document).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1",
                        help="listen address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=0,
                        help="listen port; 0 selects an unused port (default: 0)")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), TutorialHandler)
    host, port = server.server_address[:2]
    print(f"Tutorial: http://{host}:{port}/", flush=True)
    print("Press Ctrl-C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
