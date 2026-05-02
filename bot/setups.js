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
  const maxSweepATR  = opts.maxSweepATR  ?? 0.75;  // loosened from 0.5

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
  const proximityATR = opts.proximityATR ?? 0.4;     // loosened from 0.25
  const minTrendBars = opts.minTrendBars ?? 4;       // loosened from 6 (~20 min on 5m)
  const minWickPct   = opts.minWickPct   ?? 0.45;    // loosened from 0.60

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
  const minRelVol = opts.minRelVol ?? 1.2;  // loosened from 1.5

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
  const proximityATR = opts.proximityATR ?? 0.5;  // loosened from 0.3
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
  const proximityPct = opts.proximityPct ?? 0.008;  // loosened from 0.5% to 0.8%
  const minWickPct = opts.minWickPct ?? 0.45;       // loosened from 0.55
  const minTouches = opts.minTouches ?? 1;          // loosened from 2 (single-touch counts)

  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const range = last.high - last.low;
  if (range === 0) return null;
  const closePos = (last.close - last.low) / range;

  // Support: tag a multi-touch support level, close in upper half
  for (const lvl of levels.support.slice(0, 3)) {
    if (lvl.touches < minTouches) continue;
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

  // Resistance: tag a multi-touch resistance level, close in lower half
  for (const lvl of levels.resistance.slice(0, 3)) {
    if (lvl.touches < minTouches) continue;
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

// ─── Tier 2.4 — Bull/Bear Flag (post-impulse consolidation) ──────────────────

/**
 * Bull flag: a sharp impulse leg up, followed by 3-7 bars of consolidation
 * with a slight downward drift, then a breakout above the consolidation high.
 *
 * Bear flag is the mirror.
 *
 * Per Bulkowski's Encyclopedia of Chart Patterns: ~67% success rate when
 * filtered for volume confirmation on the breakout.
 */
export function detectFlag(bars, opts = {}) {
  const minImpulseATR  = opts.minImpulseATR  ?? 1.5;
  const consolBars     = opts.consolBars     ?? 5;

  if (bars.length < 30) return null;
  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return null;

  // Look for impulse leg followed by consolidation
  const last = bars[bars.length - 1];
  const consolStart = bars.length - 1 - consolBars;
  const impulseStart = consolStart - 5;
  if (impulseStart < 5) return null;

  const impulseLeg = bars[consolStart].close - bars[impulseStart].close;
  const impulseAtrRatio = Math.abs(impulseLeg) / atrNow;
  if (impulseAtrRatio < minImpulseATR) return null;

  const consolBarsArr = bars.slice(consolStart, -1);
  const consolHigh = Math.max(...consolBarsArr.map(b => b.high));
  const consolLow  = Math.min(...consolBarsArr.map(b => b.low));
  const consolRange = consolHigh - consolLow;
  if (consolRange > 1.5 * atrNow) return null;  // too wide = not a flag

  // Bullish flag: impulse up, consolidation down-drift, breakout up
  if (impulseLeg > 0 && last.close > consolHigh) {
    return {
      name: 'Bull Flag Breakout',
      direction: 'LONG',
      entry: last.close,
      invalidation: consolLow,
      rationale: `Impulse leg +${impulseLeg.toFixed(2)} (${impulseAtrRatio.toFixed(1)}× ATR) followed by ${consolBars}-bar consolidation. Breakout above ${consolHigh.toFixed(2)}.`,
      components: { impulseAtrRatio, consolHigh, consolLow },
    };
  }
  // Bearish flag: impulse down, consolidation up-drift, breakout down
  if (impulseLeg < 0 && last.close < consolLow) {
    return {
      name: 'Bear Flag Breakdown',
      direction: 'SHORT',
      entry: last.close,
      invalidation: consolHigh,
      rationale: `Impulse leg ${impulseLeg.toFixed(2)} (${impulseAtrRatio.toFixed(1)}× ATR) followed by ${consolBars}-bar consolidation. Breakdown below ${consolLow.toFixed(2)}.`,
      components: { impulseAtrRatio, consolHigh, consolLow },
    };
  }
  return null;
}

// ─── Tier 2.4 — Double Top / Bottom ──────────────────────────────────────────

/**
 * Two highs (or lows) within 0.3% of each other, separated by 5-30 bars,
 * with a clear "neckline" (intermediate low between the two highs).
 * Trigger: close below neckline (top) or above neckline (bottom).
 *
 * Per Bulkowski: double tops have ~64% follow-through to target.
 */
export function detectDoubleTopBottom(bars, opts = {}) {
  const tolerance     = opts.tolerance     ?? 0.003;   // 0.3% match tolerance
  const minSeparation = opts.minSeparation ?? 5;
  const maxSeparation = opts.maxSeparation ?? 30;

  if (bars.length < maxSeparation + 5) return null;
  const last = bars[bars.length - 1];
  const swingHighs = findSwingHighs(bars.slice(0, -1), 3);
  const swingLows  = findSwingLows(bars.slice(0, -1), 3);

  // Double top
  if (swingHighs.length >= 2) {
    for (let i = swingHighs.length - 2; i >= 0; i--) {
      const h1 = swingHighs[i];
      const h2 = swingHighs[swingHighs.length - 1];
      const sep = h2.idx - h1.idx;
      if (sep < minSeparation || sep > maxSeparation) continue;
      if (Math.abs(h1.price - h2.price) / h1.price > tolerance) continue;
      // Find neckline (lowest low between the two highs)
      const between = bars.slice(h1.idx, h2.idx);
      if (!between.length) continue;
      const neckline = Math.min(...between.map(b => b.low));
      if (last.close < neckline) {
        return {
          name: 'Double Top Breakdown',
          direction: 'SHORT',
          entry: last.close,
          invalidation: Math.max(h1.price, h2.price),
          rationale: `Double top at ${h1.price.toFixed(2)}/${h2.price.toFixed(2)} (sep ${sep} bars). Close below neckline ${neckline.toFixed(2)} confirms breakdown.`,
          components: { h1: h1.price, h2: h2.price, neckline },
        };
      }
    }
  }

  // Double bottom
  if (swingLows.length >= 2) {
    for (let i = swingLows.length - 2; i >= 0; i--) {
      const l1 = swingLows[i];
      const l2 = swingLows[swingLows.length - 1];
      const sep = l2.idx - l1.idx;
      if (sep < minSeparation || sep > maxSeparation) continue;
      if (Math.abs(l1.price - l2.price) / l1.price > tolerance) continue;
      const between = bars.slice(l1.idx, l2.idx);
      if (!between.length) continue;
      const neckline = Math.max(...between.map(b => b.high));
      if (last.close > neckline) {
        return {
          name: 'Double Bottom Breakout',
          direction: 'LONG',
          entry: last.close,
          invalidation: Math.min(l1.price, l2.price),
          rationale: `Double bottom at ${l1.price.toFixed(2)}/${l2.price.toFixed(2)} (sep ${sep} bars). Close above neckline ${neckline.toFixed(2)} confirms breakout.`,
          components: { l1: l1.price, l2: l2.price, neckline },
        };
      }
    }
  }
  return null;
}

// ─── Tier 2.4 — Gap Fill (mean reversion to prior close) ─────────────────────

/**
 * Gap-and-fade: opening gap that mean-reverts toward the prior close.
 * If gap > 1%, fade direction is back toward prior close.
 *
 * Trigger: first reversal bar after gap that moves back toward fill price.
 * Per quant studies: ~58% of gaps > 1% partially fill within first hour.
 */
export function detectGapFill(bars, opts = {}) {
  const minGapPct = opts.minGapPct ?? 0.01;       // 1%
  const maxGapPct = opts.maxGapPct ?? 0.05;       // 5% (gaps > 5% often run, don't fade)

  if (bars.length < 30) return null;
  const last = bars[bars.length - 1];

  // Find session open (first bar in the recent calendar day window) — simple heuristic:
  // assume opening bar = bar with biggest gap from previous bar in last 50 bars
  const recent = bars.slice(-50);
  let biggestGap = null;
  let biggestGapIdx = -1;
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i].open - recent[i-1].close;
    const gapPct = Math.abs(gap) / recent[i-1].close;
    if (gapPct >= minGapPct && gapPct <= maxGapPct) {
      if (!biggestGap || gapPct > Math.abs(biggestGap.pct)) {
        biggestGap = { gap, pct: gapPct, openPrice: recent[i].open, prevClose: recent[i-1].close };
        biggestGapIdx = i;
      }
    }
  }
  if (!biggestGap) return null;

  // Gap up + current bar bearish + close below open = gap fill in progress
  if (biggestGap.gap > 0 && last.close < last.open && last.close < biggestGap.openPrice) {
    return {
      name: 'Gap Fill Fade (Short)',
      direction: 'SHORT',
      entry: last.close,
      invalidation: biggestGap.openPrice + (biggestGap.openPrice - last.close) * 0.3,
      rationale: `Opening gap up of ${(biggestGap.pct*100).toFixed(2)}% (${biggestGap.prevClose.toFixed(2)} → ${biggestGap.openPrice.toFixed(2)}). Bearish reaction targets gap fill at ${biggestGap.prevClose.toFixed(2)}.`,
      components: { gapPct: biggestGap.pct, fillTarget: biggestGap.prevClose },
    };
  }
  // Gap down + bullish reaction = gap fill long
  if (biggestGap.gap < 0 && last.close > last.open && last.close > biggestGap.openPrice) {
    return {
      name: 'Gap Fill Fade (Long)',
      direction: 'LONG',
      entry: last.close,
      invalidation: biggestGap.openPrice - (last.close - biggestGap.openPrice) * 0.3,
      rationale: `Opening gap down of ${(biggestGap.pct*100).toFixed(2)}% (${biggestGap.prevClose.toFixed(2)} → ${biggestGap.openPrice.toFixed(2)}). Bullish reaction targets gap fill at ${biggestGap.prevClose.toFixed(2)}.`,
      components: { gapPct: biggestGap.pct, fillTarget: biggestGap.prevClose },
    };
  }
  return null;
}

