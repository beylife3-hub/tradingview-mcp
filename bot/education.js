/**
 * Education layer — teach the trader on every concept, decision, and term
 * the coach uses. Makes the bot a learning tool, not a black box.
 *
 * Public API:
 *   GLOSSARY              — concept → plain-English definition (one-liners)
 *   CONCEPTS              — concept → deep-dive paragraph
 *   SETUP_LESSONS         — setup name → "what's happening structurally"
 *   REGIME_LESSONS        — regime → "what this means for you today"
 *   COMPONENT_LESSONS     — scoring component → why it matters
 *   COMMON_MISTAKES       — generic + situation-specific mistakes
 *   teachAnalysis(result) — returns a formatted education block for an analysis
 *   teachConcept(term)    — looks up any term and returns a layered explanation
 */

// ─── GLOSSARY (one-liners — for quick reference) ──────────────────────────────

export const GLOSSARY = {
  ATR: 'Average True Range — the typical bar size over the last 14 bars. Measures volatility. Used to set stops, classify extension, and gauge "normal" movement.',
  VWAP: 'Volume-Weighted Average Price — the average price weighted by volume since session open. Institutions watch it because it shows where most of today\'s trading happened.',
  EMA: 'Exponential Moving Average — a moving average that weights recent prices more heavily. EMA20 = short-term trend, EMA50 = medium, EMA200 = long-term.',
  RSI: 'Relative Strength Index — momentum oscillator from 0 to 100. >70 = overbought (sellers may step in), <30 = oversold (buyers may step in). Default period 14.',
  MACD: 'Moving Average Convergence Divergence — momentum indicator showing the difference between EMA12 and EMA26, with a 9-period signal line and histogram.',
  PDH: 'Previous Day High — the highest price reached in the prior trading session. Acts as resistance; breaks above it often trigger continuation.',
  PDL: 'Previous Day Low — opposite of PDH. Acts as support; breaks below trigger continuation.',
  PMH: 'Premarket High — the highest price during pre-market hours (04:00–09:30 ET). Massive resistance level for equities at the open.',
  PML: 'Premarket Low — premarket support; breaking below often signals weak day.',
  ORH: 'Opening Range High — high of the first 5 minutes after market open. Closing above on volume = bullish breakout.',
  ORL: 'Opening Range Low — opposite. Closing below on volume = bearish breakdown.',
  'R:R': 'Reward-to-Risk ratio — potential profit divided by potential loss. 2:1 means risking $1 to make $2. Lower than 2:1 = trade is not worth it long-term.',
  Stop: 'Stop loss — the price where you exit at a predetermined loss. Set BEFORE entry. Non-negotiable. Measures how wrong you are willing to be.',
  Invalidation: 'The price level that proves your trade thesis wrong. Same as your stop. If price gets here, your idea was incorrect — exit.',
  R: '1R = the dollar distance between entry and stop. "Up 2R" means profit equals 2× the original risk. Standardizes performance across trades of different size.',
  Setup: 'A specific, recurring chart pattern with statistical edge. Has rules: where to enter, where to invalidate, what targets to expect.',
  Bias: 'The directional lean — which side has higher probability of working. Up bias = look for longs first; down bias = look for shorts first; neutral = wait.',
  Regime: 'The market\'s current "personality" — trending, ranging, choppy, or parabolic. Determines what STYLE of trade has edge today.',
  Momentum: 'A trade style — buying strength / selling weakness, expecting continuation. Works in trending regimes.',
  Pullback: 'A counter-trend retracement within a larger trend. The classic "buy the dip" entry. Works in trending regimes.',
  'Mean reversion': 'A trade style — fading extremes back toward the average. Works in ranging regimes.',
  Sweep: 'When price wicks past a prior swing high/low (taking liquidity sitting at stops) and then closes back inside. Often precedes a reversal.',
  Reclaim: 'When price closes back above (or below) a key level after briefly breaking it. The break was rejected.',
  Confluence: 'Multiple independent signals pointing the same direction at the same price. Stronger setups have 3+ confluences.',
  HTF: 'Higher Timeframe — used for bias (e.g., 1h chart while you trade the 5m).',
  LTF: 'Lower Timeframe — used for execution (e.g., 1m for entry timing while bias is on 5m).',
  Liquidity: 'Resting orders (typically stops) at obvious levels. Markets often "hunt liquidity" before reversing.',
  'Reaction bar': 'The candle that shows buyers/sellers stepping in — bullish bar with close near high (long) or bearish bar with close near low (short).',
  Notional: 'Total dollar value of the position (shares × price). Different from "risk" — risk is just the stop distance × shares.',
  Spread: 'Difference between bid and ask price. Wider spread = more slippage on entry/exit.',
  Slippage: 'Difference between expected fill price and actual fill price. Worse in low liquidity / fast markets.',
  Tilt: 'Emotional trading after losses. The #1 way retail accounts blow up. Walk away after 2 losses.',
  'Path efficiency': 'Net price move ÷ sum of absolute moves. 1.0 = perfect trend (every bar moves in trend direction); 0 = pure noise.',
  Pivot: 'A swing high or low — local max/min over a lookback window. Multiple pivots clustering at one price = key level.',
  'Range expansion': 'A bar with range much larger than recent bars. Signals new directional intent or news.',
  Choppy: 'Sideways/random price action with no clear direction. NEVER a good day-trade environment. Stand aside.',
  Parabolic: 'Vertical move that\'s gone "too far too fast." Reversal risk is huge. Don\'t chase.',
  'Trend day': 'A day that opens, sets a directional bias by 10:30 ET, and trends in that direction all session. Avoid counter-trend trades.',
  'Range day': 'A day that oscillates between defined high and low, chopping between extremes. Fade the extremes.',
};

