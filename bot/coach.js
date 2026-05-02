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
import { classifyRegime, regimeSummary } from './regime.js';
import { detectAll } from './setups.js';
import { scoreSetup, verdictFromScore, applyStrictFilters } from './scoring.js';
import { teachAnalysis, teachConcept, fullGlossary } from './education.js';
import { drawAnalysis, clearBotShapes } from './draw-plan.js';
import { logPlanToJournal } from './journal.js';
import { computeConviction, shouldOverride } from './discretion.js';

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

// ─── Risk profile presets ────────────────────────────────────────────────────
// Each profile sets multiple thresholds at once. CLI flags override individually.
//   --conservative   only A+ setups, R:R ≥ 2, capital preservation focus
//   default          balanced — loosened defaults
//   --aggressive     fires on B-grade setups, R:R ≥ 1.2, more trades per day
//   --yolo           experimental — anything that scores positive (NOT recommended)

let PROFILE_DEFAULTS = { minScore: 6.5, targetRR: 1.5, stopCapPct: 7 };
if ('--conservative' in args) PROFILE_DEFAULTS = { minScore: 7,   targetRR: 2,   stopCapPct: 5  };
if ('--aggressive'   in args) PROFILE_DEFAULTS = { minScore: 5.5, targetRR: 1.2, stopCapPct: 10 };
if ('--yolo'         in args) PROFILE_DEFAULTS = { minScore: 4.5, targetRR: 1.0, stopCapPct: 12 };

