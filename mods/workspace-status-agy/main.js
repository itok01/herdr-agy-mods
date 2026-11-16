import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, checking } from "herdr";

const PY_STATUS_BAR = `
import hashlib, json, os, re, subprocess, sys, time, urllib.request
from datetime import datetime
from pathlib import Path

root = Path.home()
now = time.time()
active_folder = sys.argv[1] if len(sys.argv) > 1 else ""

# 1. Codex rate_limits (walk YYYY/MM/DD descending to avoid scanning thousands of files)
codex_rem = None
codex_win = None
sessions_dir = root / ".codex/sessions"
if sessions_dir.is_dir():
    latest_files = []
    for y in sorted(sessions_dir.iterdir(), reverse=True):
        if not y.is_dir(): continue
        for m in sorted(y.iterdir(), reverse=True):
            if not m.is_dir(): continue
            for d in sorted(m.iterdir(), reverse=True):
                if not d.is_dir(): continue
                files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
                latest_files.extend(files[:3])
                if len(latest_files) >= 3: break
            if len(latest_files) >= 3: break
        if len(latest_files) >= 3: break
    for f in latest_files[:3]:
        try: lines = f.read_text("utf-8", errors="replace").splitlines()
        except Exception: continue
        for raw in reversed(lines):
            if "rate_limits" not in raw: continue
            try:
                rl = (json.loads(raw).get("payload") or {}).get("rate_limits") or {}
                w = rl.get("primary") or rl.get("secondary")
                if isinstance(w, dict) and "used_percent" in w:
                    codex_rem = round(max(0.0, 100.0 - float(w["used_percent"])))
                    m = int(w.get("window_minutes") or 0)
                    codex_win = f"{m//1440}d" if m and m % 1440 == 0 else (f"{m//60}h" if m and m % 60 == 0 else "win")
                    break
            except Exception: continue
        if codex_rem is not None: break

# 2. Claude multi-profile detection (~/.claude*, .envrc / mise.toml CLAUDE_CONFIG_DIR)
profiles = {}
seen_paths = set()
def add_profile(label, path_obj):
    if not path_obj.is_dir(): return
    try: rp = str(path_obj.resolve())
    except Exception: rp = str(path_obj)
    if rp in seen_paths: return
    seen_paths.add(rp)
    profiles[label] = path_obj

add_profile("default", root / ".claude")
for d in sorted(root.glob(".claude-*")):
    if d.is_dir():
        add_profile(d.name.replace(".claude-", ""), d)
for parent_dir in [root / "Projects", root / "projects", root / "src", root / "work"]:
    if not parent_dir.is_dir(): continue
    for sub in sorted(parent_dir.iterdir()):
        if not sub.is_dir(): continue
        cfg_files = [sub / "mise.toml", sub / ".envrc", *list(sub.glob("*/.envrc"))[:10], *list(sub.glob("*/mise.toml"))[:10]]
        for cfg in cfg_files:
            if not cfg.is_file(): continue
            try:
                for line in cfg.read_text("utf-8", errors="replace").splitlines():
                    sline = line.strip()
                    if not sline or sline.startswith("#"): continue
                    m = re.search(r"CLAUDE_CONFIG_DIR\\s*=\\s*[\\x22\\x27]?([^\\s\\x22\\x27#]+)", sline)
                    if m:
                        raw_p = m.group(1).replace("{{env.HOME}}", str(root)).replace("\x24{HOME}", str(root)).replace("$HOME", str(root))
                        raw_p = re.sub(r"^~(?=/|$)", str(root), raw_p)
                        add_profile(sub.name, Path(raw_p))
            except Exception: pass

def read_claude_token(cdir):
    cred_file = cdir / ".credentials.json"
    if cred_file.is_file():
        try:
            tok = (json.loads(cred_file.read_text("utf-8")).get("claudeAiOauth") or {}).get("accessToken")
            if tok: return tok
        except Exception: pass
    if sys.platform == "darwin":
        try: is_def = cdir.resolve() == (root / ".claude").resolve()
        except Exception: is_def = (cdir == root / ".claude")
        svce = "Claude Code-credentials" if is_def else f"Claude Code-credentials-{hashlib.sha256(str(cdir).encode()).hexdigest()[:8]}"
        try:
            raw = subprocess.check_output(["security", "find-generic-password", "-s", svce, "-w"], text=True, timeout=1.5, stderr=subprocess.DEVNULL).strip()
            tok = (json.loads(raw).get("claudeAiOauth") or {}).get("accessToken")
            if tok: return tok
        except Exception: pass
    return None

def write_private_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    try: os.chmod(p.parent, 0o700)
    except Exception: pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(p, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f)

def fetch_claude_quota(cdir):
    if os.environ.get("HERDR_CLAUDE_OAUTH_QUOTA") == "0":
        return None
    cache_dir = root / ".cache/herdr"
    cache_p = cache_dir / f"claude-quota-{hashlib.sha256(str(cdir).encode()).hexdigest()[:8]}.json"
    try:
        if cache_p.is_file() and not cache_p.is_symlink() and (now - cache_p.stat().st_mtime) < 60:
            return json.loads(cache_p.read_text("utf-8"))
    except Exception: pass
    tok = read_claude_token(cdir)
    if not tok:
        try: write_private_json(cache_p, {"rem": None})
        except Exception: pass
        return None
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.0"},
        )
        with urllib.request.urlopen(req, timeout=2.5) as r:
            data = json.loads(r.read().decode("utf-8"))
        rem_vals = []
        for k in ("five_hour", "seven_day"):
            w = data.get(k)
            if isinstance(w, dict) and w.get("utilization") is not None:
                rem_vals.append(round(max(0.0, 100.0 - float(w["utilization"]))))
        out = {"rem": min(rem_vals) if rem_vals else None}
        try: write_private_json(cache_p, out)
        except Exception: pass
        return out
    except Exception:
        try: write_private_json(cache_p, {"rem": None})
        except Exception: pass
        return None

claude_counts = {}
claude_quotas = {}
for label, cdir in profiles.items():
    cnt = 0
    proj = cdir / "projects"
    if proj.is_dir():
        for sub in proj.iterdir():
            if not sub.is_dir(): continue
            for jf in sub.glob("*.jsonl"):
                try:
                    if (now - jf.stat().st_mtime) <= 86400:
                        cnt += 1
                except Exception: pass
    q = fetch_claude_quota(cdir)
    if q and q.get("rem") is not None:
        claude_quotas[label] = q["rem"]
    if cnt > 0 or label != "default":
        claude_counts[label] = cnt

print(json.dumps({
    "codex_rem": codex_rem,
    "codex_win": codex_win,
    "claude_counts": claude_counts,
    "claude_quotas": claude_quotas,
}, ensure_ascii=False))
`;

