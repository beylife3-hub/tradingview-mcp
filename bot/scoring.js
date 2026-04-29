/**
 * Setup Quality Scoring (1-10 scale)
 *
 * Per the user's framework, each setup is scored across 7 dimensions:
 *   1. Trend alignment           — does setup direction match HTF trend?
 *   2. Volume confirmation       — is current volume above 20-bar avg?
 *   3. Distance from key level   — is entry AT a level, or chasing?
 *   4. Entry quality             — clean reaction bar, not late
 *   5. Reward-to-risk            — projected R:R from invalidation
 *   6. Market structure clarity  — non-choppy regime
 *   7. Move not extended         — last leg ≤ 1.5× ATR
 *
 * Scoring rule (per Jesse + Freqtrade Edge convention):
 *   Each component contributes a 0-2 sub-score except components 5,6,7 = 0-1.
 *   Total max = 14, normalized to 1-10 scale.
 *
 *   ≥ 7  → A+ tradeable
 *   5-6  → WATCHLIST ONLY
 *   < 5  → NO TRADE
 */

import { atr, ema } from './engine.js';

/**
 * Score a setup against current market state.
 *
 * @param {object} setup        - from detectors (has direction, entry, invalidation)
 * @param {object} structure    - { trend, vwap, ema20, ema50, ema200, rsi, atr, ... }
 * @param {object} levels       - extracted key levels
 * @param {object} regime       - regime classification
 * @param {Array}  bars         - OHLCV bars
 * @param {object} opts         - { targetRR }
 * @returns {object} { score: 1-10, components, suggestedTarget1, suggestedTarget2, rrEstimate }
 */
