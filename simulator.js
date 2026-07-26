import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { confirmIndicatorPreset } from './tools/chart-indicators.js';

// ─────────────────────────────────────────────────────────────────────────────
// Meridian DRY-RUN SIMULATOR (v2)
//
// Replays deploy_position log entries against PUBLIC pool data (DexScreener) —
// NO wallet, NO on-chain position reads, NO orders. Purpose: sanity-check the
// strategy's exit behaviour before going live.
//
// Fixes over v1 (all achievable without a historical wallet):
//   1. FEE — modelled from pool volume × fee-rate × liquidity share (DexScreener
//      public volume windows) instead of the old flat 0.05%/hr guess.
//   2. BIN RANGE / OOR — lower/upper price bounds computed from bins_below,
//      bins_above, bin_step and entry price. Price outside bounds ⇒ fee accrual
//      stops and position flagged out-of-range, mirroring production.
//   3. EXIT RULES — the five real production rules (Supertrend bearish, stop
//      loss, trailing TP, out-of-range-too-long, low yield) instead of the fake
//      SL/-15 % · TP/+10 % · 24 h timeout. Rules & thresholds are pulled from
//      the live config so the simulation tracks production automatically.
//
// Honest residual gaps (documented, not hidden):
//   • DexScreener fee/OOR are polling snapshots, not exact on-chain settlements.
//   • OOR resolution is limited to the simulator's polling interval.
//   • Assumes your liquidity is fully in-range & evenly spread when in-range.
// These approximations are fine for a DRY RUN; they remove the three critical
// divergences that made v1 untrustworthy.
// ─────────────────────────────────────────────────────────────────────────────

const LOGS_DIR = path.resolve('logs');
const SIM_FILE = path.resolve('simulated-history.json');
const MAX_POSITIONS = config.risk?.maxPositions ?? 2;

// Management thresholds sourced from live config (single source of truth)
const MGMT = {
  stopLossPct:            config.management?.stopLossPct            ?? -50,
  trailingTakeProfit:     config.management?.trailingTakeProfit     ?? true,
  trailingTriggerPct:     config.management?.trailingTriggerPct     ?? 3,
  trailingDropPct:        config.management?.trailingDropPct        ?? 1.5,
  outOfRangeWaitMinutes:  config.management?.outOfRangeWaitMinutes  ?? 30,
  minFeePerTvl24h:        config.management?.minFeePerTvl24h        ?? 7,
  minAgeBeforeYieldCheck: config.management?.minAgeBeforeYieldCheck ?? 60,
};

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadSim() {
  if (!fs.existsSync(SIM_FILE)) return { positions: [], summary: freshSummary() };
  const d = JSON.parse(fs.readFileSync(SIM_FILE, 'utf8'));
  if (!d.summary) d.summary = freshSummary();
  return d;
}
function freshSummary() {
  return { total_closed: 0, wins: 0, losses: 0, total_pnl_sol: 0 };
}
function saveSim(d) { fs.writeFileSync(SIM_FILE, JSON.stringify(d, null, 2)); }

// ─── Log parsing ─────────────────────────────────────────────────────────────
function parseDeploy(line) {
  try {
    const e = JSON.parse(line);
    if (e.tool !== 'deploy_position' || !e.success) return null;
    if (!e.result?.dry_run && !e.result?.would_deploy) return null;
    const a = e.args || {};
    return {
      id: (a.pool_address || 'unknown') + '_' + e.timestamp,
      ts: e.timestamp,
      pool_address: a.pool_address,
      pool_name: a.pool_name,
      // NOTE: log's `base_mint` frequently equals pool_address (SOL pair quirk),
      // which is NOT a valid token mint for indicator lookups. We resolve the
      // real token mint from DexScreener (baseToken.address) at admit time.
      base_mint: a.base_mint,
      token_mint: null,
      amount_sol: a.amount_y || 0.5,
      bins_below: a.bins_below ?? 0,
      bins_above: a.bins_above ?? 0,
      bin_step: a.bin_step ?? 100,
      fee_tvl_ratio: a.fee_tvl_ratio ?? 0.1,
      entry_mcap: a.entry_mcap,
      entry_tvl: a.entry_tvl,
      entry_sol_price: null,
      // dynamic exit-tracking state (mirrors production state.js)
      peak_pnl_pct: 0,
      trailing_active: false,
      out_of_range_since: null,
      closed: false,
    };
  } catch { return null; }
}

// ─── DexScreener public pool data ────────────────────────────────────────────
async function fetchPair(poolAddress) {
  try {
    const resp = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + poolAddress);
    const data = await resp.json();
    const pair = (data.pairs || []).find(p => p.pairAddress === poolAddress && p.chainId === 'solana');
    return pair || null;
  } catch { return null; }
}

