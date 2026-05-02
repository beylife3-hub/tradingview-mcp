#!/usr/bin/env node
/**
 * Multi-Symbol Scanner — Find the best A+ setup across your watchlist.
 *
 * Critical for live traders: instead of staring at one chart, scan a
 * curated watchlist and rank by current setup score. The bot tells you
 * which ticker has the highest-conviction trade RIGHT NOW.
 *
 * Reuses bot/coach.js analyze() and src/core/chart.js setSymbol().
 *
 * CLI:
 *   node bot/scan.js --watchlist NVDA,TSLA,AMD,SPY,QQQ
 *   node bot/scan.js --watchlist NVDA,TSLA --tf 5 --min-score 6
 *   node bot/scan.js --top 5 --aggressive
 *   node bot/scan.js --telegram          send leaderboard to phone
 */

import * as chart from '../src/core/chart.js';
import { disconnect } from '../src/connection.js';
import { analyze } from './coach.js';
import { send, isEnabled } from './notify.js';

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
  'NASDAQ:NVDA', 'NASDAQ:TSLA', 'NASDAQ:AMD', 'NASDAQ:META', 'NASDAQ:AAPL',
  'AMEX:SPY', 'NASDAQ:QQQ', 'BINANCE:BTCUSDT.P', 'COINBASE:ETHUSD',
];

const CONFIG = {
  watchlist: args['--watchlist']
    ? args['--watchlist'].split(',').map(s => s.trim())
    : DEFAULT_WATCHLIST,
  timeframe: args['--tf']        ?? null,
  riskDollars: Number(args['--risk']     ?? 100),
  minScore:  Number(args['--min-score']  ?? 5.5),  // show anything WATCHLIST or above
  top:       Number(args['--top']        ?? 10),
  noHTF:     '--no-htf' in args,                    // skip HTF for speed
  telegram:  '--telegram' in args,
  color:     !('--no-color' in args),
  profile:   '--conservative' in args ? 'conservative'
           : '--aggressive'   in args ? 'aggressive'
           : '--yolo'         in args ? 'yolo'
           : 'balanced',
};

