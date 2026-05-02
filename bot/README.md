# TradingView Day-Trading Bot

> Top-tier rule-based + adaptive day trading platform. Reads your live TradingView chart, produces strict 17-line trade plans, draws on the chart, alerts your phone, learns from your journal, blocks during news/VIX spikes, and validates everything statistically.

## Quickstart

**One command** starts the entire bot stack:

```bash
node bot/orchestrator.js
```

This launches: TradingView (with CDP), live-stream-coach, telegram-bot, web-dashboard, and health-monitor — in that order, with health checks between steps.

| Service | Port | What it does |
|---|---|---|
| TradingView | 9222 (CDP) | Live chart data via Chrome DevTools Protocol |
| Live-stream coach | — | Polls every 2s, draws BUY/SELL/STOP/T1, sends Telegram alerts |
| Telegram bot | — | 13 two-way commands (`/help` from your phone) |
| Web dashboard | 8766 | Real-time SSE-powered dashboard |
| Health monitor | — | Watches everything, alerts on failures |

To stop: `Ctrl+C` or `node bot/orchestrator.js --stop`

## Architecture

35 modules organized across 7 tiers:

### Core (always-on)
- `coach.js` — main analyzer, 9-stage pipeline, strict 17-line output
- `live-stream.js` — 2-second polling + Telegram + chart drawing
- `engine.js` — indicators (EMA, SMA, RSI, MACD, BB, ATR, VWAP, Stochastic)
- `levels.js` — PDH/PDL/PMH/PML/ORH/ORL + pivot clusters
- `regime.js` — trending/ranging/choppy/parabolic classifier
- `setups.js` — 9 setup detectors + multi-bar confirmation
- `scoring.js` — 8-component score + strict filters + adaptive multipliers
- `education.js` — 35-term glossary + concept deep-dives + lessons
- `draw-plan.js` — chart annotations
- `notify.js` — Telegram (Markdown w/ plain-text fallback)
- `setup-telegram.js` — chat-ID auto-discovery

### Tier 1 — Foundation
- `journal.js` — persistent trade log + plan adherence stats
- `position-tracker.js` — POSITION HELD mode (stops "BUY HERE" while in trade)
- `protections.js` — 6 circuit breakers (Freqtrade-style)
- `telegram-bot.js` — 13 phone commands (/status /scan /pause /entered /exited)

### Tier 4 — Validation
- `backtest.js` — bar-by-bar simulator + IC + walk-forward + permutation + Monte Carlo + synthetic price paths
- `hyperopt.js` — grid search + TPE Bayesian + 6 loss functions
- `replay-backtest.js` — TradingView replay-mode integration

### Tier 2 — Signal Quality
*(merged into coach.js, setups.js, scoring.js)*
- HTF multi-timeframe bias (auto-switch)
- Multi-bar confirmation gate
- Time-of-day session filter (NY lunch chop penalty)
- 4 additional setup detectors (Flag, Double Top/Bottom, Gap Fill, EOD Fade)

### Tier 3 — Context
- `volume-profile.js` — POC + VAH/VAL + chop zone detection
- `news-filter.js` — scheduled events + spike heuristic

### Tier 5 — Polish
- `scan.js` — multi-symbol watchlist scanner with Telegram digest
- `daily-summary.js` — end-of-day Telegram recap
- `dashboard.js` — static HTML report (one-shot snapshot)
- `quiz.js` — self-assessment mode

### Tier 6 — Top 1%
- `adaptive-weights.js` — online learning of per-setup expectancy
- `auto-tune.js` — scheduled hyperopt + per-symbol param auto-deploy
- `portfolio-risk.js` — total heat + correlation + Kelly sizing + VaR/CVaR
- `anomaly-detector.js` — z-score black-swan halt
- `ensemble.js` — 4-voter multi-strategy
- `health-monitor.js` — bot watching itself
- `orchestrator.js` — single-command stack launcher

### Tier 7 — Top 0.1%
- `vix-integration.js` — fear gauge halt (VIX > 30)
- `news-sentiment.js` — RSS + VADER-style scoring
- `order-flow.js` — CVD + wick absorption + effort/result
- `sector-rotation.js` — 11 SPDR relative strength
- `audit-log.js` — hash-chained immutable decision log
- `bandit.js` — Thompson sampling over (setup × symbol)
- `webhook-alerts.js` — Discord + Slack distribution
- `web-dashboard.js` — live SSE-powered dashboard
- `research-engine.js` — Finviz + sentiment + sector brief per ticker
- `ml-signal.js` — random forest on 10 engineered features

## Setup

