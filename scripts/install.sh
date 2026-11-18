#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS_DIR="$APP_HOME/mods"
LAYOUTS_DIR="$APP_HOME/layouts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ONLY=""
LAYOUT_NAME=""

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [all|agy|usage] [--layout <name>]

Targets:
  all    Install both bundles (agy + usage) [default in non-interactive mode]
  agy    Install only Antigravity (agy) mods: agents-agy, agy-inspector
  usage  Install only Quota/Usage mods: workspace-status-agy, model-usage

Options:
  --only TARGET  Same as positional [all|agy|usage]
  --layout NAME  Output layout name under layouts/ (default: main-agy, or main-usage for usage)
  -h, --help     Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    all|agy|usage)
      ONLY="$1"
      shift
      ;;
    --only)
      [ "$#" -ge 2 ] || { echo "Error: --only requires a value (all|agy|usage)" >&2; exit 1; }
      ONLY="$2"
      shift 2
      ;;
    --only=*)
      ONLY="${1#--only=}"
      shift
      ;;
    --layout)
      [ "$#" -ge 2 ] || { echo "Error: --layout requires a name" >&2; exit 1; }
      LAYOUT_NAME="$2"
      shift 2
      ;;
    --layout=*)
      LAYOUT_NAME="${1#--layout=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$ONLY" ]; then
  if [ -t 0 ]; then
    echo "Select which mod bundle to install:"
    echo "  1) Both (agy + usage) [default]"
    echo "  2) Quota / Usage only (Codex & Claude)"
    echo "  3) Antigravity (agy) only (Swarm & Subagents)"
    printf "Choice [1-3]: "
    read -r choice
    case "$choice" in
      ""|1|all) ONLY="all" ;;
      2|usage)  ONLY="usage" ;;
      3|agy)    ONLY="agy" ;;
      *)        echo "Error: Invalid choice: $choice" >&2; exit 1 ;;
    esac
  else
    ONLY="all"
  fi
fi

case "$ONLY" in
  all)
    SELECTED_MODS=(agents-agy agy-inspector model-usage workspace-status-agy)
    DEFAULT_LAYOUT="main-agy"
    ;;
  agy)
    SELECTED_MODS=(agents-agy agy-inspector)
    DEFAULT_LAYOUT="main-agy"
    ;;
  usage)
    SELECTED_MODS=(model-usage workspace-status-agy)
    DEFAULT_LAYOUT="main-usage"
    ;;
  *)
    echo "Error: --only must be one of: all, agy, usage (got '$ONLY')" >&2
      exit 1
    ;;
esac

LAYOUT_NAME="${LAYOUT_NAME:-$DEFAULT_LAYOUT}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required in PATH." >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

for name in "${SELECTED_MODS[@]}"; do
  mod_dir="$REPO_ROOT/mods/$name"
  if [ ! -d "$mod_dir" ]; then
    echo "Error: Missing mod directory: $mod_dir" >&2
    exit 1
  fi
  cp -R "$mod_dir" "$STAGE_DIR/$name"
  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$STAGE_DIR/$name"
  else
    echo "Warning: herdr-app not found in PATH; skipping check for $name" >&2
  fi
done

mkdir -p "$MODS_DIR"
for name in "${SELECTED_MODS[@]}"; do
  rm -rf "${MODS_DIR:?}/$name"
  cp -R "$STAGE_DIR/$name" "$MODS_DIR/$name"
  echo "Installed mod: $name -> $MODS_DIR/$name"
done

# Generate layouts/<LAYOUT_NAME>.json if layouts/main.json exists
if [ -f "$LAYOUTS_DIR/main.json" ]; then
  DST_LAYOUT="$LAYOUTS_DIR/${LAYOUT_NAME}.json"
  if [ -f "$DST_LAYOUT" ]; then
    cp "$DST_LAYOUT" "${DST_LAYOUT}.bak"
  fi
  python3 - "$LAYOUTS_DIR/main.json" "$DST_LAYOUT" "$ONLY" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
only = sys.argv[3]
install_agy = only in ("all", "agy")
install_usage = only in ("all", "usage")

data = json.loads(src.read_text("utf-8"))
patched = {"agents": False, "status": False}

def patch_layout(node):
    if isinstance(node, dict):
        if install_agy and node.get("id") == "agents" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "agents-agy"
            patched["agents"] = True
        if install_usage and node.get("id") == "status" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "workspace-status-agy"
            patched["status"] = True
        if node.get("id") == "panel-body" and isinstance(node.get("children"), list):
            existing = {c.get("id") for c in node["children"] if isinstance(c, dict)}
            if install_agy and "agy-inspector" not in existing:
                node["children"].append({"id": "agy-inspector", "type": "block", "content": {"mod": "agy-inspector"}})
            if install_usage and "model-usage" not in existing:
                node["children"].append({"id": "model-usage", "type": "block", "content": {"mod": "model-usage"}})
        for v in node.values():
            patch_layout(v)
    elif isinstance(node, list):
        for item in node:
            patch_layout(item)

patch_layout(data)
if (install_agy and not patched["agents"]) or (install_usage and not patched["status"]):
    print(f"Warning: expected layout nodes not fully matched: {patched}", file=sys.stderr)
dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Generated layout: {dst}")
PY
else
  echo "Note: $LAYOUTS_DIR/main.json not found; skipped ${LAYOUT_NAME}.json generation." >&2
fi
