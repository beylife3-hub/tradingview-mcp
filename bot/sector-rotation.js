/**
 * Sector Rotation — relative strength across 11 SPDR sectors.
 *
 * Per O'Shaughnessy ("What Works on Wall Street"): RS-filtered longs
 * outperform unfiltered by 3-7% annualized.
 *
 * Logic: rank 11 SPDR sector ETFs + SPY by relative strength over a window.
 * Only take longs in stocks belonging to top-3 sectors. Discount/skip
 * setups in bottom-3.
 *
 * Sector ETFs:
 *   XLK Tech  XLF Financials  XLE Energy  XLV Healthcare  XLI Industrials
 *   XLY Consumer Disc  XLP Consumer Staples  XLU Utilities  XLB Materials
 *   XLRE Real Estate  XLC Communications
 *
 * Symbol → sector mapping uses a small lookup table for major tickers
 * (NVDA → XLK, JPM → XLF, etc.). Falls back to 'unknown' for others.
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'journal', 'sector-rotation.json');
const CACHE_TTL_MS = 30 * 60_000;   // 30 min — sectors don't shift fast

const SECTORS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const SECTOR_NAMES = {
  XLK:'Tech', XLF:'Financials', XLE:'Energy', XLV:'Healthcare',
  XLI:'Industrials', XLY:'Consumer Disc', XLP:'Consumer Staples',
  XLU:'Utilities', XLB:'Materials', XLRE:'Real Estate', XLC:'Communications',
};

// Symbol → SPDR sector lookup (major tickers only — extend as needed)
const TICKER_TO_SECTOR = {
  // Tech
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', INTC:'XLK', AVGO:'XLK',
  ORCL:'XLK', ADBE:'XLK', CRM:'XLK', NOW:'XLK', PANW:'XLK', SMCI:'XLK',
  // Financials
  JPM:'XLF', BAC:'XLF', WFC:'XLF', GS:'XLF', MS:'XLF', C:'XLF', V:'XLF', MA:'XLF',
  // Energy
  XOM:'XLE', CVX:'XLE', COP:'XLE', EOG:'XLE', SLB:'XLE', OXY:'XLE',
  // Healthcare
  UNH:'XLV', JNJ:'XLV', PFE:'XLV', LLY:'XLV', MRK:'XLV', ABBV:'XLV',
  // Industrials
  BA:'XLI', CAT:'XLI', GE:'XLI', HON:'XLI', UPS:'XLI', UNP:'XLI', LMT:'XLI', RTX:'XLI',
  // Consumer Disc
  AMZN:'XLY', TSLA:'XLY', HD:'XLY', NKE:'XLY', SBUX:'XLY', MCD:'XLY',
  // Consumer Staples
  PG:'XLP', KO:'XLP', PEP:'XLP', WMT:'XLP', COST:'XLP',
  // Utilities
  NEE:'XLU', SO:'XLU', DUK:'XLU',
  // Materials
  LIN:'XLB', SHW:'XLB',
  // Real Estate
  PLD:'XLRE', AMT:'XLRE',
  // Communications
  GOOGL:'XLC', GOOG:'XLC', META:'XLC', NFLX:'XLC', DIS:'XLC', T:'XLC', VZ:'XLC',
};

function loadCache() {
  try { if (!existsSync(CACHE_PATH)) return null; return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); }
  catch { return null; }
}
function saveCache(s) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(s, null, 2));
}

/**
 * Get sector for a ticker symbol (handles 'NASDAQ:NVDA' → 'XLK').
 */
export function getSectorForTicker(symbol) {
  const ticker = String(symbol).split(':').pop().toUpperCase().replace(/[^A-Z]/g, '');
  return TICKER_TO_SECTOR[ticker] || null;
}

/**
 * Compute relative strength for each sector vs SPY over `windowBars` bars.
 * RS = (sector_change_pct) - (SPY_change_pct). Positive = outperforming.
 *
 * Switches chart per symbol — slow. Cache 30 min.
 */
