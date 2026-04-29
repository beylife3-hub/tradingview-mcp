/**
 * Key level detection for day trading.
 *
 * Day-trading edges live at specific price reference points:
 *   - Previous Day High / Low / Close (PDH, PDL, PDC)
 *   - Premarket High / Low (PMH, PML)  [equities only]
 *   - Opening Range High / Low (ORH, ORL) — first 5/15/30 min
 *   - Session VWAP and bands
 *   - Swing pivots clustered into multi-touch zones
 *   - Key moving averages (EMA20, EMA50, EMA200)
 *
 * The "best level" right now is computed by proximity-weighted importance.
 */

import { ema } from './engine.js';

// ─── Swing pivots (rolling lookback) ──────────────────────────────────────────

export function findSwingHighs(bars, lookback = 5) {
  const out = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const h = bars[i].high;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= h) { isPivot = false; break; }
    }
    if (isPivot) out.push({ idx: i, time: bars[i].time, price: h });
  }
  return out;
}

export function findSwingLows(bars, lookback = 5) {
  const out = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const l = bars[i].low;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].low <= l) { isPivot = false; break; }
    }
    if (isPivot) out.push({ idx: i, time: bars[i].time, price: l });
  }
  return out;
}

// ─── Cluster nearby pivots into multi-touch zones ─────────────────────────────

/**
 * Group pivots within `tolerance` (as % of price) into zones with `touches` count.
 * Zones with ≥ 2 touches are "key levels"; single touches are minor.
 */
export function clusterLevels(pivots, tolerance = 0.003) {
  if (!pivots.length) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(p.price - last.avg) / last.avg < tolerance) {
      last.prices.push(p.price);
      last.touches++;
      last.avg = last.prices.reduce((s, x) => s + x, 0) / last.prices.length;
      last.lastIdx = Math.max(last.lastIdx, p.idx);
    } else {
      groups.push({
        prices: [p.price],
        avg: p.price,
        touches: 1,
        firstIdx: p.idx,
        lastIdx: p.idx,
      });
    }
  }
  return groups
    .map(g => ({ price: g.avg, touches: g.touches, lastIdx: g.lastIdx }))
    .sort((a, b) => b.touches - a.touches);
}

// ─── Previous day H/L/C ───────────────────────────────────────────────────────

/**
 * Given intraday bars (e.g. 1m or 5m), find the previous trading day's
 * high, low, and close. Uses the bar's `time` field (unix seconds).
 *
 * Falls back to "last 24h ago" if calendar segmentation isn't possible.
 */
export function previousDayLevels(bars) {
  if (!bars.length) return null;
  const lastTs = bars[bars.length - 1].time * 1000;
  const today = new Date(lastTs);
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime() / 1000;

  // Walk backwards collecting bars from the previous calendar day
  const prev = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].time >= todayTs) continue;
    // Stop when we cross into 2 days ago
    const dayDelta = (todayTs - bars[i].time) / 86400;
    if (dayDelta > 1.5) break;
    prev.push(bars[i]);
  }
  if (!prev.length) return null;

  const high = Math.max(...prev.map(b => b.high));
  const low  = Math.min(...prev.map(b => b.low));
  const close = prev[0].close; // bars are reverse-sorted; index 0 = most recent of prev day
  return { high, low, close, barCount: prev.length };
}

// ─── Premarket H/L (US equities: 04:00–09:30 ET) ──────────────────────────────

/**
 * Detect bars timestamped during the most recent premarket session.
 * Returns null if not applicable (e.g., crypto 24/7).
 */
export function premarketLevels(bars, tzOffsetHours = -4 /* ET in DST */) {
  if (!bars.length) return null;
  const last = new Date(bars[bars.length - 1].time * 1000);
  // Most-recent calendar day's premarket = 04:00–09:30 ET
  const sessionDate = new Date(last);
  sessionDate.setHours(0, 0, 0, 0);
  // Convert local 04:00 ET to unix seconds — assume bar times are UTC seconds
  const startUtc = sessionDate.getTime() / 1000 - tzOffsetHours * 3600 + 4 * 3600;
  const endUtc   = startUtc + 5.5 * 3600; // 09:30 ET

  const pm = bars.filter(b => b.time >= startUtc && b.time <= endUtc);
  if (pm.length < 3) return null;

  return {
    high: Math.max(...pm.map(b => b.high)),
    low:  Math.min(...pm.map(b => b.low)),
    barCount: pm.length,
  };
}

// ─── Opening Range (first N minutes of US equity session) ─────────────────────

/**
 * Compute Opening Range based on the FIRST N MINUTES after the most recent
 * 09:30 ET open. Default N = 5. Per Zarattini/Aggarwal 2023, 5-min OR has
 * the strongest documented edge.
 */
export function openingRange(bars, minutes = 5, tzOffsetHours = -4) {
  if (!bars.length) return null;
  const last = new Date(bars[bars.length - 1].time * 1000);
  const sessionDate = new Date(last);
  sessionDate.setHours(0, 0, 0, 0);
  const openUtc = sessionDate.getTime() / 1000 - tzOffsetHours * 3600 + 9.5 * 3600;
  const closeUtc = openUtc + minutes * 60;

  const orBars = bars.filter(b => b.time >= openUtc && b.time < closeUtc);
  if (orBars.length === 0) return null;

  const high = Math.max(...orBars.map(b => b.high));
  const low  = Math.min(...orBars.map(b => b.low));
  // Volume avg over OR vs prior 20-bar avg (relative volume confirmation)
  const orVol = orBars.reduce((s, b) => s + (b.volume || 0), 0) / orBars.length;
  const priorBars = bars.slice(-50, bars.indexOf(orBars[0]));
  const priorVol = priorBars.length
    ? priorBars.reduce((s, b) => s + (b.volume || 0), 0) / priorBars.length
    : orVol;
  const relVolume = priorVol > 0 ? orVol / priorVol : 1;

  return { high, low, barCount: orBars.length, relVolume };
}

