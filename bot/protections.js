/**
 * Protections — Freqtrade-style circuit breakers.
 *
 * Hard auto-pauses to prevent the "tilt cluster" of consecutive losses that
 * destroys retail accounts. Reads the trade journal + tracks manual locks.
 *
 * Each protection returns:
 *   { locked: boolean, reason: string, until: ISO|null, kind: string }
 *
 * Reference: freqtrade/freqtrade/plugins/protections/
 * Community-reported 20-40% drawdown reduction vs. same strategy without these.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');
const STATE_PATH   = join(__dirname, 'journal', 'protection-state.json');

// ─── Defaults (override per-call) ─────────────────────────────────────────────

export const DEFAULTS = {
  maxDailyDrawdownPct:        -3,    // -3% on the day → halt until tomorrow
  maxWeeklyDrawdownPct:       -7,    // -7% on the week → halt until next Monday

  stoplossGuardCount:          3,    // 3 stops...
  stoplossGuardWindowMin:     60,    // ...within 60 min...
  stoplossGuardCooldownMin:  120,    // ...= 2-hour cooldown

  maxConsecutiveLosses:        3,
  consecutiveLossCooldownMin: 240,   // 4-hour cooldown after streak

  maxTradesPerDay:             8,
  maxPositionsPerSymbol:       1,

  setupBanMinTrades:           8,
  setupBanExpectancyMaxR:   -0.10,   // expectancy < -0.10R → ban for session
};

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { locks: [] };
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch { return { locks: [] }; }
}

function saveState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function loadJournal() {
  try {
    if (!existsSync(JOURNAL_PATH)) return [];
    return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));
  } catch { return []; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

function startOfWeek(d = new Date()) {
  const x = startOfDay(d);
  const day = x.getDay() || 7;          // Sunday=0 → 7; treat Mon as start
  if (day !== 1) x.setHours(-24 * (day - 1));
  return x;
}

function tradesAfter(trades, cutoff) {
  const ts = +cutoff;
  return trades.filter(t => +new Date(t.outcome?.closedAt ?? t.createdAt) >= ts);
}

// ─── Individual protections ──────────────────────────────────────────────────

export function maxDrawdown(opts = {}) {
  const { maxDailyDrawdownPct, maxWeeklyDrawdownPct } = { ...DEFAULTS, ...opts };
  const account = opts.account ?? 10000;
  const trades  = loadJournal();
  const closed  = trades.filter(t => t.outcome?.pnl != null);

  // Daily
  const todayPnl = tradesAfter(closed, startOfDay()).reduce((s, t) => s + (t.outcome.pnl || 0), 0);
  const todayDDPct = (todayPnl / account) * 100;
  if (todayDDPct <= maxDailyDrawdownPct) {
    const tomorrow = startOfDay(); tomorrow.setDate(tomorrow.getDate() + 1);
    return { locked: true, kind: 'maxDailyDrawdown', until: tomorrow.toISOString(),
             reason: `Daily drawdown ${todayDDPct.toFixed(2)}% ≤ ${maxDailyDrawdownPct}%` };
  }

  // Weekly
  const weekPnl = tradesAfter(closed, startOfWeek()).reduce((s, t) => s + (t.outcome.pnl || 0), 0);
  const weekDDPct = (weekPnl / account) * 100;
  if (weekDDPct <= maxWeeklyDrawdownPct) {
    const nextMonday = startOfWeek(); nextMonday.setDate(nextMonday.getDate() + 7);
    return { locked: true, kind: 'maxWeeklyDrawdown', until: nextMonday.toISOString(),
             reason: `Weekly drawdown ${weekDDPct.toFixed(2)}% ≤ ${maxWeeklyDrawdownPct}%` };
  }

  return { locked: false };
}

export function stoplossGuard(opts = {}) {
  const { stoplossGuardCount, stoplossGuardWindowMin, stoplossGuardCooldownMin } = { ...DEFAULTS, ...opts };
  const trades = loadJournal();
  const window = new Date(Date.now() - stoplossGuardWindowMin * 60_000);
  const recent = tradesAfter(trades, window);
  const stops  = recent.filter(t => t.outcome?.status === 'lost' && (t.outcome?.reason ?? '').toLowerCase().includes('stop'));
  if (stops.length >= stoplossGuardCount) {
    const until = new Date(Date.now() + stoplossGuardCooldownMin * 60_000);
    return { locked: true, kind: 'stoplossGuard', until: until.toISOString(),
             reason: `${stops.length} stop-outs in last ${stoplossGuardWindowMin}min — cooling down ${stoplossGuardCooldownMin}min` };
  }
  return { locked: false };
}

export function consecutiveLosses(opts = {}) {
  const { maxConsecutiveLosses, consecutiveLossCooldownMin } = { ...DEFAULTS, ...opts };
  const trades = loadJournal()
    .filter(t => t.outcome?.status === 'lost' || t.outcome?.status === 'won')
    .sort((a, b) => +new Date(b.outcome.closedAt) - +new Date(a.outcome.closedAt));
  let streak = 0;
  for (const t of trades) {
    if (t.outcome.status === 'lost') streak++;
    else break;
  }
  if (streak >= maxConsecutiveLosses) {
    const lastLoss = new Date(trades[0].outcome.closedAt);
    const until = new Date(+lastLoss + consecutiveLossCooldownMin * 60_000);
    if (until > new Date()) {
      return { locked: true, kind: 'consecutiveLosses', until: until.toISOString(),
               reason: `${streak} consecutive losses — cooldown ${consecutiveLossCooldownMin}min` };
    }
  }
  return { locked: false };
}

export function maxTradesPerDay(opts = {}) {
  const { maxTradesPerDay: cap } = { ...DEFAULTS, ...opts };
  const trades = loadJournal();
  const today  = tradesAfter(trades, startOfDay()).filter(t => t.executed?.taken);
  if (today.length >= cap) {
    const tomorrow = startOfDay(); tomorrow.setDate(tomorrow.getDate() + 1);
    return { locked: true, kind: 'maxTradesPerDay', until: tomorrow.toISOString(),
             reason: `Daily trade cap reached (${today.length}/${cap})` };
  }
  return { locked: false };
}

export function maxPositionsPerSymbol(symbol, opts = {}) {
  const { maxPositionsPerSymbol: cap } = { ...DEFAULTS, ...opts };
  const open = loadJournal().filter(t => t.symbol === symbol && t.outcome?.status === 'open');
  if (open.length >= cap) {
    return { locked: true, kind: 'maxPositionsPerSymbol', until: null,
             reason: `Already ${open.length} open position(s) on ${symbol}` };
  }
  return { locked: false };
}

export function lowExpectancySetupBan(setupName, opts = {}) {
  const { setupBanMinTrades, setupBanExpectancyMaxR } = { ...DEFAULTS, ...opts };
  const trades = loadJournal()
    .filter(t => t.setup === setupName)
    .filter(t => t.outcome?.rMult != null);
  if (trades.length < setupBanMinTrades) return { locked: false };
  const expectancy = trades.reduce((s, t) => s + t.outcome.rMult, 0) / trades.length;
  if (expectancy <= setupBanExpectancyMaxR) {
    return { locked: true, kind: 'lowExpectancySetupBan', until: null,
             reason: `"${setupName}" expectancy ${expectancy.toFixed(2)}R over ${trades.length} trades — banned this session` };
  }
  return { locked: false };
}

// ─── Aggregator ──────────────────────────────────────────────────────────────

/**
 * Run all protections (manual + auto). Returns first lock found, or { locked:false }.
 *
 * @param {object} opts - { account, symbol, setup, ...override defaults }
 */
