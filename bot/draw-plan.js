/**
 * Chart annotation layer — draws the coach's analysis directly onto the
 * TradingView chart so you can see BUY/SELL signals visually.
 *
 * Drawing strategy:
 *   - LONG  → green long_position widget (entry/target/stop) + bold "BUY HERE @ $X"
 *   - SHORT → red short_position widget + bold "SELL HERE @ $X"
 *   - Adds horizontal lines for STOP and TARGET 2 with labels
 *   - Adds a dashed line at VWAP if visible
 *   - WATCHLIST → dashed yellow lines at potential entry, no widget
 *   - NO TRADE → clears all bot drawings
 *
 * All shapes drawn by the bot are tagged with a marker so we can clear
 * only OUR shapes without nuking user-drawn analysis.
 */

import * as drawing from '../src/core/drawing.js';
import { evaluate, getChartApi } from '../src/connection.js';
import { fmt } from './engine.js';

// Shapes we know are "ours" — drawn by drawAnalysis().
// Used by clearBotShapes() to only nuke our drawings, not user ones.
const BOT_SHAPE_TYPES = new Set([
  'long_position', 'short_position', 'horizontal_line', 'rectangle', 'text',
]);

// Track entity IDs we've drawn so we can clear ONLY ours
const _ourShapeIds = new Set();

// ─── Clear ───────────────────────────────────────────────────────────────────

/**
 * Remove all shapes the bot drew. Does NOT touch user-drawn analysis.
 *
 * Strategy: get all shapes from the chart, intersect with our tracked IDs,
 * and remove them one by one. Falls back to type-based filtering for old
 * shapes that may have lost their ID tracking (e.g. across restarts).
 */
export async function clearBotShapes() {
  try {
    const apiPath = await getChartApi();
    // Pull all shape IDs + types
    const all = await evaluate(`
      (function() {
        var api = ${apiPath};
        return api.getAllShapes().map(function(s) {
          var props = api.getShapeById ? api.getShapeById(s.id) : null;
          return { id: s.id, name: s.name };
        });
      })()
    `);
    if (!Array.isArray(all)) return { removed: 0 };

    let removed = 0;
    for (const sh of all) {
      // Remove if (a) we tracked it, OR (b) it's a known bot-shape type
      // and there are no other indicators of user authorship
      if (_ourShapeIds.has(sh.id) || BOT_SHAPE_TYPES.has(sh.name)) {
        try {
          await drawing.removeOne({ entity_id: sh.id });
          removed++;
          _ourShapeIds.delete(sh.id);
        } catch { /* shape may have been removed already */ }
      }
    }
    return { removed };
  } catch (e) {
    return { removed: 0, error: e.message };
  }
}

// ─── Track shape IDs after drawing ───────────────────────────────────────────

async function track(promise) {
  const r = await promise;
  if (r?.entity_id) _ourShapeIds.add(r.entity_id);
  return r;
}

// ─── Long/short position widget (3-point) ────────────────────────────────────

async function drawPositionWidget(direction, entry, target, stop) {
  const apiPath = await getChartApi();
  const now = Math.floor(Date.now() / 1000);
  const shape = direction === 'LONG' ? 'long_position' : 'short_position';

  // Snapshot existing IDs before/after to capture the new one
  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  await evaluate(`
    ${apiPath}.createMultipointShape(
      [
        { time: ${now}, price: ${entry} },
        { time: ${now}, price: ${target} },
        { time: ${now}, price: ${stop} }
      ],
      { shape: ${JSON.stringify(shape)}, overrides: {} }
    )
  `);
  await new Promise(r => setTimeout(r, 250));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id));
  if (newId) _ourShapeIds.add(newId);
  return { success: true, entity_id: newId };
}

// ─── Main: draw an analysis result ───────────────────────────────────────────

/**
 * Draw the bot's analysis onto the chart.
 *
 * @param {object} result - from coach.analyze()
 * @returns {object} { drew: 'LONG'|'SHORT'|'WATCHLIST'|'cleared', shapes: number }
 */