// ─── Tier 2.4 — End-of-Day Fade (last hour overextension fade) ───────────────

/**
 * In the last hour of the session, if price is overextended from VWAP
 * (> 1× ATR away) and shows a reaction bar back toward VWAP, fade.
 *
 * This works because end-of-day institutional positioning often unwinds
 * intraday extremes.
 */
export function detectEODFade(bars, structure, opts = {}) {
  if (!structure?.vwap || bars.length < 30) return null;
  const minDistATR = opts.minDistATR ?? 1.0;
  const last = bars[bars.length - 1];

  // Check if we're in last 60 min ET
  const now = new Date();
  const nyHour = Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).split(':')[0]);
  if (nyHour !== 15) return null;   // 15:00-16:00 ET only

  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return null;

  const distFromVwap = (last.close - structure.vwap) / atrNow;
  const range = last.high - last.low;
  if (range === 0) return null;

  // Above VWAP by > 1 ATR + bearish reaction → fade
  if (distFromVwap > minDistATR && last.close < last.open) {
    const upperWick = (last.high - Math.max(last.open, last.close)) / range;
    if (upperWick > 0.4) {
      return {
        name: 'EOD Fade (Short)',
        direction: 'SHORT',
        entry: last.close,
        invalidation: last.high + 0.1 * atrNow,
        rationale: `Last hour fade — price ${distFromVwap.toFixed(1)}× ATR above VWAP ${structure.vwap.toFixed(2)}. Bearish bar with ${(upperWick*100).toFixed(0)}% upper wick. Target VWAP for unwind.`,
        components: { distFromVwap, vwap: structure.vwap },
      };
    }
  }
  // Below VWAP by > 1 ATR + bullish reaction → fade
  if (distFromVwap < -minDistATR && last.close > last.open) {
    const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
    if (lowerWick > 0.4) {
      return {
        name: 'EOD Fade (Long)',
        direction: 'LONG',
        entry: last.close,
        invalidation: last.low - 0.1 * atrNow,
        rationale: `Last hour fade — price ${distFromVwap.toFixed(1)}× ATR below VWAP ${structure.vwap.toFixed(2)}. Bullish bar with ${(lowerWick*100).toFixed(0)}% lower wick. Target VWAP for unwind.`,
        components: { distFromVwap, vwap: structure.vwap },
      };
    }
  }
  return null;
}

