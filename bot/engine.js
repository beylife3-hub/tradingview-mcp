/**
 * Core indicator engine — pure stateless functions over OHLCV bar arrays.
 *
 * Bar shape (TradingView OHLCV): { time, open, high, low, close, volume }
 * All functions return arrays aligned 1:1 with the input bars (NaN for warmup).
 */

// ─── Moving averages ──────────────────────────────────────────────────────────

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ─── RSI (Wilder smoothing) ───────────────────────────────────────────────────

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ─── MACD ──────────────────────────────────────────────────────────────────────

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const line = closes.map((_, i) => fastE[i] - slowE[i]);
  const signalLine = ema(line.filter(v => !Number.isNaN(v)), signal);
  // Pad signalLine back to original length
  const offset = line.findIndex(v => !Number.isNaN(v));
  const fullSignal = new Array(closes.length).fill(NaN);
  for (let i = 0; i < signalLine.length; i++) {
    fullSignal[offset + i] = signalLine[i];
  }
  const hist = line.map((v, i) => v - fullSignal[i]);
  return { line, signal: fullSignal, hist };
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

export function bollinger(closes, period = 20, stdDevs = 2) {
  const ma = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - ma[i];
      sumSq += diff * diff;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = ma[i] + stdDevs * sd;
    lower[i] = ma[i] - stdDevs * sd;
  }
  return { ma, upper, lower };
}

// ─── ATR (True Range, Wilder smoothing) ───────────────────────────────────────

export function trueRange(bars) {
  const out = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { out[i] = b.high - b.low; continue; }
    const prevClose = bars[i - 1].close;
    out[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  }
  return out;
}

export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(NaN);
  if (tr.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ─── VWAP (session anchored, with 1σ/2σ bands) ────────────────────────────────

/**
 * Session VWAP — volume-weighted average price.
 * Anchored to the start of the most recent session/window.
 * Returns: { vwap, upper1, lower1, upper2, lower2, std, barCount }
 */
export function computeVWAP(bars, lookback = null) {
  if (!bars?.length) return null;
  const window = lookback ? bars.slice(-lookback) : bars;
  if (!window.length) return null;
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  for (const b of window) {
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 1;
    cumPV  += tp * v;
    cumV   += v;
    cumPV2 += tp * tp * v;
  }
  if (cumV === 0) return null;
  const vwap = cumPV / cumV;
  const variance = cumPV2 / cumV - vwap * vwap;
  const std = Math.sqrt(Math.max(0, variance));
  return {
    vwap,
    upper1: vwap + std,
    lower1: vwap - std,
    upper2: vwap + 2 * std,
    lower2: vwap - 2 * std,
    std,
    barCount: window.length,
  };
}

/** Anchored VWAP — anchor to a specific bar index. */
export function anchoredVWAP(bars, anchorIdx) {
  if (anchorIdx < 0 || anchorIdx >= bars.length) return null;
  return computeVWAP(bars.slice(anchorIdx));
}

// ─── Stochastic ───────────────────────────────────────────────────────────────

export function stochastic(bars, kPeriod = 14, dPeriod = 3) {
  const k = new Array(bars.length).fill(NaN);
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let high = -Infinity, low = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].high > high) high = bars[j].high;
      if (bars[j].low  < low)  low  = bars[j].low;
    }
    const range = high - low;
    k[i] = range === 0 ? 50 : ((bars[i].close - low) / range) * 100;
  }
  const d = sma(k, dPeriod);
  return { k, d };
}

// ─── Statistical primitives ───────────────────────────────────────────────────

export function mean(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  return v.length === 0 ? NaN : v.reduce((s, x) => s + x, 0) / v.length;
}

export function stdev(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return NaN;
}

export function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return NaN;
  return (a - b) / b;
}

/**
 * Format helpers used across modules.
 */
export const fmt = {
  price(n) {
    if (!Number.isFinite(n)) return '?';
    if (Math.abs(n) >= 1000) return n.toFixed(2);
    if (Math.abs(n) >= 100)  return n.toFixed(2);
    if (Math.abs(n) >= 10)   return n.toFixed(3);
    if (Math.abs(n) >= 1)    return n.toFixed(4);
    return n.toFixed(6);
  },
  pct(n, decimals = 2) {
    if (!Number.isFinite(n)) return '?';
    return (n * 100).toFixed(decimals) + '%';
  },
  num(n, decimals = 2) {
    if (!Number.isFinite(n)) return '?';
    return Number(n).toFixed(decimals);
  },
  money(n) {
    if (!Number.isFinite(n)) return '?';
    const sign = n >= 0 ? '+' : '';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  },
};
