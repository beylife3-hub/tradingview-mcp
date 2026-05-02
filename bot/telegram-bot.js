#!/usr/bin/env node
/**
 * Telegram Remote Control Bot
 * ───────────────────────────
 * Two-way Telegram interface — commands flow from your phone back to the bot.
 * Pioneered by Freqtrade as the must-have feature for any live trading system.
 * Eliminates the "I'm in a meeting and the bot is hemorrhaging" failure mode.
 *
 * Long-polls Telegram getUpdates and dispatches /commands.
 *
 * Available commands:
 *   /help                                          show command menu
 *   /status                                        current chart + open positions + daily P&L
 *   /scan                                          run a fresh coach analysis NOW
 *   /stats                                         journal stats
 *   /equity                                        equity curve summary
 *   /protections                                   safety circuit breaker state
 *   /open                                          list journaled open positions
 *   /close <id>                                    cancel a journaled open position
 *   /entered SYM DIR ENTRY [STOP] [TGT] [SIZE]     declare a position (position-tracker)
 *   /exited                                        clear position-tracker
 *   /position                                      show current position-tracker state with live P&L
 *   /pause [hours]                                 pause trading; default 4h
 *   /resume                                        clear manual lock
 *
 * Usage:
 *   node bot/telegram-bot.js                       long-poll forever
 *   node bot/telegram-bot.js --once                process pending then exit
 *   node bot/telegram-bot.js --verbose             log all received messages
 */

import { request } from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { send } from './notify.js';
import {
  checkProtections, setManualLock, clearManualLock, getManualLock,
  lowExpectancySetupBan,
} from './protections.js';
import {
  getActivePosition, setActivePosition, clearActivePosition, computePositionPnL,
} from './position-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID  ?? '';
const STATE_FN  = join(__dirname, 'journal', 'telegram-state.json');
const JRN_FN    = join(__dirname, 'journal', 'trades.json');

// Token check is deferred to main() so that this module can be imported
// without exiting on missing env vars (e.g., for testing dispatcher logic).
function requireTokens() {
  if (!TOKEN || !CHAT_ID) {
    console.error('✗ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.');
    console.error('  Run: node bot/setup-telegram.js');
    process.exit(1);
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FN, 'utf-8')); }
  catch { return { last_update_id: 0 }; }
}
function saveState(s) {
  mkdirSync(dirname(STATE_FN), { recursive: true });
  writeFileSync(STATE_FN, JSON.stringify(s, null, 2));
}
function loadJournal() {
  try { return JSON.parse(readFileSync(JRN_FN, 'utf-8')); }
  catch { return []; }
}

// ─── Telegram API ────────────────────────────────────────────────────────────