export function checkProtections(opts = {}) {
  // Manual first
  const manual = getManualLock();
  if (manual.locked) return manual;

  const checks = [
    () => maxDrawdown(opts),
    () => stoplossGuard(opts),
    () => consecutiveLosses(opts),
    () => maxTradesPerDay(opts),
    ...(opts.symbol ? [() => maxPositionsPerSymbol(opts.symbol, opts)] : []),
    ...(opts.setup  ? [() => lowExpectancySetupBan(opts.setup, opts)] : []),
  ];
  for (const fn of checks) {
    const res = fn();
    if (res.locked) return res;
  }
  return { locked: false };
}

// ─── Manual lock (for /pause Telegram command) ───────────────────────────────

export function setManualLock(reasonText, untilISO) {
  const s = loadState();
  s.locks = s.locks.filter(l => l.kind !== 'manual');
  s.locks.push({ kind: 'manual', reason: reasonText, until: untilISO, locked: true });
  saveState(s);
}

export function clearManualLock() {
  const s = loadState();
  s.locks = s.locks.filter(l => l.kind !== 'manual');
  saveState(s);
}

export function getManualLock() {
  const s = loadState();
  const m = s.locks.find(l => l.kind === 'manual');
  if (!m) return { locked: false };
  if (m.until && new Date(m.until) < new Date()) {
    clearManualLock();
    return { locked: false };
  }
  return m;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const account = Number(process.argv[2] ?? 10000);
  const status = checkProtections({ account });
  const manual = getManualLock();
  console.log('━'.repeat(70));
  console.log('  PROTECTIONS STATUS');
  console.log('━'.repeat(70));
  console.log(`  Account                 $${account.toLocaleString()}`);
  console.log(`  Manual lock             ${manual.locked ? '🔒 ' + manual.reason : '✓ open'}`);
  console.log(`  Auto protections        ${status.locked && status.kind !== 'manual' ? '🔒 ' + status.reason : '✓ all clear'}`);
  if (status.until) console.log(`  Locked until            ${status.until}`);

  // Per-setup ban check
  const setups = new Set(loadJournal().map(t => t.setup).filter(Boolean));
  if (setups.size) {
    console.log('\n  Per-setup auto-ban check:');
    for (const setup of setups) {
      const r = lowExpectancySetupBan(setup);
      const trades = loadJournal().filter(t => t.setup === setup && t.outcome?.rMult != null);
      if (trades.length === 0) continue;
      const exp = trades.reduce((s, t) => s + t.outcome.rMult, 0) / trades.length;
      console.log(`    ${r.locked ? '🚫' : '✓ '} ${setup.padEnd(40)} ${exp.toFixed(2)}R  (${trades.length} trades)`);
    }
  }
}
