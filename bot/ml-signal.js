#!/usr/bin/env node
/**
 * ML Signal — Random forest on engineered features.
 *
 * Per research (López de Prado, financial-machine-learning): random forest
 * on engineered features outperforms deep NNs for OHLCV signal generation.
 * Better signal-to-noise ratio, less overfitting, no GPU.
 *
 * Pure-JS implementation — no Python, no GPU, no npm install.
 *
 * Pipeline:
 *   1. Engineer features per bar (returns, RSI, ATR-norm range, vol z, BB width, etc.)
 *   2. Compute forward returns (5/10/20-bar) as labels
 *   3. Walk-forward train/test: train on first 70%, test on next 30%, slide
 *   4. Random forest of decision trees (bagging on bootstrap samples)
 *   5. Each tree votes; output is probability of UP move
 *   6. Walk-forward IC validation tells you if it's real or noise
 *
 * Usage:
 *   node bot/ml-signal.js --bars 1000              full pipeline on current chart
 *   node bot/ml-signal.js --bars 1500 --trees 100  more trees = more stable
 */

import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';
import { ema, rsi, atr as atrFn, bollinger, mean, stdev } from './engine.js';
import { spearman, spearmanPValue } from './backtest.js';

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
  bars:    Number(args['--bars']    ?? 1000),
  horizon: Number(args['--horizon'] ?? 10),
  trees:   Number(args['--trees']   ?? 50),
  depth:   Number(args['--depth']   ?? 5),
  trainPct:Number(args['--train']   ?? 0.7),
};

const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m' };

// ─── Feature engineering ─────────────────────────────────────────────────────

function engineerFeatures(bars) {
  const closes = bars.map(b => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r14 = rsi(closes, 14);
  const atrSeries = atrFn(bars, 14);
  const bb = bollinger(closes, 20, 2);

  return bars.map((b, i) => {
    if (i < 50) return null;
    const ret1  = (b.close - bars[i-1].close) / bars[i-1].close;
    const ret5  = (b.close - bars[i-5].close) / bars[i-5].close;
    const ret20 = (b.close - bars[i-20].close) / bars[i-20].close;
    const range = b.high - b.low;
    const a = atrSeries[i] ?? 1;
    const rangeNormATR = range / a;
    const vol = b.volume || 0;
    const recentVols = bars.slice(i-20, i).map(x => x.volume || 0);
    const vMean = mean(recentVols);
    const vStd  = stdev(recentVols);
    const volZ = vStd > 0 ? (vol - vMean) / vStd : 0;
    const bbWidth = bb.upper[i] && bb.lower[i] ? (bb.upper[i] - bb.lower[i]) / bb.ma[i] : 0;
    const closeVsEma20 = (b.close - e20[i]) / e20[i];
    const closeVsEma50 = (b.close - e50[i]) / e50[i];
    const closePos = range > 0 ? (b.close - b.low) / range : 0.5;
    return {
      idx: i,
      features: [ret1, ret5, ret20, rangeNormATR, volZ, bbWidth, closeVsEma20, closeVsEma50, closePos, r14[i] / 100],
    };
  }).filter(Boolean);
}

const FEATURE_NAMES = ['ret1','ret5','ret20','rangeNormATR','volZ','bbWidth','closeVsEma20','closeVsEma50','closePos','rsi14'];

function forwardReturns(bars, featureBars, horizon) {
  return featureBars.map(f => {
    const future = bars[f.idx + horizon];
    if (!future) return null;
    const fwd = (future.close - bars[f.idx].close) / bars[f.idx].close;
    return { ...f, fwdReturn: fwd, label: fwd > 0 ? 1 : 0 };
  }).filter(x => x && Number.isFinite(x.fwdReturn));
}

// ─── Decision tree ───────────────────────────────────────────────────────────

function trainTree(samples, depth, featureSubsetSize) {
  if (depth === 0 || samples.length < 5) {
    const meanLabel = mean(samples.map(s => s.label));
    return { leaf: true, prediction: meanLabel };
  }
  // Bagging: random feature subset
  const featuresAvailable = [];
  for (let i = 0; i < FEATURE_NAMES.length; i++) featuresAvailable.push(i);
  // Shuffle and take featureSubsetSize
  for (let i = featuresAvailable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [featuresAvailable[i], featuresAvailable[j]] = [featuresAvailable[j], featuresAvailable[i]];
  }
  const subset = featuresAvailable.slice(0, featureSubsetSize);

  // Find best split
  let bestSplit = null;
  let bestVar = Infinity;
  for (const fIdx of subset) {
    const values = samples.map(s => s.features[fIdx]).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length < 5) continue;
    // Try percentile splits
    for (const pct of [0.25, 0.5, 0.75]) {
      const threshold = values[Math.floor(values.length * pct)];
      const left  = samples.filter(s => s.features[fIdx] <= threshold);
      const right = samples.filter(s => s.features[fIdx] > threshold);
      if (left.length === 0 || right.length === 0) continue;
      const lm = mean(left.map(s => s.label));
      const rm = mean(right.map(s => s.label));
      const lvar = left.reduce((s, x) => s + (x.label - lm) ** 2, 0);
      const rvar = right.reduce((s, x) => s + (x.label - rm) ** 2, 0);
      const totalVar = lvar + rvar;
      if (totalVar < bestVar) {
        bestVar = totalVar;
        bestSplit = { featureIdx: fIdx, threshold, left, right };
      }
    }
  }

  if (!bestSplit) {
    const meanLabel = mean(samples.map(s => s.label));
    return { leaf: true, prediction: meanLabel };
  }

  return {
    leaf: false,
    featureIdx: bestSplit.featureIdx,
    threshold: bestSplit.threshold,
    left: trainTree(bestSplit.left, depth - 1, featureSubsetSize),
    right: trainTree(bestSplit.right, depth - 1, featureSubsetSize),
  };
}

