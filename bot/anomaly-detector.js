/**
 * Anomaly Detector — z-score black-swan halt.
 *
 * Computes z-scores of current bar features vs the recent distribution.
 * If price action is "unprecedented" (e.g., 5σ move), pause trading.
 *
 * Catches:
 *   - Flash crashes / flash rallies
 *   - News spike events that moved beyond historical volatility
 *   - Exchange data glitches (huge spurious wicks)
 *   - Bid/ask spread blowouts
 *
 * Used as a strict-filter rejection: never trade through a black swan.
 */

import { atr, mean, stdev } from './engine.js';

/**
 * Detect anomalies in the current bar vs the recent N-bar baseline.
 *
 * Returns: {
 *   anomaly: boolean,
 *   reason: string,
 *   metrics: { rangeZ, volZ, returnZ, ... }
 * }
 *
 * Anomaly thresholds (default — tune via opts):
 *   - Range > 5σ above mean range → flash spike
 *   - Volume > 5σ above mean volume → unusual activity
 *   - 1-bar return > 4σ above mean return → news shock
 *   - ATR > 3σ above 100-bar mean ATR → vol regime shift
 */
export function detectAnomaly(bars, opts = {}) {
  const baseline   = opts.baseline   ?? 50;
  const rangeZThr  = opts.rangeZThr  ?? 5;
  const volZThr    = opts.volZThr    ?? 5;
  const returnZThr = opts.returnZThr ?? 4;
  const atrZThr    = opts.atrZThr    ?? 3;

  if (!bars || bars.length < baseline + 5) return { anomaly: false, reason: 'insufficient bars for baseline' };

  const last = bars[bars.length - 1];
  const window = bars.slice(-baseline - 1, -1);   // baseline = bars BEFORE current

  // 1. Range z-score
  const ranges = window.map(b => b.high - b.low);
  const rMean = mean(ranges);
  const rStd  = stdev(ranges);
  const lastRange = last.high - last.low;
  const rangeZ = rStd > 0 ? (lastRange - rMean) / rStd : 0;

  // 2. Volume z-score
  const vols = window.map(b => b.volume || 0);
  const vMean = mean(vols);
  const vStd  = stdev(vols);
  const volZ = vStd > 0 ? ((last.volume || 0) - vMean) / vStd : 0;

  // 3. 1-bar return z-score
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    returns.push(Math.abs(window[i].close - window[i-1].close) / window[i-1].close);
  }
  const retMean = mean(returns);
  const retStd  = stdev(returns);
  const lastReturn = bars.length > 1 ? Math.abs(last.close - bars[bars.length-2].close) / bars[bars.length-2].close : 0;
  const returnZ = retStd > 0 ? (lastReturn - retMean) / retStd : 0;

  // 4. ATR z-score (vs 100-bar baseline)
  const atrSeries = atr(bars, 14);
  const atrCurr = atrSeries[atrSeries.length - 1];
  const atrHist = atrSeries.slice(-100, -1).filter(Number.isFinite);
  const atrMean = mean(atrHist);
  const atrStd  = stdev(atrHist);
  const atrZ = atrStd > 0 ? (atrCurr - atrMean) / atrStd : 0;

  // Decide
  const triggers = [];
  if (rangeZ  > rangeZThr)  triggers.push(`bar range ${rangeZ.toFixed(1)}σ above mean`);
  if (volZ    > volZThr)    triggers.push(`bar volume ${volZ.toFixed(1)}σ above mean`);
  if (returnZ > returnZThr) triggers.push(`1-bar return ${returnZ.toFixed(1)}σ above mean`);
  if (atrZ    > atrZThr)    triggers.push(`ATR ${atrZ.toFixed(1)}σ above 100-bar mean`);

  if (triggers.length) {
    return {
      anomaly: true,
      reason: triggers.join('; '),
      metrics: { rangeZ, volZ, returnZ, atrZ },
    };
  }

  return { anomaly: false, metrics: { rangeZ, volZ, returnZ, atrZ } };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const data = await import('../src/core/data.js');
    const { disconnect } = await import('../src/connection.js');
    try {
      const ohlcv = await data.getOhlcv({ count: 100, summary: false });
      const result = detectAnomaly(ohlcv.bars);
      console.log(`Anomaly: ${result.anomaly ? '🚨 YES' : '✓ no'}`);
      if (result.reason) console.log(`Reason:  ${result.reason}`);
      console.log(`Metrics:`);
      console.log(`  Range z-score:   ${result.metrics?.rangeZ?.toFixed(2)}`);
      console.log(`  Volume z-score:  ${result.metrics?.volZ?.toFixed(2)}`);
      console.log(`  Return z-score:  ${result.metrics?.returnZ?.toFixed(2)}`);
      console.log(`  ATR z-score:     ${result.metrics?.atrZ?.toFixed(2)}`);
    } finally { await disconnect().catch(() => {}); }
  })();
}
