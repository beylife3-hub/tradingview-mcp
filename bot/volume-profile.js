/**
 * Volume Profile — Point of Control + Value Area
 *
 * Buckets traded volume by price level over a window of bars. The price level
 * with the highest cumulative volume = Point of Control (POC).
 *
 * Value Area = the price range containing 70% of total volume around POC.
 *   - Value Area High (VAH) = upper edge
 *   - Value Area Low (VAL)  = lower edge
 *
 * Day-trading uses:
 *   - POC acts as a magnet — price tends to revisit
 *   - VAH/VAL act as support/resistance for breakouts
 *   - Trading within ±0.1% of POC is the chop zone — avoid
 */

import { computeVWAP } from './engine.js';

/**
 * Compute volume profile from a series of bars.
 *
 * @param {Array} bars - OHLCV bars
 * @param {object} opts - { bins: number of price buckets (default 50) }
 * @returns { poc, vah, val, totalVolume, bins: [{ price, volume, pct }] }
 */
export function computeVolumeProfile(bars, opts = {}) {
  if (!bars?.length) return null;
  const nBins = opts.bins ?? 50;
  const valueAreaPct = opts.valueAreaPct ?? 0.70;

  // Determine price range
  let high = -Infinity, low = Infinity;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low  < low)  low  = b.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;

  const binWidth = (high - low) / nBins;
  const bins = new Array(nBins).fill(0).map((_, i) => ({
    idx: i,
    priceLow:  low + i * binWidth,
    priceHigh: low + (i + 1) * binWidth,
    price:     low + (i + 0.5) * binWidth,
    volume:    0,
  }));

  // Distribute each bar's volume across the bins it spans
  for (const bar of bars) {
    const v = bar.volume || 0;
    if (v === 0) continue;
    const barRange = bar.high - bar.low;
    if (barRange === 0) {
      // All volume at one price
      const binIdx = Math.min(nBins - 1, Math.max(0, Math.floor((bar.close - low) / binWidth)));
      bins[binIdx].volume += v;
      continue;
    }
    // Distribute proportionally across the bins this bar covers
    const startBin = Math.max(0, Math.floor((bar.low  - low) / binWidth));
    const endBin   = Math.min(nBins - 1, Math.floor((bar.high - low) / binWidth));
    const binsCovered = endBin - startBin + 1;
    const volPerBin = v / binsCovered;
    for (let i = startBin; i <= endBin; i++) bins[i].volume += volPerBin;
  }

  // POC = bin with max volume
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
  }
  const poc = bins[pocIdx].price;
  const totalVolume = bins.reduce((s, b) => s + b.volume, 0);

  // Value Area = expand from POC until 70% of volume is included
  let vaVolume = bins[pocIdx].volume;
  let vahIdx = pocIdx, valIdx = pocIdx;
  const targetVA = totalVolume * valueAreaPct;
  while (vaVolume < targetVA && (vahIdx < nBins - 1 || valIdx > 0)) {
    const upVol = vahIdx < nBins - 1 ? bins[vahIdx + 1].volume : 0;
    const dnVol = valIdx > 0          ? bins[valIdx - 1].volume : 0;
    if (upVol >= dnVol && vahIdx < nBins - 1) {
      vahIdx++; vaVolume += upVol;
    } else if (valIdx > 0) {
      valIdx--; vaVolume += dnVol;
    } else break;
  }
  const vah = bins[vahIdx].priceHigh;
  const val = bins[valIdx].priceLow;

  // Add pct to each bin
  for (const b of bins) b.pct = totalVolume > 0 ? b.volume / totalVolume : 0;

  return { poc, vah, val, totalVolume, bins, pocBin: pocIdx };
}

/**
 * Is price currently in the chop zone (within ±0.1% of POC)?
 * Returns true if so — caller may reject trade.
 */
export function isInChopZone(currentPrice, poc, tolerance = 0.001) {
  if (!Number.isFinite(poc)) return false;
  return Math.abs(currentPrice - poc) / poc < tolerance;
}

/**
 * Are we above VAH or below VAL? Useful for breakout setups.
 * Returns 'above-vah' | 'below-val' | 'inside' | null
 */
export function priceVsValueArea(currentPrice, vah, val) {
  if (!Number.isFinite(vah) || !Number.isFinite(val)) return null;
  if (currentPrice > vah) return 'above-vah';
  if (currentPrice < val) return 'below-val';
  return 'inside';
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const data = await import('../src/core/data.js');
    const { disconnect } = await import('../src/connection.js');
    try {
      const ohlcv = await data.getOhlcv({ count: 200, summary: false });
      const bars = ohlcv.bars;
      const vp = computeVolumeProfile(bars);
      const lastPrice = bars[bars.length - 1].close;
      console.log(`Volume Profile (${bars.length} bars):`);
      console.log(`  POC:   ${vp.poc.toFixed(4)}`);
      console.log(`  VAH:   ${vp.vah.toFixed(4)}`);
      console.log(`  VAL:   ${vp.val.toFixed(4)}`);
      console.log(`  Now:   ${lastPrice.toFixed(4)}`);
      console.log(`  vs VA: ${priceVsValueArea(lastPrice, vp.vah, vp.val)}`);
      console.log(`  Chop:  ${isInChopZone(lastPrice, vp.poc) ? 'YES — within 0.1% of POC' : 'no'}`);
    } finally { await disconnect().catch(() => {}); }
  })();
}
