import sys

p = 'index.js'
s = open(p).read()

# ═══ 1) Fix sanity gate: pnl <= -90% should NOT be auto-skipped if it's a
#       stop-loss OR the position has essentially no value left (rug-pull).
#       Previously ANY pnl <= -90% (non-stop-loss) was treated as "suspect" and
#       the position was never closed — exactly the Chiikawa -91% freeze.
old = '''    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();'''
new = '''    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    // Severe loss: -90% or worse is a rug-pull / near-total loss. Only skip when
    // the position demonstrably still holds value (unsettled data). If value is
    // ~0, treat as REAL and let stop-loss / emergency rules close it.
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    log("cron_warn", `Severe PnL for ${position.pair}: ${position.pnl_pct}% with ~0 value — treating as real, will close`);
    return false;
  })();'''
assert s.count(old) == 1, 'sanity gate block not found'
s = s.replace(old, new)

# ═══ 2) Panic close: emergencyStopLossPct closes on FIRST tick (no confirmTicks).
#       This runs in getDeterministicCloseRule so both the fast poller (3s) and
#       management cycle (10m) honor it. Inserted right after the stop-loss rule.
old = '''  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }'''
new = '''  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  // Emergency panic close — one tick, no confirmation wait. Catches fast rug-pulls
  // between the -20% stop loss and total wipeout. confirmer bypassed in poller.
  if (!pnlSuspect && position.pnl_pct != null && managementConfig.emergencyStopLossPct != null
      && position.pnl_pct <= managementConfig.emergencyStopLossPct) {
    return { action: "CLOSE", rule: 9, reason: `EMERGENCY STOP LOSS (${position.pnl_pct.toFixed(2)}% <= ${managementConfig.emergencyStopLossPct}%)` };
  }'''
assert s.count(old) == 1, 'stop loss rule block not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('index.js rules OK')
