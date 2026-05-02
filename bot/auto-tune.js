#!/usr/bin/env node
/**
 * Auto-Tune — scheduled hyperopt re-run + auto-deploy of best params.
 *
 * Run nightly via cron. Reads recent N bars per (symbol, TF), runs hyperopt
 * grid search with walk-forward stability check, picks the most stable
 * combo per symbol, writes to bot/journal/optimal-params.json.
 *
 * Live-stream auto-loads optimal-params.json on each tick — so the bot
 * stays calibrated as market regime shifts WITHOUT manual intervention.
 *
 * Cron example (run every day at 17:00 ET, after US RTH close):
 *   00 17 * * 1-5  cd ~/tradingview-mcp && node bot/auto-tune.js >> /tmp/auto-tune.log 2>&1
 *
 * CLI:
 *   node bot/auto-tune.js                    tune default watchlist
 *   node bot/auto-tune.js --symbols TSLA,NVDA --bars 1500
 *   node bot/auto-tune.js --loss calmar --notify-telegram
 */

import * as chart from '../src/core/chart.js';
import * as data  from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

import { simulate, metrics } from './backtest.js';
import { LOSS_FUNCTIONS } from './hyperopt.js';
import { send, isEnabled } from './notify.js';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARAMS_PATH = join(__dirname, 'journal', 'optimal-params.json');

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

const DEFAULT_WATCHLIST = [
  'NASDAQ:NVDA', 'NASDAQ:TSLA', 'NASDAQ:AMD',
  'AMEX:SPY', 'NASDAQ:QQQ',
  'BINANCE:BTCUSDT.P', 'COINBASE:ETHUSD',
];

const CONFIG = {
  symbols: args['--symbols'] ? args['--symbols'].split(',').map(s => s.trim()) : DEFAULT_WATCHLIST,
  bars:    Number(args['--bars'] ?? 1200),
  tf:      args['--tf'] ?? null,
  lossFn:  args['--loss'] ?? 'calmar',
  minStability: Number(args['--min-stability'] ?? 0.75),
  notifyTelegram: '--notify-telegram' in args,

  // Smaller grid for nightly runs — full grid takes too long per symbol
  thresholds:  (args['--thresholds']  ?? '5.5,6,6.5,7').split(',').map(Number),
  rrs:         (args['--rrs']         ?? '1.5,2,2.5').split(',').map(Number),
  atrMults:    (args['--atr-mults']   ?? '1,1.5,2').split(',').map(Number),
  maxHolds:    (args['--max-holds']   ?? '15,20,25').split(',').map(Number),

  startEquity: 10000, feeBps: 5, riskPct: 1,
};

