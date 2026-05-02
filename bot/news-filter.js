/**
 * News risk filter — block trades around scheduled high-impact events.
 *
 * Uses a manually-curated list of scheduled events (FOMC, CPI, NFP, earnings,
 * etc.) plus a heuristic spike-detection fallback. No external API dependency
 * by default — events are loaded from bot/journal/news-events.json.
 *
 * Schema for news-events.json (manually edit OR script-update):
 * [
 *   { "datetime": "2026-05-07T18:00:00Z", "name": "FOMC", "impact": "high" },
 *   { "datetime": "2026-05-09T12:30:00Z", "name": "CPI MoM", "impact": "high" },
 *   { "datetime": "2026-05-10T12:30:00Z", "name": "NFP", "impact": "high" }
 * ]
 *
 * Default block window: ±30 min around any high-impact event.
 *
 * Heuristic fallback: if first 5-min bar of the session has range > 2× ATR(20),
 * news already moved the market — skip the session.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atr } from './engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, 'journal', 'news-events.json');
const OVERRIDES_PATH = join(__dirname, 'journal', 'news-overrides.json');

const DEFAULT_BLOCK_WINDOW_MIN = 30;

function loadEvents() {
  try {
    if (!existsSync(EVENTS_PATH)) return [];
    return JSON.parse(readFileSync(EVENTS_PATH, 'utf-8'));
  } catch { return []; }
}

function loadOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return [];
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'));
  } catch { return []; }
}

/**
 * Is right now within blockWindowMin of any scheduled high-impact event?
 * @returns {object} { blocked, reason, events }
 */
export function isNewsRisk(opts = {}) {
  const blockWindowMin = opts.blockWindowMin ?? DEFAULT_BLOCK_WINDOW_MIN;
  const now = Date.now();
  const blockMs = blockWindowMin * 60_000;

  const events = [...loadEvents(), ...loadOverrides()];
  const nearby = events.filter(e => {
    const t = new Date(e.datetime).getTime();
    return Math.abs(now - t) <= blockMs && (e.impact === 'high' || e.impact === 'critical');
  });

  if (nearby.length) {
    const e = nearby[0];
    const minutesAway = Math.round((new Date(e.datetime).getTime() - now) / 60_000);
    const direction = minutesAway > 0 ? `in ${minutesAway} min` : `${-minutesAway} min ago`;
    return {
      blocked: true,
      reason: `${e.name} (${e.impact}) — ${direction}`,
      events: nearby,
    };
  }
  return { blocked: false };
}

/**
 * Heuristic spike detector — if the first bar of the session was > 2× ATR(20),
 * news already moved the market. Skip the rest of the session.
 *
 * @param {Array} bars - recent OHLCV bars
 */
export function detectNewsSpike(bars, opts = {}) {
  const ratioThreshold = opts.ratioThreshold ?? 2.0;
  if (!bars || bars.length < 25) return { spike: false };

  const atrSeries = atr(bars, 20);
  // Find session-open bar — heuristic: largest gap from prior close in last 80 bars
  const recent = bars.slice(-80);
  let openIdx = -1, biggestGap = 0;
  for (let i = 1; i < recent.length; i++) {
    const gap = Math.abs(recent[i].open - recent[i-1].close);
    if (gap > biggestGap) { biggestGap = gap; openIdx = i; }
  }
  if (openIdx < 0) return { spike: false };

  const openBar = recent[openIdx];
  const range = openBar.high - openBar.low;
  const baseAtr = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(baseAtr) || baseAtr === 0) return { spike: false };

  const ratio = range / baseAtr;
  if (ratio > ratioThreshold) {
    return {
      spike: true,
      ratio,
      reason: `Session-open bar range ${ratio.toFixed(1)}× ATR (${range.toFixed(2)} vs ATR ${baseAtr.toFixed(2)}) — news likely moved the market`,
    };
  }
  return { spike: false, ratio };
}

/**
 * Add a manual override event (e.g., earnings call you know about).
 */
export function addOverride(name, datetime, impact = 'high') {
  const overrides = loadOverrides();
  overrides.push({ name, datetime: new Date(datetime).toISOString(), impact });
  mkdirSync(dirname(OVERRIDES_PATH), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
  return overrides.length;
}

/**
 * Combined check — is now risky?
 */
export function checkNewsRisk(bars, opts = {}) {
  const sched = isNewsRisk(opts);
  if (sched.blocked) return sched;
  const spike = detectNewsSpike(bars, opts);
  if (spike.spike) return { blocked: true, reason: spike.reason, kind: 'spike' };
  return { blocked: false };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'add') {
    // node bot/news-filter.js add "FOMC" "2026-05-07T18:00:00Z" high
    const [, , , name, datetime, impact = 'high'] = process.argv;
    if (!name || !datetime) { console.error('Usage: add <name> <ISO datetime> [impact]'); process.exit(1); }
    const count = addOverride(name, datetime, impact);
    console.log(`✓ Added override (${count} total)`);
  } else if (cmd === 'check') {
    const r = isNewsRisk();
    console.log(r.blocked ? `🔒 BLOCKED: ${r.reason}` : '✓ no news risk in next/last 30min');
    if (r.events) for (const e of r.events) console.log(`   ${e.datetime}  ${e.name}  (${e.impact})`);
  } else {
    console.log('Usage:');
    console.log('  node bot/news-filter.js check                       check current news risk');
    console.log('  node bot/news-filter.js add <name> <ISO> [impact]   add manual event');
    console.log('');
    console.log('Edit bot/journal/news-events.json to populate scheduled events.');
    console.log('Manual overrides go in bot/journal/news-overrides.json.');
  }
}