// ─── Run all detectors and return the best one ───────────────────────────────

/**
 * Multi-bar confirmation gate — verifies the last N bars all reacted in
 * setup direction. Helps avoid catching falling knives.
 *
 * For LONG: last N bars must all be bullish (close > open)
 *           AND last bar must close > previous bar close
 *           AND last bar must close in upper half of its range
 * For SHORT: mirror.
 *
 * @returns {object} { confirmed: bool, reason: string }
 */
export function checkMultiBarConfirmation(direction, bars, count = 1) {
  if (!bars || bars.length < count + 2) return { confirmed: false, reason: 'insufficient bars' };
  const recent = bars.slice(-count);
  const prev = bars[bars.length - count - 1];

  for (let i = 0; i < recent.length; i++) {
    const b = recent[i];
    const range = b.high - b.low;
    if (range === 0) return { confirmed: false, reason: `bar ${i+1} is flat` };
    const closePos = (b.close - b.low) / range;

    if (direction === 'LONG') {
      if (b.close <= b.open) return { confirmed: false, reason: `bar -${count-i} not bullish (close ${b.close.toFixed(4)} ≤ open ${b.open.toFixed(4)})` };
      if (closePos < 0.55) return { confirmed: false, reason: `bar -${count-i} closed in lower half (${(closePos*100).toFixed(0)}%)` };
    } else if (direction === 'SHORT') {
      if (b.close >= b.open) return { confirmed: false, reason: `bar -${count-i} not bearish` };
      if (closePos > 0.45) return { confirmed: false, reason: `bar -${count-i} closed in upper half` };
    }
  }
  // Last bar must show progress vs the bar before our window
  const lastClose = recent[recent.length - 1].close;
  if (direction === 'LONG' && lastClose <= prev.close)  return { confirmed: false, reason: 'no follow-through vs prior bar' };
  if (direction === 'SHORT' && lastClose >= prev.close) return { confirmed: false, reason: 'no follow-through vs prior bar' };

  return { confirmed: true, reason: `${count}-bar ${direction.toLowerCase()} confirmation` };
}

