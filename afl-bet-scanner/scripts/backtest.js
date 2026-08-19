#!/usr/bin/env node
/**
 * Backtest the scanner against completed games.
 *
 * Replays every finished match through the same pricing and edge code the app
 * ships, settles each bet against the final score, and reports whether the
 * flagged edges actually made money.
 *
 *   node scripts/backtest.js [--years 2021-2026] [--stake 10] [--audit] [--write]
 *
 * `--write` emits src/data/backtest.js so the app can show its own track
 * record instead of only its claims.
 *
 * Squiggle stamps a tip's `updated` field when it grades the tip, not when the
 * tip was made, so historical rows carry a post-game timestamp. The margins
 * themselves are pre-game forecasts: every source on a given game shares one
 * grading timestamp, seconds after the final score lands. `--audit` prints that
 * check so the assumption can be re-verified against fresh data.
 */
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceGame } from '../src/lib/model.js';
import { matchMarkets, EDGE_TIERS, pct } from '../src/lib/edges.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');

const CONTACT = 'AFL-Bet-Edge-Scanner/1.0 (farrer91@gmail.com)';
const OVERROUND = 1.05;
const BOOTSTRAP = 20000;

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
  timeout: 60000,
  headers: { 'User-Agent': CONTACT },
  paramsSerializer: { serialize: (p) => p.q },
});
const get = async (q) => (await squiggle.get('', { params: { q } })).data;

const isComplete = (g) => g.complete === 100 && g.hscore != null && g.ascore != null;
const round = (n, dp = 4) => Number(n.toFixed(dp));

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
  const cover = isHome ? margin + market.line : -margin + market.line;
  if (cover === 0) return null;
  return cover > 0 ? 1 : 0;
}

const profit = (result, odds) => (result === null ? 0 : result === 1 ? odds - 1 : -1);

function summarise(bets) {
  const settled = bets.filter((b) => b.result !== null);
  const wins = settled.filter((b) => b.result === 1).length;
  const staked = settled.length * STAKE;
  const returned = settled.reduce((s, b) => s + profit(b.result, b.odds) * STAKE, 0);
  const expected = settled.reduce((s, b) => s + b.ev * STAKE, 0);
  return {
    bets: settled.length,
    pushes: bets.length - settled.length,
    wins,
    winRate: settled.length ? round(wins / settled.length) : 0,
    profit: round(returned, 2),
    roi: staked ? round(returned / staked) : 0,
    claimedEv: staked ? round(expected / staked) : 0,
  };
}

/** Bootstrap a confidence interval for realised ROI. */
function bootstrapRoi(bets) {
  const settled = bets.filter((b) => b.result !== null);
  if (settled.length < 20) return null;
  const pls = settled.map((b) => profit(b.result, b.odds));
  const out = new Array(BOOTSTRAP);
  for (let i = 0; i < BOOTSTRAP; i += 1) {
    let sum = 0;
    for (let j = 0; j < pls.length; j += 1) sum += pls[(Math.random() * pls.length) | 0];
    out[i] = sum / pls.length;
  }
  out.sort((a, b) => a - b);
  const claimed = settled.reduce((s, b) => s + b.ev, 0) / settled.length;
  return {
    low: round(out[Math.floor(0.025 * BOOTSTRAP)]),
    high: round(out[Math.floor(0.975 * BOOTSTRAP)]),
    pProfitable: round(out.filter((x) => x > 0).length / BOOTSTRAP),
    pMeetsClaim: round(out.filter((x) => x >= claimed).length / BOOTSTRAP),
  };
}

const CAL_BUCKETS = [
  [0, 0.2],
  [0.2, 0.35],
  [0.35, 0.5],
  [0.5, 0.65],
  [0.65, 0.8],
  [0.8, 1.01],
];

function calibration(bets) {
  const out = [];
  for (const [lo, hi] of CAL_BUCKETS) {
    const sel = bets.filter(
      (b) => b.type === 'H2H' && b.modelProb >= lo && b.modelProb < hi && b.result !== null,
    );
    if (!sel.length) continue;
    const predicted = sel.reduce((s, b) => s + b.modelProb, 0) / sel.length;
    const actual = sel.filter((b) => b.result === 1).length / sel.length;
    out.push({
      lo,
      hi: Math.min(hi, 1),
      bets: sel.length,
      predicted: round(predicted),
      actual: round(actual),
    });
  }
  return out;
}

