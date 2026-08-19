#!/usr/bin/env node
/**
 * Accumulate a real prop track record, one round at a time.
 *
 *   node scripts/settle-props.js
 *
 * Historical prop odds are not affordable to buy, but they can be earned: this
 * snapshots the markets the app is showing right now, then settles them against
 * the per-round game logs once the round is played. Every week the record gets
 * one round longer.
 *
 * What is snapshotted is the output of playerMarkets - the same prices, lines
 * and probabilities the UI displayed - so the record scores what was actually
 * shown rather than a reconstruction of it.
 *
 * Snapshots live in data/prop-snapshots.json, outside src/ so they never reach
 * the bundle. The settled summary is written to src/data/propRecord.js.
 */
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYERS } from '../src/data/playerProps.js';
import { PROP_ODDS } from '../src/data/propOdds.js';
import { MATCHES } from '../src/data/matches.js';
import { META } from '../src/data/meta.js';
import { playerMarkets, EDGE_TIERS, pct } from '../src/lib/edges.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'prop-snapshots.json');
const OUT = path.join(ROOT, 'src', 'data', 'propRecord.js');

const AFL = 'https://api.afl.com.au/cfs/afl';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CONTACT = 'AFL-Bet-Edge-Scanner/1.0 (farrer91@gmail.com)';

const round2 = (n, dp = 4) => Number(n.toFixed(dp));

/** Stats we can settle, mapped to their field in a round's totals. */
const SETTLE_FIELD = {
  disposals: 'disposals',
  kicks: 'kicks',
  handballs: 'handballs',
  marks: 'marks',
  tackles: 'tackles',
  inside50s: 'inside50s',
  hitouts: 'hitouts',
  dreamTeamPoints: 'dreamTeamPoints',
  goals: 'goals',
  clearances: 'clearances',
};

const readStore = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : { snapshots: [] });

// ---------------------------------------------------------------------------

/** Capture the markets currently on screen, replacing any earlier capture of
 *  the same round so the record uses the latest pre-game prices. */
function snapshot(store) {
  const markets = [];
  for (const player of PLAYERS) {
    const odds = PROP_ODDS.odds[player.id];
    if (!odds) continue;
    for (const m of playerMarkets(player, 1.91, 0, odds)) {
      if (!m.real) continue; // only a real price can be settled honestly
      markets.push({
        playerId: player.id,
        player: player.player,
        team: player.team,
        match: m.match || player.match,
        statKey: m.statKey,
        direction: m.direction,
        line: m.line,
        odds: m.odds,
        book: m.book,
        modelProb: round2(m.modelProb),
        ev: round2(m.ev),
        suspect: Boolean(m.suspect),
      });
    }
  }
  if (!markets.length) {
    console.log('No real prop markets to snapshot.');
    return store;
  }
  const key = `${META.year}-${META.round}`;
  const existing = store.snapshots.findIndex((s) => `${s.year}-${s.round}` === key);
  const entry = {
    year: META.year,
    round: META.round,
    capturedAt: new Date().toISOString(),
    settled: false,
    markets,
  };
  if (existing >= 0) {
    if (store.snapshots[existing].settled) {
      console.log(`Round ${META.round} already settled - not overwriting.`);
      return store;
    }
    store.snapshots[existing] = entry;
    console.log(`Refreshed snapshot for round ${META.round}: ${markets.length} markets`);
  } else {
    store.snapshots.push(entry);
    console.log(`Snapshotted round ${META.round}: ${markets.length} markets`);
  }
  return store;
}

// ---------------------------------------------------------------------------

async function aflClient() {
  const { data } = await axios.post(`${AFL}/WMCTok`, null, {
    timeout: 30000,
    headers: { 'User-Agent': BROWSER_UA, 'Content-Length': '0' },
  });
  return axios.create({
    baseURL: AFL,
    timeout: 45000,
    headers: { 'x-media-mis-token': data.token, 'User-Agent': BROWSER_UA },
  });
}

const roundId = (year, round) => `CD_R${year}014${String(round).padStart(2, '0')}`;

/** Per-round totals for every player who played, keyed by playerId. */
async function roundTotals(afl, year, round) {
  const { data } = await afl.get('/statsCentre/players', {
    params: { seasonId: `CD_S${year}014`, roundId: roundId(year, round), pageNum: 1 },
  });
  const out = new Map();
  for (const row of data.lists || []) {
    const id = String(row.player?.playerId || '');
    if (id && row.stats?.totals) out.set(id, row.stats.totals);
  }
  return out;
}