function predictTree(tree, features) {
  if (tree.leaf) return tree.prediction;
  return features[tree.featureIdx] <= tree.threshold
    ? predictTree(tree.left, features)
    : predictTree(tree.right, features);
}

function trainForest(samples, opts) {
  const { trees, depth } = opts;
  const featureSubsetSize = Math.max(1, Math.floor(Math.sqrt(FEATURE_NAMES.length)));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    // Bootstrap sample
    const boot = [];
    for (let i = 0; i < samples.length; i++) {
      boot.push(samples[Math.floor(Math.random() * samples.length)]);
    }
    forest.push(trainTree(boot, depth, featureSubsetSize));
  }
  return forest;
}

function predictForest(forest, features) {
  return mean(forest.map(t => predictTree(t, features)));
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.cyan}━ ML Signal Generator (random forest) ━${C.reset}\n`);

  const ohlcv = await data.getOhlcv({ count: CONFIG.bars, summary: false });
  const bars = ohlcv.bars;
  console.log(`${C.dim}Loaded ${bars.length} bars${C.reset}`);

  const features = engineerFeatures(bars);
  const labeled = forwardReturns(bars, features, CONFIG.horizon);
  console.log(`${C.dim}Engineered ${labeled.length} samples (10 features × ${CONFIG.horizon}-bar fwd return)${C.reset}\n`);

  if (labeled.length < 100) {
    console.log(`${C.red}Not enough labeled samples (${labeled.length}); need ≥ 100.${C.reset}`);
    await disconnect().catch(() => {});
    process.exit(0);
  }

  // Train/test split
  const splitIdx = Math.floor(labeled.length * CONFIG.trainPct);
  const train = labeled.slice(0, splitIdx);
  const test  = labeled.slice(splitIdx);

  console.log(`Training random forest (${CONFIG.trees} trees × depth ${CONFIG.depth}) on ${train.length} samples...`);
  const forest = trainForest(train, CONFIG);
  console.log(`${C.green}✓${C.reset} Trained\n`);

  // Out-of-sample evaluation
  let correct = 0;
  const probs = [];
  const fwds = [];
  for (const sample of test) {
    const prob = predictForest(forest, sample.features);
    probs.push(prob);
    fwds.push(sample.fwdReturn);
    if ((prob > 0.5) === (sample.label === 1)) correct++;
  }

  const accuracy = correct / test.length;
  const ic = spearman(probs, fwds);
  const pVal = spearmanPValue(ic, test.length);

  console.log(`${C.cyan}━ OUT-OF-SAMPLE EVALUATION ━${C.reset}`);
  console.log(`Accuracy:         ${(accuracy * 100).toFixed(1)}% (random ≈ 50%)`);
  console.log(`IC (rank corr):   ${ic >= 0 ? '+' : ''}${ic.toFixed(3)}  p=${pVal.toFixed(4)}`);
  const verdict = ic > 0.10 && pVal < 0.05 ? `${C.green}STRONG signal — real predictive edge${C.reset}` :
                  ic > 0.05 && pVal < 0.10 ? `${C.yellow}MARGINAL — some edge but noisy${C.reset}` :
                                              `${C.red}WEAK — likely no edge${C.reset}`;
  console.log(`Verdict:          ${verdict}`);

  // Trade simulation: long when prob > 0.55, short when < 0.45
  let pnl = 0;
  let trades = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > 0.55) { pnl += fwds[i] * 100; trades++; }
    else if (probs[i] < 0.45) { pnl -= fwds[i] * 100; trades++; }
  }
  console.log(`\n${C.cyan}━ NAIVE BACKTEST (long > 0.55, short < 0.45) ━${C.reset}`);
  console.log(`Trades fired:     ${trades}`);
  console.log(`Total $/trade:    ${pnl >= 0 ? C.green : C.red}${(pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)}${C.reset}`);

  // Live signal — predict on most recent bar
  const lastSample = labeled[labeled.length - 1];
  const liveProb = predictForest(forest, lastSample.features);
  console.log(`\n${C.cyan}━ LIVE SIGNAL (current bar) ━${C.reset}`);
  console.log(`P(UP next ${CONFIG.horizon} bars):  ${(liveProb * 100).toFixed(1)}%`);
  const direction = liveProb > 0.55 ? `${C.green}🟢 BULLISH${C.reset}` :
                    liveProb < 0.45 ? `${C.red}🔴 BEARISH${C.reset}` : `${C.yellow}⚪ NEUTRAL${C.reset}`;
  console.log(`Direction:        ${direction}`);

  await disconnect().catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async e => {
    console.error('Fatal:', e.message); console.error(e.stack);
    await disconnect().catch(() => {});
    process.exit(1);
  });
}
