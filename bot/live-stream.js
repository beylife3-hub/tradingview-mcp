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
import { send, isEnabled, notifyAnalysis, notifyInfo } from './notify.js';
import { disconnect } from '../src/connection.js';

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
const CONFIG = {
  intervalSec: Number(args['--interval']  ?? 60),
  riskDollars: Number(args['--risk']      ?? 100),
  minScore:    Number(args['--min-score'] ?? 7),
  targetRR:    Number(args['--target-rr'] ?? 2),
  silentNoop:  '--silent-noop' in args,
  changesOnly: '--changes-only' in args,
  once:        '--once' in args,
};

let _prevHash = null;
let _prevAt = 0;
const FORCED_REFRESH_MS = 5 * 60_000;

function ts() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function logInfo(s) { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[36mℹ\x1b[0m ${s}`); }
function logOk(s)   { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[32m✓\x1b[0m ${s}`); }
function logWarn(s) { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[33m⚠\x1b[0m ${s}`); }
function logErr(s)  { console.log(`\x1b[2m${ts()}\x1b[0m \x1b[31m✗\x1b[0m ${s}`); }

async function tick() {
  let result;
  try {
    result = await analyze({
      riskDollars: CONFIG.riskDollars,
      minScore: CONFIG.minScore,
      targetRR: CONFIG.targetRR,
    });
  } catch (e) {
    logErr(`Analysis failed: ${e.message}`);
    return;
  }

  const o = result.output;
  logInfo(`${o.ticker} ${o.timeframe}  •  ${o.decision}  •  score ${o.setupScore}`);

  // Skip silent-noop
  if (CONFIG.silentNoop && o.decision === 'NO TRADE') {
    logInfo('Silent: NO TRADE skipped');
    return;
  }

  // Dedupe — only Telegram on material change
  // State hash = decision + score bucket
  const scoreBucket = Math.round(o.setupScore);
  const hash = `${o.decision}|${scoreBucket}`;

  if (CONFIG.changesOnly && hash === _prevHash) {
    const sinceMs = Date.now() - _prevAt;
    if (sinceMs < FORCED_REFRESH_MS) {
      logInfo('No state change — skip Telegram');
      return;
    }
    logInfo('5-min refresh interval reached — sending');
  }

  const sent = await notifyAnalysis(result);
  if (sent) {
    logOk(`Sent to Telegram (${o.decision})`);
    _prevHash = hash;
    _prevAt = Date.now();
  } else {
    logWarn('Send failed');
  }
}

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

  logInfo(`Polling every ${CONFIG.intervalSec}s — Ctrl+C to stop`);
  process.on('SIGINT', async () => {
    logInfo('Shutting down...');
    await notifyInfo('📡 Live Coach Stopped').catch(() => {});
    await disconnect().catch(() => {});
    process.exit(0);
  });

  setInterval(async () => {
    try { await tick(); }
    catch (e) { logErr(`Tick error: ${e.message}`); }
  }, CONFIG.intervalSec * 1000);
}

main().catch(async e => {
  logErr(`Fatal: ${e.message}`);
  console.error(e.stack);
  await disconnect().catch(() => {});
  process.exit(1);
});