const C = CONFIG.color
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', bgGreen:'\x1b[42m', bgRed:'\x1b[41m', bgYellow:'\x1b[43m' }
  : new Proxy({}, { get: () => '' });

function decisionBadge(d) {
  if (d === 'LONG')             return `${C.green}🟢 LONG    ${C.reset}`;
  if (d === 'SHORT')            return `${C.red}🔴 SHORT   ${C.reset}`;
  if (d === 'WATCHLIST ONLY')   return `${C.yellow}🟡 WATCH   ${C.reset}`;
  return `${C.dim}⚪ NO TRADE${C.reset}`;
}

async function main() {
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}MULTI-SYMBOL SCANNER — find best A+ setup right now${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`${C.dim}Watchlist: ${CONFIG.watchlist.length} symbols  Profile: ${CONFIG.profile}${C.reset}\n`);

  // Remember the original chart so we restore at end
  const originalState = await chart.getState();
  const originalSymbol = originalState.symbol;
  const originalTf     = originalState.resolution;

  const results = [];
  for (let i = 0; i < CONFIG.watchlist.length; i++) {
    const sym = CONFIG.watchlist[i];
    process.stdout.write(`  [${i+1}/${CONFIG.watchlist.length}] ${sym.padEnd(25)} ... `);
    try {
      await chart.setSymbol({ symbol: sym });
      await new Promise(r => setTimeout(r, 1500));
      if (CONFIG.timeframe) {
        await chart.setTimeframe({ timeframe: CONFIG.timeframe });
        await new Promise(r => setTimeout(r, 1200));
      }
      const result = await analyze({
        riskDollars: CONFIG.riskDollars,
        minScore:    CONFIG.minScore,
        profile:     CONFIG.profile,
        noHTF:       CONFIG.noHTF,
      });
      results.push({ symbol: sym, result });
      const o = result.output;
      const dirShort = o.decision === 'WATCHLIST ONLY' ? 'WATCH' : o.decision;
      console.log(`${o.setupScore.toFixed(1)}/10  ${dirShort.padEnd(8)}  ${C.dim}${o.marketCondition}${C.reset}`);
    } catch (e) {
      console.log(`${C.red}error: ${e.message.slice(0, 60)}${C.reset}`);
    }
  }

  // Restore original chart
  try {
    await chart.setSymbol({ symbol: originalSymbol });
    await new Promise(r => setTimeout(r, 1500));
    if (originalTf) {
      await chart.setTimeframe({ timeframe: originalTf });
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch { /* best-effort */ }

  // Sort by score, show leaderboard
  results.sort((a, b) => (b.result.output.setupScore || 0) - (a.result.output.setupScore || 0));

  console.log(`\n${C.cyan}━━━ LEADERBOARD — by setup score ━━━${C.reset}\n`);
  console.log(`  ${C.dim}Rank Symbol                    Score  Decision      Bias       Best Level${C.reset}`);
  console.log('  ' + '─'.repeat(98));
  const top = results.slice(0, CONFIG.top);
  for (let i = 0; i < top.length; i++) {
    const { symbol, result } = top[i];
    const o = result.output;
    const score = (o.setupScore || 0).toFixed(1).padStart(5);
    const sym = symbol.padEnd(25);
    const bias = (o.bias || '?').slice(0, 10).padEnd(10);
    const lvl = (o.bestLevel || 'n/a').slice(0, 35);
    const rankBadge = i === 0 ? `${C.bgGreen} #1 ${C.reset}` : `#${(i+1).toString().padEnd(2)}  `;
    console.log(`  ${rankBadge} ${sym} ${score}  ${decisionBadge(o.decision)}  ${bias}  ${C.dim}${lvl}${C.reset}`);
  }

  // Highlight TRADE-grade winners
  const tradeable = results.filter(r => r.result.output.decision === 'LONG' || r.result.output.decision === 'SHORT');
  if (tradeable.length) {
    console.log(`\n${C.green}━━━ ${tradeable.length} TRADEABLE SETUP${tradeable.length === 1 ? '' : 'S'} ━━━${C.reset}\n`);
    for (const { symbol, result } of tradeable) {
      const o = result.output;
      console.log(`  ${decisionBadge(o.decision)}  ${C.bold}${symbol}${C.reset} @ ${o.currentPrice}`);
      console.log(`    Entry: ${o.entry}   Stop: ${o.stop}   T1: ${o.target1}   T2: ${o.target2}`);
      console.log(`    R/R: ${o.rewardRisk}`);
      console.log('');
    }
  } else {
    console.log(`\n  ${C.dim}No A+ setups across the watchlist right now. Stand aside.${C.reset}`);
  }

  // Optional Telegram leaderboard
  if (CONFIG.telegram && isEnabled()) {
    const tgLines = ['📊 *WATCHLIST SCAN*', ''];
    for (let i = 0; i < Math.min(5, top.length); i++) {
      const { symbol, result } = top[i];
      const o = result.output;
      const emoji = o.decision === 'LONG' ? '🟢' : o.decision === 'SHORT' ? '🔴' : o.decision === 'WATCHLIST ONLY' ? '🟡' : '⚪';
      tgLines.push(`${emoji} *${symbol}* — ${o.setupScore.toFixed(1)}/10  _${o.decision}_`);
      if (o.decision === 'LONG' || o.decision === 'SHORT') {
        tgLines.push(`    Entry \`${o.entry}\` Stop \`${o.stop}\` T1 \`${o.target1}\``);
      }
    }
    if (tradeable.length) tgLines.push('', `🎯 *${tradeable.length} A+ setup${tradeable.length === 1 ? '' : 's'}* in watchlist`);
    await send(tgLines.join('\n'));
    console.log(`\n${C.green}✓${C.reset} Sent to Telegram`);
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