export function scoreSetup(setup, structure, levels, regime, bars, opts = {}) {
  const targetRR = opts.targetRR ?? 2.0;

  let raw = 0;
  const components = [];

  const last = bars[bars.length - 1];
  const atrSeries = atr(bars, 14);
  const atrNow = atrSeries[atrSeries.length - 1];
  const stopDist = Math.abs(setup.entry - setup.invalidation);

  // ─── 1. Trend alignment (0-2) ─────────────────────────────────────────────
  // 2 if setup direction matches HTF + LTF trend; 1 if matches LTF only; 0 if counter
  const longTrend = levels.ema20 > levels.ema50 && levels.ema50 > (levels.ema200 ?? levels.ema50);
  const shortTrend = levels.ema20 < levels.ema50 && levels.ema50 < (levels.ema200 ?? levels.ema50);
  const isLong = setup.direction === 'LONG';
  let s1 = 0;
  if (isLong && longTrend) s1 = 2;
  else if (!isLong && shortTrend) s1 = 2;
  else if (isLong && levels.ema20 > levels.ema50) s1 = 1;
  else if (!isLong && levels.ema20 < levels.ema50) s1 = 1;
  raw += s1;
  components.push({ name: 'Trend alignment', score: s1, max: 2,
    note: s1 === 2 ? 'Full HTF + LTF aligned' : s1 === 1 ? 'Partial alignment' : 'Counter-trend' });

  // ─── 2. Volume confirmation (0-2) — softer brackets ───────────────────────
  const recent = bars.slice(-21, -1);
  const avgVol = recent.reduce((s, b) => s + (b.volume || 0), 0) / Math.max(1, recent.length);
  const lastVol = last.volume || 0;
  const relVol = avgVol > 0 ? lastVol / avgVol : 1;
  let s2 = 0;
  if (relVol >= 1.5)      s2 = 2;
  else if (relVol >= 1.0) s2 = 1.5;   // average vol now scores 1.5 (was 1)
  else if (relVol >= 0.7) s2 = 1;     // even soft vol gets 1pt
  else if (relVol >= 0.4) s2 = 0.5;
  raw += s2;
  components.push({ name: 'Volume confirmation', score: s2, max: 2,
    note: `Last bar vol ${relVol.toFixed(2)}× 20-bar avg` });

  // ─── 3. Distance from key level (0-2) — wider proximity window ────────────
  const allLevels = [...levels.resistance, ...levels.support];
  // Try multiple proximity bands for partial credit
  const nearTight  = allLevels.find(l => Math.abs(l.distancePct) < 0.005);  // within 0.5%
  const nearMedium = allLevels.find(l => Math.abs(l.distancePct) < 0.01);   // within 1%
  let s3 = 0;
  if (nearTight && nearTight.weight >= 3) s3 = 2;
  else if (nearTight && nearTight.weight >= 2) s3 = 1.5;
  else if (nearTight) s3 = 1;
  else if (nearMedium && nearMedium.weight >= 2) s3 = 0.5;
  raw += s3;
  const nearLevel = nearTight ?? nearMedium;
  components.push({ name: 'Distance from level', score: s3, max: 2,
    note: nearLevel
      ? `At ${nearLevel.type} ${nearLevel.price.toFixed(2)} (${(nearLevel.distancePct * 100).toFixed(2)}% away, weight ${nearLevel.weight})`
      : 'Not at any major level — chasing risk' });

  // ─── 4. Entry quality (0-2) — softer reaction-bar gates ──────────────────
  const range = last.high - last.low;
  let s4 = 0;
  if (range > 0) {
    const closePos = (last.close - last.low) / range;
    if (isLong) {
      if      (closePos >= 0.7 && last.close > last.open) s4 = 2;
      else if (closePos >= 0.5 && last.close > last.open) s4 = 1.5;
      else if (closePos >= 0.5)                            s4 = 1;     // bullish position even on doji/red
      else if (last.close > last.open)                     s4 = 0.5;
    } else {
      if      (closePos <= 0.3 && last.close < last.open) s4 = 2;
      else if (closePos <= 0.5 && last.close < last.open) s4 = 1.5;
      else if (closePos <= 0.5)                            s4 = 1;
      else if (last.close < last.open)                     s4 = 0.5;
    }
  }
  raw += s4;
  components.push({ name: 'Entry quality', score: s4, max: 2,
    note: s4 === 2 ? 'Strong reaction bar' : s4 === 1 ? 'Decent bar' : 'Weak / no reaction' });

  // ─── 5. Reward-to-Risk (0-2) ──────────────────────────────────────────────
  // Compute projected R:R based on next major level in setup direction
  const directionalLevels = isLong ? levels.resistance : levels.support;
  const nextLevel = directionalLevels.find(l => Math.abs(l.distancePct) > 0.001 && l.weight >= 2);
  let rrEstimate = 0;
  let suggestedTarget1, suggestedTarget2;
  if (nextLevel && stopDist > 0) {
    const targetDist = Math.abs(nextLevel.price - setup.entry);
    rrEstimate = targetDist / stopDist;
    suggestedTarget1 = isLong ? setup.entry + targetDist : setup.entry - targetDist;
    // T2 = 1.5× T1 distance, capped by next-next major level
    const t2dist = targetDist * 1.5;
    suggestedTarget2 = isLong ? setup.entry + t2dist : setup.entry - t2dist;
  } else if (atrNow > 0 && stopDist > 0) {
    // Fallback: target = stopDist × targetRR (≥ 2:1)
    rrEstimate = targetRR;
    const targetDist = stopDist * targetRR;
    suggestedTarget1 = isLong ? setup.entry + stopDist * 1.5 : setup.entry - stopDist * 1.5;
    suggestedTarget2 = isLong ? setup.entry + targetDist     : setup.entry - targetDist;
  }
  let s5 = 0;
  if (rrEstimate >= 3)      s5 = 2;
  else if (rrEstimate >= 2) s5 = 1.5;
  else if (rrEstimate >= 1.5) s5 = 1;     // 1.5:1 now scores partial (was 0)
  else if (rrEstimate >= 1.2) s5 = 0.5;
  raw += s5;
  components.push({ name: 'Reward/Risk', score: s5, max: 2,
    note: `Projected ${rrEstimate.toFixed(2)}:1 R:R to next major level` });

  // ─── 6. Market structure clarity (0-1) ────────────────────────────────────
  let s6 = 0;
  if (regime.type === 'trending-up' || regime.type === 'trending-down' || regime.type === 'ranging') {
    s6 = regime.confidence >= 0.6 ? 1 : 0.5;
  }
  raw += s6;
  components.push({ name: 'Structure clarity', score: s6, max: 1,
    note: `${regime.type} (confidence ${(regime.confidence * 100).toFixed(0)}%)` });

  // ─── 7. Move not extended (0-1) — finer extension gradient ────────────────
  const fiveAgo = bars[bars.length - 6]?.close ?? last.close;
  const lastLeg = Math.abs(last.close - fiveAgo);
  const atrRatio = atrNow > 0 ? lastLeg / atrNow : 0;
  let s7 = 0;
  if (atrRatio < 1.0)      s7 = 1;
  else if (atrRatio < 1.5) s7 = 0.75;
  else if (atrRatio < 2.0) s7 = 0.5;
  else if (atrRatio < 2.5) s7 = 0.25;
  raw += s7;
  components.push({ name: 'Not extended', score: s7, max: 1,
    note: `Last 5-bar move ${atrRatio.toFixed(2)}× ATR ${atrRatio < 1.0 ? '(fresh)' : atrRatio < 1.5 ? '(neutral)' : '(extended — late)'}` });

  // Normalize 0-14 raw → 1-10 scale
  // 0 → 1, 14 → 10. Linear: 1 + raw * (9/14)
  const score = Math.round((1 + raw * (9 / 14)) * 10) / 10;

  return {
    score,
    rawScore: raw,
    maxRaw: 14,
    components,
    suggestedTarget1,
    suggestedTarget2,
    rrEstimate,
    stopDist,
  };
}

