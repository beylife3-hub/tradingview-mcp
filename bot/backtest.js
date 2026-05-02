#!/usr/bin/env node
/**
 * Backtest Harness — bar-by-bar simulator + statistical validation.
 *
 * Answers the only question that matters: "Does this bot have measurable
 * edge or am I curve-fitting?"
 *
 * Pipeline:
 *   1. Pull N bars from current chart
 *   2. Pre-compute features per bar
 *   3. Bar-by-bar simulate(): run analyzer, take paper trades, track exits
 *   4. Compute full metrics (Sharpe, Sortino, Calmar, PF, expectancy, max DD)
 *   5. IC analysis — Spearman ρ per factor per horizon + p-value
 *   6. Walk-forward — split into 4 windows, count positive-Sharpe windows
 *   7. Permutation test — 500 shuffles of forward returns, p-value on Sharpe
 *   8. Monte Carlo — 1000 trade-order shuffles, equity curve percentiles
 *   9. 6-criterion final verdict
 *
 * CLI:
 *   node bot/backtest.js --bars 500 --threshold 6.5 --rr 1.5 --atr-mult 1.5
 *   node bot/backtest.js --bars 800 --no-color
 */

import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

import { ema, sma, rsi, macd, bollinger, atr as atrFn, computeVWAP, mean, stdev } from './engine.js';
import { extractKeyLevels } from './levels.js';
import { classifyRegime } from './regime.js';
import { detectAll } from './setups.js';
import { scoreSetup, applyStrictFilters } from './scoring.js';

// ─── CLI ─────────────────────────────────────────────────────────────────────

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
  bars:        Number(args['--bars']      ?? 500),
  threshold:   Number(args['--threshold'] ?? 6.5),
  rewardRisk:  Number(args['--rr']        ?? 1.5),
  atrMult:     Number(args['--atr-mult']  ?? 1.5),
  maxHoldBars: Number(args['--max-hold']  ?? 20),
  riskPct:     Number(args['--risk-pct']  ?? 1),
  startEquity: Number(args['--equity']    ?? 10000),
  feeBps:      Number(args['--fee-bps']   ?? 5),
  perms:       Number(args['--perms']     ?? 500),
  monteCarlo:  Number(args['--mc']        ?? 1000),
  walkForward: Number(args['--wf']        ?? 4),
  color:       !('--no-color' in args),
};

const C = CONFIG.color
  ? { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' }
  : new Proxy({}, { get: () => '' });

function fmtPct(n) { return Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '?'; }
function fmtNum(n) { return Number.isFinite(n) ? n.toFixed(2) : '?'; }
function fmt$(n)   { return Number.isFinite(n) ? `$${n.toFixed(2)}` : '?'; }

// ─── Stat primitives ─────────────────────────────────────────────────────────

export function rank(arr) {
  const sorted = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) out[sorted[i][1]] = i + 1;
  return out;
}

