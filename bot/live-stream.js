#!/usr/bin/env node
/**
 * Live Stream — runs the day-trading coach on a recurring interval and sends
 * the analysis to Telegram. Smart deduplication: only fires Telegram alerts
 * when the trade decision or score materially changes.
 *
 * Usage:
 *   node bot/live-stream.js                        # default 60s interval
 *   node bot/live-stream.js --interval 30          # every 30 seconds
 *   node bot/live-stream.js --once                 # one analysis then exit
 *   node bot/live-stream.js --silent-noop          # skip Telegram for NO TRADE
 *   node bot/live-stream.js --risk 100 --min-score 7
 *
 * Setup: requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 */

import { analyze } from './coach.js';
import { send, isEnabled, notifyAnalysis, notifyInfo, formatAnalysisForTelegram } from './notify.js';
import { teachAnalysis } from './education.js';
import { drawAnalysis, clearBotShapes } from './draw-plan.js';
import { getActivePositionFor, computePositionPnL } from './position-tracker.js';
import { checkProtections } from './protections.js';
import { getOptimalParams } from './auto-tune.js';
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';

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

// Profile presets — same as coach.js
let PROFILE = { minScore: 6.5, targetRR: 1.5, stopCapPct: 7, profile: 'balanced' };
if ('--conservative' in args) PROFILE = { minScore: 7,   targetRR: 2,   stopCapPct: 5,  profile: 'conservative' };
if ('--aggressive'   in args) PROFILE = { minScore: 5.5, targetRR: 1.2, stopCapPct: 10, profile: 'aggressive'   };
if ('--yolo'         in args) PROFILE = { minScore: 4.5, targetRR: 1.0, stopCapPct: 12, profile: 'yolo'         };

const CONFIG = {
  intervalSec: Number(args['--interval']  ?? 60),
  riskDollars: Number(args['--risk']      ?? 100),
  minScore:    Number(args['--min-score'] ?? PROFILE.minScore),
  targetRR:    Number(args['--target-rr'] ?? PROFILE.targetRR),
  stopCapPct:  Number(args['--stop-cap']  ?? PROFILE.stopCapPct),
  profile:     PROFILE.profile,
  silentNoop:  '--silent-noop' in args,
  changesOnly: !('--no-changes-only' in args),  // ON by default — Telegram only on state change
  once:        '--once' in args,
  live:        '--live' in args,                 // tight polling: 2s quote, deep analysis on price move
  livePollSec: Number(args['--live-poll'] ?? 2), // quote check every 2s in --live
  movePct:     Number(args['--move-pct'] ?? 0.0015), // trigger deep analysis on 0.15% move
  teach:       !('--no-teach' in args),
  draw:        '--draw' in args,                  // draw BUY/SELL/STOP/T1 on chart every deep analysis
};

let _prevHash = null;
let _prevAt = 0;
const FORCED_REFRESH_MS = 5 * 60_000;

