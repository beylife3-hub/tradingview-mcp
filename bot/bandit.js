/**
 * Multi-Armed Bandit — Thompson sampling over setup detectors.
 *
 * Per Lattimore & Szepesvári "Bandit Algorithms": Thompson sampling is
 * the empirically best approach for the explore/exploit tradeoff in
 * non-stationary trading environments.
 *
 * How it works:
 *   - Each setup is an "arm" (e.g., Sweep+Reclaim, VWAP Bounce)
 *   - Track wins/losses per setup as Beta distribution parameters (α, β)
 *   - When deciding which setup to fire: sample probability from each Beta(α, β)
 *   - Pick the arm with highest sampled probability
 *   - This naturally explores untried setups + exploits known winners
 *
 * Per research: ~10-15% PnL boost in regime shifts vs static weights.
 *
 * Storage: bot/journal/bandit-state.json — Beta params per (setup, symbol)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, 'journal', 'bandit-state.json');
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');

const PRIOR_ALPHA = 1;   // Prior wins (Beta(1,1) = uniform)
const PRIOR_BETA  = 1;   // Prior losses

function loadState() {
  try { if (!existsSync(STATE_PATH)) return { arms: {}, lastUpdated: null }; return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { arms: {}, lastUpdated: null }; }
}
function saveState(s) { mkdirSync(dirname(STATE_PATH), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function loadJournal() {
  try { if (!existsSync(JOURNAL_PATH)) return []; return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); }
  catch { return []; }
}

// ─── Beta sampling ───────────────────────────────────────────────────────────
// Box-Muller-style Beta sampler via two Gamma samples (Marsaglia-Tsang).

function gammaSample(shape) {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1/3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x*x*x*x) return d * v;
    if (Math.log(u) < 0.5 * x*x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample() {
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function betaSample(alpha, beta) {
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an outcome for a setup arm.
 * @param {string} setupName
 * @param {string} symbol
 * @param {boolean} won — was the trade profitable?
 */
export function recordOutcome(setupName, symbol, won) {
  const state = loadState();
  const key = `${setupName}|${symbol}`;
  if (!state.arms[key]) state.arms[key] = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, totalTrades: 0 };
  if (won) state.arms[key].alpha++;
  else     state.arms[key].beta++;
  state.arms[key].totalTrades++;
  state.arms[key].lastUpdated = new Date().toISOString();
  state.lastUpdated = new Date().toISOString();
  saveState(state);
  return state.arms[key];
}

/**
 * Sample expected win probability for a (setup, symbol) using Thompson sampling.
 * Returns a value in [0, 1] — call multiple times to get distribution.
 */
export function sampleArm(setupName, symbol) {
  const state = loadState();
  const key = `${setupName}|${symbol}`;
  const arm = state.arms[key] ?? { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, totalTrades: 0 };
  return betaSample(arm.alpha, arm.beta);
}

/**
 * Get expected win rate (mean of Beta) for a (setup, symbol).
 */
export function getExpectedWinRate(setupName, symbol) {
  const state = loadState();
  const key = `${setupName}|${symbol}`;
  const arm = state.arms[key] ?? { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, totalTrades: 0 };
  return arm.alpha / (arm.alpha + arm.beta);
}

/**
 * Compute multiplier for a (setup, symbol):
 *   - sample once via Thompson
 *   - return multiplier 0.5..1.5 mapped from probability 0.3..0.7
 *
 * Use as score multiplier in scoring.js.
 */
export function banditMultiplier(setupName, symbol) {
  const sampled = sampleArm(setupName, symbol);
  // Map [0.3..0.7] win-rate to [0.5..1.5] multiplier
  const clamped = Math.max(0.3, Math.min(0.7, sampled));
  return 0.5 + (clamped - 0.3) * 2.5;
}

/**
 * Rebuild arm state from the journal — call periodically (or on bot startup).
 */
export function rebuildFromJournal() {
  const trades = loadJournal()
    .filter(t => ['won', 'lost'].includes(t.outcome?.status));
  const state = { arms: {}, lastUpdated: new Date().toISOString() };
  for (const t of trades) {
    const setup = t.setup || '?';
    const symbol = t.symbol || '?';
    const key = `${setup}|${symbol}`;
    if (!state.arms[key]) state.arms[key] = { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, totalTrades: 0 };
    if (t.outcome.status === 'won') state.arms[key].alpha++;
    else                             state.arms[key].beta++;
    state.arms[key].totalTrades++;
  }
  saveState(state);
  return state;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'rebuild') {
    const s = rebuildFromJournal();
    console.log(`✓ Rebuilt bandit state from journal — ${Object.keys(s.arms).length} arms`);
  } else {
    const state = loadState();
    const arms = Object.entries(state.arms || {});
    if (!arms.length) { console.log('(no bandit state yet — run rebuild after some trades)'); process.exit(0); }
    console.log(`Bandit arms — ${arms.length} (setup × symbol) pairs:\n`);
    arms.sort((a, b) => (b[1].alpha / (b[1].alpha + b[1].beta)) - (a[1].alpha / (a[1].alpha + a[1].beta)));
    for (const [key, arm] of arms) {
      const er = arm.alpha / (arm.alpha + arm.beta);
      const sample = betaSample(arm.alpha, arm.beta);
      const bar = '█'.repeat(Math.round(er * 10));
      console.log(`  ${key.padEnd(50)}  α=${arm.alpha} β=${arm.beta}  WR=${(er*100).toFixed(1)}%  sample=${(sample*100).toFixed(1)}%  ${bar}`);
    }
  }
}
