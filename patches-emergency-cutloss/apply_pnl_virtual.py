import sys

p = 'tools/pnl.js'
s = open(p).read()

# ── Add virtual position PnL engine after getJupiterPrices (line ~100) ──
anchor = '''// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────'''
addition = '''// ─── Dry-run virtual position PnL engine ────────────────────────
// DRY RUN tracks positions locally (state.json) — they never exist on-chain,
// so getMyPositions() returns [] for them and the fast 3s PnL poller can never
// fire the stop-loss / exit rules. This engine prices each open virtual
// position from the live token price (Jupiter) vs the entry price captured at
// deploy time, producing the same position shape the poller expects.
import { getTrackedPositions } from "../state.js";

export async function getVirtualPositions() {
  const dryRun = process.env.DRY_RUN === "true";
  const tracked = getTrackedPositions(true).filter((p) => p.dry_run === true);
  if (!dryRun || tracked.length === 0) return [];

  // Entry price: store SOL-per-token at deploy (activeBin price, native).
  // If entry_price is missing (legacy virtual positions), fall back to the
  // entry mcap/holders heuristic — but only if we have a usable price.
  const prices = await getJupiterPrices(
    tracked.map((t) => t.base_mint || t.pool_name).filter(Boolean)
  );

  const positions = [];
  for (const t of tracked) {
    const baseMint = t.base_mint;
    const entryPrice = t.entry_price; // SOL per token at deploy
    const curPriceSol = prices[baseMint]; // SOL per token now (Jupiter USD/SOL)
    if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      // Cannot price — emit position with null pnl so rules stay paused, but
      // keep it visible so the poller doesn't drop it silently.
      positions.push(virtualPositionShape(t, null));
      continue;
    }
    const pnlPct = ((curPriceSol - entryPrice) / entryPrice) * 100;
    const amountSol = t.amount_sol || 0;
    const pnlSol = (pnlPct / 100) * amountSol;
    positions.push(virtualPositionShape(t, { pnl_pct: pnlPct, pnl_sol: pnlSol, price_sol: curPriceSol }));
  }
  return positions;
}

function virtualPositionShape(t, pnl) {
  return {
    position: t.position,
    pool: t.pool,
    pair: t.pool_name || t.pool,
    base_mint: t.base_mint,
    lower_bin: t.bin_range?.min ?? null,
    upper_bin: t.bin_range?.max ?? null,
    active_bin: t.active_bin_at_deploy ?? null,
    in_range: true,
    unclaimed_fees_usd: 0,
    total_value_usd: t.amount_sol || 0,
    total_value_true_usd: t.amount_sol || 0,
    collected_fees_usd: 0,
    collected_fees_true_usd: 0,
    pnl_usd: pnl ? Math.round(pnl.pnl_sol * 100) / 100 : null,
    pnl_true_usd: pnl ? Math.round(pnl.pnl_sol * 100) / 100 : null,
    pnl_pct: pnl ? Math.round(pnl.pnl_pct * 100) / 100 : null,
    pnl_pct_derived: pnl ? Math.round(pnl.pnl_pct * 100) / 100 : null,
    pnl_pct_diff: 0,
    pnl_pct_suspicious: !pnl,
    unclaimed_fees_true_usd: 0,
    fee_per_tvl_24h: null,
    age_minutes: t.deployed_at ? Math.floor((Date.now() - new Date(t.deployed_at).getTime()) / 60000) : null,
    minutes_out_of_range: 0,
    instruction: t.instruction || null,
    dry_run: true,
    _virtual: true,
  };
}

'''
assert s.count(anchor) == 1, 'pnl.js anchor not found'
s = s.replace(anchor, addition + anchor)

open(p, 'w').write(s)
print('pnl.js virtual engine OK')