export function spearman(x, y) {
  const filtered = x.map((v, i) => [v, y[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (filtered.length < 5) return NaN;
  const xs = filtered.map(p => p[0]);
  const ys = filtered.map(p => p[1]);
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  let sumDsq = 0;
  for (let i = 0; i < n; i++) sumDsq += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * sumDsq) / (n * (n * n - 1));
}

// Two-tailed p-value for Spearman ρ via Fisher z-transformation
export function spearmanPValue(rho, n) {
  if (n < 4 || !Number.isFinite(rho)) return 1;
  const z = 0.5 * Math.log((1 + rho) / (1 - rho)) * Math.sqrt(n - 3);
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export function normalCdf(z) {
  // Abramowitz & Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Pre-compute features per bar ────────────────────────────────────────────

export function precomputeFeatures(bars) {
  const closes = bars.map(b => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const a = atrFn(bars, 14);

  return bars.map((bar, i) => ({
    bar, idx: i,
    ema20: e20[i], ema50: e50[i], ema200: e200[i],
    rsi: r[i],
    macd: m.line[i], macdSignal: m.signal[i], macdHist: m.hist[i],
    bbUpper: bb.upper[i], bbMid: bb.ma[i], bbLower: bb.lower[i],
    atr: a[i],
  }));
}

// ─── Bar-by-bar simulator ────────────────────────────────────────────────────

/**
 * Run the analyzer at each bar (using only data up to that bar), execute
 * paper trades, manage exits.
 *
 * Returns: { trades, equityCurve, finalEquity }
 */
export function simulate(bars, opts = {}) {
  const cfg = {
    threshold:   opts.threshold   ?? CONFIG.threshold,
    rewardRisk:  opts.rewardRisk  ?? CONFIG.rewardRisk,
    atrMult:     opts.atrMult     ?? CONFIG.atrMult,
    maxHoldBars: opts.maxHoldBars ?? CONFIG.maxHoldBars,
    riskPct:     opts.riskPct     ?? CONFIG.riskPct,
    startEquity: opts.startEquity ?? CONFIG.startEquity,
    feeBps:      opts.feeBps      ?? CONFIG.feeBps,
    minBars:     opts.minBars     ?? 50,
  };

  const trades = [];
  const equityCurve = [cfg.startEquity];
  let equity = cfg.startEquity;
  let openPos = null;

  for (let i = cfg.minBars; i < bars.length; i++) {
    const sub = bars.slice(0, i + 1);
    const last = sub[sub.length - 1];

    // ─── Manage open position first ──────────────────────────────────────
    if (openPos) {
      const dir = openPos.direction === 'LONG' ? 1 : -1;
      const stopHit   = (dir ===  1 && last.low <= openPos.stop) || (dir === -1 && last.high >= openPos.stop);
      const targetHit = (dir ===  1 && last.high >= openPos.target) || (dir === -1 && last.low <= openPos.target);
      const maxHoldHit = (i - openPos.entryIdx) >= cfg.maxHoldBars;

      let exitPrice = null, reason = null;
      if (stopHit)        { exitPrice = openPos.stop;   reason = 'stop'; }
      else if (targetHit) { exitPrice = openPos.target; reason = 'target'; }
      else if (maxHoldHit){ exitPrice = last.close;     reason = 'max-hold'; }

      if (exitPrice !== null) {
        const move = (exitPrice - openPos.entry) * dir;
        const grossPnl = move * openPos.size;
        const fees = (openPos.entry + exitPrice) * openPos.size * cfg.feeBps / 10_000;
        const pnl = grossPnl - fees;
        const initR = Math.abs(openPos.entry - openPos.stop);
        const rMult = initR > 0 ? move / initR : 0;
        equity += pnl;
        trades.push({
          ...openPos, exitIdx: i, exitPrice, reason, pnl, rMult,
          holdBars: i - openPos.entryIdx,
        });
        openPos = null;
      }
    }

    // ─── Look for new entry (only when flat) ─────────────────────────────
    if (!openPos) {
      try {
        const closes = sub.map(b => b.close);
        const lastBar = sub[sub.length - 1];
        const e20  = ema(closes, 20);
        const e50  = ema(closes, 50);
        const e200 = ema(closes, 200);
        const atrSeries = atrFn(sub, 14);
        const rsiSeries = rsi(closes, 14);
        const vwapResult = computeVWAP(sub, Math.min(78, sub.length));

        const structure = {
          price: lastBar.close,
          open: lastBar.open, high: lastBar.high, low: lastBar.low,
          ema20: e20[e20.length-1], ema50: e50[e50.length-1], ema200: e200[e200.length-1],
          atr:  atrSeries[atrSeries.length-1],
          rsi:  rsiSeries[rsiSeries.length-1],
          vwap: vwapResult?.vwap ?? null,
        };
        const levels = extractKeyLevels(sub, structure);
        const regime = classifyRegime(sub);
        const setups = detectAll(sub, levels, structure);

        const scored = setups.map(setup => {
          const score = scoreSetup(setup, structure, levels, regime, sub, { targetRR: cfg.rewardRisk });
          const rejection = applyStrictFilters({
            setup, score, structure, regime, bars: sub,
            accountRiskDollars: equity * cfg.riskPct / 100,
            targetRR: cfg.rewardRisk, stopCapPct: 7, profile: 'balanced',
          });
          return { setup, score, rejection };
        });
        scored.sort((a, b) => b.score.score - a.score.score);
        const best = scored.find(s => !s.rejection);

        if (best && best.score.score >= cfg.threshold) {
          // Enter at next bar's open (look-ahead-safe)
          const entry = best.setup.entry;
          const stop  = best.setup.invalidation;
          const stopDist = Math.abs(entry - stop);
          if (stopDist > 0) {
            const riskAmount = equity * cfg.riskPct / 100;
            const size = riskAmount / stopDist;
            const target = best.score.suggestedTarget1
                       ?? (best.setup.direction === 'LONG' ? entry + stopDist * cfg.rewardRisk
                                                            : entry - stopDist * cfg.rewardRisk);
            openPos = {
              entryIdx: i, entry, stop, target, size,
              direction: best.setup.direction,
              setup: best.setup.name,
              score: best.score.score,
            };
          }
        }
      } catch (e) { /* skip bar on analyzer error */ }
    }

    equityCurve.push(equity);
  }

  return { trades, equityCurve, finalEquity: equity };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function metrics(trades, equityCurve, startEquity, barsPerYear = 252 * 78) {
  if (trades.length === 0) {
    return { trades: 0, winRate: 0, profitFactor: 0, sharpe: 0, sortino: 0, calmar: 0,
             maxDrawdownPct: 0, totalPnl: 0, totalReturnPct: 0, expectancyR: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const winRate = wins.length / trades.length;
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Bar-by-bar returns from equity curve
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]);
  }
  const r = returns.filter(x => Number.isFinite(x));
  const mu  = mean(r);
  const sig = stdev(r);
  const sharpe = sig > 0 ? (mu / sig) * Math.sqrt(barsPerYear) : 0;

  // Sortino — only downside deviation
  const downside = r.filter(x => x < 0);
  const dSig = downside.length > 1 ? stdev(downside) : sig;
  const sortino = dSig > 0 ? (mu / dSig) * Math.sqrt(barsPerYear) : sharpe;

  // Max drawdown
  let peak = startEquity, maxDD = 0;
  for (const eq of equityCurve) {
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const totalPnl = equityCurve[equityCurve.length-1] - startEquity;
  const totalReturnPct = totalPnl / startEquity;
  const calmar = maxDD > 0 ? totalReturnPct / maxDD : 0;

  // R-multiple expectancy
  const sumR = trades.reduce((s, t) => s + (t.rMult || 0), 0);
  const expectancyR = sumR / trades.length;
  const avgWinR  = wins.length   ? wins.reduce((s,t) => s + t.rMult, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s,t) => s + t.rMult, 0) / losses.length : 0;

  return {
    trades: trades.length,
    winRate, profitFactor, sharpe, sortino, calmar,
    maxDrawdownPct: maxDD * 100,
    totalPnl, totalReturnPct, expectancyR,
    avgWinR, avgLossR,
    grossWin, grossLoss,
  };
}

// ─── IC Analysis ─────────────────────────────────────────────────────────────

export function computeIC(features, horizons = [5, 10, 20]) {
  const factorNames = ['rsi', 'macdHist', 'ema20', 'ema50', 'atr'];
  const out = {};
  for (const h of horizons) {
    out[h] = {};
    const fwdRet = features.map((f, i) => {
      const fwd = features[i + h];
      return fwd ? (fwd.bar.close - f.bar.close) / f.bar.close : NaN;
    });
    for (const name of factorNames) {
      const series = features.map(f => f[name]);
      const rho = spearman(series, fwdRet);
      const validN = series.filter((v, i) => Number.isFinite(v) && Number.isFinite(fwdRet[i])).length;
      const p = spearmanPValue(rho, validN);
      out[h][name] = { rho, p, n: validN };
    }
  }
  return out;
}

// ─── Walk-Forward ────────────────────────────────────────────────────────────

export function walkForward(bars, opts, nWindows = 4) {
  const chunkSize = Math.floor(bars.length / nWindows);
  const windows = [];
  for (let w = 0; w < nWindows; w++) {
    const start = w * chunkSize;
    const end = w === nWindows - 1 ? bars.length : start + chunkSize;
    const sim = simulate(bars.slice(start, end), opts);
    const m = metrics(sim.trades, sim.equityCurve, opts.startEquity ?? CONFIG.startEquity);
    windows.push({ idx: w, range: [start, end], trades: sim.trades.length, ...m });
  }
  return windows;
}

// ─── Permutation Test ────────────────────────────────────────────────────────

export function permutationTest(bars, opts, nPerms = 500) {
  const baseline = simulate(bars, opts);
  const baseM = metrics(baseline.trades, baseline.equityCurve, opts.startEquity ?? CONFIG.startEquity);
  const baseSharpe = baseM.sharpe;

  // Compute returns then shuffle them; rebuild equity curve from shuffled returns
  const closes = bars.map(b => b.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i-1]) / closes[i-1]);
  }

  const shuffledSharpes = [];
  for (let p = 0; p < nPerms; p++) {
    const sh = shuffle(returns);
    let synth = closes[0];
    const synthBars = [{ ...bars[0] }];
    for (let i = 0; i < sh.length; i++) {
      synth = synth * (1 + sh[i]);
      const orig = bars[i + 1] ?? bars[bars.length - 1];
      const ratio = synth / orig.close;
      synthBars.push({
        time: orig.time,
        open:  orig.open  * ratio,
        high:  orig.high  * ratio,
        low:   orig.low   * ratio,
        close: synth,
        volume: orig.volume,
      });
    }
    const sim = simulate(synthBars, opts);
    const m = metrics(sim.trades, sim.equityCurve, opts.startEquity ?? CONFIG.startEquity);
    shuffledSharpes.push(m.sharpe);
  }

  const pVal = shuffledSharpes.filter(s => s >= baseSharpe).length / shuffledSharpes.length;
  return {
    baseSharpe, randomMean: mean(shuffledSharpes), randomStd: stdev(shuffledSharpes),
    pValue: pVal, samples: shuffledSharpes.length,
  };
}

// ─── Monte Carlo (trade-order shuffle) ───────────────────────────────────────

export function monteCarlo(trades, startEquity, nRuns = 1000) {
  if (!trades.length) return null;
  const finals = [];
  const dds = [];
  const sharpes = [];
  for (let r = 0; r < nRuns; r++) {
    const sh = shuffle(trades);
    let eq = startEquity, peak = eq, maxDD = 0;
    const equity = [eq];
    for (const t of sh) {
      eq += t.pnl;
      equity.push(eq);
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
    }
    finals.push(eq);
    dds.push(maxDD * 100);
    const rets = [];
    for (let i = 1; i < equity.length; i++) rets.push((equity[i] - equity[i-1]) / equity[i-1]);
    const m = mean(rets);
    const s = stdev(rets);
    sharpes.push(s > 0 ? (m / s) * Math.sqrt(252 * 78) : 0);
  }
  finals.sort((a,b) => a - b);
  dds.sort((a,b) => a - b);
  sharpes.sort((a,b) => a - b);
  const pct = (arr, p) => arr[Math.floor(arr.length * p)];
  return {
    final5:  pct(finals, 0.05), final50: pct(finals, 0.5), final95: pct(finals, 0.95),
    dd5:     pct(dds, 0.05),    dd50:    pct(dds, 0.5),    dd95:    pct(dds, 0.95),
    sharpe50: pct(sharpes, 0.5),
    ruinProbPct: finals.filter(f => f < startEquity * 0.5).length / finals.length * 100,
  };
}

// ─── Synthetic Price Path Generation ────────────────────────────────────────

/**
 * Block bootstrap — resample blocks of consecutive bars to generate synthetic
 * price paths. Preserves short-term autocorrelation while generating new
 * sequences. Per López de Prado Chapter 12: reveals strategy fragility.
 *
 * If your Sharpe collapses on resampled data, you've overfit.
 *
 * @param {Array} bars - original bars
 * @param {object} opts - { blockSize: how many bars per resample block }
 */
export function blockBootstrap(bars, opts = {}) {
  const blockSize = opts.blockSize ?? 20;
  const targetLen = opts.length ?? bars.length;

  // Generate returns
  const returns = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push((bars[i].close - bars[i-1].close) / bars[i-1].close);
  }

  // Resample blocks of `blockSize` consecutive returns
  const synthReturns = [];
  while (synthReturns.length < targetLen - 1) {
    const start = Math.floor(Math.random() * (returns.length - blockSize));
    for (let i = 0; i < blockSize && synthReturns.length < targetLen - 1; i++) {
      synthReturns.push(returns[start + i]);
    }
  }

  // Build synthetic bars from returns
  const synthBars = [{ ...bars[0] }];
  let currentPrice = bars[0].close;
  for (let i = 0; i < synthReturns.length; i++) {
    currentPrice = currentPrice * (1 + synthReturns[i]);
    const orig = bars[i + 1] ?? bars[bars.length - 1];
    const ratio = currentPrice / orig.close;
    synthBars.push({
      time: orig.time,
      open:  orig.open  * ratio,
      high:  orig.high  * ratio,
      low:   orig.low   * ratio,
      close: currentPrice,
      volume: orig.volume,
    });
  }
  return synthBars;
}

/**
 * Run the strategy on N synthetic price paths and report Sharpe distribution.
 * If real Sharpe is in the top 5% of synthetic paths' Sharpes, edge is real.
 * If real Sharpe is at/below median synthetic Sharpe, you've overfit.
 */
export function syntheticPathTest(bars, opts, nPaths = 100) {
  const baseline = simulate(bars, opts);
  const baseM = metrics(baseline.trades, baseline.equityCurve, opts.startEquity ?? CONFIG.startEquity);
  const baseSharpe = baseM.sharpe;

  const synthSharpes = [];
  for (let p = 0; p < nPaths; p++) {
    const synthBars = blockBootstrap(bars, { blockSize: 20 });
    const sim = simulate(synthBars, opts);
    const m = metrics(sim.trades, sim.equityCurve, opts.startEquity ?? CONFIG.startEquity);
    synthSharpes.push(m.sharpe);
  }

  synthSharpes.sort((a, b) => a - b);
  const pct95 = synthSharpes[Math.floor(nPaths * 0.95)];
  const pct50 = synthSharpes[Math.floor(nPaths * 0.5)];
  const pct05 = synthSharpes[Math.floor(nPaths * 0.05)];
  const realPercentile = synthSharpes.filter(s => s < baseSharpe).length / nPaths;

  return {
    baseSharpe, nPaths,
    synth5th: pct05, synth50th: pct50, synth95th: pct95,
    realIsTopPct: Number((realPercentile * 100).toFixed(1)),
    verdict: realPercentile > 0.95 ? 'EDGE REAL — base Sharpe in top 5% of resampled paths'
           : realPercentile > 0.75 ? 'PROMISING — base Sharpe above 75% of resampled paths'
           : realPercentile > 0.5  ? 'MARGINAL — base Sharpe near median'
           :                          'OVERFIT — base Sharpe below median of resampled paths',
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}BACKTEST HARNESS${C.reset}`);
  console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);

  const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
  if (!ohlcv.success || !ohlcv.bars) throw new Error('Could not fetch bars');
  const bars = ohlcv.bars;
  console.log(`${C.dim}Loaded ${bars.length} bars${C.reset}`);

  // ─── 1. Baseline simulation ───────────────────────────────────────────────
  console.log(`\n${C.cyan}━━━ 1. Baseline simulation ━━━${C.reset}`);
  const sim = simulate(bars, CONFIG);
  const m = metrics(sim.trades, sim.equityCurve, CONFIG.startEquity);
  console.log(`  Trades:           ${m.trades}`);
  console.log(`  Win rate:         ${fmtPct(m.winRate)}`);
  console.log(`  Profit factor:    ${fmtNum(m.profitFactor)}`);
  console.log(`  Sharpe (annual):  ${fmtNum(m.sharpe)}`);
  console.log(`  Sortino (annual): ${fmtNum(m.sortino)}`);
  console.log(`  Calmar:           ${fmtNum(m.calmar)}`);
  console.log(`  Max DD:           ${m.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Expectancy:       ${m.expectancyR >= 0 ? '+' : ''}${m.expectancyR.toFixed(3)}R`);
  console.log(`  Total P&L:        ${m.totalPnl >= 0 ? C.green : C.red}${fmt$(m.totalPnl)}${C.reset}  (${fmtPct(m.totalReturnPct)})`);

  // ─── 2. IC Analysis ────────────────────────────────────────────────────────
  console.log(`\n${C.cyan}━━━ 2. Information Coefficient (Spearman ρ vs forward returns) ━━━${C.reset}`);
  const features = precomputeFeatures(bars);
  const ic = computeIC(features);
  for (const [horizon, factors] of Object.entries(ic)) {
    console.log(`\n  ${C.bold}${horizon}-bar forward${C.reset}:`);
    for (const [name, { rho, p, n }] of Object.entries(factors)) {
      const sigMark = p < 0.05 ? '*' : p < 0.10 ? '.' : '';
      const rhoStr = (rho >= 0 ? '+' : '') + rho.toFixed(3);
      const verdict = Math.abs(rho) > 0.10 ? `${C.green}strong${C.reset}` :
                       Math.abs(rho) > 0.05 ? `${C.cyan}meaningful${C.reset}` :
                       Math.abs(rho) > 0.02 ? `${C.yellow}weak${C.reset}` : `${C.red}NO EDGE${C.reset}`;
      console.log(`    ${name.padEnd(14)} IC ${rhoStr.padStart(8)}  p=${p.toFixed(3)}${sigMark.padEnd(2)} n=${n}  ${verdict}`);
    }
  }

  // ─── 3. Walk-Forward ──────────────────────────────────────────────────────
  console.log(`\n${C.cyan}━━━ 3. Walk-Forward (${CONFIG.walkForward} windows) ━━━${C.reset}`);
  const wfWindows = walkForward(bars, CONFIG, CONFIG.walkForward);
  let positiveWindows = 0;
  for (const w of wfWindows) {
    const positive = w.totalPnl > 0;
    if (positive) positiveWindows++;
    const mark = positive ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${mark}  Window ${w.idx + 1} (bars ${w.range[0]}-${w.range[1]}):  ${w.trades.toString().padStart(3)} trades  WR ${fmtPct(w.winRate).padStart(7)}  Sharpe ${fmtNum(w.sharpe).padStart(7)}  ${(w.totalPnl >= 0 ? '+' : '') + '$' + w.totalPnl.toFixed(0)}`);
  }
  const wfVerdict = positiveWindows >= 3 ? `${C.green}✓ EDGE PERSISTENT${C.reset}` :
                    positiveWindows >= 2 ? `${C.yellow}⚠ MIXED${C.reset}` :
                                           `${C.red}✗ CURVE-FIT${C.reset}`;
  console.log(`  Verdict: ${positiveWindows}/${wfWindows.length} windows positive — ${wfVerdict}`);

  // ─── 4. Permutation Test ─────────────────────────────────────────────────
  if (m.trades > 0 && CONFIG.perms > 0) {
    console.log(`\n${C.cyan}━━━ 4. Permutation Test (${CONFIG.perms} shuffles) ━━━${C.reset}`);
    process.stdout.write(`  Computing... `);
    const perm = permutationTest(bars, CONFIG, CONFIG.perms);
    console.log(`done`);
    console.log(`  Original Sharpe:  ${fmtNum(perm.baseSharpe)}`);
    console.log(`  Random Sharpe:    ${fmtNum(perm.randomMean)} ± ${fmtNum(perm.randomStd)}`);
    const sigMark = perm.pValue < 0.05 ? `${C.green}** STATISTICALLY SIGNIFICANT${C.reset}` :
                    perm.pValue < 0.10 ? `${C.cyan}* marginal${C.reset}` :
                                          `${C.red}NOT significant — could be random${C.reset}`;
    console.log(`  p-value:          ${perm.pValue.toFixed(4)}  ${sigMark}`);
  }

  // ─── 5. Monte Carlo ──────────────────────────────────────────────────────
  if (sim.trades.length > 5 && CONFIG.monteCarlo > 0) {
    console.log(`\n${C.cyan}━━━ 5. Monte Carlo — Equity Stress Test (${CONFIG.monteCarlo} shuffles) ━━━${C.reset}`);
    const mc = monteCarlo(sim.trades, CONFIG.startEquity, CONFIG.monteCarlo);
    if (mc) {
      console.log(`  Final equity 5th pct:    ${C.dim}${fmt$(mc.final5)}${C.reset}`);
      console.log(`  Final equity 50th pct:   ${fmt$(mc.final50)}`);
      console.log(`  Final equity 95th pct:   ${C.green}${fmt$(mc.final95)}${C.reset}`);
      console.log(`  Max DD 50th pct:         ${mc.dd50.toFixed(2)}%`);
      console.log(`  Probability of ruin:     ${mc.ruinProbPct.toFixed(2)}%  ${mc.ruinProbPct > 5 ? C.red + '⚠ HIGH' + C.reset : C.green + '✓' + C.reset}`);
    }
  }

  // ─── 6. Final verdict ─────────────────────────────────────────────────────
  console.log(`\n${C.cyan}━━━ 6. FINAL VERDICT ━━━${C.reset}`);
  const checks = [
    { name: 'Profit factor > 1.3',     pass: m.profitFactor > 1.3 },
    { name: 'Sharpe > 0.8 (annual)',   pass: m.sharpe > 0.8 },
    { name: 'Positive expectancy',     pass: m.expectancyR > 0 },
    { name: 'Max drawdown < 20%',      pass: m.maxDrawdownPct < 20 },
    { name: 'Edge persistent (WF)',    pass: positiveWindows >= 3 },
    { name: 'At least 20 trades',      pass: m.trades >= 20 },
  ];
  for (const c of checks) {
    console.log(`  ${c.pass ? C.green + '✓' + C.reset : C.red + '✗' + C.reset}  ${c.name}`);
  }
  const passed = checks.filter(c => c.pass).length;
  const totalChecks = checks.length;
  console.log('');
  if (passed === totalChecks)      console.log(`  ${C.bgGreen ?? C.green}${C.bold}${passed}/${totalChecks} — STRATEGY VALIDATED${C.reset}`);
  else if (passed >= 4)             console.log(`  ${C.yellow}${C.bold}${passed}/${totalChecks} — promising but needs work${C.reset}`);
  else                              console.log(`  ${C.red}${C.bold}${passed}/${totalChecks} — no measurable edge. Don't trade live.${C.reset}`);

  await disconnect().catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    console.error('Fatal:', e.message); console.error(e.stack);
    await disconnect().catch(() => {});
    process.exit(1);
  });
}
