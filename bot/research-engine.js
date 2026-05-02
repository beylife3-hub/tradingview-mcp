#!/usr/bin/env node
/**
 * Research Engine — auto-research the current ticker.
 *
 * Combines news sentiment + Finviz scrape + sector context + insider summary
 * to produce a one-page research brief on demand. Useful before taking a
 * position on a less-familiar symbol.
 *
 * Sources (all free, no API keys):
 *   - Yahoo Finance RSS (via news-sentiment.js)
 *   - SeekingAlpha RSS
 *   - Finviz quote page (analyst PT, short interest, insider trans, earnings)
 *   - SPDR sector context (via sector-rotation.js)
 *
 * Usage:
 *   node bot/research-engine.js TSLA          full brief on TSLA
 *   node bot/research-engine.js NVDA --json   machine-readable
 */

import { request } from 'node:https';
import { getTickerSentiment } from './news-sentiment.js';
import { getSectorForTicker } from './sector-rotation.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      out[argv[i]] = (next == null || next.startsWith('--')) ? true : next;
      if (out[argv[i]] !== true) i++;
    }
  }
  return out;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const r = request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) return resolve(fetchUrl(res.headers.location));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    r.on('error', reject);
    r.setTimeout(10_000, () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// ─── Finviz scraper ──────────────────────────────────────────────────────────
// Finviz has a stable HTML table on /quote.ashx?t=TICKER with key fundamentals.
// We extract via regex (no DOM parser to keep zero-dep).

function extractFinvizTable(html) {
  const out = {};
  const rowRegex = /<tr[^>]*class="table-dark[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const tagStrip = /<[^>]+>/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cm;
    while ((cm = cellRegex.exec(m[1])) !== null) {
      cells.push(cm[1].replace(tagStrip, '').replace(/&nbsp;/g, ' ').trim());
    }
    // Pairs of [label, value]
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i];
      const val = cells[i + 1];
      if (key && val) out[key] = val;
    }
  }
  return out;
}

async function fetchFinviz(ticker) {
  try {
    const html = await fetchUrl(`https://finviz.com/quote.ashx?t=${ticker}`);
    const fields = extractFinvizTable(html);
    if (!Object.keys(fields).length) return null;
    return fields;
  } catch { return null; }
}

// Extract the key fundamentals we care about
function summarizeFinviz(f) {
  if (!f) return null;
  return {
    price:       f['Price']        ?? null,
    marketCap:   f['Market Cap']   ?? null,
    pe:          f['P/E']          ?? null,
    eps:         f['EPS (ttm)']    ?? null,
    earningsDate:f['Earnings']     ?? null,
    targetPrice: f['Target Price'] ?? null,
    shortFloat:  f['Short Float']  ?? null,
    instOwn:     f['Inst Own']     ?? null,
    insiderOwn:  f['Insider Own']  ?? null,
    insiderTrans:f['Insider Trans']?? null,
    relVolume:   f['Rel Volume']   ?? null,
    avgVolume:   f['Avg Volume']   ?? null,
    week52High:  f['52W High']     ?? null,
    week52Low:   f['52W Low']      ?? null,
    perfWeek:    f['Perf Week']    ?? null,
    perfMonth:   f['Perf Month']   ?? null,
    perfYear:    f['Perf Year']    ?? null,
    rsi:         f['RSI (14)']     ?? null,
    beta:        f['Beta']         ?? null,
  };
}

// ─── Public: full research brief ─────────────────────────────────────────────

