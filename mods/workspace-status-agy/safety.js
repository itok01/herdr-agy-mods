/**
 * Allowlist-first safety classifier and shared state helpers for Approve Guard.
 */

export const GUARD_KEY = "approve.guard";
export const GUARD_CACHE_KEY = "approve.guard.cache";
export const GUARD_CMD_KEY = "approve.guard.cmd";
export const GUARD_LOCK_KEY = "approve.guard.locks";
export const MAX_AUDIT_LOG = 30;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

/**
 * Strip ANSI escape sequences and carriage returns from terminal output.
 * @param {string} raw
 * @returns {string}
 */
export function stripAnsi(raw) {
  return String(raw || "").replace(ANSI_RE, "");
}

const QUESTION_OR_ESCALATION_RE = [
  { re: /password(?:\s+for\s+[^\n:]+)?\s*:|passphrase(?:\s+for\s+[^\n:]+)?\s*:|verification\s+code\s*:|enter\s+otp\s*:|2fa\s*:/i, reason: "Credential or OTP prompt" },
  { re: /do you trust the files in this folder/i, reason: "Workspace trust dialog — review manually" },
  { re: /bypass permissions|auto-accept edits|don't ask again/i, reason: "Permission escalation option — review manually" },
  { re: /\b(?:askuserquestion|which\s+option|choose\s+one|select\s+an\s+option)\b/i, reason: "Interactive question — review manually" },
];

const UNSAFE_LITERAL_RE = [
  { re: /\brm\b/i, reason: "File deletion (rm)" },
  { re: /\b(?:sudo|su|doas)\b/i, reason: "Privileged command" },
  { re: /\bgit\s+(?:push|reset|clean|checkout\s+--|rebase)\b|\bgit\s+-C\s+\S+\s+push\b/i, reason: "Mutating git command" },
  { re: /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b/i, reason: "Destructive SQL statement" },
  { re: /\b(?:mkfs|fdisk|parted|dd|shutdown|reboot|halt)\b/i, reason: "System/disk command" },
  { re: /\b(?:chmod|chown)\b/i, reason: "Permission/ownership change" },
  { re: /\b(?:curl|wget)\b/i, reason: "Network transfer command" },
  { re: /\b(?:npm|pnpm|yarn)\s+publish\b|\b(?:cargo\s+publish|twine\s+upload|gh\s+release)\b/i, reason: "Publish/release command" },
  { re: /\b(?:terraform\s+destroy|kubectl\s+delete|docker\s+system\s+prune)\b/i, reason: "Infrastructure teardown" },
  { re: /\b(?:eval|exec)\b|\b(?:sh|bash|zsh)\s+-c\b|\bpython3?\s+-c\b|\bnode\s+-e\b/i, reason: "Inline script/shell execution" },
  { re: /(?:\.aws\/|\.ssh\/|\.netrc\b|\.env\b|\.zshrc\b|\.bashrc\b|\.git\/hooks|\.github\/workflows|credentials)/i, reason: "Sensitive config/credential path" },
];

const SHELL_META_RE = /[;&|><`\n]|\$\(|<\(|>\(/;

const SAFE_READONLY_OR_TEST_COMMANDS = [
  /^(?:ls|pwd|which|echo|cat|head|tail|wc|rg|grep|ps)(?:\s+[^\n]*)?$/,
  /^find\s+(?!.*(?:-delete|-exec|-execdir|-ok\b))[^\n]*$/,
  /^git\s+(?:status|diff|log|branch|show|rev-parse)(?:\s+[^\n]*)?$/,
  /^(?:pytest|python3\s+-m\s+unittest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|cargo\s+check|go\s+test|herdr-app\s+check)(?:\s+[^\n]*)?$/,
];

/**
 * Extract the last non-empty lines from stripped terminal output.
 * @param {string} raw
 * @param {number} maxLines
 * @returns {string[]}
 */
export function tailLines(raw, maxLines = 20) {
  const clean = stripAnsi(raw);
  return clean
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines);
}

/**
 * Detect which key confirms the active prompt ("ctrl+k" for agy, "enter" for Claude/Codex).
 * @param {string[]} lines
 * @returns {"ctrl+k" | "enter"}
 */
export function detectApproveKey(lines) {
  const footer = lines.slice(-6).join("\n");
  if (/\bctrl\s*\+\s*k\b|\^K\b/i.test(footer)) return "ctrl+k";
  return "enter";
}

/**
 * Extract the active command from a recognized permission prompt block.
 * Returns null if no active permission prompt block is found or if truncated.
 * @param {string[]} lines
 * @returns {{ kind: "command", command: string } | { kind: "truncated" } | { kind: "multiline", command: string } | null}
 */
function extractActiveCommandPrompt(lines) {
  let headerIdx = -1;
  let isRequestingFor = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (/^requesting permission for:$/i.test(trimmed)) {
      headerIdx = i;
      isRequestingFor = true;
      break;
    }
    if (/would you like to run the following command\?|^(?:run|execute)\s+command\b/i.test(trimmed)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const block = lines.slice(headerIdx);
  const blockText = block.join("\n");
  if (/…\s*\+\d+\s*lines|\.\.\.\s*\+\d+\s*lines/i.test(blockText)) {
    return { kind: "truncated" };
  }

  // Require an active confirmation footer after the header so stale scrollback doesn't match.
  const hasFooter = block.some((l) => /1\.\s*yes,\s*(?:proceed|run command)|run this command\?|press enter to confirm|\bctrl\s*\+\s*k\b|\^K\b/i.test(l));
  if (!hasFooter) return null;

  const cmdLines = [];
  let inCmd = isRequestingFor;
  for (let i = 1; i < block.length; i++) {
    const t = block[i].trim();
    if (/^(?:›|>)?\s*1\.\s*yes|run this command\?|press enter to confirm|\bctrl\s*\+\s*k\b|\^K\b/i.test(t)) break;
    if (t.startsWith("$ ")) {
      inCmd = true;
      cmdLines.push(t.slice(2).trim());
    } else if (inCmd && t.length > 0) {
      cmdLines.push(t);
    }
  }
  if (cmdLines.length === 0) return null;
  if (cmdLines.length > 1) return { kind: "multiline", command: cmdLines.join("\n") };
  return { kind: "command", command: cmdLines[0] };
}

/**
 * Classify a blocked terminal's recent screen text using an allowlist-first policy.
 * @param {string} rawScreen
 * @returns {{ verdict: "safe" | "unsafe" | "question" | "review", reason: string, snippet: string, approveKey: "ctrl+k" | "enter" }}
 */
export function classifyPrompt(rawScreen) {
  const lines = tailLines(rawScreen, 20);
  const text = lines.join("\n");
  const snippet = lines.slice(-6).join("\n");
  const approveKey = detectApproveKey(lines);

  if (!text.trim()) {
    return { verdict: "review", reason: "Empty terminal output", snippet: "", approveKey: "enter" };
  }

  for (const rule of QUESTION_OR_ESCALATION_RE) {
    if (rule.re.test(text)) {
      return { verdict: "question", reason: rule.reason, snippet, approveKey };
    }
  }

  const extracted = extractActiveCommandPrompt(lines);
  if (!extracted) {
    return { verdict: "review", reason: "No recognized active permission prompt — review manually", snippet, approveKey };
  }
  if (extracted.kind === "truncated") {
    return { verdict: "review", reason: "Truncated command output — review manually", snippet, approveKey };
  }
  if (extracted.kind === "multiline") {
    return { verdict: "review", reason: "Multiline command — review manually", snippet, approveKey };
  }

  const cmd = extracted.command.trim();
  for (const rule of UNSAFE_LITERAL_RE) {
    if (rule.re.test(cmd)) {
      return { verdict: "unsafe", reason: rule.reason, snippet, approveKey };
    }
  }

  if (SHELL_META_RE.test(cmd)) {
    return { verdict: "unsafe", reason: "Shell chaining/redirection/subshell not allowed in auto-approve", snippet, approveKey };
  }

  for (const allowRe of SAFE_READONLY_OR_TEST_COMMANDS) {
    if (allowRe.test(cmd)) {
      return { verdict: "safe", reason: `Allowlisted command: ${cmd.slice(0, 60)}`, snippet, approveKey };
    }
  }

  return { verdict: "review", reason: `Command not in safe allowlist: ${cmd.slice(0, 60)}`, snippet, approveKey };
}

/**
 * Resolve effective guard mode ("off" | "safe") for an agent address.
 * @param {object} guardState
 * @param {string} address
 * @returns {"off" | "safe"}
 */
export function getEffectiveMode(guardState, address) {
  const perAgent = guardState?.agents?.[address];
  if (perAgent === "safe" || perAgent === "off") return perAgent;
  return guardState?.mode === "safe" ? "safe" : "off";
}

/**
 * Normalize shared guard state object.
 * @param {unknown} raw
 * @returns {{ mode: "off" | "safe", agents: Record<string, "off" | "safe">, log: Array<object> }}
 */
export function normalizeGuardState(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    mode: obj.mode === "safe" ? "safe" : "off",
    agents: obj.agents && typeof obj.agents === "object" ? { ...obj.agents } : {},
    log: Array.isArray(obj.log) ? obj.log.slice(0, MAX_AUDIT_LOG) : [],
  };
}

/**
 * Prepend an audit entry, deduplicating consecutive unchanged "skipped" entries.
 * @param {object} state
 * @param {{ address: string, label: string, action: string, verdict: string, reason: string, snippet?: string }} entry
 */
export function withAuditEntry(state, entry) {
  const cur = normalizeGuardState(state);
  const prev = cur.log[0];
  if (
    entry.action === "skipped" &&
    prev &&
    prev.action === "skipped" &&
    prev.address === entry.address &&
    prev.verdict === entry.verdict &&
    prev.reason === (entry.reason || "")
  ) {
    return cur;
  }
  const item = {
    ts: Date.now(),
    address: entry.address,
    label: entry.label || entry.address,
    action: entry.action,
    verdict: entry.verdict,
    reason: entry.reason || "",
  };
  return {
    ...cur,
    log: [item, ...cur.log].slice(0, MAX_AUDIT_LOG),
  };
}
