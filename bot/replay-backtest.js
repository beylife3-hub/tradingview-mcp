#!/usr/bin/env node
/**
 * Replay Backtest — run the bot inside TradingView's replay mode.
 *
 * More realistic than synthetic backtest because it uses TV's actual
 * historical data feed and mirrors how the bot would behave LIVE on those bars.
 *
 * Flow:
 *   1. replay.start({ date: '2025-03-01' }) — enter replay mode
 *   2. Loop: replay.step() → analyze() → if signal fires, log paper trade
 *   3. Track open positions; exit on stop / target / max-hold
 *   4. After N steps, print stats and replay.stop()
 *
 * Differences from bot/backtest.js:
 *   - Uses TradingView's data feed (not raw OHLCV array)
 *   - Each step advances exactly one bar of historical data
 *   - Slower (network round-trips per step) but more realistic
 *
 * CLI:
 *   node bot/replay-backtest.js --date 2025-03-01 --steps 200
 *   node bot/replay-backtest.js --date 2025-03-01 --steps 100 --threshold 6.5
 *   node bot/replay-backtest.js --speed 200  (autoplay mode, faster)
 */

import * as replay from '../src/core/replay.js';
import * as data   from '../src/core/data.js';
import * as chart  from '../src/core/chart.js';
import { disconnect } from '../src/connection.js';

import { analyze } from './coach.js';

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
  date:        args['--date']      ?? null,                 // YYYY-MM-DD start of replay
  steps:       Number(args['--steps']    ?? 200),
  threshold:   Number(args['--threshold']?? 6.5),
  rewardRisk:  Number(args['--rr']       ?? 1.5),
  riskDollars: Number(args['--risk']     ?? 100),
  maxHoldBars: Number(args['--max-hold'] ?? 20),
  startEquity: Number(args['--equity']   ?? 10000),
  symbol:      args['--symbol']    ?? null,
  timeframe:   args['--tf']        ?? null,
  feeBps:      Number(args['--fee-bps']  ?? 5),
  delayMs:     Number(args['--delay']    ?? 200),         // pause between steps
  color:       !('--no-color' in args),
  profile:     '--conservative' in args ? 'conservative'
             : '--aggressive'   in args ? 'aggressive'
             : '--yolo'         in args ? 'yolo'
             : 'balanced',
};

const C = CONFIG.color
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' }
  : new Proxy({}, { get: () => '' });