/** Head-to-head accuracy of the model against the bookmaker line. */
function modelVsMarket(rows) {
  const clamp = (p) => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const logLoss = (key) =>
    -rows.reduce((s, r) => s + (r.homeWon ? Math.log(clamp(r[key])) : Math.log(1 - clamp(r[key]))), 0) /
    rows.length;
  const brier = (key) => rows.reduce((s, r) => s + ((r.homeWon ? 1 : 0) - r[key]) ** 2, 0) / rows.length;
  const mae = (key) => rows.reduce((s, r) => s + Math.abs(r.actualMargin - r[key]), 0) / rows.length;

  const disagree = rows.filter((r) => Math.abs(r.modelMargin - r.marketMargin) >= 6);
  const modelRight = disagree.filter(
    (r) => r.modelMargin > r.marketMargin === r.actualMargin > r.marketMargin,
  ).length;

  return {
    games: rows.length,
    logLoss: { model: round(logLoss('modelProb')), market: round(logLoss('marketProb')) },
    brier: { model: round(brier('modelProb')), market: round(brier('marketProb')) },
    marginMae: { model: round(mae('modelMargin'), 2), market: round(mae('marketMargin'), 2) },
    disagreement: {
      games: disagree.length,
      modelCoverRate: disagree.length ? round(modelRight / disagree.length) : 0,
      breakEven: round(1 / 1.9),
    },
  };
}

// ---------------------------------------------------------------------------

