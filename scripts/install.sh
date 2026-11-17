#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS_DIR="$APP_HOME/mods"
LAYOUTS_DIR="$APP_HOME/layouts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required in PATH." >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

installed=0
for mod_dir in "$REPO_ROOT"/mods/*; do
  [ -d "$mod_dir" ] || continue
  name="$(basename "$mod_dir")"
  cp -R "$mod_dir" "$STAGE_DIR/$name"
  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$STAGE_DIR/$name"
  else
    echo "Warning: herdr-app not found in PATH; skipping check for $name" >&2
  fi
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No mods found under $REPO_ROOT/mods" >&2
  exit 1
fi

mkdir -p "$MODS_DIR"
for staged_dir in "$STAGE_DIR"/*; do
  name="$(basename "$staged_dir")"
  rm -rf "${MODS_DIR:?}/$name"
  cp -R "$staged_dir" "$MODS_DIR/$name"
  echo "Installed mod: $name -> $MODS_DIR/$name"
done

# Generate layouts/main-agy.json if layouts/main.json exists
if [ -f "$LAYOUTS_DIR/main.json" ]; then
  if [ -f "$LAYOUTS_DIR/main-agy.json" ]; then
    cp "$LAYOUTS_DIR/main-agy.json" "$LAYOUTS_DIR/main-agy.json.bak"
  fi
  python3 - "$LAYOUTS_DIR/main.json" "$LAYOUTS_DIR/main-agy.json" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
data = json.loads(src.read_text("utf-8"))
patched = {"agents": False, "status": False}

def patch_layout(node):
    if isinstance(node, dict):
        if node.get("id") == "agents" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "agents-agy"
            patched["agents"] = True
        if node.get("id") == "status" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "workspace-status-agy"
            patched["status"] = True
        if node.get("id") == "panel-body" and isinstance(node.get("children"), list):
            existing = {c.get("id") for c in node["children"] if isinstance(c, dict)}
            if "agy-inspector" not in existing:
                node["children"].append({"id": "agy-inspector", "type": "block", "content": {"mod": "agy-inspector"}})
            if "model-usage" not in existing:
                node["children"].append({"id": "model-usage", "type": "block", "content": {"mod": "model-usage"}})
        for v in node.values():
            patch_layout(v)
    elif isinstance(node, list):
        for item in node:
            patch_layout(item)

patch_layout(data)
if not (patched["agents"] and patched["status"]):
    print(f"Warning: expected layout nodes not fully matched: {patched}", file=sys.stderr)
dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Generated layout: {dst}")
PY
else
  echo "Note: $LAYOUTS_DIR/main.json not found; skipped main-agy.json generation." >&2
fi
