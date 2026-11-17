import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, exec, theme, checking, closeOverlay } from "herdr";

const PY_USAGE = `
import hashlib, json, os, re, subprocess, sys, time, urllib.request
from datetime import datetime
from pathlib import Path

def read_json(p):
    try: return json.loads(p.read_text("utf-8"))
    except Exception: return None

def fmt_win(m):
    if not m: return "win"
    m = int(m)
    if m % 1440 == 0: return f"{m // 1440}d"
    if m % 60 == 0: return f"{m // 60}h"
    return f"{m}m"

def fmt_rst(ts, now):
    if not ts: return "-"
    d = max(0, int(ts - now))
    days, rem = divmod(d, 86400)
    hrs, rem = divmod(rem, 3600)
    mins = rem // 60
    if days > 0: return f"{days}d {hrs}h"
    if hrs > 0: return f"{hrs}h {mins}m"
    return f"{mins}m"

root = Path(os.environ.get("HERDR_USAGE_HOME") or Path.home())
now = time.time()

codex_dir = root / ".codex"
codex = {"installed": codex_dir.is_dir(), "plan_type": None, "rate_limits": [], "tokens": None}
if (codex_dir / "sessions").is_dir():
    files = []
    for y in sorted((codex_dir / "sessions").iterdir(), reverse=True):
        if not y.is_dir(): continue
        for m in sorted(y.iterdir(), reverse=True):
            if not m.is_dir(): continue
            for d in sorted(m.iterdir(), reverse=True):
                if not d.is_dir(): continue
                files.extend(sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:5])
                if len(files) >= 5: break
            if len(files) >= 5: break
        if len(files) >= 5: break
    for f in files[:5]:
        try: lines = f.read_text("utf-8", errors="replace").splitlines()
        except Exception: continue
        for raw in reversed(lines):
            if "rate_limits" not in raw and "total_token_usage" not in raw: continue
            try: obj = json.loads(raw)
            except Exception: continue
            pl = obj.get("payload") or {}
            if not isinstance(pl, dict): continue
            info = pl.get("info") or {}
            if codex["tokens"] is None and isinstance(info, dict) and isinstance(info.get("total_token_usage"), dict):
                tu = info["total_token_usage"]
                codex["tokens"] = {"input": tu.get("input_tokens", 0), "cached": tu.get("cached_input_tokens", 0), "output": tu.get("output_tokens", 0), "total": tu.get("total_tokens", 0)}
            rl = pl.get("rate_limits")
            if not codex["rate_limits"] and isinstance(rl, dict):
                codex["plan_type"] = rl.get("plan_type")
                for k in ("primary", "secondary"):
                    w = rl.get(k)
                    if isinstance(w, dict) and w.get("used_percent") is not None:
                        try: u = float(w["used_percent"])
                        except Exception: continue
                        rst_raw = w.get("resets_at")
                        rst_ts = None
                        try: rst_ts = float(rst_raw) if rst_raw is not None else None
                        except Exception: rst_ts = parse_iso_ts(rst_raw) if isinstance(rst_raw, str) else None
                        expired = bool(rst_ts is not None and rst_ts < now)
                        codex["rate_limits"].append({
                            "label": fmt_win(w.get("window_minutes")),
                            "used_percent": u,
                            "remaining_percent": round(max(0.0, 100.0 - u), 1),
                            "reset_in": "expired" if expired else fmt_rst(rst_ts, now),
                            "stale": expired,
                        })
            if codex["rate_limits"] and codex["tokens"]: break
        if codex["rate_limits"] and codex["tokens"]: break

def parse_iso_ts(s):
    if not isinstance(s, str): return None
    s = re.sub(r"\\.\\d+", "", s).replace("Z", "+00:00")
    try: return datetime.fromisoformat(s).timestamp()
    except Exception: return None

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
        for cfg in [sub / "mise.toml", sub / ".envrc", *list(sub.glob("*/.envrc"))[:10], *list(sub.glob("*/mise.toml"))[:10]]:
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

def fetch_claude_limits(cdir):
    if "--no-oauth" in sys.argv[1:] or os.environ.get("HERDR_CLAUDE_OAUTH_QUOTA") == "0":
        return []
    cache_dir = root / ".cache/herdr"
    cache_p = cache_dir / f"claude-limits-{hashlib.sha256(str(cdir).encode()).hexdigest()[:8]}.json"
    cached_data = None
    try:
        if cache_p.is_file() and not cache_p.is_symlink():
            cached_data = json.loads(cache_p.read_text("utf-8"))
            if (now - cache_p.stat().st_mtime) < 60 and isinstance(cached_data, list):
                return cached_data
    except Exception:
        cached_data = None
    tok = read_claude_token(cdir)
    if not tok:
        return []
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "herdr-mods/1.0"},
        )
        with urllib.request.urlopen(req, timeout=1.8) as r:
            data = json.loads(r.read().decode("utf-8"))
        limits = []
        for k, lbl in (("five_hour", "5h"), ("seven_day", "7d")):
            w = data.get(k)
            if isinstance(w, dict) and w.get("utilization") is not None:
                u = float(w["utilization"])
                rst_ts = parse_iso_ts(w.get("resets_at"))
                limits.append({"label": lbl, "used_percent": u, "remaining_percent": round(max(0.0, 100.0 - u), 1), "reset_in": fmt_rst(rst_ts, now)})
        try: write_private_json(cache_p, limits)
        except Exception: pass
        return limits
    except Exception:
        if isinstance(cached_data, list) and cached_data:
            return [{**item, "stale": True} for item in cached_data if isinstance(item, dict)]
        return []

claude_profiles = {}
claude_24h = 0
for label, cdir in profiles.items():
    cnt = 0
    tok_5h, out_5h, tok_24h, out_24h = 0, 0, 0, 0
    proj = cdir / "projects"
    if proj.is_dir():
        msg_map = {}
        anon_idx = 0
        for sub in proj.iterdir():
            if not sub.is_dir(): continue
            for p in sub.glob("*.jsonl"):
                try:
                    age = now - p.stat().st_mtime
                    if age > 86400: continue
                    cnt += 1
                    with open(p, "r", encoding="utf-8", errors="replace") as fh:
                        for raw in fh:
                            if '"usage"' not in raw: continue
                            try: obj = json.loads(raw)
                            except Exception: continue
                            if not isinstance(obj, dict): continue
                            msg = obj.get("message")
                            if not isinstance(msg, dict): continue
                            u = msg.get("usage")
                            if not isinstance(u, dict): continue
                            ts_val = parse_iso_ts(obj.get("timestamp"))
                            msg_age = (now - ts_val) if ts_val is not None else age
                            if msg_age > 86400: continue
                            tot = int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0) + int(u.get("cache_read_input_tokens") or 0)
                            out_t = int(u.get("output_tokens") or 0)
                            mid = msg.get("id")
                            if not mid:
                                anon_idx += 1
                                mid = f"anon:{p.name}:{anon_idx}"
                            prev = msg_map.get(mid)
                            if prev is None or tot >= prev[0]:
                                msg_map[mid] = (tot, out_t, msg_age <= 18000)
                except Exception: pass
        for tot, out_t, in_5h in msg_map.values():
            tok_24h += tot
            out_24h += out_t
            if in_5h:
                tok_5h += tot
                out_5h += out_t
    limits = fetch_claude_limits(cdir)
    if cnt > 0 or limits or label != "default":
        claude_profiles[label] = {"sessions": cnt, "tokens_5h": tok_5h, "output_5h": out_5h, "tokens_24h": tok_24h, "output_24h": out_24h, "rate_limits": limits}
    claude_24h += cnt
claude = {"installed": bool(profiles), "recent_24h_sessions": claude_24h, "profiles": claude_profiles}

print(json.dumps({"codex": codex, "claude": claude}, ensure_ascii=False))
`;

