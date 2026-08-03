import sys

p = 'tools/dlmm.js'
s = open(p).read()

# 1) Import getVirtualPositions
old = '''import { computePositions, fetchDlmmPnlForPool } from "./pnl.js";'''
new = '''import { computePositions, fetchDlmmPnlForPool, getVirtualPositions } from "./pnl.js";'''
assert s.count(old) == 1, 'import line not found'
s = s.replace(old, new)

# 2) Merge virtual positions into getMyPositions result (RPC path)
old = '''        if (useLocalWallet) {
          syncOpenPositions(rpcResult.positions.map((p) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;'''
new = '''        if (useLocalWallet) {
          syncOpenPositions(rpcResult.positions.map((p) => p.position));
          // DRY RUN: merge locally-tracked virtual positions so the fast poller
          // sees them and can enforce stop-loss/exit rules (they never appear
          // on-chain).
          if (process.env.DRY_RUN === "true") {
            const virtual = await getVirtualPositions().catch(() => []);
            const existing = new Set(rpcResult.positions.map((p) => p.position));
            const merged = [...rpcResult.positions, ...virtual.filter((v) => !existing.has(v.position))];
            rpcResult = { ...rpcResult, positions: merged, total_positions: merged.length, virtual_count: virtual.length };
          }
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;'''
assert s.count(old) == 1, 'RPC merge block not found'
s = s.replace(old, new)

# 3) Merge virtual positions into getMyPositions result (Meteora fallback path)
old = '''    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      syncOpenPositions(positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;'''
new = '''    let result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      syncOpenPositions(positions.map(p => p.position));
      if (process.env.DRY_RUN === "true") {
        const virtual = await getVirtualPositions().catch(() => []);
        const existing = new Set(result.positions.map((p) => p.position));
        const merged = [...result.positions, ...virtual.filter((v) => !existing.has(v.position))];
        result = { ...result, positions: merged, total_positions: merged.length, virtual_count: virtual.length };
      }
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;'''
assert s.count(old) == 1, 'Meteora merge block not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('dlmm.js merge OK')