export async function rankSectors({ windowBars = 100, force = false } = {}) {
  const cache = loadCache();
  if (!force && cache && (Date.now() - new Date(cache.computedAt).getTime()) < CACHE_TTL_MS) {
    return { ...cache, cached: true };
  }

  const original = await chart.getState();
  const originalSymbol = original.symbol;
  const originalTf = original.resolution;

  // Force daily TF for sector rotation (not minute-level)
  await chart.setTimeframe({ timeframe: 'D' });
  await new Promise(r => setTimeout(r, 1500));

  // Pull SPY first as benchmark
  let spyChange = null;
  try {
    await chart.setSymbol({ symbol: 'AMEX:SPY' });
    await new Promise(r => setTimeout(r, 1500));
    const spy = await data.getOhlcv({ count: windowBars, summary: false });
    if (spy.success && spy.bars?.length >= 2) {
      spyChange = (spy.bars[spy.bars.length - 1].close - spy.bars[0].close) / spy.bars[0].close;
    }
  } catch (e) { /* SPY failed */ }

  const sectors = [];
  for (const sect of SECTORS) {
    try {
      await chart.setSymbol({ symbol: 'AMEX:' + sect });
      await new Promise(r => setTimeout(r, 1500));
      const bars = await data.getOhlcv({ count: windowBars, summary: false });
      if (!bars.success || !bars.bars?.length) continue;
      const change = (bars.bars[bars.bars.length - 1].close - bars.bars[0].close) / bars.bars[0].close;
      sectors.push({ sector: sect, name: SECTOR_NAMES[sect], change, rs: spyChange != null ? change - spyChange : change });
    } catch (e) { /* skip */ }
  }

  // Restore
  try {
    await chart.setSymbol({ symbol: originalSymbol });
    await new Promise(r => setTimeout(r, 1500));
    if (originalTf) {
      await chart.setTimeframe({ timeframe: originalTf });
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch { /* best-effort */ }

  // Rank by RS (descending = strongest first)
  sectors.sort((a, b) => b.rs - a.rs);
  const result = {
    computedAt: new Date().toISOString(),
    windowBars,
    spyChange: spyChange != null ? Number(spyChange.toFixed(4)) : null,
    sectors: sectors.map((s, i) => ({ ...s, rank: i + 1, change: Number(s.change.toFixed(4)), rs: Number(s.rs.toFixed(4)) })),
  };
  saveCache(result);
  return result;
}

/**
 * Quick gate — is this symbol's sector in the top-N strongest right now?
 *
 * Returns: { allowed, sector, rank, totalSectors, reason }
 */
export async function checkSectorGate(symbol, opts = {}) {
  const topN = opts.topN ?? 5;
  const sector = getSectorForTicker(symbol);
  if (!sector) return { allowed: true, sector: null, reason: 'symbol not in sector map (allowing)' };

  const ranking = await rankSectors(opts);
  const entry = ranking.sectors.find(s => s.sector === sector);
  if (!entry) return { allowed: true, sector, reason: 'sector ranking unavailable' };

  const allowed = entry.rank <= topN;
  return {
    allowed, sector, rank: entry.rank,
    totalSectors: ranking.sectors.length,
    reason: allowed
      ? `${SECTOR_NAMES[sector]} (${sector}) ranked #${entry.rank}/${ranking.sectors.length} — strong sector ✓`
      : `${SECTOR_NAMES[sector]} (${sector}) ranked #${entry.rank}/${ranking.sectors.length} — bottom sector, skip longs`,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { disconnect } = await import('../src/connection.js');
    try {
      const symbol = process.argv[2];
      const ranking = await rankSectors({ force: true });
      console.log(`\nSector RS over ${ranking.windowBars} bars (vs SPY ${(ranking.spyChange*100).toFixed(2)}%):\n`);
      for (const s of ranking.sectors) {
        const bar = s.rs > 0 ? '🟢' : '🔴';
        console.log(`  #${s.rank.toString().padStart(2)} ${bar} ${s.sector.padEnd(5)} ${SECTOR_NAMES[s.sector].padEnd(20)} ${(s.change*100).toFixed(2)}%  RS ${s.rs >= 0 ? '+' : ''}${(s.rs*100).toFixed(2)}%`);
      }
      if (symbol) {
        const gate = await checkSectorGate(symbol);
        console.log(`\nGate for ${symbol}: ${gate.allowed ? '✓' : '🚫'} ${gate.reason}`);
      }
    } finally { await disconnect().catch(() => {}); }
  })();
}
