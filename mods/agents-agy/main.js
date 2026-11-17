// Agents in grouped or priority views + inline agy Swarm/Subagent tree rows.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, checking } from "herdr";

const PY_AGY_TREE = `
import json, os, re, subprocess, time
from pathlib import Path

def read_json(p):
    try: return json.loads(p.read_text("utf-8"))
    except Exception: return None

def live_agy_convs():
    """Return {conv_id: pid_cwd} for currently running agy processes (Linux /proc + macOS lsof)."""
    res_map = {}
    uuid_re = re.compile(r"(?:presence|conversations)/([0-9a-f-]{36})\\.(?:lock|db)$")
    proc_dir = Path("/proc")
    if proc_dir.is_dir():
        for p in proc_dir.iterdir():
            if not p.name.isdigit(): continue
            try:
                if (p / "comm").read_text("utf-8", errors="replace").strip() != "agy": continue
                cwd = os.readlink(p / "cwd")
                for fd in (p / "fd").iterdir():
                    try:
                        target = os.readlink(fd)
                        m = uuid_re.search(target)
                        if m: res_map[m.group(1)] = cwd
                    except Exception: pass
            except Exception: pass
        return res_map
    try:
        pids = subprocess.check_output(["pgrep", "-x", "agy"], text=True, timeout=1.5).split()
        if pids:
            out = subprocess.check_output(["lsof", "-a", "-p", ",".join(pids), "-Ffn"], text=True, timeout=2.0)
            cur_cwd = ""
            expect_cwd = False
            for line in out.splitlines():
                if line.startswith("p"):
                    cur_cwd = ""
                    expect_cwd = False
                elif line == "fcwd":
                    expect_cwd = True
                elif line.startswith("f"):
                    expect_cwd = False
                elif line.startswith("n"):
                    val = line[1:]
                    if expect_cwd:
                        cur_cwd = val
                        expect_cwd = False
                    else:
                        m = uuid_re.search(val)
                        if m: res_map[m.group(1)] = cur_cwd
    except Exception:
        pass
    return res_map

def tail_jsonl(p, limit=15):
    if not p.is_file(): return []
    out = []
    try:
        with open(p, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 65536))
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

env_brain = os.environ.get("AGY_BRAIN_ROOT")
brain = Path(env_brain) if env_brain else (Path.home() / ".gemini/antigravity-cli/brain")
agy_root = brain.parent
now = time.time()
if not brain.is_dir():
    print("[]")
    raise SystemExit(0)

out = []
live_map = live_agy_convs()
for d in brain.iterdir():
    sg = d / ".system_generated"
    if not (d.is_dir() and sg.is_dir()): continue
    mem_raw = read_json(sg / "swarm/members.json") or {}
    subs_dir = sg / "subagents"
    has_swarm = bool(mem_raw.get("members"))
    has_subs = subs_dir.is_dir() and any(subs_dir.glob("*.json"))
    if not (has_swarm or has_subs): continue

    tr_path = sg / "logs/transcript.jsonl"
    mtime = tr_path.stat().st_mtime if tr_path.exists() else d.stat().st_mtime
    active_lock = d.name in live_map
    # Show active conversations or ones updated in the last 6 hours
    if not active_lock and (now - mtime) > 21600:
        continue

    hint_text = str(mem_raw.get("title") or "")
    for row in tail_jsonl(tr_path, 10):
        hint_text += " " + str(row.get("content") or "")[:300]
        for tc in (row.get("tool_calls") or []):
            if isinstance(tc, dict):
                hint_text += " " + json.dumps(tc.get("arguments") or tc.get("args") or {}, ensure_ascii=False)[:200]

    kids = []
    for name, info in (mem_raw.get("members") or {}).items():
        if not isinstance(info, dict): continue
        killed = bool(info.get("killed", False))
        phase = str(info.get("phase") or "")
        wake = str(info.get("wake_mode") or "")
        if killed:
            st = "idle"
        elif "block" in phase.lower() or "err" in phase.lower():
            st = "blocked"
        elif "work" in phase.lower() or "run" in phase.lower() or wake == "working":
            st = "working"
        else:
            st = "idle"
        kids.append({
            "id": f"swarm:{d.name}:{name}",
            "conv_id": d.name,
            "kind": "swarm",
            "name": f"@{name}",
            "detail": info.get("applied_model") or info.get("desired_model") or "",
            "status": st,
            "killed": killed,
        })

    if subs_dir.is_dir():
        for sp in sorted(subs_dir.glob("*.json")):
            sd = read_json(sp) or {}
            desc = sd.get("subagentDescriptor") or {}
            sid = str(sd.get("conversationId") or sp.stem)
            raw_st = str(sd.get("state") or "").upper()
            st = "working" if raw_st in ("RUNNING", "WORKING", "ACTIVE") else ("blocked" if "ERR" in raw_st or "FAIL" in raw_st else "idle")
            kids.append({
                "id": f"sub:{sid}",
                "sid": sid,
                "conv_id": d.name,
                "kind": "subagent",
                "name": desc.get("role") or desc.get("typeName") or sid[:8],
                "detail": desc.get("typeName") or "",
                "status": st,
                "killed": False,
            })

    if kids:
        out.append({
            "conv_id": d.name,
            "title": mem_raw.get("title"),
            "active": active_lock,
            "pid_cwd": live_map.get(d.name, ""),
            "mtime": mtime,
            "hint": hint_text[:600],
            "kids": kids,
        })

out.sort(key=lambda x: (x["active"], x["mtime"]), reverse=True)
print(json.dumps(out[:10], ensure_ascii=False))
`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class AgentsAgy extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    this.agyByMachine = {};
    this.stickyConv = {};
    this.pollingAgy = false;
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    if (!checking()) {
      this.refreshAgy(cx);
      cx.timer.every(5000, (cx) => this.refreshAgy(cx));
    }
  }

  refreshAgy(cx) {
    if (this.pollingAgy || checking()) return;
    this.pollingAgy = true;
    const agyAgents = agents().filter((a) => a.program?.key === "antigravity" || a.app === "antigravity");
    const machineKeys = [...new Set(agyAgents.map((a) => (a.address.includes("/") ? a.address.split("/")[0] : "")))];
    if (!machineKeys.length) machineKeys.push("");
    cx.spawn(async (cx) => {
      try {
        await Promise.all(
          machineKeys.map(async (mk) => {
            try {
              const on = mk || null;
              const res = await exec("python3", ["-c", PY_AGY_TREE], { on, timeout: 4000 });
              if (res.code === 0) {
                this.agyByMachine[mk] = JSON.parse(res.stdout);
              }
            } catch {
              // Ignore per-machine poll errors
            }
          })
        );
      } finally {
        this.pollingAgy = false;
        cx.notify();
      }
    });
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) { return this.changed[a.address]?.at ?? 0; }
  rank(a) { return RANK[a.status] ?? 0; }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { kind: "terminal", t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  assignAgyConvs(list, allPanes) {
    const byMachine = new Map();
    for (const a of list) {
      if (!(a.program?.key === "antigravity" || a.app === "antigravity")) continue;
      const mk = a.address.includes("/") ? a.address.split("/")[0] : "";
      if (!byMachine.has(mk)) byMachine.set(mk, []);
      byMachine.get(mk).push(a);
    }
    const result = new Map();
    for (const [mk, agyList] of byMachine.entries()) {
      const convs = this.agyByMachine[mk] ?? [];
      if (!convs.length) continue;
      const pairs = [];
      for (const a of agyList) {
        const pane = allPanes.find((p) => p.pane === a.pane);
        const cwd = (pane?.cwd || "").toLowerCase();
        const cwdBase = cwd ? cwd.split("/").filter(Boolean).pop() : "";
        const space = (a.space_name || "").toLowerCase();
        for (const c of convs) {
          const pidCwd = (c.pid_cwd || "").toLowerCase();
          const hint = (c.hint || "").toLowerCase();
          let score = 0;
          if (pidCwd && cwd && pidCwd === cwd) score = 1000;
          else if (cwd && hint.includes(cwd)) score = 500 + cwd.length;
          else if (cwdBase && cwdBase.length >= 4 && hint.includes(cwdBase)) score = 200 + cwdBase.length;
          else if (space && c.active && hint.includes(space)) score = 100;
          if (score > 0) {
            if (c.active) score += 50;
            if (c.active && a.status === "working") score += 40;
            if (this.stickyConv[a.address] === c.conv_id) score += 10;
            pairs.push({ a, c, score });
          }
        }
      }
      pairs.sort((x, y) => y.score - x.score || (y.c.mtime || 0) - (x.c.mtime || 0) || x.a.address.localeCompare(y.a.address));
      const usedAgents = new Set();
      const usedConvs = new Set();
      for (const { a, c } of pairs) {
        if (usedAgents.has(a.address) || usedConvs.has(c.conv_id)) continue;
        usedAgents.add(a.address);
        usedConvs.add(c.conv_id);
        this.stickyConv[a.address] = c.conv_id;
        const kids = c.kids
          .filter((k) => (k.kind === "swarm" ? !k.killed : k.status === "working" || k.status === "blocked"))
          .slice(0, 8);
        if (!kids.length) continue;
        result.set(
          a.address,
          kids.map((k, i) => ({
            kind: "agy",
            parentAddr: a.address,
            machine: mk || null,
            agy: k,
            lines: [i === kids.length - 1 ? "└" : "├"],
          }))
        );
      }
    }
    const liveAddrs = new Set(list.map((a) => a.address));
    for (const addr of Object.keys(this.stickyConv)) {
      if (!liveAddrs.has(addr)) delete this.stickyConv[addr];
    }
    return result;
  }

  subRow(t, s, shown, compact) {
    if (s.kind === "agy") {
      const k = s.agy;
      return h_flex()
        .id(`agy-${s.parentAddr ?? ""}-${k.id}`)
        .pl(39)
        .pr(8)
        .rounded(8)
        .h(24)
        .flex_none()
        .gap(0)
        .items_center()
        .text_size(12)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          setShared("agy.selectedConv", k.conv_id);
          openOverlay({
            mod: "agy-inspector",
            kind: "dialog",
            width: 820,
            height: 640,
            props: {
              conversationId: k.conv_id,
              tab: k.kind === "subagent" ? "subagents" : "board",
              subagentId: k.sid ?? null,
              terminal: s.parentAddr ?? null,
              machine: s.machine ?? null,
            },
          });
        })
        .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(16).mr(4).flex_none()
          .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
          .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
        .child(div().mr(8).child(image("icons/antigravity.svg").w(14).h(14).flex_none()))
        .child(div().flex_1().truncate().text_color(k.killed ? t.dim : t.muted).child(k.name))
        .when(Boolean(k.detail), (el) => el.child(div().mr(6).text_size(10).text_color(t.dim).truncate().max_w(75).child(k.detail)))
        .child(this.status(t, { status: k.status }, compact));
    }
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const allPanes = panes();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);

    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";

    const agyMap = collapsed ? new Map() : this.assignAgyConvs(list, allPanes);
    const allKidsOf = (a) => {
      if (collapsed) return [];
      const realKids = this.tree(all, a.address);
      const agyKids = agyMap.get(a.address) ?? [];
      if (realKids.length && agyKids.length) {
        const lastReal = realKids[realKids.length - 1];
        if (lastReal?.lines?.length) {
          lastReal.lines[lastReal.lines.length - 1] = "├";
        }
      }
      return [...realKids, ...agyKids];
    };

    const urgency = new Map(list.map((a) => [
      a.address,
      Math.max(
        this.rank(a),
        ...allKidsOf(a).map((s) => RANK[s.kind === "agy" ? s.agy.status : kidStatus(s.t, this.listed)] ?? 0),
      ),
    ]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const fold = (a, subs) => {
      const sts = subs.map((s) => (s.kind === "agy" ? s.agy.status : kidStatus(s.t, this.listed)));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    const leads = leadPanes(allPanes);
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const labels = new Map(list.map((a) => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map((a) => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .mx(6)
          .px(2)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .when(a.focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(a.focused ? t.foreground : t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), (el) => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, (el) => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, (el) => el.child(fold(a, subs)))
        .when(this.hovered === a.address, (el) => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    const withKids = (a, i) => {
      const subs = allKidsOf(a);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agents-agy", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
