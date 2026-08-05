const REFRESH_MS = 5000;
const state = { view: "overview", overview: null, positions: null, flow: null, logs: null, busy: false };
let refreshTimer = null;
const views = [...document.querySelectorAll("[data-view]")];
const navItems = [...document.querySelectorAll("[data-view-target]")];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function text(value, fallback = "—") {
  return value == null || value === "" ? fallback : String(value);
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  return `${amount < 0 ? "−" : ""}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  return `${amount >= 0 ? "+" : "−"}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function age(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const minutes = Math.max(0, Math.floor(Number(value)));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

function when(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setLive(message) { $("#live-region").textContent = message; }

function setConnection(status, label) {
  const element = $("#connection-status");
  element.dataset.state = status;
  $("#connection-label").textContent = label;
  const dot = element.querySelector(".status-dot");
  dot.className = `status-dot status-dot--${status === "ok" ? "good" : status === "error" ? "bad" : "info"}`;
}

function setError(message = "") {
  const banner = $("#error-banner");
  banner.hidden = !message;
  banner.textContent = message;
}

async function getJson(endpoint) {
  const response = await fetch(endpoint, { method: "GET", headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function setBusy(busy) {
  state.busy = busy;
  $("#refresh-button").disabled = busy;
  $("#refresh-button").setAttribute("aria-busy", String(busy));
  $("#refresh-button").lastChild.textContent = busy ? " Loading…" : " Refresh";
}

function setDataBadge(selector, status) {
  const element = $(selector);
  if (!element) return;
  element.dataset.state = status || "unavailable";
  element.textContent = status === "live" ? "LIVE DATA" : status === "local" ? "LOCAL FALLBACK" : status === "unavailable" ? "DATA UNAVAILABLE" : "WAITING FOR DATA";
}

function renderKpis(summary = {}) {
  const values = { open_positions: number(summary.open_positions), portfolio_value_usd: money(summary.portfolio_value_usd), open_pnl_usd: signedMoney(summary.open_pnl_usd), realized_pnl_usd: signedMoney(summary.realized_pnl_usd), fees_earned_usd: money(summary.fees_earned_usd), out_of_range: number(summary.out_of_range) };
  for (const [key, value] of Object.entries(values)) {
    const element = document.querySelector(`[data-kpi="${key}"]`);
    if (!element) continue;
    element.textContent = value;
    element.classList.toggle("positive", key.includes("pnl") && Number(summary[key]) >= 0);
    element.classList.toggle("negative", key.includes("pnl") && Number(summary[key]) < 0);
  }
  $("[data-kpi-meta=\"open_positions\"]").textContent = summary.data_status === "live" ? "Live tracked" : summary.data_status === "local" ? "Local state fallback" : "No source available";
}

function renderSparkline(points = []) {
  const svg = $("#pnl-sparkline");
  const empty = $("#chart-empty");
  svg.replaceChildren();
  if (!Array.isArray(points) || points.length < 2) { empty.hidden = false; return; }
  empty.hidden = true;
  const width = 720, height = 220, pad = 15;
  const values = points.map((point) => Number(point.pnl_usd) || 0);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
  const x = (index) => pad + (index / (values.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const make = (name, attrs) => { const node = document.createElementNS("http://www.w3.org/2000/svg", name); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
  const defs = make("defs", {});
  const gradient = make("linearGradient", { id: "pnl-area", x1: "0", x2: "0", y1: "0", y2: "1" });
  gradient.append(make("stop", { offset: "0%", "stop-color": "#22c55e", "stop-opacity": ".28" }), make("stop", { offset: "100%", "stop-color": "#22c55e", "stop-opacity": "0" }));
  defs.append(gradient); svg.append(defs);
  for (const ratio of [0.25, 0.5, 0.75]) svg.append(make("line", { class: "grid-line", x1: pad, x2: width - pad, y1: height * ratio, y2: height * ratio }));
  svg.append(make("line", { class: "zero-line", x1: pad, x2: width - pad, y1: y(0), y2: y(0) }));
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(" ");
  svg.append(make("path", { class: "area", d: `${line} L ${x(values.length - 1)} ${height - pad} L ${x(0)} ${height - pad} Z` }));
  svg.append(make("path", { class: "line", d: line }));
  const last = values.at(-1);
  svg.setAttribute("aria-label", `PnL history, latest ${signedMoney(last)}`);
}

function appendEvent(list, title, copy, timestamp, tag = "") {
  const item = document.createElement("li"); item.className = "event-item";
  const meta = document.createElement("span"); meta.className = "event-time"; meta.textContent = `${when(timestamp)}${tag ? ` · ${tag}` : ""}`;
  const body = document.createElement("div"); body.className = "event-copy";
  const strong = document.createElement("strong"); strong.textContent = title;
  body.append(strong); const description = document.createElement("span"); description.textContent = copy; body.append(description); item.append(meta, body); list.append(item);
}

function renderEvents(events = [], decisions = []) {
  const eventList = $("#recent-events"); eventList.replaceChildren();
  if (!events.length) { const empty = document.createElement("li"); empty.className = "empty-row"; empty.textContent = "No events recorded yet."; eventList.append(empty); } else events.slice(0, 6).forEach((event) => appendEvent(eventList, text(event.action || event.category, "Event"), text(event.reason || event.message || event.position, "State updated"), event.ts || event.timestamp, event.position ? "POSITION" : "STATE"));
  const decisionList = $("#recent-decisions"); decisionList.replaceChildren();
  if (!decisions.length) { const empty = document.createElement("li"); empty.className = "empty-row"; empty.textContent = "No structured decisions yet."; decisionList.append(empty); } else decisions.slice(0, 6).forEach((decision) => appendEvent(decisionList, `${text(decision.actor, "BOT")} · ${text(decision.type, "NOTE")}`, text(decision.summary || decision.reason, "No explanation recorded"), decision.ts || decision.timestamp, text(decision.pool_name || decision.pool, "DECISION")));
}

function renderOverview(data) {
  state.overview = data;
  const configuredRefresh = Number(data.runtime?.refresh_ms);
  if (Number.isFinite(configuredRefresh) && configuredRefresh >= 1000 && configuredRefresh <= 60000) {
    const nextTimer = Math.round(configuredRefresh);
    if (state.refresh_ms !== nextTimer) {
      state.refresh_ms = nextTimer;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => refresh({ announce: false }), nextTimer);
    }
  }
  renderKpis(data.summary);
  renderSparkline(data.pnl_history);
  setDataBadge("#overview-data-status", data.summary?.data_status);
  $("#runtime-node").textContent = `Node ${text(data.runtime?.node)}`;
  $("#runtime-activity").textContent = data.runtime?.bot_activity === "active" ? "Bot activity detected" : "No recent activity";
  $("#runtime-source").textContent = text(data.summary?.data_status, "unavailable").toUpperCase();
  $("#runtime-pid").textContent = text(data.runtime?.pid);
  $("#runtime-mode").textContent = data.runtime?.dry_run ? "DRY RUN" : "LIVE / CONFIGURED";
  $("#runtime-updated").textContent = when(data.summary?.last_updated);
  $("#runtime-dot").className = `status-dot status-dot--${data.runtime?.bot_activity === "active" ? "good" : "info"}`;
  renderEvents(data.recent_events || [], data.recent_decisions || []);
}

function cell(textValue, className = "") { const td = document.createElement("td"); td.className = className; td.textContent = textValue; return td; }

function renderPositions(data) {
  state.positions = data;
  const rows = Array.isArray(data.positions) ? data.positions : [];
  setDataBadge("#positions-data-status", data.data_status || data.summary?.data_status);
  $("#positions-count").textContent = `${rows.length} position${rows.length === 1 ? "" : "s"}`;
  const table = $("#positions-table"); table.replaceChildren();
  if (!rows.length) { const row = document.createElement("tr"); const empty = document.createElement("td"); empty.colSpan = 7; empty.className = "empty-row"; empty.textContent = data.data_status === "unavailable" ? "Position data is unavailable. Check wallet configuration and runtime dependencies." : "No open positions found."; row.append(empty); table.append(row); return; }
  rows.forEach((position) => {
    const row = document.createElement("tr");
    const pool = document.createElement("td"); const main = document.createElement("span"); main.className = "cell-main"; main.textContent = text(position.pair, "Unknown pool"); const sub = document.createElement("span"); sub.className = "cell-sub"; sub.textContent = text(position.position, "No address"); pool.append(main, sub); row.append(pool);
    row.append(cell(money(position.total_value_usd), "number"));
    const pnl = cell(signedMoney(position.pnl_usd), `number ${Number(position.pnl_usd) >= 0 ? "positive" : "negative"}`); row.append(pnl);
    row.append(cell(money(position.unclaimed_fees_usd), "number"));
    const range = cell("", ""); const rangeLabel = document.createElement("span"); rangeLabel.className = `status-label status-label--${position.in_range ? "good" : "warn"}`; rangeLabel.textContent = `${position.in_range ? "● IN RANGE" : "▲ OUT OF RANGE"}${position.active_bin != null ? ` · ${position.active_bin}` : ""}`; range.append(rangeLabel); row.append(range);
    row.append(cell(position.in_range ? "—" : age(position.minutes_out_of_range), "number"));
    row.append(cell(text(position.strategy), ""));
    table.append(row);
  });
}

function renderFlow(data) {
  state.flow = data;
  const nodes = Array.isArray(data.flow_nodes) ? data.flow_nodes : [];
  $("#flow-stage-badge").textContent = text(data.active_label, "Waiting for activity");
  $("#flow-active-label").textContent = text(data.active_label, "Waiting for activity");
  $("#flow-detail-title").textContent = text(data.active_label, "No signal yet");
  $("#flow-detail-copy").textContent = text(data.explanation, "The dashboard will explain the current stage when a log event is available.");
  const list = $("#flow-list"); list.replaceChildren();
  if (!nodes.length) { const empty = document.createElement("li"); empty.className = "empty-row"; empty.textContent = "No flow nodes available."; list.append(empty); return; }
  nodes.forEach((node, index) => { const item = document.createElement("li"); item.className = `flow-node ${node.status === "active" ? "is-active" : node.status === "complete" ? "is-complete" : ""}`; const numberNode = document.createElement("span"); numberNode.className = "flow-node__number"; numberNode.textContent = String(index + 1).padStart(2, "0"); const copy = document.createElement("div"); copy.className = "flow-node__copy"; const label = document.createElement("strong"); label.textContent = text(node.label); const description = document.createElement("span"); description.textContent = text(node.description); copy.append(label, description); const status = document.createElement("span"); status.className = "flow-node__state"; status.textContent = text(node.status, "idle"); item.append(numberNode, copy, status); list.append(item); });
}

function renderLogs(data) {
  state.logs = data;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  $("#logs-count").textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  const table = $("#logs-table"); table.replaceChildren();
  if (!entries.length) { const row = document.createElement("tr"); const empty = document.createElement("td"); empty.colSpan = 5; empty.className = "empty-row"; empty.textContent = "No log entries match these filters."; row.append(empty); table.append(row); return; }
  entries.forEach((entry) => { const row = document.createElement("tr"); row.append(cell(when(entry.timestamp)), cell(text(entry.source).toUpperCase()), (() => { const td = document.createElement("td"); const label = document.createElement("span"); label.className = `log-status log-status--${text(entry.status, "info")}`; label.textContent = `${entry.status === "failure" ? "✕" : entry.status === "success" ? "✓" : entry.status === "warn" ? "△" : "·"} ${text(entry.status, "info")}`; td.append(label); return td; })(), cell(text(entry.message, "No message")), cell(entry.details ? JSON.stringify(entry.details) : text(entry.category, "—"))); table.append(row); });
}

async function refreshLogs() {
  const source = encodeURIComponent($("#log-source").value); const level = encodeURIComponent($("#log-level").value); const query = encodeURIComponent($("#log-search").value.trim());
  renderLogs(await getJson(`/api/logs?source=${source}&level=${level}&q=${query}&limit=100`));
}

async function refresh({ announce = true } = {}) {
  if (state.busy) return;
  setBusy(true); setError(""); setConnection("loading", "Refreshing…");
  try {
    const overview = await getJson("/api/overview");
    renderOverview(overview);
    if (state.view === "positions") renderPositions(await getJson("/api/positions"));
    if (state.view === "flow") renderFlow(await getJson("/api/flow"));
    if (state.view === "logs") await refreshLogs();
    setConnection("ok", "Connected");
    $("#last-refresh").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (announce) setLive("Dashboard refreshed from read-only sources.");
  } catch (error) {
    setConnection("error", "Unavailable"); setError(`Dashboard refresh failed: ${error.message}. Local files may be empty or the server may be offline.`); if (announce) setLive("Dashboard refresh failed.");
  } finally { setBusy(false); }
}

function setView(view) {
  const next = ["overview", "positions", "flow", "logs"].includes(view) ? view : "overview";
  state.view = next;
  if (location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);
  for (const item of navItems) { const active = item.dataset.viewTarget === next; item.classList.toggle("is-active", active); item.setAttribute("aria-current", active ? "page" : "false"); }
  for (const section of views) { const active = section.dataset.view === next; section.classList.toggle("is-visible", active); section.hidden = !active; }
  $("#page-title").textContent = next === "positions" ? "Positions / PnL" : next === "flow" ? "Bot Flow" : next === "logs" ? "Logs" : "Overview";
  refresh({ announce: false });
}

for (const item of navItems) item.addEventListener("click", () => setView(item.dataset.viewTarget));
for (const item of $$('[data-go-view]')) item.addEventListener("click", () => setView(item.dataset.goView));
$("#refresh-button").addEventListener("click", () => refresh());
$("#logs-refresh").addEventListener("click", () => refreshLogs().catch((error) => setError(`Could not load logs: ${error.message}`)));
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
setView(location.hash.slice(1) || "overview");
refreshTimer = setInterval(() => refresh({ announce: false }), REFRESH_MS);