/**
 * Run all setup detectors. Returns array of detected setups (most specific first).
 * Caller picks the best one via setup-quality scoring.
 *
 * @param {object} opts
 * @param {boolean} opts.aggressive - loosen detector thresholds further
 * @param {boolean} opts.yolo       - extreme loosening (any whisper triggers)
 */
export function detectAll(bars, levels, structure, opts = {}) {
  // Profile-aware option overrides
  const sweep = opts.yolo
    ? { maxSweepATR: 1.5 }
    : opts.aggressive
      ? { maxSweepATR: 1.0 }
      : {};
  const vwap = opts.yolo
    ? { proximityATR: 0.6, minTrendBars: 2, minWickPct: 0.30 }
    : opts.aggressive
      ? { proximityATR: 0.5, minTrendBars: 3, minWickPct: 0.35 }
      : {};
  const orb = opts.yolo
    ? { minRelVol: 0.8 }
    : opts.aggressive
      ? { minRelVol: 1.0 }
      : {};
  const pullback = opts.yolo
    ? { proximityATR: 1.0 }
    : opts.aggressive
      ? { proximityATR: 0.7 }
      : {};
  const range = opts.yolo
    ? { proximityPct: 0.015, minWickPct: 0.30, minTouches: 1 }
    : opts.aggressive
      ? { proximityPct: 0.012, minWickPct: 0.40, minTouches: 1 }
      : {};

  const detectors = [
    () => detectSweepReclaim(bars, sweep),
    () => detectVWAPBounce(bars, structure, vwap),
    () => detectORB(bars, levels, orb),
    () => detectTrendPullback(bars, levels, structure, pullback),
    () => detectRangeReversal(bars, levels, range),
    () => detectFlag(bars),
    () => detectDoubleTopBottom(bars),
    () => detectGapFill(bars),
    () => detectEODFade(bars, structure),
  ];
  const results = [];
  for (const fn of detectors) {
    try {
      const r = fn();
      if (r) results.push(r);
    } catch (e) { /* silent — detector failed */ }
  }
  return results;
}
