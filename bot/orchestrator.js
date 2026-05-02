#!/usr/bin/env node
/**
 * Orchestrator — single-command launcher for the entire bot stack.
 *
 * Starts everything in the right order with health checks between steps:
 *   1. TradingView Desktop (with CDP debug port 9222)
 *   2. Wait until CDP responds
 *   3. Start telegram-bot (2-way phone control)
 *   4. Start live-stream-coach (analysis + alerts + chart drawing)
 *   5. Start dashboard server (HTTP on 8765)
 *   6. Start health-monitor (watches everything)
 *
 * On Ctrl+C: gracefully stops every child process in reverse order.
 *
 * Usage:
 *   node bot/orchestrator.js                    start full stack
 *   node bot/orchestrator.js --no-tv            skip TV launch (already running)
 *   node bot/orchestrator.js --aggressive       use aggressive risk profile
 *   node bot/orchestrator.js --status           print process status (then exit)
 *   node bot/orchestrator.js --stop             kill everything (then exit)
 */

import { spawn, execSync } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, isEnabled } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

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
const NO_TV = '--no-tv' in args;
const STATUS_ONLY = '--status' in args;
const STOP_ALL    = '--stop' in args;
const PROFILE = '--conservative' in args ? '--conservative'
              : '--aggressive'   in args ? '--aggressive'
              : '--yolo'         in args ? '--yolo'
              : '--aggressive';   // sensible default for daily use
const RISK = args['--risk'] ?? '100';

const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' };

// ─── Process inventory ──────────────────────────────────────────────────────

const PROCESSES = [
  { name: 'live-stream-coach', pattern: 'node bot/live-stream', argv: ['bot/live-stream.js', '--live', '--live-poll', '2', '--draw', PROFILE, '--risk', RISK] },
  { name: 'telegram-bot',      pattern: 'node bot/telegram-bot', argv: ['bot/telegram-bot.js'] },
  { name: 'web-dashboard',     pattern: 'node bot/web-dashboard', argv: ['bot/web-dashboard.js'] },   // SSE live (Tier 7.8)
  { name: 'health-monitor',    pattern: 'node bot/health-monitor', argv: ['bot/health-monitor.js'] },
];

const childProcs = new Map();   // name → child process handle

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRunning(pattern) {
  try {
    const out = execSync(`ps aux | grep '${pattern}' | grep -v grep`, { stdio: ['pipe','pipe','pipe'] }).toString();
    return out.trim().split('\n').filter(Boolean).length > 0;
  } catch { return false; }
}