// ─── CONCEPTS (deep-dive paragraphs — when user wants to LEARN) ───────────────

export const CONCEPTS = {
  ATR: `**ATR (Average True Range)** measures the typical "size" of a bar over the last 14 bars. It's calculated as the largest of: bar range, |high − previous close|, or |low − previous close|, then smoothed.

Why traders use it:
• **Stop placement:** stops should be at least 1 ATR away from entry, otherwise normal noise stops you out
• **Extension check:** if a 5-bar move > 1.5× ATR, the move is "extended" and chasing has poor R:R
• **Volatility regime:** rising ATR = expanding moves; falling ATR = consolidation

Example: if NVDA's 14-bar ATR is $2.50, a $0.50 stop is too tight (random noise will hit it); a $5 stop is unnecessarily wide.`,

  VWAP: `**VWAP (Volume-Weighted Average Price)** is the average price weighted by traded volume since the session opened. It shows "where the average dollar today was transacted."

Why it matters for day trading:
• **Institutional benchmark:** Big funds get measured against VWAP; they tend to buy below it and sell above it
• **Mean-reversion magnet:** In trending sessions, price often pulls back to VWAP and bounces (62% win rate on first touch per backtests)
• **Bias filter:** Above VWAP = institutional bullish; below = institutional bearish

How to read it on the chart:
• Price grinding above VWAP all day = strong trend day (long-only)
• Price oscillating around VWAP = chop (no trade)
• First touch of VWAP after a directional move = high-probability bounce setup`,

  Sweep: `**Liquidity Sweep + Reclaim** is one of the highest-edge day-trading patterns. It works because of how markets actually work mechanically.

Step 1: Stops cluster at obvious levels (just below a swing low, just above a swing high). These are "resting liquidity."

Step 2: Price wicks past that level briefly, triggering those stops. Algorithms hunt these because they NEED counterparties — when stops trigger, those orders provide the fills they want.

Step 3: Once stops are taken out, the move reverses because the actual trend doesn't have the structural break that the stops implied. Price closes back inside the range.

Step 4: The "reclaim" candle — the next bar closes beyond the body midpoint of the sweep bar — confirms reversal.

The trade: enter on the reclaim candle, stop just past the sweep wick, target 3R+ to the next major level. This pattern has 58% win rate with R:R of 1:3 in published ICT backtests.`,

  Regime: `**Market Regime** determines what trading style has edge today. Trading the wrong style for the regime is the #1 retail loser.

Four regimes you'll see:

**Trending day:** path efficiency > 45%, EMA20 sloped, monotonic VWAP. By 10:30 ET, price is > 1.5× the opening range away from open. → Trade pullbacks WITH the trend. Skip counter-trend.

**Range day:** path efficiency 18-35%, EMAs flat, oscillating between defined H/L. → Fade extremes (sell tops, buy bottoms). Skip middle.

**Choppy:** path efficiency < 18%, no clear direction, lots of doji bars. → STAND ASIDE. No edge anywhere.

**Parabolic:** range expansion > 3× ATR, ATR percentile > 1.5σ above mean. → DO NOT chase. Wait for retracement.

The single most important question to ask before any trade: "Does this setup fit today's regime?"`,

  PositionSizing: `**Position Sizing** is the math that turns your risk tolerance into a share count. It's the single most important variable in long-term profitability — even more than win rate.

The formula: \`shares = max_dollar_risk / stop_distance\`

Example:
- Entry: $100
- Stop: $99
- Stop distance: $1
- Max risk per trade: $50
- Shares: 50 / 1 = 50 shares

If the trade hits stop: lose exactly $50.
If it hits a 2:1 target ($102): make $100 (profit = 2× risk).

Why this matters:
• **Risk is constant** regardless of stop distance — wide stop = fewer shares, tight stop = more shares
• **Same dollar pain on every loss** = no emotional escalation
• **Bankroll math:** at 1% risk per trade, you can lose 10 in a row and still have 90% of capital. Survivors keep playing.

Rule: never increase size mid-trade. Never "average down." If you wouldn't take the trade fresh at the new price, you shouldn't add to it.`,

  Confluence: `**Confluence** = multiple independent signals pointing to the same trade at the same price. The more confluences, the higher the probability.

Examples of confluence at one entry:
1. Setup pattern (e.g., trend pullback) — geometric edge
2. At a key level (PDH, VWAP, prior pivot) — structural edge
3. HTF bias agrees — directional edge
4. Volume confirmation — institutional edge
5. RSI not overbought — momentum edge
6. Time of day favorable (open/close hour) — session edge

A "C-grade" trade has 1-2 confluences. An "A+" trade has 4+. Your win rate on A+ setups is dramatically higher because you're not betting on a single signal — you're getting paid only when multiple independent things align.

The bot's 1-10 score effectively measures confluence count. ≥ 7 = high-confluence A+ trade.`,
};

