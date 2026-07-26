#!/bin/bash
echo "{ \"positions\": {}, \"recentEvents\": [], \"lastUpdated\": \"2026-07-08T07:22:25.230Z\" }" > state.json
echo "{ \"positions\": [], \"summary\": { \"wins\": 0, \"losses\": 0, \"total_pnl_sol\": 0, \"avg_pnl_pct\": 0 } }" > simulated-history.json
echo "[]" > decision-log.json
echo "{}" > signal-weights.json
echo "[]" > pool-memory.json 2>/dev/null || true
echo "[]" > token-blacklist.json 2>/dev/null || true
echo "[]" > dev-blocklist.json 2>/dev/null || true
echo "Data reset complete."