function activeMachine() {
  return spaces().find((s) => s.active)?.machine ?? null;
}

function fmtNum(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function barRow(label, usedPct, resetIn, t, stale = false) {
  const used = Math.min(100, Math.max(0, Number(usedPct || 0)));
  const remNum = Math.max(0, 100 - used);
  const rem = remNum.toFixed(1);
  const fillColor = stale ? t.dim : remNum <= 15 ? (t.blocked ?? t.accent) : remNum <= 30 ? (t.accent ?? t.working) : (t.working ?? t.accent);

  return v_flex()
    .w_full()
    .gap(4)
    .child(
      h_flex()
        .w_full()
        .gap(8)
        .items_center()
        .child(div().font_semibold().child(label))
        .child(div().text_color(fillColor).child(`${rem}% left`))
        .child(div().text_size(11).text_color(t.dim).child(`(${used.toFixed(1)}% used)`))
        .when(stale, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("stale")))
        .child(div().flex_1())
        .when(resetIn && resetIn !== "-", (e) =>
          e.child(div().text_size(11).text_color(t.dim).child(resetIn === "expired" ? "expired" : `reset in ${resetIn}`))
        )
    )
    .child(
      h_flex()
        .w_full()
        .h(6)
        .rounded(3)
        .overflow_hidden()
        .bg(t.border)
        .when(remNum > 0, (el) => el.child(div().h_full().flex_grow(remNum).bg(fillColor)))
        .when(used > 0, (el) => el.child(div().h_full().flex_grow(used)))
    );
}

