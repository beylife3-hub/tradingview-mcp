#!/usr/bin/env node
/**
 * Daily Summary — End-of-day recap to Telegram.
 *
 * Pulls today's trades from the journal, computes stats, sends a clean
 * digest message. Best run at 16:05 ET via cron, or manually.
 *
 * Content:
 *   - Trades taken / planned / skipped
 *   - P&L vs daily limit
 *   - Win rate
 *   - Best/worst trade
 *   - One rotated lesson
 *
 * CLI:
 *   node bot/daily-summary.js                       send to Telegram
 *   node bot/daily-summary.js --print               print to terminal only
 *   node bot/daily-summary.js --date 2025-04-30     summary for specific date
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, isEnabled } from './notify.js';
import { COMMON_MISTAKES, CONCEPTS } from './education.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');

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

const args = parseArgs(process.argv.slice(2));
const PRINT_ONLY = '--print' in args;
const DATE_FILTER = args['--date'] ?? null;

function loadJournal() {
  try { if (!existsSync(JOURNAL_PATH)) return []; return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); }
  catch { return []; }
}

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23,59,59,999); return x; }

function fmtR(n) { return n == null ? '?' : (n >= 0 ? '+' : '') + n.toFixed(2) + 'R'; }
function fmt$(n) { return n == null ? '?' : (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2); }
function pct(n)  { return n == null ? '?' : (n * 100).toFixed(1) + '%'; }

async function main() {
  const targetDate = DATE_FILTER ? new Date(DATE_FILTER) : new Date();
  const dayStart = +startOfDay(targetDate);
  const dayEnd   = +endOfDay(targetDate);

  const all = loadJournal();
  const today = all.filter(t => {
    const ts = +new Date(t.outcome?.closedAt ?? t.createdAt);
    return ts >= dayStart && ts <= dayEnd;
  });

  const planned   = today.filter(t => t.outcome?.status === 'planned' || t.outcome?.status === 'cancelled');
  const taken     = today.filter(t => t.executed?.taken);
  const closed    = today.filter(t => ['won','lost','breakeven'].includes(t.outcome?.status));
  const wins      = closed.filter(t => t.outcome.status === 'won');
  const losses    = closed.filter(t => t.outcome.status === 'lost');
  const totalPnl  = closed.reduce((s, t) => s + (t.outcome.pnl ?? 0), 0);
  const winRate   = closed.length ? wins.length / closed.length : 0;
  const sumR      = closed.reduce((s, t) => s + (t.outcome.rMult ?? 0), 0);
  const avgR      = closed.length ? sumR / closed.length : 0;

  const best  = closed.slice().sort((a,b) => (b.outcome.pnl ?? 0) - (a.outcome.pnl ?? 0))[0];
  const worst = closed.slice().sort((a,b) => (a.outcome.pnl ?? 0) - (b.outcome.pnl ?? 0))[0];

  // Per-setup breakdown
  const setups = new Map();
  for (const t of closed) {
    const k = t.setup || '?';
    if (!setups.has(k)) setups.set(k, { count: 0, wins: 0, pnl: 0 });
    const s = setups.get(k);
    s.count++;
    s.pnl += t.outcome.pnl ?? 0;
    if (t.outcome.status === 'won') s.wins++;
  }

  // Pick a rotated lesson
  const lessonIdx = targetDate.getDate() % COMMON_MISTAKES.generic.length;
  const lesson = COMMON_MISTAKES.generic[lessonIdx];

  // Build message
  const dateStr = targetDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const lines = [
    `🌅 *DAILY SUMMARY — ${dateStr}*`,
    '',
    `Plans fired:   ${today.length}`,
    `Taken:         ${taken.length}`,
    `Cancelled:     ${planned.filter(t => t.outcome?.status === 'cancelled').length}`,
    `Closed:        ${closed.length}  (${wins.length}W / ${losses.length}L)`,
    '',
    `Win rate:      ${pct(winRate)}`,
    `Avg R-mult:    \`${fmtR(avgR)}\``,
    `Total P&L:     \`${fmt$(totalPnl)}\``,
    '',
  ];
  if (best && best.outcome.pnl > 0) {
    lines.push(`🏆 *Best:*  ${best.symbol} ${best.direction} \`${fmt$(best.outcome.pnl)}\` (${fmtR(best.outcome.rMult)})`);
  }
  if (worst && worst.outcome.pnl < 0) {
    lines.push(`💔 *Worst:* ${worst.symbol} ${worst.direction} \`${fmt$(worst.outcome.pnl)}\` (${fmtR(worst.outcome.rMult)})`);
  }
  lines.push('');
  if (setups.size) {
    lines.push('*By setup:*');
    for (const [name, s] of setups) {
      lines.push(`  ${name} — ${s.count} trades, WR ${pct(s.wins/s.count)}, ${fmt$(s.pnl)}`);
    }
    lines.push('');
  }

  // Today's lesson
  lines.push(`📚 *Today's reminder:*`);
  lines.push(`_${lesson}_`);
  lines.push('');
  lines.push(`Tomorrow: walk in fresh, take only A+ setups, respect every stop.`);

  const msg = lines.join('\n');

  if (PRINT_ONLY || !isEnabled()) {
    console.log(msg);
  } else {
    const ok = await send(msg);
    console.log(ok ? '✓ Daily summary sent to Telegram' : '✗ Send failed');
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
