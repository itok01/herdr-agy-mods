import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, checking, hc, shared, setShared } from "herdr";
import {
  GUARD_KEY,
  GUARD_CACHE_KEY,
  GUARD_CMD_KEY,
  GUARD_LOCK_KEY,
  classifyPrompt,
  getEffectiveMode,
  normalizeGuardState,
  withAuditEntry,
} from "./safety.js";

const PY_STATUS_BAR = `
import hashlib, json, os, re, subprocess, sys, time, urllib.request
from datetime import datetime
from pathlib import Path

root = Path(os.environ.get("HERDR_USAGE_HOME") or Path.home())
now = time.time()

# 1. Codex rate_limits (walk YYYY/MM/DD descending to avoid scanning thousands of files)
codex_rem = None
codex_win = None
codex_rst = None
codex_stale = False
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
                rl = (json.loads(raw).get("payload") or {}).get("rate_limits")
                if not isinstance(rl, dict): continue
                best = None
                for key in ("primary", "secondary"):
                    w = rl.get(key)
                    if isinstance(w, dict) and w.get("used_percent") is not None:
                        u = float(w["used_percent"])
                        if best is None or u > best[0]:
                            best = (u, w)
                if best is not None:
                    u, w = best
                    codex_rem = round(max(0.0, 100.0 - u))
                    m = int(w.get("window_minutes") or 0)
                    codex_win = f"{m//1440}d" if m and m % 1440 == 0 else (f"{m//60}h" if m and m % 60 == 0 else "win")
                    rst_raw = w.get("resets_at")
                    try:
                        if rst_raw is not None:
                            d_sec = int(float(rst_raw) - now)
                            if d_sec < 0:
                                codex_stale = True
                            else:
                                days, r_s = divmod(d_sec, 86400)
                                hrs, r_s = divmod(r_s, 3600)
                                mins = r_s // 60
                                codex_rst = f"{days}d {hrs}h" if days > 0 else (f"{hrs}h {mins}m" if hrs > 0 else f"{mins}m")
                    except Exception: pass
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
    key = label
    n = 2
    while key in profiles:
        key = f"{label}-{n}"
        n += 1
    profiles[key] = path_obj

add_profile("default", root / ".claude")
for d in sorted(root.glob(".claude-*")):
    if d.is_dir():
        add_profile(d.name.replace(".claude-", ""), d)
seen_parents = set()
for parent_dir in [root / "Projects", root / "projects", root / "src", root / "work"]:
    if not parent_dir.is_dir(): continue
    try: prp = str(parent_dir.resolve())
    except Exception: prp = str(parent_dir)
    if prp in seen_parents: continue
    seen_parents.add(prp)
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
                        raw_p = os.path.expandvars(m.group(1).replace("{{env.HOME}}", str(root)).replace("\x24{HOME}", str(root)).replace("$HOME", str(root)))
                        raw_p = re.sub(r"^~(?=/|$)", str(root), raw_p)
                        p_obj = Path(raw_p)
                        if not p_obj.is_absolute():
                            p_obj = (cfg.parent / p_obj).resolve()
                        add_profile(sub.name, p_obj)
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

def parse_iso_ts(s):
    if not isinstance(s, str): return None
    s = re.sub(r"\\.\\d+", "", s).replace("Z", "+00:00")
    try: return datetime.fromisoformat(s).timestamp()
    except Exception: return None

def write_private_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.parent.is_symlink():
        return
    try: os.chmod(p.parent, 0o700)
    except Exception: pass
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    try:
        if tmp.exists() or tmp.is_symlink(): tmp.unlink()
    except Exception: pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(tmp, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, p)

def fetch_claude_quota(cdir):
    if "--no-oauth" in sys.argv[1:] or os.environ.get("HERDR_CLAUDE_OAUTH_QUOTA") == "0":
        return None
    cache_dir = root / ".cache/herdr"
    if cache_dir.is_symlink():
        return None
    cache_p = cache_dir / f"claude-limits-{hashlib.sha256(str(cdir).encode()).hexdigest()[:8]}.json"
    cached_list = None
    try:
        if cache_p.is_file() and not cache_p.is_symlink():
            cached_list = json.loads(cache_p.read_text("utf-8"))
            if (now - cache_p.stat().st_mtime) < 60 and isinstance(cached_list, list):
                rems = [round(float(x["remaining_percent"])) for x in cached_list if isinstance(x, dict) and x.get("remaining_percent") is not None]
                return {"rem": min(rems) if rems else None}
    except Exception:
        cached_list = None
    tok = read_claude_token(cdir)
    if not tok:
        if not cached_list:
            try: write_private_json(cache_p, [])
            except Exception: pass
        return None
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "herdr-mods/1.0"},
        )
        with urllib.request.urlopen(req, timeout=1.8) as r:
            data = json.loads(r.read().decode("utf-8"))
        limits = []
        rem_vals = []
        for k, lbl in (("five_hour", "5h"), ("seven_day", "7d")):
            w = data.get(k)
            if isinstance(w, dict) and w.get("utilization") is not None:
                u = float(w["utilization"])
                rem = round(max(0.0, 100.0 - u), 1)
                rst_ts = parse_iso_ts(w.get("resets_at"))
                rem_vals.append(round(rem))
                limits.append({"label": lbl, "used_percent": u, "remaining_percent": rem, "resets_at": rst_ts})
        try: write_private_json(cache_p, limits)
        except Exception: pass
        return {"rem": min(rem_vals) if rem_vals else None}
    except Exception:
        if isinstance(cached_list, list) and cached_list:
            rems = [round(float(x["remaining_percent"])) for x in cached_list if isinstance(x, dict) and x.get("remaining_percent") is not None]
            if rems:
                return {"rem": min(rems), "stale": True}
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
    "codex_rst": codex_rst,
    "codex_stale": codex_stale,
    "claude_counts": claude_counts,
    "claude_quotas": claude_quotas,
}, ensure_ascii=False))
`;

