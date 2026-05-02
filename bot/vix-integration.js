/**
 * VIX Integration — fear gauge halt.
 *
 * Reads VIX from the TradingView chart by switching to it temporarily,
 * then switches back. If VIX > spikeThreshold OR has spiked > spikePctThreshold
 * in the last hour, halts trading.
 *
 * Why: VIX > 30 historically marks regimes where intraday day-trading edge
 * collapses (correlations spike, news dominates, slippage explodes).
 *
 * Cache: VIX value cached in bot/journal/vix-state.json so we don't switch
 * the chart every single tick.
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'journal', 'vix-state.json');

const DEFAULT_SPIKE_LEVEL = 30;         // VIX > 30 = halt
const DEFAULT_SPIKE_PCT   = 0.20;       // > 20% rise in last hour = halt
const CACHE_TTL_MS        = 15 * 60_000; // 15 min — VIX moves slowly, less chart-switching

function loadCache() {
  try { if (!existsSync(CACHE_PATH)) return null; return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); }
  catch { return null; }
}

function saveCache(state) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Fetch current VIX value. Switches chart to TVC:VIX, reads quote, switches back.
 * Caches for 5 minutes to avoid disrupting trading flow.
 *
 * Returns: { value, fetchedAt, cached } or null on error
 */
export async function fetchVIX({ force = false } = {}) {
  const cache = loadCache();
  if (!force && cache && (Date.now() - new Date(cache.fetchedAt).getTime()) < CACHE_TTL_MS) {
    return { ...cache, cached: true };
  }

  let originalSymbol = null;
  let originalTf = null;
  try {
    const state = await chart.getState();
    originalSymbol = state.symbol;
    originalTf = state.resolution;

    // Don't switch if we're already on TVC:VIX (e.g., user is staring at it)
    if (originalSymbol === 'TVC:VIX') {
      const ohlcv = await data.getOhlcv({ count: 60, summary: false });
      if (!ohlcv.success || !ohlcv.bars?.length) throw new Error('VIX bars unavailable');
      const bars = ohlcv.bars;
      const currentVix = bars[bars.length - 1].close;
      const hourAgoVix = bars.length >= 60 ? bars[bars.length - 60].close : bars[0].close;
      const result = {
        value: Number(currentVix.toFixed(2)),
        hourAgo: Number(hourAgoVix.toFixed(2)),
        oneHourPctChange: Number(((currentVix - hourAgoVix) / hourAgoVix).toFixed(4)),
        fetchedAt: new Date().toISOString(),
        cached: false,
      };
      saveCache(result);
      return result;
    }

    await chart.setSymbol({ symbol: 'TVC:VIX' });
    await new Promise(r => setTimeout(r, 1500));

    // Pull last few bars to get current + 1-hour-ago value
    const ohlcv = await data.getOhlcv({ count: 60, summary: false });
    if (!ohlcv.success || !ohlcv.bars?.length) throw new Error('VIX bars unavailable');
    const bars = ohlcv.bars;
    const currentVix = bars[bars.length - 1].close;

    // Compute 1-hour-ago value (assuming 1m bars; closest to 60 bars back)
    const hourAgoBars = bars.length >= 60 ? bars[bars.length - 60] : bars[0];
    const hourAgoVix = hourAgoBars.close;
    const oneHourPctChange = (currentVix - hourAgoVix) / hourAgoVix;

    // Restore chart — VERIFIED. Loop up to 3 times if it didn't take.
    for (let attempt = 0; attempt < 3; attempt++) {
      await chart.setSymbol({ symbol: originalSymbol });
      await new Promise(r => setTimeout(r, 1500));
      const newState = await chart.getState();
      if (newState.symbol === originalSymbol) break;
      console.error(`[vix] restore attempt ${attempt + 1} failed, retrying...`);
    }
    if (originalTf) {
      await chart.setTimeframe({ timeframe: originalTf });
      await new Promise(r => setTimeout(r, 1200));
    }

    const result = {
      value: Number(currentVix.toFixed(2)),
      hourAgo: Number(hourAgoVix.toFixed(2)),
      oneHourPctChange: Number(oneHourPctChange.toFixed(4)),
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
    saveCache(result);
    return result;
  } catch (e) {
    // Best-effort restore — try harder
    if (originalSymbol && originalSymbol !== 'TVC:VIX') {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        await new Promise(r => setTimeout(r, 1500));
        if (originalTf) {
          await chart.setTimeframe({ timeframe: originalTf });
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch {}
    }
    return null;
  }
}

/**
 * Decide whether VIX state warrants halting trades.
 * Returns: { halted, reason, vix } or { halted: false, vix }
 */
export async function checkVIXHalt(opts = {}) {
  const spikeLevel  = opts.spikeLevel  ?? DEFAULT_SPIKE_LEVEL;
  const spikePctThr = opts.spikePctThr ?? DEFAULT_SPIKE_PCT;

  const vix = await fetchVIX(opts);
  if (!vix) return { halted: false, vix: null, reason: 'VIX unavailable (skipping check)' };

  if (vix.value >= spikeLevel) {
    return { halted: true, reason: `VIX ${vix.value} ≥ ${spikeLevel} (fear regime — halt)`, vix };
  }
  if (vix.oneHourPctChange >= spikePctThr) {
    return { halted: true, reason: `VIX spiked ${(vix.oneHourPctChange * 100).toFixed(1)}% in last hour (≥ ${(spikePctThr * 100).toFixed(0)}%)`, vix };
  }
  return { halted: false, vix };
}

/**
 * Get VIX without fetching (read cache only — for display/tracking).
 */
export function getCachedVIX() {
  return loadCache();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { disconnect } = await import('../src/connection.js');
    try {
      const r = await checkVIXHalt({ force: true });
      if (r.vix) {
        console.log(`VIX: ${r.vix.value}  (1h ago: ${r.vix.hourAgo}, change: ${(r.vix.oneHourPctChange * 100).toFixed(2)}%)`);
        console.log(`Halt: ${r.halted ? '🚨 YES — ' + r.reason : '✓ no'}`);
      } else {
        console.log(`VIX unavailable — ${r.reason}`);
      }
    } finally { await disconnect().catch(() => {}); }
  })();
}
