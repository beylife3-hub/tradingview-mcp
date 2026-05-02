/**
 * Discretion Override — "AI judgment" layer.
 *
 * Composes ALL the bot's available signals into a single 0-100 conviction
 * score. If conviction is very high AND only SOFT filters tripped, the
 * bot can override the user's threshold/RR cutoff and take the trade.
 *
 * NEVER overrides HARD safety rules:
 *   - VIX > 30 / VIX spike
 *   - Anomaly detection (5σ)
 *   - Parabolic regime
 *   - News risk (FOMC/CPI/earnings ±30 min)
 *   - Manual lock from /pause
 *   - Daily/weekly drawdown limits
 *   - Consecutive-loss stoploss-guard
 *   - Stop > sanity cap %
 *
 * Logs every override to the audit log with full conviction breakdown.
 */

import { ensembleDecision } from './ensemble.js';
import { computeOrderFlow } from './order-flow.js';
import { getMultiplier as getAdaptiveMultiplier } from './adaptive-weights.js';
import { sampleArm, getExpectedWinRate } from './bandit.js';
import { getTickerSentiment } from './news-sentiment.js';

// ─── HARD vs SOFT filter classification ─────────────────────────────────────
// HARD = capital preservation, never bypass.
// SOFT = quality threshold, AI may override on high conviction.

const HARD_FILTER_PATTERNS = [
  /vix/i,                        // VIX halt
  /anomaly/i,                    // z-score black-swan
  /parabolic/i,                  // overextended vertical
  /news risk/i,                  // FOMC/CPI/NFP
  /news halt/i,
  /sentiment/i,                  // bearish news cluster
  /sanity cap/i,                 // stop too wide
  /portfolio risk:/i,            // total heat blow
  /Already \d+ open/i,           // max-positions per symbol
  /lock/i,                       // manual + auto locks
  /drawdown/i,                   // daily/weekly DD
  /consecutive losses/i,         // stoploss guard
  /stop-outs in last/i,          // stoploss guard
];

const SOFT_FILTER_PATTERNS = [
  /R:R only/i,                   // R:R slightly under
  /Volume below/i,               // weak volume
  /Price extremely extended/i,   // 2.5× ATR check
  /chop zone/i,                  // VP POC proximity
  /spread/i,                     // bid/ask spread
  /Adaptive ban/i,               // can override if other signals say otherwise
];

/**
 * Classify a rejection reason as 'hard' or 'soft'.
 */
export function classifyRejection(reasonStr) {
  for (const re of HARD_FILTER_PATTERNS) {
    if (re.test(reasonStr)) return 'hard';
  }
  for (const re of SOFT_FILTER_PATTERNS) {
    if (re.test(reasonStr)) return 'soft';
  }
  return 'soft';   // default to soft (override-eligible)
}

// ─── Conviction scoring ──────────────────────────────────────────────────────

/**
 * Compute a 0-100 conviction score combining ALL the bot's signals.
 * High conviction = many independent signals agree.
 *
 * Components (each 0-N points, total max 100):
 *   1. Base setup score (×4)        — 0-40 pts (10/10 setup → 40)
 *   2. Ensemble agreement            — 0-15 pts (all 4 voters agree → 15)
 *   3. HTF alignment                  — 0-10 pts (HTF bullish + LONG = 10)
 *   4. Order flow agreement           — 0-10 pts (CVD divergence + absorption agree)
 *   5. Adaptive expectancy            — 0-10 pts (multiplier > 1.2 → 10)
 *   6. Bandit win rate                — 0-7 pts (>= 60% expected WR)
 *   7. News sentiment alignment       — 0-5 pts (matches direction)
 *   8. Volume confluence              — 0-3 pts (>= 1.5× avg)
 *
 * Returns: { conviction, breakdown }
 */
