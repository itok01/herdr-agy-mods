#!/usr/bin/env python3
"""Collect model/agent quota, rate limits, and token usage hints for Herdr mod."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def fmt_window(minutes: int | float | None) -> str:
    if not minutes:
        return "window"
    m = int(minutes)
    if m % 1440 == 0:
        return f"{m // 1440}d"
    if m % 60 == 0:
        return f"{m // 60}h"
    return f"{m}m"


def fmt_reset(resets_at: int | float | None, now: float) -> str:
    if not resets_at:
        return "-"
    diff = max(0, int(resets_at - now))
    d, rem = divmod(diff, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d > 0:
        return f"{d}d {h}h"
    if h > 0:
        return f"{h}h {m}m"
    return f"{m}m"


def collect_codex_quota(codex_dir: Path, now: float) -> dict[str, Any]:
    sessions_dir = codex_dir / "sessions"
    if not sessions_dir.is_dir():
        return {"installed": codex_dir.is_dir(), "rate_limits": [], "tokens": None}

    files = sorted(sessions_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    rate_limits: list[dict[str, Any]] = []
    plan_type = None
    tokens = None

    for path in files[:5]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        for raw in reversed(lines):
            if "rate_limits" not in raw and "total_token_usage" not in raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            payload = obj.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            info = payload.get("info") or {}
            if tokens is None and isinstance(info, dict) and isinstance(info.get("total_token_usage"), dict):
                tu = info["total_token_usage"]
                tokens = {
                    "input": tu.get("input_tokens", 0),
                    "cached": tu.get("cached_input_tokens", 0),
                    "output": tu.get("output_tokens", 0),
                    "reasoning": tu.get("reasoning_output_tokens", 0),
                    "total": tu.get("total_tokens", 0),
                }
            rl = payload.get("rate_limits")
            if not rate_limits and isinstance(rl, dict):
                plan_type = rl.get("plan_type")
                for key in ("primary", "secondary"):
                    win = rl.get(key)
                    if isinstance(win, dict) and "used_percent" in win:
                        used = float(win["used_percent"])
                        rate_limits.append(
                            {
                                "label": fmt_window(win.get("window_minutes")),
                                "used_percent": used,
                                "remaining_percent": round(max(0.0, 100.0 - used), 1),
                                "reset_in": fmt_reset(win.get("resets_at"), now),
                            }
                        )
            if rate_limits and tokens:
                break
        if rate_limits and tokens:
            break

    return {
        "installed": True,
        "plan_type": plan_type,
        "rate_limits": rate_limits,
        "tokens": tokens,
    }


def collect_agy_stats(agy_dir: Path, now: float) -> dict[str, Any]:
    settings = read_json(agy_dir / "settings.json") or {}
    account = None
    cli_log = agy_dir / "cli.log"
    if cli_log.exists():
        try:
            for line in reversed(cli_log.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]):
                m = re.search(r"email=([^\s,]+)", line)
                if m:
                    account = m.group(1)
                    break
        except Exception:
            pass

    brain_dir = agy_dir / "brain"
    recent_24h = 0
    active_locks = 0
    quota_warnings = 0
    if brain_dir.is_dir():
        for conv in brain_dir.iterdir():
            if not conv.is_dir():
                continue
            if (agy_dir / "presence" / f"{conv.name}.lock").exists():
                active_locks += 1
            tr = conv / ".system_generated" / "logs" / "transcript.jsonl"
            if tr.exists() and (now - tr.stat().st_mtime) <= 86400:
                recent_24h += 1
            board = conv / ".system_generated" / "swarm" / "board.jsonl"
            if board.exists() and (now - board.stat().st_mtime) <= 86400:
                try:
                    if "[quota]" in board.read_text(encoding="utf-8", errors="replace"):
                        quota_warnings += 1
                except Exception:
                    pass

    return {
        "installed": agy_dir.is_dir(),
        "account": account,
        "model": settings.get("model") or settings.get("defaultModel") or "configured",
        "active_locks": active_locks,
        "recent_24h_convs": recent_24h,
        "quota_warnings_24h": quota_warnings,
    }


def collect_claude_stats(claude_dir: Path, now: float) -> dict[str, Any]:
    if not claude_dir.is_dir():
        return {"installed": False, "recent_24h_sessions": 0}
    recent_24h = 0
    projects = claude_dir / "projects"
    if projects.is_dir():
        for p in projects.rglob("*.jsonl"):
            try:
                if (now - p.stat().st_mtime) <= 86400:
                    recent_24h += 1
            except Exception:
                continue
    return {"installed": True, "recent_24h_sessions": recent_24h}


def collect_hc_agents() -> list[dict[str, Any]]:
    try:
        proc = subprocess.run(
            ["hc", "ls", "--json"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if proc.returncode != 0:
            return []
        data = json.loads(proc.stdout)
        terms = data.get("terminals") or []
        return [
            {
                "address": t.get("address"),
                "agent": t.get("agent"),
                "name": t.get("name") or t.get("where"),
                "status": t.get("status"),
                "turn": t.get("turn"),
            }
            for t in terms
            if isinstance(t, dict)
        ]
    except Exception:
        return []


def collect_usage(home: Path | None = None, now: float | None = None) -> dict[str, Any]:
    root = home or Path.home()
    ts = now if now is not None else time.time()
    hc_terms = collect_hc_agents()
    by_agent: dict[str, dict[str, int]] = {}
    for t in hc_terms:
        key = str(t.get("agent") or "unknown")
        bucket = by_agent.setdefault(key, {"total": 0, "working": 0, "blocked": 0, "done": 0, "idle": 0})
        bucket["total"] += 1
        st = str(t.get("status") or "idle")
        if st in bucket:
            bucket[st] += 1

    return {
        "codex": collect_codex_quota(root / ".codex", ts),
        "agy": collect_agy_stats(root / ".gemini" / "antigravity-cli", ts),
        "claude": collect_claude_stats(root / ".claude", ts),
        "agent_summary": by_agent,
        "active_terminals": hc_terms,
    }


def main() -> int:
    home_override = os.environ.get("HERDR_USAGE_HOME")
    home = Path(home_override) if home_override else None
    print(json.dumps(collect_usage(home=home), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
