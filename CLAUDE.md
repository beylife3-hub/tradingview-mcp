# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A local bridge that exposes a running **TradingView Desktop** app to Claude (or any tool consumer) via two transports:

- **MCP server** over stdio (`src/server.js`) — 78 tools registered for Claude Code
- **`tv` CLI** (`src/cli/index.js`) — JSON-output commands that mirror the MCP tools

Both transports are thin wrappers that call into shared logic in `src/core/*.js`. Communication with TradingView happens over **Chrome DevTools Protocol on `localhost:9222`** — there is no network call to TradingView's servers and no separate process. The user must launch TradingView Desktop with `--remote-debugging-port=9222` for any tool to work.

```
Claude Code  ←→  MCP Server (stdio)  ┐
                                     ├─→  src/core/*.js  ─→  CDP (port 9222)  ─→  TradingView Desktop
              tv CLI (stdout JSON)   ┘
```

There is **no build step** (pure ESM, `"type": "module"`) and only two runtime dependencies: `@modelcontextprotocol/sdk` and `chrome-remote-interface`.

## Common Commands

```bash
npm start                # run the MCP server (stdio)
npm run tv -- <cmd>      # run the CLI directly without npm link
node src/cli/index.js status   # equivalent

# Tests
npm test                 # e2e + pine_analyze (e2e REQUIRES TradingView running on :9222)
npm run test:unit        # offline only — pine_analyze + cli tests
npm run test:cli         # CLI routing/help tests only (offline)
npm run test:e2e         # e2e against a live TradingView instance
npm run test:all         # everything in package.json
npm run test:verbose     # spec reporter on e2e + pine_analyze

# Run a single test file
node --test tests/sanitization.test.js
node --test tests/replay.test.js

# Run a single test by name
node --test --test-name-pattern="safeString" tests/sanitization.test.js
```

Note the `npm test` script **does include** the e2e suite — for offline iteration use `npm run test:unit`. CONTRIBUTING.md's "29 offline tests" claim is out of date; trust the script names in `package.json`. `tests/sanitization.test.js` and `tests/replay.test.js` are not wired into any npm script — invoke them directly.

## Architecture

### Three-layer module pattern

Every capability area (chart, pine, data, drawing, replay, …) is implemented as **three parallel files**:

| Layer | Path | Role |
|-------|------|------|
| Core logic | `src/core/<area>.js` | Pure async functions. Take plain options objects, return plain JS objects, **throw** on failure. No MCP, no CLI, no formatting. |
| MCP tool | `src/tools/<area>.js` | Registers `server.tool(...)` entries with Zod schemas. Wraps core calls in `try/catch` and `jsonResult(...)`. |
| CLI command | `src/cli/commands/<area>.js` | Calls `register(name, { handler, options })` from `src/cli/router.js`. Handler returns the same plain object the core function returns; the router prints it as JSON. |

When adding a feature, write the logic in `src/core/`, then thread it through both `src/tools/` and `src/cli/commands/` so MCP and CLI stay 1:1. `src/core/index.js` re-exports core modules as the package's public API (`tradingview-mcp/core`).

### Connection module (`src/connection.js`)

Single source of truth for all CDP interaction. Holds a singleton `client`, runs a liveness check on reuse, and reconnects with exponential backoff (5 retries, base 500ms, capped at 30s).

- `evaluate(expr)` / `evaluateAsync(expr)` — run JS in the TradingView page and return the value. **All core modules use these**, never the raw CDP client.
- `KNOWN_PATHS` — central registry of internal TradingView object paths discovered via probing (e.g. `window.TradingViewApi._activeChartWidgetWV.value()`). When you find a new path, add it here rather than inlining a string in core code.
- `safeString(str)` — wraps `JSON.stringify` to produce a safely-escaped JS string literal for interpolation into evaluated code. **Use this for any user-supplied string** that ends up inside an `evaluate(...)` template literal — failing to do so is a CDP injection bug.
- `requireFinite(value, name)` — throws on `NaN`/`Infinity`/non-numeric. Use it before sending numeric input to TradingView APIs that mutate cloud-persisted state (visible range, alerts, drawings).

`tests/sanitization.test.js` audits core modules to catch unsanitized interpolation — keep it green.

### Server registration (`src/server.js`)

The `instructions` block passed to `new McpServer(...)` is the **runtime tool selection guide** the model sees when choosing tools. Update it (and the table below) when adding/removing/renaming tools. Tool count: 78.

### CLI router (`src/cli/router.js`)

Zero-dependency router built on `node:util` `parseArgs`. Supports two-level commands (`tv pine compile`) via the `subcommands` Map on a registered command. Exit codes: `0` success, `1` error, `2` connection failure (matched on `/CDP|connection|ECONNREFUSED|not running/i`). Output is always pretty-printed JSON to stdout.

### Chart-readiness gating (`src/wait.js`)

After mutating chart state (symbol/timeframe change, indicator add), the chart can take seconds to redraw and old data is briefly visible. `waitForChartReady(symbol?, tf?, timeout?)` polls for: no loading spinner present, expected symbol in the legend, and stable bar count for two consecutive polls. Mutating core functions should call this before reading data back. Returns `false` on timeout but does not throw — callers should still verify.

## CDP Conventions

