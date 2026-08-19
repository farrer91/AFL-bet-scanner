#!/usr/bin/env node
/**
 * Backtest the scanner against completed games.
 *
 * Replays every finished match through the same pricing and edge code the app
 * ships, settles each bet against the real result, and reports whether the
 * flagged edges actually made money.
 *
 *   node scripts/backtest.js [--years 2021-2026] [--stake 10] [--audit] [--json]
 *
 * Squiggle stamps a tip's `updated` field when it grades the tip, not when the
 * tip was made, so historical rows carry a post-game timestamp. The margins
 * themselves are pre-game forecasts: every source on a given game shares one
 * grading timestamp, seconds after the final score lands. `--audit` prints that
 * check so the assumption can be re-verified against fresh data.
 */
import axios from 'axios';
import { priceGame } from '../src/lib/model.js';
import { matchMarkets, EDGE_TIERS, edgeTier, pct } from '../src/lib/edges.js';

const CONTACT = 'AFL-Bet-Edge-Scanner/1.0 (farrer91@gmail.com)';
const OVERROUND = 1.05;

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const STAKE = Number(argValue('--stake') || 1);

// --years accepts a single season or an inclusive range: 2024 or 2021-2026.
const YEARS = (() => {
  const raw = argValue('--years') || argValue('--year');
  if (!raw) return [new Date().getFullYear()];
  const [from, to] = raw.split('-').map(Number);
  if (!to) return [from];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
})();

const squiggle = axios.create({
  baseURL: 'https://api.squiggle.com.au/',
  timeout: 45000,
  headers: { 'User-Agent': CONTACT },
  paramsSerializer: { serialize: (p) => p.q },
});

const get = async (q) => (await squiggle.get('', { params: { q } })).data;

const isComplete = (g) => g.complete === 100 && g.hscore != null && g.ascore != null;

/**
 * Settle one market against the final score.
 * Returns 1 for a win, 0 for a loss, null for a push (stake returned).
 */
function settle(market, game) {
  const margin = game.hscore - game.ascore;
  const isHome = market.selection === game.hteam;

  if (market.type === 'H2H') {
    if (margin === 0) return null; // draw - both sides push
    return (isHome ? margin > 0 : margin < 0) ? 1 : 0;
  }

  // Line: the selection covers if the margin beats its handicap.
  const covered = isHome ? margin + market.line > 0 : -margin + market.line > 0;
  if (isHome ? margin + market.line === 0 : -margin + market.line === 0) return null;
  return covered ? 1 : 0;
}

/** Profit from a settled bet, in units of stake. */
const profit = (result, odds) => (result === null ? 0 : result === 1 ? odds - 1 : -1);

function summarise(bets) {
  const settled = bets.filter((b) => b.result !== null);
  const wins = settled.filter((b) => b.result === 1).length;
  const staked = settled.length * STAKE;
  const returned = settled.reduce((sum, b) => sum + profit(b.result, b.odds) * STAKE, 0);
  const expected = settled.reduce((sum, b) => sum + b.ev * STAKE, 0);
  return {
    bets: settled.length,
    pushes: bets.length - settled.length,
    wins,
    winRate: settled.length ? wins / settled.length : 0,
    staked,
    profit: returned,
    roi: staked ? returned / staked : 0,
    expectedRoi: staked ? expected / staked : 0,
  };
}