const fmtMoney = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`;
const HEAD =
  `  ${'segment'.padEnd(26)} ${'bets'.padStart(5)} ${'win%'.padStart(7)} ` +
  `${'profit'.padStart(10)} ${'ROI'.padStart(8)} ${'claimed'.padStart(9)}`;
const line = (label, s) =>
  `  ${label.padEnd(26)} ${String(s.bets).padStart(5)} ${pct(s.winRate, 1).padStart(7)} ` +
  `${fmtMoney(s.profit).padStart(10)} ${pct(s.roi, 1).padStart(8)} ${pct(s.claimedEv, 1).padStart(9)}`;

async function main() {
  const label = YEARS.length > 1 ? `${YEARS[0]}-${YEARS[YEARS.length - 1]}` : String(YEARS[0]);
  console.log(`Backtesting ${label} at $${STAKE} per bet\n`);

  const games = [];
  const tips = [];
  // Sequential rather than parallel - one polite request at a time.
  for (const year of YEARS) {
    games.push(...((await get(`q=games;year=${year}`)).games || []));
    tips.push(...((await get(`q=tips;year=${year}`)).tips || []));
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
  const rows = [];
  let priced = 0;

  for (const game of played) {
    const model = priceGame(game, tipsByGame.get(Number(game.id)) || []);
    if (!model || model.marketProb == null) continue;
    priced += 1;

    const actualMargin = game.hscore - game.ascore;
    if (actualMargin !== 0) {
      rows.push({
        modelProb: model.homeWinProb,
        marketProb: model.marketProb,
        modelMargin: model.predictedMargin,
        marketMargin: model.marketMargin,
        actualMargin,
        homeWon: actualMargin > 0,
      });
    }

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

  console.log(`${played.length} completed games, ${priced} with a market line`);
  console.log(`${all.length} markets replayed\n`);

  const live = all.filter((b) => !b.suspect);

  console.log('BETS THE SCANNER WOULD SURFACE (guards applied)');
  console.log(HEAD);
  const tiers = [];
  for (const tier of EDGE_TIERS) {
    if (tier.key === 'none') continue;
    const sel = live.filter((b) => b.ev >= tier.min);
    if (!sel.length) continue;
    const summary = summarise(sel);
    const ci = bootstrapRoi(sel);
    tiers.push({ key: tier.key, label: tier.label, min: tier.min, ...summary, ci });
    console.log(line(`${tier.label} (EV >= ${pct(tier.min, 1)})`, summary));
    if (ci) console.log(`  ${''.padEnd(26)} 95% CI ${pct(ci.low, 1)} to ${pct(ci.high, 1)}`);
  }

  console.log('\nGUARD VALIDATION - markets the scanner suppresses');
  console.log(HEAD);
  const suppressed = summarise(all.filter((b) => b.suspect && b.ev > 0));
  // The two guards pull in opposite directions, so they are scored apart.
  const longshotGuard = summarise(all.filter((b) => b.longshot && b.ev > 0));
  const wideGapGuard = summarise(all.filter((b) => b.wideGap && !b.longshot && b.ev > 0));
  const kept = summarise(live.filter((b) => b.ev >= 0.05));
  console.log(line('suppressed, +EV (all)', suppressed));
  console.log(line('  by longshot filter', longshotGuard));
  console.log(line('  by wide-gap filter', wideGapGuard));
  console.log(line('kept, +5% EV', kept));

  console.log('\nBASELINES');
  console.log(HEAD);
  const blindLine = summarise(all.filter((b) => b.type === 'LINE'));
  const favourites = summarise(all.filter((b) => b.type === 'H2H' && b.marketProb > 0.5));
  console.log(line('every line market', blindLine));
  console.log(line('back the market favourite', favourites));

  const cal = calibration(all);
  console.log('\nCALIBRATION - does the model mean what it says?');
  console.log(`  ${'model says'.padEnd(14)} ${'bets'.padStart(5)} ${'predicted'.padStart(10)} ${'actual'.padStart(8)} ${'error'.padStart(8)}`);
  for (const b of cal) {
    const err = b.actual - b.predicted;
    console.log(
      `  ${`${pct(b.lo, 0)}-${pct(b.hi, 0)}`.padEnd(14)} ${String(b.bets).padStart(5)} ` +
        `${pct(b.predicted, 1).padStart(10)} ${pct(b.actual, 1).padStart(8)} ` +
        `${((err >= 0 ? '+' : '') + pct(err, 1)).padStart(8)}`,
    );
  }

  const mvm = modelVsMarket(rows);
  console.log('\nMODEL vs BOOKMAKER LINE');
  console.log(`  log-loss    model ${mvm.logLoss.model}  market ${mvm.logLoss.market}`);
  console.log(`  Brier       model ${mvm.brier.model}  market ${mvm.brier.market}`);
  console.log(`  margin MAE  model ${mvm.marginMae.model}   market ${mvm.marginMae.market}`);
  console.log(
    `  when they disagree by 6+ pts (n=${mvm.disagreement.games}): model side covered ${pct(mvm.disagreement.modelCoverRate, 1)}`,
  );

  if (args.includes('--write')) {
    const payload = {
      seasons: YEARS,
      games: priced,
      markets: all.length,
      generatedAt: new Date().toISOString(),
      tiers,
      guards: {
        suppressed,
        kept,
        longshot: { ...longshotGuard, ci: bootstrapRoi(all.filter((b) => b.longshot && b.ev > 0)) },
        wideGap: {
          ...wideGapGuard,
          ci: bootstrapRoi(all.filter((b) => b.wideGap && !b.longshot && b.ev > 0)),
        },
      },
      baselines: { blindLine, favourites },
      calibration: cal,
      modelVsMarket: mvm,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'backtest.js'),
      `// AUTO-GENERATED by scripts/backtest.js - do not edit by hand.\n` +
        `// ${YEARS[0]}-${YEARS[YEARS.length - 1]}, ${priced} games, generated ${payload.generatedAt}\n\n` +
        `export const BACKTEST = ${JSON.stringify(payload, null, 2)};\n\nexport default BACKTEST;\n`,
    );
    console.log(`\nWrote src/data/backtest.js (${priced} games, ${all.length} markets)`);
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
  console.log(`  ${individual} games with many distinct timestamps (would suggest edits)\n`);
}

main().catch((err) => {
  console.error('\nBACKTEST FAILED:', err.message);
  process.exit(1);
});