// ─── SETUP LESSONS — what's happening structurally for each setup ────────────

export const SETUP_LESSONS = {
  'Liquidity Sweep + Reclaim': `What just happened: price wicked past a prior swing level, taking out stops, then closed back inside. The current bar confirmed the rejection by closing beyond the sweep bar's midpoint.

Why this works: algorithms hunted the stops on the sweep, but the underlying structure didn't actually break. The reversal that follows is "real" because it's not driven by stop-loss cascades.

What to watch: did the sweep happen on increased volume? That's even better — confirms big players were the ones taking out the stops, and they tend to step in opposite to the move once stops are gone.

Common mistake: entering during the sweep itself instead of waiting for the reclaim. The sweep can keep extending. Wait for the bar that closes back inside.`,

  'VWAP First-Touch Bounce': `What just happened: price has been above VWAP for a while (signaling institutional bullish), pulled back to touch VWAP for the first time today, and formed a bullish reaction bar with a long lower wick.

Why this works: institutions defend their long positions at VWAP — they accumulated above it, and a clean dip back to VWAP is where they add. The "first touch" is the highest-probability one (62% historical win rate); subsequent touches degrade to ~48%.

What to watch: VWAP slope. If VWAP itself is sloping up = strong trend, high-probability bounce. If VWAP is flat = weak setup.

Common mistake: shorting against VWAP in a trend day, or buying VWAP in a downtrending market. Always check VWAP slope first.`,

  'Opening Range Breakout (Long)': `What just happened: price closed above the high of the first 5 minutes (the Opening Range), on volume ≥ 1.2× the prior 20-bar average.

Why this works: the first 5 minutes establishes the day's emotional range. Closing through it on volume signals real demand — the breakout has institutional fuel. Per Zarattini/Aggarwal 2023, this is a documented edge worth ~33% annualized on QQQ when filtered by relative volume.

What to watch: relative volume is the #1 thing. ORB without volume = stop-out factory. ORB WITH 1.5×+ vol = high-quality continuation trade.

Common mistake: entering the breakout BAR rather than waiting for the close. Many fakeouts wick through OR-high then immediately reverse. Always wait for bar close.`,

  'Opening Range Breakout (Short)': `Same logic as Long but mirrored — close below OR-low on volume = bearish breakdown. Markets that break down from the open often trend down all day. Don't try to catch the bounce.`,

  'Trend Pullback (Long)': `What just happened: price is in an established uptrend (EMA20 > EMA50), pulled back to within 0.5× ATR of EMA20, and is now reacting back up.

Why this works: in trends, the dominant side defends pullbacks. Buyers who missed the initial run-up come back in at the EMA20. This is the bread-and-butter trend-day continuation entry.

What to watch: how DEEP the pullback was. Shallow pullback (< 0.3 ATR) = strong trend, likely continues. Deep pullback (>1 ATR to EMA50) = trend may be weakening.

Common mistake: confusing "pullback" with "reversal." If price closes below the EMA50, the trend has shifted — exit and reassess. Don't average into a falling pullback.`,

  'Trend Pullback (Short)': `Mirror of long. Established downtrend (EMA20 < EMA50), pullback to EMA20, bearish reaction bar = short the pullback. Targets are prior pivot lows.`,

  'Range Reversal at Support': `What just happened: in a ranging market, price tagged a multi-touch support level and printed a strong bullish reaction bar.

Why this works: ranges hold until they break. Each touch of support without breaking it strengthens the level (more buyers showing up). The reaction bar is the trigger.

What to watch: how MANY prior touches. 1-2 touches = decent. 3+ touches = much higher probability bounce. The level has been "tested" successfully more times.

Common mistake: trading reversals in trending markets. Range reversal needs a clear range — not just a "level" in a downtrend. Check regime first.`,

  'Range Reversal at Resistance': `Mirror of support. Multi-touch resistance + bearish reaction bar = short with stop above the high.`,
};