- **Unwrap `WatchedValue`**: many TradingView APIs return `{ value: () => actual }` wrappers. The pattern is `(v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v`. Pre-existing helpers do this; mirror them.
- **Pine graphics path**: custom-indicator drawings live at `study._graphics._primitivesCollection.dwg{lines,labels,boxes,tablecells}.get('<key>').get(false)._primitivesDataById`. The Pine drawing readers (`data_get_pine_*`) walk this. Indicators must be **visible on chart** for these primitives to populate — hidden studies return empty.
- **`_deps` injection**: core mutators accept an optional `_deps` parameter to swap `evaluate`/`evaluateAsync`/`waitForChartReady` for unit testing without a live chart (see `tests/sanitization.test.js`). Preserve this pattern when editing core functions.
- **Caps**: OHLCV ≤ 500 bars, trades ≤ 20, pine labels ≤ 50/study by default. Don't loosen without a reason.
- **Output shape**: every tool returns `{ success: true/false, ... }`. Errors return `{ success: false, error, hint? }` and the MCP wrapper passes `isError: true` to `jsonResult`.
- **Indicator names**: `chart_manage_indicator` requires the **full TradingView name** (`"Relative Strength Index"`, `"Moving Average Exponential"`, `"Bollinger Bands"` — not `"RSI"`/`"EMA"`/`"BB"`). Surface this in any new tool that takes an indicator name.

## Runtime Tool Decision Tree (for sessions that consume this MCP server)

When a Claude session has this MCP server attached, follow this routing:

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators
3. `quote_get` → real-time price snapshot (last, OHLC, volume)

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()` / `label.new()` / `table.new()` / `box.new()`. These are invisible to standard data tools — use the pine graphics readers:

1. `data_get_pine_lines` → horizontal price levels (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices ("PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table rows (session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones as `{high, low}` pairs

Always pass `study_filter: "<substring>"` when you know which indicator you want.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg vol, last 5 bars)
- `data_get_ohlcv` without summary → all bars (cap with `count`, default 100, max 500)
- `quote_get` → single latest snapshot

### "Analyze my chart" (full report)
`quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `data_get_pine_tables` → `data_get_ohlcv` (summary) → `capture_screenshot`

### "Change the chart"
- `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`
- `chart_manage_indicator` (full names only)
- `chart_scroll_to_date` (ISO `"2025-01-15"`), `chart_set_visible_range` (unix seconds)

### "Work on Pine Script"
1. `pine_set_source` → inject code
2. `pine_smart_compile` → compile + auto-detect errors
3. `pine_get_errors` / `pine_get_console`
4. `pine_save` / `pine_new` / `pine_open`
5. `pine_get_source` only when you actually need to read existing code (can be 200KB+)
6. `pine_analyze` and `pine_check` are offline (no chart needed)

### "Practice with replay"
`replay_start` (date) → `replay_step` / `replay_autoplay` → `replay_trade` (buy/sell/close) → `replay_status` → `replay_stop`

### "Screen multiple symbols"
`batch_run` with `symbols: [...]` and `action: "screenshot" | "get_ohlcv"`. For multi-pane comparison, use `pane_set_layout` (`s`, `2h`, `2v`, `2x2`, `4`, `6`, `8`) + `pane_set_symbol` per pane.

### "Draw / alerts / UI"
- `draw_shape` (`horizontal_line`, `trend_line`, `rectangle`, `text`), `draw_list`, `draw_remove_one`, `draw_clear`
- `alert_create` (`crossing` / `greater_than` / `less_than`), `alert_list`, `alert_delete`
- `ui_open_panel` (pine-editor, strategy-tester, watchlist, alerts, trading), `ui_click`, `ui_evaluate`, `layout_switch`, `ui_fullscreen`

### "TradingView isn't running"
`tv_launch` (auto-detects on Mac/Win/Linux) → `tv_health_check`. If `cdp_connected: false`, the user needs `--remote-debugging-port=9222` on their TradingView launch.

## Context-Management Rules (when consuming the tools)

These tools can return large payloads — follow these to avoid blowing context:

1. **Always pass `summary: true` to `data_get_ohlcv`** unless you genuinely need individual bars.
2. **Always pass `study_filter`** to pine readers when you know the indicator name.
3. **Never pass `verbose: true`** to pine readers unless the user explicitly asks for raw drawing data with IDs/colors.
4. **Avoid `pine_get_source`** on complex scripts — read only when editing.
5. **Avoid `data_get_indicator`** on protected/encrypted indicators (their inputs are encoded blobs); use `data_get_study_values` for current values.
6. **Prefer `capture_screenshot`** (~300 bytes — returns a file path) over pulling large datasets when visual context is what's actually needed.
7. **Call `chart_get_state` once** at the start; entity IDs are stable within a session — don't refetch.
8. **Cap OHLCV** — `count: 20` for quick checks, `100` for deeper work, `500` only when needed.

### Output size cheatsheet

| Tool | Typical |
|------|---------|
| `quote_get` | ~200 B |
| `data_get_study_values` | ~500 B |
| `data_get_pine_lines` | 1–3 KB / study |
| `data_get_pine_labels` | 2–5 KB / study (capped at 50) |
| `data_get_pine_tables` | 1–4 KB / study |
| `data_get_pine_boxes` | 1–2 KB / study |
| `data_get_ohlcv` (summary) | ~500 B |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 B (path only) |

## Scope Constraints (from CONTRIBUTING.md)

Out of scope and **must not** be added:

- Direct connections to TradingView's servers (everything goes through the local Desktop app via CDP)
- Bypassing authentication or subscription restrictions
- Scraping/caching/redistributing market data (no databases, no CSV exports of price data)
- Automated trading or order execution (chart reading and Pine development only; replay trading is simulated)
- Bundling or redistributing TradingView's proprietary code
- Accessing other users' private scripts/watchlists/account info
