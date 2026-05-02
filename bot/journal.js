#!/usr/bin/env node
/**
 * Trade Journal — Persistent log of every plan, fill, and outcome.
 *
 * The journal is the single source of truth for:
 *   - What setups the bot has fired (planned)
 *   - Which ones you actually took (executed)
 *   - How they ended (outcome: won/lost/breakeven/cancelled)
 *
 * Storage: bot/journal/trades.json (append-only JSON array)
 *
 * Trade record schema:
 * {
 *   id, createdAt, symbol, tf, setup, direction, score,
 *   plan:     { entry, stop, t1, t2, size, riskAmount },
 *   executed: { taken, actualEntry, actualSize, actualStop, actualTarget, takenAt },
 *   outcome:  { status, actualExit, reason, pnl, rMult, closedAt },
 *   notes
 * }
 *
 * status values: planned | open | won | lost | breakeven | cancelled
 *
 * CLI:
 *   node bot/journal.js list                           — recent plans
 *   node bot/journal.js open                           — currently open positions
 *   node bot/journal.js taken <id> [entry] [size]      — mark a plan as executed
 *   node bot/journal.js close <id> <exitPrice> <reason>— close a position at price
 *   node bot/journal.js cancel <id>                    — cancel a planned trade
 *   node bot/journal.js stats                          — full performance breakdown
 *   node bot/journal.js monitor                        — live unrealized P&L per open position
 *
 * Programmatic:
 *   logPlanToJournal(plan) — called by coach.js --log
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_DIR = join(__dirname, 'journal');
const JOURNAL_PATH = join(JOURNAL_DIR, 'trades.json');

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadJournal() {
  try {
    if (!existsSync(JOURNAL_PATH)) return [];
    return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));
  } catch { return []; }
}

function saveJournal(trades) {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(JOURNAL_PATH, JSON.stringify(trades, null, 2));
}

function makeId() {
  return randomBytes(6).toString('hex');
}

// ─── Public: log a plan from coach.js ────────────────────────────────────────

/**
 * Append a planned trade. Called by coach.js when --log is set.
 *
 * @param {object} planData - { symbol, timeframe, setup, direction, score,
 *                              entry, stop, t1, t2, size, riskAmount, biasScore? }
 * @returns {string} the new trade ID
 */