// ─── REGIME LESSONS — what each regime means for YOUR DAY ─────────────────────

export const REGIME_LESSONS = {
  'trending-up': `Today is a TREND DAY UP. Path efficiency is high — the market is moving in one direction with little wasted motion.

Your playbook today:
✅ Buy pullbacks to EMA20 / VWAP / prior breakout level
✅ Hold winners — trend days have BIG continuation moves
✅ Targets at PDH, prior pivot highs, R-multiple expansion
❌ Do NOT short — counter-trend on a trend day is the largest losing category
❌ Do NOT fade extremes — extremes keep extending in trends
❌ Do NOT exit at first sign of weakness — small dips are buy zones, not exits

Common trend-day error: profit-taking too early. Trail stops, scale out gradually.`,

  'trending-down': `Today is a TREND DAY DOWN. Same rules as up, mirrored. Sell rallies, don't try to catch the falling knife.

✅ Short rallies to EMA20 / VWAP
✅ Hold short winners — downtrends often accelerate
❌ Do NOT buy dips — "value buying" in a downtrend is how accounts blow up
❌ Do NOT short the gap-down candle — wait for retracement first`,

  ranging: `Today is a RANGE DAY. Price is oscillating between defined high and low. Path efficiency is low.

Your playbook:
✅ Fade extremes — buy near range low, sell near range high
✅ Use multi-touch levels — more prior tests = stronger level
✅ Targets are the OPPOSITE side of the range
❌ Do NOT trade the middle of the range — no edge there
❌ Do NOT chase breakouts that don't have volume — most fail and reverse

Range days require patience. Wait for price to come to you at the extremes.`,

  choppy: `Today is CHOPPY. No clear direction. Path efficiency under 18% means most bar-to-bar movement is noise.

The hardest lesson in trading: **doing nothing is a position.** The choppy day's edge is recognizing it and standing aside.

What NOT to do:
❌ Force trades because you're bored
❌ "Scalp the noise" — slippage and spread eat all your edge
❌ Convince yourself you see a setup that isn't there

What to do instead:
✅ Watch and learn — observe how markets behave when there's no edge
✅ Review previous trades — journal what worked
✅ Walk away — protect mental capital for the next clean day`,

  parabolic: `The market is PARABOLIC — a vertical move that's gone too far too fast. ATR is way above normal, range expansion is extreme.

The trap: thinking "I have to get in before it leaves without me."

The reality: parabolic moves end with brutal reversals. The risk:reward of chasing is terrible — you're entering near the top with no defined stop.

Your options:
✅ Wait for retracement — even after parabolic moves, price typically pulls back 30-50%
✅ Trade the SHORT side cautiously after first lower-high forms
❌ Do NOT enter in the direction of the parabolic move
❌ Do NOT short the strength — wait for confirmed reversal pattern first`,
};

// ─── COMPONENT LESSONS — why each scoring dimension matters ──────────────────