function loadParams() {
  try { if (!existsSync(PARAMS_PATH)) return {}; return JSON.parse(readFileSync(PARAMS_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveParams(p) {
  mkdirSync(dirname(PARAMS_PATH), { recursive: true });
  writeFileSync(PARAMS_PATH, JSON.stringify(p, null, 2));
}

// ─── Per-symbol tune ─────────────────────────────────────────────────────────

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

function walkForwardPositive(bars, combo, nWindows = 4) {
  const chunkSize = Math.floor(bars.length / nWindows);
  let positive = 0;
  for (let w = 0; w < nWindows; w++) {
    const start = w * chunkSize;
    const end = w === nWindows - 1 ? bars.length : start + chunkSize;
    const sim = simulate(bars.slice(start, end), combo);
    const m = metrics(sim.trades, sim.equityCurve, combo.startEquity);
    if (m.totalPnl > 0) positive++;
  }
  return { positive, total: nWindows, ratio: positive / nWindows };
}

async function tuneSymbol(symbol) {
  console.log(`\n→ Tuning ${symbol}...`);
  try {
    await chart.setSymbol({ symbol });
    await new Promise(r => setTimeout(r, 1500));
    if (CONFIG.tf) {
      await chart.setTimeframe({ timeframe: CONFIG.tf });
      await new Promise(r => setTimeout(r, 1200));
    }

    const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
    if (!ohlcv.success || !ohlcv.bars || ohlcv.bars.length < 200) {
      console.log(`  ✗ insufficient bars (${ohlcv.bars?.length || 0})`);
      return null;
    }
    const bars = ohlcv.bars;

    const grid = buildGrid();
    const lossFn = LOSS_FUNCTIONS[CONFIG.lossFn] ?? LOSS_FUNCTIONS.calmar;
    const results = [];
    for (const combo of grid) {
      const sim = simulate(bars, combo);
      const m = metrics(sim.trades, sim.equityCurve, combo.startEquity);
      const lossScore = lossFn(m, { minTrades: 8 });
      results.push({ combo, metrics: m, lossScore });
    }

    // Sort by loss function, take top 5, run walk-forward stability check
    results.sort((a, b) => b.lossScore - a.lossScore);
    let best = null;
    for (const r of results.slice(0, 5)) {
      if (r.lossScore <= -Infinity) continue;
      const wf = walkForwardPositive(bars, r.combo);
      if (wf.ratio >= CONFIG.minStability) {
        best = { ...r, walkForward: wf };
        break;
      }
    }

    if (!best) {
      console.log(`  ⚠ no combo passed walk-forward stability (${CONFIG.minStability * 100}%)`);
      return null;
    }

    const c = best.combo;
    const m = best.metrics;
    console.log(`  ✓ ${c.threshold}/${c.rewardRisk}/${c.atrMult}×/${c.maxHoldBars}  trades:${m.trades} sharpe:${m.sharpe.toFixed(2)} pf:${m.profitFactor.toFixed(2)} pnl:${m.totalPnl >= 0 ? '+' : ''}$${m.totalPnl.toFixed(0)} WF:${best.walkForward.positive}/${best.walkForward.total}`);

    return {
      symbol,
      tunedAt: new Date().toISOString(),
      params: {
        threshold:   c.threshold,
        rewardRisk:  c.rewardRisk,
        atrMult:     c.atrMult,
        maxHoldBars: c.maxHoldBars,
      },
      metrics: {
        trades: m.trades, sharpe: m.sharpe, calmar: m.calmar, pf: m.profitFactor,
        totalPnl: m.totalPnl, winRate: m.winRate,
      },
      walkForward: best.walkForward,
      bars: bars.length,
    };
  } catch (e) {
    console.log(`  ✗ error: ${e.message}`);
    return null;
  }
}

// ─── Public: read tuned params for a symbol ──────────────────────────────────

export function getOptimalParams(symbol) {
  const all = loadParams();
  return all[symbol]?.params ?? null;
}

export function getAllTunedParams() {
  return loadParams();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(70));
  console.log('  AUTO-TUNE — nightly hyperopt + auto-deploy');
  console.log('━'.repeat(70));
  console.log(`Symbols: ${CONFIG.symbols.length}  Bars: ${CONFIG.bars}  Loss: ${CONFIG.lossFn}  Min WF stability: ${CONFIG.minStability * 100}%`);

  const all = loadParams();
  const startTime = Date.now();
  let tunedCount = 0;

  for (const sym of CONFIG.symbols) {
    const result = await tuneSymbol(sym);
    if (result) {
      all[sym] = result;
      tunedCount++;
      saveParams(all);    // save after each symbol so partial work survives crashes
    }
  }

  console.log(`\n━━━ DONE in ${((Date.now() - startTime) / 1000).toFixed(0)}s ━━━`);
  console.log(`Tuned ${tunedCount} / ${CONFIG.symbols.length} symbols`);
  console.log(`Saved to ${PARAMS_PATH}`);

  // Telegram digest
  if (CONFIG.notifyTelegram && isEnabled() && tunedCount > 0) {
    const lines = [
      '🔧 *Auto-Tune Complete*',
      '',
      `Tuned ${tunedCount} symbols on ${CONFIG.bars}-bar window`,
      `Loss: ${CONFIG.lossFn}  Min WF: ${CONFIG.minStability * 100}%`,
      '',
    ];
    for (const sym of CONFIG.symbols) {
      const r = all[sym];
      if (!r) { lines.push(`⚠ ${sym}: no stable combo`); continue; }
      const p = r.params;
      const m = r.metrics;
      lines.push(`*${sym}* — thr ${p.threshold}, RR ${p.rewardRisk}, sharpe ${m.sharpe.toFixed(2)}`);
    }
    await send(lines.join('\n'));
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