export default class ModelUsage extends View {
  init(_props, cx) {
    this.dataByMachine = {};
    this.errorByMachine = {};
    this.loadingMachines = new Set();
    this.reqSeqByMachine = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (checking()) return;
    const on = activeMachine();
    const mk = on ?? "";
    if (this.loadingMachines.has(mk)) return;
    this.loadingMachines.add(mk);
    const seq = (this.reqSeqByMachine[mk] = (this.reqSeqByMachine[mk] ?? 0) + 1);
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", ["-c", PY_USAGE], { on, timeout: 10000 });
        if (seq !== this.reqSeqByMachine[mk]) return;
        if (res.code === 0) {
          this.dataByMachine[mk] = JSON.parse(res.stdout);
          this.errorByMachine[mk] = null;
        } else {
          const lines = String(res.stderr || "").trim().split(/\r?\n/).filter(Boolean);
          this.errorByMachine[mk] = (lines.pop() || `exit ${res.code}`).slice(0, 140);
        }
      } catch (e) {
        if (seq === this.reqSeqByMachine[mk]) this.errorByMachine[mk] = String(e).slice(0, 140);
      } finally {
        this.loadingMachines.delete(mk);
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const on = activeMachine();
    const mk = on ?? "";
    const machineLabel = on ?? "local";
    const data = this.dataByMachine[mk];
    const err = this.errorByMachine[mk];
    const isLoading = this.loadingMachines.has(mk);
    if (!checking() && data === undefined && !isLoading && err === undefined) {
      this.refresh(cx);
    }
    const codex = data?.codex;
    const claude = data?.claude;

    return v_flex()
      .id("model-usage")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.popover ?? t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay();
          cx.stop_propagation();
        } else if (e.key === "r") {
          this.refresh(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(44)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/model-usage/gauge.svg").size(15).flex_none().text_color(t.accent))
          .child(div().font_semibold().child("Model Usage & Quota"))
          .child(
            div()
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(t.dim)
              .child(machineLabel)
          )
          .child(div().flex_1())
          .child(
            h_flex()
              .id("refresh-usage")
              .gap(5)
              .items_center()
              .px(8)
              .py(4)
              .rounded(7)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11.5)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.refresh(cx);
              })
              .child(
                isLoading
                  ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
                  : svg("mods/model-usage/refresh.svg").size(12).flex_none()
              )
              .child("Refresh")
          )
          .child(
            div()
              .id("close-usage")
              .p(4)
              .rounded(6)
              .text_color(t.dim)
              .cursor_pointer()
              .tooltip("Close (Esc)")
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                closeOverlay();
              })
              .child(svg("mods/workspace-chrome/x.svg").size(13).flex_none())
          )
      )
      .when(Boolean(err), (e) =>
        e.child(div().px(12).py(6).text_size(11).text_color(t.blocked ?? t.accent).child(`Error: ${err}`))
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("usage-scroll")
              .flex_1()
              .min_h(0)
              .overflow_y_scrollbar()
              .mode("always")
              .p(10)
              .gap(8)
              .when(Boolean(codex), (e) =>
                e.child(
                  v_flex()
                    .w_full()
                    .p(11)
                    .gap(7)
                    .rounded(8)
                    .bg(t.surface ?? t.raised)
                    .border_1()
                    .border_color(t.border)
                    .child(
                      h_flex()
                        .w_full()
                        .gap(7)
                        .items_center()
                        .child(image("icons/codex.svg").w(15).h(15).flex_none())
                        .child(div().font_semibold().child(`Codex CLI ${codex.plan_type ? `(${codex.plan_type})` : ""}`))
                        .child(div().flex_1())
                        .when(Boolean(codex.tokens), (el) =>
                          el.child(div().text_size(11).text_color(t.dim).child(`session total: ${fmtNum(codex.tokens.total)} tok (out ${fmtNum(codex.tokens.output)})`))
                        )
                    )
                    .children(
                      (codex.rate_limits ?? []).length
                        ? codex.rate_limits.map((r) => barRow(`Quota ${r.label}`, r.used_percent, r.reset_in, t, Boolean(r.stale)))
                        : [div().text_size(11).text_color(t.dim).child(codex.installed ? "No rate_limits telemetry in recent sessions." : "Not installed")]
                    )
                )
              )
              .when(Boolean(claude), (e) => {
                const profEntries = Object.entries(claude.profiles ?? {});
                return e.child(
                  v_flex()
                    .w_full()
                    .p(11)
                    .gap(6)
                    .rounded(8)
                    .bg(t.surface ?? t.raised)
                    .border_1()
                    .border_color(t.border)
                    .child(
                      h_flex()
                        .w_full()
                        .gap(7)
                        .items_center()
                        .child(image("icons/claude.svg").w(15).h(15).flex_none())
                        .child(div().font_semibold().child("Claude Code"))
                    )
                    .child(div().text_size(11.5).text_color(t.dim).child(claude.installed ? `24h active session files: ${claude.recent_24h_sessions}` : "Not installed"))
                    .children(
                      profEntries.map(([name, info]) => {
                        const isObj = info && typeof info === "object";
                        const line = isObj
                          ? `${name}: ${info.sessions} sess | 5h ${fmtNum(info.tokens_5h)} tok (out ${fmtNum(info.output_5h)}) | 24h ${fmtNum(info.tokens_24h)} tok`
                          : `${name}: ${info} sess`;
                        const rls = isObj ? (info.rate_limits ?? []) : [];
                        return v_flex()
                          .w_full()
                          .gap(3)
                          .pt(4)
                          .child(div().text_size(11).text_color(t.foreground).child(line))
                          .children(rls.map((r) => barRow(`${name} ${r.label}`, r.used_percent, r.reset_in, t, Boolean(r.stale))));
                      })
                    )
                );
              })
          )
      );
  }
}
