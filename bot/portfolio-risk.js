/**
 * Portfolio Risk — total heat + correlation + Kelly sizing.
 *
 * Top 1% feature: instead of treating each trade as isolated $100 risk,
 * track:
 *   1. Total portfolio heat (sum of risk across all open positions)
 *   2. Correlation between symbols (BTC + ETH = halve both)
 *   3. Kelly fraction per setup (from measured win rate × payoff)
 *   4. Drawdown-adaptive sizing (cut size as drawdown grows)
 *
 * Reads from journal + position-tracker + active broker positions
 * (if/when wired to a real broker — currently uses journal "open" trades).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spearman } from './backtest.js';
import { mean, stdev } from './engine.js';
import { getActivePosition } from './position-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');

function loadJournal() {
  try { if (!existsSync(JOURNAL_PATH)) return []; return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); }
  catch { return []; }
}

// ─── Portfolio heat ──────────────────────────────────────────────────────────

/**
 * Sum of dollar risk across all currently-open positions.
 * Returns: { totalHeatDollars, totalHeatPct, openCount, byPosition: [...] }
 */
export function computePortfolioHeat(account = 10000) {
  const trades = loadJournal();
  const open = trades.filter(t => t.outcome?.status === 'open');
  const tracked = getActivePosition();

  // Combine: journal opens + (separately tracked single position if not already in journal)
  const allOpen = [...open];
  if (tracked && !open.some(t => t.symbol === tracked.symbol)) {
    allOpen.push({
      symbol: tracked.symbol,
      direction: tracked.direction,
      executed: { actualEntry: tracked.entry, actualSize: tracked.size, actualStop: tracked.stop },
    });
  }

  let totalRisk = 0;
  const byPosition = [];
  for (const t of allOpen) {
    const entry = t.executed?.actualEntry ?? t.plan?.entry;
    const stop  = t.executed?.actualStop  ?? t.plan?.stop;
    const size  = t.executed?.actualSize  ?? t.plan?.size;
    if (entry == null || stop == null || size == null) continue;
    const dollarRisk = Math.abs(entry - stop) * size;
    totalRisk += dollarRisk;
    byPosition.push({ symbol: t.symbol, direction: t.direction, dollarRisk, entry, stop, size });
  }

  return {
    totalHeatDollars: Number(totalRisk.toFixed(2)),
    totalHeatPct: (totalRisk / account) * 100,
    openCount: allOpen.length,
    byPosition,
  };
}

// ─── Correlation matrix between symbols ──────────────────────────────────────

/**
 * Compute pairwise Spearman correlation between symbols' recent returns.
 * Used to detect "correlated risk" (e.g., BTC + ETH = effectively one position).
 *
 * @param {Map<string, Array>} symbolBars - { symbol → [bars] }
 * @returns {object} { matrix: { 'A|B': rho }, correlatedPairs: [{ a, b, rho }] }
 */
export function correlationMatrix(symbolBars, threshold = 0.7) {
  const symbols = Array.from(symbolBars.keys());
  const matrix = {};
  const correlatedPairs = [];

  // Compute returns for each symbol
  const returns = new Map();
  for (const [sym, bars] of symbolBars) {
    const r = [];
    for (let i = 1; i < bars.length; i++) {
      r.push((bars[i].close - bars[i-1].close) / bars[i-1].close);
    }
    returns.set(sym, r);
  }

  // Pairwise spearman
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i], b = symbols[j];
      const ra = returns.get(a);
      const rb = returns.get(b);
      const minLen = Math.min(ra.length, rb.length);
      const rho = spearman(ra.slice(-minLen), rb.slice(-minLen));
      matrix[`${a}|${b}`] = Number(rho.toFixed(3));
      if (Math.abs(rho) >= threshold) correlatedPairs.push({ a, b, rho });
    }
  }
  return { matrix, correlatedPairs };
}

// ─── Kelly fraction per setup ────────────────────────────────────────────────

/**
 * Compute Kelly fraction for a setup based on its measured win rate
 * and average win/loss size.
 *
 * Kelly formula: f* = (bp - q) / b
 *   b = avg_win / avg_loss (payoff ratio)
 *   p = win rate
 *   q = 1 - p
 *
 * We CAP at 0.25 (quarter-Kelly) for safety — full Kelly is too aggressive
 * for noisy expectancy estimates and creates massive drawdowns.
 */