export async function research(symbol) {
  const ticker = String(symbol).split(':').pop().toUpperCase().replace(/[^A-Z0-9]/g, '');

  const [sentiment, finviz] = await Promise.all([
    getTickerSentiment(ticker).catch(() => null),
    fetchFinviz(ticker),
  ]);

  const fundamentals = summarizeFinviz(finviz);
  const sector = getSectorForTicker(ticker);

  // Compute a quick "research score" — composite of all signals
  let score = 0;
  const factors = [];

  if (sentiment) {
    if (sentiment.avgScore > 0.2) { score += 1; factors.push(`+1 bullish news (avg ${sentiment.avgScore})`); }
    if (sentiment.avgScore < -0.2) { score -= 1; factors.push(`-1 bearish news (avg ${sentiment.avgScore})`); }
  }

  if (fundamentals) {
    // Earnings within next 5 days = risky to hold through
    if (fundamentals.earningsDate?.match(/\b(today|tomorrow|in [1-5]d|May [0-9]+)\b/i)) {
      factors.push(`⚠️ earnings: ${fundamentals.earningsDate}`);
    }
    // Short squeeze potential
    if (fundamentals.shortFloat) {
      const sf = parseFloat(fundamentals.shortFloat);
      if (sf > 20) { score += 0.5; factors.push(`+0.5 short squeeze potential (SF ${fundamentals.shortFloat})`); }
    }
    // Heavy insider buying
    if (fundamentals.insiderTrans?.includes('+')) {
      const it = parseFloat(fundamentals.insiderTrans);
      if (it > 5) { score += 1; factors.push(`+1 heavy insider buying (${fundamentals.insiderTrans})`); }
      if (it < -5) { score -= 1; factors.push(`-1 heavy insider selling (${fundamentals.insiderTrans})`); }
    }
    // RSI extremes
    const rsi = parseFloat(fundamentals.rsi);
    if (rsi > 70) factors.push(`overbought (RSI ${fundamentals.rsi})`);
    if (rsi < 30) factors.push(`oversold (RSI ${fundamentals.rsi})`);
  }

  return {
    ticker,
    fetchedAt: new Date().toISOString(),
    sector,
    sentiment,
    fundamentals,
    researchScore: Number(score.toFixed(1)),
    factors,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const symbol = process.argv[2];
  if (!symbol || symbol.startsWith('--')) {
    console.log('Usage: node bot/research-engine.js <SYMBOL> [--json]');
    process.exit(1);
  }
  (async () => {
    const r = await research(symbol);
    if (args['--json']) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`\n━━━ RESEARCH BRIEF: ${r.ticker} ━━━\n`);
    if (r.sector) console.log(`Sector:           ${r.sector}`);
    if (r.fundamentals) {
      const f = r.fundamentals;
      console.log(`Price:            ${f.price ?? '—'}`);
      console.log(`Market cap:       ${f.marketCap ?? '—'}`);
      console.log(`P/E:              ${f.pe ?? '—'}  EPS: ${f.eps ?? '—'}`);
      console.log(`Target price:     ${f.targetPrice ?? '—'}`);
      console.log(`Earnings:         ${f.earningsDate ?? '—'}`);
      console.log(`Short float:      ${f.shortFloat ?? '—'}`);
      console.log(`Insider trans:    ${f.insiderTrans ?? '—'}  Inst own: ${f.instOwn ?? '—'}`);
      console.log(`Beta:             ${f.beta ?? '—'}  RSI(14): ${f.rsi ?? '—'}`);
      console.log(`Performance:      W ${f.perfWeek ?? '—'}  M ${f.perfMonth ?? '—'}  Y ${f.perfYear ?? '—'}`);
      console.log(`52W range:        ${f.week52Low ?? '—'} → ${f.week52High ?? '—'}`);
    }
    if (r.sentiment) {
      console.log(`\nNews sentiment:   ${r.sentiment.avgScore >= 0 ? '+' : ''}${r.sentiment.avgScore} ${r.sentiment.avgScore > 0.2 ? '🟢' : r.sentiment.avgScore < -0.2 ? '🔴' : '⚪'} (${r.sentiment.headlineCount} recent headlines)`);
      if (r.sentiment.recentBearish?.length) {
        console.log(`\nRecent bearish:`);
        for (const h of r.sentiment.recentBearish) console.log(`  [${h.score.toFixed(2)}]  ${h.title}`);
      }
      if (r.sentiment.recentBullish?.length) {
        console.log(`\nRecent bullish:`);
        for (const h of r.sentiment.recentBullish) console.log(`  [+${h.score.toFixed(2)}] ${h.title}`);
      }
    }
    console.log(`\nResearch score:   ${r.researchScore >= 0 ? '+' : ''}${r.researchScore}`);
    if (r.factors.length) {
      console.log(`Factors:`);
      for (const f of r.factors) console.log(`  • ${f}`);
    }
  })();
}
