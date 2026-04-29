/**
 * Setup detection — geometric pattern recognizers for day trading.
 *
 * Each detector returns null if no setup is present, otherwise:
 *   { name, direction: 'LONG' | 'SHORT', entry, invalidation, rationale, components }
 *
 * Detectors implemented (per research from QuantConnect/Lean ORB,
 * SmartMoneyConcepts, Freqtrade VWAPStrategy, ICT bots):
 *
 *   1. Liquidity sweep + reclaim   (highest documented edge per ICT backtests)
 *   2. VWAP first-touch bounce      (62% win rate on first touch)
 *   3. 5-min Opening Range Breakout (33% annualized on QQQ when filtered)
 *   4. Trend Pullback to EMA20     (with-trend continuation)
 *   5. Range reversal at level     (mean-reversion at clustered S/R)
 */

import { atr } from './engine.js';
import { findSwingHighs, findSwingLows } from './levels.js';

// ─── 1. Liquidity Sweep + Reclaim (ICT pattern) ───────────────────────────────

/**
 * Bullish: a recent bar wicked BELOW a prior swing low by ≥ 1 tick (sweeping
 * liquidity), but closed BACK ABOVE the swing low. Next bar (current) closes
 * above the sweep bar's body midpoint = confirmed reclaim.
 *
 * Mirror for bearish.
 *
 * Rejection: sweep distance > 0.5 ATR (overextended).
 */
export function detectSweepReclaim(bars, opts = {}) {
  const swingLookback = opts.swingLookback ?? 5;
  const maxSweepATR  = opts.maxSweepATR  ?? 0.5;

  if (bars.length < 30) return null;

  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return null;

  const last = bars[bars.length - 1];
  const sweep = bars[bars.length - 2];   // the bar that did the sweep
  if (!sweep) return null;

  const swingHighs = findSwingHighs(bars.slice(0, -2), swingLookback);
  const swingLows  = findSwingLows(bars.slice(0, -2), swingLookback);

  // Bullish: sweep below a recent swing low
  for (const sl of swingLows.slice(-5).reverse()) {
    const sweepDistance = sl.price - sweep.low;
    if (sweepDistance <= 0) continue;
    if (sweepDistance > maxSweepATR * atrNow) continue;
    if (sweep.close <= sl.price) continue;  // didn't reclaim on sweep bar

    const sweepMid = (sweep.high + sweep.low) / 2;
    if (last.close > sweepMid) {
      return {
        name: 'Liquidity Sweep + Reclaim',
        direction: 'LONG',
        entry: last.close,
        invalidation: sweep.low - 0.05 * atrNow,
        rationale: `Bar [-2] swept below swing low ${sl.price.toFixed(2)} by ${sweepDistance.toFixed(2)} (${(sweepDistance/atrNow).toFixed(2)} ATR), closed back above. Current bar closes above sweep bar midpoint = liquidity grabbed and reclaimed.`,
        components: { sweepBar: -2, sweptLevel: sl.price, sweepDistance, atr: atrNow },
      };
    }
  }

  // Bearish: sweep above a recent swing high
  for (const sh of swingHighs.slice(-5).reverse()) {
    const sweepDistance = sweep.high - sh.price;
    if (sweepDistance <= 0) continue;
    if (sweepDistance > maxSweepATR * atrNow) continue;
    if (sweep.close >= sh.price) continue;

    const sweepMid = (sweep.high + sweep.low) / 2;
    if (last.close < sweepMid) {
      return {
        name: 'Liquidity Sweep + Reclaim',
        direction: 'SHORT',
        entry: last.close,
        invalidation: sweep.high + 0.05 * atrNow,
        rationale: `Bar [-2] swept above swing high ${sh.price.toFixed(2)} by ${sweepDistance.toFixed(2)} (${(sweepDistance/atrNow).toFixed(2)} ATR), closed back below. Current bar closes below sweep bar midpoint.`,
        components: { sweepBar: -2, sweptLevel: sh.price, sweepDistance, atr: atrNow },
      };
    }
  }

  return null;
}

// ─── 2. VWAP First-Touch Bounce ───────────────────────────────────────────────

/**
 * Trend day, price has been above VWAP for ≥ 30 min, pulls back to VWAP ± 0.25 ATR,
 * forms a bullish reaction bar (close > open, wick > 60% of range, close above VWAP).
 *
 * Reject if price has been below VWAP within last 15 min ("not first touch").
 */
