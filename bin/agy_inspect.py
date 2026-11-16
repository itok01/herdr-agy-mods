#!/usr/bin/env python3
"""Inspect Antigravity CLI (agy) brain state for Herdr mod."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def read_jsonl_tail(path: Path, limit: int = 30) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    for raw in lines[-limit:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                rows.append(obj)
        except Exception:
            continue
    return rows


def summarize_transcript_step(step: dict[str, Any]) -> dict[str, Any]:
    tool_names = []
    for tc in step.get("tool_calls") or []:
        if isinstance(tc, dict) and tc.get("name"):
            tool_names.append(str(tc["name"]))
    full_text = str(step.get("content") or "").strip()
    preview = full_text.replace("\n", " ")
    if len(preview) > 140:
        preview = preview[:137] + "..."
    return {
        "step_index": step.get("step_index"),
        "type": step.get("type"),
        "source": step.get("source"),
        "status": step.get("status"),
        "created_at": step.get("created_at"),
        "tools": tool_names,
        "preview": preview,
        "full": full_text[:1500],
    }


def inspect_conversation(conv_dir: Path, agy_root: Path) -> dict[str, Any]:
    conv_id = conv_dir.name
    sys_dir = conv_dir / ".system_generated"
    swarm_meta = read_json(sys_dir / "swarm" / "swarm.json") or {}
    members_raw = read_json(sys_dir / "swarm" / "members.json") or {}
    board_rows = read_jsonl_tail(sys_dir / "swarm" / "board.jsonl", limit=40)
    transcript_rows = read_jsonl_tail(sys_dir / "logs" / "transcript.jsonl", limit=25)
    is_active_lock = (agy_root / "presence" / f"{conv_id}.lock").exists()

    members = []
    raw_members = members_raw.get("members") if isinstance(members_raw, dict) else {}
    if isinstance(raw_members, dict):
        for name, info in raw_members.items():
            if not isinstance(info, dict):
                continue
            members.append(
                {
                    "name": name,
                    "conversation_id": info.get("conversation_id"),
                    "role": info.get("role"),
                    "model": info.get("applied_model") or info.get("desired_model"),
                    "workspace_mode": info.get("workspace_mode"),
                    "phase": info.get("phase"),
                    "wake_mode": info.get("wake_mode"),
                    "last_read_seq": info.get("last_read_seq"),
                    "killed": bool(info.get("killed", False)),
                }
            )

    subagents = []
    sub_dir = sys_dir / "subagents"
    if sub_dir.is_dir():
        for p in sorted(sub_dir.glob("*.json")):
            data = read_json(p)
            if isinstance(data, dict):
                desc = data.get("subagentDescriptor") or {}
                sub_id = str(data.get("conversationId") or p.stem)
                sub_steps = read_jsonl_tail(
                    agy_root / "brain" / sub_id / ".system_generated" / "logs" / "transcript.jsonl",
                    limit=6,
                )
                subagents.append(
                    {
                        "conversation_id": sub_id,
                        "type_name": desc.get("typeName") or data.get("typeName"),
                        "role": desc.get("role") or data.get("role"),
                        "state": data.get("state"),
                        "spawn_step": data.get("spawnStepIndex"),
                        "recent_steps": [summarize_transcript_step(s) for s in sub_steps],
                    }
                )

    last_step = transcript_rows[-1] if transcript_rows else {}
    mtime = 0.0
    for candidate in (
        sys_dir / "logs" / "transcript.jsonl",
        sys_dir / "swarm" / "board.jsonl",
        conv_dir,
    ):
        if candidate.exists():
            mtime = max(mtime, candidate.stat().st_mtime)

    return {
        "conversation_id": conv_id,
        "active": is_active_lock,
        "mtime": mtime,
        "swarm_title": members_raw.get("title") if isinstance(members_raw, dict) else None,
        "swarm_backend": swarm_meta.get("backend"),
        "members": members,
        "board": board_rows,
        "subagents": subagents,
        "recent_steps": [summarize_transcript_step(s) for s in transcript_rows],
        "last_activity_at": last_step.get("created_at"),
    }


def collect(brain_root: Path, selected_conv: str | None = None, limit: int = 10) -> dict[str, Any]:
    if not brain_root.is_dir():
        return {"brain_root": str(brain_root), "conversations": [], "selected": None}

    agy_root = brain_root.parent
    dirs = [d for d in brain_root.iterdir() if d.is_dir() and (d / ".system_generated").is_dir()]
    summaries = [inspect_conversation(d, agy_root) for d in dirs]
    summaries.sort(key=lambda item: (item["active"], item["mtime"]), reverse=True)

    trimmed = summaries[:limit]
    selected = None
    if selected_conv:
        for item in summaries:
            if item["conversation_id"] == selected_conv:
                selected = item
                break
    if selected is None and trimmed:
        selected = trimmed[0]

    list_items = [
        {
            "conversation_id": s["conversation_id"],
            "active": s["active"],
            "swarm_title": s["swarm_title"],
            "member_count": len(s["members"]),
            "subagent_count": len(s["subagents"]),
            "last_activity_at": s["last_activity_at"],
            "mtime": s["mtime"],
        }
        for s in trimmed
    ]
    return {
        "brain_root": str(brain_root),
        "conversations": list_items,
        "selected": selected,
    }


def main() -> int:
    brain_root = Path(os.environ.get("AGY_BRAIN_ROOT") or Path.home() / ".gemini" / "antigravity-cli" / "brain")
    selected = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    print(json.dumps(collect(brain_root, selected_conv=selected), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