const fmtMoney = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`;
const row = (label, s) =>
  `  ${label.padEnd(26)} ${String(s.bets).padStart(5)} ${pct(s.winRate, 1).padStart(7)} ` +
  `${fmtMoney(s.profit).padStart(10)} ${pct(s.roi, 1).padStart(8)} ${pct(s.expectedRoi, 1).padStart(9)}`;

const HEAD =
  `  ${'segment'.padEnd(26)} ${'bets'.padStart(5)} ${'win%'.padStart(7)} ` +
  `${'profit'.padStart(10)} ${'ROI'.padStart(8)} ${'modelEV'.padStart(9)}`;

async function main() {
  const label = YEARS.length > 1 ? `${YEARS[0]}-${YEARS[YEARS.length - 1]}` : String(YEARS[0]);
  console.log(`Backtesting ${label} at $${STAKE} per bet\n`);

  const games = [];
  const tips = [];
  // Sequential rather than parallel - one polite request at a time.
  for (const year of YEARS) {
    const [g, t] = [await get(`q=games;year=${year}`), await get(`q=tips;year=${year}`)];
    games.push(...(g.games || []));
    tips.push(...(t.tips || []));
  }

  const tipsByGame = new Map();
  for (const t of tips) {
    const key = Number(t.gameid);
    if (!tipsByGame.has(key)) tipsByGame.set(key, []);
    tipsByGame.get(key).push(t);
  }

  if (args.includes('--audit')) auditTimestamps(games, tips);

  const played = games.filter(isComplete);
  const all = [];
  let priced = 0;
  let skipped = 0;

  for (const game of played) {
    const gameTips = tipsByGame.get(Number(game.id)) || [];
    const model = priceGame(game, gameTips);
    if (!model || model.marketProb == null) {
      skipped += 1;
      continue;
    }
    priced += 1;

    for (const market of matchMarkets(model, OVERROUND)) {
      all.push({
        ...market,
        year: game.year,
        round: game.round,
        game: `${game.hteam} v ${game.ateam}`,
        result: settle(market, game),
      });
    }
  }

  console.log(`${played.length} completed games, ${priced} with a market line (${skipped} skipped)`);
  console.log(`${all.length} markets replayed\n`);

  // --- What the scanner would actually have told you to bet -----------------
  const live = all.filter((b) => !b.suspect);

  console.log('BETS THE SCANNER WOULD SURFACE (guards applied)');
  console.log(HEAD);
  for (const tier of EDGE_TIERS) {
    if (tier.key === 'none') continue;
    const sel = live.filter((b) => b.ev >= tier.min);
    if (sel.length) row0(tier.label + ` (EV >= ${pct(tier.min, 1)})`, sel);
  }
  const flat = live.filter((b) => b.ev > 0);
  console.log(row('any positive EV', summarise(flat)));

  // --- Do the guards earn their keep? --------------------------------------
  console.log('\nGUARD VALIDATION - markets the scanner suppresses');
  console.log(HEAD);
  const suppressed = all.filter((b) => b.suspect && b.ev > 0);
  console.log(row('suppressed, +EV', summarise(suppressed)));
  const wouldHaveBet = all.filter((b) => b.ev >= 0.05);
  console.log(row('all +5% EV, no guards', summarise(wouldHaveBet)));
  console.log(row('  of those, kept', summarise(wouldHaveBet.filter((b) => !b.suspect))));
  console.log(row('  of those, suppressed', summarise(wouldHaveBet.filter((b) => b.suspect))));

  // --- Baselines ------------------------------------------------------------
  console.log('\nBASELINES');
  console.log(HEAD);
  console.log(row('every H2H market', summarise(all.filter((b) => b.type === 'H2H'))));
  console.log(row('every line market', summarise(all.filter((b) => b.type === 'LINE'))));
  console.log(
    row(
      'back the market favourite',
      summarise(all.filter((b) => b.type === 'H2H' && b.marketProb > 0.5)),
    ),
  );

  // --- Calibration ----------------------------------------------------------
  console.log('\nCALIBRATION - does the model mean what it says?');
  console.log(`  ${'model says'.padEnd(14)} ${'bets'.padStart(5)} ${'predicted'.padStart(10)} ${'actual'.padStart(8)} ${'error'.padStart(8)}`);
  const buckets = [
    [0, 0.2],
    [0.2, 0.35],
    [0.35, 0.5],
    [0.5, 0.65],
    [0.65, 0.8],
    [0.8, 1.01],
  ];
  for (const [lo, hi] of buckets) {
    const sel = all.filter((b) => b.type === 'H2H' && b.modelProb >= lo && b.modelProb < hi && b.result !== null);
    if (!sel.length) continue;
    const predicted = sel.reduce((s, b) => s + b.modelProb, 0) / sel.length;
    const actual = sel.filter((b) => b.result === 1).length / sel.length;
    const err = actual - predicted;
    console.log(
      `  ${`${pct(lo, 0)}-${pct(hi > 1 ? 1 : hi, 0)}`.padEnd(14)} ${String(sel.length).padStart(5)} ` +
        `${pct(predicted, 1).padStart(10)} ${pct(actual, 1).padStart(8)} ${(err >= 0 ? '+' : '') + pct(err, 1).padStart(7)}`,
    );
  }

  function row0(label, sel) {
    console.log(row(label, summarise(sel)));
  }

  if (args.includes('--json')) {
    console.log(`\n${JSON.stringify({ live: summarise(flat), markets: all.length }, null, 2)}`);
  }
}

/** Re-verify that historical tips are pre-game forecasts, not post-game edits. */
function auditTimestamps(games, tips) {
  const byId = new Map(games.map((g) => [Number(g.id), g]));
  const perGame = new Map();
  for (const t of tips) {
    const key = Number(t.gameid);
    if (!perGame.has(key)) perGame.set(key, new Set());
    perGame.get(key).add(t.updated);
  }
  let shared = 0;
  let individual = 0;
  for (const [id, stamps] of perGame) {
    const g = byId.get(id);
    if (!g || !isComplete(g)) continue;
    if (stamps.size <= 2) shared += 1;
    else individual += 1;
  }
  console.log('TIMESTAMP AUDIT (completed games)');
  console.log(`  ${shared} games where every tip shares 1-2 timestamps (bulk grading)`);
  console.log(`  ${individual} games with many distinct timestamps (would suggest edits)`);
  console.log('');
}

main().catch((err) => {
  console.error('\nBACKTEST FAILED:', err.message);
  process.exit(1);
});