function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function logInfo(s) { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[36mℹ\x1b[0m ${s}`); }
function logOk(s)   { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[32m✓\x1b[0m ${s}`); }
function logWarn(s) { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[33m⚠\x1b[0m ${s}`); }
function logErr(s)  { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[31m✗\x1b[0m ${s}`); }

// Track last analyzed price + time for live-mode change detection
let _lastAnalyzedPrice = null;
let _lastDeepAnalysisAt = 0;

async function runDeepAnalysis() {
  _lastDeepAnalysisAt = Date.now();   // mark BEFORE so even on failure we don't tight-loop
  let result;
  try {
    // Check for symbol-specific tuned params first; fall back to CONFIG defaults
    let minScore = CONFIG.minScore;
    let targetRR = CONFIG.targetRR;
    let usedTuned = false;
    try {
      // Need to know current symbol BEFORE calling analyze. Cheaper to fetch state.
      const { getState } = await import('../src/core/chart.js');
      const state = await getState();
      const tuned = getOptimalParams(state.symbol);
      if (tuned) {
        minScore = tuned.threshold;
        targetRR = tuned.rewardRisk;
        usedTuned = true;
      }
    } catch { /* fall back to defaults */ }

    result = await analyze({
      riskDollars: CONFIG.riskDollars,
      minScore, targetRR,
      stopCapPct:  CONFIG.stopCapPct,
      profile:     CONFIG.profile,
    });
    if (usedTuned) result._tuned = { minScore, targetRR };
  } catch (e) {
    logErr(`Analysis failed: ${e.message}`);
    return null;
  }

  const o = result.output;
  logInfo(`${o.ticker} ${o.timeframe}  •  ${o.decision}  •  score ${o.setupScore}  •  $${o.currentPrice.toFixed ? o.currentPrice.toFixed(4) : o.currentPrice}`);
  _lastAnalyzedPrice = o.currentPrice;

  // ─── POSITION HELD MODE ──────────────────────────────────────────────────
  // If user is already in a trade on this symbol, switch to monitor mode:
  //   - DON'T draw new BUY HERE labels
  //   - DON'T send standard analysis to Telegram
  //   - DO send a P&L update on material status change
  const heldPosition = getActivePositionFor(o.ticker);
  if (heldPosition) {
    const pnl = computePositionPnL(heldPosition, o.currentPrice);
    const heldHash = `held|${heldPosition.direction}|${pnl.status}|${Math.round((pnl.rMult || 0) * 4) / 4}`;

    if (CONFIG.changesOnly && heldHash === _prevHash && (Date.now() - _prevAt) < FORCED_REFRESH_MS) {
      logInfo(`Held: ${heldPosition.direction} @ ${heldPosition.entry} (${pnl.rMult?.toFixed(2) ?? '?'}R, status ${pnl.status}) — no change`);
      // Clear chart so no stale BUY HERE remains
      if (CONFIG.draw) await clearBotShapes().catch(() => {});
      return result;
    }

    // Build held-position message
    const dirIcon = heldPosition.direction === 'LONG' ? '🟢' : '🔴';
    const sign = (pnl.pnl$ ?? 0) >= 0 ? '+' : '';
    const heldMsg = [
      `${dirIcon} *POSITION HELD* — \`${heldPosition.symbol}\` ${heldPosition.direction}`,
      '',
      `*P&L:* \`${sign}$${(pnl.pnl$ ?? 0).toFixed(2)}\` _(${sign}${(pnl.pnlPct * 100).toFixed(2)}%)_`,
      pnl.rMult != null ? `*R-mult:* \`${pnl.rMult >= 0 ? '+' : ''}${pnl.rMult.toFixed(2)}R\`` : '',
      '',
      `Entry:    \`${heldPosition.entry}\``,
      `Now:      \`${o.currentPrice.toFixed(4)}\``,
      heldPosition.stop   ? `Stop:     \`${heldPosition.stop}\`` : '',
      heldPosition.target ? `Target:   \`${heldPosition.target}\`` : '',
      heldPosition.size   ? `Size:     ${heldPosition.size}` : '',
      `Held:     ${Math.round(pnl.ageMinutes)} min`,
      '',
      pnl.status === 'stopHit'    ? '⛔ *STOP HIT* — close immediately and run /exited' :
      pnl.status === 'targetHit'  ? '✅ *TARGET HIT* — take profit and run /exited' :
      pnl.status === 'nearStop'   ? '⚠️ *Near stop* — be ready to exit' :
      pnl.status === 'nearTarget' ? '🎯 *Near target* — consider taking 50% off' :
      (pnl.rMult != null && pnl.rMult >= 1) ? '💡 *In >1R profit* — move stop to break-even' : '',
      '',
      '_New BUY HERE labels paused. Use /exited when closed._',
    ].filter(Boolean).join('\n');

    const sent = await send(heldMsg);
    logOk(`${sent ? 'Sent' : 'Send failed'} — POSITION HELD update (status ${pnl.status})`);
    _prevHash = heldHash;
    _prevAt   = Date.now();

    // Clear chart drawings so no stale BUY HERE remains
    if (CONFIG.draw) await clearBotShapes().catch(() => {});
    return result;
  }

  // ─── PROTECTION LOCKS ────────────────────────────────────────────────────
  // Check circuit breakers BEFORE acting on any signal.
  const lock = checkProtections({
    account: 10000,
    symbol:  o.ticker,
    setup:   result.best?.setup?.name,
  });
  if (lock.locked) {
    const lockHash = `lock|${lock.kind}|${lock.until || ''}`;
    if (CONFIG.changesOnly && lockHash === _prevHash && (Date.now() - _prevAt) < FORCED_REFRESH_MS) {
      logInfo(`🔒 ${lock.kind} — no change, suppressed`);
      if (CONFIG.draw) await clearBotShapes().catch(() => {});
      return result;
    }
    const lockMsg = [
      `🔒 *TRADING LOCKED* — \`${o.ticker}\` ${o.timeframe}`,
      '',
      `*Reason:* ${lock.reason}`,
      lock.until ? `*Until:* ${new Date(lock.until).toLocaleString()}` : '',
      '',
      '_Use /resume on Telegram to override._',
      '_All entries blocked. Existing positions can still be managed via /position._',
    ].filter(Boolean).join('\n');
    const sent = await send(lockMsg);
    logOk(`${sent ? 'Sent' : 'Send failed'} — LOCK (${lock.kind})`);
    _prevHash = lockHash; _prevAt = Date.now();
    if (CONFIG.draw) await clearBotShapes().catch(() => {});
    return result;
  }

  // Skip silent-noop
  if (CONFIG.silentNoop && o.decision === 'NO TRADE') {
    logInfo('Silent: NO TRADE skipped');
    return result;
  }

  // Dedupe — only Telegram on material change
  const scoreBucket = Math.round(o.setupScore);
  const hash = `${o.decision}|${scoreBucket}`;

  if (CONFIG.changesOnly && hash === _prevHash) {
    const sinceMs = Date.now() - _prevAt;
    if (sinceMs < FORCED_REFRESH_MS) {
      logInfo('No state change — skip Telegram');
      return result;
    }
    logInfo('5-min refresh interval reached — sending');
  }

  // Build message — append teach block if enabled
  let msg;
  if (CONFIG.teach) {
    const lessonText = teachAnalysis(result);
    // Cap teach block at 1500 chars so the full Telegram fits
    const trimmedLesson = lessonText.length > 1500
      ? lessonText.slice(0, 1500) + '\n\n_(...trimmed; run `node bot/coach.js` for full lesson)_'
      : lessonText;
    msg = (await import('./notify.js')).formatAnalysisForTelegram(result) + '\n\n' + trimmedLesson;
  }

  const sent = msg ? await send(msg) : await notifyAnalysis(result);
  if (sent) {
    logOk(`Sent to Telegram (${o.decision})`);
    _prevHash = hash;
    _prevAt = Date.now();
  } else {
    logWarn('Send failed');
  }

  // Draw on chart if --draw enabled
  if (CONFIG.draw) {
    try {
      const r = await drawAnalysis(result);
      if (r.shapes > 0) logOk(`Drew on chart: ${r.drew} (${r.shapes} shapes)`);
      else if (r.drew === 'cleared' && o.decision !== 'NO TRADE') logInfo('Cleared chart (no actionable plan)');
    } catch (e) { logWarn(`Draw failed: ${e.message}`); }
  }

  return result;
}

/**
 * Live-mode tick: cheap quote check.
 * Only runs deep analysis if price moved more than --move-pct since last deep run.
 */
async function liveQuoteTick() {
  try {
    // Use getQuote() — cheap single-bar pull (much faster than 200-bar OHLCV)
    const q = await data.getQuote();
    const price = q?.last ?? q?.close ?? null;
    if (!Number.isFinite(price)) return;

    if (_lastAnalyzedPrice == null) {
      await runDeepAnalysis();
      return;
    }

    const moveAbs = Math.abs(price - _lastAnalyzedPrice);
    const movePct = moveAbs / _lastAnalyzedPrice;
    const sinceDeepSec = (Date.now() - _lastDeepAnalysisAt) / 1000;

    if (movePct >= CONFIG.movePct) {
      logInfo(`Price moved ${(movePct * 100).toFixed(3)}% ($${_lastAnalyzedPrice.toFixed(4)} → $${price.toFixed(4)}) — re-analyzing`);
      await runDeepAnalysis();
    } else if (sinceDeepSec > 60) {
      // Stale refresh — even without movement, re-analyze every 60s
      logInfo(`Stale refresh (${sinceDeepSec.toFixed(0)}s since last deep) — price flat at $${price.toFixed(4)}`);
      await runDeepAnalysis();
    } else {
      // Heartbeat log every 30s of pure idle so user sees the bot is alive
      if (sinceDeepSec > 30 && Math.floor(sinceDeepSec) % 10 === 0) {
        logInfo(`💓 alive — price $${price.toFixed(4)} (move ${(movePct * 100).toFixed(3)}% < ${(CONFIG.movePct * 100).toFixed(2)}%)`);
      }
    }
  } catch (e) {
    logErr(`Live tick error: ${e.message}`);
  }
}

// Backwards-compat alias
const tick = runDeepAnalysis;

async function main() {
  console.log('\n━'.repeat(70));
  console.log('  TradingView Day Trading Coach — Live Stream');
  console.log('━'.repeat(70));

  if (!isEnabled()) {
    logErr('Telegram is not configured. Run: node bot/setup-telegram.js');
    process.exit(1);
  }
  logOk('Telegram: configured');

  if (!CONFIG.once) {
    await notifyInfo(`📡 *Live Coach Started*\nInterval: ${CONFIG.intervalSec}s\nMin score: ${CONFIG.minScore}\nMax risk per trade: $${CONFIG.riskDollars}`);
  }

  await tick();
  if (CONFIG.once) {
    await disconnect().catch(() => {});
    return;
  }

  process.on('SIGINT', async () => {
    logInfo('Shutting down...');
    await notifyInfo('📡 Live Coach Stopped').catch(() => {});
    await disconnect().catch(() => {});
    process.exit(0);
  });

  if (CONFIG.live) {
    // True LIVE mode: cheap quote check every N seconds; deep analysis only on price move
    logInfo(`🔴 LIVE mode — quote every ${CONFIG.livePollSec}s, deep analysis on ${(CONFIG.movePct * 100).toFixed(2)}% move`);
    setInterval(async () => {
      try { await liveQuoteTick(); }
      catch (e) { logErr(`Live tick error: ${e.message}`); }
    }, CONFIG.livePollSec * 1000);
  } else {
    logInfo(`Polling every ${CONFIG.intervalSec}s — Ctrl+C to stop`);
    setInterval(async () => {
      try { await tick(); }
      catch (e) { logErr(`Tick error: ${e.message}`); }
    }, CONFIG.intervalSec * 1000);
  }
}

main().catch(async e => {
  logErr(`Fatal: ${e.message}`);
  console.error(e.stack);
  await disconnect().catch(() => {});
  process.exit(1);
});
