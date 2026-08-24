#!/usr/bin/env python3
"""Drive the running dsh web process over its HTTP RPC API (POST /api/<method>).

A thin console for supervising the supervisor: send prompts, wait for the turn
to finish, and print a readable tail of what happened. Used by the course's
test runs; also handy interactively.

Usage:
    drive.py create --cwd "$HOME/agi-lab" [--preset main-agent]
    drive.py send  <sessionId> "message"            # prompt + wait + tail
    drive.py steer <sessionId> "message"            # mode=steer
    drive.py wait  <sessionId> [--timeout 900]      # wait until not running
    drive.py tail  <sessionId> [--n 25]             # last N events, readable
    drive.py watch <sessionId> [--timeout 900]      # wait, then tail
    drive.py sessions --cwd "$HOME/agi-lab"         # list sessions
    drive.py children <sessionId>                   # subagent.list for parent

The wire envelope (verified: packages/host/apiproxy/src/fetch/handler.ts):
POST /api/<method> with {"type":"client-request","rpcId","method","payload"}.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import uuid

BASE = "http://127.0.0.1:3080"


def rpc(method: str, payload: dict, timeout: float = 60.0) -> dict:
    envelope = {"type": "client-request", "rpcId": f"drive-{uuid.uuid4().hex[:12]}",
                "method": method, "payload": payload}
    req = urllib.request.Request(
        f"{BASE}/api/{method}", data=json.dumps(envelope).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        answer = json.loads(resp.read())
    result = answer.get("result", {})
    if not result.get("ok"):
        raise SystemExit(f"RPC {method} failed: {json.dumps(result.get('error'))}")
    return result["value"]


def summary_of(session_id: str) -> dict | None:
    for item in rpc("session.list", {})["items"]:
        if item["sessionId"] == session_id:
            return item
    return None


def wait_idle(session_id: str, timeout: float = 900.0, settle: float = 6.0) -> None:
    """Block until the session stops running and stays idle for `settle` seconds."""
    deadline = time.time() + timeout
    idle_since: float | None = None
    while time.time() < deadline:
        item = summary_of(session_id)
        running = bool(item and item.get("running"))
        now = time.time()
        if running:
            idle_since = None
        elif idle_since is None:
            idle_since = now
        elif now - idle_since >= settle:
            return
        time.sleep(3)
    print(f"[drive] wait timed out after {timeout}s (still running)", file=sys.stderr)


def _text_of(content) -> str:
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content
                        if isinstance(b, dict) and b.get("type") == "text")
    return str(content)


def render_event(ev: dict) -> str | None:
    """One readable line per interesting event; None = skip."""
    t, data = ev.get("type"), ev.get("data", {})
    if t == "user/message":
        msg = data.get("message", data)
        src = msg.get("source", {}) if isinstance(msg, dict) else {}
        kind = src.get("kind", "?")
        text = _text_of(msg.get("content")) if isinstance(msg, dict) else ""
        label = {"user": "YOU", "subagent-settled": "SETTLE",
                 "subagent-report": "REPORT", "schedule": "TIMER"}.get(kind, kind.upper())
        if kind == "subagent-settled":
            text = src.get("summary", text)
        return f"  ◦ {label}: {text[:220]}"
    if t == "assistant/message":
        text = _text_of(data.get("message", {}).get("content"))
        return f"  ● AGENT: {text[:400]}" if text.strip() else None
    if t == "tool/call":
        name = data.get("name", "?")
        args = str(data.get("arguments", ""))[:160]
        return f"  ▸ tool {name}({args})"
    if t == "turn/end":
        return "  — turn end —"
    return None


def tail(session_id: str, n: int = 25) -> None:
    value = rpc("session.history", {"sessionId": session_id, "maxMessages": n})
    lines = [line for entry in value["events"]
             if (line := render_event(entry["event"])) is not None]
    print("\n".join(lines[-60:]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create")
    p.add_argument("--cwd", required=True)
    p.add_argument("--preset", default="main-agent")

    for name in ("send", "steer"):
        p = sub.add_parser(name)
        p.add_argument("session")
        p.add_argument("message")
        p.add_argument("--timeout", type=float, default=900)
        p.add_argument("--no-wait", action="store_true")

    p = sub.add_parser("wait")
    p.add_argument("session")
    p.add_argument("--timeout", type=float, default=900)

    p = sub.add_parser("tail")
    p.add_argument("session")
    p.add_argument("--n", type=int, default=25)

    p = sub.add_parser("watch")
    p.add_argument("session")
    p.add_argument("--timeout", type=float, default=900)

    p = sub.add_parser("sessions")
    p.add_argument("--cwd")

    p = sub.add_parser("children")
    p.add_argument("session")

    args = ap.parse_args()

    if args.cmd == "create":
        value = rpc("session.create", {"cwd": args.cwd, "agentPreset": args.preset})
        print(value["sessionId"])
    elif args.cmd in ("send", "steer"):
        rpc("session.prompt", {
            "sessionId": args.session,
            "mode": "queue" if args.cmd == "send" else "steer",
            "content": [{"type": "text", "text": args.message}],
        })
        print(f"[drive] sent ({args.cmd}); waiting for idle…")
        if not args.no_wait:
            time.sleep(4)
            wait_idle(args.session, timeout=args.timeout)
            tail(args.session)
    elif args.cmd == "wait":
        wait_idle(args.session, timeout=args.timeout)
        print("[drive] idle")
    elif args.cmd == "tail":
        tail(args.session, n=args.n)
    elif args.cmd == "watch":
        wait_idle(args.session, timeout=args.timeout)
        tail(args.session)
    elif args.cmd == "sessions":
        for item in rpc("session.list", {})["items"]:
            if args.cwd and item.get("cwd") != args.cwd:
                continue
            title = (item.get("projections", {}).get("values", {}) or {}).get("title", "")
            print(f"{item['sessionId']}  running={item['running']}  "
                  f"preset={item.get('agentPreset')}  cwd={item.get('cwd')}  {title}")
    elif args.cmd == "children":
        value = rpc("subagent.list", {"parentSessionId": args.session})
        print(json.dumps(value, indent=2)[:3000])


if __name__ == "__main__":
    main()
