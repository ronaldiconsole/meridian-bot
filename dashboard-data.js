import fs from "node:fs";
import path from "node:path";
import { repoPath, REPO_ROOT } from "./repo-root.js";

const SECRET_NAME = /^(?:\.env(?:\..*)?|user-config\.json|.*\.key|.*\.pem)$/i;
const SECRET_KEY = /private|secret|token|mnemonic|password|api.?key/i;
const MAX_TEXT = 1200;
const MAX_LOG_LIMIT = 200;

function isWithin(rootDir, target) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function assertReadablePath(filePath, rootDir, { logsOnly = false } = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Path is not allowed");
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(filePath);
  if (!isWithin(resolvedRoot, resolved)) throw new Error("Path is not allowed outside dashboard root");
  const relative = path.relative(resolvedRoot, resolved);
  const parts = relative.split(path.sep).filter(Boolean);
  const base = parts.at(-1) || "";
  if (parts.some((part) => SECRET_NAME.test(part))) throw new Error("Path is not allowed");
  if (logsOnly && (parts[0] !== "logs" || parts.length !== 2)) throw new Error("Log path is not allowed");
  return resolved;
}

function asText(value, max = MAX_TEXT) {
  if (value == null) return "";
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function redactText(value, max = MAX_TEXT) {
  return asText(value, max).replace(/((?:private[_ -]?key|secret|token|mnemonic|password|api[_ -]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
}

function redact(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return asText(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  return asText(value);
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Read one of the dashboard's local JSON files without following arbitrary paths. */
export function safeJsonFile(filePath, fallback = null, { rootDir = REPO_ROOT } = {}) {
  let resolved;
  try {
    resolved = assertReadablePath(filePath, rootDir);
  } catch (error) {
    throw error;
  }
  if (!resolved.toLowerCase().endsWith(".json")) throw new Error("Path is not allowed");
  if (!fs.existsSync(resolved)) return fallback;
  try {
    return parseJson(fs.readFileSync(resolved, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

/** Read bounded JSONL audit entries. Malformed lines are ignored by design. */
export function safeJsonlFile(filePath, { rootDir = REPO_ROOT, limit = 100 } = {}) {
  const resolved = assertReadablePath(filePath, rootDir, { logsOnly: true });
  if (!resolved.toLowerCase().endsWith(".jsonl")) throw new Error("Log path is not allowed");
  const hardLimit = Math.min(Math.max(Number(limit) || 0, 0), MAX_LOG_LIMIT);
  if (!fs.existsSync(resolved) || hardLimit === 0) return [];
  const rows = [];
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJson(line, null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(redact(parsed));
    if (rows.length >= hardLimit) break;
  }
  return rows;
}

function listLogFiles(rootDir, prefix, extension) {
  const logDir = path.join(rootDir, "logs");
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(extension))
    .filter((entry) => !SECRET_NAME.test(entry.name))
    .map((entry) => path.join(logDir, entry.name))
    .sort()
    .reverse();
}

function runtimeEntry(line, file) {
  const match = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/);
  if (!match) return null;
  const [, timestamp, category, message] = match;
  const upper = category.toUpperCase();
  const status = /SAFETY|BLOCK|FAIL|ERROR|REJECT|DENY/.test(upper)
    ? "failure"
    : /WARN|DEGRADED|RETRY/.test(upper)
      ? "warn"
      : "info";
  return {
    timestamp,
    source: "runtime",
    category: upper,
    level: status === "failure" && /ERROR/.test(upper) ? "error" : status,
    status,
    message: redactText(message),
    file: path.basename(file),
  };
}

function actionEntry(entry, file) {
  const success = entry.success === true;
  return {
    timestamp: entry.timestamp || entry.ts || null,
    source: "actions",
    category: "ACTION",
    level: success ? "success" : "failure",
    status: success ? "success" : "failure",
    message: `${entry.tool || "unknown_tool"}${entry.error ? ` — ${redactText(entry.error, 300)}` : ""}`,
    tool: asText(entry.tool, 100) || "unknown_tool",
    duration_ms: Number.isFinite(Number(entry.duration_ms)) ? Number(entry.duration_ms) : null,
    success,
    details: redact({ args: entry.args || {}, result: entry.result || {}, error: entry.error || null }),
    file: path.basename(file),
  };
}

function decisionEntry(entry) {
  const type = asText(entry.type, 60) || "note";
  return {
    timestamp: entry.ts || entry.timestamp || null,
    source: "decisions",
    category: "DECISION",
    level: /reject|skip|block|safety/i.test(type) ? "failure" : "info",
    status: /reject|skip|block|safety/i.test(type) ? "failure" : "info",
    message: redactText(entry.summary || entry.reason || `${entry.actor || "GENERAL"} ${type}`, 500),
    type,
    actor: asText(entry.actor, 80) || "GENERAL",
    pool: asText(entry.pool_name || entry.pool, 120) || null,
    details: redact({ reason: entry.reason, risks: entry.risks, metrics: entry.metrics, rejected: entry.rejected }),
  };
}

function normalizeLevel(entry) {
  const level = String(entry.status || "info").toLowerCase();
  if (["info", "warn", "error", "success", "failure"].includes(level)) return level;
  return "info";
}

function matches(entry, level, query) {
  if (level !== "all" && normalizeLevel(entry) !== level && String(entry.level || "").toLowerCase() !== level) return false;
  if (!query) return true;
  const haystack = JSON.stringify(entry).toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/** Return normalized, redacted runtime, action-audit, and decision-log entries. */
export function readLogs({
  rootDir = REPO_ROOT,
  source = "all",
  level = "all",
  q = "",
  limit = 100,
} = {}) {
  const selectedSource = ["runtime", "actions", "decisions", "all"].includes(source) ? source : "all";
  const selectedLevel = ["all", "info", "warn", "error", "success", "failure"].includes(level) ? level : "all";
  const hardLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_LOG_LIMIT);
  const entries = [];

  if (selectedSource === "all" || selectedSource === "runtime") {
    for (const file of listLogFiles(rootDir, "agent-", ".log")) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const item = runtimeEntry(line, file);
        if (item) entries.push(item);
      }
    }
  }
  if (selectedSource === "all" || selectedSource === "actions") {
    for (const file of listLogFiles(rootDir, "actions-", ".jsonl")) {
      for (const row of safeJsonlFile(file, { rootDir, limit: MAX_LOG_LIMIT })) entries.push(actionEntry(row, file));
    }
  }
  if (selectedSource === "all" || selectedSource === "decisions") {
    const decisions = safeJsonFile(path.join(rootDir, "decision-log.json"), { decisions: [] }, { rootDir });
    for (const decision of Array.isArray(decisions?.decisions) ? decisions.decisions : []) entries.push(decisionEntry(redact(decision)));
  }

  const filtered = entries
    .filter((entry) => matches(entry, selectedLevel, asText(q, 100)))
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, hardLimit);
  return { entries: filtered, count: filtered.length, limit: hardLimit, source: selectedSource, level: selectedLevel };
}

const FLOW_STAGES = [
  ["scheduler", "Scheduler", "Triggers the configured management/screening cycle."],
  ["data", "Load data", "Reads wallet, pools, positions, prices, and local state."],
  ["cycle", "Management cycle", "Evaluates open positions and current PnL."],
  ["decision", "Decision", "Scores candidates and chooses hold, claim, rebalance, or close."],
  ["safety", "Safety gates", "Checks dry-run, cooldowns, confirmations, and risk limits."],
  ["execute", "Execute action", "Runs an approved tool action when all gates pass."],
  ["verify", "Verify result", "Confirms the result and records transaction or error details."],
  ["persist", "Persist state", "Updates state, lessons, performance, and decision history."],
  ["notify", "Notify", "Publishes a concise status update to configured channels."],
];

function stageForEntry(entry) {
  const text = `${entry.category || ""} ${entry.message || ""} ${entry.tool || ""}`.toLowerCase();
  if (/safety|blocked|cooldown|dry.?run|confirmation|risk/.test(text)) return "safety";
  if (entry.source === "actions" || entry.category === "ACTION") return "execute";
  if (/screen|management cycle|pnl|exit signal|out of range|trailing|stop.?loss/.test(text)) return "cycle";
  if (/position|wallet|pool|portfolio|fetch|rpc|price|candidate/.test(text)) return "data";
  if (/decision|score|select|hold|claim|rebalance|close/.test(text)) return "decision";
  if (/deploy|swap|execute|transaction|action|tool/.test(text)) return "execute";
  if (/verify|confirmed|signature|result/.test(text)) return "verify";
  if (/state|lesson|performance|persist|record|decision_log/.test(text)) return "persist";
  if (/telegram|notify|notification|discord/.test(text)) return "notify";
  if (/cron|schedule|tick|starting/.test(text)) return "scheduler";
  return null;
}

/** Build a stable process map for the Bot Flow view from recent logs. */
export function getFlowSnapshot({ logs = [] } = {}) {
  const normalized = Array.isArray(logs) ? logs : [];
  const latest = [...normalized].sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0] || null;
  const activeStage = latest ? stageForEntry(latest) : null;
  const activeIndex = FLOW_STAGES.findIndex(([id]) => id === activeStage);
  const flowNodes = FLOW_STAGES.map(([id, label, description], index) => ({
    id,
    label,
    description,
    status: activeIndex < 0 ? "idle" : index < activeIndex ? "complete" : index === activeIndex ? "active" : "idle",
  }));
  return {
    active_stage: activeStage,
    active_label: flowNodes.find((node) => node.id === activeStage)?.label || "Waiting for activity",
    last_event: latest,
    flow_nodes: flowNodes,
    explanation: latest ? asText(latest.message, 300) : "No recent bot activity has been recorded.",
  };
}

async function defaultLiveReader() {
  try {
    const module = await import("./tools/dlmm.js");
    return await module.getMyPositions({ force: true, silent: true });
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ageMinutes(value, now) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / 60000)) : null;
}

function mapPosition(position, tracked, now) {
  const row = { ...(tracked || {}), ...(position || {}) };
  const outOfRange = row.in_range === false || Boolean(row.out_of_range_since);
  return {
    position: asText(row.position, 120) || null,
    pool: asText(row.pool, 120) || null,
    pair: asText(row.pair || row.pool_name || row.pool, 120) || "Unknown pool",
    pool_name: asText(row.pool_name || row.pair, 120) || null,
    strategy: asText(row.strategy, 60) || null,
    value_usd: numberOrNull(row.total_value_true_usd ?? row.total_value_usd ?? row.value_usd),
    total_value_usd: numberOrNull(row.total_value_usd ?? row.total_value_true_usd ?? row.value_usd),
    pnl_usd: numberOrNull(row.pnl_true_usd ?? row.pnl_usd),
    pnl_pct: numberOrNull(row.pnl_pct),
    fees_usd: numberOrNull(row.unclaimed_fees_true_usd ?? row.unclaimed_fees_usd ?? row.fees_usd),
    unclaimed_fees_usd: numberOrNull(row.unclaimed_fees_usd ?? row.unclaimed_fees_true_usd ?? row.fees_usd),
    in_range: row.in_range == null ? !outOfRange : Boolean(row.in_range),
    lower_bin: numberOrNull(row.lower_bin ?? row.bin_range?.min),
    upper_bin: numberOrNull(row.upper_bin ?? row.bin_range?.max),
    active_bin: numberOrNull(row.active_bin ?? row.bin_range?.active),
    minutes_out_of_range: numberOrNull(row.minutes_out_of_range) ?? ageMinutes(row.out_of_range_since, now),
    age_minutes: numberOrNull(row.age_minutes) ?? ageMinutes(row.deployed_at, now),
    peak_pnl_pct: numberOrNull(row.peak_pnl_pct),
    trailing_active: Boolean(row.trailing_active),
    instruction: asText(row.instruction, 280) || null,
    closed: Boolean(row.closed),
  };
}

function localPositions(state, now) {
  return Object.values(state?.positions || {})
    .filter((position) => !position.closed)
    .map((position) => mapPosition(null, position, now));
}

function performanceSummary(lessons) {
  const performance = Array.isArray(lessons?.performance) ? lessons.performance : [];
  const realized = performance.reduce((sum, row) => sum + (numberOrNull(row.pnl_usd) || 0), 0);
  const fees = performance.reduce((sum, row) => sum + (numberOrNull(row.fees_earned_usd) || 0), 0);
  return {
    realized_pnl_usd: Math.round(realized * 100) / 100,
    fees_earned_usd: Math.round(fees * 100) / 100,
    performance_points: performance.slice(0, 30).map((row) => ({
      timestamp: row.recorded_at || row.ts || null,
      pnl_usd: numberOrNull(row.pnl_usd) || 0,
      fees_earned_usd: numberOrNull(row.fees_earned_usd) || 0,
    })),
  };
}

/** Assemble the complete read-only payload used by all dashboard API views. */
export async function readDashboardData({ rootDir = REPO_ROOT, liveReader = defaultLiveReader, now = new Date() } = {}) {
  const state = safeJsonFile(path.join(rootDir, "state.json"), { positions: {}, recentEvents: [], lastUpdated: null }, { rootDir }) || {};
  const lessons = safeJsonFile(path.join(rootDir, "lessons.json"), { performance: [], lessons: [] }, { rootDir }) || {};
  const decisionsFile = safeJsonFile(path.join(rootDir, "decision-log.json"), { decisions: [] }, { rootDir }) || {};
  const recentLogs = readLogs({ rootDir, source: "all", limit: 80 }).entries;
  const flow = getFlowSnapshot({ logs: recentLogs });
  const performance = performanceSummary(lessons);

  let live = null;
  try {
    live = typeof liveReader === "function" ? await liveReader() : null;
  } catch {
    live = null;
  }
  const liveRows = Array.isArray(live?.positions) ? live.positions : [];
  const localRows = localPositions(state, now);
  const tracked = state.positions || {};
  const liveAvailable = Array.isArray(live?.positions) && !live?.error;
  const positions = liveAvailable
    ? liveRows.map((position) => mapPosition(position, tracked[position.position], now))
    : localRows;
  const dataStatus = liveAvailable ? "live" : (localRows.length ? "local" : "unavailable");
  const openPnl = positions.reduce((sum, row) => sum + (row.pnl_usd || 0), 0);
  const portfolioValue = positions.reduce((sum, row) => sum + (row.total_value_usd || 0), 0);
  const unclaimedFees = positions.reduce((sum, row) => sum + (row.unclaimed_fees_usd || 0), 0);
  const allTracked = Object.values(tracked);

  return {
    generated_at: now.toISOString(),
    runtime: {
      node: process.version,
      pid: process.pid,
      dry_run: String(process.env.DRY_RUN || "").toLowerCase() === "true",
      refresh_ms: Math.min(Math.max(Number(process.env.DASHBOARD_REFRESH_MS || 5000) || 5000, 1000), 60000),
      bot_activity: flow.active_stage ? "active" : "idle",
    },
    summary: {
      open_positions: positions.length,
      closed_positions: allTracked.filter((position) => position.closed).length,
      portfolio_value_usd: Math.round(portfolioValue * 100) / 100,
      open_pnl_usd: Math.round(openPnl * 100) / 100,
      realized_pnl_usd: performance.realized_pnl_usd,
      fees_earned_usd: Math.round((performance.fees_earned_usd + unclaimedFees) * 100) / 100,
      out_of_range: positions.filter((position) => position.in_range === false).length,
      data_status: dataStatus,
      last_updated: state.lastUpdated || null,
    },
    positions,
    pnl_history: performance.performance_points,
    recent_events: Array.isArray(state.recentEvents) ? state.recentEvents.slice(-20).map(redact).reverse() : [],
    recent_decisions: Array.isArray(decisionsFile.decisions) ? decisionsFile.decisions.slice(0, 10).map(redact) : [],
    flow,
    logs: recentLogs.slice(0, 40),
  };
}

export { redact };