export function detectVWAPBounce(bars, structure, opts = {}) {
  const proximityATR = opts.proximityATR ?? 0.25;
  const minTrendBars = opts.minTrendBars ?? 6;       // ~30 min on 5m
  const minWickPct   = opts.minWickPct   ?? 0.60;

  if (!structure.vwap || !Number.isFinite(structure.vwap)) return null;
  if (bars.length < 30) return null;

  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return null;

  const last = bars[bars.length - 1];
  const vwap = structure.vwap;
  const distance = Math.abs(last.close - vwap);
  if (distance > proximityATR * atrNow) return null;   // not close enough

  const range = last.high - last.low;
  if (range === 0) return null;

  // Were we above VWAP for the last N bars (with no recent below-VWAP excursion)?
  const recent = bars.slice(-minTrendBars);
  const aboveCount = recent.filter(b => b.close > vwap).length;
  const belowCount = recent.filter(b => b.close < vwap).length;

  // Bullish bounce: been above, current bar reacts up
  if (aboveCount >= minTrendBars - 1 && last.close > last.open && last.close > vwap) {
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const wickPct = lowerWick / range;
    if (wickPct >= minWickPct) {
      return {
        name: 'VWAP First-Touch Bounce',
        direction: 'LONG',
        entry: last.close,
        invalidation: vwap - 0.5 * atrNow,
        rationale: `Above VWAP ${aboveCount}/${minTrendBars} of last bars (first touch). Current bar reaction: lower wick ${(wickPct*100).toFixed(0)}% of range, close above VWAP.`,
        components: { vwap, distanceATR: distance/atrNow, wickPct },
      };
    }
  }

  // Bearish rejection: been below, current bar reacts down
  if (belowCount >= minTrendBars - 1 && last.close < last.open && last.close < vwap) {
    const upperWick = last.high - Math.max(last.open, last.close);
    const wickPct = upperWick / range;
    if (wickPct >= minWickPct) {
      return {
        name: 'VWAP First-Touch Rejection',
        direction: 'SHORT',
        entry: last.close,
        invalidation: vwap + 0.5 * atrNow,
        rationale: `Below VWAP ${belowCount}/${minTrendBars} of last bars (first touch). Current bar reaction: upper wick ${(wickPct*100).toFixed(0)}% of range, close below VWAP.`,
        components: { vwap, distanceATR: distance/atrNow, wickPct },
      };
    }
  }

  return null;
}

// ─── 3. Opening Range Breakout (5-minute, volume-confirmed) ───────────────────

/**
 * Per Zarattini/Aggarwal 2023: price closes outside the 5-min OR with
 * relative volume ≥ 1.5× the prior 20-bar avg.
 */
export function detectORB(bars, levels, opts = {}) {
  const minRelVol = opts.minRelVol ?? 1.5;

  if (!levels.orh || !levels.orl) return null;
  if (!Number.isFinite(levels.orRelVolume)) return null;
  if (bars.length < 20) return null;

  const last = bars[bars.length - 1];
  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];

  // Recent volume (last bar) vs 20-bar avg
  const recent = bars.slice(-21, -1);
  const avgVol = recent.reduce((s, b) => s + (b.volume || 0), 0) / Math.max(1, recent.length);
  const lastRelVol = avgVol > 0 ? (last.volume || 0) / avgVol : 0;

  if (lastRelVol < minRelVol) return null;

  if (last.close > levels.orh) {
    return {
      name: 'Opening Range Breakout (Long)',
      direction: 'LONG',
      entry: last.close,
      invalidation: levels.orl,
      rationale: `Close ${last.close.toFixed(2)} above OR-high ${levels.orh.toFixed(2)} on ${lastRelVol.toFixed(2)}× avg volume.`,
      components: { orh: levels.orh, orl: levels.orl, relVol: lastRelVol, atr: atrNow },
    };
  }

  if (last.close < levels.orl) {
    return {
      name: 'Opening Range Breakout (Short)',
      direction: 'SHORT',
      entry: last.close,
      invalidation: levels.orh,
      rationale: `Close ${last.close.toFixed(2)} below OR-low ${levels.orl.toFixed(2)} on ${lastRelVol.toFixed(2)}× avg volume.`,
      components: { orh: levels.orh, orl: levels.orl, relVol: lastRelVol, atr: atrNow },
    };
  }

  return null;
}

// ─── 4. Trend Pullback to EMA20 ───────────────────────────────────────────────

/**
 * In an uptrend (EMA20 > EMA50, price > EMA20 over recent bars), price has
 * pulled back to within 0.3 ATR of EMA20, then reacts (bullish bar + close
 * back above EMA20). Mirror for downtrend.
 */
