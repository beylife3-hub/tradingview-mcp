/**
 * Webhook Alerts — Discord + Slack distribution.
 *
 * Pushes trade signals to Discord/Slack channels via incoming webhooks.
 * No deps beyond Node's built-in fetch (Node 18+).
 *
 * Setup:
 *   Discord:
 *     1. Server settings → Integrations → Webhooks → New Webhook
 *     2. Copy URL, set: export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
 *
 *   Slack:
 *     1. https://api.slack.com/apps → Create App → Incoming Webhooks → Activate
 *     2. Add to workspace, pick channel, copy URL
 *     3. export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
 */

const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL ?? '';
const SLACK_URL   = process.env.SLACK_WEBHOOK_URL ?? '';

function isDiscordEnabled() { return !!DISCORD_URL; }
function isSlackEnabled()   { return !!SLACK_URL; }
export function isAnyEnabled() { return isDiscordEnabled() || isSlackEnabled(); }

// ─── Discord rich-embed format ───────────────────────────────────────────────

function decisionColor(decision) {
  return decision === 'LONG'           ? 0x00d97e :   // green
         decision === 'SHORT'          ? 0xf44336 :   // red
         decision === 'WATCHLIST ONLY' ? 0xffb74d :   // amber
                                          0x666666;   // gray
}

function buildDiscordPayload(result) {
  const o = result.output;
  const fields = [
    { name: 'Score',    value: `${o.setupScore}/10`, inline: true },
    { name: 'Bias',     value: o.bias,    inline: true },
    { name: 'Regime',   value: o.marketCondition.split('—')[0].trim(), inline: true },
  ];
  if (o.decision === 'LONG' || o.decision === 'SHORT') {
    fields.push(
      { name: 'Entry',  value: `\`${o.entry}\``, inline: true },
      { name: 'Stop',   value: `\`${o.stop}\``,  inline: true },
      { name: 'T1',     value: `\`${o.target1}\``, inline: true },
      { name: 'R/R',    value: o.rewardRisk, inline: false },
      { name: 'Size',   value: o.positionSize, inline: false },
    );
  }
  fields.push({ name: 'Best level', value: o.bestLevel.slice(0, 100) || 'n/a', inline: false });
  if (o.reasons?.length) {
    fields.push({ name: 'Why', value: o.reasons.slice(0, 3).map(r => `• ${r}`).join('\n').slice(0, 1000) });
  }
  fields.push({ name: 'Final instruction', value: o.finalInstruction.slice(0, 500) });

  return {
    embeds: [{
      title: `${o.decision === 'LONG' ? '🟢' : o.decision === 'SHORT' ? '🔴' : o.decision === 'WATCHLIST ONLY' ? '🟡' : '⚪'} ${o.decision} — ${o.ticker} ${o.timeframe}`,
      description: `Price: \`${o.currentPrice}\``,
      color: decisionColor(o.decision),
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'TradingView Bot' },
    }],
  };
}

// ─── Slack block format ──────────────────────────────────────────────────────

function buildSlackPayload(result) {
  const o = result.output;
  const emoji = o.decision === 'LONG' ? ':large_green_circle:' :
                o.decision === 'SHORT' ? ':large_red_circle:' :
                o.decision === 'WATCHLIST ONLY' ? ':large_yellow_circle:' : ':white_circle:';
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${o.decision}* — *${o.ticker}* ${o.timeframe}\nPrice \`${o.currentPrice}\`  •  Score *${o.setupScore}/10*  •  Bias ${o.bias}\nRegime: ${o.marketCondition.split('—')[0].trim()}\nLevel: ${o.bestLevel.slice(0, 80)}` } },
  ];
  if (o.decision === 'LONG' || o.decision === 'SHORT') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `*Entry:* \`${o.entry}\` | *Stop:* \`${o.stop}\` | *T1:* \`${o.target1}\` | *T2:* \`${o.target2}\`\n*R/R:* ${o.rewardRisk}\n*Size:* ${o.positionSize}` } });
  }
  if (o.reasons?.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Why:*\n' + o.reasons.slice(0, 3).map(r => `• ${r}`).join('\n') } });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${o.finalInstruction.slice(0, 300)}_` }] });
  return { blocks };
}

// ─── Send (uses Node 18+ built-in fetch) ─────────────────────────────────────

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function sendDiscord(result) {
  if (!isDiscordEnabled()) return false;
  const payload = buildDiscordPayload(result);
  const r = await postJson(DISCORD_URL, payload);
  return r.ok;
}

export async function sendSlack(result) {
  if (!isSlackEnabled()) return false;
  const payload = buildSlackPayload(result);
  const r = await postJson(SLACK_URL, payload);
  return r.ok;
}

/**
 * Send the analysis to all configured webhook destinations.
 * Returns: { discord: bool, slack: bool }
 */
export async function broadcast(result) {
  return {
    discord: await sendDiscord(result),
    slack:   await sendSlack(result),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Webhook status:');
  console.log(`  Discord: ${isDiscordEnabled() ? '✓ configured' : '✗ DISCORD_WEBHOOK_URL not set'}`);
  console.log(`  Slack:   ${isSlackEnabled()   ? '✓ configured' : '✗ SLACK_WEBHOOK_URL not set'}`);
  if (process.argv[2] === 'test') {
    const fake = {
      output: {
        ticker: 'TEST', timeframe: '5m', currentPrice: 100, decision: 'LONG',
        setupScore: 7.5, bias: 'BULLISH', marketCondition: '📈 Trend day',
        bestLevel: 'Test level @ 100', entry: 100, stop: 98, target1: 103, target2: 105,
        rewardRisk: '1.5:1', positionSize: '50 units', confidence: 'high',
        reasons: ['Test reason 1', 'Test reason 2'], finalInstruction: 'Test instruction',
      },
    };
    (async () => {
      const r = await broadcast(fake);
      console.log('\nTest broadcast:', r);
    })();
  } else {
    console.log('\nRun: node bot/webhook-alerts.js test  to send a test message');
  }
}
