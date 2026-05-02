/**
 * Multi-Strategy Ensemble — voter system.
 *
 * Multiple independent strategy "voters" each emit a directional signal.
 * Trade only when multiple agree (configurable quorum).
 *
 * Voters:
 *   1. rules        — full coach.analyze() output
 *   2. sweep-only   — only Liquidity Sweep + Reclaim (highest doc'd edge)
 *   3. trend-only   — only Trend Pullback + ORB (continuation)
 *   4. mean-rev     — only Range Reversal + VWAP Bounce + EOD Fade
 *   5. price-action — pure candle: bullish engulfing or pin bar at level
 *
 * Meta-strategy: weight each voter by its rolling expectancy from the
 * journal. Voters with negative recent expectancy get half weight.
 *
 * Decision: trade only if weighted vote ≥ 2 (majority for direction).
 */

import { detectSweepReclaim, detectVWAPBounce, detectORB, detectTrendPullback,
         detectRangeReversal, detectFlag, detectGapFill, detectEODFade } from './setups.js';
import { extractKeyLevels } from './levels.js';
import { classifyRegime } from './regime.js';
import { computeVWAP } from './engine.js';
import { atr } from './engine.js';
import { getMultiplier } from './adaptive-weights.js';

// ─── Strategy voters ─────────────────────────────────────────────────────────

function voterSweepOnly(bars, structure, levels) {
  const r = detectSweepReclaim(bars);
  if (!r) return null;
  return { name: 'sweep-only', direction: r.direction, setup: r.name, confidence: 0.7 };
}

function voterTrendOnly(bars, structure, levels) {
  const pullback = detectTrendPullback(bars, levels, structure);
  if (pullback) return { name: 'trend-only', direction: pullback.direction, setup: pullback.name, confidence: 0.65 };
  const orb = detectORB(bars, levels);
  if (orb) return { name: 'trend-only', direction: orb.direction, setup: orb.name, confidence: 0.65 };
  const flag = detectFlag(bars);
  if (flag) return { name: 'trend-only', direction: flag.direction, setup: flag.name, confidence: 0.6 };
  return null;
}

function voterMeanReversion(bars, structure, levels) {
  const range = detectRangeReversal(bars, levels);
  if (range) return { name: 'mean-rev', direction: range.direction, setup: range.name, confidence: 0.6 };
  const vwap = detectVWAPBounce(bars, structure);
  if (vwap) return { name: 'mean-rev', direction: vwap.direction, setup: vwap.name, confidence: 0.65 };
  const eod = detectEODFade(bars, structure);
  if (eod) return { name: 'mean-rev', direction: eod.direction, setup: eod.name, confidence: 0.55 };
  const gap = detectGapFill(bars);
  if (gap) return { name: 'mean-rev', direction: gap.direction, setup: gap.name, confidence: 0.5 };
  return null;
}

function voterPriceAction(bars) {
  // Simple pure-candle voter: bullish engulfing or pin bar
  if (bars.length < 5) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const range = last.high - last.low;
  if (range === 0) return null;
  const closePos = (last.close - last.low) / range;
  const bodySize = Math.abs(last.close - last.open) / range;

  // Bullish engulfing
  if (last.close > last.open && prev.close < prev.open
      && last.close > prev.open && last.open <= prev.close
      && bodySize > 0.6) {
    return { name: 'price-action', direction: 'LONG', setup: 'Bullish Engulfing', confidence: 0.55 };
  }
  // Bearish engulfing
  if (last.close < last.open && prev.close > prev.open
      && last.close < prev.open && last.open >= prev.close
      && bodySize > 0.6) {
    return { name: 'price-action', direction: 'SHORT', setup: 'Bearish Engulfing', confidence: 0.55 };
  }
  // Bullish pin bar (long lower wick, close upper)
  const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
  const upperWick = (last.high - Math.max(last.open, last.close)) / range;
  if (lowerWick > 0.6 && closePos > 0.65) {
    return { name: 'price-action', direction: 'LONG', setup: 'Bullish Pin Bar', confidence: 0.5 };
  }
  if (upperWick > 0.6 && closePos < 0.35) {
    return { name: 'price-action', direction: 'SHORT', setup: 'Bearish Pin Bar', confidence: 0.5 };
  }
  return null;
}

