# herdr-mods

Third-party mods and layout for [Herdr App](https://github.com/herdrdev/herdr-app) (`herdr-app`) adding **Antigravity CLI (`agy`)** Swarm/Subagent inspection and **Codex / Claude Code** quota monitoring across both local and SSH remote machines (`hc machine`).

## Included Mods

1. **`agents-agy`** (`mods/agents-agy`)
   - Extends the default `agents` sidebar with nested `└` / `├` tree rows for `agy` Swarm members (`@name`) and active Subagents.
   - Works across local (macOS `lsof`) and Linux remote (`/proc`) machines via `exec(..., { on: space.machine })`.
   - Clicking a nested row opens `agy-inspector` directly on the corresponding conversation and tab.
2. **`agy-inspector`** (`mods/agy-inspector`)
   - Overlay inspector for `agy` Swarm Roster, `Board` timeline, `Subagents` (expandable recent steps), `Transcript`, and `hc send` intervention to the bound parent `agy` PTY.
3. **`workspace-status-agy`** (`mods/workspace-status-agy`)
   - Extends the bottom status bar with remaining quota indicators for **Codex** (`rate_limits` from `~/.codex/sessions`) and **Claude Code** (5h/7d remaining % per profile, auto-discovering `~/.claude*` and `CLAUDE_CONFIG_DIR` in `.envrc` / `mise.toml`).
   - Clicking a quota indicator opens `model-usage`.
4. **`model-usage`** (`mods/model-usage`)
   - Overlay showing Codex CLI quota/session tokens and per-profile Claude Code 5h/7d quota bars, reset countdowns, and 5h/24h token usage.

## Installation

```bash
./scripts/install.sh
```

This copies the mods into `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME/mods/`), runs `herdr-app check` on each mod, and generates `~/.config/herdr-app/layouts/main-agy.json` from your existing `layouts/main.json`.

### Switching Layout & Shortcuts

- Press **`⌘ + Shift + L`** (`layout.switch`) in Herdr App and select **`main-agy`**.
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

- `HERDR_CLAUDE_OAUTH_QUOTA=0`: Disable reading local Claude Code OAuth credentials / macOS Keychain for `api.anthropic.com/api/oauth/usage` (falls back to local 24h session counts).
- Quota caches are stored per-user under `~/.cache/herdr/` (`0700` dir, `0600` files, 60s TTL).

## Verification

```bash
python3 -m unittest discover -s tests -v
```
