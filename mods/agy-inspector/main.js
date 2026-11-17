import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, hc, theme, checking, shared, setShared, props, closeOverlay, run } from "herdr";

const PY_INSPECT = `
import json, os, re, subprocess, sys
from pathlib import Path

def live_agy_set():
    uuid_re = re.compile(r"(?:presence|conversations)/([0-9a-f-]{36})\\.(?:lock|db)$")
    res_set = set()
    proc_dir = Path("/proc")
    if proc_dir.is_dir():
        for p in proc_dir.iterdir():
            if not p.name.isdigit(): continue
            try:
                if (p / "comm").read_text("utf-8", errors="replace").strip() != "agy": continue
                for fd in (p / "fd").iterdir():
                    try:
                        m = uuid_re.search(os.readlink(fd))
                        if m: res_set.add(m.group(1))
                    except Exception: pass
            except Exception: pass
        return res_set
    try:
        pids = subprocess.check_output(["pgrep", "-x", "agy"], text=True, timeout=1.5).split()
        if pids:
            out = subprocess.check_output(["lsof", "-a", "-p", ",".join(pids), "-Fn"], text=True, timeout=2.0)
            for line in out.splitlines():
                if line.startswith("n"):
                    m = uuid_re.search(line[1:])
                    if m: res_set.add(m.group(1))
    except Exception:
        pass
    return res_set

def read_json(p):
    try: return json.loads(p.read_text("utf-8"))
    except Exception: return None

def is_safe_id(val):
    return bool(val) and "/" not in val and "\\\\" not in val and ".." not in val

def tail_jsonl(p, limit=30):
    if not p.is_file(): return []
    out = []
    try:
        with open(p, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 131072))
            raw = f.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    for line in raw.splitlines()[-limit:]:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict): out.append(obj)
        except Exception: pass
    return out

def sum_step(s):
    tools = [str(tc.get("name")) for tc in (s.get("tool_calls") or []) if isinstance(tc, dict) and tc.get("name")]
    full = str(s.get("content") or "").strip()
    clean = re.sub(r"<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>", "", full)
    clean = re.sub(r"</?USER_REQUEST>", "", clean)
    clean = re.sub(r"(?:Created|Completed) At:\s*\S+(?:\s*Command exited with code \d+\.?)?", "", clean)
    prev = " ".join(clean.split())
    if len(prev) > 140: prev = prev[:137] + "..."
    return {"step": s.get("step_index"), "type": s.get("type"), "status": s.get("status"), "tools": tools, "preview": prev, "full": full[:1500]}

env_brain = os.environ.get("AGY_BRAIN_ROOT")
brain = Path(env_brain) if env_brain else (Path.home() / ".gemini/antigravity-cli/brain")
agy_root = brain.parent
sel = sys.argv[1] if len(sys.argv) > 1 and is_safe_id(sys.argv[1]) else None
if not brain.is_dir():
    print(json.dumps({"conversations": [], "selected": None}))
    sys.exit(0)

live_agy = live_agy_set()
all_dirs = [d for d in brain.iterdir() if d.is_dir() and (d / ".system_generated").is_dir()]
all_dirs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
live_dirs = [d for d in all_dirs if d.name in live_agy]
rest_dirs = [d for d in all_dirs if d.name not in live_agy]
candidates = (live_dirs + rest_dirs)[:15]
if sel:
    sel_dir = brain / sel
    if sel_dir.is_dir() and sel_dir not in candidates:
        candidates = [sel_dir] + candidates[:14]

items = []
for d in candidates:
    sg = d / ".system_generated"
    mem_raw = read_json(sg / "swarm/members.json")
    if not isinstance(mem_raw, dict):
        mem_raw = {}
    board = tail_jsonl(sg / "swarm/board.jsonl", 40)
    steps = tail_jsonl(sg / "logs/transcript.jsonl", 20)
    active_lock = d.name in live_agy
    subs = []
    if (sg / "subagents").is_dir():
        for sp in sorted((sg / "subagents").glob("*.json")):
            sd = read_json(sp)
            if not isinstance(sd, dict):
                continue
            desc = sd.get("subagentDescriptor")
            if not isinstance(desc, dict):
                desc = {}
            sid = str(sd.get("conversationId") or sp.stem)
            sub_tr = brain / sid / ".system_generated/logs/transcript.jsonl" if is_safe_id(sid) else None
            sub_steps = tail_jsonl(sub_tr, 5) if sub_tr else []
            raw_sub_st = str(sd.get("state") or "").upper()
            eff_state = sd.get("state")
            if "ALIVE" in raw_sub_st and sub_tr and sub_tr.is_file():
                try:
                    import time as _time
                    if (_time.time() - sub_tr.stat().st_mtime) > 300:
                        eff_state = "waiting"
                    elif sub_steps:
                        ls = sub_steps[-1]
                        if ls.get("type") == "PLANNER_RESPONSE" and ls.get("status") == "DONE" and not ls.get("tool_calls"):
                            eff_state = "waiting"
                except Exception:
                    pass
            subs.append({
                "conversation_id": sid,
                "role": desc.get("role") or sd.get("role"),
                "type_name": desc.get("typeName") or sd.get("typeName"),
                "state": eff_state,
                "recent_steps": [sum_step(x) for x in sub_steps],
            })
    members = []
    for name, info in (mem_raw.get("members") or {}).items():
        if not isinstance(info, dict): continue
        members.append({
            "name": name,
            "role": info.get("role"),
            "model": info.get("applied_model") or info.get("desired_model"),
            "phase": info.get("phase"),
            "wake_mode": info.get("wake_mode"),
            "last_read_seq": info.get("last_read_seq"),
            "killed": bool(info.get("killed", False)),
        })
    if not (members or subs or board) and d.name != sel:
        continue
    mtime = d.stat().st_mtime
    for c in (sg / "logs/transcript.jsonl", sg / "swarm/board.jsonl"):
        if c.exists(): mtime = max(mtime, c.stat().st_mtime)
    items.append({
        "conversation_id": d.name,
        "active": active_lock,
        "mtime": mtime,
        "swarm_title": mem_raw.get("title"),
        "members": members,
        "board": board,
        "subagents": subs,
        "recent_steps": [sum_step(s) for s in steps],
    })

items.sort(key=lambda x: (x["active"], x["mtime"]), reverse=True)
top = items[:10]
chosen = next((x for x in items if x["conversation_id"] == sel), None) or (top[0] if top else None)
conv_list = [{"conversation_id": x["conversation_id"], "active": x["active"], "swarm_title": x["swarm_title"], "members": len(x["members"]), "subagents": len(x["subagents"])} for x in top]
print(json.dumps({"conversations": conv_list, "selected": chosen}, ensure_ascii=False))
`;