export function logPlanToJournal(planData) {
  const trades = loadJournal();
  const id = makeId();
  const trade = {
    id,
    createdAt: new Date().toISOString(),
    symbol:    planData.symbol,
    tf:        planData.timeframe ?? planData.tf ?? null,
    setup:     planData.setup,
    direction: planData.direction,
    score:     planData.score ?? null,
    biasScore: planData.biasScore ?? null,
    plan: {
      entry:      planData.entry,
      stop:       planData.stop,
      t1:         planData.t1 ?? planData.target1 ?? null,
      t2:         planData.t2 ?? planData.target2 ?? null,
      size:       planData.size,
      riskAmount: planData.riskAmount ?? null,
    },
    executed: { taken: false, actualEntry: null, actualSize: null,
                actualStop: null, actualTarget: null, takenAt: null },
    outcome:  { status: 'planned', actualExit: null, reason: null,
                pnl: null, rMult: null, closedAt: null },
    notes: planData.notes ?? '',
  };
  trades.push(trade);
  saveJournal(trades);
  return id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green:  '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan:   '\x1b[36m', white: '\x1b[37m',
};

function fmt$(n)  { if (n == null) return '—'; const s = n >= 0 ? '+' : ''; return `${s}$${Math.abs(n).toFixed(2)}`; }
function fmtR(n)  { if (n == null) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R'; }
function fmtPct(n){ if (n == null) return '—'; return (n * 100).toFixed(2) + '%'; }
function fmtPx(n) { if (n == null) return '—'; return Number(n) >= 100 ? Number(n).toFixed(2) : Number(n).toFixed(4); }
function colorize(text, n) {
  if (n == null) return text;
  return n >= 0 ? `${C.green}${text}${C.reset}` : `${C.red}${text}${C.reset}`;
}

function findById(trades, idPrefix) {
  // Match by full ID or shortest unique prefix
  return trades.find(t => t.id.startsWith(idPrefix));
}

function statusBadge(status) {
  const map = {
    planned:    `${C.dim}planned${C.reset}`,
    open:       `${C.cyan}OPEN${C.reset}`,
    won:        `${C.green}WON${C.reset}`,
    lost:       `${C.red}LOST${C.reset}`,
    breakeven:  `${C.yellow}B/E${C.reset}`,
    cancelled:  `${C.dim}cancelled${C.reset}`,
  };
  return map[status] ?? status;
}

// ─── CLI commands ────────────────────────────────────────────────────────────

function cmdList(limit = 20) {
  const trades = loadJournal();
  if (!trades.length) { console.log('_(no trades logged yet)_'); return; }
  const recent = trades.slice(-limit).reverse();
  console.log(`${C.bold}Recent ${recent.length} trades:${C.reset}`);
  console.log('');
  console.log(`  ID       Symbol         Dir   Setup                   Score  Status        Entry      P&L`);
  console.log('  ' + '─'.repeat(100));
  for (const t of recent) {
    const dir = t.direction === 'LONG' ? `${C.green}LONG${C.reset}` : `${C.red}SHORT${C.reset}`;
    const setup = (t.setup || '?').slice(0, 22).padEnd(22);
    const sym = (t.symbol || '?').slice(0, 14).padEnd(14);
    const score = (t.score != null ? t.score.toFixed(1) : '?').padStart(4);
    const entry = fmtPx(t.executed?.actualEntry ?? t.plan?.entry).padStart(10);
    const pnl = colorize(fmt$(t.outcome?.pnl).padStart(8), t.outcome?.pnl);
    console.log(`  ${t.id.slice(0,8)} ${sym} ${dir.padEnd(15)} ${setup} ${score}    ${statusBadge(t.outcome.status).padEnd(20)} ${entry}  ${pnl}`);
  }
}

function cmdOpen() {
  const trades = loadJournal();
  const open = trades.filter(t => t.outcome.status === 'open');
  if (!open.length) { console.log('_(no open positions)_'); return; }
  console.log(`${C.bold}${open.length} open position${open.length === 1 ? '' : 's'}:${C.reset}`);
  console.log('');
  for (const t of open) {
    const dir = t.direction === 'LONG' ? `${C.green}LONG${C.reset}` : `${C.red}SHORT${C.reset}`;
    console.log(`  ${C.bold}${t.symbol}${C.reset} ${dir}  (id ${t.id.slice(0,8)})`);
    console.log(`    Entry:   ${fmtPx(t.executed.actualEntry ?? t.plan.entry)}`);
    console.log(`    Stop:    ${fmtPx(t.executed.actualStop ?? t.plan.stop)}`);
    console.log(`    Target:  ${fmtPx(t.executed.actualTarget ?? t.plan.t1)}`);
    console.log(`    Size:    ${t.executed.actualSize ?? t.plan.size}`);
    console.log(`    Setup:   ${t.setup}  •  Score ${t.score}`);
    console.log(`    Opened:  ${t.executed.takenAt ?? t.createdAt}`);
    console.log('');
  }
}

function cmdTaken(id, actualEntry, actualSize) {
  const trades = loadJournal();
  const t = findById(trades, id);
  if (!t) { console.error(`✗ no trade matching "${id}"`); process.exit(1); }
  if (t.outcome.status !== 'planned') {
    console.error(`✗ trade ${t.id.slice(0,8)} is already ${t.outcome.status}`);
    process.exit(1);
  }
  t.executed.taken       = true;
  t.executed.actualEntry = actualEntry ? Number(actualEntry) : t.plan.entry;
  t.executed.actualSize  = actualSize  ? Number(actualSize)  : t.plan.size;
  t.executed.actualStop  = t.plan.stop;
  t.executed.actualTarget = t.plan.t1;
  t.executed.takenAt     = new Date().toISOString();
  t.outcome.status       = 'open';
  saveJournal(trades);
  console.log(`${C.green}✓${C.reset} ${t.symbol} ${t.direction} marked open at ${fmtPx(t.executed.actualEntry)}, size ${t.executed.actualSize}`);

  // Check for plan adherence deviations
  if (Math.abs(t.executed.actualEntry - t.plan.entry) / t.plan.entry > 0.005) {
    console.log(`${C.yellow}⚠${C.reset}  Entry deviates ${fmtPct((t.executed.actualEntry - t.plan.entry) / t.plan.entry)} from plan ${fmtPx(t.plan.entry)}`);
  }
  if (t.plan.size && Math.abs(t.executed.actualSize - t.plan.size) / t.plan.size > 0.10) {
    console.log(`${C.yellow}⚠${C.reset}  Size deviates ${fmtPct((t.executed.actualSize - t.plan.size) / t.plan.size)} from plan ${t.plan.size}`);
  }
}

function cmdClose(id, exitPrice, reason) {
  const trades = loadJournal();
  const t = findById(trades, id);
  if (!t) { console.error(`✗ no trade matching "${id}"`); process.exit(1); }
  if (t.outcome.status !== 'open') {
    console.error(`✗ trade ${t.id.slice(0,8)} is ${t.outcome.status}, not open`);
    process.exit(1);
  }
  const exit = Number(exitPrice);
  if (!Number.isFinite(exit)) { console.error('✗ exitPrice must be a number'); process.exit(1); }

  const entry = t.executed.actualEntry;
  const size  = t.executed.actualSize;
  const stop  = t.executed.actualStop ?? t.plan.stop;
  const dir   = t.direction === 'LONG' ? 1 : -1;
  const pnl   = (exit - entry) * dir * size;
  const initialRisk = Math.abs(entry - stop);
  const rMult = initialRisk > 0 ? ((exit - entry) * dir) / initialRisk : 0;

  let status;
  if (Math.abs(rMult) < 0.05)      status = 'breakeven';
  else if (rMult > 0)               status = 'won';
  else                              status = 'lost';

  t.outcome.actualExit = exit;
  t.outcome.reason     = reason ?? 'manual';
  t.outcome.pnl        = pnl;
  t.outcome.rMult      = rMult;
  t.outcome.status     = status;
  t.outcome.closedAt   = new Date().toISOString();
  saveJournal(trades);

  const verdict = status === 'won' ? `${C.green}✓ WON${C.reset}` : status === 'lost' ? `${C.red}✗ LOST${C.reset}` : `${C.yellow}— B/E${C.reset}`;
  console.log(`${verdict}  ${t.symbol} ${t.direction}  exit ${fmtPx(exit)}  ${colorize(fmt$(pnl), pnl)}  (${colorize(fmtR(rMult), rMult)})  reason: ${reason ?? 'manual'}`);
}

function cmdCancel(id) {
  const trades = loadJournal();
  const t = findById(trades, id);
  if (!t) { console.error(`✗ no trade matching "${id}"`); process.exit(1); }
  if (t.outcome.status === 'open' || t.outcome.status === 'won' || t.outcome.status === 'lost') {
    console.error(`✗ cannot cancel trade in status ${t.outcome.status}`);
    process.exit(1);
  }
  t.outcome.status   = 'cancelled';
  t.outcome.closedAt = new Date().toISOString();
  t.outcome.reason   = 'manual cancel';
  saveJournal(trades);
  console.log(`${C.dim}✗ cancelled ${t.symbol} ${t.direction} ${t.id.slice(0,8)}${C.reset}`);
}

function cmdStats() {
  const trades = loadJournal();
  const closed = trades.filter(t => ['won','lost','breakeven'].includes(t.outcome.status));
  if (!closed.length) {
    console.log(`${C.dim}_(no closed trades yet — ${trades.length} planned, ${trades.filter(t=>t.outcome.status==='open').length} open)_${C.reset}`);
    return;
  }

  const wins = closed.filter(t => t.outcome.status === 'won');
  const losses = closed.filter(t => t.outcome.status === 'lost');
  const totalPnl = closed.reduce((s, t) => s + (t.outcome.pnl ?? 0), 0);
  const winRate = wins.length / closed.length;
  const avgWinR = wins.length ? wins.reduce((s, t) => s + (t.outcome.rMult || 0), 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, t) => s + (t.outcome.rMult || 0), 0) / losses.length : 0;
  const expectancy = winRate * avgWinR + (1 - winRate) * avgLossR;
  const grossWin  = wins.reduce((s, t) => s + (t.outcome.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.outcome.pnl || 0), 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Streak detection
  let curStreak = 0, curStreakKind = null;
  let maxWinStreak = 0, maxLossStreak = 0;
  for (const t of closed) {
    if (t.outcome.status === 'won') {
      if (curStreakKind === 'won') curStreak++; else { curStreak = 1; curStreakKind = 'won'; }
      maxWinStreak = Math.max(maxWinStreak, curStreak);
    } else if (t.outcome.status === 'lost') {
      if (curStreakKind === 'lost') curStreak++; else { curStreak = 1; curStreakKind = 'lost'; }
      maxLossStreak = Math.max(maxLossStreak, curStreak);
    }
  }

  console.log(`${C.bold}━━━ Journal Stats ━━━${C.reset}`);
  console.log('');
  console.log(`  Total trades       ${closed.length}  (${C.green}${wins.length}W${C.reset} / ${C.red}${losses.length}L${C.reset})`);
  console.log(`  Win rate           ${fmtPct(winRate)}`);
  console.log(`  Avg win            ${C.green}${fmtR(avgWinR)}${C.reset}`);
  console.log(`  Avg loss           ${C.red}${fmtR(avgLossR)}${C.reset}`);
  console.log(`  Expectancy         ${colorize(fmtR(expectancy), expectancy)} per trade`);
  console.log(`  Profit factor      ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
  console.log(`  Total P&L          ${colorize(fmt$(totalPnl), totalPnl)}`);
  console.log(`  Max win streak     ${maxWinStreak}`);
  console.log(`  Max loss streak    ${maxLossStreak}`);

  // Per-setup breakdown
  console.log('');
  console.log(`${C.bold}By setup:${C.reset}`);
  const setups = new Map();
  for (const t of closed) {
    const k = t.setup || '?';
    if (!setups.has(k)) setups.set(k, { wins:0, losses:0, pnl:0, count:0, sumR:0 });
    const s = setups.get(k);
    s.count++;
    s.pnl += t.outcome.pnl || 0;
    s.sumR += t.outcome.rMult || 0;
    if (t.outcome.status === 'won')  s.wins++;
    if (t.outcome.status === 'lost') s.losses++;
  }
  for (const [name, s] of setups) {
    const wr = s.count ? s.wins / s.count : 0;
    const exp = s.sumR / s.count;
    console.log(`  ${name.padEnd(30)} ${s.count.toString().padStart(3)} trades  WR ${(wr*100).toFixed(1).padStart(5)}%  exp ${colorize(fmtR(exp), exp).padStart(20)}  ${colorize(fmt$(s.pnl).padStart(10), s.pnl)}`);
  }

  // Plan adherence
  console.log('');
  console.log(`${C.bold}Plan adherence:${C.reset}`);
  let sizeDeviations = 0, stopDeviations = 0;
  const taken = trades.filter(t => t.executed.taken && t.plan.size && t.executed.actualSize);
  for (const t of taken) {
    if (Math.abs(t.executed.actualSize - t.plan.size) / t.plan.size > 0.10) sizeDeviations++;
    const planStop = t.plan.stop;
    const actStop  = t.executed.actualStop ?? planStop;
    if (planStop && Math.abs(actStop - planStop) / Math.abs(t.plan.entry - planStop) > 0.20) stopDeviations++;
  }
  console.log(`  Trades taken       ${taken.length} / ${trades.length} planned (${(taken.length / Math.max(1, trades.length) * 100).toFixed(0)}%)`);
  console.log(`  Size deviations    ${sizeDeviations}  (>10% off plan)`);
  console.log(`  Stop deviations    ${stopDeviations}  (>20% off plan)`);
}

async function cmdMonitor() {
  const open = loadJournal().filter(t => t.outcome.status === 'open');
  if (!open.length) { console.log('_(no open positions to monitor)_'); return; }

  const chart = await import('../src/core/chart.js');
  const data  = await import('../src/core/data.js');
  const { disconnect } = await import('../src/connection.js');

  console.log(`${C.bold}━━━ Live monitor — ${open.length} open position${open.length === 1 ? '' : 's'} ━━━${C.reset}`);

  for (const t of open) {
    try {
      // Switch chart to position symbol
      await chart.setSymbol({ symbol: t.symbol });
      await new Promise(r => setTimeout(r, 1500));
      const q = await data.getQuote();
      const price = q?.last ?? q?.close;
      if (!Number.isFinite(price)) { console.log(`  ${t.symbol}: could not fetch quote`); continue; }

      const entry = t.executed.actualEntry;
      const stop  = t.executed.actualStop ?? t.plan.stop;
      const tgt   = t.executed.actualTarget ?? t.plan.t1;
      const size  = t.executed.actualSize;
      const dir   = t.direction === 'LONG' ? 1 : -1;
      const move  = (price - entry) * dir;
      const pnl   = move * size;
      const initR = Math.abs(entry - stop);
      const rMult = initR ? ((price - entry) * dir) / initR : 0;
      const stopHit   = (dir === 1 && price <= stop) || (dir === -1 && price >= stop);
      const tgtHit    = tgt && ((dir === 1 && price >= tgt) || (dir === -1 && price <= tgt));

      const flag = stopHit ? `${C.red}⛔ STOP HIT${C.reset}` : tgtHit ? `${C.green}🎯 TARGET HIT${C.reset}` : '';
      console.log('');
      console.log(`  ${C.bold}${t.symbol}${C.reset} ${t.direction === 'LONG' ? C.green+'LONG'+C.reset : C.red+'SHORT'+C.reset}  (id ${t.id.slice(0,8)})`);
      console.log(`    Entry: ${fmtPx(entry)}  →  Now: ${fmtPx(price)}  (Stop ${fmtPx(stop)}, T1 ${fmtPx(tgt)})`);
      console.log(`    P&L:   ${colorize(fmt$(pnl), pnl)}  (${colorize(fmtR(rMult), rMult)})  ${flag}`);
    } catch (e) {
      console.log(`  ${t.symbol}: error — ${e.message}`);
    }
  }
  await disconnect().catch(() => {});
}

// ─── CLI dispatch ────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const [cmd, ...args] = process.argv.slice(2);
    try {
      switch (cmd) {
        case 'list':    cmdList(Number(args[0]) || 20); break;
        case 'open':    cmdOpen(); break;
        case 'taken':   cmdTaken(args[0], args[1], args[2]); break;
        case 'close':   cmdClose(args[0], args[1], args[2]); break;
        case 'cancel':  cmdCancel(args[0]); break;
        case 'stats':   cmdStats(); break;
        case 'monitor': await cmdMonitor(); break;
        default:
          console.log(`Usage:
  node bot/journal.js list [N]                          show recent N trades (default 20)
  node bot/journal.js open                              list open positions
  node bot/journal.js taken <id> [entry] [size]         mark a planned trade as taken
  node bot/journal.js close <id> <exitPrice> <reason>   close an open position
  node bot/journal.js cancel <id>                       cancel a planned trade
  node bot/journal.js stats                             performance breakdown
  node bot/journal.js monitor                           live unrealized P&L per open position`);
      }
    } catch (e) {
      console.error('✗', e.message);
      process.exit(1);
    }
  })();
}