function actualValue(totals, statKey) {
  const field = SETTLE_FIELD[statKey];
  if (!field) return null;
  const raw = totals[field];
  if (statKey === 'clearances' && typeof raw === 'object' && raw) {
    return Number(raw.totalClearances) || 0;
  }
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** 1 win, 0 loss, null void (did not play, or an exact push). */
function settleMarket(m, actual) {
  if (actual == null) return null;
  if (m.statKey === 'goals') return actual >= 1 ? 1 : 0; // anytime
  if (actual === m.line) return null; // half-lines make this vanishingly rare
  const over = actual > m.line;
  return (m.direction === 'Over' ? over : !over) ? 1 : 0;
}

/** Which rounds have finished, per Squiggle. */
async function completedRounds(year) {
  const { data } = await axios.get('https://api.squiggle.com.au/', {
    params: { q: `q=games;year=${year}` },
    paramsSerializer: { serialize: (p) => p.q },
    headers: { 'User-Agent': CONTACT },
    timeout: 30000,
  });
  const byRound = new Map();
  for (const g of data.games || []) {
    if (!byRound.has(g.round)) byRound.set(g.round, []);
    byRound.get(g.round).push(g);
  }
  const done = new Set();
  for (const [round, games] of byRound) {
    if (games.length && games.every((g) => g.complete === 100)) done.add(round);
  }
  return done;
}

async function settle(store) {
  const pending = store.snapshots.filter((s) => !s.settled);
  if (!pending.length) {
    console.log('Nothing pending settlement.');
    return store;
  }
  const done = await completedRounds(pending[0].year);
  const ready = pending.filter((s) => done.has(s.round));
  if (!ready.length) {
    console.log(`${pending.length} snapshot(s) pending, none of their rounds complete yet.`);
    return store;
  }

  const afl = await aflClient();
  for (const snap of ready) {
    const totals = await roundTotals(afl, snap.year, snap.round);
    let settled = 0;
    let voided = 0;
    for (const m of snap.markets) {
      const t = totals.get(m.playerId);
      const actual = t ? actualValue(t, m.statKey) : null;
      m.actual = actual;
      m.result = settleMarket(m, actual);
      if (m.result == null) voided += 1;
      else settled += 1;
    }
    snap.settled = true;
    snap.settledAt = new Date().toISOString();
    console.log(`Settled round ${snap.round}: ${settled} bets, ${voided} void`);
  }
  return store;
}

// ---------------------------------------------------------------------------

const summarise = (bets) => {
  const n = bets.length;
  if (!n) return { bets: 0, wins: 0, winRate: 0, roi: 0, claimedEv: 0 };
  const wins = bets.filter((b) => b.result === 1).length;
  const profit = bets.reduce((s, b) => s + (b.result === 1 ? b.odds - 1 : -1), 0);
  return {
    bets: n,
    wins,
    winRate: round2(wins / n),
    roi: round2(profit / n),
    claimedEv: round2(bets.reduce((s, b) => s + b.ev, 0) / n),
  };
};

/**
 * Totals the header needs, computed here so App never has to import the
 * player and odds modules just to count them - that would drag ~800KB of data
 * into the initial bundle for two numbers.
 */
function marketTotals() {
  let markets = 0;
  let withLiveOdds = 0;
  for (const player of PLAYERS) {
    const odds = PROP_ODDS.odds[player.id];
    const priced = playerMarkets(player, 1.91, 0, odds);
    markets += priced.length;
    if (priced.some((m) => m.real)) withLiveOdds += 1;
  }
  return { markets, players: PLAYERS.length, withLiveOdds };
}

function buildRecord(store) {
  const settledSnaps = store.snapshots.filter((s) => s.settled);
  const all = settledSnaps.flatMap((s) =>
    s.markets.filter((m) => m.result != null).map((m) => ({ ...m, round: s.round, year: s.year })),
  );

  const byTier = [];
  for (const tier of EDGE_TIERS) {
    if (tier.key === 'none') continue;
    const sel = all.filter((b) => !b.suspect && b.ev >= tier.min);
    if (sel.length) byTier.push({ key: tier.key, label: tier.label, min: tier.min, ...summarise(sel) });
  }
  const byStat = {};
  for (const b of all) {
    (byStat[b.statKey] ||= []).push(b);
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: marketTotals(),
    rounds: settledSnaps.map((s) => s.round).sort((a, b) => a - b),
    pendingRounds: store.snapshots.filter((s) => !s.settled).map((s) => s.round),
    bets: all.length,
    overall: summarise(all),
    positiveEv: summarise(all.filter((b) => !b.suspect && b.ev > 0)),
    flagged: summarise(all.filter((b) => b.suspect)),
    byTier,
    byStat: Object.fromEntries(Object.entries(byStat).map(([k, v]) => [k, summarise(v)])),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  let store = readStore();

  store = snapshot(store);
  store = await settle(store);

  fs.writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);

  const record = buildRecord(store);
  fs.writeFileSync(
    OUT,
    `// AUTO-GENERATED by scripts/settle-props.js - do not edit by hand.\n` +
      `// ${record.bets} settled bets across ${record.rounds.length} round(s)\n\n` +
      `export const PROP_RECORD = ${JSON.stringify(record, null, 2)};\n\nexport default PROP_RECORD;\n`,
  );

  console.log(`\nSettled bets so far: ${record.bets}`);
  if (record.bets) {
    console.log(`  overall ROI ${pct(record.overall.roi, 1)} on ${record.overall.bets} bets`);
    for (const t of record.byTier) {
      console.log(`  ${t.label.padEnd(8)} ${String(t.bets).padStart(4)} bets  claimed ${pct(t.claimedEv, 1)}  realised ${pct(t.roi, 1)}`);
    }
  } else {
    console.log(`  none yet - round(s) ${record.pendingRounds.join(', ')} awaiting results`);
  }
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error('\nSETTLEMENT FAILED:', err.response?.data?.message || err.message);
  process.exit(1);
});