export default class WorkspaceStatusAgy extends View {
  init(_props, cx) {
    this.usageByMachine = {};
    this.lastMachine = undefined;
    this.loadingMachines = new Set();
    this.guardTickRunning = false;
    this.guardCooldown = new Map();
    if (!checking()) {
      this.refresh(cx);
      cx.timer.every(15000, (c) => this.refresh(c));
      cx.timer.every(2000, (c) => this.tickApproveGuard(c));
    }
  }

  acquireLock(addr, ttlMs = 10000) {
    const now = Date.now();
    const locks = { ...(shared(GUARD_LOCK_KEY) || {}) };
    if ((locks[addr] || 0) > now) return false;
    locks[addr] = now + ttlMs;
    setShared(GUARD_LOCK_KEY, locks);
    return true;
  }

  releaseLock(addr) {
    const locks = { ...(shared(GUARD_LOCK_KEY) || {}) };
    if (addr in locks) {
      delete locks[addr];
      setShared(GUARD_LOCK_KEY, locks);
    }
  }

  async inspectAddress(addr) {
    try {
      const res = await hc(["read", addr]);
      if (res.code !== 0) {
        return { verdict: "review", reason: `hc read failed (exit ${res.code})`, snippet: "" };
      }
      return classifyPrompt(res.stdout || "");
    } catch (e) {
      return { verdict: "review", reason: `hc read error: ${String(e)}`, snippet: "" };
    }
  }

  async approveIfVerified(a, allowUnsafe = false) {
    if (!this.acquireLock(a.address)) return false;
    try {
      const info = await this.inspectAddress(a.address);
      const label = a.title || a.program?.name || a.address;
      if (info.verdict !== "safe" && !allowUnsafe) {
        setShared(GUARD_KEY, withAuditEntry(shared(GUARD_KEY), {
          address: a.address,
          label,
          action: "skipped",
          verdict: info.verdict,
          reason: info.reason,
        }));
        return false;
      }

      // Re-verify agent is still blocked and (if auto) mode is still safe right before sending keys.
      const stillBlocked = agents().some((x) => x.address === a.address && x.status === "blocked");
      if (!stillBlocked) return false;
      if (!allowUnsafe) {
        const curState = normalizeGuardState(shared(GUARD_KEY));
        if (getEffectiveMode(curState, a.address) !== "safe") return false;
      }

      const key = info.approveKey === "ctrl+k" ? "ctrl+k" : "enter";
      const sent = await hc(["keys", a.address, key]);
      if (sent.code === 0) {
        setShared(GUARD_KEY, withAuditEntry(shared(GUARD_KEY), {
          address: a.address,
          label,
          action: "approved",
          verdict: info.verdict,
          reason: `[${key}] ${info.reason}`,
        }));
        return true;
      }
      return false;
    } finally {
      this.releaseLock(a.address);
    }
  }