function getPids(pattern) {
  try {
    const out = execSync(`pgrep -f '${pattern}'`, { stdio: ['pipe','pipe','pipe'] }).toString();
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

async function checkCDP() {
  return new Promise(resolve => {
    const r = request('http://127.0.0.1:9222/json/version', { method: 'GET' }, res => {
      resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.setTimeout(2000, () => { r.destroy(); resolve(false); });
    r.end();
  });
}

async function waitForCDP(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkCDP()) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

function spawnChild(name, argv, env = process.env) {
  const child = spawn('node', argv, {
    cwd: repoRoot,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(`${C.dim}[${name}]${C.reset} ${d}`));
  child.stderr.on('data', d => process.stderr.write(`${C.dim}[${name}]${C.reset} ${d}`));
  child.on('exit', (code) => {
    console.log(`${C.yellow}[${name}] exited code ${code}${C.reset}`);
    childProcs.delete(name);
  });
  childProcs.set(name, child);
  return child;
}

function status() {
  console.log(`${C.cyan}━ Process Status ━${C.reset}`);
  for (const p of PROCESSES) {
    const pids = getPids(p.pattern);
    const mark = pids.length ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
    console.log(`  ${mark} ${p.name.padEnd(20)} ${pids.length ? 'PIDs ' + pids.join(',') : 'not running'}`);
  }
  console.log(`  ${C.dim}TradingView CDP:${C.reset} (check separately)`);
}

async function stopAll() {
  console.log(`${C.cyan}━ Stopping all bot processes ━${C.reset}`);
  for (const p of [...PROCESSES].reverse()) {
    const pids = getPids(p.pattern);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGINT'); console.log(`  ${C.yellow}→${C.reset} Sent SIGINT to ${p.name} (${pid})`); }
      catch { /* may already be dead */ }
    }
  }
  await new Promise(r => setTimeout(r, 2000));
  // Force-kill stragglers
  for (const p of PROCESSES) {
    const pids = getPids(p.pattern);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); console.log(`  ${C.red}✗${C.reset} Force-killed ${p.name} (${pid})`); }
      catch {}
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (STATUS_ONLY) { status(); return; }
  if (STOP_ALL) { await stopAll(); status(); return; }

  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}🚀 ORCHESTRATOR — starting full bot stack${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`Profile: ${PROFILE}  Risk per trade: $${RISK}\n`);

  // ─── Step 1: TradingView ──────────────────────────────────────────────────
  if (NO_TV) {
    console.log(`${C.dim}Step 1: skipping TV launch (--no-tv)${C.reset}`);
  } else {
    console.log(`${C.cyan}Step 1: Launching TradingView with CDP...${C.reset}`);
    if (await checkCDP()) {
      console.log(`  ${C.green}✓${C.reset} TradingView CDP already up`);
    } else {
      spawn('bash', ['scripts/launch_tv_debug_mac.sh'], {
        cwd: repoRoot, detached: true, stdio: 'ignore',
      }).unref();
      console.log(`  ${C.dim}Waiting for CDP...${C.reset}`);
      const ok = await waitForCDP(60_000);
      if (!ok) { console.error(`  ${C.red}✗ CDP did not come up in 60s${C.reset}`); process.exit(1); }
      console.log(`  ${C.green}✓${C.reset} TradingView CDP ready`);
    }
  }

  // ─── Step 2: telegram-bot ─────────────────────────────────────────────────
  console.log(`${C.cyan}Step 2: telegram-bot${C.reset}`);
  if (isRunning(PROCESSES[1].pattern)) {
    console.log(`  ${C.yellow}∎${C.reset} already running, skipping`);
  } else {
    spawnChild('telegram-bot', PROCESSES[1].argv);
    console.log(`  ${C.green}✓${C.reset} telegram-bot starting`);
    await new Promise(r => setTimeout(r, 1500));
  }

  // ─── Step 3: live-stream-coach ────────────────────────────────────────────
  console.log(`${C.cyan}Step 3: live-stream-coach${C.reset}`);
  if (isRunning(PROCESSES[0].pattern)) {
    console.log(`  ${C.yellow}∎${C.reset} already running, skipping`);
  } else {
    spawnChild('live-stream-coach', PROCESSES[0].argv);
    console.log(`  ${C.green}✓${C.reset} live-stream-coach starting`);
    await new Promise(r => setTimeout(r, 1500));
  }

  // ─── Step 4: web dashboard (SSE live) ─────────────────────────────────────
  console.log(`${C.cyan}Step 4: web-dashboard${C.reset}`);
  if (isRunning(PROCESSES[2].pattern)) {
    console.log(`  ${C.yellow}∎${C.reset} already running, skipping`);
  } else {
    spawnChild('web-dashboard', PROCESSES[2].argv);
    console.log(`  ${C.green}✓${C.reset} live web dashboard at http://localhost:8766/`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // ─── Step 5: health monitor ───────────────────────────────────────────────
  console.log(`${C.cyan}Step 5: health-monitor${C.reset}`);
  if (isRunning(PROCESSES[3].pattern)) {
    console.log(`  ${C.yellow}∎${C.reset} already running, skipping`);
  } else {
    spawnChild('health-monitor', PROCESSES[3].argv);
    console.log(`  ${C.green}✓${C.reset} health-monitor starting`);
  }

  console.log(`\n${C.green}━━ ALL SYSTEMS LIVE ━━${C.reset}`);
  console.log(`  Dashboard:        http://localhost:8765/`);
  console.log(`  Phone control:    /help in Telegram`);
  console.log(`  Stop everything:  Ctrl+C   OR   node bot/orchestrator.js --stop`);
  console.log('');

  if (isEnabled()) {
    await send(`🚀 *Bot stack started*\nProfile: ${PROFILE}\nRisk: $${RISK}\nDashboard: http://localhost:8765`).catch(() => {});
  }

  // Trap SIGINT — stop all children gracefully
  process.on('SIGINT', async () => {
    console.log(`\n${C.cyan}━ Stopping all child processes ━${C.reset}`);
    if (isEnabled()) await send('🛑 Bot stack stopped').catch(() => {});
    for (const [name, child] of childProcs) {
      try { child.kill('SIGINT'); console.log(`  ${C.yellow}→${C.reset} ${name}`); } catch {}
    }
    await new Promise(r => setTimeout(r, 2000));
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