// ─── Ensemble decision ──────────────────────────────────────────────────────

/**
 * Run all voters and return ensemble decision.
 *
 * @param {Array} bars
 * @param {object} opts - { quorum: minimum votes for decision (default 2) }
 * @returns {object} { decision: 'LONG'|'SHORT'|null, votes: [...], summary }
 */
export function ensembleDecision(bars, opts = {}) {
  const quorum = opts.quorum ?? 2;
  const symbol = opts.symbol || '*';

  // Build context once
  const closes = bars.map(b => b.close);
  const vwapResult = computeVWAP(bars, Math.min(78, bars.length));
  const last = bars[bars.length - 1];
  const atrSeries = atr(bars, 14);
  const structure = {
    price: last.close,
    open: last.open, high: last.high, low: last.low,
    atr: atrSeries[atrSeries.length - 1],
    vwap: vwapResult?.vwap ?? null,
  };
  const levels = extractKeyLevels(bars, structure);
  const regime = classifyRegime(bars);

  // Run voters
  const voterResults = [
    voterSweepOnly(bars, structure, levels),
    voterTrendOnly(bars, structure, levels),
    voterMeanReversion(bars, structure, levels),
    voterPriceAction(bars),
  ].filter(Boolean);

  // Apply adaptive multiplier per voter (each voter's setup gets its own weight)
  for (const v of voterResults) {
    v.adaptiveMult = getMultiplier(v.setup, symbol, regime?.type || 'all');
    v.weightedConfidence = v.confidence * v.adaptiveMult;
  }

  // Tally weighted votes per direction
  const tally = { LONG: 0, SHORT: 0 };
  for (const v of voterResults) tally[v.direction] += v.weightedConfidence;

  // Decision: direction with at least `quorum` weighted votes AND winning by margin
  const winner = tally.LONG > tally.SHORT ? 'LONG' : tally.SHORT > tally.LONG ? 'SHORT' : null;
  const winnerVotes = winner ? tally[winner] : 0;
  const loserVotes  = winner ? tally[winner === 'LONG' ? 'SHORT' : 'LONG'] : 0;

  let decision = null;
  if (winner && winnerVotes >= quorum && winnerVotes > loserVotes * 1.5) {
    decision = winner;
  }

  return {
    decision,
    votes: voterResults,
    tally,
    quorum,
    summary: voterResults.length === 0 ? 'no voter signaled' :
             decision ? `${decision} consensus (${winnerVotes.toFixed(2)} weighted votes)` :
             `no consensus (LONG ${tally.LONG.toFixed(2)} vs SHORT ${tally.SHORT.toFixed(2)})`,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const data = await import('../src/core/data.js');
    const chart = await import('../src/core/chart.js');
    const { disconnect } = await import('../src/connection.js');
    try {
      const state = await chart.getState();
      const ohlcv = await data.getOhlcv({ count: 200, summary: false });
      const r = ensembleDecision(ohlcv.bars, { symbol: state.symbol });
      console.log(`Ensemble decision: ${r.decision || 'NO CONSENSUS'}`);
      console.log(`Summary: ${r.summary}`);
      console.log(`\nVoter results:`);
      if (!r.votes.length) console.log('  (no voters signaled)');
      for (const v of r.votes) {
        const dirIcon = v.direction === 'LONG' ? '🟢' : '🔴';
        console.log(`  ${dirIcon} ${v.name.padEnd(15)} ${v.direction.padEnd(5)} ${v.setup.padEnd(35)} confidence ${v.confidence.toFixed(2)} × adaptive ${v.adaptiveMult.toFixed(2)} = ${v.weightedConfidence.toFixed(3)}`);
      }
      console.log(`\nTally:  LONG ${r.tally.LONG.toFixed(2)}  vs  SHORT ${r.tally.SHORT.toFixed(2)}`);
    } finally { await disconnect().catch(() => {}); }
  })();
}
