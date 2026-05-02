/**
 * Position Tracker — single source of truth for "am I in a trade right now?"
 *
 * Without this, the bot has no idea when YOU've already entered, so it keeps
 * yelling "BUY HERE" every 30 seconds. With this:
 *   - /entered SYM DIR ENTRY [STOP] [TARGET] [SIZE]   — declare position
 *   - /exited                                          — clear position
 *   - bot routes to "POSITION HELD" mode while held (no new BUY HERE labels)
 *   - alerts on approaching stop / hitting target / breakeven trigger
 *
 * Storage: bot/journal/active-position.json (single object or null)
 *
 * Symbol matching is normalized — "BATS:TSLA" matches "TSLA" — so you can
 * declare without the exchange prefix.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSITION_PATH = join(__dirname, 'journal', 'active-position.json');

// ─── State persistence ────────────────────────────────────────────────────────

function load() {
  try {
    if (!existsSync(POSITION_PATH)) return null;
    const obj = JSON.parse(readFileSync(POSITION_PATH, 'utf-8'));
    return obj?.position ?? null;
  } catch { return null; }
}

function save(position) {
  mkdirSync(dirname(POSITION_PATH), { recursive: true });
  writeFileSync(POSITION_PATH, JSON.stringify({ position }, null, 2));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the active position object or null if flat. */
export function getActivePosition() {
  return load();
}

/**
 * Returns the active position only if it matches the given symbol.
 * Normalizes — "BATS:TSLA" matches "TSLA", "BINANCE:BTCUSDT.P" matches "BTCUSDT.P", etc.
 */
export function getActivePositionFor(symbol) {
  const p = load();
  if (!p) return null;
  const norm = (s) => String(s).split(':').pop().toUpperCase();
  return norm(p.symbol) === norm(symbol) ? p : null;
}

/**
 * Set the active position.
 * @param {object} pos - { symbol, direction: 'LONG'|'SHORT', entry, stop?, target?, size?, notes? }
 */
export function setActivePosition(pos) {
  if (!pos.symbol || !pos.direction || pos.entry == null) {
    throw new Error('symbol, direction, and entry are required');
  }
  const dir = pos.direction.toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') throw new Error('direction must be LONG or SHORT');
  const enriched = {
    symbol:    pos.symbol,
    direction: dir,
    entry:     Number(pos.entry),
    stop:      pos.stop   != null ? Number(pos.stop)   : null,
    target:    pos.target != null ? Number(pos.target) : null,
    size:      pos.size   != null ? Number(pos.size)   : null,
    openedAt:  pos.openedAt || new Date().toISOString(),
    notes:     pos.notes || '',
  };
  save(enriched);
  return enriched;
}

/** Clear the active position (you've closed it). Returns the cleared position or null. */
export function clearActivePosition() {
  const prev = load();
  save(null);
  return prev;
}

// ─── P&L computation ─────────────────────────────────────────────────────────

/**
 * Given a current price, compute live P&L data for an active position.
 *
 * Returns:
 *   { pnl$, pnlPct, rMult,
 *     distanceToStopPct, distanceToTargetPct,
 *     status, ageMinutes }
 *
 * status values:
 *   open | inProfit | inLoss | nearStop | nearTarget | stopHit | targetHit
 */
export function computePositionPnL(pos, currentPrice) {
  if (!pos) return null;
  const dir = pos.direction === 'LONG' ? 1 : -1;
  const move = (currentPrice - pos.entry) * dir;
  const pnlPct = move / pos.entry;
  const pnl$   = pos.size != null ? move * pos.size : null;

  let rMult = null;
  let distanceToStopPct = null;
  let distanceToTargetPct = null;
  let status = move > 0 ? 'inProfit' : move < 0 ? 'inLoss' : 'open';

  if (pos.stop != null) {
    const initialRisk = Math.abs(pos.entry - pos.stop);
    rMult = initialRisk > 0 ? move / initialRisk : 0;
    distanceToStopPct = ((currentPrice - pos.stop) * dir) / pos.entry;
    if (dir === 1) {
      if (currentPrice <= pos.stop)         status = 'stopHit';
      else if (distanceToStopPct < 0.002)   status = 'nearStop';
    } else {
      if (currentPrice >= pos.stop)         status = 'stopHit';
      else if (distanceToStopPct < 0.002)   status = 'nearStop';
    }
  }

  if (pos.target != null) {
    distanceToTargetPct = ((pos.target - currentPrice) * dir) / pos.entry;
    if (dir === 1) {
      if (currentPrice >= pos.target)             status = 'targetHit';
      else if (distanceToTargetPct < 0.002)       status = 'nearTarget';
    } else {
      if (currentPrice <= pos.target)             status = 'targetHit';
      else if (distanceToTargetPct < 0.002)       status = 'nearTarget';
    }
  }

  return {
    pnl$, pnlPct, rMult,
    distanceToStopPct, distanceToTargetPct,
    status,
    ageMinutes: pos.openedAt ? (Date.now() - +new Date(pos.openedAt)) / 60_000 : 0,
  };
}

// ─── CLI for inspection ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];

  if (cmd === 'set') {
    // node bot/position-tracker.js set TSLA long 175.50 174.00 178.00 100
    const [, , , symbol, direction, entry, stop, target, size] = process.argv;
    const pos = setActivePosition({ symbol, direction, entry, stop, target, size });
    console.log('✓ Active position set:');
    console.log(JSON.stringify(pos, null, 2));
  } else if (cmd === 'clear') {
    const prev = clearActivePosition();
    console.log(prev ? `✓ Cleared ${prev.symbol} ${prev.direction} @ ${prev.entry}` : 'Already flat.');
  } else if (cmd === 'pnl') {
    // node bot/position-tracker.js pnl 211.50 (current price)
    const p = getActivePosition();
    if (!p) { console.log('Flat.'); process.exit(0); }
    const price = Number(process.argv[3]);
    if (!Number.isFinite(price)) { console.error('Provide current price'); process.exit(1); }
    const pnl = computePositionPnL(p, price);
    console.log('Position:', p.symbol, p.direction, 'entry', p.entry, 'now', price);
    console.log('P&L:', JSON.stringify(pnl, null, 2));
  } else {
    const p = getActivePosition();
    console.log(p ? 'Active position:\n' + JSON.stringify(p, null, 2) : 'Flat (no active position).');
    console.log('\nUsage:');
    console.log('  node bot/position-tracker.js                        show current');
    console.log('  node bot/position-tracker.js set SYM DIR ENTRY [STOP] [TGT] [SIZE]');
    console.log('  node bot/position-tracker.js clear                  go flat');
    console.log('  node bot/position-tracker.js pnl <currentPrice>     compute P&L');
  }
}