export const COMPONENT_LESSONS = {
  'Trend alignment': 'Trades WITH the trend have ~2x the win rate of counter-trend. The bot rewards 2pts when EMA stack is fully aligned (EMA20 > EMA50 > EMA200 for long), 1pt for partial. Counter-trend = 0pts and a uphill battle.',
  'Volume confirmation': 'Without volume, breakouts are usually fake. Real moves need real participation. Volume ≥ 1.5× the 20-bar average = institutional involvement. Trades without volume have far higher fakeout/stop-out rates.',
  'Distance from level': 'A trade AT a key level (PDH, VWAP, pivot) has structural reason. A trade in the middle of nowhere is just hope. The bot wants you AT a major level (≥3 weight) within 0.5%, not chasing 2% past it.',
  'Entry quality': 'A clean bullish reaction bar (close near high, > open) shows buyers stepping in. A weak doji or bearish bar shows hesitation. The reaction bar is the difference between catching a knife and catching a bounce.',
  'Reward/Risk': 'Math: with 50% win rate and 2:1 R:R, you make money. With 50% win rate and 1:1 R:R, you barely break even after fees. R:R below 1.5:1 means even high win rate isn\'t enough.',
  'Structure clarity': 'In a clear trending or ranging regime, setups have higher win rates because there\'s an underlying structural force pushing in your direction. In choppy regimes, even "good" patterns fail randomly.',
  'Not extended': 'Mean reversion is a thing — moves that go too far too fast tend to revert. Entering at the END of a 2× ATR move means buying near the local exhaustion point. Wait for retracement.',
};

// ─── COMMON MISTAKES — generic + situation-aware ─────────────────────────────

export const COMMON_MISTAKES = {
  generic: [
    'Moving stops further away when the trade goes against you ("just give it more room") — turns small losses into account-killers',
    'Adding to losers ("averaging down") — pyramids losses, breaks the original risk plan',
    'Skipping the stop entirely "because I\'m watching" — your discipline collapses fastest exactly when it matters most',
    'Revenge trading after a stop-out — the next setup looks worse because you\'re emotional',
    'Sizing UP after winners ("hot streak") — variance catches up; you give back the run on the next loss',
    'Ignoring time of day — the first/last 90 min of a session have edge; mid-day is mostly noise',
    'Trading without a journal — you can\'t improve what you don\'t measure',
  ],
  byRegime: {
    'trending-up':   ['Shorting strength because "it\'s overdue for a pullback"', 'Selling winners at first sign of red — small dips are buy zones in trend days, not exits'],
    'trending-down': ['Buying dips because "it\'s cheap" — markets can stay irrational longer than you can stay solvent', 'Catching falling knives — wait for confirmed reversal'],
    'ranging':       ['Trading breakouts that don\'t have volume — they almost always fail in ranging markets'],
    'choppy':        ['Forcing trades because nothing is happening — choppy days are journal/study days, not trade days'],
    'parabolic':     ['Buying the top because "FOMO" — parabolic = literally the worst-R:R entry possible'],
  },
};

// ─── Helpers — pluck a lesson for the analysis output ────────────────────────

/**
 * Build a "Today's Lesson" educational block tailored to the current analysis.
 * Returns a multi-line string ready to print or send to Telegram.
 */