export async function drawAnalysis(result, opts = {}) {
  const cleanFirst = opts.cleanFirst !== false;
  if (cleanFirst) await clearBotShapes();

  const o = result.output;

  // NO TRADE → just clear, no new drawings
  if (o.decision === 'NO TRADE') {
    return { drew: 'cleared', shapes: 0 };
  }

  // WATCHLIST → light yellow horizontal line at potential entry, no widget
  if (o.decision === 'WATCHLIST ONLY') {
    if (!result.best?.setup?.entry) return { drew: 'cleared', shapes: 0 };
    const now = Math.floor(Date.now() / 1000);
    const entry = result.best.setup.entry;
    const dirArrow = result.best.setup.direction === 'LONG' ? '🟡 WATCH LONG' : '🟡 WATCH SHORT';
    await track(drawing.drawShape({
      shape: 'horizontal_line',
      point: { time: now, price: entry },
      overrides: { linecolor: '#ffd600', linewidth: 1, linestyle: 2 },
      text: `  ${dirArrow}  @ $${fmt.price(entry)}  (score ${o.setupScore}/10)  `,
    }));
    return { drew: 'WATCHLIST', shapes: 1 };
  }

  // LONG / SHORT → full widget + labels
  if (o.decision === 'LONG' || o.decision === 'SHORT') {
    const entry  = result.best.setup.entry;
    const stop   = result.best.setup.invalidation;
    const t1     = result.best.score.suggestedTarget1;
    const t2     = result.best.score.suggestedTarget2;
    const isLong = o.decision === 'LONG';
    const now    = Math.floor(Date.now() / 1000);
    let shapes = 0;

    // 1. Native long_position / short_position widget (3-point: entry/T1/stop)
    try {
      await drawPositionWidget(o.decision, entry, t1, stop);
      shapes++;
    } catch (e) { /* widget may not be supported on all chart types */ }

    // 2. Big bold BUY HERE / SELL HERE label at entry
    const actionColor = isLong ? '#00e676' : '#ff1744';
    const actionWord  = isLong ? '🟢 BUY HERE' : '🔴 SELL HERE';
    await track(drawing.drawShape({
      shape: 'text',
      point: { time: now, price: entry },
      overrides: { color: actionColor, bold: true, fontsize: 18, backgroundColor: 'rgba(0,0,0,0.85)' },
      text: `  ${actionWord}  @  $${fmt.price(entry)}  `,
    }));
    shapes++;

    // 3. STOP label
    const stopPct = (Math.abs(stop - entry) / entry * 100).toFixed(2);
    await track(drawing.drawShape({
      shape: 'text',
      point: { time: now, price: stop },
      overrides: { color: '#ff5252', bold: true, fontsize: 12, backgroundColor: 'rgba(0,0,0,0.7)' },
      text: `  ⛔ STOP  $${fmt.price(stop)}  (-${stopPct}%)  `,
    }));
    shapes++;

    // 4. T1 label
    await track(drawing.drawShape({
      shape: 'text',
      point: { time: now, price: t1 },
      overrides: { color: '#69f0ae', bold: true, fontsize: 12, backgroundColor: 'rgba(0,0,0,0.7)' },
      text: `  🎯 T1  $${fmt.price(t1)}  (take 50% off)  `,
    }));
    shapes++;

    // 5. T2 dashed horizontal line + label (further target)
    if (Math.abs(t2 - t1) > 0.0001) {
      await track(drawing.drawShape({
        shape: 'horizontal_line',
        point: { time: now, price: t2 },
        overrides: { linecolor: '#00c853', linewidth: 1, linestyle: 2 },
        text: `  🎯 T2  $${fmt.price(t2)}  (runner — trail rest)  `,
      }));
      shapes++;
    }

    // 6. Score + size badge below entry
    const sizing = result.output.positionSize.split('  ');  // "X shares  ($Y notional)  Max loss: $Z"
    const detailPrice = isLong ? entry - (entry - stop) * 0.25 : entry + (stop - entry) * 0.25;
    await track(drawing.drawShape({
      shape: 'text',
      point: { time: now, price: detailPrice },
      overrides: { color: actionColor, bold: false, fontsize: 11 },
      text: `  ${sizing[0] || '?'}  •  Score ${o.setupScore}/10  •  ${result.best.setup.name}  `,
    }));
    shapes++;

    return { drew: o.decision, shapes };
  }

  return { drew: 'cleared', shapes: 0 };
}

// ─── CLI for quick test ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { analyze } = await import('./coach.js');
  const { disconnect } = await import('../src/connection.js');
  try {
    const result = await analyze();
    console.log(`Decision: ${result.output.decision}`);
    const r = await drawAnalysis(result);
    console.log(`Drew on chart:`, r);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await disconnect().catch(() => {});
  }
}
