#!/usr/bin/env node
/**
 * One-time Telegram chat-ID discovery helper.
 *
 * Usage:
 *   1. Already exported TELEGRAM_BOT_TOKEN in ~/.zshrc
 *   2. Sent a message to your bot from your phone
 *   3. Run: node bot/setup-telegram.js
 *
 * Auto-fetches your chat ID and appends TELEGRAM_CHAT_ID to ~/.zshrc.
 */

import { request } from 'node:https';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

if (!TOKEN) {
  console.error('\x1b[31m✗ TELEGRAM_BOT_TOKEN is not set.\x1b[0m');
  console.error('  Did you open a NEW terminal after editing ~/.zshrc?');
  console.error('  Try: source ~/.zshrc');
  process.exit(1);
}

console.log('\x1b[36m→ Looking up your chat ID...\x1b[0m');

const req = request({
  hostname: 'api.telegram.org',
  path: `/bot${TOKEN}/getUpdates`,
  method: 'GET',
}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    let json;
    try { json = JSON.parse(data); }
    catch { console.error('\x1b[31m✗ Invalid response\x1b[0m'); process.exit(1); }

    if (!json.ok) {
      console.error('\x1b[31m✗ Telegram error:\x1b[0m', json.description);
      process.exit(1);
    }

    if (!json.result?.length) {
      console.error('\x1b[33m⚠ No messages found.\x1b[0m');
      console.error('  1. Open Telegram');
      console.error('  2. Search for your bot username');
      console.error('  3. Tap Start (or send any message)');
      console.error('  4. Re-run this script');
      process.exit(1);
    }

    const chats = new Map();
    for (const upd of json.result) {
      const chat = upd.message?.chat || upd.channel_post?.chat;
      if (chat?.type === 'private') chats.set(chat.id, chat);
    }
    if (!chats.size) {
      console.error('\x1b[33m⚠ No private chat found.\x1b[0m');
      process.exit(1);
    }

    const [id, chat] = chats.entries().next().value;
    console.log(`\x1b[32m✓ Found chat:\x1b[0m ${chat.first_name ?? chat.username ?? '?'} (id ${id})`);

    const zshrc = join(homedir(), '.zshrc');
    const line = `export TELEGRAM_CHAT_ID="${id}"`;
    try {
      const existing = readFileSync(zshrc, 'utf-8');
      if (existing.includes('TELEGRAM_CHAT_ID')) {
        console.log('\x1b[33m⚠ TELEGRAM_CHAT_ID already in ~/.zshrc — skipping append.\x1b[0m');
      } else {
        appendFileSync(zshrc, `\n${line}\n`);
        console.log('\x1b[32m✓ Added to ~/.zshrc\x1b[0m');
      }
    } catch (e) {
      console.log(`\x1b[33mAppend failed (${e.message}). Add manually:\x1b[0m\n  ${line}`);
    }

    console.log('\n\x1b[36mSending a test message...\x1b[0m');
    const body = JSON.stringify({
      chat_id: id,
      text: '🤖 *Day Trading Coach*\nConnected — you\'ll get trade plans here.',
      parse_mode: 'Markdown',
    });
    const sendReq = request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, sendRes => {
      let sd = '';
      sendRes.on('data', c => sd += c);
      sendRes.on('end', () => {
        try {
          const sj = JSON.parse(sd);
          console.log(sj.ok
            ? '\x1b[32m✓ Test message sent — check your phone!\x1b[0m\n\nNext: open a NEW terminal then run\n  node bot/coach.js --risk 100'
            : `\x1b[31m✗ sendMessage failed:\x1b[0m ${sj.description}`);
        } catch { console.error('\x1b[31m✗ Bad response\x1b[0m'); }
      });
    });
    sendReq.on('error', e => console.error('Send error:', e.message));
    sendReq.write(body);
    sendReq.end();
  });
});
req.on('error', e => { console.error('\x1b[31m✗ Request error:\x1b[0m', e.message); process.exit(1); });
req.end();