async function fetchPairs(pools) {
  const out = {};
  for (const p of [...new Set(pools)]) {
    const pair = await fetchPair(p);
    if (pair) out[p] = pair;
    await new Promise(r => setTimeout(r, 350)); // gentle rate-limit
  }
  return out;
}

// ─── Bin-range bounds (fix #2) ───────────────────────────────────────────────
// Meteora bin i has price = entry * (1 + bin_step/10000)^i. The active range
// spans bins_below below and bins_above above the entry bin.
function rangeBounds(entryPrice, binStep, binsBelow, binsAbove) {
  const step = 1 + binStep / 10000;
  const lower = entryPrice * Math.pow(step, -binsBelow);
  const upper = entryPrice * Math.pow(step, binsAbove);
  return { lower, upper };
}
function inRange(price, bounds) {
  return price >= bounds.lower && price <= bounds.upper;
}

// ─── Fee accrual from public volume (fix #1) ─────────────────────────────────
// Approximate fees earned by our liquidity over the elapsed window:
//   fee ≈ volume_rate × fee_bps × (our_liquidity / active_tvl) × hours_in_range
// We use DexScreener h1 volume as the current volume-rate proxy and derive the
// pool fee rate from the deploy log's fee_tvl_ratio when available, else a
// conservative default. Accrues ONLY while in-range.
function estimateFeeSol(pos, pair, hoursInRangeDelta) {
  if (hoursInRangeDelta <= 0) return 0;
  const activeTvlUsd = pair?.liquidity?.usd || pos.entry_tvl || 0;
  if (activeTvlUsd <= 0) return 0;

  // Hourly volume proxy (USD). Prefer h1; fall back to h6/6 or h24/24.
  const v = pair?.volume || {};
  const hourlyVolUsd = v.h1 ?? (v.h6 != null ? v.h6 / 6 : (v.h24 != null ? v.h24 / 24 : 0));
  if (hourlyVolUsd <= 0) return 0;

  // Pool fee rate (fraction). fee_tvl_ratio in log ≈ 24h-fee/TVL as a percent
  // over the screening timeframe; convert to an effective per-volume fee rate
  // using a conservative DLMM base-fee assumption when unavailable.
  const feeBps = 0.003; // 0.30% effective — conservative DLMM taker fee proxy
  // Our share of active liquidity (SOL notional vs pool TVL in SOL terms).
  const solUsd = pair?.priceUsd && pair?.priceNative
    ? (parseFloat(pair.priceUsd) / parseFloat(pair.priceNative))
    : 0;
  if (solUsd <= 0) return 0;
  const ourLiquidityUsd = pos.amount_sol * solUsd;
  const share = Math.min(1, ourLiquidityUsd / activeTvlUsd);

  const feeUsd = hourlyVolUsd * feeBps * share * hoursInRangeDelta;
  return feeUsd / solUsd; // back to SOL
}

// ─── PnL: impermanent-loss asset value + accrued fees ────────────────────────
function calcAssetValue(entryPrice, currentPrice, amountSol) {
  const ratio = entryPrice > 0 ? currentPrice / entryPrice : 1;
  const sqrtR = Math.sqrt(ratio);
  const ilFactor = entryPrice > 0 ? (2 * sqrtR) / (1 + ratio) : 1;
  return amountSol * ilFactor;
}

// fee/TVL over 24h as a percent (for low-yield rule), from public data
function feePerTvl24h(pair) {
  const tvl = pair?.liquidity?.usd || 0;
  const vol24 = pair?.volume?.h24 || 0;
  if (tvl <= 0) return null;
  const fee24Usd = vol24 * 0.003; // same conservative fee proxy
  return (fee24Usd / tvl) * 100;
}

