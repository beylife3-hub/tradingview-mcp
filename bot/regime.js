/**
 * Market regime classifier.
 *
 * Per Mark Fisher (ACD method) and replicated in `backtrader/IBS_TrendFilter`,
 * by 10:30 ET if price is > 1.5× the opening 30-min range AND VWAP slope is
 * monotonic, the day classifies as a TREND DAY → only with-trend pullbacks.
 *
 * Otherwise it's a RANGE DAY → fade extremes.
 *
 * Outputs one of: 'trending-up', 'trending-down', 'ranging', 'choppy', 'parabolic'
 *
 * Each environment fits a different style:
 *   trending-up/down → momentum or pullback
 *   ranging          → mean reversion at extremes
 *   choppy           → no trade
 *   parabolic        → no trade (too extended)
 */

import { ema, atr, mean, stdev } from './engine.js';

/**
 * Classify current market regime from bars.
 *
 * @param {Array} bars - OHLCV bars
 * @param {object} opts
 * @param {number} opts.atrPeriod - ATR period (default 14)
 * @param {number} opts.lookback - bars to consider for regime (default 30)
 * @returns {object} { type, confidence, reason, pricePathEfficiency, atrPercentile, fitsStyle }
 */
export function classifyRegime(bars, opts = {}) {
  const atrPeriod = opts.atrPeriod ?? 14;
  const lookback  = opts.lookback  ?? 30;

  if (bars.length < lookback + atrPeriod) {
    return { type: 'unknown', confidence: 0, reason: 'insufficient bars', fitsStyle: 'none' };
  }

  const recent = bars.slice(-lookback);
  const closes = recent.map(b => b.close);
  const last = recent[recent.length - 1];
  const first = recent[0];

  // ─── Price path efficiency ────────────────────────────────────────────────
  // Net move / sum of absolute moves. 1.0 = perfect trend, 0 = pure noise.
  const netMove = Math.abs(last.close - first.close);
  let totalMove = 0;
  for (let i = 1; i < recent.length; i++) {
    totalMove += Math.abs(recent[i].close - recent[i - 1].close);
  }
  const efficiency = totalMove > 0 ? netMove / totalMove : 0;

  // ─── EMA slopes (trending up/down vs sideways) ────────────────────────────
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e20Now = e20[e20.length - 1];
  const e20Old = e20[Math.max(0, e20.length - 10)];
  const e20Slope = (e20Now - e20Old) / e20Old;
  const e50Now = e50[e50.length - 1];

  // ─── ATR percentile (high vol = parabolic risk, low vol = ranging) ────────
  const atrSeries = atr(bars, atrPeriod);
  const atrCurrent = atrSeries[atrSeries.length - 1];
  const atrHistory = atrSeries.slice(-100).filter(Number.isFinite);
  const atrMean = mean(atrHistory);
  const atrStd  = stdev(atrHistory);
  const atrPercentile = atrStd > 0 ? (atrCurrent - atrMean) / atrStd : 0;

  // ─── Range expansion ratio (parabolic detection) ──────────────────────────
  const lastBarRange = last.high - last.low;
  const rangeRatio = atrCurrent > 0 ? lastBarRange / atrCurrent : 1;

  // ─── Classification logic ────────────────────────────────────────────────
  let type, confidence, reason, fitsStyle;

  if (rangeRatio > 3 && atrPercentile > 1.5) {
    type = 'parabolic';
    confidence = 0.9;
    reason = `Last bar range ${rangeRatio.toFixed(1)}× ATR with ATR ${atrPercentile.toFixed(1)}σ above mean — overextended.`;
    fitsStyle = 'wait';
  } else if (efficiency > 0.45 && Math.abs(e20Slope) > 0.001) {
    // Strong directional move with high path efficiency
    type = e20Slope > 0 ? 'trending-up' : 'trending-down';
    confidence = Math.min(0.95, 0.5 + efficiency);
    reason = `Path efficiency ${(efficiency * 100).toFixed(0)}% with EMA20 slope ${(e20Slope * 100).toFixed(2)}%. Trend day signature.`;
    fitsStyle = 'momentum-or-pullback';
  } else if (efficiency < 0.18 && Math.abs(e20Slope) < 0.0005) {
    type = 'choppy';
    confidence = 0.7;
    reason = `Path efficiency only ${(efficiency * 100).toFixed(0)}% and flat EMA20 — pure noise. No-trade environment.`;
    fitsStyle = 'wait';
  } else if (efficiency < 0.35) {
    type = 'ranging';
    confidence = 0.6;
    reason = `Path efficiency ${(efficiency * 100).toFixed(0)}%. Range day — fade level extremes.`;
    fitsStyle = 'mean-reversion';
  } else {
    // Weakly trending — trade with caution
    type = e20Slope > 0 ? 'trending-up' : 'trending-down';
    confidence = 0.4;
    reason = `Weak trend (efficiency ${(efficiency * 100).toFixed(0)}%) — expect continuation but smaller targets.`;
    fitsStyle = 'pullback';
  }

  return {
    type, confidence, reason, fitsStyle,
    pricePathEfficiency: efficiency,
    atrPercentile,
    atrCurrent,
    rangeRatio,
    e20Slope,
  };
}

/** Human-readable summary for the coach output. */
export function regimeSummary(regime) {
  const map = {
    'trending-up':   '📈 Trend day (up)',
    'trending-down': '📉 Trend day (down)',
    'ranging':       '↔️ Range day',
    'choppy':        '🌊 Chop / noise',
    'parabolic':     '🚀 Parabolic / overextended',
    'unknown':       '❓ Unknown',
  };
  return map[regime.type] || regime.type;
}

/** Style this regime fits — used by the coach to decide setup type. */
export function styleFor(regime) {
  return regime.fitsStyle;  // 'momentum-or-pullback' | 'pullback' | 'mean-reversion' | 'wait'
}
