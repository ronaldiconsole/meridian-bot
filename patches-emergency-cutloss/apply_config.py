import sys

p = 'config.js'
s = open(p).read()

# ── Add emergencyCutloss config block after stopLossPct line ──
old = '''    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,'''
new = '''    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    // Emergency cutloss — strict fast-exit protection (Plan B)
    emergencyStopLossPct:  u.emergencyStopLossPct  ?? -35, // 1-tick panic close threshold (no confirmTicks wait)
    circuitBreakerDrawdownPct: u.circuitBreakerDrawdownPct ?? -30, // total unrealized loss % of wallet to halt new deploys
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,'''
assert s.count(old) == 1, 'config stopLossPct anchor not found'
s = s.replace(old, new)

# ── Add risk.circuitBreakerPauseHours ──
old = '''  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },'''
new = '''  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    circuitBreakerPauseHours: u.circuitBreakerPauseHours ?? 4, // halt new deploys for N hours after breaker trips
  },'''
assert s.count(old) == 1, 'config risk block not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('config.js OK')
