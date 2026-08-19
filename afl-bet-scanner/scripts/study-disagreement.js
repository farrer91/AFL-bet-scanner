#!/usr/bin/env node
/**
 * Does betting the model's side of a model-vs-market disagreement make money?
 *
 *   node scripts/study-disagreement.js [--years 2021-2026]
 *
 * The 6-point threshold was chosen by inspecting the full backtest, so measuring
 * it on that same data proves nothing. This script is built to survive that:
 *
 *   1. a sweep across every threshold, to see whether the effect is a smooth
 *      structure or a lone spike that happens to look good;
 *   2. disjoint bands, since a threshold lumps 6-point and 40-point gaps
 *      together when the earlier backtest showed the extremes are worthless;
 *   3. walk-forward testing, where the threshold is chosen only from seasons
 *      strictly before the one being scored;
 *   4. a permutation test that reproduces the threshold search under the null,
 *      pricing in the fact that we went looking for the best cut.
 *
 * The bet is the market's line at the market's price, taking whichever side the
 * model prefers, so break-even is 52.5% rather than 50%.
 */
import axios from 'axios';
import { priceGame } from '../src/lib/model.js';

const CONTACT = 'AFL-Bet-Edge-Scanner/1.0 (farrer91@gmail.com)';
const OVERROUND = 1.05;
const LINE_ODDS = 1 / (0.5 * OVERROUND); // 1.9048
const BREAK_EVEN = 1 / LINE_ODDS; // 0.525
const PERMUTATIONS = 20000;

const args = process.argv.slice(2);
const argValue = (f) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const YEARS = (() => {
  const raw = argValue('--years') || '2021-2026';
  const [from, to] = raw.split('-').map(Number);
  return to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : [from];
})();

const squiggle = axios.create({
  baseURL: 'https://api.squiggle.com.au/',
  timeout: 60000,
  headers: { 'User-Agent': CONTACT },
  paramsSerializer: { serialize: (p) => p.q },
});
const get = async (q) => (await squiggle.get('', { params: { q } })).data;
const isComplete = (g) => g.complete === 100 && g.hscore != null && g.ascore != null;

const pct = (v, dp = 1) => `${(v * 100).toFixed(dp)}%`;
const roiOf = (rate) => rate * LINE_ODDS - 1;

/** Wilson interval - trustworthy at the small samples these buckets produce. */
function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

/** One-sided binomial tail: P(>= wins | n, p0). */
function binomTail(wins, n, p0) {
  let logC = 0;
  let total = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) logC += Math.log((n - k + 1) / k);
    const logP = logC + k * Math.log(p0) + (n - k) * Math.log(1 - p0);
    if (k >= wins) total += Math.exp(logP);
  }
  return Math.min(total, 1);
}

function evaluate(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.modelCovers).length;
  const rate = n ? wins / n : 0;
  const [lo, hi] = wilson(wins, n);
  return {
    n,
    wins,
    rate,
    roi: roiOf(rate),
    ciLow: roiOf(lo),
    ciHigh: roiOf(hi),
    pNoSkill: n ? binomTail(wins, n, 0.5) : 1,
    pUnprofitable: n ? binomTail(wins, n, BREAK_EVEN) : 1,
  };
}

const line = (label, s) =>
  `  ${label.padEnd(18)} ${String(s.n).padStart(5)} ${pct(s.rate).padStart(8)} ` +
  `${(s.roi >= 0 ? '+' : '') + pct(s.roi)}`.padStart(9) +
  `   [${(s.ciLow >= 0 ? '+' : '') + pct(s.ciLow, 0)}, ${(s.ciHigh >= 0 ? '+' : '') + pct(s.ciHigh, 0)}]`.padEnd(20) +
  ` p=${s.pNoSkill.toFixed(3)}`;
const HEAD = `  ${'segment'.padEnd(18)} ${'games'.padStart(5)} ${'cover%'.padStart(8)} ${'ROI'.padStart(9)}   ${'95% CI'.padEnd(20)} vs coin flip`;

