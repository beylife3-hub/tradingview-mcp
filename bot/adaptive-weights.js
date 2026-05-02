/**
 * Adaptive Weights — online learning from your own trades.
 *
 * Reads the journal and computes per-setup, per-symbol, per-regime
 * expectancy on a rolling window. Outputs a "weight multiplier" that
 * the scoring layer uses to amplify setups that are working FOR YOU
 * RIGHT NOW and dampen ones that aren't.
 *
 * Storage: bot/journal/adaptive-state.json
 *
 * Concepts:
 *   - Rolling window: last 30 closed trades per (setup × symbol × regime) cell
 *   - Expectancy: avg R-multiple
 *   - Weight: maps expectancy [-1R..+1R] → multiplier [0.5..1.5]
 *   - Confidence: scales with sample size (Bayesian shrinkage to 1.0 at low N)
 *
 * The multiplier flows back into scoring.js → setup score is amplified
 * or dampened based on its actual recent performance for YOU specifically.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');
const STATE_PATH   = join(__dirname, 'journal', 'adaptive-state.json');

const ROLLING_WINDOW    = 30;     // bars per (setup × symbol × regime) cell
const MIN_TRADES_TRUST  = 5;      // need this many before trusting expectancy
const SHRINKAGE_PRIOR   = 1.0;    // Bayesian prior — neutral multiplier
const SHRINKAGE_STRENGTH = 10;    // higher = more shrinkage at low N

function loadJournal() {
  try { if (!existsSync(JOURNAL_PATH)) return []; return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); }
  catch { return []; }
}

function loadState() {
  try { if (!existsSync(STATE_PATH)) return { lastUpdated: null, weights: {} }; return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { lastUpdated: null, weights: {} }; }
}

function saveState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ─── Compute expectancy → multiplier ─────────────────────────────────────────

/**
 * Map expectancy in R-units to a weight multiplier with Bayesian shrinkage.
 *
 * exp = +1R     → mult ≈ 1.5  (boost)
 * exp =  0R     → mult ≈ 1.0  (neutral)
 * exp = -1R     → mult ≈ 0.5  (dampen)
 *
 * At low sample size, shrinks toward 1.0 (don't trust noisy data).
 */
function expectancyToMultiplier(expectancy, n) {
  if (n === 0) return 1.0;
  // Shrinkage factor: pulls toward prior (1.0) when n is small
  const trust = n / (n + SHRINKAGE_STRENGTH);
  const rawMult = Math.max(0.5, Math.min(1.5, 1.0 + expectancy * 0.5));
  return SHRINKAGE_PRIOR * (1 - trust) + rawMult * trust;
}

// ─── Build weights from journal ──────────────────────────────────────────────

/**
 * Recompute all adaptive weights from the journal.
 *
 * Returns: { lastUpdated, weights: { 'setup|symbol|regime': { count, expectancy, multiplier, lastN } } }
 */
export function recomputeWeights() {
  const trades = loadJournal()
    .filter(t => ['won', 'lost', 'breakeven'].includes(t.outcome?.status) && t.outcome?.rMult != null)
    .sort((a, b) => +new Date(a.outcome.closedAt) - +new Date(b.outcome.closedAt));

  // Group by setup × symbol × regime (regime stored on the trade if available)
  const cells = new Map();
  for (const t of trades) {
    const setup = t.setup || '?';
    const symbol = t.symbol || '?';
    // Note: regime is not currently stored on trades; we use 'all' as fallback
    const regime = t.regime || 'all';

    // Three keys at increasing specificity for graceful fallback
    const keys = [
      `${setup}|${symbol}|${regime}`,    // most specific
      `${setup}|${symbol}|*`,            // setup × symbol
      `${setup}|*|*`,                    // setup only
    ];

    for (const k of keys) {
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(t.outcome.rMult);
    }
  }

  // Compute rolling expectancy + multiplier for each cell
  const weights = {};
  for (const [k, rMults] of cells) {
    const recent = rMults.slice(-ROLLING_WINDOW);
    const expectancy = recent.reduce((s, r) => s + r, 0) / recent.length;
    const multiplier = expectancyToMultiplier(expectancy, recent.length);
    weights[k] = {
      count: recent.length,
      totalCount: rMults.length,
      expectancy: Number(expectancy.toFixed(3)),
      multiplier: Number(multiplier.toFixed(3)),
      lastN: recent.slice(-5).map(r => Number(r.toFixed(2))),  // sparkline of last 5
    };
  }

  const state = { lastUpdated: new Date().toISOString(), weights };
  saveState(state);
  return state;
}