export function kellyForSetup(setupName, opts = {}) {
  const minTrades = opts.minTrades ?? 10;
  const cap = opts.cap ?? 0.25;
  const trades = loadJournal()
    .filter(t => t.setup === setupName)
    .filter(t => t.outcome?.pnl != null);

  if (trades.length < minTrades) return { kelly: 0.01, reason: `only ${trades.length} trades, default to 1%`, sample: trades.length };

  const wins = trades.filter(t => t.outcome.pnl > 0);
  const losses = trades.filter(t => t.outcome.pnl < 0);
  if (!wins.length || !losses.length) {
    return { kelly: 0.01, reason: 'need both wins and losses for Kelly', sample: trades.length };
  }

  const winRate = wins.length / trades.length;
  const avgWin  = wins.reduce((s, t) => s + t.outcome.pnl, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((s, t) => s + t.outcome.pnl, 0) / losses.length);
  const b = avgWin / avgLoss;
  const fullKelly = (b * winRate - (1 - winRate)) / b;

  // Negative Kelly = no edge → don't trade
  if (fullKelly <= 0) return { kelly: 0, reason: `Kelly = ${fullKelly.toFixed(3)} (no edge)`, sample: trades.length, winRate, avgWin, avgLoss };

  // Cap at quarter-Kelly
  const cappedKelly = Math.min(fullKelly, cap);
  return { kelly: cappedKelly, fullKelly, reason: `WR ${(winRate*100).toFixed(1)}% × payoff ${b.toFixed(2)}`, sample: trades.length, winRate, avgWin, avgLoss };
}

// ─── Drawdown-adaptive sizing ────────────────────────────────────────────────

/**
 * Reduce position size as portfolio drawdown grows.
 *
 * Logic: if current equity is X% below peak, multiply size by (1 - X*0.5).
 * Restores fully as you recover.
 *
 * Example: 10% drawdown → size × 0.95
 *          20% drawdown → size × 0.90
 *          30% drawdown → size × 0.85
 */
export function drawdownAdjuster(account = 10000) {
  const closed = loadJournal()
    .filter(t => t.outcome?.pnl != null)
    .sort((a, b) => +new Date(a.outcome.closedAt) - +new Date(b.outcome.closedAt));

  let eq = account;
  let peak = account;
  for (const t of closed) {
    eq += t.outcome.pnl;
    peak = Math.max(peak, eq);
  }
  const dd = peak > 0 ? (peak - eq) / peak : 0;
  const adjuster = Math.max(0.5, 1 - dd * 0.5);
  return { adjuster: Number(adjuster.toFixed(3)), drawdownPct: Number((dd * 100).toFixed(2)), peak, current: eq };
}

// ─── Aggregator: should I take this trade given portfolio state? ─────────────

/**
 * Returns suggested position size given:
 *   - the setup's Kelly fraction (from measured perf)
 *   - current portfolio heat
 *   - current drawdown
 *   - correlation with existing open positions
 *
 * @param {object} opts - { account, setupName, requestedRisk, currentSymbol, openSymbols }
 * @returns {object} { suggestedRisk$, multiplier, reasons: [...], block?: bool }
 */
export function adjustPositionSize(opts) {
  const account = opts.account ?? 10000;
  const requestedRisk = opts.requestedRisk ?? 100;
  const setupName = opts.setupName;
  const currentSymbol = opts.currentSymbol;
  const correlatedSymbols = opts.correlatedSymbols ?? [];

  const reasons = [];
  let multiplier = 1.0;

  // 1. Portfolio heat cap — refuse if already at 5% portfolio risk
  const heat = computePortfolioHeat(account);
  if (heat.totalHeatPct >= 5) {
    return { suggestedRisk$: 0, multiplier: 0, reasons: [`Portfolio heat ${heat.totalHeatPct.toFixed(1)}% ≥ 5% cap`], block: true };
  }
  if (heat.totalHeatPct >= 3) {
    multiplier *= 0.5;
    reasons.push(`Heat ${heat.totalHeatPct.toFixed(1)}% — halving size`);
  }

  // 2. Kelly fraction per setup
  if (setupName) {
    const kelly = kellyForSetup(setupName);
    if (kelly.kelly === 0) {
      return { suggestedRisk$: 0, multiplier: 0, reasons: [`Kelly=0 for ${setupName}: ${kelly.reason}`], block: true };
    }
    // Map Kelly to multiplier: Kelly=0.05 → 0.5×, Kelly=0.25 → 1.5× (cap at 1.5)
    const kellyMult = Math.max(0.3, Math.min(1.5, kelly.kelly * 6));
    multiplier *= kellyMult;
    reasons.push(`Kelly ${(kelly.kelly * 100).toFixed(1)}% (${kelly.reason}) → ${kellyMult.toFixed(2)}×`);
  }

  // 3. Drawdown adjuster
  const dd = drawdownAdjuster(account);
  if (dd.adjuster < 0.95) {
    multiplier *= dd.adjuster;
    reasons.push(`Drawdown ${dd.drawdownPct}% → ${dd.adjuster.toFixed(2)}× size`);
  }

  // 4. Correlation penalty — if any open position is highly correlated with this symbol, halve
  for (const corrSym of correlatedSymbols) {
    if (heat.byPosition.some(p => p.symbol === corrSym)) {
      multiplier *= 0.5;
      reasons.push(`Already open in correlated ${corrSym} → halving`);
      break;
    }
  }

  const suggestedRisk = requestedRisk * multiplier;
  return {
    suggestedRisk$: Number(suggestedRisk.toFixed(2)),
    multiplier: Number(multiplier.toFixed(3)),
    reasons,
    portfolioHeat: heat.totalHeatPct,
    block: suggestedRisk < 5,    // refuse to trade if size would be < $5
  };
}