async function main() {
  console.log(`Model-vs-market disagreement study, ${YEARS[0]}-${YEARS[YEARS.length - 1]}`);
  console.log(`Betting the market line at $${LINE_ODDS.toFixed(4)} - break-even ${pct(BREAK_EVEN)}\n`);

  const games = [];
  const tips = [];
  for (const y of YEARS) {
    games.push(...((await get(`q=games;year=${y}`)).games || []));
    tips.push(...((await get(`q=tips;year=${y}`)).tips || []));
  }
  const byGame = new Map();
  for (const t of tips) {
    const k = Number(t.gameid);
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(t);
  }

  const rows = [];
  for (const g of games.filter(isComplete)) {
    const m = priceGame(g, byGame.get(Number(g.id)) || []);
    if (!m || m.marketMargin == null) continue;
    const actual = g.hscore - g.ascore;
    if (actual === m.marketMargin) continue; // push
    const gap = m.predictedMargin - m.marketMargin;
    if (gap === 0) continue;
    rows.push({
      year: g.year,
      gap,
      absGap: Math.abs(gap),
      // The model leans to the home side when gap > 0; that side covers when the
      // real margin lands on the model's side of the market's line.
      modelCovers: gap > 0 ? actual > m.marketMargin : actual < m.marketMargin,
    });
  }
  console.log(`${rows.length} priced games with a market line\n`);

  // 1. Threshold sweep -------------------------------------------------------
  console.log('1. THRESHOLD SWEEP - is there structure, or one lucky cut?');
  console.log(HEAD);
  const thresholds = Array.from({ length: 16 }, (_, i) => i);
  const sweep = thresholds.map((t) => ({ t, ...evaluate(rows.filter((r) => r.absGap >= t)) }));
  for (const s of sweep) {
    if (s.n < 30) continue;
    console.log(line(`gap >= ${s.t} pts`, s));
  }

  // 2. Disjoint bands --------------------------------------------------------
  console.log('\n2. DISJOINT BANDS - a threshold hides what the extremes are doing');
  console.log(HEAD);
  const bands = [[0, 3], [3, 6], [6, 9], [9, 12], [12, 18], [18, Infinity]];
  for (const [lo, hi] of bands) {
    const sel = rows.filter((r) => r.absGap >= lo && r.absGap < hi);
    if (sel.length < 20) continue;
    console.log(line(`${lo}-${hi === Infinity ? '∞' : hi} pts`, evaluate(sel)));
  }

  // 3. Walk-forward ----------------------------------------------------------
  console.log('\n3. WALK-FORWARD - threshold chosen only from earlier seasons');
  console.log(`  ${'test season'.padEnd(14)} ${'picked'.padStart(7)} ${'games'.padStart(6)} ${'cover%'.padStart(8)} ${'ROI'.padStart(9)}`);
  const oos = [];
  for (const testYear of YEARS.slice(2)) {
    const train = rows.filter((r) => r.year < testYear);
    const test = rows.filter((r) => r.year === testYear);
    if (train.length < 100 || !test.length) continue;
    let bestT = 0;
    let bestRate = -1;
    for (const t of thresholds) {
      const sel = train.filter((r) => r.absGap >= t);
      if (sel.length < 60) continue; // need a usable sample to choose on
      const rate = sel.filter((r) => r.modelCovers).length / sel.length;
      if (rate > bestRate) {
        bestRate = rate;
        bestT = t;
      }
    }
    const sel = test.filter((r) => r.absGap >= bestT);
    const s = evaluate(sel);
    oos.push(...sel);
    console.log(
      `  ${String(testYear).padEnd(14)} ${`>=${bestT}`.padStart(7)} ${String(s.n).padStart(6)} ` +
        `${pct(s.rate).padStart(8)} ${((s.roi >= 0 ? '+' : '') + pct(s.roi)).padStart(9)}`,
    );
  }
  const combined = evaluate(oos);
  console.log(`\n  ${'POOLED'.padEnd(14)} ${''.padStart(7)} ${String(combined.n).padStart(6)} ${pct(combined.rate).padStart(8)} ${((combined.roi >= 0 ? '+' : '') + pct(combined.roi)).padStart(9)}`);
  console.log(`  95% CI ${pct(combined.ciLow)} to ${pct(combined.ciHigh)}`);
  console.log(`  P(this good | no skill)      ${combined.pNoSkill.toFixed(4)}`);
  console.log(`  P(this good | not profitable) ${combined.pUnprofitable.toFixed(4)}`);

  // 4. Permutation test ------------------------------------------------------
  // Redo the threshold search on shuffled outcomes to see how good the best cut
  // looks when nothing is there.
  const observed = Math.max(...sweep.filter((s) => s.n >= 30).map((s) => s.rate));
  const absGaps = rows.map((r) => r.absGap);
  let beaten = 0;
  for (let i = 0; i < PERMUTATIONS; i += 1) {
    const shuffled = absGaps.map((g) => ({ absGap: g, modelCovers: Math.random() < 0.5 }));
    let best = 0;
    for (const t of thresholds) {
      const sel = shuffled.filter((r) => r.absGap >= t);
      if (sel.length < 30) continue;
      const rate = sel.filter((r) => r.modelCovers).length / sel.length;
      if (rate > best) best = rate;
    }
    if (best >= observed) beaten += 1;
  }
  console.log('\n4. PERMUTATION TEST - the search itself, run against noise');
  console.log(`  best observed cover rate across thresholds: ${pct(observed)}`);
  console.log(`  P(a search this good | pure noise):         ${(beaten / PERMUTATIONS).toFixed(4)}`);
  console.log(`  (${PERMUTATIONS.toLocaleString()} permutations, threshold search repeated each time)`);

  const verdict =
    combined.pUnprofitable < 0.05 && beaten / PERMUTATIONS < 0.05
      ? 'Signal survives both out-of-sample testing and the multiplicity correction.'
      : combined.roi > 0
        ? 'Positive out-of-sample, but not distinguishable from chance. Not tradeable.'
        : 'No signal. The 6-point result was an artifact of choosing the cut after seeing the data.';
  console.log(`\nVERDICT: ${verdict}`);
}

main().catch((e) => {
  console.error('\nSTUDY FAILED:', e.message);
  process.exit(1);
});