  async tickApproveGuard(cx) {
    if (checking() || this.guardTickRunning) return;
    this.guardTickRunning = true;
    try {
      const blocked = agents().filter((a) => a.status === "blocked");
      const blockedSet = new Set(blocked.map((a) => a.address));
      for (const k of this.guardCooldown.keys()) {
        if (!blockedSet.has(k)) this.guardCooldown.delete(k);
      }

      // Handle explicit command requests from sidebar or Approve Guard overlay
      const cmd = shared(GUARD_CMD_KEY);
      if (cmd && cmd.op) {
        setShared(GUARD_CMD_KEY, null);
        if (cmd.op === "approve_safe" && cmd.address) {
          const target = blocked.find((a) => a.address === cmd.address);
          if (target) {
            const info = await this.inspectAddress(target.address);
            if (info.verdict === "safe") {
              await this.approveIfVerified(target, true);
            } else {
              run("mod.open", { name: "approve-guard" });
            }
          }
        } else if (cmd.op === "approve_all_safe") {
          for (const a of blocked) {
            const info = await this.inspectAddress(a.address);
            if (info.verdict === "safe") {
              await this.approveIfVerified(a, true);
            }
          }
        }
      }

      if (!blocked.length) {
        if (Object.keys(shared(GUARD_CACHE_KEY) || {}).length > 0) {
          setShared(GUARD_CACHE_KEY, {});
        }
        return;
      }

      const state = normalizeGuardState(shared(GUARD_KEY));
      const hasAnySafe = state.mode === "safe" || Object.values(state.agents).some((v) => v === "safe");
      const forceInspect = cmd?.op === "refresh";
      if (!hasAnySafe && !forceInspect) return;

      const cache = { ...(shared(GUARD_CACHE_KEY) || {}) };
      let cacheChanged = false;
      for (const k of Object.keys(cache)) {
        if (!blockedSet.has(k)) {
          delete cache[k];
          cacheChanged = true;
        }
      }

      for (const a of blocked) {
        const now = Date.now();
        if (!forceInspect && now - (this.guardCooldown.get(a.address) ?? 0) < 8000) continue;
        this.guardCooldown.set(a.address, now);

        const info = await this.inspectAddress(a.address);
        const prev = cache[a.address];
        if (!prev || prev.verdict !== info.verdict || prev.reason !== info.reason || prev.snippet !== info.snippet) {
          cache[a.address] = { ...info, ts: now };
          cacheChanged = true;
        }

        if (getEffectiveMode(state, a.address) === "safe") {
          await this.approveIfVerified(a, false);
        }
      }

      if (cacheChanged) setShared(GUARD_CACHE_KEY, cache);
      cx.notify();
    } finally {
      this.guardTickRunning = false;
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
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", ["-c", PY_STATUS_BAR], { on, timeout: 10000 });
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
    const codexRem = u?.codex_rem;
    const codexText = codexRem != null ? `${u.codex_win || "5h"} ${codexRem}%${u.codex_stale ? " (exp)" : ""}` : null;
    const codexTip = codexRem != null
      ? `Codex ${u.codex_win || "5h"}: ${codexRem}% left${u.codex_rst ? ` (reset in ${u.codex_rst})` : ""} — click for details`
      : "Codex quota — click for details";
    const quotaEntries = Object.entries(u?.claude_quotas ?? {});
    const profEntries = Object.entries(u?.claude_counts ?? {});
    const claudeMin = quotaEntries.length ? Math.min(...quotaEntries.map(([, rem]) => Number(rem))) : null;
    const claudeLow = claudeMin != null && claudeMin <= 15;
    const claudeWarn = claudeMin != null && claudeMin <= 30;
    const fmtEntry = ([k, v], unit, onlyOne) => (onlyOne && k === "default" ? `${v}${unit}` : `${k} ${v}${unit}`);
    const claudeText = quotaEntries.length
      ? quotaEntries.map((e) => fmtEntry(e, "%", quotaEntries.length === 1)).join(" · ")
      : profEntries.length
      ? profEntries.map((e) => fmtEntry(e, " sess", profEntries.length === 1)).join(" · ")
      : null;
    const healthColor = (pct, stale) => (stale ? t.dim : pct <= 15 ? t.blocked : pct <= 30 ? t.accent : t.working);

    const guard = shared("approve.guard");
    const guardPerCount = guard?.agents ? Object.values(guard.agents).filter((v) => v === "safe").length : 0;
    const guardActive = guard?.mode === "safe" || guardPerCount > 0;
    const guardText = guard?.mode === "safe" ? "Guard: SAFE" : guardPerCount > 0 ? `Guard: ${guardPerCount} auto` : "Guard: OFF";

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
      .child(
        h_flex()
          .id("status-approve-guard")
          .gap(5)
          .items_center()
          .px(6)
          .py(1)
          .rounded(4)
          .text_color(needs > 0 ? t.blocked : guardActive ? t.working : t.dim)
          .cursor_pointer()
          .tooltip("Approve Guard — click to open permissions & audit log")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("mod.open", { name: "approve-guard" });
          })
          .child(div().size(5).rounded(3).flex_none().bg(needs > 0 ? t.blocked : guardActive ? t.working : t.dim))
          .child(guardText)
      )
      .when(Boolean(codexText), (el) =>
        el.child(
          h_flex()
            .id("status-codex-quota")
            .gap(5)
            .items_center()
            .px(6)
            .py(1)
            .rounded(4)
            .text_color(u.codex_rem <= 15 ? t.blocked : u.codex_rem <= 30 ? t.accent : t.muted)
            .cursor_pointer()
            .tooltip(codexTip)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("mod.open", { name: "model-usage" });
            })
            .child(div().size(5).rounded(3).flex_none().bg(healthColor(u.codex_rem, u.codex_stale)))
            .child(image("icons/codex.svg").w(12).h(12).flex_none())
            .child(codexText)
        )
      )
      .when(Boolean(claudeText), (el) =>
        el.child(
          h_flex()
            .id("status-claude-quota")
            .gap(5)
            .items_center()
            .px(6)
            .py(1)
            .rounded(4)
            .text_color(claudeLow ? t.blocked : claudeWarn ? t.accent : t.muted)
            .cursor_pointer()
            .tooltip("Claude Code quota — click for details")
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("mod.open", { name: "model-usage" });
            })
            .when(claudeMin != null, (e) => e.child(div().size(5).rounded(3).flex_none().bg(healthColor(claudeMin, false))))
            .child(image("icons/claude.svg").w(12).h(12).flex_none())
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