// ─── Comprehensive level extraction ───────────────────────────────────────────

/**
 * Extract all key day-trading levels relative to current price.
 * Returns an object with sorted arrays of resistance (above) and support (below).
 *
 * Each level: { price, type, touches, distancePct, weight }
 *   type ∈ 'pivot' | 'pdh' | 'pdl' | 'pdc' | 'pmh' | 'pml' | 'orh' | 'orl' | 'ema20' | 'ema50' | 'ema200' | 'vwap'
 *   weight: heuristic importance (3=major, 2=medium, 1=minor)
 */
export function extractKeyLevels(bars, structure = {}) {
  const last = bars[bars.length - 1];
  const price = last.close;
  const closes = bars.map(b => b.close);

  const all = [];

  // Pivot clusters
  const swingHighs = findSwingHighs(bars, 5);
  const swingLows  = findSwingLows(bars, 5);
  const tol = 0.003; // 0.3% clustering tolerance
  for (const c of clusterLevels(swingHighs, tol)) {
    all.push({ price: c.price, type: 'pivot-high', touches: c.touches, weight: c.touches >= 3 ? 3 : c.touches >= 2 ? 2 : 1 });
  }
  for (const c of clusterLevels(swingLows, tol)) {
    all.push({ price: c.price, type: 'pivot-low', touches: c.touches, weight: c.touches >= 3 ? 3 : c.touches >= 2 ? 2 : 1 });
  }

  // PDH/PDL/PDC
  const pd = previousDayLevels(bars);
  if (pd) {
    all.push({ price: pd.high,  type: 'pdh', touches: 1, weight: 3 });
    all.push({ price: pd.low,   type: 'pdl', touches: 1, weight: 3 });
    all.push({ price: pd.close, type: 'pdc', touches: 1, weight: 2 });
  }

  // Premarket
  const pm = premarketLevels(bars);
  if (pm) {
    all.push({ price: pm.high, type: 'pmh', touches: 1, weight: 3 });
    all.push({ price: pm.low,  type: 'pml', touches: 1, weight: 3 });
  }

  // Opening Range
  const or = openingRange(bars, 5);
  if (or) {
    all.push({ price: or.high, type: 'orh', touches: 1, weight: 3 });
    all.push({ price: or.low,  type: 'orl', touches: 1, weight: 3 });
  }

  // Moving averages
  const e20  = ema(closes, 20);
  const e50  = ema(closes, 50);
  const e200 = ema(closes, 200);
  const e20Last  = e20[e20.length - 1];
  const e50Last  = e50[e50.length - 1];
  const e200Last = e200[e200.length - 1];
  if (Number.isFinite(e20Last))  all.push({ price: e20Last,  type: 'ema20',  touches: 1, weight: 2 });
  if (Number.isFinite(e50Last))  all.push({ price: e50Last,  type: 'ema50',  touches: 1, weight: 2 });
  if (Number.isFinite(e200Last)) all.push({ price: e200Last, type: 'ema200', touches: 1, weight: 3 });

  // VWAP
  if (structure.vwap && Number.isFinite(structure.vwap)) {
    all.push({ price: structure.vwap, type: 'vwap', touches: 1, weight: 3 });
  }

  // Annotate distance
  for (const lvl of all) {
    lvl.distancePct = (lvl.price - price) / price;
  }

  const resistance = all.filter(l => l.price > price).sort((a, b) => a.distancePct - b.distancePct);
  const support    = all.filter(l => l.price < price).sort((a, b) => b.distancePct - a.distancePct);

  return {
    resistance: resistance.slice(0, 8),
    support:    support.slice(0, 8),
    pdh: pd?.high, pdl: pd?.low, pdc: pd?.close,
    pmh: pm?.high, pml: pm?.low,
    orh: or?.high, orl: or?.low, orRelVolume: or?.relVolume,
    ema20: e20Last, ema50: e50Last, ema200: e200Last,
  };
}

// ─── "Best level" — what matters most right now ──────────────────────────────

/**
 * Pick the single most important level driving the current price action.
 * Logic: closest weighted-by-importance level within 0.5 ATR of price.
 */
export function pickBestLevel(levels, price, atr) {
  const all = [...levels.resistance, ...levels.support];
  if (!all.length) return null;
  const proximityATR = atr > 0 ? atr / price : 0.002;
  // Score: weight × (1 / (1 + distance/atr))
  const scored = all.map(l => {
    const distAtr = Math.abs(l.distancePct) / proximityATR;
    return { ...l, score: l.weight / (1 + distAtr) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

// Pretty label for a level type
export const LEVEL_LABELS = {
  'pivot-high': 'Pivot resistance',
  'pivot-low':  'Pivot support',
  'pdh': 'Previous Day High',
  'pdl': 'Previous Day Low',
  'pdc': 'Previous Day Close',
  'pmh': 'Premarket High',
  'pml': 'Premarket Low',
  'orh': 'Opening Range High',
  'orl': 'Opening Range Low',
  'ema20':  'EMA20',
  'ema50':  'EMA50',
  'ema200': 'EMA200',
  'vwap':   'VWAP',
};