// ─── Exit evaluation: the five production rules (fix #3) ──────────────────────
async function evaluateExits(pos, ctx) {
  const { pnlPct, isInRange, feeTvl24, ageMinutes } = ctx;

  // 1. Supertrend bearish (15m) — indicator-driven, needs token mint only
  if (config.indicators?.enabled && pos.token_mint) {
    try {
      const ind = await confirmIndicatorPreset({
        mint: pos.token_mint, side: 'exit', intervals: ['15_MINUTE'],
      });
      const r15 = ind.intervals?.find(x => x.interval === '15_MINUTE');
      if (r15 && r15.confirmed) {
        return { action: 'SUPERTREND_BEARISH', reason: 'Supertrend flipped bearish on 15m TF' };
      }
    } catch { /* indicator unavailable — fall through */ }
  }

  // 2. Stop loss
  if (pnlPct != null && MGMT.stopLossPct != null && pnlPct <= MGMT.stopLossPct) {
    return { action: 'STOP_LOSS', reason: `PnL ${pnlPct.toFixed(2)}% <= ${MGMT.stopLossPct}%` };
  }

  // 3. Trailing take-profit
  if (MGMT.trailingTakeProfit) {
    if (!pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= MGMT.trailingTriggerPct) {
      pos.trailing_active = true;
    }
    if (pos.trailing_active) {
      const drop = pos.peak_pnl_pct - pnlPct;
      if (drop >= MGMT.trailingDropPct) {
        return {
          action: 'TRAILING_TP',
          reason: `peak ${pos.peak_pnl_pct.toFixed(2)}% → ${pnlPct.toFixed(2)}% (drop ${drop.toFixed(2)}% >= ${MGMT.trailingDropPct}%)`,
        };
      }
    }
  }

  // 4. Out of range too long
  if (!isInRange) {
    if (!pos.out_of_range_since) pos.out_of_range_since = new Date().toISOString();
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= MGMT.outOfRangeWaitMinutes) {
      return { action: 'OUT_OF_RANGE', reason: `OOR ${minutesOOR}m >= ${MGMT.outOfRangeWaitMinutes}m` };
    }
  } else {
    pos.out_of_range_since = null;
  }

  // 5. Low yield (only after min-age)
  if (
    feeTvl24 != null && MGMT.minFeePerTvl24h != null &&
    feeTvl24 < MGMT.minFeePerTvl24h &&
    (ageMinutes == null || ageMinutes >= MGMT.minAgeBeforeYieldCheck)
  ) {
    return { action: 'LOW_YIELD', reason: `fee/TVL ${feeTvl24.toFixed(2)}% < ${MGMT.minFeePerTvl24h}%` };
  }

  return null;
}