const CONFIG = {
  symbol:     args['--symbol']    ?? null,
  timeframe:  args['--tf']        ?? null,
  bars:       Number(args['--bars']      ?? 200),
  riskDollars: Number(args['--risk']     ?? 100),
  minScore:   Number(args['--min-score'] ?? PROFILE_DEFAULTS.minScore),
  targetRR:   Number(args['--target-rr'] ?? PROFILE_DEFAULTS.targetRR),
  stopCapPct: Number(args['--stop-cap']  ?? PROFILE_DEFAULTS.stopCapPct),
  profile:    '--conservative' in args ? 'conservative'
            : '--aggressive'   in args ? 'aggressive'
            : '--yolo'         in args ? 'yolo'
            : 'balanced',
  color:      !('--no-color' in args),
  teach:      !('--no-teach' in args),              // education ON by default
  glossary:   '--glossary' in args,
  explain:    args['--explain'] ?? null,            // --explain VWAP
  draw:       '--draw' in args,                      // draw analysis on TradingView chart
  log:        '--log'  in args,                      // append plan to journal when LONG/SHORT
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

function buildStructure(bars, quote) {
  const closes = bars.map(b => b.close);
  const last = bars[bars.length - 1];

  const e20  = ema(closes, 20);
  const e50  = ema(closes, 50);
  const e200 = ema(closes, 200);
  const atrSeries = atr(bars, 14);
  const rsiSeries = rsi(closes, 14);
  const vwapResult = computeVWAP(bars, Math.min(78, bars.length));

  // Anchored VWAP from PDH (highest high in last 50 bars) — useful for fade entries
  let avwapPivot = null;
  let pivotIdx = bars.length - 1;
  let pivotHigh = -Infinity;
  for (let i = Math.max(0, bars.length - 50); i < bars.length; i++) {
    if (bars[i].high > pivotHigh) { pivotHigh = bars[i].high; pivotIdx = i; }
  }
  if (pivotIdx < bars.length - 5) {
    const avwapResult = computeVWAP(bars.slice(pivotIdx));
    avwapPivot = avwapResult?.vwap ?? null;
  }

  return {
    price: last.close,
    open: last.open, high: last.high, low: last.low,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
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
    avwapPivot,
    pivotIdx,
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

// ─── Higher-timeframe bias (multi-timeframe confluence) ──────────────────────
//
// Pulls the "next TF up" and computes a 4-factor bias score there. Returns
// { direction: 'BULLISH'|'BEARISH'|'NEUTRAL', score, htf, factors }.
//
// HTF mapping (Freqtrade convention):
//   1m → 5m, 5m → 15m, 15m → 60m, 60m → 240m, 240m → D, D → W
//
// Strategy: temporarily switch the chart, fetch bars, score, switch back.
export async function fetchHTFBias(currentTF) {
  const HTF_MAP = { '1':'5', '3':'15', '5':'15', '15':'60', '30':'60',
                    '60':'240', '120':'240', '240':'D', 'D':'W' };
  const htf = HTF_MAP[currentTF] || HTF_MAP[String(currentTF)];
  if (!htf) return null;

  try {
    await chart.setTimeframe({ timeframe: htf });
    await new Promise(r => setTimeout(r, 1500));   // wait for data load

    const ohlcv = await data.getOhlcv({ count: 100, summary: false });
    if (!ohlcv.success || !ohlcv.bars || ohlcv.bars.length < 50) {
      await chart.setTimeframe({ timeframe: currentTF });
      return null;
    }
    const bars = ohlcv.bars;
    const closes = bars.map(b => b.close);
    const lastBar = bars[bars.length - 1];

    // 4-factor HTF bias
    const e20s  = ema(closes, 20);
    const e50s  = ema(closes, 50);
    const e200s = ema(closes, 200);
    const rsiS  = rsi(closes, 14);
    const e20  = e20s[e20s.length - 1];
    const e50  = e50s[e50s.length - 1];
    const e200 = e200s[e200s.length - 1];
    const e20Prev = e20s[Math.max(0, e20s.length - 5)];
    const r = rsiS[rsiS.length - 1];

    let score = 0;
    const factors = [];

    // 1. EMA stack alignment (±25)
    if (e20 > e50 && e50 > e200 && lastBar.close > e20)       { score += 25; factors.push({ name: 'EMA stack full bullish', value: 25 }); }
    else if (e20 < e50 && e50 < e200 && lastBar.close < e20)  { score -= 25; factors.push({ name: 'EMA stack full bearish', value: -25 }); }
    else if (e20 > e50)                                        { score += 18; factors.push({ name: 'EMA stack partial bullish', value: 18 }); }
    else if (e20 < e50)                                        { score -= 18; factors.push({ name: 'EMA stack partial bearish', value: -18 }); }

    // 2. HTF RSI zone (±15)
    if (r > 60)                                                { score += 15; factors.push({ name: `HTF RSI ${r.toFixed(0)} bullish zone`, value: 15 }); }
    else if (r < 40)                                           { score -= 15; factors.push({ name: `HTF RSI ${r.toFixed(0)} bearish zone`, value: -15 }); }

    // 3. EMA20 slope (±10)
    if (e20Prev && e20 > e20Prev * 1.001)                      { score += 10; factors.push({ name: 'EMA20 slope rising', value: 10 }); }
    else if (e20Prev && e20 < e20Prev * 0.999)                 { score -= 10; factors.push({ name: 'EMA20 slope falling', value: -10 }); }

    // 4. Price vs HTF EMA20 (±10)
    if (lastBar.close > e20)                                   { score += 10; factors.push({ name: 'Price > HTF EMA20', value: 10 }); }
    else                                                       { score -= 10; factors.push({ name: 'Price < HTF EMA20', value: -10 }); }

    // Switch chart back
    await chart.setTimeframe({ timeframe: currentTF });
    await new Promise(r => setTimeout(r, 1500));

    const direction = score >= 30 ? 'BULLISH' : score <= -30 ? 'BEARISH' : 'NEUTRAL';
    return { direction, score, htf, factors };
  } catch (e) {
    // Best-effort restore
    try { await chart.setTimeframe({ timeframe: currentTF }); } catch {}
    return null;
  }
}

export async function analyze({
  riskDollars = CONFIG.riskDollars,
  minScore    = CONFIG.minScore,
  targetRR    = CONFIG.targetRR,
  stopCapPct  = CONFIG.stopCapPct,
  profile     = CONFIG.profile,
  noHTF       = false,                              // skip HTF fetch (faster)
  allowDiscretion = true,                           // allow AI override of soft filters
  discretionThreshold = 80,                         // conviction needed (0-100)
} = {}) {
  // 1. Read chart
  const state = await chart.getState();
  const symbol = state.symbol;
  const tf = state.resolution;

  const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
  if (!ohlcv.success || !ohlcv.bars || ohlcv.bars.length < 50) {
    throw new Error(`Insufficient bars (got ${ohlcv.bars?.length || 0})`);
  }
  const bars = ohlcv.bars;

  // 2. HTF bias FIRST (changes TF temporarily, switches back) — Freqtrade pattern
  let htfBias = null;
  if (!noHTF) {
    htfBias = await fetchHTFBias(tf);
  }

  // 3. Build structure + extract levels (also fetch quote for bid/ask spread check)
  let quote = null;
  try { quote = await data.getQuote(); } catch { /* not all feeds expose bid/ask */ }
  const structure = buildStructure(bars, quote);
  const levels    = extractKeyLevels(bars, structure);
  const regime    = classifyRegime(bars);

  // 4. Detect setups (pass profile-aware detector options + current regime)
  const detectorOpts = {
    aggressive: profile === 'aggressive' || profile === 'yolo',
    yolo:       profile === 'yolo',
    regime:     regime?.type,                    // for regime-conditional whitelisting
  };
  const setups = detectAll(bars, levels, structure, detectorOpts);

  // 5. Apply HTF confluence to each setup
  if (htfBias && htfBias.direction !== 'NEUTRAL') {
    for (const s of setups) {
      s.htfAligned = (htfBias.direction === 'BULLISH' && s.direction === 'LONG')
                  || (htfBias.direction === 'BEARISH' && s.direction === 'SHORT');
      s.htfCounter = (htfBias.direction === 'BULLISH' && s.direction === 'SHORT')
                  || (htfBias.direction === 'BEARISH' && s.direction === 'LONG');
    }
  }

  // 6. Score each + pick best (only ones that pass strict filters)
  const scored = setups.map(setup => {
    const score = scoreSetup(setup, structure, levels, regime, bars, { targetRR });
    // HTF counter-trend = quality downgrade (penalty in conservative/balanced)
    if (setup.htfCounter && profile !== 'aggressive' && profile !== 'yolo') {
      score.score = Math.max(1, score.score - 1.5);
      score.components.push({ name: 'HTF disagreement', score: 0, max: 0,
        note: `${htfBias.htf}m HTF is ${htfBias.direction} but setup is ${setup.direction}` });
    }
    const rejection = applyStrictFilters({
      setup, score, structure, regime, bars,
      accountRiskDollars: riskDollars,
      targetRR, stopCapPct, profile,
    });
    return { setup, score, rejection };
  });

  // Pick the highest-scoring NON-rejected setup
  scored.sort((a, b) => b.score.score - a.score.score);
  let best   = scored.find(s => !s.rejection) ?? scored[0];
  // Apply profile-aware verdict thresholds
  let verdict = best
    ? verdictFromScore(best.score.score, { tradeThreshold: minScore })
    : 'NO_TRADE';

  // ─── DISCRETION OVERRIDE (Tier 7 +) — AI judgment layer ────────────────────
  // If a setup was rejected OR scored below threshold, compute conviction
  // from ALL signals. If conviction is high AND only soft filters tripped,
  // allow the override.
  let discretionOverride = null;
  if (allowDiscretion && best) {
    const wouldFire = !best.rejection && verdict === 'TRADE';
    if (!wouldFire) {
      try {
        const convictionRes = await computeConviction({ result: { best, output: { setupScore: best.score.score, ticker: symbol }, htfBias, regime }, bars, symbol });
        const reasons = best.rejection ?? [];
        const ov = shouldOverride({
          rejectionReasons: reasons,
          conviction: convictionRes.conviction,
          threshold: discretionThreshold,
          originalScore: best.score.score,
          minScore,
        });
        if (ov.override) {
          // Allow the trade — clear rejection, force TRADE verdict
          best.rejection = null;
          verdict = 'TRADE';
          discretionOverride = {
            applied: true,
            conviction: convictionRes.conviction,
            breakdown: convictionRes.breakdown,
            originalReasons: reasons,
            originalScore: best.score.score,
            reason: ov.reason,
          };
        } else {
          // Still record the conviction even when not overriding (for transparency)
          discretionOverride = {
            applied: false,
            conviction: convictionRes.conviction,
            breakdown: convictionRes.breakdown,
            blockReason: ov.reason,
          };
        }
      } catch (e) { /* discretion is opt-in; failure shouldn't break analyze */ }
    }
  }

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

    // ─── Add discretion-override warning to instruction if applicable ────────
    if (discretionOverride?.applied) {
      finalInstruction = `🤖 DISCRETION OVERRIDE (conviction ${discretionOverride.conviction}/100). Original score ${discretionOverride.originalScore} was below threshold but multi-signal agreement is strong. Treat with extra caution — half-size suggested. ${finalInstruction}`;
      mainRisk = `DISCRETION-overridden trade — soft filter(s) bypassed: ${discretionOverride.originalReasons?.join('; ') || 'score below threshold'}. Lower-probability than A+ trades.`;
    }
  } else if (decision === 'WATCHLIST ONLY') {
    // Show the actual trade structure even for WATCHLIST so user can act if they choose
    entry        = fmt.price(best.setup.entry);
    invalidation = fmt.price(best.setup.invalidation);
    stop         = invalidation;
    target1      = best.score.suggestedTarget1 ? fmt.price(best.score.suggestedTarget1) : '—';
    target2      = best.score.suggestedTarget2 ? fmt.price(best.score.suggestedTarget2) : '—';

    if (best.score.suggestedTarget1 && best.score.stopDist) {
      const t1Dist = Math.abs(best.score.suggestedTarget1 - best.setup.entry);
      const t2Dist = best.score.suggestedTarget2 ? Math.abs(best.score.suggestedTarget2 - best.setup.entry) : 0;
      rewardRisk = `${(t1Dist / best.score.stopDist).toFixed(2)}:1 to T1${t2Dist ? ` / ${(t2Dist / best.score.stopDist).toFixed(2)}:1 to T2` : ''}`;
      const sizing = calcPositionSize(best.setup.entry, best.setup.invalidation, riskDollars);
      positionSize = `${sizing.shares} units  ($${sizing.notional.toFixed(2)} notional)  Max loss: $${sizing.maxLoss.toFixed(2)}`;
    }

    confidence = 'low-medium (B-grade setup)';
    reasons = best.score.components
      .sort((a,b) => (b.score / b.max) - (a.score / a.max))
      .slice(0, 3)
      .map(c => `${c.name} (${c.score}/${c.max}) — ${c.note}`);
    mainRisk = `B-grade setup — score ${best.score.score}/10 vs A+ target ${minScore}. Lower probability. Smaller size if you take it.`;
    finalInstruction = best.setup.direction === 'LONG'
      ? `Optional ${best.setup.direction} — wait for next bullish confirmation bar at ${fmt.price(best.setup.entry)} or above. Set stop at ${fmt.price(best.setup.invalidation)} BEFORE entering. Cut size in half vs A+ trades.`
      : `Optional ${best.setup.direction} — wait for next bearish confirmation bar at ${fmt.price(best.setup.entry)} or below. Set stop at ${fmt.price(best.setup.invalidation)} BEFORE entering. Cut size in half vs A+ trades.`;
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
    htfBias,
    discretionOverride,
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
      htf: htfBias ? `${htfBias.htf}m ${htfBias.direction} (score ${htfBias.score >= 0 ? '+' : ''}${htfBias.score})` : 'n/a',
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

  // Education block — on by default, suppress with --no-teach
  if (CONFIG.teach) {
    L.hdr('📚 Today\'s Lesson');
    console.log(teachAnalysis(result));
  }
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      // Education-only modes — don't need chart access
      if (CONFIG.glossary) {
        console.log(fullGlossary());
        return;
      }
      if (CONFIG.explain) {
        console.log(teachConcept(CONFIG.explain));
        return;
      }
      const result = await analyze();
      printAnalysis(result);
      if (CONFIG.draw) {
        const r = await drawAnalysis(result);
        L.ok(`Drew on chart: ${r.drew} (${r.shapes} shapes)`);
      }
      if (CONFIG.log && (result.output.decision === 'LONG' || result.output.decision === 'SHORT')) {
        const o = result.output;
        const id = logPlanToJournal({
          symbol: o.ticker, timeframe: o.timeframe,
          setup: result.best?.setup?.name ?? '?',
          direction: o.decision,
          score: o.setupScore,
          biasScore: result.bias?.score ?? null,
          entry: result.best?.setup?.entry,
          stop: result.best?.setup?.invalidation,
          t1: result.best?.score?.suggestedTarget1,
          t2: result.best?.score?.suggestedTarget2,
          size: result.best ? Math.floor(CONFIG.riskDollars / Math.abs(result.best.setup.entry - result.best.setup.invalidation)) : null,
          riskAmount: CONFIG.riskDollars,
        });
        L.ok(`Logged plan to journal as id ${id.slice(0,8)}`);
      }
    } catch (e) {
      L.err(`Fatal: ${e.message}`);
      console.error(e.stack);
      process.exitCode = 1;
    } finally {
      await disconnect().catch(() => {});
    }
  })();
}
