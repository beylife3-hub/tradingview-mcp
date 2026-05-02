#!/usr/bin/env node
/**
 * Quiz Mode — self-assessment.
 *
 * Bot pulls the current chart, computes the analysis, but HIDES the decision.
 * Shows you structure + bias + level only, then asks "what would YOU do?"
 * After you answer, reveals what the bot decided and explains the gap.
 *
 * Usage:
 *   node bot/quiz.js                              prompt mode (interactive)
 *   node bot/quiz.js --auto LONG                  non-interactive (CI / scripts)
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { analyze } from './coach.js';
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
const AUTO = args['--auto'] ?? null;

const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' };

async function main() {
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}🧠 QUIZ MODE — what would YOU do here?${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}\n`);

  const result = await analyze({});
  const o = result.output;

  // Show context WITHOUT the decision
  console.log(`${C.bold}Ticker:${C.reset}        ${o.ticker}  (${o.timeframe})`);
  console.log(`${C.bold}Current price:${C.reset} ${o.currentPrice}`);
  console.log(`${C.bold}Market:${C.reset}        ${o.marketCondition}`);
  console.log(`${C.bold}HTF bias:${C.reset}      ${o.htf}`);
  console.log(`${C.bold}LTF bias:${C.reset}      ${o.bias}`);
  console.log(`${C.bold}Best level:${C.reset}    ${o.bestLevel}`);
  console.log('');
  console.log(`${C.dim}Detected ${result.setups?.length ?? 0} setup(s) — top: ${result.best?.setup?.name ?? '(none)'}${C.reset}`);
  console.log('');

  let userAnswer;
  if (AUTO) {
    userAnswer = AUTO.toUpperCase();
    console.log(`${C.dim}(auto: ${userAnswer})${C.reset}`);
  } else {
    const rl = createInterface({ input, output });
    console.log(`${C.bold}What would you do?${C.reset}`);
    console.log(`  L = LONG  /  S = SHORT  /  W = WATCHLIST  /  N = NO TRADE`);
    const ans = await rl.question('Your answer: ');
    rl.close();
    const map = { L: 'LONG', S: 'SHORT', W: 'WATCHLIST ONLY', N: 'NO TRADE' };
    userAnswer = map[ans.trim().toUpperCase()] || ans.trim().toUpperCase();
  }

  // Reveal
  console.log(`\n${C.cyan}━━━ REVEAL ━━━${C.reset}\n`);
  console.log(`${C.bold}You said:${C.reset}     ${userAnswer}`);
  console.log(`${C.bold}Bot decided:${C.reset}  ${o.decision}`);
  console.log(`${C.bold}Setup score:${C.reset}  ${o.setupScore}/10`);
  console.log('');

  const matched = userAnswer === o.decision;
  if (matched) {
    console.log(`${C.green}✓ MATCH — you and the bot agree.${C.reset}`);
  } else {
    console.log(`${C.yellow}⚠ MISMATCH — you said ${userAnswer}, bot said ${o.decision}.${C.reset}`);
  }
  console.log('');

  console.log(`${C.bold}Why the bot decided ${o.decision}:${C.reset}`);
  for (const r of o.reasons) console.log(`  • ${r}`);
  console.log('');
  console.log(`${C.yellow}Main risk:${C.reset}        ${o.mainRisk}`);
  console.log(`${C.cyan}Final instruction:${C.reset} ${o.finalInstruction}`);

  if (!matched && (userAnswer === 'LONG' || userAnswer === 'SHORT') && o.decision === 'NO TRADE') {
    console.log(`\n${C.red}⚠ DANGER: you wanted to take a trade the bot rejected.${C.reset}`);
    console.log('  Common reasons retail traders override "no trade":');
    console.log('    - Boredom (forced trade in chop)');
    console.log('    - FOMO (chasing extended move)');
    console.log('    - Revenge (trying to make back a loss)');
    console.log('  Trust the bot. Re-read why it said NO TRADE before you click.');
  } else if (!matched && userAnswer === 'NO TRADE' && (o.decision === 'LONG' || o.decision === 'SHORT')) {
    console.log(`\n${C.cyan}ℹ Note: bot saw an A+ setup that you missed.${C.reset}`);
    console.log('  Review the bot\'s reasons above. Which confluence did you not see?');
  }

  await disconnect().catch(() => {});
}

main().catch(async e => {
  console.error('Fatal:', e.message);
  await disconnect().catch(() => {});
  process.exit(1);
});
