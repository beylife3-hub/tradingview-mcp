#!/usr/bin/env node
/**
 * Hyperopt — Multi-Objective Grid Search
 *
 * Finds the best parameter combo for THIS bot on THIS symbol/TF.
 * Tests every combination of threshold × R:R × ATR-mult × max-hold,
 * ranks by chosen loss function, runs walk-forward stability check on top combos.
 *
 * Multi-objective loss functions (Freqtrade pattern):
 *   sharpe         — annualized Sharpe (default)
 *   sortino        — downside-risk-adjusted
 *   calmar         — return / max-DD (best OOS track record)
 *   maxDrawdown    — minimize DD (capital preservation focus)
 *   profitOnly     — maximize raw $ P&L
 *   expectancy     — expectancy × √trades (favors statistical significance)
 *
 * CLI:
 *   node bot/hyperopt.js --bars 800 --top 8 --min-trades 8
 *   node bot/hyperopt.js --bars 1000 --loss calmar --top 5
 */

import * as data from '../src/core/data.js';
import * as chart from '../src/core/chart.js';
import { disconnect } from '../src/connection.js';

import { simulate, metrics } from './backtest.js';

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      out[argv[i]] = (next == null || next.startsWith('--')) ? true : next;
      if (out[argv[i]] !== true) i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  bars:      Number(args['--bars']        ?? 800),
  top:       Number(args['--top']         ?? 8),
  minTrades: Number(args['--min-trades']  ?? 8),
  walkForward: Number(args['--wf']        ?? 4),
  symbol:    args['--symbol']    ?? null,
  timeframe: args['--tf']        ?? null,
  lossFn:    args['--loss']      ?? 'sharpe',
  startEquity: Number(args['--equity']    ?? 10000),
  feeBps:    Number(args['--fee-bps']     ?? 5),
  riskPct:   Number(args['--risk-pct']    ?? 1),
  color:     !('--no-color' in args),

  // Grid (override via flags if needed)
  thresholds:  (args['--thresholds']  ?? '5,5.5,6,6.5,7').split(',').map(Number),
  rrs:         (args['--rrs']         ?? '1.5,2,2.5,3').split(',').map(Number),
  atrMults:    (args['--atr-mults']   ?? '1,1.5,2').split(',').map(Number),
  maxHolds:    (args['--max-holds']   ?? '10,15,20,25').split(',').map(Number),
};

const C = CONFIG.color
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' }
  : new Proxy({}, { get: () => '' });

// ─── Loss functions ──────────────────────────────────────────────────────────

function tradeCountWeight(trades, minTrades) {
  if (trades < minTrades) return 0;
  return trades < 20 ? (trades / 20) * 0.5 : 1;
}

export const LOSS_FUNCTIONS = {
  sharpe(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    return (m.sharpe ?? 0) * w + (m.profitFactor > 1.5 ? 0.1 : 0);
  },
  sortino(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    return (m.sortino ?? m.sharpe ?? 0) * w;
  },
  calmar(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    return (m.calmar ?? 0) * w;
  },
  maxDrawdown(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    return -Math.abs(m.maxDrawdownPct ?? 100) * w + (m.totalPnl > 0 ? 1 : -1);
  },
  profitOnly(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    return (m.totalPnl ?? 0) * w;
  },
  expectancy(m, opts = {}) {
    const w = tradeCountWeight(m.trades, opts.minTrades ?? 5);
    if (w === 0) return -Infinity;
    const exp = m.expectancyR ?? 0;
    return exp * Math.sqrt(m.trades) * w;
  },
};

function score(m, lossFn) {
  const fn = LOSS_FUNCTIONS[lossFn] ?? LOSS_FUNCTIONS.sharpe;
  return fn(m, { minTrades: CONFIG.minTrades });
}

// ─── Bayesian (TPE-style) optimizer ─────────────────────────────────────────
// Tree-structured Parzen Estimator approximation: instead of full grid,
// adaptively sample combos based on prior performance. Per Optuna research:
// finds better params in 10-20 trials vs 1000s for grid.
//
// Simple TPE: split observed combos into "good" (top 25%) and "rest";
// for next sample, score candidate combos by p_good/p_rest ratio.