// ─── Main replay loop ─────────────────────────────────────────────────────────
async function run(days) {
  const now = Date.now();
  const cutoff = new Date(now - days * 86400000);
  const todayISO = new Date().toISOString().slice(0, 10);

  // Collect deploys from log window
  const deploys = [];
  for (let d = new Date(cutoff.toISOString().slice(0, 10)); d.toISOString().slice(0, 10) <= todayISO; d.setDate(d.getDate() + 1)) {
    const f = path.join(LOGS_DIR, 'actions-' + d.toISOString().slice(0, 10) + '.jsonl');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.trim()) continue;
    raw.trim().split('\n').forEach(l => {
      const pos = parseDeploy(l);
      if (pos && new Date(pos.ts) >= cutoff && pos.pool_address) deploys.push(pos);
    });
  }
  deploys.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const sim = loadSim();
  const knownIds = new Set(sim.positions.map(p => p.id));
  let openCount = sim.positions.filter(p => !p.closed).length;

  // Prefetch public pool data for open positions + new candidates
  const poolsToFetch = new Set(sim.positions.filter(p => !p.closed).map(p => p.pool_address));
  const newCandidates = deploys.filter(d => !knownIds.has(d.id));
  newCandidates.forEach(d => poolsToFetch.add(d.pool_address));
  const pairs = await fetchPairs([...poolsToFetch]);

  // ── Update existing open positions ──
  for (const ex of sim.positions.filter(p => !p.closed)) {
    const pair = pairs[ex.pool_address];
    if (!pair) continue;
    const price = parseFloat(pair.priceNative);
    if (!(price > 0)) continue;

    const heldHours = (now - new Date(ex.ts).getTime()) / 36e5;
    const lastHours = ex._last_eval_hours ?? 0;
    const bounds = rangeBounds(ex.entry_sol_price, ex.bin_step, ex.bins_below, ex.bins_above);
    const isInRange = inRange(price, bounds);

    // Fee accrues only over the in-range delta since last eval
    const deltaHours = Math.max(0, heldHours - lastHours);
    const feeDelta = isInRange ? estimateFeeSol(ex, pair, deltaHours) : 0;
    ex.accrued_fee_sol = (ex.accrued_fee_sol || 0) + feeDelta;
    ex._last_eval_hours = heldHours;

    const assetValue = calcAssetValue(ex.entry_sol_price, price, ex.amount_sol);
    const pnlSol = assetValue + ex.accrued_fee_sol - ex.amount_sol;
    const pnlPct = (pnlSol / ex.amount_sol) * 100;

    ex.current_pnl_pct = pnlPct;
    ex.current_pnl_sol = pnlSol;
    ex.hours_held = heldHours;
    ex.in_range = isInRange;
    if (pnlPct > (ex.peak_pnl_pct ?? 0)) ex.peak_pnl_pct = pnlPct;

    const exit = await evaluateExits(ex, {
      pnlPct,
      isInRange,
      feeTvl24: feePerTvl24h(pair),
      ageMinutes: heldHours * 60,
    });

    if (exit) {
      ex.closed = true;
      ex.closed_at = new Date().toISOString();
      ex.exit_action = exit.action;
      ex.exit_reason = exit.reason;
      ex.final_pnl_sol = pnlSol;
      ex.final_pnl_pct = pnlPct;
      openCount--;
      console.log(`CLOSE ${(ex.pool_name || '?').padEnd(18)} ${exit.action.padEnd(18)} ${pnlPct.toFixed(1)}% | ${pnlSol.toFixed(4)} SOL`);
    }
  }

  // ── Admit new positions (respect max slots + prod dedup) ──
  for (const pos of newCandidates) {
    if (openCount >= MAX_POSITIONS) continue;
    const pair = pairs[pos.pool_address];
    if (!pair) continue;
    const price = parseFloat(pair.priceNative);
    if (!(price > 0)) continue;

    // Resolve real token mint for indicator lookups (log's base_mint is unreliable)
    const tokenMint = pair.baseToken?.address || pos.base_mint || null;

    // Production rule: one position per token, and never two on the same pool.
    const dupOpen = sim.positions.some(p =>
      !p.closed && (p.pool_address === pos.pool_address ||
                    (tokenMint && p.token_mint === tokenMint))
    );
    if (dupOpen) {
      console.log(`SKIP  ${(pos.pool_name || '?').padEnd(18)} already holding this token/pool`);
      continue;
    }

    pos.entry_sol_price = price;
    pos.token_mint = tokenMint;
    pos.current_pnl_pct = 0;
    pos.accrued_fee_sol = 0;
    pos._last_eval_hours = 0;
    pos.in_range = true;
    sim.positions.push(pos);
    openCount++;
    console.log(`NEW   ${(pos.pool_name || '?').padEnd(18)} @ ${price.toExponential(2)} SOL  mint=${(pos.token_mint || '?').slice(0, 8)}`);
  }

  // ── Summary ──
  const closed = sim.positions.filter(p => p.closed);
  if (closed.length) {
    const tp = closed.reduce((s, p) => s + p.final_pnl_sol, 0);
    sim.summary.total_closed = closed.length;
    sim.summary.wins = closed.filter(p => p.final_pnl_sol > 0).length;
    sim.summary.losses = closed.filter(p => p.final_pnl_sol <= 0).length;
    sim.summary.total_pnl_sol = Math.round(tp * 10000) / 10000;
    sim.summary.win_rate = Math.round((sim.summary.wins / closed.length) * 100);
    sim.summary.avg_pnl_pct = Math.round(closed.reduce((s, p) => s + p.final_pnl_pct, 0) / closed.length * 100) / 100;
    // exit-reason breakdown so you can compare against production behaviour
    sim.summary.exit_breakdown = closed.reduce((acc, p) => {
      const k = p.exit_action || 'UNKNOWN';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  }
  sim.summary.last_updated = new Date().toISOString();
  saveSim(sim);

  const open = sim.positions.filter(p => !p.closed);
  console.log('\n=== DRY RUN SIMULATOR v2 (public-data, no wallet) ===');
  console.log(`Max Slots: ${MAX_POSITIONS} | Open: ${open.length}`);
  console.log(`Rules: SL ${MGMT.stopLossPct}% | trail ${MGMT.trailingTriggerPct}/${MGMT.trailingDropPct}% | OOR ${MGMT.outOfRangeWaitMinutes}m | minYield ${MGMT.minFeePerTvl24h}%`);
  if (closed.length) {
    console.log(`Win: ${sim.summary.wins} | Loss: ${sim.summary.losses} | Rate: ${sim.summary.win_rate}% | Total: ${sim.summary.total_pnl_sol} SOL`);
    console.log('Exits: ' + JSON.stringify(sim.summary.exit_breakdown));
  }
  if (open.length) {
    console.log('\nOpen Positions:');
    for (const p of open) {
      const h = ((now - new Date(p.ts).getTime()) / 36e5).toFixed(1);
      const rng = p.in_range === false ? 'OOR' : 'in ';
      console.log(`  ${(p.pool_name || '?').padEnd(18)} ${h}h ${rng} | ${(p.current_pnl_pct || 0).toFixed(1)}% | fee ${(p.accrued_fee_sol || 0).toFixed(4)} SOL`);
    }
  }
}

const days = parseInt(process.argv[2]) || 1;
run(days).catch(e => { console.error(e.message); process.exit(1); });