function tgGet(method, query = {}) {
  const qs = new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const r = request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}${qs ? '?' + qs : ''}`,
      method:   'GET',
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
    });
    r.on('error', reject);
    r.setTimeout(60_000, () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n, d = 2)  { return n == null ? '?' : Number(n).toFixed(d); }
function pct(n)         { return n == null ? '?' : (n * 100).toFixed(2) + '%'; }
function money(n)       { if (n == null) return '?'; const s = n >= 0 ? '+' : ''; return `${s}$${Math.abs(n).toFixed(2)}`; }
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function totalPnl(trades) { return trades.reduce((s, t) => s + (t.outcome?.pnl ?? 0), 0); }

// ─── Command handlers ────────────────────────────────────────────────────────

const handlers = {

  async help() {
    return [
      '🤖 *TradingView Bot — Commands*',
      '',
      '*Position tracker* (so bot knows you\'re in a trade)',
      '`/entered SYM DIR ENTRY [STOP] [TGT] [SIZE]`',
      '`/exited`     clear position',
      '`/position`   live P&L on current position',
      '',
      '*Bot control*',
      '`/status`        current chart + open positions + P&L',
      '`/scan`          fresh analysis NOW',
      '`/stats`         journal stats (WR, expectancy, PF)',
      '`/equity`        equity curve summary',
      '`/protections`   circuit breakers state',
      '`/open`          journaled open positions',
      '`/close <id>`    cancel a journaled open',
      '`/pause [hrs]`   pause trading (default 4h)',
      '`/resume`        unpause',
      '`/help`          this menu',
    ].join('\n');
  },

  async status() {
    const trades = loadJournal();
    const open   = trades.filter(t => t.outcome?.status === 'open');
    const today  = trades.filter(t => +new Date(t.outcome?.closedAt ?? t.createdAt) >= +startOfDay()
                                  && t.outcome?.pnl != null);
    const dailyPnl = totalPnl(today);
    const lock = getManualLock();
    const auto = checkProtections({ account: 10000 });
    const activePos = getActivePosition();

    const lines = ['📊 *STATUS*', ''];
    lines.push(`Tracked position: ${activePos ? `${activePos.symbol} ${activePos.direction} @ ${activePos.entry}` : '_(flat)_'}`);
    lines.push(`Journaled open:   ${open.length}`);
    if (open.length) {
      for (const o of open.slice(0, 3)) {
        lines.push(`  • ${o.symbol} ${o.direction} @ ${fmt(o.executed?.actualEntry ?? o.plan?.entry, 4)} (${o.id.slice(0, 8)})`);
      }
    }
    lines.push('');
    lines.push(`Today:           ${today.length} trades · P&L \`${money(dailyPnl)}\``);
    lines.push(`Manual lock:     ${lock.locked ? '🔒 ' + lock.reason : '✓ open'}`);
    lines.push(`Auto protect:    ${auto.locked && auto.kind !== 'manual' ? '🔒 ' + auto.reason : '✓ all clear'}`);
    return lines.join('\n');
  },

  async scan() {
    return new Promise(resolve => {
      const p = spawn('node', ['bot/live-stream.js', '--once'], {
        cwd: join(__dirname, '..'),
        env: process.env,
        stdio: 'pipe',
      });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.stderr.on('data', d => out += d.toString());
      p.on('close', () => {
        if (out.toLowerCase().includes('sent to telegram')) {
          resolve('🔍 Fresh scan sent — see message above ⬆️');
        } else if (out.toLowerCase().includes('locked')) {
          resolve('🔒 Scan blocked — protection lock active. See above for details.');
        } else if (out.toLowerCase().includes('held')) {
          resolve('🟢 Position held — see P&L update above.');
        } else {
          resolve(`⚠ Scan errored. Output:\n\`\`\`\n${out.slice(-300)}\n\`\`\``);
        }
      });
    });
  },

  async stats() {
    const all = loadJournal().filter(t => ['won','lost','breakeven'].includes(t.outcome?.status));
    if (!all.length) return '_(no closed trades yet)_';
    const wins   = all.filter(t => t.outcome.status === 'won');
    const losses = all.filter(t => t.outcome.status === 'lost');
    const totalP = totalPnl(all);
    const winRate = wins.length / all.length;
    const avgWinR  = wins.length   ? wins.reduce((s,t)   => s + (t.outcome.rMult || 0), 0) / wins.length   : 0;
    const avgLossR = losses.length ? losses.reduce((s,t) => s + (t.outcome.rMult || 0), 0) / losses.length : 0;
    const expectancy = winRate * avgWinR + (1 - winRate) * avgLossR;
    const grossWin  = wins.reduce((s,t)   => s + (t.outcome.pnl || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s,t) => s + (t.outcome.pnl || 0), 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

    return [
      '📈 *JOURNAL STATS*',
      '',
      `Trades:        ${all.length}  (${wins.length}W / ${losses.length}L)`,
      `Win rate:      ${pct(winRate)}`,
      `Avg win:       \`${fmt(avgWinR, 2)}R\``,
      `Avg loss:      \`${fmt(avgLossR, 2)}R\``,
      `Expectancy:    \`${fmt(expectancy, 2)}R per trade\``,
      `Profit factor: \`${pf === Infinity ? '∞' : fmt(pf, 2)}\``,
      `Total P&L:     \`${money(totalP)}\``,
    ].join('\n');
  },

  async equity() {
    const all = loadJournal()
      .filter(t => t.outcome?.pnl != null)
      .sort((a, b) => +new Date(a.outcome.closedAt) - +new Date(b.outcome.closedAt));
    if (!all.length) return '_(no closed trades yet)_';
    let eq = 10000, peak = eq, maxDD = 0;
    for (const t of all) {
      eq += t.outcome.pnl;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
    }
    return [
      '💹 *EQUITY*',
      '',
      'Starting:    $10,000',
      `Current:     \`$${fmt(eq)}\``,
      `P&L:         \`${money(eq - 10000)}\` (${pct((eq - 10000) / 10000)})`,
      `Peak:        \`$${fmt(peak)}\``,
      `Max DD:      ${pct(maxDD)}`,
      `Trades:      ${all.length}`,
    ].join('\n');
  },

  async protections() {
    const lock = getManualLock();
    const auto = checkProtections({ account: 10000 });
    const allSetups = new Set(loadJournal().map(t => t.setup).filter(Boolean));
    const setupBans = [];
    for (const s of allSetups) {
      const r = lowExpectancySetupBan(s);
      if (r.locked) setupBans.push(`🚫 ${s}: ${r.reason}`);
    }
    const lines = ['🛡 *PROTECTIONS*', ''];
    lines.push(`Manual:    ${lock.locked ? '🔒 ' + lock.reason : '✓ open'}`);
    if (lock.until) lines.push(`           until ${new Date(lock.until).toLocaleString()}`);
    lines.push(`Auto:      ${auto.locked && auto.kind !== 'manual' ? '🔒 ' + auto.reason : '✓ all clear'}`);
    if (auto.until && auto.kind !== 'manual') lines.push(`           until ${new Date(auto.until).toLocaleString()}`);
    if (setupBans.length) {
      lines.push('', '*Banned setups (negative expectancy):*');
      for (const b of setupBans) lines.push(b);
    }
    return lines.join('\n');
  },

  async open() {
    const open = loadJournal().filter(t => t.outcome?.status === 'open');
    if (!open.length) return '_(no journaled open positions)_';
    const lines = ['📂 *JOURNALED OPEN POSITIONS*', ''];
    for (const t of open) {
      const ent = t.executed?.actualEntry ?? t.plan?.entry;
      lines.push(`*${t.symbol}* ${t.direction}  \`${t.id.slice(0, 8)}\``);
      lines.push(`  Entry \`${fmt(ent, 4)}\`  Stop \`${fmt(t.executed?.actualStop ?? t.plan?.stop, 4)}\``);
      lines.push(`  Setup: ${t.setup}`);
      lines.push('');
    }
    lines.push('_To close: `/close <id-prefix>`_');
    return lines.join('\n');
  },

  async close(arg) {
    if (!arg) return '⚠ Usage: `/close <id-prefix>` (first 8 chars of trade ID)';
    const journal = loadJournal();
    const idx = journal.findIndex(t => t.id.startsWith(arg) && t.outcome?.status === 'open');
    if (idx < 0) return `⚠ No open trade matching \`${arg}\`. Try /open to list.`;
    const trade = journal[idx];
    trade.outcome.status   = 'cancelled';
    trade.outcome.reason   = 'closed via Telegram /close';
    trade.outcome.closedAt = new Date().toISOString();
    journal[idx] = trade;
    writeFileSync(JRN_FN, JSON.stringify(journal, null, 2));
    return `✅ Cancelled \`${trade.symbol}\` ${trade.direction} (${arg}). Now close it on your broker too.`;
  },

  async entered(arg) {
    if (!arg) return '⚠ Usage: `/entered SYMBOL DIRECTION ENTRY [STOP] [TARGET] [SIZE]`\nExample: `/entered ETH long 2302 2290 2320 3`';
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 3) return '⚠ Need at least: symbol direction entry. Example: `/entered ETH long 2302`';
    const [symbol, direction, entry, stop, target, size] = parts;
    try {
      const pos = setActivePosition({ symbol, direction, entry, stop, target, size });
      return [
        '✅ *Position recorded* — bot will stop showing new BUY HERE labels',
        '',
        `${pos.direction === 'LONG' ? '🟢' : '🔴'} *${pos.symbol}* ${pos.direction}`,
        `Entry:    \`${pos.entry}\``,
        pos.stop   ? `Stop:     \`${pos.stop}\``   : '',
        pos.target ? `Target:   \`${pos.target}\`` : '',
        pos.size   ? `Size:     ${pos.size} units` : '',
        '',
        '_Bot now monitors this position. Run /exited when you close it._',
      ].filter(Boolean).join('\n');
    } catch (e) { return `⚠ ${e.message}`; }
  },

  async exited() {
    const prev = clearActivePosition();
    if (!prev) return '_(already flat — no active position to clear)_';
    return `✅ *Position cleared* — ${prev.symbol} ${prev.direction} @ ${prev.entry}\n_Bot resumes normal scanning._`;
  },

  async position() {
    const p = getActivePosition();
    if (!p) return '_(flat — no active position)_\n\nUse `/entered SYM DIR ENTRY` when you take a trade.';
    const lines = [
      `${p.direction === 'LONG' ? '🟢' : '🔴'} *${p.symbol}* ${p.direction}`,
      '',
      `Entry:    \`${p.entry}\``,
      p.stop   ? `Stop:     \`${p.stop}\``   : '_(no stop set)_',
      p.target ? `Target:   \`${p.target}\`` : '_(no target set)_',
      p.size   ? `Size:     ${p.size}`       : '_(no size set)_',
      `Opened:   ${new Date(p.openedAt).toLocaleString()}`,
      '',
      '_Use /exited when you close it. Live P&L appears in regular updates._',
    ];
    return lines.join('\n');
  },

  async pause(arg) {
    const hours = Number(arg) || 4;
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    setManualLock(`Manual /pause ${hours}h via Telegram`, until);
    return `⏸ *Trading paused* for ${hours}h (until ${new Date(until).toLocaleTimeString()})\nUse /resume to unpause.`;
  },

  async resume() {
    clearManualLock();
    return '▶️ *Trading resumed.* Manual lock cleared.';
  },
};