export default class WorkspaceStatusAgy extends View {
  init(_props, cx) {
    this.usageByMachine = {};
    this.lastMachine = undefined;
    this.loadingMachines = new Set();
    if (!checking()) {
      this.refresh(cx);
      cx.timer.every(15000, (cx) => this.refresh(cx));
    }
  }

  refresh(cx) {
    if (checking()) return;
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const mk = on ?? "";
    this.lastMachine = on;
    if (this.loadingMachines.has(mk)) return;
    this.loadingMachines.add(mk);
    const folder = space?.folder ?? "";
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", ["-c", PY_STATUS_BAR, folder], { on, timeout: 6000 });
        if (res.code === 0) this.usageByMachine[mk] = JSON.parse(res.stdout);
      } catch {
        // Ignore transient status poll failure
      } finally {
        this.loadingMachines.delete(mk);
        cx.notify();
      }
    });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const curMachine = space?.machine ?? null;
    if (!checking() && this.lastMachine !== undefined && curMachine !== this.lastMachine) {
      this.refresh(cx);
    }
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);

    const u = this.usageByMachine[curMachine ?? ""];
    const codexText = u?.codex_rem != null ? `Codex ${u.codex_win || ""} ${u.codex_rem}%` : null;
    const quotaEntries = Object.entries(u?.claude_quotas ?? {});
    const profEntries = Object.entries(u?.claude_counts ?? {});
    const claudeLow = quotaEntries.some(([, rem]) => Number(rem) <= 15);
    const claudeText = quotaEntries.length
      ? `Claude [${quotaEntries.map(([k, v]) => `${k}:${v}%`).join(" ")}]`
      : profEntries.length
      ? `Claude [${profEntries.map(([k, v]) => `${k}:${v}`).join(" ")}]`
      : null;

    return h_flex()
      .size_full()
      .px(14)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`)))
      )
      .child(div().flex_1())
      .when(Boolean(codexText), (el) =>
        el.child(
          div()
            .id("status-codex-quota")
            .px(5)
            .py(1)
            .rounded(4)
            .text_color(u.codex_rem <= 15 ? t.blocked : t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("mod.open", { name: "model-usage" });
            })
            .child(codexText)
        )
      )
      .when(Boolean(claudeText), (el) =>
        el.child(
          div()
            .id("status-claude-quota")
            .px(5)
            .py(1)
            .rounded(4)
            .text_color(claudeLow ? t.blocked : t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("mod.open", { name: "model-usage" });
            })
            .child(claudeText)
        )
      )
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("app.palette");
          })
          .child(this.hint())
      );
  }
}