function fmt$(n)   { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}` : '?'; }
function fmtPct(n) { return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '?'; }
function fmtR(n)   { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '?'; }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}REPLAY BACKTEST — TradingView historical data${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);

  if (!CONFIG.date) throw new Error('--date YYYY-MM-DD is required');

  if (CONFIG.symbol)    { await chart.setSymbol({ symbol: CONFIG.symbol });   await new Promise(r=>setTimeout(r,1500)); }
  if (CONFIG.timeframe) { await chart.setTimeframe({ timeframe: CONFIG.timeframe }); await new Promise(r=>setTimeout(r,1500)); }

  const state = await chart.getState();
  console.log(`${C.dim}Symbol: ${state.symbol}  TF: ${state.resolution}m  Replay date: ${CONFIG.date}  Steps: ${CONFIG.steps}${C.reset}`);
  console.log(`${C.dim}Profile: ${CONFIG.profile}  Threshold: ${CONFIG.threshold}  Risk per trade: $${CONFIG.riskDollars}${C.reset}\n`);

  // ─── Enter replay mode ────────────────────────────────────────────────────
  console.log(`${C.cyan}→ Entering replay mode at ${CONFIG.date}...${C.reset}`);
  const startRes = await replay.start({ date: CONFIG.date });
  if (!startRes?.success) throw new Error(`replay.start failed: ${JSON.stringify(startRes)}`);
  console.log(`${C.green}✓${C.reset} Replay active`);

  let equity = CONFIG.startEquity;
  let openPos = null;
  const trades = [];

  // ─── Step loop ────────────────────────────────────────────────────────────
  console.log(`${C.cyan}→ Stepping ${CONFIG.steps} bars...${C.reset}\n`);
  let step = 0;
  for (step = 0; step < CONFIG.steps; step++) {
    try {
      // Advance one bar
      await replay.step();
      await new Promise(r => setTimeout(r, CONFIG.delayMs));

      // Get current quote for stop/target check
      const q = await data.getQuote();
      const price = q?.last ?? q?.close;
      if (!Number.isFinite(price)) continue;

      // Manage open position first
      if (openPos) {
        const dir = openPos.direction === 'LONG' ? 1 : -1;
        const stopHit   = (dir === 1 && price <= openPos.stop)   || (dir === -1 && price >= openPos.stop);
        const targetHit = (dir === 1 && price >= openPos.target) || (dir === -1 && price <= openPos.target);
        const maxHoldHit = (step - openPos.entryStep) >= CONFIG.maxHoldBars;

        let exitPrice = null, reason = null;
        if (stopHit)        { exitPrice = openPos.stop;   reason = 'stop'; }
        else if (targetHit) { exitPrice = openPos.target; reason = 'target'; }
        else if (maxHoldHit){ exitPrice = price;          reason = 'max-hold'; }

        if (exitPrice !== null) {
          const move = (exitPrice - openPos.entry) * dir;
          const grossPnl = move * openPos.size;
          const fees = (openPos.entry + exitPrice) * openPos.size * CONFIG.feeBps / 10_000;
          const pnl = grossPnl - fees;
          const initR = Math.abs(openPos.entry - openPos.stop);
          const rMult = initR > 0 ? move / initR : 0;
          equity += pnl;
          trades.push({ ...openPos, exitStep: step, exitPrice, reason, pnl, rMult });

          const verdict = rMult > 0.05 ? `${C.green}✓ WON${C.reset}` :
                          rMult < -0.05 ? `${C.red}✗ LOST${C.reset}` :
                                          `${C.yellow}— B/E${C.reset}`;
          console.log(`  Step ${step.toString().padStart(3)}: ${verdict} ${openPos.symbol} ${openPos.direction} exit ${exitPrice.toFixed(4)} ${fmtR(rMult)} ${fmt$(pnl)} (${reason}) — equity ${fmt$(equity)}`);
          openPos = null;
        }
      }

      // Look for new entry (only when flat)
      if (!openPos) {
        const result = await analyze({
          riskDollars: CONFIG.riskDollars,
          minScore:    CONFIG.threshold,
          targetRR:    CONFIG.rewardRisk,
          profile:     CONFIG.profile,
        });
        const o = result.output;
        if ((o.decision === 'LONG' || o.decision === 'SHORT') && result.best) {
          const entry = result.best.setup.entry;
          const stop  = result.best.setup.invalidation;
          const stopDist = Math.abs(entry - stop);
          if (stopDist > 0) {
            const size = CONFIG.riskDollars / stopDist;
            const target = result.best.score.suggestedTarget1
                       ?? (o.decision === 'LONG' ? entry + stopDist * CONFIG.rewardRisk
                                                  : entry - stopDist * CONFIG.rewardRisk);
            openPos = {
              entryStep: step, entry, stop, target, size,
              symbol: o.ticker, direction: o.decision,
              setup: result.best.setup.name, score: o.setupScore,
            };
            const dirIcon = o.decision === 'LONG' ? `${C.green}LONG${C.reset}` : `${C.red}SHORT${C.reset}`;
            console.log(`  Step ${step.toString().padStart(3)}: ${dirIcon} ${o.ticker} entry ${entry.toFixed(4)} stop ${stop.toFixed(4)} target ${target.toFixed(4)} size ${size.toFixed(2)} score ${o.setupScore} (${result.best.setup.name})`);
          }
        }
      }
    } catch (e) {
      console.log(`  ${C.dim}Step ${step}: error — ${e.message}${C.reset}`);
    }
  }

  // ─── Close any open position at final price ───────────────────────────────
  if (openPos) {
    const q = await data.getQuote();
    const price = q?.last ?? q?.close ?? openPos.entry;
    const dir = openPos.direction === 'LONG' ? 1 : -1;
    const move = (price - openPos.entry) * dir;
    const pnl = move * openPos.size;
    const initR = Math.abs(openPos.entry - openPos.stop);
    const rMult = initR > 0 ? move / initR : 0;
    equity += pnl;
    trades.push({ ...openPos, exitStep: step, exitPrice: price, reason: 'end-of-replay', pnl, rMult });
    console.log(`  ${C.dim}End: closing open ${openPos.direction} at ${price.toFixed(4)} (${fmt$(pnl)})${C.reset}`);
  }

  // ─── Stop replay ──────────────────────────────────────────────────────────
  await replay.stop();
  console.log(`\n${C.green}✓${C.reset} Replay mode stopped`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${C.cyan}━━━ REPLAY RESULTS ━━━${C.reset}\n`);
  if (!trades.length) {
    console.log(`  ${C.yellow}No trades fired in ${CONFIG.steps} steps. Try lowering --threshold or use --aggressive/--yolo.${C.reset}`);
  } else {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = wins.length / trades.length;
    const avgR = trades.reduce((s, t) => s + t.rMult, 0) / trades.length;

    console.log(`  Trades:           ${trades.length}  (${C.green}${wins.length}W${C.reset} / ${C.red}${losses.length}L${C.reset})`);
    console.log(`  Win rate:         ${fmtPct(winRate)}`);
    console.log(`  Avg R-mult:       ${fmtR(avgR)}`);
    console.log(`  Final equity:     ${equity >= CONFIG.startEquity ? C.green : C.red}${fmt$(equity)}${C.reset}`);
    console.log(`  Total P&L:        ${totalPnl >= 0 ? C.green : C.red}${fmt$(totalPnl)}${C.reset}  (${fmtPct(totalPnl / CONFIG.startEquity)})`);

    // Per-setup breakdown
    console.log(`\n  ${C.bold}By setup:${C.reset}`);
    const setups = new Map();
    for (const t of trades) {
      if (!setups.has(t.setup)) setups.set(t.setup, { count: 0, wins: 0, pnl: 0 });
      const s = setups.get(t.setup);
      s.count++;
      s.pnl += t.pnl;
      if (t.pnl > 0) s.wins++;
    }
    for (const [name, s] of setups) {
      console.log(`    ${name.padEnd(30)} ${s.count.toString().padStart(3)} trades  WR ${(s.wins/s.count*100).toFixed(1).padStart(5)}%  ${s.pnl >= 0 ? C.green : C.red}${fmt$(s.pnl).padStart(10)}${C.reset}`);
    }
  }

  await disconnect().catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    console.error('Fatal:', e.message); console.error(e.stack);
    try { await replay.stop(); } catch {}
    await disconnect().catch(() => {});
    process.exit(1);
  });
}
