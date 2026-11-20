import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, hc, run, theme, shared, setShared, props, closeOverlay, checking } from "herdr";

const GUARD_KEY = "approve.guard";
const GUARD_CACHE_KEY = "approve.guard.cache";
const GUARD_CMD_KEY = "approve.guard.cmd";
const GUARD_LOCK_KEY = "approve.guard.locks";
const MAX_AUDIT_LOG = 30;

function normalizeState(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    mode: obj.mode === "safe" ? "safe" : "off",
    agents: obj.agents && typeof obj.agents === "object" ? { ...obj.agents } : {},
    log: Array.isArray(obj.log) ? obj.log.slice(0, MAX_AUDIT_LOG) : [],
  };
}

function effectiveMode(state, address) {
  const ov = state?.agents?.[address];
  if (ov === "safe" || ov === "off") return ov;
  return state?.mode === "safe" ? "safe" : "off";
}

function fmtAge(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function agentLabel(a) {
  return a.title || a.program?.name || a.address;
}

/**
 * Approve Guard overlay: per-agent / global safety-filtered auto-approve and manual review.
 */
export default class ApproveGuard extends View {
  init(_props, cx) {
    this.busy = new Set();
    this.confirmUnsafe = new Set();
    this.note = null;
    this.handle = cx.focus_handle();
    if (props()?.overlay) this.handle.focus();
    if (!checking()) {
      setShared(GUARD_CMD_KEY, { op: "refresh", ts: Date.now() });
    }
  }

  readState() {
    return normalizeState(shared(GUARD_KEY));
  }

  writeState(next) {
    setShared(GUARD_KEY, normalizeState(next));
  }

  toggleGlobal(cx) {
    const cur = this.readState();
    const mode = cur.mode === "safe" ? "off" : "safe";
    this.writeState({ ...cur, mode });
    this.note = mode === "safe" ? "Global Safe Auto-approve enabled" : "Global Auto-approve disabled";
    cx.notify();
  }

  cycleAgentMode(addr, cx) {
    const cur = this.readState();
    const curOverride = cur.agents[addr];
    const nextAgents = { ...cur.agents };
    if (!curOverride) nextAgents[addr] = "safe";
    else if (curOverride === "safe") nextAgents[addr] = "off";
    else delete nextAgents[addr];
    this.writeState({ ...cur, agents: nextAgents });
    cx.notify();
  }

  requestRefresh(cx) {
    if (checking()) return;
    setShared(GUARD_CMD_KEY, { op: "refresh", ts: Date.now() });
    this.note = "Refreshing blocked agents...";
    cx.notify();
  }

  approveAllSafe(cx) {
    if (checking()) return;
    setShared(GUARD_CMD_KEY, { op: "approve_all_safe", ts: Date.now() });
    this.note = "Requested safe approval for allowlisted prompts";
    cx.notify();
  }

  async approveManual(a, info, cx) {
    if (this.busy.has(a.address) || checking()) return;
    if (info?.verdict === "unsafe" && !this.confirmUnsafe.has(a.address)) {
      this.confirmUnsafe.add(a.address);
      this.note = `Click again to confirm sending Enter to UNSAFE prompt (${agentLabel(a)})`;
      cx.notify();
      return;
    }

    const now = Date.now();
    const locks = { ...(shared(GUARD_LOCK_KEY) || {}) };
    if ((locks[a.address] || 0) > now) {
      this.note = `${agentLabel(a)} is currently being processed`;
      cx.notify();
      return;
    }
    locks[a.address] = now + 10000;
    setShared(GUARD_LOCK_KEY, locks);

    this.confirmUnsafe.delete(a.address);
    this.busy.add(a.address);
    this.note = null;
    cx.notify();
    try {
      const stillBlocked = agents().some((x) => x.address === a.address && x.status === "blocked");
      if (!stillBlocked) {
        this.note = `${agentLabel(a)} is no longer blocked`;
        return;
      }
      const key = info?.approveKey === "ctrl+k" ? "ctrl+k" : "enter";
      const res = await hc(["keys", a.address, key]);
      if (res.code === 0) {
        const cur = this.readState();
        const entry = {
          ts: Date.now(),
          address: a.address,
          label: agentLabel(a),
          action: "approved",
          verdict: info?.verdict || "manual",
          reason: `Manual [${key}]: ${info?.reason || "Sent key"}`,
        };
        this.writeState({ ...cur, log: [entry, ...cur.log].slice(0, MAX_AUDIT_LOG) });
        this.note = `Sent ${key} to ${agentLabel(a)}`;
      } else {
        this.note = res.stderr || `hc keys exit ${res.code}`;
      }
    } catch (e) {
      this.note = String(e);
    } finally {
      this.busy.delete(a.address);
      const nextLocks = { ...(shared(GUARD_LOCK_KEY) || {}) };
      delete nextLocks[a.address];
      setShared(GUARD_LOCK_KEY, nextLocks);
      cx.notify();
    }
  }

  badgeColor(t, verdict) {
    if (verdict === "safe") return t.working;
    if (verdict === "unsafe") return t.blocked;
    return t.accent;
  }

  renderBlockedRow(t, a, state, cache) {
    const info = cache?.[a.address] ?? { verdict: "review", reason: "Waiting for background inspection...", snippet: "" };
    const bc = this.badgeColor(t, info.verdict);
    const eff = effectiveMode(state, a.address);
    const isBusy = this.busy.has(a.address);
    const needsConfirm = info.verdict === "unsafe" && this.confirmUnsafe.has(a.address);

    return v_flex()
      .id(`blk-${a.address}`)
      .p(10)
      .gap(6)
      .rounded(7)
      .bg(t.surface)
      .border(1)
      .border_color(info.verdict === "unsafe" ? t.blocked : t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).text_color(t.foreground).child(agentLabel(a)))
          .child(div().text_size(10.5).text_color(t.dim).child(a.space_name || a.address))
          .child(
            div()
              .px(6)
              .py(2)
              .rounded(4)
              .bg(bc + "26")
              .text_size(10)
              .font_semibold()
              .text_color(bc)
              .child(info.verdict.toUpperCase())
          )
      )
      .child(div().text_size(11).text_color(t.muted).child(info.reason))
      .when(Boolean(info.snippet), (el) =>
        el.child(
          div()
            .p(7)
            .rounded(5)
            .bg(t.background)
            .text_size(10.5)
            .text_color(t.dim)
            .child(info.snippet)
        )
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .id(`ag-approve-${a.address}`)
              .px(8)
              .py(3)
              .rounded(5)
              .bg(info.verdict === "unsafe" ? t.blocked + "22" : t.working + "26")
              .text_size(11)
              .font_semibold()
              .text_color(info.verdict === "unsafe" ? t.blocked : t.working)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, c) => {
                c.stop_propagation();
                c.spawn(async (c2) => this.approveManual(a, info, c2));
              })
              .child(
                isBusy
                  ? "Sending..."
                  : needsConfirm
                    ? `Confirm UNSAFE (${info?.approveKey === "ctrl+k" ? "Ctrl+K" : "Enter"})`
                    : info.verdict === "unsafe"
                      ? `Approve Anyway (${info?.approveKey === "ctrl+k" ? "Ctrl+K" : "Enter"})`
                      : `Approve (${info?.approveKey === "ctrl+k" ? "Ctrl+K" : "Enter"})`
              )
          )
          .child(
            div()
              .id(`ag-focus-${a.address}`)
              .px(8)
              .py(3)
              .rounded(5)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, c) => {
                c.stop_propagation();
                run("agent.focus", { terminal: a.address });
                closeOverlay();
              })
              .child("Focus")
          )
          .child(div().flex_1())
          .child(
            div()
              .id(`ag-mode-${a.address}`)
              .px(7)
              .py(3)
              .rounded(5)
              .border(1)
              .border_color(eff === "safe" ? t.working : t.border)
              .text_size(10.5)
              .text_color(eff === "safe" ? t.working : t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, c) => {
                c.stop_propagation();
                this.cycleAgentMode(a.address, c);
              })
              .child(`Auto: ${eff.toUpperCase()}`)
          )
      );
  }

  render(_cx) {
    const t = theme();
    const state = this.readState();
    const cache = shared(GUARD_CACHE_KEY) || {};
    const allAgents = agents();
    const blocked = allAgents.filter((a) => a.status === "blocked");

    return v_flex()
      .id("approve-guard-root")
      .key_context("ApproveGuard")
      .size_full()
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .track_focus(this.handle)
      .on_key_down((e, c) => {
        if (e.key === "escape") {
          c.stop_propagation();
          closeOverlay();
        } else if (e.key === "r") {
          c.stop_propagation();
          this.requestRefresh(c);
        }
      })
      .child(
        h_flex()
          .px(14)
          .py(10)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Approve Guard"))
          .child(
            div()
              .id("ag-global-toggle")
              .px(8)
              .py(3)
              .rounded(5)
              .bg(state.mode === "safe" ? t.working + "26" : t.surface)
              .border(1)
              .border_color(state.mode === "safe" ? t.working : t.border)
              .text_size(11)
              .font_semibold()
              .text_color(state.mode === "safe" ? t.working : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, c) => {
                c.stop_propagation();
                this.toggleGlobal(c);
              })
              .child(state.mode === "safe" ? "Global Auto: SAFE" : "Global Auto: OFF")
          )
          .child(div().flex_1())
          .when(blocked.length > 0, (el) =>
            el.child(
              div()
                .id("ag-approve-all")
                .px(8)
                .py(3)
                .rounded(5)
                .bg(t.working + "26")
                .text_size(11)
                .font_semibold()
                .text_color(t.working)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, c) => {
                  c.stop_propagation();
                  this.approveAllSafe(c);
                })
                .child("Approve All Safe")
            )
          )
          .child(
            div()
              .id("ag-refresh")
              .px(8)
              .py(3)
              .rounded(5)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, c) => {
                c.stop_propagation();
                this.requestRefresh(c);
              })
              .child("Refresh")
          )
          .child(
            div()
              .id("ag-close")
              .px(6)
              .py(3)
              .rounded(5)
              .text_size(12)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, c) => {
                c.stop_propagation();
                closeOverlay();
              })
              .child("×")
          )
      )
      .when(Boolean(this.note), (el) =>
        el.child(div().px(14).py(5).bg(t.surface).border_b(1).border_color(t.border).text_size(11).text_color(t.muted).child(this.note))
      )
      .child(
        v_flex()
          .id("approve-guard-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .p(14)
          .gap(12)
          .child(
            v_flex()
              .gap(6)
              .child(div().text_size(11).font_semibold().text_color(t.dim).child(`BLOCKED AGENTS (${blocked.length})`))
              .when(blocked.length === 0, (el) =>
                el.child(div().p(10).rounded(6).bg(t.surface).text_size(11.5).text_color(t.dim).child("No blocked agents right now."))
              )
              .children(blocked.map((a) => this.renderBlockedRow(t, a, state, cache)))
          )
          .when(allAgents.length > 0, (el) =>
            el.child(
              v_flex()
                .gap(5)
                .child(div().text_size(11).font_semibold().text_color(t.dim).child(`PER-AGENT AUTO-APPROVE (${allAgents.length})`))
                .children(
                  allAgents.map((a) => {
                    const ov = state.agents[a.address];
                    const eff = effectiveMode(state, a.address);
                    const badge = ov ? `Override: ${ov.toUpperCase()}` : `Inherit (${eff.toUpperCase()})`;
                    return h_flex()
                      .id(`perm-${a.address}`)
                      .px(10)
                      .py(6)
                      .rounded(6)
                      .bg(t.surface)
                      .gap(8)
                      .items_center()
                      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(agentLabel(a)))
                      .child(div().text_size(10.5).text_color(t.dim).child(a.status))
                      .child(
                        div()
                          .id(`perm-toggle-${a.address}`)
                          .px(7)
                          .py(2)
                          .rounded(4)
                          .border(1)
                          .border_color(eff === "safe" ? t.working : t.border)
                          .text_size(10.5)
                          .text_color(eff === "safe" ? t.working : t.dim)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, c) => {
                            c.stop_propagation();
                            this.cycleAgentMode(a.address, c);
                          })
                          .child(badge)
                      );
                  })
                )
            )
          )
          .when(state.log.length > 0, (el) =>
            el.child(
              v_flex()
                .gap(4)
                .child(div().text_size(11).font_semibold().text_color(t.dim).child("RECENT AUDIT LOG"))
                .children(
                  state.log.slice(0, 8).map((entry, idx) =>
                    h_flex()
                      .id(`log-${idx}-${entry.ts}`)
                      .px(8)
                      .py(4)
                      .rounded(5)
                      .bg(t.surface)
                      .gap(8)
                      .items_center()
                      .child(
                        div()
                          .text_size(10)
                          .font_semibold()
                          .text_color(entry.action === "approved" ? t.working : t.blocked)
                          .child(entry.action.toUpperCase())
                      )
                      .child(div().text_size(11).text_color(t.foreground).child(entry.label))
                      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(entry.reason))
                      .child(div().text_size(10).text_color(t.dim).child(fmtAge(entry.ts)))
                  )
                )
            )
          )
      );
  }
}