function sampleRandomCombo(grid) {
  return grid[Math.floor(Math.random() * grid.length)];
}

function comboKey(c) {
  return `${c.threshold}|${c.rewardRisk}|${c.atrMult}|${c.maxHoldBars}`;
}

function densityAt(combos, candidate) {
  // Naive Parzen: count combos within "small distance" of candidate
  let count = 0;
  for (const c of combos) {
    if (Math.abs(c.threshold   - candidate.threshold)   <= 0.5 &&
        Math.abs(c.rewardRisk  - candidate.rewardRisk)  <= 0.5 &&
        Math.abs(c.atrMult     - candidate.atrMult)     <= 0.5 &&
        Math.abs(c.maxHoldBars - candidate.maxHoldBars) <= 5) count++;
  }
  return count / Math.max(1, combos.length);
}

/**
 * Bayesian hyperopt — adaptive sampling.
 * Returns ordered list of trials, best on top.
 *
 * @param {Array} bars
 * @param {object} opts - { trials: number, lossFn: string }
 */
export async function bayesianHyperopt(bars, opts = {}) {
  const trials = opts.trials ?? 30;
  const lossFnName = opts.lossFn ?? 'sharpe';
  const fullGrid = buildGrid();
  const tried = new Map();   // key → { combo, lossScore }

  // Phase 1: 5 random warmup trials
  for (let i = 0; i < Math.min(5, fullGrid.length); i++) {
    const combo = sampleRandomCombo(fullGrid);
    const key = comboKey(combo);
    if (tried.has(key)) continue;
    const sim = simulate(bars, combo);
    const m = metrics(sim.trades, sim.equityCurve, combo.startEquity);
    tried.set(key, { combo, metrics: m, lossScore: score(m, lossFnName) });
  }

  // Phase 2: TPE-style adaptive sampling
  for (let i = 0; i < trials - 5; i++) {
    const all = [...tried.values()];
    if (all.length === 0) break;
    all.sort((a, b) => b.lossScore - a.lossScore);
    const goodCount = Math.max(1, Math.floor(all.length * 0.25));
    const good = all.slice(0, goodCount).map(x => x.combo);
    const bad  = all.slice(goodCount).map(x => x.combo);

    // Sample candidates from full grid not yet tried, score by p(good)/p(bad)
    let bestCandidate = null;
    let bestRatio = -Infinity;
    const candidates = [];
    for (let c = 0; c < 20; c++) {
      const cand = sampleRandomCombo(fullGrid);
      if (tried.has(comboKey(cand))) continue;
      candidates.push(cand);
    }
    if (!candidates.length) break;
    for (const cand of candidates) {
      const pG = densityAt(good, cand);
      const pB = densityAt(bad, cand);
      const ratio = pG / Math.max(0.01, pB);
      if (ratio > bestRatio) { bestRatio = ratio; bestCandidate = cand; }
    }
    if (!bestCandidate) bestCandidate = candidates[0];

    const sim = simulate(bars, bestCandidate);
    const m = metrics(sim.trades, sim.equityCurve, bestCandidate.startEquity);
    tried.set(comboKey(bestCandidate), { combo: bestCandidate, metrics: m, lossScore: score(m, lossFnName) });
  }

  return [...tried.values()].sort((a, b) => b.lossScore - a.lossScore);
}

// ─── Build grid ──────────────────────────────────────────────────────────────

function buildGrid() {
  const out = [];
  for (const threshold of CONFIG.thresholds)
    for (const rewardRisk of CONFIG.rrs)
      for (const atrMult of CONFIG.atrMults)
        for (const maxHoldBars of CONFIG.maxHolds)
          out.push({ threshold, rewardRisk, atrMult, maxHoldBars,
                     riskPct: CONFIG.riskPct, startEquity: CONFIG.startEquity, feeBps: CONFIG.feeBps });
  return out;
}

// ─── Walk-forward stability ─────────────────────────────────────────────────