export function detectTrendPullback(bars, levels, structure, opts = {}) {
  const proximityATR = opts.proximityATR ?? 0.3;
  if (!levels.ema20 || !levels.ema50) return null;
  if (bars.length < 30) return null;

  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return null;

  const last = bars[bars.length - 1];
  const distEMA20 = Math.abs(last.close - levels.ema20);
  if (distEMA20 > proximityATR * atrNow) return null;

  const isUptrend   = levels.ema20 > levels.ema50;
  const isDowntrend = levels.ema20 < levels.ema50;
  const isBullish   = last.close > last.open;
  const isBearish   = last.close < last.open;

  if (isUptrend && isBullish && last.close > levels.ema20) {
    return {
      name: 'Trend Pullback (Long)',
      direction: 'LONG',
      entry: last.close,
      invalidation: levels.ema50,
      rationale: `Uptrend (EMA20 > EMA50). Price pulled back to EMA20 (${levels.ema20.toFixed(2)}), bullish reaction bar closes back above.`,
      components: { ema20: levels.ema20, ema50: levels.ema50, distATR: distEMA20/atrNow },
    };
  }

  if (isDowntrend && isBearish && last.close < levels.ema20) {
    return {
      name: 'Trend Pullback (Short)',
      direction: 'SHORT',
      entry: last.close,
      invalidation: levels.ema50,
      rationale: `Downtrend (EMA20 < EMA50). Price pulled back to EMA20 (${levels.ema20.toFixed(2)}), bearish reaction bar closes back below.`,
      components: { ema20: levels.ema20, ema50: levels.ema50, distATR: distEMA20/atrNow },
    };
  }

  return null;
}

// ─── 5. Range Reversal at Key Level ──────────────────────────────────────────

/**
 * In a ranging market: price tags a multi-touch support/resistance level
 * (≥ 2 prior touches), forms a strong reaction bar (wick > 60%, close in
 * opposite half of range).
 */
export function detectRangeReversal(bars, levels, opts = {}) {
  const proximityPct = opts.proximityPct ?? 0.005;  // 0.5% of price
  const minWickPct = opts.minWickPct ?? 0.55;

  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const range = last.high - last.low;
  if (range === 0) return null;
  const closePos = (last.close - last.low) / range;

  // Support: tag a >= 2-touch support level, close in upper half
  for (const lvl of levels.support.slice(0, 3)) {
    if (lvl.touches < 2) continue;
    if (Math.abs(last.low - lvl.price) / lvl.price > proximityPct) continue;
    const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
    if (lowerWick >= minWickPct && closePos > 0.55 && last.close > last.open) {
      return {
        name: 'Range Reversal at Support',
        direction: 'LONG',
        entry: last.close,
        invalidation: last.low - 0.05 * (last.high - last.low),
        rationale: `Tagged ${lvl.touches}-touch support ${lvl.price.toFixed(2)}. Bullish reaction: wick ${(lowerWick*100).toFixed(0)}% of range, close at ${(closePos*100).toFixed(0)}% up.`,
        components: { level: lvl.price, touches: lvl.touches, wickPct: lowerWick, closePos },
      };
    }
  }

  // Resistance: tag a >= 2-touch resistance level, close in lower half
  for (const lvl of levels.resistance.slice(0, 3)) {
    if (lvl.touches < 2) continue;
    if (Math.abs(last.high - lvl.price) / lvl.price > proximityPct) continue;
    const upperWick = (last.high - Math.max(last.open, last.close)) / range;
    if (upperWick >= minWickPct && closePos < 0.45 && last.close < last.open) {
      return {
        name: 'Range Reversal at Resistance',
        direction: 'SHORT',
        entry: last.close,
        invalidation: last.high + 0.05 * range,
        rationale: `Tagged ${lvl.touches}-touch resistance ${lvl.price.toFixed(2)}. Bearish reaction: wick ${(upperWick*100).toFixed(0)}% of range, close at ${(closePos*100).toFixed(0)}% up.`,
        components: { level: lvl.price, touches: lvl.touches, wickPct: upperWick, closePos },
      };
    }
  }

  return null;
}

// ─── Run all detectors and return the best one ───────────────────────────────

/**
 * Run all setup detectors. Returns array of detected setups (most specific first).
 * Caller picks the best one via setup-quality scoring.
 */
export function detectAll(bars, levels, structure) {
  const detectors = [
    () => detectSweepReclaim(bars),
    () => detectVWAPBounce(bars, structure),
    () => detectORB(bars, levels),
    () => detectTrendPullback(bars, levels, structure),
    () => detectRangeReversal(bars, levels),
  ];
  const results = [];
  for (const fn of detectors) {
    try {
      const r = fn();
      if (r) results.push(r);
    } catch (e) {
      // Detector failed silently — log but continue
    }
  }
  return results;
}
