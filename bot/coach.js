#!/usr/bin/env node
/**
 * TradingView MCP — Rules-Based Day Trading Coach
 * ────────────────────────────────────────────────
 *
 * "You are my rules-based day trading analyst, not a gambler, not a hype man,
 *  and not a prediction machine."
 *
 * Reads the live TradingView chart, runs a 9-stage analysis, and produces a
 * trade plan ONLY when ALL rules pass. Otherwise it says NO TRADE / WATCHLIST.
 *
 * Pipeline:
 *   1. Market context     — HTF trend, regime classification
 *   2. Key levels         — PDH/PDL/PMH/PML/ORH/ORL/VWAP/EMAs/pivots
 *   3. Setup quality      — 1-10 score across 7 dimensions
 *   4. Trade decision     — LONG / SHORT / WATCHLIST / NO TRADE
 *   5. Trade structure    — exact entry/stop/T1/T2/invalidation
 *   6. Position sizing    — from configured max dollar risk
 *   7. Strict filters     — capital-preservation rejections
 *   8. Execution coaching — trigger conditions, failure modes, common mistakes
 *   9. Output formatting  — fixed format the user specified
 *
 * Behavioral rules (hard-coded):
 *   - Never claim "this will make money"
 *   - Never use hype language
 *   - Never force a trade
 *   - If unclear → NO TRADE
 *   - If decent but not ideal → WATCHLIST ONLY
 *
 * Usage:
 *   node bot/coach.js                              # use chart's current symbol/TF
 *   node bot/coach.js --tf 5                       # override timeframe
 *   node bot/coach.js --bars 200                   # bars to analyze
 *   node bot/coach.js --risk 100                   # max dollar risk
 *   node bot/coach.js --min-score 7                # only TRADE at this score+
 *   node bot/coach.js --target-rr 2                # required minimum R:R
 *   node bot/coach.js --no-color                   # plain text output
 */

import * as chart from '../src/core/chart.js';
import * as data  from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

import { ema, atr, rsi, computeVWAP, fmt } from './engine.js';
import { extractKeyLevels, pickBestLevel, LEVEL_LABELS } from './levels.js';
import { classifyRegime, regimeSummary, styleFor } from './regime.js';
import { detectAll } from './setups.js';
import { scoreSetup, verdictFromScore, applyStrictFilters } from './scoring.js';

// ─── CLI parsing ─────────────────────────────────────────────────────────────

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
  symbol:     args['--symbol']    ?? null,
  timeframe:  args['--tf']        ?? null,
  bars:       Number(args['--bars']      ?? 200),
  riskDollars: Number(args['--risk']     ?? 100),
  minScore:   Number(args['--min-score'] ?? 7),    // ≥ 7 = TRADE
  targetRR:   Number(args['--target-rr'] ?? 2),    // mandatory minimum
  color:      !('--no-color' in args),
};

// ─── Terminal styling ────────────────────────────────────────────────────────

