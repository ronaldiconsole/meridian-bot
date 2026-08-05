import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  safeJsonFile,
  safeJsonlFile,
  readLogs,
  readDashboardData,
  getFlowSnapshot,
} from "../dashboard-data.js";

function makeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-dashboard-"));
  fs.mkdirSync(path.join(rootDir, "logs"));
  fs.writeFileSync(path.join(rootDir, "state.json"), JSON.stringify({
    lastUpdated: "2026-08-05T10:00:00.000Z",
    positions: {
      pos_open: {
        position: "pos_open",
        pool: "pool_1",
        pool_name: "SOL / TEST",
        strategy: "bid_ask",
        amount_sol: 0.5,
        initial_value_usd: 100,
        deployed_at: "2026-08-05T09:00:00.000Z",
        out_of_range_since: null,
        total_fees_claimed_usd: 1.25,
        closed: false,
        peak_pnl_pct: 4.2,
        trailing_active: true,
      },
    },
    recentEvents: [{ ts: "2026-08-05T10:00:00.000Z", action: "deploy", position: "pos_open" }],
  }));
  fs.writeFileSync(path.join(rootDir, "lessons.json"), JSON.stringify({
    performance: [{ pnl_usd: 12, fees_earned_usd: 2, recorded_at: "2026-08-05T09:30:00.000Z" }],
    lessons: [],
  }));
  fs.writeFileSync(path.join(rootDir, "decision-log.json"), JSON.stringify({
    decisions: [{
      id: "dec_1",
      ts: "2026-08-05T09:59:00.000Z",
      type: "skip",
      actor: "SCREENER",
      pool_name: "SOL / TEST",
      summary: "Waiting for a stronger candidate",
      reason: "fee ratio below threshold",
      risks: [],
      metrics: {},
      rejected: [],
    }],
  }));
  fs.writeFileSync(path.join(rootDir, "logs", "agent-2026-08-05.log"), [
    "[2026-08-05T10:01:00.000Z] [CRON] Starting management cycle",
    "[2026-08-05T10:01:01.000Z] [SAFETY_BLOCK] close_position blocked: missing position",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(rootDir, "logs", "actions-2026-08-05.jsonl"), [
    JSON.stringify({ timestamp: "2026-08-05T10:01:02.000Z", tool: "close_position", success: false, error: "blocked", duration_ms: 2, args: { position_address: "pos_open", private_key: "do-not-leak" } }),
    "not-json",
    JSON.stringify({ timestamp: "2026-08-05T10:01:03.000Z", tool: "get_my_positions", success: true, result: { total_positions: 1 }, args: {} }),
  ].join("\n") + "\n");
  return rootDir;
}

test("safe JSON readers return fallbacks and reject secret paths", () => {
  const rootDir = makeFixture();
  assert.deepEqual(safeJsonFile(path.join(rootDir, "missing.json"), { fallback: true }, { rootDir }), { fallback: true });
  assert.throws(
    () => safeJsonFile(path.join(rootDir, ".env"), {}, { rootDir }),
    /not allowed/i,
  );
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("JSONL reader skips malformed lines and respects a hard limit", () => {
  const rootDir = makeFixture();
  const entries = safeJsonlFile(path.join(rootDir, "logs", "actions-2026-08-05.jsonl"), { rootDir, limit: 1 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, "close_position");
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("readLogs normalizes runtime, action, and decision sources with filters", () => {
  const rootDir = makeFixture();
  const result = readLogs({ rootDir, source: "all", level: "failure", limit: 20 });
  assert.ok(result.entries.length >= 2);
  assert.ok(result.entries.every((entry) => entry.status === "failure"));
  assert.ok(result.entries.some((entry) => entry.source === "actions"));
  assert.ok(result.entries.some((entry) => entry.source === "runtime"));
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("flow snapshot maps the latest safety event to the safety stage", () => {
  const flow = getFlowSnapshot({
    logs: [{
      timestamp: "2026-08-05T10:01:01.000Z",
      category: "SAFETY_BLOCK",
      message: "close_position blocked",
      source: "runtime",
    }],
  });
  assert.equal(flow.active_stage, "safety");
  assert.ok(flow.flow_nodes.some((node) => node.id === "safety"));
});

test("dashboard data prefers live positions and keeps local performance summary", async () => {
  const rootDir = makeFixture();
  const data = await readDashboardData({
    rootDir,
    liveReader: async () => ({
      source: "test-live",
      positions: [{
        position: "pos_open",
        pool: "pool_1",
        pair: "SOL / TEST",
        total_value_usd: 110,
        pnl_usd: 10,
        pnl_pct: 10,
        unclaimed_fees_usd: 3,
        in_range: true,
        lower_bin: 1,
        upper_bin: 10,
        active_bin: 5,
        minutes_out_of_range: 0,
      }],
    }),
  });
  assert.equal(data.positions[0].pnl_pct, 10);
  assert.equal(data.summary.open_positions, 1);
  assert.equal(data.summary.realized_pnl_usd, 12);
  assert.equal(data.summary.data_status, "live");
  fs.rmSync(rootDir, { recursive: true, force: true });
});