function walkForwardStability(bars, combo, nWindows = 4) {
  const chunkSize = Math.floor(bars.length / nWindows);
  let positiveWindows = 0;
  for (let w = 0; w < nWindows; w++) {
    const start = w * chunkSize;
    const end = w === nWindows - 1 ? bars.length : start + chunkSize;
    const sim = simulate(bars.slice(start, end), combo);
    const m = metrics(sim.trades, sim.equityCurve, combo.startEquity);
    if (m.totalPnl > 0) positiveWindows++;
  }
  return { positiveWindows, totalWindows: nWindows };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}HYPEROPT — Multi-Objective Grid Search${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);

  if (CONFIG.symbol)    { await chart.setSymbol({ symbol: CONFIG.symbol });   await new Promise(r=>setTimeout(r,1500)); }
  if (CONFIG.timeframe) { await chart.setTimeframe({ timeframe: CONFIG.timeframe }); await new Promise(r=>setTimeout(r,1500)); }

  const state = await chart.getState();
  console.log(`${C.dim}Symbol: ${state.symbol}  Timeframe: ${state.resolution}m  Bars: ${CONFIG.bars}  Loss: ${CONFIG.lossFn}${C.reset}`);

  const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
  if (!ohlcv.success || !ohlcv.bars) throw new Error('Could not fetch bars');
  const bars = ohlcv.bars;
  console.log(`${C.green}✓${C.reset} Loaded ${bars.length} bars`);

  const grid = buildGrid();
  console.log(`${C.dim}ℹ${C.reset} Running ${grid.length} combinations (${CONFIG.thresholds.length}×${CONFIG.rrs.length}×${CONFIG.atrMults.length}×${CONFIG.maxHolds.length})...`);

  const results = [];
  let prog = 0;
  for (const combo of grid) {
    const sim = simulate(bars, combo);
    const m = metrics(sim.trades, sim.equityCurve, combo.startEquity);
    results.push({ combo, metrics: m, lossScore: score(m, CONFIG.lossFn) });
    prog++;
    if (prog % Math.max(1, Math.floor(grid.length / 20)) === 0) process.stdout.write('.');
  }
  console.log(' done');

  // Rank by chosen loss function
  const valid = results
    .filter(r => r.lossScore > -Infinity)
    .sort((a, b) => b.lossScore - a.lossScore);

  console.log(`\n${C.cyan}━━━ TOP ${CONFIG.top} COMBOS — ranked by ${CONFIG.lossFn} ━━━${C.reset}\n`);
  console.log(`  ${C.dim}Rank  Thresh  RR    ATR×  Hold  Trades  WinR     PF     Sharpe   Calmar   Total P&L${C.reset}`);
  for (let i = 0; i < Math.min(CONFIG.top, valid.length); i++) {
    const { combo: c, metrics: m } = valid[i];
    const pnlColor = m.totalPnl >= 0 ? C.green : C.red;
    console.log(`  #${(i+1).toString().padStart(2)}   ${c.threshold.toString().padStart(4)}    ${c.rewardRisk.toString().padStart(4)}  ${c.atrMult.toString().padStart(4)}  ${c.maxHoldBars.toString().padStart(4)}  ${m.trades.toString().padStart(5)}   ${(m.winRate*100).toFixed(1).padStart(5)}%   ${m.profitFactor.toFixed(2).padStart(5)}   ${m.sharpe.toFixed(2).padStart(6)}   ${m.calmar.toFixed(2).padStart(6)}   ${pnlColor}${(m.totalPnl >= 0 ? '+' : '') + '$' + m.totalPnl.toFixed(0)}${C.reset}`);
  }

  // ─── Walk-forward stability on top 3 ──────────────────────────────────────
  console.log(`\n${C.cyan}━━━ WALK-FORWARD STABILITY — Top 3 Combos ━━━${C.reset}`);
  console.log(`${C.dim}  (Stability = % of walk-forward windows that were profitable)${C.reset}\n`);

  const top3 = valid.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    const { combo: c, metrics: m } = top3[i];
    const wf = walkForwardStability(bars, c, CONFIG.walkForward);
    const pct = wf.positiveWindows / wf.totalWindows;
    const verdict = pct >= 0.75 ? `${C.green}STABLE — passes walk-forward${C.reset}` :
                    pct >= 0.50 ? `${C.yellow}MIXED — fragile${C.reset}` :
                                  `${C.red}CURVE-FIT — fails walk-forward${C.reset}`;
    console.log(`  ${C.bold}#${i+1}${C.reset} thr=${c.threshold} rr=${c.rewardRisk} atr×${c.atrMult} hold=${c.maxHoldBars}`);
    console.log(`     WF stability: ${wf.positiveWindows}/${wf.totalWindows} (${(pct*100).toFixed(0)}%) — ${verdict}`);
    console.log(`     Sharpe: ${m.sharpe.toFixed(2)}  PF: ${m.profitFactor.toFixed(2)}  Trades: ${m.trades}\n`);
  }

  // ─── Final recommendation ─────────────────────────────────────────────────
  if (valid.length) {
    const best = valid[0];
    const wf = walkForwardStability(bars, best.combo, CONFIG.walkForward);
    console.log(`${C.cyan}━━━ RECOMMENDED PARAMETERS ━━━${C.reset}\n`);
    console.log(`  ${C.dim}Symbol / TF                 ${C.reset}${state.symbol} / ${state.resolution}m`);
    console.log(`  ${C.dim}Threshold                   ${C.reset}${best.combo.threshold}`);
    console.log(`  ${C.dim}Reward:Risk                 ${C.reset}${best.combo.rewardRisk}:1`);
    console.log(`  ${C.dim}ATR multiplier              ${C.reset}${best.combo.atrMult}×`);
    console.log(`  ${C.dim}Max hold bars               ${C.reset}${best.combo.maxHoldBars}`);
    console.log(`  ${C.dim}Backtest Sharpe             ${C.reset}${C.green}${best.metrics.sharpe.toFixed(2)}${C.reset}`);
    console.log(`  ${C.dim}Backtest PF                 ${C.reset}${C.green}${best.metrics.profitFactor.toFixed(2)}${C.reset}`);
    console.log(`  ${C.dim}Win rate                    ${C.reset}${(best.metrics.winRate*100).toFixed(1)}%`);
    console.log(`  ${C.dim}Total P&L                   ${C.reset}${best.metrics.totalPnl >= 0 ? C.green : C.red}${(best.metrics.totalPnl >= 0 ? '+' : '') + '$' + best.metrics.totalPnl.toFixed(0)}${C.reset}`);
    console.log(`  ${C.dim}WF stability                ${C.reset}${wf.positiveWindows}/${wf.totalWindows} ${wf.positiveWindows >= 3 ? C.green + '✓' + C.reset : C.yellow + '⚠' + C.reset}`);
    console.log(`\n  ${C.dim}Copy these into live-stream.js or pass as CLI flags:${C.reset}`);
    console.log(`  ${C.cyan}node bot/live-stream.js --live --draw --min-score ${best.combo.threshold} --target-rr ${best.combo.rewardRisk}${C.reset}`);
  }

  // ─── Sensitivity heatmap (threshold × RR) ─────────────────────────────────
  console.log(`\n${C.cyan}━━━ SENSITIVITY HEATMAP — Threshold × R:R (best Sharpe per cell) ━━━${C.reset}\n`);
  const cells = new Map();
  for (const r of valid) {
    const key = `${r.combo.threshold}|${r.combo.rewardRisk}`;
    if (!cells.has(key) || cells.get(key).metrics.sharpe < r.metrics.sharpe) cells.set(key, r);
  }
  process.stdout.write('         ');
  for (const rr of CONFIG.rrs) process.stdout.write(`RR=${rr.toString().padEnd(7)}`);
  console.log();
  for (const thr of CONFIG.thresholds) {
    process.stdout.write(`  thr=${thr.toString().padEnd(4)}`);
    for (const rr of CONFIG.rrs) {
      const cell = cells.get(`${thr}|${rr}`);
      if (cell) {
        const s = cell.metrics.sharpe;
        const color = s > 1.5 ? C.green : s > 0.5 ? C.yellow : C.red;
        process.stdout.write(`${color}${s.toFixed(2).padStart(7)}(${cell.metrics.trades})${C.reset} `);
      } else {
        process.stdout.write('    -    ');
      }
    }
    console.log();
  }

  await disconnect().catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    console.error('Fatal:', e.message); console.error(e.stack);
    await disconnect().catch(() => {});
    process.exit(1);
  });
}
