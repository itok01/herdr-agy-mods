# herdr-mods

Third-party mods and layout for [Herdr App](https://github.com/herdrdev/herdr-app) (`herdr-app`) adding **Antigravity CLI (`agy`)** Swarm/Subagent inspection and **Codex / Claude Code** quota monitoring across both local and SSH remote machines (`hc machine`).

## Included Mods

1. **`agents-agy`** (`mods/agents-agy`)
   - Extends the default `agents` sidebar with nested `└` / `├` tree rows for `agy` Swarm members (`@name`) and active Subagents.
   - Works across local (macOS `lsof`) and Linux remote (`/proc`) machines via `exec(..., { on: space.machine })`.
   - Clicking a nested row opens `agy-inspector` directly on the corresponding conversation and tab.
2. **`agy-inspector`** (`mods/agy-inspector`)
   - Overlay inspector for `agy` Swarm Roster, `Board` timeline, `Subagents` (expandable recent steps), `Transcript`, `Focus PTY` button, and `hc send --` intervention to the bound parent `agy` PTY.
   - Keyboard shortcuts (when not typing in the input): `1` / `2` / `3` to switch tabs, `r` to refresh, `Esc` to close.
3. **`workspace-status-agy`** (`mods/workspace-status-agy`)
   - Extends the bottom status bar with remaining quota indicators for **Codex** (`rate_limits` from `~/.codex/sessions`) and **Claude Code** (5h/7d remaining % per profile, auto-discovering `~/.claude*` and `CLAUDE_CONFIG_DIR` in `.envrc` / `mise.toml`).
   - Clicking a quota indicator opens `model-usage`.
4. **`model-usage`** (`mods/model-usage`)
   - Overlay showing Codex CLI quota/session tokens and per-profile Claude Code 5h/7d quota bars, reset countdowns, and 5h/24h token usage.
   - Keyboard shortcuts: `r` to refresh, `Esc` to close.

## Requirements

- **Herdr App** (`herdr-app` in `PATH` for `herdr-app check` during installation)
- **`python3`** on the local machine and any SSH remote machine (`hc machine`)
- **`pgrep` + `lsof`** on macOS (or `/proc` on Linux) for live `agy` process detection

## Installation

Run `./scripts/install.sh` (interactive menu when run in a terminal), or pass bundles / individual mod names directly:

```bash
# List all available mods and bundles
./scripts/install.sh --list

# Install everything (default in non-interactive mode -> layouts/main-agy.json)
./scripts/install.sh all

# Install only Codex / Claude quota & usage mods (-> layouts/main-usage.json)
./scripts/install.sh usage

# Install only Antigravity (agy) Swarm / Subagent mods (-> layouts/main-agy.json)
./scripts/install.sh agy

# Install specific individual mod(s)
./scripts/install.sh model-usage workspace-status-agy
```

The installer stages and validates the selected mods with `herdr-app check` before copying them into `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME/mods/`), backs up any existing target layout to `.bak`, and generates the layout from `layouts/main.json` (override with `--layout <name>`).

### Switching Layout & Shortcuts

- Press **`⌘ + Shift + L`** (`layout.switch`) in Herdr App and select **`main-agy`** (or **`main-usage`** if you installed `usage`).
- Optional global shortcuts in `~/.config/herdr-app/keys.json`:
  ```json
  {
    "global": {
      "cmd-shift-a": "mod.open:agy-inspector",
      "cmd-shift-u": "mod.open:model-usage"
    }
  }
  ```

### Privacy & Environment Options

- By default, `workspace-status-agy` and `model-usage` read local Claude Code OAuth credentials (`.credentials.json` or macOS Keychain) and send a bearer request to `https://api.anthropic.com/api/oauth/usage` (on both local and SSH remote machines) to display 5h/7d remaining percentages.
- Set `HERDR_CLAUDE_OAUTH_QUOTA=0` to disable OAuth quota queries and fall back to local 24h session counts.
- Quota caches are shared under `~/.cache/herdr/` (`0700` dir, `0600` files, 60s TTL, `O_NOFOLLOW`) and store only percentages/timestamps (never tokens).

### Uninstall

Switch back to the `main` layout (`⌘ + Shift + L`) and run:

```bash
./scripts/install.sh --uninstall
```

(This removes installed mods and generated `main-agy.json` / `main-usage.json` / `*.bak` layouts. Optionally remove cached quota files with `rm -rf ~/.cache/herdr`.)

## Verification

```bash
python3 -m unittest discover -s tests -v
```
