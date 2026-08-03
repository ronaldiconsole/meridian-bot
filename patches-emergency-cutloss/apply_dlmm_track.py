import sys

p = 'tools/dlmm.js'
s = open(p).read()

# 1) Pass entry_price/base_mint/quote_mint into trackPosition in DRY RUN branch
old = '''        active_bin: activeBin.binId,
        bin_step: actualBinStep,
        volatility: normalizedVolatility,
        fee_tvl_ratio,
        organic_score,
        initial_value_usd,
        entry_mcap,
        entry_tvl,
        entry_volume,
        entry_holders,
      });'''
new = '''        active_bin: activeBin.binId,
        bin_step: actualBinStep,
        volatility: normalizedVolatility,
        fee_tvl_ratio,
        organic_score,
        initial_value_usd,
        entry_mcap,
        entry_tvl,
        entry_volume,
        entry_holders,
        entry_price: activePrice,
        base_mint: baseMint,
        quote_mint: pool.lbPair.tokenYMint.toString(),
      });'''
assert s.count(old) == 1, 'dry-run trackPosition block not found'
s = s.replace(old, new)

open(p, 'w').write(s)
print('dlmm.js dry-run track OK')
