#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS_DIR="$APP_HOME/mods"
LAYOUTS_DIR="$APP_HOME/layouts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$MODS_DIR"

installed=0
for mod_dir in "$REPO_ROOT"/mods/*; do
  [ -d "$mod_dir" ] || continue
  name="$(basename "$mod_dir")"
  rm -rf "${MODS_DIR:?}/$name"
  cp -R "$mod_dir" "$MODS_DIR/$name"
  echo "Installed mod: $name -> $MODS_DIR/$name"
  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$MODS_DIR/$name"
  fi
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No mods found under $REPO_ROOT/mods" >&2
  exit 1
fi

# Generate layouts/main-agy.json if layouts/main.json exists
if [ -f "$LAYOUTS_DIR/main.json" ]; then
  python3 - "$LAYOUTS_DIR/main.json" "$LAYOUTS_DIR/main-agy.json" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
data = json.loads(src.read_text("utf-8"))

def patch_layout(node):
    if isinstance(node, dict):
        if node.get("id") == "agents" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "agents-agy"
        if node.get("id") == "status" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "workspace-status-agy"
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
dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Generated layout: {dst}")
PY
fi