export function teachAnalysis(result) {
  const o = result.output;
  const setupName = result.best?.setup?.name;
  const regimeType = result.regime?.type;

  const blocks = [];

  // 1. Regime lesson — always relevant
  if (regimeType && REGIME_LESSONS[regimeType]) {
    blocks.push(`📚 TODAY'S REGIME — ${o.marketCondition}\n\n${REGIME_LESSONS[regimeType]}`);
  }

  // 2. Setup lesson — only if a setup was detected
  if (setupName && SETUP_LESSONS[setupName]) {
    blocks.push(`🎯 SETUP DEEP DIVE — ${setupName}\n\n${SETUP_LESSONS[setupName]}`);
  }

  // 3. Decision-specific teaching
  if (o.decision === 'NO TRADE') {
    blocks.push(`🛑 WHY "NO TRADE" IS A WIN

Sitting still IS the trade right now. The data says no clean setup is forming, and the math says forcing a trade at this moment has negative expectancy.

Pros track "trades not taken" as a metric. Every trade you DON'T take that would have lost = a win for your account.

The single most underrated skill in trading is patience. Use this time to:
  • Review prior trades in your journal
  • Watch how price reacts at the levels you marked
  • Study the chart instead of trading it

When the next clean A+ setup forms, you'll have full capital and a clear head to take it.`);
  } else if (o.decision === 'WATCHLIST ONLY') {
    blocks.push(`👀 WHY "WATCHLIST ONLY"

The setup is forming but isn't yet at A+ quality. One or two confluences are missing. Front-running it (entering before all conditions align) has historically bad expectancy.

The right move: keep this on your watchlist. Re-evaluate when the missing conditions trigger. Don't enter early just because "it might fire."

If it fires fully = you take it. If it doesn't = no harm, no missed cost.`);
  } else if (o.decision === 'LONG' || o.decision === 'SHORT') {
    blocks.push(`✅ WHY THIS IS TRADEABLE

The bot ran the setup through 7 quality checks and 5 strict filters. It hit ${o.setupScore}/10 — above the 6.5 threshold for "tradeable" — without tripping any rejection rule.

Reminder before you click:
  • Place stop FIRST (broker-side, not mental)
  • Risk only what's in the position size — never increase mid-trade
  • Take 50% off at T1 — never give back 1R+ profit
  • If 5 minutes pass and the trade hasn't moved your way, exit (timestop)`);
  }

  // 4. Component breakdown — so user learns what scored well/poorly
  if (result.best?.score?.components) {
    const compLines = ['📊 SCORE BREAKDOWN — what passed and what didn\'t'];
    compLines.push('');
    for (const c of result.best.score.components) {
      const bar = '▓'.repeat(Math.round(c.score * 2)) + '░'.repeat(Math.round((c.max - c.score) * 2));
      compLines.push(`  ${c.name.padEnd(22)} ${bar} ${c.score}/${c.max}  — ${c.note}`);
    }
    compLines.push('');
    compLines.push('Each component teaches you something to watch on the next setup.');
    blocks.push(compLines.join('\n'));
  }

  // 5. Common mistake watch — situation-aware
  const regimeMistakes = COMMON_MISTAKES.byRegime[regimeType] ?? [];
  const mistake = regimeMistakes[0] ?? COMMON_MISTAKES.generic[Math.floor(Date.now() / 60_000) % COMMON_MISTAKES.generic.length];
  blocks.push(`⚠️  COMMON MISTAKE TO AVOID RIGHT NOW\n\n${mistake}`);

  return blocks.join('\n\n' + '─'.repeat(70) + '\n\n');
}

/**
 * Look up a single concept and return a layered explanation:
 *   1. One-line glossary definition
 *   2. Deep-dive paragraph if available
 *   3. Related glossary terms
 */
export function teachConcept(term) {
  const key = String(term).trim();
  // Try exact match, then case-insensitive
  const direct = GLOSSARY[key];
  const ciKey = Object.keys(GLOSSARY).find(k => k.toLowerCase() === key.toLowerCase());
  const oneLiner = direct ?? (ciKey ? GLOSSARY[ciKey] : null);

  const conceptKey = Object.keys(CONCEPTS).find(k => k.toLowerCase() === key.toLowerCase());
  const deep = conceptKey ? CONCEPTS[conceptKey] : null;

  if (!oneLiner && !deep) {
    const closest = Object.keys(GLOSSARY).filter(k => k.toLowerCase().includes(key.toLowerCase())).slice(0, 3);
    return closest.length
      ? `Term "${term}" not found. Did you mean: ${closest.join(', ')}?`
      : `Term "${term}" not found. Try /glossary to see all terms.`;
  }

  const out = [];
  out.push(`📖 ${ciKey ?? conceptKey ?? term}`);
  out.push('');
  if (oneLiner) {
    out.push(oneLiner);
    out.push('');
  }
  if (deep) {
    out.push(deep);
  }
  return out.join('\n');
}

/** Print every glossary term as a quick reference card. */
export function fullGlossary() {
  const lines = ['📖 GLOSSARY — every term used by the coach', ''];
  for (const [term, def] of Object.entries(GLOSSARY).sort()) {
    lines.push(`  ${term.padEnd(20)} ${def}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── CLI for quick lookup ────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.slice(2).join(' ');
  if (!arg || arg === '--all') {
    console.log(fullGlossary());
  } else {
    console.log(teachConcept(arg));
  }
}
