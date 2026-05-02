/**
 * Audit Log — hash-chained immutable decision log.
 *
 * Every analyze() decision (LONG/SHORT/WATCHLIST/NO TRADE) is appended
 * with SHA-256 hash of previous entry. Tampering with any past entry
 * breaks the chain — provable integrity.
 *
 * Use cases:
 *   - Post-mortem: "Why did the bot say NO TRADE at 14:32?"
 *   - Compliance: SOX-style decision trail
 *   - Debugging: trace adaptive weights changing decisions over time
 *   - Performance attribution: which factors drove each call
 *
 * Storage: bot/journal/audit-log.jsonl (append-only)
 */

import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, 'journal', 'audit-log.jsonl');

function sha256(s) { return createHash('sha256').update(String(s)).digest('hex'); }

/**
 * Append a decision to the audit log.
 *
 * @param {object} entry - { decision, score, symbol, tf, setup?, reasons?, factors?, ... }
 */
export function logDecision(entry) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });

  // Get previous entry's hash
  let prevHash = '0000';
  if (existsSync(LOG_PATH)) {
    try {
      const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        prevHash = last.hash;
      }
    } catch { /* corrupt file, restart chain */ }
  }

  const record = {
    timestamp: new Date().toISOString(),
    seq: existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean).length + 1 : 1,
    decision:  entry.decision,
    score:     entry.score,
    symbol:    entry.symbol,
    tf:        entry.tf,
    setup:     entry.setup ?? null,
    direction: entry.direction ?? null,
    bias:      entry.bias ?? null,
    regime:    entry.regime ?? null,
    factors:   entry.factors ?? [],
    reasons:   entry.reasons ?? [],
    htfBias:   entry.htfBias ?? null,
    adaptiveMult: entry.adaptiveMult ?? null,
    prevHash,
    // Hash includes everything ABOVE this line for tamper-evidence
    hash: '',
  };
  // Compute hash of canonical JSON (excluding the hash field itself)
  const { hash, ...payload } = record;
  record.hash = sha256(JSON.stringify(payload));

  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
  return record.hash;
}

/**
 * Verify the chain — recompute every hash and compare.
 *
 * Returns: { valid, brokenAt, totalEntries }
 */
export function verifyChain() {
  if (!existsSync(LOG_PATH)) return { valid: true, brokenAt: null, totalEntries: 0 };
  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  let prevHash = '0000';
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: `prevHash mismatch at seq ${entry.seq}`, totalEntries: lines.length };
    }
    const { hash, ...payload } = entry;
    const expected = sha256(JSON.stringify(payload));
    if (hash !== expected) {
      return { valid: false, brokenAt: i, reason: `hash mismatch at seq ${entry.seq}`, totalEntries: lines.length };
    }
    prevHash = hash;
  }
  return { valid: true, brokenAt: null, totalEntries: lines.length };
}

/**
 * Read the last N entries (most recent first).
 */
export function readRecent(n = 20) {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).reverse().map(l => JSON.parse(l));
}

/**
 * Filter entries by decision type, symbol, or date range.
 */
export function filter({ decision, symbol, sinceISO } = {}) {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => JSON.parse(l))
    .filter(e => !decision || e.decision === decision)
    .filter(e => !symbol || e.symbol === symbol)
    .filter(e => !sinceISO || e.timestamp >= sinceISO);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'verify') {
    const r = verifyChain();
    console.log(r.valid
      ? `✓ Chain intact — ${r.totalEntries} entries, all hashes verified`
      : `✗ Chain broken at entry ${r.brokenAt}: ${r.reason}`);
  } else if (cmd === 'recent') {
    const n = Number(process.argv[3] ?? 10);
    const entries = readRecent(n);
    if (!entries.length) { console.log('(audit log empty)'); process.exit(0); }
    console.log(`Last ${entries.length} decisions (most recent first):\n`);
    for (const e of entries) {
      const ts = new Date(e.timestamp).toLocaleString();
      const decIcon = e.decision === 'LONG' ? '🟢' : e.decision === 'SHORT' ? '🔴' : e.decision === 'WATCHLIST ONLY' ? '🟡' : '⚪';
      console.log(`  #${e.seq.toString().padStart(4)}  ${ts}  ${decIcon} ${e.decision.padEnd(15)} ${(e.symbol || '?').padEnd(20)} ${e.tf || ''}m  score ${e.score ?? '?'}  hash ${e.hash.slice(0,8)}`);
    }
  } else if (cmd === 'stats') {
    if (!existsSync(LOG_PATH)) { console.log('(audit log empty)'); process.exit(0); }
    const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l));
    const counts = {};
    for (const e of entries) counts[e.decision] = (counts[e.decision] || 0) + 1;
    console.log(`Total decisions: ${entries.length}\n`);
    for (const [d, c] of Object.entries(counts).sort((a,b) => b[1] - a[1])) {
      console.log(`  ${d.padEnd(20)} ${c.toString().padStart(6)} (${(c/entries.length*100).toFixed(1)}%)`);
    }
  } else {
    console.log('Usage:');
    console.log('  node bot/audit-log.js verify           verify hash chain');
    console.log('  node bot/audit-log.js recent [N]       show last N decisions');
    console.log('  node bot/audit-log.js stats            decision counts by type');
  }
}