// ─── VaR / CVaR computation ──────────────────────────────────────────────────

/**
 * Value-at-Risk (VaR) — historical method.
 *
 * VaR(95%) = the daily $ loss that you would NOT exceed 95% of the time.
 * Computed as the 5th percentile of historical daily P&L (sorted ascending).
 *
 * CVaR (Conditional VaR) = average loss in the worst 5% of cases (tail risk).
 * Useful because VaR ignores HOW BAD the tail is — CVaR captures it.
 *
 * Best used as a sizing input: cap CVaR(95%) at e.g., 2% of account.
 */
export function computeVaR(account = 10000, confidence = 0.95) {
  const closed = loadJournal()
    .filter(t => t.outcome?.pnl != null)
    .sort((a, b) => +new Date(a.outcome.closedAt) - +new Date(b.outcome.closedAt));

  if (closed.length < 10) {
    return { var: null, cvar: null, samples: closed.length, reason: 'need ≥ 10 trades for meaningful VaR' };
  }

  // Aggregate daily P&L (sum trades closed same day)
  const daily = new Map();
  for (const t of closed) {
    const day = t.outcome.closedAt.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + (t.outcome.pnl ?? 0));
  }
  const dailyPnls = [...daily.values()].sort((a, b) => a - b);   // ascending

  const tail = 1 - confidence;
  const varIdx = Math.max(0, Math.floor(dailyPnls.length * tail) - 1);
  const varValue = dailyPnls[varIdx];
  // CVaR = mean of worst tail (everything from 0 to varIdx inclusive)
  const tailLosses = dailyPnls.slice(0, varIdx + 1);
  const cvarValue = tailLosses.length ? tailLosses.reduce((s, x) => s + x, 0) / tailLosses.length : varValue;

  return {
    var: Number(varValue.toFixed(2)),
    cvar: Number(cvarValue.toFixed(2)),
    varPctOfAccount: Number(((varValue / account) * 100).toFixed(2)),
    cvarPctOfAccount: Number(((cvarValue / account) * 100).toFixed(2)),
    confidence, samples: dailyPnls.length,
    interpretation: `On ${(confidence * 100).toFixed(0)}% of days, daily loss won't exceed ${Math.abs(varValue).toFixed(2)} ($${Math.abs(varValue).toFixed(0)}). On the worst ${((1-confidence)*100).toFixed(0)}% of days, average loss is ${Math.abs(cvarValue).toFixed(2)} ($${Math.abs(cvarValue).toFixed(0)}).`,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const account = Number(process.argv[2] ?? 10000);
  console.log('━'.repeat(70));
  console.log('  PORTFOLIO RISK STATE');
  console.log('━'.repeat(70));

  const heat = computePortfolioHeat(account);
  console.log(`\nTotal heat:       $${heat.totalHeatDollars}  (${heat.totalHeatPct.toFixed(2)}% of $${account})`);
  console.log(`Open positions:   ${heat.openCount}`);
  for (const p of heat.byPosition) {
    console.log(`  ${p.symbol.padEnd(15)} ${p.direction.padEnd(5)} entry ${p.entry} stop ${p.stop} risk $${p.dollarRisk.toFixed(2)}`);
  }

  const dd = drawdownAdjuster(account);
  console.log(`\nDrawdown:         ${dd.drawdownPct}%  peak $${dd.peak.toFixed(2)}  current $${dd.current.toFixed(2)}`);
  console.log(`Size adjuster:    ${dd.adjuster}× (smaller as DD grows)`);

  // Per-setup Kelly
  const setups = new Set([...require('node:fs').readFileSync(JOURNAL_PATH, 'utf-8').match(/"setup":\s*"([^"]+)"/g) || []]
    .map(s => s.match(/"([^"]+)"$/)?.[1]).filter(Boolean));
  if (setups.size) {
    console.log(`\nKelly fraction per setup:`);
    for (const setup of setups) {
      const k = kellyForSetup(setup);
      console.log(`  ${setup.padEnd(40)} ${(k.kelly * 100).toFixed(2)}%  (${k.reason})`);
    }
  }
}
