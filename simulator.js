import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.resolve('logs');
const SIM_FILE = path.resolve('simulated-history.json');
const MAX_POSITIONS = 2;

function loadSim() {
  if (!fs.existsSync(SIM_FILE)) return { positions: [], summary: { total_closed: 0, wins: 0, losses: 0, total_pnl_sol: 0 } };
  const d = JSON.parse(fs.readFileSync(SIM_FILE, 'utf8'));
  if (!d.summary) d.summary = { total_closed: 0, wins: 0, losses: 0, total_pnl_sol: 0 };
  return d;
}
function saveSim(d) { fs.writeFileSync(SIM_FILE, JSON.stringify(d, null, 2)); }

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
      amount_sol: a.amount_y || 0.5,
      bins_below: a.bins_below || 0,
      bin_step: a.bin_step || 100,
      fee_tvl_ratio: a.fee_tvl_ratio || 0.1,
      entry_mcap: a.entry_mcap,
      entry_tvl: a.entry_tvl,
      entry_sol_price: null,
      closed: false,
    };
  } catch { return null; }
}

async function fetchPrice(poolAddress) {
  try {
    const resp = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + poolAddress);
    const data = await resp.json();
    const pair = (data.pairs || []).find(p => p.pairAddress === poolAddress && p.chainId === 'solana');
    return pair ? parseFloat(pair.priceNative) : null;
  } catch { return null; }
}

async function fetchPrices(pools) {
  const prices = {};
  for (const p of [...new Set(pools)]) {
    const price = await fetchPrice(p);
    if (price !== null) prices[p] = price;
    await new Promise(r => setTimeout(r, 350));
  }
  return prices;
}

function calcPnl(entryPrice, currentPrice, amountSol, hoursHeld, feeTvlRatio) {
  const ratio = entryPrice > 0 ? currentPrice / entryPrice : 1;
  const sqrtR = Math.sqrt(ratio);
  const ilFactor = entryPrice > 0 ? (2 * sqrtR) / (1 + ratio) : 1;
  const assetValue = amountSol * ilFactor;
  const feePct = 0.05 * hoursHeld * (feeTvlRatio / 0.1);
  const feeSol = amountSol * (feePct / 100);
  const pnlSol = assetValue + feeSol - amountSol;
  return {
    pnl_sol: pnlSol,
    pnl_pct: (pnlSol / amountSol) * 100,
    hours_held: hoursHeld,
  };
}

async function run(days) {
  const now = Date.now();
  const cutoff = new Date(now - days * 86400000);
  const todayISO = new Date().toISOString().slice(0, 10);

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

  // Sort chronological
  deploys.sort((a,b) => new Date(a.ts) - new Date(b.ts));

  const sim = loadSim();
  const knownIds = new Set(sim.positions.map(p => p.id));
  
  // Only process if we have room
  let openCount = sim.positions.filter(p => !p.closed).length;
  
  // Pre-fetch prices for existing open positions and new candidates
  const poolsToFetch = new Set(sim.positions.filter(p => !p.closed).map(p => p.pool_address));
  const newCandidates = deploys.filter(d => !knownIds.has(d.id));
  newCandidates.forEach(d => poolsToFetch.add(d.pool_address));
  
  const prices = await fetchPrices([...poolsToFetch]);

  // First, update existing open positions
  for (const ex of sim.positions.filter(p => !p.closed)) {
    const price = prices[ex.pool_address];
    if (!price) continue;
    
    const held = (now - new Date(ex.ts).getTime()) / 36e5;
    const pnl = calcPnl(ex.entry_sol_price, price, ex.amount_sol, held, ex.fee_tvl_ratio);
    ex.current_pnl_pct = pnl.pnl_pct;
    ex.current_pnl_sol = pnl.pnl_sol;
    ex.hours_held = held;
    
    if (pnl.pnl_pct <= -15 || pnl.pnl_pct >= 10 || held >= 24) {
      ex.closed = true;
      ex.closed_at = new Date().toISOString();
      ex.final_pnl_sol = pnl.pnl_sol;
      ex.final_pnl_pct = pnl.pnl_pct;
      sim.summary.total_closed++;
      pnl.pnl_sol > 0 ? sim.summary.wins++ : sim.summary.losses++;
      openCount--;
      console.log('CLOSE ' + (ex.pool_name||'?') + ': ' + pnl.pnl_pct.toFixed(1) + '% | ' + pnl.pnl_sol.toFixed(4) + ' SOL');
    }
  }

  // Second, admit new positions if we have slots
  for (const pos of newCandidates) {
    if (openCount >= MAX_POSITIONS) {
      // Skip it — simulator respects maxPositions
      continue;
    }
    
    const price = prices[pos.pool_address];
    if (!price) continue;

    pos.entry_sol_price = price;
    pos.current_pnl_pct = 0;
    sim.positions.push(pos);
    openCount++;
    console.log('NEW  ' + (pos.pool_name||'?').padEnd(18) + ' @ ' + price.toExponential(2) + ' SOL');
  }

  const closed = sim.positions.filter(p => p.closed);
  if (closed.length) {
    const tp = closed.reduce((s, p) => s + p.final_pnl_sol, 0);
    sim.summary.total_closed = closed.length;
    sim.summary.wins = closed.filter(p => p.final_pnl_sol > 0).length;
    sim.summary.losses = closed.filter(p => p.final_pnl_sol <= 0).length;
    sim.summary.total_pnl_sol = Math.round(tp * 10000) / 10000;
    sim.summary.win_rate = Math.round((sim.summary.wins / closed.length) * 100);
    sim.summary.avg_pnl_pct = Math.round(closed.reduce((s, p) => s + p.final_pnl_pct, 0) / closed.length * 100) / 100;
  }
  sim.summary.last_updated = new Date().toISOString();
  saveSim(sim);

  const open = sim.positions.filter(p => !p.closed);
  console.log('\n=== DRY RUN SIMULATOR ===');
  console.log('Max Slots: ' + MAX_POSITIONS + ' | Open: ' + open.length + ' | Ignored: ' + (newCandidates.length - (open.length - (sim.positions.length - newCandidates.length))));
  if (closed.length) {
    console.log('Win: ' + sim.summary.wins + ' | Loss: ' + sim.summary.losses + ' | Rate: ' + sim.summary.win_rate + '%');
  }
  if (open.length) {
    console.log('\nOpen Positions:');
    for (const p of open) {
      const h = ((now - new Date(p.ts).getTime()) / 36e5).toFixed(1);
      console.log('  ' + (p.pool_name||'?').padEnd(18) + ' ' + h + 'h | ' + (p.current_pnl_pct||0).toFixed(1) + '%');
    }
  }
}

const days = parseInt(process.argv[2]) || 1;
run(days).catch(e => { console.error(e.message); process.exit(1); });