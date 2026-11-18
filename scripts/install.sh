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

# Discover all valid mods under mods/ (must contain mod.json)
ALL_MODS=()
for d in "$REPO_ROOT"/mods/*; do
  [ -d "$d" ] && [ -f "$d/mod.json" ] || continue
  ALL_MODS+=("$(basename "$d")")
done

if [ "${#ALL_MODS[@]}" -eq 0 ]; then
  echo "No mods found under $REPO_ROOT/mods" >&2
  exit 1
fi

list_mods() {
  echo "Available bundles:"
  echo "  all    All mods (${ALL_MODS[*]})"
  echo "  agy    Antigravity Swarm/Subagent (agents-agy, agy-inspector)"
  echo "  usage  Codex & Claude Quota/Usage (workspace-status-agy, model-usage)"
  echo ""
  echo "Available mods:"
  python3 - "$REPO_ROOT/mods" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
for d in sorted(p for p in root.iterdir() if p.is_dir() and (p / "mod.json").is_file()):
    try: title = json.loads((d / "mod.json").read_text("utf-8")).get("title", "")
    except Exception: title = ""
    print(f"  {d.name:<24} {title}")
PY
}

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [TARGET...] [--layout <name>] [--skip-check]
       ./scripts/install.sh --uninstall [TARGET...]

Targets (one or more mod names or bundles; default: interactive menu or 'all'):
  all            All discovered mods under mods/
  agy            Bundle: agents-agy, agy-inspector
  usage          Bundle: workspace-status-agy, model-usage
  <mod-name>...  Any specific mod folder name(s) under mods/

Options:
  --list         List all available mods and bundles
  --only TARGET  Same as positional TARGET
  --layout NAME  Output layout name under layouts/ (default: main-agy, or main-usage for usage-only)
  --skip-check   Skip 'herdr-app check' validation
  --uninstall    Uninstall selected (or all) mods and generated layouts
  -h, --help     Show this help
EOF
}

TARGETS=()
LAYOUT_NAME=""
SKIP_CHECK=0
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list)
      list_mods
      exit 0
      ;;
    --skip-check)
      SKIP_CHECK=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --only)
      [ "$#" -ge 2 ] || { echo "Error: --only requires a target" >&2; exit 1; }
      TARGETS+=("$2")
      shift 2
      ;;
    --only=*)
      TARGETS+=("${1#--only=}")
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
    -*)
      echo "Error: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
  if [ "$UNINSTALL" -eq 0 ] && [ -t 0 ]; then
    echo "Select what to install:"
    echo "  1) all   - All mods (${#ALL_MODS[@]}) [default]"
    echo "  2) usage - Codex & Claude Quota/Usage"
    echo "  3) agy   - Antigravity (agy) Swarm & Subagents"
    echo "  Or enter space-separated mod names (run './scripts/install.sh --list' to see all)"
    printf "Choice [1]: "
    if ! IFS= read -r line; then
      line=""
    fi
    if [ -z "$line" ] || [ "$line" = "1" ]; then
      TARGETS=("all")
    elif [ "$line" = "2" ]; then
      TARGETS=("usage")
    elif [ "$line" = "3" ]; then
      TARGETS=("agy")
    else
      read -ra toks <<< "$line"
      for tok in "${toks[@]}"; do
        TARGETS+=("$tok")
      done
    fi
  else
    TARGETS=("all")
  fi
fi

# Resolve targets (bundles + individual mod names) into deduplicated SELECTED_MODS
SELECTED_MODS=()
add_mod() {
  local m="$1"
  for existing in "${SELECTED_MODS[@]+"${SELECTED_MODS[@]}"}"; do
    [ "$existing" = "$m" ] && return 0
  done
  SELECTED_MODS+=("$m")
}

for tgt in "${TARGETS[@]}"; do
  case "$tgt" in
    all)
      for m in "${ALL_MODS[@]}"; do add_mod "$m"; done
      ;;
    agy)
      add_mod "agents-agy"
      add_mod "agy-inspector"
      ;;
    usage)
      add_mod "model-usage"
      add_mod "workspace-status-agy"
      ;;
    *)
      if [ -d "$REPO_ROOT/mods/$tgt" ] && [ -f "$REPO_ROOT/mods/$tgt/mod.json" ]; then
        add_mod "$tgt"
      else
        echo "Error: Unknown mod or bundle '$tgt'. Run './scripts/install.sh --list' to see options." >&2
        exit 1
      fi
      ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  for name in "${SELECTED_MODS[@]}"; do
    if [ -d "$MODS_DIR/$name" ]; then
      rm -rf "${MODS_DIR:?}/$name"
      echo "Removed mod: $MODS_DIR/$name"
    fi
  done
  if [ "${#TARGETS[@]}" -eq 1 ] && [ "${TARGETS[0]}" = "all" ]; then
    rm -f "$LAYOUTS_DIR/main-agy.json" "$LAYOUTS_DIR/main-agy.json.bak" \
          "$LAYOUTS_DIR/main-usage.json" "$LAYOUTS_DIR/main-usage.json.bak"
    echo "Removed generated layouts in $LAYOUTS_DIR"
  fi
  exit 0
fi

if [ -z "$LAYOUT_NAME" ]; then
  if [ "${#TARGETS[@]}" -eq 1 ] && [ "${TARGETS[0]}" = "usage" ]; then
    LAYOUT_NAME="main-usage"
  else
    LAYOUT_NAME="main-agy"
  fi
fi

LAYOUT_NAME="${LAYOUT_NAME%.json}"
if [[ ! "$LAYOUT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || [ "$LAYOUT_NAME" = "main" ]; then
  echo "Error: Invalid --layout name '$LAYOUT_NAME' (must match ^[A-Za-z0-9._-]+$ and cannot be 'main')." >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

for name in "${SELECTED_MODS[@]}"; do
  mod_dir="$REPO_ROOT/mods/$name"
  cp -R "$mod_dir" "$STAGE_DIR/$name"
  if [ "$SKIP_CHECK" -eq 0 ]; then
    if command -v herdr-app >/dev/null 2>&1; then
      herdr-app check "$STAGE_DIR/$name"
    else
      echo "Warning: herdr-app not found in PATH; skipping check for $name (use --skip-check to silence)" >&2
    fi
  fi
done

mkdir -p "$MODS_DIR"
for name in "${SELECTED_MODS[@]}"; do
  rm -rf "${MODS_DIR:?}/$name"
  cp -R "$STAGE_DIR/$name" "$MODS_DIR/$name"
  echo "Installed mod: $name -> $MODS_DIR/$name"
done

# Collect all currently installed repo mods in $MODS_DIR so incremental installs preserve existing patches
ACTIVE_MODS=()
for m in "${ALL_MODS[@]}"; do
  if [ -d "$MODS_DIR/$m" ]; then
    ACTIVE_MODS+=("$m")
  fi
done

# Generate layouts/<LAYOUT_NAME>.json if layouts/main.json exists
if [ -f "$LAYOUTS_DIR/main.json" ]; then
  DST_LAYOUT="$LAYOUTS_DIR/${LAYOUT_NAME}.json"
  if [ -f "$DST_LAYOUT" ]; then
    cp "$DST_LAYOUT" "${DST_LAYOUT}.bak"
  fi
  python3 - "$LAYOUTS_DIR/main.json" "$DST_LAYOUT" "$REPO_ROOT/mods" "${ACTIVE_MODS[@]}" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
mods_root = Path(sys.argv[3])
active = sys.argv[4:]
active_set = set(active)

pane_mods = []
for name in active:
    mj = mods_root / name / "mod.json"
    if mj.is_file():
        try:
            meta = json.loads(mj.read_text("utf-8"))
            if meta.get("place") == "pane":
                pane_mods.append(name)
        except Exception:
            pass

data = json.loads(src.read_text("utf-8"))

def patch_layout(node):
    if isinstance(node, dict):
        if "agents-agy" in active_set and node.get("id") == "agents" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "agents-agy"
        if "workspace-status-agy" in active_set and node.get("id") == "status" and isinstance(node.get("content"), dict):
            node["content"]["mod"] = "workspace-status-agy"
        if node.get("id") == "panel-body" and isinstance(node.get("children"), list):
            existing = {c.get("id") for c in node["children"] if isinstance(c, dict)}
            for pm in pane_mods:
                if pm not in existing:
                    node["children"].append({"id": pm, "type": "block", "content": {"mod": pm}})
        for v in node.values():
            patch_layout(v)
    elif isinstance(node, list):
        for item in node:
            patch_layout(item)

patch_layout(data)
dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Generated layout: {dst}")
PY
else
  echo "Note: $LAYOUTS_DIR/main.json not found; skipped ${LAYOUT_NAME}.json generation." >&2
fi