const C = CONFIG.color
  ? {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green:  '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    cyan:   '\x1b[36m', white: '\x1b[37m', blue: '\x1b[34m',
    bgGreen: '\x1b[42m', bgRed: '\x1b[41m', bgYellow: '\x1b[43m',
  }
  : new Proxy({}, { get: () => '' });

const L = {
  hdr(s) { const bar = '━'.repeat(75); console.log(`\n${C.cyan}${bar}${C.reset}`); console.log(`  ${C.bold}${C.cyan}${s}${C.reset}`); console.log(`${C.cyan}${bar}${C.reset}`); },
  ok(s)  { console.log(`${C.green}✓${C.reset} ${s}`); },
  warn(s){ console.log(`${C.yellow}⚠${C.reset} ${s}`); },
  err(s) { console.log(`${C.red}✗${C.reset} ${s}`); },
  info(s){ console.log(`${C.dim}ℹ${C.reset} ${s}`); },
};

// ─── Build current structure object ──────────────────────────────────────────

function buildStructure(bars) {
  const closes = bars.map(b => b.close);
  const last = bars[bars.length - 1];

  const e20  = ema(closes, 20);
  const e50  = ema(closes, 50);
  const e200 = ema(closes, 200);
  const atrSeries = atr(bars, 14);
  const rsiSeries = rsi(closes, 14);
  const vwapResult = computeVWAP(bars, Math.min(78, bars.length));

  return {
    price: last.close,
    open: last.open, high: last.high, low: last.low,
    ema20:  e20[e20.length - 1],
    ema50:  e50[e50.length - 1],
    ema200: e200[e200.length - 1],
    atr:  atrSeries[atrSeries.length - 1],
    rsi:  rsiSeries[rsiSeries.length - 1],
    vwap: vwapResult?.vwap ?? null,
    vwapBands: vwapResult ? {
      upper1: vwapResult.upper1, lower1: vwapResult.lower1,
      upper2: vwapResult.upper2, lower2: vwapResult.lower2,
    } : null,
  };
}

// ─── Position sizing ─────────────────────────────────────────────────────────

function calcPositionSize(entry, stop, riskDollars) {
  const stopDist = Math.abs(entry - stop);
  if (stopDist === 0) return { shares: 0, maxLoss: 0, notional: 0 };
  const shares = Math.floor(riskDollars / stopDist);
  const notional = shares * entry;
  const maxLoss = shares * stopDist;
  return { shares, maxLoss, notional };
}

// ─── Output formatter (per user spec) ────────────────────────────────────────

function formatVerdict(decision) {
  if (decision === 'LONG')        return `${C.bgGreen}${C.bold} LONG ${C.reset}`;
  if (decision === 'SHORT')       return `${C.bgRed}${C.bold} SHORT ${C.reset}`;
  if (decision === 'WATCHLIST')   return `${C.bgYellow}${C.bold} WATCHLIST ${C.reset}`;
  return `${C.dim}${C.bold} NO TRADE ${C.reset}`;
}

function formatStrictOutput(out) {
  // The exact 17-line format the user requested
  const lines = [];
  lines.push(`Ticker:           ${out.ticker}`);
  lines.push(`Timeframe:        ${out.timeframe}`);
  lines.push(`Current price:    ${fmt.price(out.currentPrice)}`);
  lines.push(`Bias:             ${out.bias}`);
  lines.push(`Market condition: ${out.marketCondition}`);
  lines.push(`Best level:       ${out.bestLevel}`);
  lines.push(`Decision:         ${out.decision}`);
  lines.push(`Setup score:      ${out.setupScore}/10`);
  lines.push(`Entry:            ${out.entry}`);
  lines.push(`Stop:             ${out.stop}`);
  lines.push(`Target 1:         ${out.target1}`);
  lines.push(`Target 2:         ${out.target2}`);
  lines.push(`Invalidation:     ${out.invalidation}`);
  lines.push(`Reward/Risk:      ${out.rewardRisk}`);
  lines.push(`Position size:    ${out.positionSize}`);
  lines.push(`Confidence:       ${out.confidence}`);
  lines.push(`Reason in 3 bullets:`);
  for (const b of out.reasons) lines.push(`  • ${b}`);
  lines.push(`Main risk:        ${out.mainRisk}`);
  lines.push(`Final instruction: ${out.finalInstruction}`);
  return lines.join('\n');
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyze({ riskDollars = CONFIG.riskDollars, minScore = CONFIG.minScore, targetRR = CONFIG.targetRR } = {}) {
  // 1. Read chart
  const state = await chart.getState();
  const symbol = state.symbol;
  const tf = state.resolution;

  const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
  if (!ohlcv.success || !ohlcv.bars || ohlcv.bars.length < 50) {
    throw new Error(`Insufficient bars (got ${ohlcv.bars?.length || 0})`);
  }
  const bars = ohlcv.bars;

  // 2. Build structure + extract levels
  const structure = buildStructure(bars);
  const levels    = extractKeyLevels(bars, structure);
  const regime    = classifyRegime(bars);

  // 3. Detect setups
  const setups = detectAll(bars, levels, structure);

  // 4. Score each + pick best (only ones that pass strict filters)
  const scored = setups.map(setup => {
    const score = scoreSetup(setup, structure, levels, regime, bars, { targetRR });
    const rejection = applyStrictFilters({
      setup, score, structure, regime, bars,
      accountRiskDollars: riskDollars,
    });
    return { setup, score, rejection };
  });

  // Pick the highest-scoring NON-rejected setup
  scored.sort((a, b) => b.score.score - a.score.score);
  const best   = scored.find(s => !s.rejection) ?? scored[0];
  const verdict = best ? verdictFromScore(best.score.score) : 'NO_TRADE';

  // 5. Build output
  const bestLevel = pickBestLevel(levels, structure.price, structure.atr);
  const bestLevelLabel = bestLevel
    ? `${LEVEL_LABELS[bestLevel.type] ?? bestLevel.type} @ ${fmt.price(bestLevel.price)} (${(bestLevel.distancePct * 100).toFixed(2)}% away)`
    : 'no major level nearby';

  // Bias inferred from EMA stack + regime
  let bias = 'NEUTRAL';
  if (regime.type === 'trending-up')   bias = 'BULLISH';
  else if (regime.type === 'trending-down') bias = 'BEARISH';
  else if (regime.type === 'ranging')  bias = 'NEUTRAL — RANGE';
  else if (regime.type === 'choppy')   bias = 'NO BIAS — CHOP';
  else if (regime.type === 'parabolic') bias = 'OVEREXTENDED';

  // Decision
  let decision = 'NO TRADE';
  if (best && !best.rejection) {
    if (verdict === 'TRADE')        decision = best.setup.direction;
    else if (verdict === 'WATCHLIST') decision = 'WATCHLIST ONLY';
    else                              decision = 'NO TRADE';
  } else if (best?.rejection) {
    decision = 'NO TRADE';
  }

  // If no setup detected
  if (!best) {
    decision = 'NO TRADE';
  }

  // Position size + targets (only if TRADE)
  let entry = '—', stop = '—', target1 = '—', target2 = '—', invalidation = '—';
  let rewardRisk = '—', positionSize = '—', confidence = 'low';
  let reasons = [];
  let mainRisk = '—';
  let finalInstruction = '—';
  let setupScore = best ? best.score.score : 0;

  if (decision === 'LONG' || decision === 'SHORT') {
    entry        = fmt.price(best.setup.entry);
    invalidation = fmt.price(best.setup.invalidation);
    stop         = invalidation;
    target1      = fmt.price(best.score.suggestedTarget1);
    target2      = fmt.price(best.score.suggestedTarget2);

    const t1Dist = Math.abs(best.score.suggestedTarget1 - best.setup.entry);
    const t2Dist = Math.abs(best.score.suggestedTarget2 - best.setup.entry);
    const stopDist = best.score.stopDist;
    rewardRisk = `${(t1Dist / stopDist).toFixed(2)}:1 to T1 / ${(t2Dist / stopDist).toFixed(2)}:1 to T2`;

    const sizing = calcPositionSize(best.setup.entry, best.setup.invalidation, riskDollars);
    positionSize = `${sizing.shares} shares  ($${sizing.notional.toFixed(2)} notional)  Max loss: $${sizing.maxLoss.toFixed(2)}`;

    confidence = setupScore >= 8 ? 'high' : setupScore >= 7 ? 'medium' : 'low';

    reasons = best.score.components.slice(0, 3).map(c => `${c.name} (${c.score}/${c.max}) — ${c.note}`);

    mainRisk = best.score.components.find(c => c.score < c.max * 0.5)?.note
            ?? `Setup invalidated if price closes through ${fmt.price(best.setup.invalidation)}`;

    finalInstruction = best.setup.direction === 'LONG'
      ? `Place stop at ${fmt.price(best.setup.invalidation)} BEFORE clicking buy. Take 50% off at T1, trail rest. Exit if 5 min after entry the trade hasn't moved your way.`
      : `Place stop at ${fmt.price(best.setup.invalidation)} BEFORE clicking sell. Cover 50% at T1, trail rest. Exit if 5 min after entry the trade hasn't moved your way.`;
  } else if (decision === 'WATCHLIST ONLY') {
    entry = `Watch for ${best.setup.direction.toLowerCase()} confirmation`;
    invalidation = best.setup.invalidation ? fmt.price(best.setup.invalidation) : '—';
    reasons = best.score.components
      .filter(c => c.score < c.max)
      .slice(0, 3)
      .map(c => `${c.name} (${c.score}/${c.max}) — ${c.note}`);
    mainRisk = 'Setup forming but not yet A+. Don\'t front-run it.';
    finalInstruction = `Wait. Add to watchlist. Re-evaluate when score hits ${minScore}+ or setup invalidates.`;
    confidence = 'low';
  } else {
    // NO TRADE
    if (best?.rejection) {
      reasons = best.rejection.slice(0, 3);
      mainRisk = 'Forcing this trade would violate rule-based discipline.';
    } else {
      reasons = [
        `Regime: ${regime.type} (${regime.reason})`,
        `No setup met the minimum criteria`,
        `Score floor of ${minScore} not reached`,
      ];
      mainRisk = 'Boredom trades — sitting still IS the trade right now.';
    }
    finalInstruction = 'Stand aside. Save your capital for a clean A+ setup.';
    confidence = 'n/a';
  }

  const formatted = formatStrictOutput({
    ticker: symbol,
    timeframe: tf + 'm',
    currentPrice: structure.price,
    bias,
    marketCondition: `${regimeSummary(regime)} — ${regime.reason}`,
    bestLevel: bestLevelLabel,
    decision: decision === 'NO TRADE' ? 'NO TRADE'
            : decision === 'WATCHLIST ONLY' ? 'WATCHLIST ONLY'
            : decision,
    setupScore,
    entry, stop, target1, target2, invalidation,
    rewardRisk, positionSize, confidence,
    reasons,
    mainRisk,
    finalInstruction,
  });

  return {
    symbol, tf,
    structure, levels, regime, setups, scored, best,
    decision, verdict,
    score: setupScore,
    formatted,
    output: {
      ticker: symbol,
      timeframe: tf + 'm',
      currentPrice: structure.price,
      bias,
      marketCondition: regimeSummary(regime),
      bestLevel: bestLevelLabel,
      decision,
      setupScore,
      entry, stop, target1, target2, invalidation,
      rewardRisk, positionSize, confidence,
      reasons, mainRisk, finalInstruction,
    },
  };
}

// ─── Pretty terminal output ──────────────────────────────────────────────────

function printAnalysis(result) {
  const o = result.output;
  L.hdr(`Day Trading Coach — ${o.ticker}  ${o.timeframe}`);
  console.log();
  console.log(`Current price:    ${C.bold}${fmt.price(o.currentPrice)}${C.reset}`);
  console.log(`Market condition: ${o.marketCondition}`);
  console.log(`Bias:             ${C.bold}${o.bias}${C.reset}`);
  console.log(`Best level:       ${o.bestLevel}`);
  console.log(`Setup score:      ${C.bold}${o.setupScore}/10${C.reset}`);
  console.log();
  console.log(`Decision:         ${formatVerdict(o.decision)}`);
  console.log();

  if (o.decision === 'LONG' || o.decision === 'SHORT') {
    console.log(`Entry:            ${C.bold}${o.entry}${C.reset}`);
    console.log(`Stop:             ${C.red}${o.stop}${C.reset}`);
    console.log(`Target 1:         ${C.green}${o.target1}${C.reset}`);
    console.log(`Target 2:         ${C.green}${o.target2}${C.reset}`);
    console.log(`Invalidation:     ${o.invalidation}`);
    console.log(`Reward/Risk:      ${o.rewardRisk}`);
    console.log(`Position size:    ${o.positionSize}`);
    console.log(`Confidence:       ${o.confidence}`);
    console.log();
  }

  console.log(`${C.bold}Reason:${C.reset}`);
  for (const r of o.reasons) console.log(`  • ${r}`);
  console.log();
  console.log(`${C.yellow}Main risk:${C.reset}        ${o.mainRisk}`);
  console.log(`${C.cyan}Final instruction:${C.reset} ${o.finalInstruction}`);
  console.log();

  // Strict-format block per user spec
  L.hdr('Strict Output Format');
  console.log(result.formatted);
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const result = await analyze();
      printAnalysis(result);
    } catch (e) {
      L.err(`Fatal: ${e.message}`);
      console.error(e.stack);
      process.exitCode = 1;
    } finally {
      await disconnect().catch(() => {});
    }
  })();
}