export async function computeConviction({ result, bars, symbol }) {
  const o = result.output;
  const setup = result.best?.setup;
  if (!setup) return { conviction: 0, breakdown: [{ name: 'no setup', points: 0 }] };

  const direction = setup.direction;
  const breakdown = [];
  let total = 0;

  // 1. Base setup score (0-40)
  const setupPoints = (o.setupScore / 10) * 40;
  total += setupPoints;
  breakdown.push({ name: 'Setup score', points: Number(setupPoints.toFixed(1)), max: 40, note: `${o.setupScore}/10 × 4` });

  // 2. Ensemble agreement (0-15)
  let ensemblePoints = 0;
  try {
    const ens = ensembleDecision(bars, { symbol });
    if (ens.decision === direction) {
      // Number of voters agreeing × 5
      const agreeing = ens.votes.filter(v => v.direction === direction).length;
      ensemblePoints = Math.min(15, agreeing * 5);
    } else if (ens.decision && ens.decision !== direction) {
      ensemblePoints = -10;   // ensemble actively disagrees → strong negative signal
    }
    total += ensemblePoints;
    breakdown.push({ name: 'Ensemble', points: Number(ensemblePoints.toFixed(1)), max: 15,
      note: ens.decision ? `${ens.decision} consensus from ${ens.votes.length} voters` : 'no consensus' });
  } catch { /* ensemble may fail */ }

  // 3. HTF alignment (0-10)
  let htfPoints = 0;
  if (result.htfBias) {
    if (result.htfBias.direction === 'BULLISH' && direction === 'LONG')   htfPoints = 10;
    else if (result.htfBias.direction === 'BEARISH' && direction === 'SHORT') htfPoints = 10;
    else if (result.htfBias.direction === 'NEUTRAL')                       htfPoints = 5;
    else                                                                    htfPoints = -5;   // counter
    total += htfPoints;
    breakdown.push({ name: 'HTF bias', points: htfPoints, max: 10,
      note: `${result.htfBias.htf}m ${result.htfBias.direction}` });
  }

  // 4. Order flow agreement (0-10)
  let flowPoints = 0;
  try {
    const flow = computeOrderFlow(bars);
    if (flow.cvd?.divergence?.detected) {
      const divDir = flow.cvd.divergence.type === 'bullish' ? 'LONG' : 'SHORT';
      if (divDir === direction) flowPoints += 5;
    }
    if (flow.absorption?.absorbed) {
      const absDir = flow.absorption.side === 'lower' ? 'LONG' : 'SHORT';
      if (absDir === direction) flowPoints += 3;
    }
    if (flow.effortResult?.kind === 'continuation') flowPoints += 2;
    total += flowPoints;
    if (flowPoints) breakdown.push({ name: 'Order flow', points: flowPoints, max: 10, note: 'CVD/absorption/effort' });
  } catch { /* skip */ }

  // 5. Adaptive expectancy (0-10)
  try {
    const adaptiveMult = getAdaptiveMultiplier(setup.name, symbol, result.regime?.type || 'all');
    const adaptivePoints = (adaptiveMult - 1.0) * 20;   // 1.5 → +10, 0.5 → -10
    const clamped = Math.max(-10, Math.min(10, adaptivePoints));
    total += clamped;
    if (Math.abs(clamped) > 1) {
      breakdown.push({ name: 'Adaptive', points: Number(clamped.toFixed(1)), max: 10,
        note: `${(adaptiveMult * 100).toFixed(0)}% recent expectancy` });
    }
  } catch { /* no adaptive state yet */ }

  // 6. Bandit win rate (0-7)
  try {
    const wr = getExpectedWinRate(setup.name, symbol);
    let banditPoints = 0;
    if (wr >= 0.65)      banditPoints = 7;
    else if (wr >= 0.55) banditPoints = 4;
    else if (wr >= 0.45) banditPoints = 0;
    else                 banditPoints = -5;   // bandit thinks setup is bad
    total += banditPoints;
    if (banditPoints) breakdown.push({ name: 'Bandit', points: banditPoints, max: 7, note: `expected WR ${(wr*100).toFixed(0)}%` });
  } catch { /* no bandit state yet */ }

  // 7. News sentiment alignment (0-5)
  try {
    const sent = await getTickerSentiment(symbol);
    if (sent && sent.headlineCount >= 2) {
      let sentPoints = 0;
      if (sent.avgScore > 0.2 && direction === 'LONG')       sentPoints = 5;
      else if (sent.avgScore < -0.2 && direction === 'SHORT') sentPoints = 5;
      else if (sent.avgScore > 0.2 && direction === 'SHORT')  sentPoints = -5;
      else if (sent.avgScore < -0.2 && direction === 'LONG')  sentPoints = -5;
      total += sentPoints;
      if (sentPoints) breakdown.push({ name: 'News sentiment', points: sentPoints, max: 5,
        note: `${sent.headlineCount} headlines, avg ${sent.avgScore}` });
    }
  } catch { /* skip */ }

  // 8. Volume confluence (0-3)
  if (bars && bars.length > 20) {
    const recent = bars.slice(-21, -1);
    const avgVol = recent.reduce((s, b) => s + (b.volume || 0), 0) / recent.length;
    const lastVol = bars[bars.length - 1].volume || 0;
    const ratio = avgVol > 0 ? lastVol / avgVol : 1;
    let volPoints = 0;
    if (ratio >= 2.0)      volPoints = 3;
    else if (ratio >= 1.5) volPoints = 2;
    else if (ratio >= 1.2) volPoints = 1;
    total += volPoints;
    if (volPoints) breakdown.push({ name: 'Volume', points: volPoints, max: 3, note: `${ratio.toFixed(2)}× avg` });
  }

  return {
    conviction: Math.max(0, Math.min(100, Math.round(total))),
    breakdown,
  };
}

