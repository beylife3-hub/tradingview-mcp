/**
 * Telegram notification layer.
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
 * Auto-falls back to plain text if Markdown parsing fails.
 *
 * Public:
 *   send(text)            — primary low-level sender (Markdown, fallback to plain)
 *   isEnabled()           — whether env is configured
 *   notifyAnalysis(out)   — sends a coach.analyze() output as a clean message
 *   notifyInfo(text)      — wraps with ℹ️ prefix
 *   notifyWarn(text)      — wraps with ⚠️
 *   notifyError(text)     — wraps with 🚨
 */

import { request } from 'node:https';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID  ?? '';
const ENABLED = Boolean(TOKEN && CHAT_ID);

// Telegram limits to 30 messages/sec — we throttle to 1/s for safety
let _lastSent = 0;
async function rateLimitWait() {
  const since = Date.now() - _lastSent;
  if (since < 1000) await new Promise(r => setTimeout(r, 1000 - since));
  _lastSent = Date.now();
}

export function isEnabled() { return ENABLED; }

function _post(text, parseMode) {
  const payload = {
    chat_id: CHAT_ID,
    text:    text.slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  const body = JSON.stringify(payload);
  return new Promise(resolve => {
    const req = request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: json.ok === true, status: res.statusCode, error: json.description });
        } catch { resolve({ ok: false, status: res.statusCode, error: 'parse error' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function stripMarkdown(s) {
  return String(s)
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

export async function send(text) {
  if (!ENABLED) return false;
  await rateLimitWait();

  // Try Markdown first
  let res = await _post(text, 'Markdown');
  if (res.ok) return true;

  // Markdown parse error → retry as plain text
  if (res.error?.toLowerCase().includes('parse') || res.error?.toLowerCase().includes('entit')) {
    res = await _post(stripMarkdown(text), null);
    if (res.ok) return true;
  }

  console.error(`✗ Telegram send failed: ${res.error || 'unknown'}`);
  return false;
}

export async function notifyInfo(text)  { return send(`ℹ️ ${text}`); }
export async function notifyWarn(text)  { return send(`⚠️ ${text}`); }
export async function notifyError(text) { return send(`🚨 *ERROR*\n${text}`); }

/**
 * Format an analyze() output as a Telegram message.
 *
 * Highlights the verdict (LONG/SHORT/WATCHLIST/NO TRADE) and gives the
 * full structured plan when actionable.
 */
export function formatAnalysisForTelegram(result) {
  const o = result.output;
  const lines = [];

  // Header — verdict-driven emoji
  const verdictEmoji = {
    'LONG':           '🟢',
    'SHORT':          '🔴',
    'WATCHLIST ONLY': '🟡',
    'NO TRADE':       '⚪',
  }[o.decision] ?? '⚪';

  lines.push(`${verdictEmoji} *${o.decision}*  —  ${o.ticker} ${o.timeframe}`);
  lines.push('');
  lines.push(`Price: \`${o.currentPrice.toFixed ? o.currentPrice.toFixed(4) : o.currentPrice}\`  •  Score: *${o.setupScore}/10*`);
  lines.push(`Bias: ${o.bias}`);
  lines.push(`Regime: ${o.marketCondition}`);
  lines.push(`Best level: ${o.bestLevel}`);
  lines.push('');

  if (o.decision === 'LONG' || o.decision === 'SHORT') {
    lines.push('*Trade plan:*');
    lines.push(`Entry:    \`${o.entry}\``);
    lines.push(`Stop:     \`${o.stop}\``);
    lines.push(`Target 1: \`${o.target1}\``);
    lines.push(`Target 2: \`${o.target2}\``);
    lines.push(`R/R: ${o.rewardRisk}`);
    lines.push(`Size: ${o.positionSize}`);
    lines.push(`Confidence: ${o.confidence}`);
    lines.push('');
  }

  lines.push('*Why:*');
  for (const r of o.reasons) lines.push(`  • ${r}`);
  lines.push('');
  lines.push(`⚠️ *Main risk:* ${o.mainRisk}`);
  lines.push(`📋 *Final instruction:* ${o.finalInstruction}`);

  return lines.join('\n');
}

export async function notifyAnalysis(result) {
  return send(formatAnalysisForTelegram(result));
}

// ─── CLI for setup test ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!ENABLED) {
    console.log('⚠ Telegram not configured.\n');
    console.log('To enable notifications:');
    console.log('  1. Message @BotFather on Telegram → /newbot → get your TOKEN');
    console.log('  2. Open a chat with your new bot, send any message');
    console.log('  3. Add to ~/.zshrc:');
    console.log('       export TELEGRAM_BOT_TOKEN="123456:ABC..."');
    console.log('       export TELEGRAM_CHAT_ID="987654321"');
    console.log('  4. Reload: source ~/.zshrc');
    console.log('  5. Run setup helper: node bot/setup-telegram.js');
    process.exit(0);
  }
  console.log('Testing Telegram connection...');
  const ok = await send('🤖 *TradingView Day Trading Coach*\nTelegram connected — you\'ll get analysis here.');
  console.log(ok ? '✓ Test message sent!' : '✗ Send failed.');
}