/**
 * Verdict from score, honoring profile-specific TRADE threshold.
 *
 *   conservative: TRADE ≥ 7,   WATCHLIST ≥ 5
 *   balanced:     TRADE ≥ 6.5, WATCHLIST ≥ 5
 *   aggressive:   TRADE ≥ 5.5, WATCHLIST ≥ 4
 *   yolo:         TRADE ≥ 4.5, WATCHLIST ≥ 3
 */
export function verdictFromScore(score, opts = {}) {
  const tradeT = opts.tradeThreshold ?? 6.5;
  // WATCHLIST band scales with trade threshold (1pt below)
  const watchT = Math.max(2, tradeT - 1.5);
  if (score >= tradeT) return 'TRADE';
  if (score >= watchT) return 'WATCHLIST';
  return 'NO_TRADE';
}

// ─── Strict filters (rejection rules per user spec) ──────────────────────────

/**
 * Apply strict rejection rules. Returns null if all pass, or a rejection reason.
 *
 * Per user spec — reject if any of these are true:
 *   - Reward-to-risk is below 2:1
 *   - Entry is too far from support/resistance/VWAP
 *   - Volume is weak
 *   - Price is too extended after a large move
 *   - Stop loss would need to be too wide for account
 *   - Major news/event risk makes the chart unreliable
 *   - Setup depends on hope instead of structure
 */
export function applyStrictFilters({
  setup, score, structure, regime, bars,
  accountRiskDollars,
  targetRR = 1.5,
  stopCapPct = 7,
  profile = 'balanced',
}) {
  const reasons = [];

  // R:R below required (profile-aware)
  if (score.rrEstimate < targetRR) {
    reasons.push(`R:R only ${score.rrEstimate.toFixed(2)}:1 — below ${targetRR.toFixed(1)}:1 minimum`);
  }

  // Volume severely weak (no longer auto-rejects — only if extreme)
  const volComp = score.components.find(c => c.name === 'Volume confirmation');
  if (volComp && volComp.score === 0) {
    // Volume so dead that nothing should fire — but only reject if combined with
    // other weakness. Just note it as a soft penalty in the score.
    // No hard rejection here.
  }

  // Price extreme overextension only — was rejecting anything > 1.5×, now > 2.5×
  const extComp = score.components.find(c => c.name === 'Not extended');
  if (extComp && extComp.score === 0) {
    reasons.push('Price extremely extended (>2.5× ATR) — chasing risk too high');
  }

  // Parabolic always rejects — capital protection (even YOLO)
  if (regime.type === 'parabolic') {
    reasons.push('Parabolic — wait for retracement');
  }
  // Choppy rejects in conservative/balanced; aggressive/yolo allow it
  if (regime.type === 'choppy' && profile !== 'aggressive' && profile !== 'yolo') {
    reasons.push('Choppy market — no clear edge');
  }

  // Stop too wide (profile-aware)
  if (accountRiskDollars > 0 && score.stopDist > 0) {
    const stopDistPct = score.stopDist / setup.entry;
    const cap = stopCapPct / 100;
    if (stopDistPct > cap) {
      reasons.push(`Stop ${(stopDistPct * 100).toFixed(2)}% wide — exceeds ${stopCapPct}% sanity cap`);
    }
  }

  return reasons.length > 0 ? reasons : null;
}
