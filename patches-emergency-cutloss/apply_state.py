import sys

p = 'state.js'
s = open(p).read()

old1 = '''  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {'''
new1 = '''  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  entry_price = null,
  base_mint = null,
  quote_mint = null,
}) {'''
assert s.count(old1) == 1, 'param block not found'
s = s.replace(old1, new1)

old1b = '''    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,'''
new1b = '''    entry_volume,
    entry_holders,
    entry_price,
    base_mint,
    quote_mint,
    signal_snapshot: signal_snapshot || null,'''
assert s.count(old1b) == 1, 'store block not found'
s = s.replace(old1b, new1b)

old2 = '''  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period:'''
new2 = '''  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Dry-run virtual positions are never on-chain — never auto-close them here.
    if (pos.dry_run === true) continue;

    // Grace period:'''
assert s.count(old2) == 1, 'sync block not found'
s = s.replace(old2, new2)

open(p, 'w').write(s)
print('state.js OK')