// ─── Public: get multiplier for a (setup, symbol, regime) tuple ──────────────

/**
 * Returns the weight multiplier for a given setup. Falls back from most
 * specific → least specific:
 *   1. setup × symbol × regime (e.g. "Sweep+Reclaim|TSLA|trending-up")
 *   2. setup × symbol (e.g. "Sweep+Reclaim|TSLA|*")
 *   3. setup only (e.g. "Sweep+Reclaim|*|*")
 *   4. neutral 1.0 if no data
 */
export function getMultiplier(setup, symbol, regime) {
  const state = loadState();
  const w = state.weights || {};
  const candidates = [
    `${setup}|${symbol}|${regime}`,
    `${setup}|${symbol}|*`,
    `${setup}|*|*`,
  ];
  for (const k of candidates) {
    if (w[k] && w[k].count >= MIN_TRADES_TRUST) return w[k].multiplier;
  }
  return 1.0;
}

/**
 * Returns whether a setup should be banned (auto-blacklist if expectancy
 * is severely negative on enough trades).
 */
export function isAutoBanned(setup, symbol = '*') {
  const state = loadState();
  const w = state.weights || {};
  const candidates = [`${setup}|${symbol}|*`, `${setup}|*|*`];
  for (const k of candidates) {
    const cell = w[k];
    if (cell && cell.count >= 10 && cell.expectancy < -0.20) {
      return { banned: true, reason: `${cell.expectancy.toFixed(2)}R expectancy over ${cell.count} trades — adaptive auto-ban` };
    }
  }
  return { banned: false };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];

  if (cmd === 'recompute' || cmd === 'rebuild') {
    const state = recomputeWeights();
    console.log(`✓ Rebuilt ${Object.keys(state.weights).length} weight cells`);
    console.log(`  Last updated: ${state.lastUpdated}`);
  } else {
    const state = loadState();
    if (!state.lastUpdated) {
      console.log('No adaptive state yet. Run: node bot/adaptive-weights.js recompute');
      process.exit(0);
    }
    console.log(`Adaptive Weights — last updated ${state.lastUpdated}\n`);
    const cells = Object.entries(state.weights || {});
    if (!cells.length) { console.log('(no cells yet — need closed trades in journal)'); process.exit(0); }

    console.log('  Cell                                          N    Expectancy   Multiplier   Last 5 Rs');
    console.log('  ' + '─'.repeat(100));
    cells.sort((a, b) => b[1].multiplier - a[1].multiplier);
    for (const [k, v] of cells) {
      const sparkline = v.lastN.map(r => r >= 0 ? `\x1b[32m+${r}\x1b[0m` : `\x1b[31m${r}\x1b[0m`).join(' ');
      const multColor = v.multiplier > 1.1 ? '\x1b[32m' : v.multiplier < 0.9 ? '\x1b[31m' : '';
      console.log(`  ${k.padEnd(45)} ${v.count.toString().padStart(3)}  ${(v.expectancy >= 0 ? '+' : '') + v.expectancy + 'R'.padEnd(8)}  ${multColor}${v.multiplier.toFixed(3)}\x1b[0m       ${sparkline}`);
    }

    // Show any auto-bans
    const bans = cells.filter(([, v]) => v.count >= 10 && v.expectancy < -0.20);
    if (bans.length) {
      console.log(`\n🚫 Auto-banned cells (expectancy < -0.20R on 10+ trades):`);
      for (const [k, v] of bans) console.log(`  ${k}: ${v.expectancy}R over ${v.count} trades`);
    }
  }
}