function targetAgyTerminal(boundTerminal) {
  const all = panes();
  const isLiveAgy = (term) => Boolean(term && all.some((p) => p.terminal === term && p.program?.key === "antigravity"));
  if (boundTerminal) return isLiveAgy(boundTerminal) ? boundTerminal : null;
  const f = focused();
  const focusedPane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  if (focusedPane?.terminal && focusedPane.program?.key === "antigravity") return focusedPane.terminal;
  const activeSpace = spaces().find((s) => s.active);
  const tabIds = new Set((activeSpace?.tabs ?? []).map((t) => t.id));
  const matches = all.filter((p) => p.terminal && tabIds.has(p.tab) && p.program?.key === "antigravity");
  return matches.length === 1 ? matches[0].terminal : null;
}

function shortErr(err) {
  const lines = String(err || "").trim().split(/\r?\n/);
  return (lines.filter(Boolean).pop() || "Unknown error").slice(0, 140);
}

function badgeColor(phase, killed, t) {
  if (killed) return t.dim;
  const p = String(phase || "").toLowerCase();
  if (p.includes("work") || p.includes("run")) return t.working ?? t.accent;
  if (p.includes("block") || p.includes("err")) return t.blocked ?? t.accent;
  return t.dim;
}

function statusPill(phase, killed, t) {
  const p = String(phase || "").toLowerCase();
  if (killed || p.includes("kill") || p.includes("stop")) {
    return h_flex()
      .gap(5)
      .items_center()
      .child(div().size(6).rounded(3).bg(t.dim))
      .child(div().text_size(11).text_color(t.dim).child("killed"));
  }
  if (p.includes("alive") || p.includes("work") || p.includes("run") || p.includes("active") || p.includes("progress")) {
    return h_flex()
      .gap(5)
      .items_center()
      .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
      .child(div().text_size(11).text_color(t.working).child("working"));
  }
  if (p.includes("block") || p.includes("err")) {
    return div()
      .px(6)
      .h(18)
      .rounded(5)
      .bg(t.blocked + "26")
      .text_size(10.5)
      .font_semibold()
      .text_color(t.blocked)
      .flex()
      .items_center()
      .child("Needs you");
  }
  return h_flex()
    .gap(5)
    .items_center()
    .child(div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim))
    .child(div().text_size(11).text_color(t.dim).child(phase || "waiting"));
}