// ─── Dispatcher ──────────────────────────────────────────────────────────────

async function dispatch(text) {
  const trim = text.trim();
  if (!trim.startsWith('/')) return null;
  const [cmd, ...args] = trim.slice(1).split(/\s+/);
  const fn = handlers[cmd.toLowerCase()];
  if (!fn) return `⚠ Unknown command \`/${cmd}\`. Try /help.`;
  try { return await fn(args.join(' ')); }
  catch (e) { return `🚨 Error in /${cmd}: ${e.message}`; }
}

// ─── Main long-poll loop ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const ONCE    = argv.includes('--once');
const VERBOSE = argv.includes('--verbose');

async function main() {
  requireTokens();
  console.log('━'.repeat(70));
  console.log('  Telegram Remote Control Bot');
  console.log('━'.repeat(70));
  if (!ONCE) await send('🛰 *Telegram bot online* — try /help');

  const state = loadState();
  let backoff = 1000;

  while (true) {
    try {
      const offset = state.last_update_id + 1;
      const res = await tgGet('getUpdates', { offset, timeout: 25, limit: 50 });
      backoff = 1000;

      if (res.ok && res.result?.length) {
        for (const upd of res.result) {
          state.last_update_id = upd.update_id;
          const msg = upd.message;
          if (!msg?.text) continue;
          if (String(msg.chat.id) !== String(CHAT_ID)) {
            // Ignore strangers
            continue;
          }
          if (VERBOSE) console.log(`[${msg.from.first_name}] ${msg.text}`);
          const reply = await dispatch(msg.text);
          if (reply) await send(reply);
        }
        saveState(state);
      }
    } catch (e) {
      console.error('  poll error:', e.message);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
    if (ONCE) break;
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await send('🛰 *Telegram bot offline*').catch(() => {});
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