// ─── Override decision ──────────────────────────────────────────────────────

/**
 * Decide whether to override a rejected trade.
 *
 * @param {object} result - from coach.analyze()
 * @param {Array} rejectionReasons - the reasons array from applyStrictFilters
 * @param {object} opts - { conviction, threshold, allowWatchlist }
 * @returns {object} { override: bool, reason, conviction, hardBlocked, softReasons }
 */
export function shouldOverride({ rejectionReasons = [], conviction, threshold = 80, originalScore, minScore }) {
  // Classify each rejection
  const hardBlocked = [];
  const softReasons = [];
  for (const r of rejectionReasons) {
    const cls = classifyRejection(r);
    if (cls === 'hard') hardBlocked.push(r);
    else softReasons.push(r);
  }

  // If ANY hard block, never override
  if (hardBlocked.length > 0) {
    return {
      override: false,
      reason: `Hard safety rule(s) blocking — never override: ${hardBlocked.join('; ')}`,
      hardBlocked, softReasons, conviction,
    };
  }

  // Below-threshold score is the most common "soft" reason — check it specifically
  const scoreShortfall = originalScore != null && minScore != null && originalScore < minScore;

  // Conviction must clear the override threshold
  if (conviction < threshold) {
    return {
      override: false,
      reason: `Conviction ${conviction}/100 below override threshold ${threshold}`,
      hardBlocked, softReasons, conviction,
    };
  }

  // High conviction + only soft blocks → ALLOW override
  return {
    override: true,
    reason: `🤖 DISCRETION OVERRIDE — conviction ${conviction}/100 ≥ ${threshold}; soft filter(s) bypassed: ${softReasons.join('; ') || (scoreShortfall ? `score ${originalScore} below ${minScore}` : 'none')}`,
    hardBlocked, softReasons, conviction,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { analyze } = await import('./coach.js');
    const data = await import('../src/core/data.js');
    const { disconnect } = await import('../src/connection.js');
    try {
      const result = await analyze({});
      const ohlcv = await data.getOhlcv({ count: 200, summary: false });
      const o = result.output;
      console.log(`\n━ Conviction Analysis ━\n`);
      console.log(`Symbol: ${o.ticker}  Decision: ${o.decision}  Score: ${o.setupScore}/10`);
      if (!result.best) { console.log('(no setup detected)'); process.exit(0); }
      const c = await computeConviction({ result, bars: ohlcv.bars, symbol: o.ticker });
      console.log(`\nConviction: ${c.conviction}/100\n`);
      for (const b of c.breakdown) {
        const sign = b.points >= 0 ? '+' : '';
        console.log(`  ${sign}${b.points.toString().padStart(5)} / ${b.max.toString().padEnd(3)}  ${b.name.padEnd(20)} ${b.note}`);
      }
      console.log('');
      // If decision is NO TRADE, show what override would say
      if (o.decision === 'NO TRADE') {
        const reasons = (result.scored || []).flatMap(s => s.rejection || []);
        const ov = shouldOverride({
          rejectionReasons: reasons,
          conviction: c.conviction,
          originalScore: o.setupScore,
          minScore: 5.5,
        });
        console.log(`Override decision: ${ov.override ? '🟢 ALLOW' : '🔴 BLOCK'}`);
        console.log(`  ${ov.reason}`);
      }
    } finally { await disconnect().catch(() => {}); }
  })();
}