export default class AgyInspector extends View {
  init(_props, cx) {
    const p = props() ?? _props ?? {};
    this.data = null;
    this.error = null;
    this.note = null;
    this.selectedId = p.conversationId ?? shared("agy.selectedConv") ?? null;
    this.initialConvId = this.selectedId;
    this.boundTerminal = p.terminal ?? null;
    this.focusedMember = p.member ? String(p.member).replace(/^@/, "") : null;
    this.machine = Object.prototype.hasOwnProperty.call(p, "machine") ? p.machine : undefined;
    this.reqSeq = 0;
    if (shared("agy.selectedConv")) setShared("agy.selectedConv", null);
    this.expandedSub = p.subagentId ?? null;
    this.focusedSub = p.subagentId ?? null;
    this.initialSubId = p.subagentId ?? null;
    this.expandedStep = null;
    this.expandedBoardSeqs = new Set();
    this.filterMemberOnly = false;
    this.showKilled = false;
    this.userPickedTab = Boolean(p.tab);
    this.tab = p.tab ?? "board";
    this.loading = false;
    this.sending = false;
    this.typing = false;
    this.message = this.focusedMember && this.boundTerminal ? `@${this.focusedMember} ` : "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Send to parent agy PTY (e.g. @worker ...)..." });
    if (this.message) this.input.set_value(this.message);
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.sendToParent(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
  }

  getMachine() {
    if (this.machine !== undefined) return this.machine;
    return spaces().find((s) => s.active)?.machine ?? null;
  }

  refresh(cx) {
    if (this.loading || checking()) return;
    this.loading = true;
    const requested = shared("agy.selectedConv");
    if (requested) {
      if (requested !== this.selectedId) this.selectedId = requested;
      setShared("agy.selectedConv", null);
    }
    const on = this.getMachine();
    const seq = ++this.reqSeq;
    const args = ["-c", PY_INSPECT];
    if (this.selectedId) args.push(this.selectedId);
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", args, { on, timeout: 8000 });
        if (seq !== this.reqSeq) return;
        if (res.code === 0) {
          this.data = JSON.parse(res.stdout);
          if (!this.selectedId && this.data?.selected?.conversation_id) {
            this.selectedId = this.data.selected.conversation_id;
          }
          const selConv = this.data?.selected;
          if (!this.userPickedTab && selConv && !(selConv.board?.length) && !(selConv.members?.length) && (selConv.subagents?.length)) {
            this.tab = "subagents";
          }
          this.error = null;
        } else {
          this.error = shortErr(res.stderr || `exit ${res.code}`);
        }
      } catch (e) {
        if (seq === this.reqSeq) this.error = shortErr(e);
      } finally {
        if (seq === this.reqSeq) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  boundTarget() {
    if (this.boundTerminal) {
      return this.selectedId === this.initialConvId ? targetAgyTerminal(this.boundTerminal) : null;
    }
    return targetAgyTerminal(null);
  }

  sendToParent(cx) {
    const text = this.message.trim();
    const target = this.boundTarget();
    if (!text || !target || this.sending || checking()) return;
    this.sending = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const res = await hc(["send", "--", target, text]);
        if (res.code === 0) {
          this.message = "";
          this.input.set_value("");
          this.note = `Sent to ${target}`;
        } else {
          this.note = shortErr(res.stderr || `hc send exit ${res.code}`);
        }
      } catch (e) {
        this.note = shortErr(e);
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const convs = this.data?.conversations ?? [];
    const sel = this.data?.selected;
    const machineLabel = this.getMachine() ?? "local";
    const target = this.boundTarget();
    const canSend = Boolean(this.message.trim() && target && !this.sending);

    return v_flex()
      .id("agy-inspector")
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
          if (this.typing) {
            this.typing = false;
            this.handle.focus();
          } else {
            closeOverlay();
          }
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (this.typing) return;
        if (e.key === "1") { this.tab = "board"; cx.notify(); }
        else if (e.key === "2") { this.tab = "subagents"; cx.notify(); }
        else if (e.key === "3") { this.tab = "transcript"; cx.notify(); }
        else if (e.key === "r") { this.refresh(cx); }
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
          .child(image("icons/antigravity.svg").w(16).h(16).flex_none())
          .child(div().font_semibold().child("Agy Inspector"))
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
          .when(Boolean(target), (e) =>
            e.child(
              div()
                .id("focus-agy-pty")
                .px(8)
                .py(4)
                .rounded(7)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(11.5)
                .text_color(t.foreground)
                .cursor_pointer()
                .tooltip(`Focus bound agy pane (${target})`)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  run("pane.focus", { terminal: target });
                  closeOverlay();
                })
                .child("Focus PTY")
            )
          )
          .child(
            h_flex()
              .id("refresh-agy")
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
                this.loading
                  ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
                  : svg("mods/agy-inspector/refresh.svg").size(12).flex_none()
              )
              .child("Refresh")
          )
          .child(
            div()
              .id("close-agy")
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
      .when(Boolean(this.error), (e) =>
        e.child(div().px(12).py(6).text_size(11).text_color(t.blocked ?? t.accent).child(`Error: ${this.error}`))
      )
      .child(
        h_flex()
          .flex_none()
          .px(10)
          .py(6)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .children(
            convs.slice(0, 4).map((c) => {
              const active = sel?.conversation_id === c.conversation_id;
              const rawTitle = c.swarm_title || c.conversation_id.slice(0, 8);
              const label = rawTitle.length > 20 ? rawTitle.slice(0, 18) + "…" : rawTitle;
              return h_flex()
                .id(`conv-${c.conversation_id}`)
                .gap(6)
                .items_center()
                .px(8)
                .py(4)
                .rounded(6)
                .border_1()
                .border_color(active ? t.accent : t.border)
                .cursor_pointer()
                .bg(active ? t.selected : t.raised)
                .text_color(active ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.selectedId = c.conversation_id;
                  this.expandedSub = null;
                  this.expandedStep = null;
                  this.refresh(cx);
                })
                .when(Boolean(c.active), (e) =>
                  e.child(div().size(6).rounded(3).flex_none().bg(t.working ?? t.accent))
                )
                .child(`${label} (${c.members}/${c.subagents})`);
            })
          )
      )
      .child(
        h_flex()
          .flex_none()
          .px(10)
          .py(5)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .children(
            (() => {
              const allSubs = sel?.subagents ?? [];
              const aliveSubs = allSubs.filter((s) => {
                const st = String(s.state || "").toLowerCase();
                return !(st.includes("kill") || st.includes("done") || st.includes("stop"));
              }).length;
              const subLabel = aliveSubs > 0 && aliveSubs < allSubs.length
                ? `Subagents (${aliveSubs}/${allSubs.length})`
                : `Subagents (${allSubs.length})`;
              return [
                ["board", "board", `Board (${sel?.board?.length ?? 0})`],
                ["subagents", "subagent", subLabel],
                ["transcript", "transcript", `Transcript (${sel?.recent_steps?.length ?? 0})`],
              ];
            })().map(([id, iconName, label]) => {
              const active = this.tab === id;
              return h_flex()
                .id(`tab-${id}`)
                .gap(5)
                .items_center()
                .px(8)
                .py(3)
                .rounded(6)
                .cursor_pointer()
                .bg(active ? t.selected : t.background)
                .text_color(active ? t.foreground : t.dim)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.userPickedTab = true;
                  this.tab = id;
                  cx.notify();
                })
                .child(svg(`mods/agy-inspector/${iconName}.svg`).size(12).flex_none())
                .child(label);
            })
          )
      )
      .child(
        v_flex()
          .id("agy-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .mode("always")
          .p(10)
          .gap(6)
          .child(this.renderBody(sel, t))
      )
      .when(Boolean(this.note), (e) =>
        e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.note))
      )
      .child(
        h_flex()
          .flex_none()
          .p(8)
          .gap(8)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .px(7)
              .py(3)
              .rounded(5)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(target ? t.foreground : t.dim)
              .child(target ? `PTY: ${target}` : "No PTY")
          )
          .child(
            div()
              .id("agy-steer-input")
              .flex_1()
              .min_w(0)
              .h(30)
              .px(10)
              .flex()
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))
          )
          .child(
            h_flex()
              .id("agy-steer-send")
              .h(30)
              .gap(5)
              .px(12)
              .items_center()
              .rounded(7)
              .bg(canSend ? t.solid : t.raised)
              .text_color(canSend ? t.solid_foreground : t.dim)
              .text_size(12)
              .when(canSend, (e) => e.cursor_pointer())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.sendToParent(cx);
              })
              .child(
                this.sending
                  ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900)
                  : svg("mods/agy-inspector/send.svg").size(12).flex_none()
              )
              .child("Send")
          )
      );
  }

  renderBody(sel, t) {
    if (!sel) {
      return div().p(8).text_color(t.dim).child("No agy brain directories found on this machine.");
    }
    if (this.tab === "subagents") {
      const isSubKilled = (s) => {
        const st = String(s.state || "").toLowerCase();
        return st.includes("kill") || st.includes("done") || st.includes("stop");
      };
      const subs = (sel.subagents ?? []).slice().sort((a, b) => {
        const ai = this.initialSubId && a.conversation_id === this.initialSubId ? 1 : 0;
        const bi = this.initialSubId && b.conversation_id === this.initialSubId ? 1 : 0;
        if (ai !== bi) return bi - ai;
        const ak = isSubKilled(a) ? 1 : 0;
        const bk = isSubKilled(b) ? 1 : 0;
        return ak - bk;
      });
      if (!subs.length) return div().text_color(t.dim).child("No subagents in this conversation.");
      const hasAliveSubs = subs.some((s) => !isSubKilled(s));
      const killedSubCount = hasAliveSubs ? subs.filter((s) => isSubKilled(s) && s.conversation_id !== this.expandedSub).length : 0;
      const visibleSubs = (!hasAliveSubs || this.showKilled) ? subs : subs.filter((s) => !isSubKilled(s) || s.conversation_id === this.expandedSub);
      return v_flex()
        .w_full()
        .gap(6)
        .children(
          visibleSubs.map((s) => {
            const open = this.expandedSub === s.conversation_id;
            const isFocusedSub = this.focusedSub === s.conversation_id;
            return v_flex()
              .id(`sub-${s.conversation_id}`)
              .w_full()
              .p(9)
              .gap(6)
              .rounded(8)
              .bg(isFocusedSub ? t.selected : (t.surface ?? t.raised))
              .border_1()
              .border_color(isFocusedSub ? t.accent : t.border)
              .when(isFocusedSub, (el) => el.border_l(3).border_color(t.accent))
              .cursor_pointer()
              .hover((el) => el.bg(t.hover))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.initialSubId = null;
                this.focusedSub = s.conversation_id;
                this.expandedSub = open ? null : s.conversation_id;
                cx.notify();
              })
              .child(
                h_flex()
                  .w_full()
                  .gap(8)
                  .items_center()
                  .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
                  .child(image("icons/antigravity.svg").w(13).h(13).flex_none())
                  .child(div().font_semibold().child(s.role || s.type_name || "subagent"))
                  .child(div().text_size(11).text_color(t.dim).child(String(s.conversation_id).slice(0, 8)))
                  .child(div().flex_1())
                  .child(statusPill(s.state, false, t))
              )
              .when(open, (e) =>
                e.child(
                  v_flex()
                    .w_full()
                    .pt(4)
                    .gap(4)
                    .children(
                      (s.recent_steps ?? []).length
                        ? s.recent_steps.slice().reverse().map((st) =>
                            v_flex()
                              .p(7)
                              .gap(3)
                              .rounded(6)
                              .bg(t.background)
                              .border_1()
                              .border_color(t.border)
                              .child(
                                h_flex()
                                  .gap(6)
                                  .items_center()
                                  .child(div().text_size(11).font_semibold().text_color(t.accent).child(`#${st.step ?? "?"}`))
                                  .when(Boolean(st.tools?.length), (el) =>
                                    el.child(div().text_size(11).text_color(t.working ?? t.accent).child(st.tools.join(", ")))
                                  )
                              )
                              .when(Boolean(st.preview) || !st.tools?.length, (el) =>
                                el.child(div().text_size(11.5).text_color(t.foreground).child(st.preview || "(empty step)"))
                              )
                          )
                        : [div().text_size(11).text_color(t.dim).child("No transcript steps yet.")]
                    )
                )
              );
          })
        )
        .when(killedSubCount > 0, (el) =>
          el.child(
            div()
              .id("toggle-killed-subs")
              .px(8)
              .py(3)
              .rounded(6)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.showKilled = !this.showKilled;
                cx.notify();
              })
              .child(this.showKilled ? `Hide ${killedSubCount} killed subagents` : `Show ${killedSubCount} killed subagents`)
          )
        );
    }
    if (this.tab === "transcript") {
      const steps = sel.recent_steps ?? [];
      return v_flex()
        .w_full()
        .gap(5)
        .children(
          steps.slice().reverse().map((s) => {
            const open = this.expandedStep === s.step;
            return v_flex()
              .id(`step-${s.step}`)
              .w_full()
              .p(9)
              .gap(4)
              .rounded(8)
              .bg(t.surface ?? t.raised)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((el) => el.bg(t.hover))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.expandedStep = open ? null : s.step;
                cx.notify();
              })
              .child(
                h_flex()
                  .w_full()
                  .gap(6)
                  .items_center()
                  .child(div().font_semibold().text_color(t.accent).child(`#${s.step ?? "?"}`))
                  .when(Boolean(s.type), (e) =>
                    e.child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(s.type)
                    )
                  )
                  .when(Boolean(s.tools?.length), (e) => e.child(div().text_size(11).text_color(t.working ?? t.accent).child(s.tools.join(", "))))
              )
              .child(div().text_size(12).child(open ? (s.full || s.preview || "(empty)") : (s.preview || "(tool-only step)")));
          })
        );
    }
    const members = (sel.members ?? []).slice().sort((a, b) => {
      const af = this.focusedMember && a.name === this.focusedMember ? 1 : 0;
      const bf = this.focusedMember && b.name === this.focusedMember ? 1 : 0;
      if (af !== bf) return bf - af;
      const ak = a.killed ? 1 : 0;
      const bk = b.killed ? 1 : 0;
      if (ak !== bk) return ak - bk;
      return String(a.name).localeCompare(String(b.name));
    });
    const killedCount = members.filter((m) => m.killed && m.name !== this.focusedMember).length;
    const visibleMembers = this.showKilled ? members : members.filter((m) => !m.killed || m.name === this.focusedMember);
    const board = sel.board ?? [];
    return v_flex()
      .w_full()
      .gap(8)
      .when(members.length > 0, (e) =>
        e.child(
          v_flex()
            .w_full()
            .gap(4)
            .children(
              visibleMembers.map((m) => {
                const isFocusedMember = this.focusedMember && m.name === this.focusedMember;
                return h_flex()
                  .id(`roster-${m.name}`)
                  .w_full()
                  .px(10)
                  .py(6)
                  .gap(8)
                  .items_center()
                  .rounded(8)
                  .bg(isFocusedMember ? t.selected : (t.surface ?? t.raised))
                  .border_1()
                  .border_color(isFocusedMember ? t.accent : t.border)
                  .when(isFocusedMember, (el) => el.border_l(3).border_color(t.accent))
                  .cursor_pointer()
                  .tooltip(`Click to mention @${m.name} in message`)
                  .hover((el) => el.bg(t.hover))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    const prefix = `@${m.name} `;
                    if (!this.message.startsWith(prefix)) {
                      this.message = `${prefix}${this.message}`;
                      this.input.set_value(this.message);
                      cx.notify();
                    }
                  })
                  .child(div().font_semibold().text_color(badgeColor(m.phase, m.killed, t)).child(`@${m.name}`))
                  .when(Boolean(m.model), (el) =>
                    el.child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(m.model)
                    )
                  )
                  .child(div().flex_1())
                  .child(div().text_size(11).text_color(t.dim).child(`read #${m.last_read_seq ?? 0}`))
                  .child(statusPill(m.wake_mode || m.phase, m.killed, t));
              })
            )
            .when(killedCount > 0, (el) =>
              el.child(
                div()
                  .id("toggle-killed-members")
                  .px(8)
                  .py(3)
                  .rounded(6)
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.showKilled = !this.showKilled;
                    cx.notify();
                  })
                  .child(this.showKilled ? `Hide ${killedCount} killed members` : `Show ${killedCount} killed members`)
              )
            )
        )
      )
      .when(Boolean(this.focusedMember) && board.length > 0, (e) =>
        e.child(
          h_flex()
            .w_full()
            .gap(6)
            .items_center()
            .child(
              div()
                .id("filter-focused-member")
                .px(8)
                .py(3)
                .rounded(6)
                .border_1()
                .border_color(this.filterMemberOnly ? t.accent : t.border)
                .bg(this.filterMemberOnly ? t.selected : t.raised)
                .text_size(11)
                .text_color(this.filterMemberOnly ? t.foreground : t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.filterMemberOnly = !this.filterMemberOnly;
                  cx.notify();
                })
                .child(this.filterMemberOnly ? `Showing @${this.focusedMember} only (click for all)` : `Filter: @${this.focusedMember} only`)
            )
        )
      )
      .child(
        v_flex()
          .w_full()
          .gap(5)
          .children((() => {
            const visibleBoard = (this.filterMemberOnly && this.focusedMember)
              ? board.filter((b) => b.agent === this.focusedMember)
              : board;
            if (!visibleBoard.length) {
              return [div().text_color(t.dim).child(this.filterMemberOnly ? `No board messages from @${this.focusedMember}.` : "No swarm board messages in this conversation.")];
            }
            return visibleBoard.slice().reverse().map((b, idx) => {
              const seqKey = String(b.seq ?? idx);
              const isPostFocused = Boolean(this.focusedMember && b.agent === this.focusedMember);
              const fullText = String(b.text || "");
              const isLong = fullText.length > 360;
              const isExpanded = this.expandedBoardSeqs.has(seqKey);
              const displayText = isLong && !isExpanded ? fullText.slice(0, 357) + "..." : fullText;
              const authorColor = isPostFocused ? t.accent : (this.focusedMember ? t.muted : t.accent);
              return v_flex()
                .id(`board-post-${seqKey}`)
                .p(9)
                .gap(4)
                .rounded(8)
                .bg(isPostFocused ? t.selected : (t.surface ?? t.raised))
                .border_1()
                .border_color(isPostFocused ? t.accent : t.border)
                .when(isPostFocused, (el) => el.border_l(3).border_color(t.accent))
                .child(
                  h_flex()
                    .w_full()
                    .items_center()
                    .child(div().font_semibold().text_color(authorColor).child(`@${b.agent || "?"}`))
                    .child(div().flex_1())
                    .child(div().text_size(10.5).text_color(t.dim).child(`#${b.seq ?? "?"}`))
                )
                .child(div().text_size(12).text_color(t.foreground).child(displayText))
                .when(isLong, (el) =>
                  el.child(
                    div()
                      .id(`board-more-${seqKey}`)
                      .text_size(11)
                      .text_color(t.accent)
                      .cursor_pointer()
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        isExpanded ? this.expandedBoardSeqs.delete(seqKey) : this.expandedBoardSeqs.add(seqKey);
                        cx.notify();
                      })
                      .child(isExpanded ? "Show less" : "Show more")
                  )
                );
            });
          })())
      );
  }
}
