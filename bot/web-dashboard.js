#!/usr/bin/env node
/**
 * Live Web Dashboard — SSE-powered real-time updates.
 *
 * Beyond the static HTML dashboard: this server pushes new trades,
 * P&L updates, lock state changes, and bot health to the browser
 * over Server-Sent Events. Page auto-updates without refresh.
 *
 * Zero deps — pure Node http + SSE.
 *
 * Endpoints:
 *   GET /              — main dashboard HTML
 *   GET /events        — SSE stream of live updates
 *   GET /api/state     — JSON snapshot of current state
 *
 * Usage:
 *   node bot/web-dashboard.js                       port 8766 (different from static)
 *   PORT=4000 node bot/web-dashboard.js
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActivePosition } from './position-tracker.js';
import { checkProtections, getManualLock } from './protections.js';
import { getCachedVIX } from './vix-integration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, 'journal', 'trades.json');
const AUDIT_PATH   = join(__dirname, 'journal', 'audit-log.jsonl');
const PORT = Number(process.env.PORT ?? 8766);

// ─── State snapshot ──────────────────────────────────────────────────────────

function snapshot() {
  let trades = [];
  try { if (existsSync(JOURNAL_PATH)) trades = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); } catch {}

  const closed = trades.filter(t => ['won','lost','breakeven'].includes(t.outcome?.status));
  const wins   = closed.filter(t => t.outcome.status === 'won');
  const losses = closed.filter(t => t.outcome.status === 'lost');
  const open   = trades.filter(t => t.outcome?.status === 'open');
  const totalPnl = closed.reduce((s, t) => s + (t.outcome.pnl ?? 0), 0);

  let eq = 10000, peak = eq, maxDD = 0;
  const equity = [{ x: 'start', y: eq }];
  for (const t of closed.sort((a,b) => +new Date(a.outcome.closedAt) - +new Date(b.outcome.closedAt))) {
    eq += t.outcome.pnl ?? 0;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    equity.push({ x: t.outcome.closedAt, y: Number(eq.toFixed(2)) });
  }

  let auditCount = 0;
  try { if (existsSync(AUDIT_PATH)) auditCount = readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(Boolean).length; } catch {}

  return {
    timestamp: new Date().toISOString(),
    equity, equityCurrent: eq,
    trades: closed.length, wins: wins.length, losses: losses.length, openCount: open.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    totalPnl, maxDDPct: maxDD * 100, peak,
    activePosition: getActivePosition(),
    lock: checkProtections({ account: 10000 }),
    manualLock: getManualLock(),
    vix: getCachedVIX(),
    auditCount,
    recent: trades.slice(-20).reverse(),
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trading Bot — Live Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
body { font-family: -apple-system, sans-serif; margin:0; padding:24px; background:#0f1218; color:#e6e9ef; }
h1 { font-size:20px; margin-bottom:4px; }
.subtitle { color:#8a93a6; font-size:13px; margin-bottom:24px; }
.subtitle .live { color:#00d97e; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:16px; }
.card { background:#161b22; border:1px solid #2a313c; border-radius:8px; padding:14px; }
.card h2 { font-size:12px; margin:0 0 8px 0; color:#8a93a6; text-transform:uppercase; letter-spacing:0.5px; }
.stat { font-size:24px; font-weight:600; }
.stat-label { color:#8a93a6; font-size:11px; margin-top:2px; }
.green { color:#00d97e; } .red { color:#f44336; } .yellow { color:#ffb74d; } .blue { color:#4493f8; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #2a313c; }
th { color:#8a93a6; font-weight:500; font-size:10px; text-transform:uppercase; }
.pill { display:inline-block; padding:1px 7px; border-radius:4px; font-size:10px; font-weight:500; }
.pill-won { background:#00d97e22; color:#00d97e; } .pill-lost { background:#f4433622; color:#f44336; }
.pill-be { background:#ffb74d22; color:#ffb74d; } .pill-open { background:#4493f822; color:#4493f8; }
.banner { padding:10px 14px; border-radius:6px; margin-bottom:12px; font-size:13px; }
.banner.locked { background:#f4433622; color:#f44336; } .banner.open { background:#00d97e22; color:#00d97e; }
.banner.held { background:#4493f822; color:#4493f8; }
canvas { max-height:200px !important; }
#status { display:inline-block; width:8px; height:8px; border-radius:50%; background:#666; margin-right:6px; vertical-align:middle; }
#status.connected { background:#00d97e; box-shadow:0 0 6px #00d97e; }
</style>
</head>
<body>
<h1>📊 Trading Bot — Live Dashboard</h1>
<div class="subtitle"><span id="status"></span><span id="connState">connecting…</span> · last update <span id="lastUpdate">—</span></div>

<div id="banners"></div>

<div class="grid">
  <div class="card"><h2>Equity</h2><div class="stat" id="equityVal">$10,000</div><div class="stat-label">since start</div></div>
  <div class="card"><h2>Total P&L</h2><div class="stat" id="pnlVal">$0</div><div class="stat-label" id="pnlPct">+0.0%</div></div>
  <div class="card"><h2>Trades</h2><div class="stat" id="tradesVal">0</div><div class="stat-label" id="tradesBreakdown">0W / 0L</div></div>
  <div class="card"><h2>Win Rate</h2><div class="stat" id="wrVal">—</div><div class="stat-label">closed only</div></div>
  <div class="card"><h2>Max DD</h2><div class="stat red" id="ddVal">0%</div><div class="stat-label">peak to trough</div></div>
  <div class="card"><h2>VIX</h2><div class="stat" id="vixVal">—</div><div class="stat-label">5-min cache</div></div>
  <div class="card"><h2>Audit Log</h2><div class="stat blue" id="auditVal">0</div><div class="stat-label">decisions logged</div></div>
</div>

<div class="card" style="margin-bottom:16px;"><h2>Equity Curve</h2><canvas id="equity"></canvas></div>

<div class="card"><h2>Recent Trades</h2><table id="tradesTable"><thead><tr><th>Time</th><th>Symbol</th><th>Dir</th><th>Setup</th><th>Score</th><th>Status</th><th>R-mult</th><th>P&L</th></tr></thead><tbody></tbody></table></div>

<script>
const fmt$ = n => (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2);
const fmtPct = (n, d=1) => (n >= 0 ? '+' : '') + (n*100).toFixed(d) + '%';
let equityChart;

function updateUI(state) {
  document.getElementById('lastUpdate').textContent = new Date(state.timestamp).toLocaleTimeString();
  document.getElementById('equityVal').textContent = '$' + state.equityCurrent.toFixed(2);
  document.getElementById('equityVal').className = 'stat ' + (state.equityCurrent >= 10000 ? 'green' : 'red');
  document.getElementById('pnlVal').textContent = fmt$(state.totalPnl);
  document.getElementById('pnlVal').className = 'stat ' + (state.totalPnl >= 0 ? 'green' : 'red');
  document.getElementById('pnlPct').textContent = fmtPct(state.totalPnl / 10000);
  document.getElementById('tradesVal').textContent = state.trades;
  document.getElementById('tradesBreakdown').textContent = state.wins + 'W / ' + state.losses + 'L';
  document.getElementById('wrVal').textContent = state.trades ? (state.winRate*100).toFixed(1) + '%' : '—';
  document.getElementById('wrVal').className = 'stat ' + (state.winRate >= 0.5 ? 'green' : 'red');
  document.getElementById('ddVal').textContent = state.maxDDPct.toFixed(1) + '%';
  document.getElementById('vixVal').textContent = state.vix?.value ?? '—';
  document.getElementById('vixVal').className = 'stat ' + ((state.vix?.value ?? 0) >= 30 ? 'red' : (state.vix?.value ?? 0) >= 20 ? 'yellow' : 'green');
  document.getElementById('auditVal').textContent = state.auditCount;

  // Banners
  const banners = document.getElementById('banners');
  banners.innerHTML = '';
  if (state.activePosition) {
    const p = state.activePosition;
    banners.innerHTML += '<div class="banner held">🟢 POSITION HELD — ' + p.symbol + ' ' + p.direction + ' @ ' + p.entry + ' · stop ' + p.stop + ' · target ' + p.target + '</div>';
  }
  if (state.manualLock?.locked) {
    banners.innerHTML += '<div class="banner locked">🔒 MANUAL LOCK — ' + state.manualLock.reason + '</div>';
  } else if (state.lock?.locked && state.lock.kind !== 'manual') {
    banners.innerHTML += '<div class="banner locked">🔒 AUTO LOCK — ' + state.lock.reason + '</div>';
  }
  if (!state.activePosition && !state.manualLock?.locked && !(state.lock?.locked && state.lock.kind !== 'manual')) {
    banners.innerHTML = '<div class="banner open">✓ Trading open — bot scanning</div>';
  }

  // Equity chart
  if (equityChart) {
    equityChart.data.labels = state.equity.map(p => typeof p.x === 'string' && p.x.includes('T') ? new Date(p.x).toLocaleTimeString() : p.x);
    equityChart.data.datasets[0].data = state.equity.map(p => p.y);
    equityChart.update();
  }

  // Recent trades
  const tbody = document.querySelector('#tradesTable tbody');
  tbody.innerHTML = state.recent.map(t => {
    const status = t.outcome.status === 'won' ? 'pill pill-won' : t.outcome.status === 'lost' ? 'pill pill-lost' : t.outcome.status === 'breakeven' ? 'pill pill-be' : 'pill pill-open';
    return '<tr><td>' + new Date(t.outcome?.closedAt ?? t.createdAt).toLocaleTimeString() + '</td><td><b>' + t.symbol + '</b></td><td>' + t.direction + '</td><td>' + (t.setup||'—') + '</td><td>' + (t.score?.toFixed(1) ?? '—') + '</td><td><span class="' + status + '">' + t.outcome.status + '</span></td><td>' + (t.outcome.rMult != null ? (t.outcome.rMult >= 0 ? '+' : '') + t.outcome.rMult.toFixed(2) + 'R' : '—') + '</td><td class="' + ((t.outcome.pnl ?? 0) >= 0 ? 'green' : 'red') + '">' + (t.outcome.pnl != null ? fmt$(t.outcome.pnl) : '—') + '</td></tr>';
  }).join('');
}

function initChart() {
  equityChart = new Chart(document.getElementById('equity').getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Equity', data: [], borderColor: '#00d97e', backgroundColor: '#00d97e22', fill: true, tension: 0.2, pointRadius: 1 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#8a93a6' }, grid: { color: '#2a313c' } }, x: { ticks: { color: '#8a93a6', maxRotation: 0 }, grid: { color: '#2a313c' } } } },
  });
}

// SSE
const es = new EventSource('/events');
es.onopen = () => { document.getElementById('status').className = 'connected'; document.getElementById('connState').textContent = 'live'; };
es.onerror = () => { document.getElementById('status').className = ''; document.getElementById('connState').textContent = 'reconnecting…'; };
es.onmessage = e => { try { updateUI(JSON.parse(e.data)); } catch {} };

initChart();
fetch('/api/state').then(r => r.json()).then(updateUI);
</script>
</body>
</html>`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(state) {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHTML());
  } else if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
  } else if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✓ Live web dashboard: http://localhost:${PORT}/`);
  console.log(`  SSE events stream + auto-update on state changes`);
});

// Push state every 5 seconds AND watch journal mtime for instant push
let lastJournalMtime = 0;
setInterval(() => {
  try {
    const stat = statSync(JOURNAL_PATH);
    if (stat.mtimeMs !== lastJournalMtime) {
      lastJournalMtime = stat.mtimeMs;
      broadcast(snapshot());
    }
  } catch { /* journal may not exist */ }
}, 1000);

setInterval(() => broadcast(snapshot()), 5000);

process.on('SIGINT', () => { server.close(); process.exit(0); });