### Prerequisites
- Node.js 18+
- TradingView Desktop installed
- macOS (Linux/Windows scripts also exist; see `scripts/`)

### One-time
```bash
# 1. Telegram bot (3 min)
node bot/setup-telegram.js
# Follow on-screen instructions

# 2. (Optional) Discord webhook
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# 3. (Optional) Slack webhook
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

### Run daily
```bash
node bot/orchestrator.js                          # default --aggressive profile
node bot/orchestrator.js --conservative           # strict A+ only
node bot/orchestrator.js --yolo                   # max signals
node bot/orchestrator.js --no-tv                  # if TV already running
node bot/orchestrator.js --status                 # check what's running
node bot/orchestrator.js --stop                   # kill everything
```

### Run individual tools
```bash
# Analysis
node bot/coach.js --risk 100                      # one-shot analysis
node bot/coach.js --explain VWAP                  # learn any concept
node bot/coach.js --glossary                      # all 35 terms

# Multi-symbol
node bot/scan.js --watchlist NVDA,TSLA,AMD,SPY    # rank watchlist by score
node bot/scan.js --aggressive --telegram          # send leaderboard to phone

# Validation
node bot/backtest.js --bars 1000                  # full statistical validation
node bot/hyperopt.js --bars 800 --loss calmar     # find best params
node bot/auto-tune.js --notify-telegram           # nightly per-symbol tune
node bot/replay-backtest.js --date 2025-04-15     # replay-mode test

# Research
node bot/research-engine.js TSLA                  # full research brief
node bot/news-sentiment.js NVDA                   # news sentiment
node bot/order-flow.js                            # CVD + absorption snapshot
node bot/sector-rotation.js                       # SPDR sector RS ranking
node bot/vix-integration.js                       # current VIX + halt verdict
node bot/ml-signal.js --bars 1500 --trees 100     # ML signal generation

# Risk + monitoring
node bot/portfolio-risk.js                        # heat + Kelly + VaR
node bot/protections.js                           # circuit breaker state
node bot/health-monitor.js --once                 # health check
node bot/audit-log.js verify                      # verify hash chain
node bot/bandit.js                                # Thompson arm states

# Reporting
node bot/journal.js stats                         # full journal stats
node bot/journal.js monitor                       # live P&L per open position
node bot/daily-summary.js                         # end-of-day Telegram digest
node bot/dashboard.js --open                      # static HTML report
node bot/quiz.js                                  # self-assessment
```

## Risk profiles

| Profile | TRADE at | WATCHLIST | R:R min | Stop cap | Choppy OK? | Extended OK? |
|---|---|---|---|---|---|---|
| `--conservative` | 7.0 | 5.5 | 2.0:1 | 5% | ❌ | ❌ |
| default | 6.5 | 5.0 | 1.5:1 | 7% | ❌ | ❌ |
| `--aggressive` | 5.5 | 4.0 | 1.2:1 | 10% | ✅ | ✅ |
| `--yolo` | 4.5 | 3.0 | 1.0:1 | 12% | ✅ | ✅ |

## Key safety features (always on, regardless of profile)

- 🚨 VIX > 30 = halt
- 🚨 Anomaly z-score (5σ range, 5σ vol, 4σ return, 3σ ATR) = halt
- 🚨 Parabolic regime = always rejects
- 🚨 News risk (FOMC/CPI/NFP) ±30 min = halt
- 🚨 Bearish news cluster (sentiment < -0.4) = halt LONGs
- 🚨 Portfolio heat ≥ 5% = halt new entries
- 🚨 Stoploss guard: 3 stops in 60min = 2h cooldown
- 🚨 Daily DD > -3% = halt rest of day
- 🚨 Adaptive auto-ban: setup with -0.20R expectancy on 10+ trades = banned

## What this bot CAN'T do

Honest gaps:

- ❌ Real broker API execution — you still hit BUY in TradingView yourself
- ❌ L2 order book data — TradingView doesn't expose it
- ❌ Sub-millisecond fills — different infrastructure needed
- ❌ Predict the future — it pattern-matches with statistically validated edge

These limits are mostly inherent to running on TradingView. To close them you'd need a different platform (Alpaca/IBKR + own infrastructure).

## Backups

The bot is saved in 4 places so it can never be magically deleted:

1. **GitHub:** https://github.com/beylife3-hub/tradingview-mcp/tree/claude/day-trading-bot-v2
2. **Local git branch:** `~/tradingview-mcp/bot/`
3. **Local backups:** `~/tradingview-bot-*` folders
4. **Obsidian vault:** `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memories for claude/Trading Bot/`

## License

Same as parent repo (see /LICENSE).
