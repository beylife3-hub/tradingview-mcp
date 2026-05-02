#!/usr/bin/env node
/**
 * HTML Dashboard — Single-file performance report.
 *
 * Generates bot/dashboard.html — a self-contained HTML page with
 * embedded Chart.js (CDN) showing equity curve, score distribution,
 * win rate by setup, and recent signals table.
 *
 * Usage:
 *   node bot/dashboard.js                       writes to bot/dashboard.html
 *   node bot/dashboard.js --open                also opens in default browser
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getActivePosition } from './position-tracker.js';
import { checkProtections, getManualLock } from './protections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');
const OUT_PATH     = join(__dirname, 'dashboard.html');

const args = process.argv.slice(2);
const SHOULD_OPEN = args.includes('--open');

function loadJournal() {
  try { if (!existsSync(JOURNAL_PATH)) return []; return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); }
  catch { return []; }
}

const trades = loadJournal();
const closed = trades.filter(t => ['won','lost','breakeven'].includes(t.outcome?.status));

// Compute equity curve
let eq = 10000;
const equityPoints = [{ x: 'start', y: eq }];
for (const t of closed) {
  eq += t.outcome.pnl ?? 0;
  equityPoints.push({ x: new Date(t.outcome.closedAt).toISOString(), y: Number(eq.toFixed(2)) });
}

// Stats
const wins   = closed.filter(t => t.outcome.status === 'won');
const losses = closed.filter(t => t.outcome.status === 'lost');
const winRate = closed.length ? (wins.length / closed.length * 100).toFixed(1) : '0.0';
const totalPnl = closed.reduce((s, t) => s + (t.outcome.pnl ?? 0), 0);

// Per-setup stats
const setupStats = new Map();
for (const t of closed) {
  const k = t.setup || '?';
  if (!setupStats.has(k)) setupStats.set(k, { count: 0, wins: 0, pnl: 0 });
  const s = setupStats.get(k);
  s.count++;
  s.pnl += t.outcome.pnl ?? 0;
  if (t.outcome.status === 'won') s.wins++;
}

// Score distribution (planned trades)
const scoreBuckets = new Array(11).fill(0);
for (const t of trades) {
  if (t.score != null) scoreBuckets[Math.min(10, Math.floor(t.score))]++;
}

// State
const activePos = getActivePosition();
const lock = checkProtections({ account: 10000 });
const manual = getManualLock();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TradingView Bot Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px; background: #0f1218; color: #e6e9ef; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #8a93a6; margin-bottom: 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: #161b22; border: 1px solid #2a313c; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px 0; color: #8a93a6; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat { font-size: 28px; font-weight: 600; }
  .stat-label { color: #8a93a6; font-size: 12px; margin-top: 4px; }
  .green { color: #00d97e; }
  .red { color: #f44336; }
  .yellow { color: #ffb74d; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a313c; }
  th { color: #8a93a6; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .pill-won  { background: #00d97e22; color: #00d97e; }
  .pill-lost { background: #f4433622; color: #f44336; }
  .pill-be   { background: #ffb74d22; color: #ffb74d; }
  .pill-open { background: #4493f822; color: #4493f8; }
  .lock-banner { background: #f4433622; color: #f44336; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
  .lock-banner.open { background: #00d97e22; color: #00d97e; }
  canvas { max-height: 240px !important; }
</style>
</head>
<body>
<h1>📊 TradingView Bot Dashboard</h1>
<div class="subtitle">Generated ${new Date().toLocaleString()}</div>

<div class="lock-banner ${(lock.locked || manual.locked) ? '' : 'open'}">
  ${manual.locked ? `🔒 MANUAL LOCK: ${manual.reason}`
    : lock.locked && lock.kind !== 'manual' ? `🔒 AUTO LOCK: ${lock.reason}`
    : '✓ Trading open — no protection locks active'}
</div>

${activePos ? `
<div class="card" style="margin-bottom:16px; border-color: #4493f8;">
  <h2>🟢 Active Position</h2>
  <div><strong>${activePos.symbol}</strong> ${activePos.direction} @ ${activePos.entry}</div>
  <div class="stat-label">Stop ${activePos.stop} · Target ${activePos.target} · Size ${activePos.size}</div>
</div>` : ''}

<div class="grid">
  <div class="card">
    <h2>Trades</h2>
    <div class="stat">${closed.length}</div>
    <div class="stat-label">${wins.length}W / ${losses.length}L</div>
  </div>
  <div class="card">
    <h2>Win Rate</h2>
    <div class="stat ${parseFloat(winRate) >= 50 ? 'green' : 'red'}">${winRate}%</div>
    <div class="stat-label">closed only</div>
  </div>
  <div class="card">
    <h2>Total P&L</h2>
    <div class="stat ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</div>
    <div class="stat-label">since first trade</div>
  </div>
  <div class="card">
    <h2>Equity</h2>
    <div class="stat ${eq >= 10000 ? 'green' : 'red'}">$${eq.toFixed(2)}</div>
    <div class="stat-label">starting $10,000</div>
  </div>
</div>

<div class="grid" style="margin-top:16px;">
  <div class="card" style="grid-column: span 2;">
    <h2>Equity Curve</h2>
    <canvas id="equity"></canvas>
  </div>
  <div class="card">
    <h2>Score Distribution</h2>
    <canvas id="scores"></canvas>
  </div>
</div>

<div class="card" style="margin-top:16px;">
  <h2>By Setup</h2>
  <table>
    <thead><tr><th>Setup</th><th>Trades</th><th>Win%</th><th>P&L</th></tr></thead>
    <tbody>
      ${[...setupStats].map(([name, s]) => `
        <tr>
          <td>${name}</td>
          <td>${s.count}</td>
          <td>${(s.wins/s.count*100).toFixed(0)}%</td>
          <td class="${s.pnl >= 0 ? 'green' : 'red'}">${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>

<div class="card" style="margin-top:16px;">
  <h2>Recent Trades (last 25)</h2>
  <table>
    <thead><tr><th>Time</th><th>Symbol</th><th>Dir</th><th>Setup</th><th>Score</th><th>Status</th><th>R-mult</th><th>P&L</th></tr></thead>
    <tbody>
      ${trades.slice(-25).reverse().map(t => `
        <tr>
          <td>${new Date(t.outcome?.closedAt ?? t.createdAt).toLocaleString()}</td>
          <td><strong>${t.symbol}</strong></td>
          <td>${t.direction}</td>
          <td>${t.setup || '—'}</td>
          <td>${t.score?.toFixed(1) ?? '—'}</td>
          <td><span class="pill pill-${t.outcome.status === 'won' ? 'won' : t.outcome.status === 'lost' ? 'lost' : t.outcome.status === 'breakeven' ? 'be' : 'open'}">${t.outcome.status}</span></td>
          <td>${t.outcome.rMult != null ? (t.outcome.rMult >= 0 ? '+' : '') + t.outcome.rMult.toFixed(2) + 'R' : '—'}</td>
          <td class="${(t.outcome.pnl ?? 0) >= 0 ? 'green' : 'red'}">${t.outcome.pnl != null ? (t.outcome.pnl >= 0 ? '+' : '') + '$' + t.outcome.pnl.toFixed(2) : '—'}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>

<script>
const equityData = ${JSON.stringify(equityPoints)};
const scoreData = ${JSON.stringify(scoreBuckets)};

new Chart(document.getElementById('equity').getContext('2d'), {
  type: 'line',
  data: {
    labels: equityData.map(p => typeof p.x === 'string' && p.x.includes('T') ? new Date(p.x).toLocaleTimeString() : p.x),
    datasets: [{
      label: 'Equity',
      data: equityData.map(p => p.y),
      borderColor: '#00d97e', backgroundColor: '#00d97e22',
      fill: true, tension: 0.2, pointRadius: 2,
    }],
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#8a93a6' }, grid: { color: '#2a313c' } }, x: { ticks: { color: '#8a93a6', maxRotation: 0 }, grid: { color: '#2a313c' } } } },
});

new Chart(document.getElementById('scores').getContext('2d'), {
  type: 'bar',
  data: {
    labels: ['0','1','2','3','4','5','6','7','8','9','10'],
    datasets: [{ label: 'Plans', data: scoreData, backgroundColor: scoreData.map((_, i) => i >= 7 ? '#00d97e' : i >= 5 ? '#ffb74d' : '#666') }],
  },
  options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#8a93a6' }, grid: { color: '#2a313c' } }, x: { ticks: { color: '#8a93a6' }, grid: { color: '#2a313c' } } } },
});
</script>
</body>
</html>`;

writeFileSync(OUT_PATH, html);
console.log(`✓ Dashboard written to ${OUT_PATH}`);

if (SHOULD_OPEN) {
  spawn('open', [OUT_PATH], { detached: true, stdio: 'ignore' }).unref();
  console.log('✓ Opened in browser');
}
