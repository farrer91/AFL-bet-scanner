#!/usr/bin/env node
/**
 * Real bookmaker player-prop odds, from The Odds API.
 *
 *   node scripts/fetch-odds.js [--markets a,b] [--regions au] [--dry-run]
 *
 * Needs ODDS_API_KEY, read from the environment or a local .env file.
 * Without it the script exits cleanly and the app falls back to modelled
 * lines, so the build never depends on this feed being available.
 *
 * Quota costs [markets] x [regions] per event, charged only on markets that
 * actually come back, against 500 credits a month on the free tier. The
 * default pair costs 18 credits for a full round.
 */
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATCHES } from '../src/data/matches.js';
import { PLAYERS } from '../src/data/playerProps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'src', 'data');

const API = 'https://api.the-odds-api.com/v4';
const SPORT = 'aussierules_afl';

// AFL Fantasy is documented but no AU book was quoting it, so it is left out of
// the default set - an unreturned market costs nothing, but it also adds
// nothing.
const DEFAULT_MARKETS = ['player_disposals', 'player_goal_scorer_anytime'];

/** Odds API market key -> the stat key used in playerProps.js. */
const MARKET_TO_STAT = {
  player_disposals: 'disposals',
  player_disposals_over: 'disposals',
  player_marks_over: 'marks',
  player_tackles_over: 'tackles',
  player_clearances_over: 'clearances',
  player_kicks_over: 'kicks',
  player_handballs_over: 'handballs',
  player_afl_fantasy_points: 'dreamTeamPoints',
  player_afl_fantasy_points_over: 'dreamTeamPoints',
  player_goal_scorer_anytime: 'goals',
};

const args = process.argv.slice(2);
const argValue = (f) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const MARKETS = (argValue('--markets') || DEFAULT_MARKETS.join(',')).split(',');
const REGIONS = argValue('--regions') || 'au';
const DRY_RUN = args.includes('--dry-run');

/** Read .env for local runs; CI injects the key as a real env var. */
function loadKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY.trim();
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return null;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*ODDS_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

// --- name matching --------------------------------------------------------
// Books and the AFL API disagree on given names - Daniel/Dan, Nicholas/Nick,
// Jackson/Jack, Leonardo/Leo. Surname plus first initial reconciles those
// without the false positives that fuzzy matching on the whole name invites.

const normalise = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function nameKey(full) {
  const parts = normalise(full).split(' ').filter(Boolean);
  if (!parts.length) return null;
  const surname = parts[parts.length - 1];
  return `${parts[0][0]}|${surname}`;
}

/**
 * Index our players per match, so a book quote is only ever matched against
 * the 44 players actually in that game.
 */
function buildIndex() {
  const byMatch = new Map();
  for (const p of PLAYERS) {
    if (!byMatch.has(p.match)) byMatch.set(p.match, { exact: new Map(), initial: new Map() });
    const idx = byMatch.get(p.match);
    idx.exact.set(normalise(p.player), p);
    const key = nameKey(p.player);
    if (!key) continue;
    // Collisions are recorded rather than resolved - guessing between two
    // players with the same initial and surname would be worse than a miss.
    if (idx.initial.has(key)) idx.initial.set(key, 'AMBIGUOUS');
    else idx.initial.set(key, p);
  }
  return byMatch;
}

function matchPlayer(index, matchName, bookName) {
  const idx = index.get(matchName);
  if (!idx) return { player: null, how: 'no-match-fixture' };
  const exact = idx.exact.get(normalise(bookName));
  if (exact) return { player: exact, how: 'exact' };
  const key = nameKey(bookName);
  const viaInitial = key && idx.initial.get(key);
  if (viaInitial === 'AMBIGUOUS') return { player: null, how: 'ambiguous' };
  if (viaInitial) return { player: viaInitial, how: 'initial' };
  return { player: null, how: 'unmatched' };
}

// --- fetching -------------------------------------------------------------

const client = axios.create({ baseURL: API, timeout: 30000 });
let creditsUsed = 0;
let creditsRemaining = null;

async function get(url, params) {
  const res = await client.get(url, { params });
  const last = Number(res.headers['x-requests-last']);
  if (Number.isFinite(last)) creditsUsed += last;
  const rem = Number(res.headers['x-requests-remaining']);
  if (Number.isFinite(rem)) creditsRemaining = rem;
  return res.data;
}

/** Fixtures keyed by UTC start, which both feeds agree on exactly. */
function fixtureByStart() {
  const m = new Map();
  for (const match of MATCHES) {
    const utc = new Date(`${match.date.replace(' ', 'T')}+10:00`).toISOString().slice(0, 16);
    m.set(utc, match);
  }
  return m;
}

/**
 * Collapse every bookmaker's quotes into one book per player, stat and line,
 * keeping the best price available on each side.
 */
function collectQuotes(bookmakers, onOutcome) {
  for (const book of bookmakers || []) {
    for (const market of book.markets || []) {
      const stat = MARKET_TO_STAT[market.key];
      if (!stat) continue;
      const twoWay = !market.key.endsWith('_over') && market.key !== 'player_goal_scorer_anytime';
      for (const o of market.outcomes || []) {
        if (!o.description || !Number.isFinite(o.price)) continue;
        onOutcome({
          stat,
          marketKey: market.key,
          twoWay,
          player: o.description,
          side: (o.name || 'Over').toLowerCase(),
          line: Number.isFinite(o.point) ? o.point : null,
          price: o.price,
          book: book.key,
        });
      }
    }
  }
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.log('ODDS_API_KEY not set - skipping odds feed, app will use modelled lines.');
    return;
  }
  console.log(`Fetching AFL player props (${MARKETS.join(', ')}) for ${REGIONS}\n`);

  const events = await get(`/sports/${SPORT}/events/`, { apiKey: key });
  const byStart = fixtureByStart();
  const paired = [];
  for (const e of events) {
    const match = byStart.get(e.commence_time.slice(0, 16));
    if (match) paired.push({ event: e, match });
  }
  console.log(`${events.length} events, ${paired.length} matched to this round's fixtures`);
  if (paired.length < MATCHES.length) {
    console.warn(`  ! ${MATCHES.length - paired.length} fixtures had no event - odds will be partial`);
  }
  if (DRY_RUN) {
    console.log('\n--dry-run: stopping before any paid request.');
    return;
  }

  const index = buildIndex();
  const out = {};
  const stats = { exact: 0, initial: 0, unmatched: 0, ambiguous: 0 };
  const unmatchedNames = new Set();
  const booksSeen = new Set();

  for (const { event, match } of paired) {
    let data;
    try {
      data = await get(`/sports/${SPORT}/events/${event.id}/odds`, {
        apiKey: key,
        regions: REGIONS,
        markets: MARKETS.join(','),
        oddsFormat: 'decimal',
      });
    } catch (err) {
      console.warn(`  ! ${match.home} v ${match.away}: ${err.response?.status || err.message}`);
      continue;
    }

    const matchName = `${match.home} v ${match.away}`;
    let quoted = 0;
    collectQuotes(data.bookmakers, (q) => {
      booksSeen.add(q.book);
      const { player, how } = matchPlayer(index, matchName, q.player);
      if (!player) {
        stats[how === 'ambiguous' ? 'ambiguous' : 'unmatched'] += 1;
        unmatchedNames.add(q.player);
        return;
      }
      stats[how] += 1;
      quoted += 1;

      const byPlayer = (out[player.id] ||= { player: player.player, match: matchName, markets: {} });
      const byStat = (byPlayer.markets[q.stat] ||= { twoWay: q.twoWay, lines: {} });
      const lineKey = q.line == null ? 'anytime' : String(q.line);
      const entry = (byStat.lines[lineKey] ||= { line: q.line, over: null, under: null });
      const side = q.side === 'under' ? 'under' : 'over';
      // Best available price wins; the book offering it travels with it.
      if (!entry[side] || q.price > entry[side].price) entry[side] = { price: q.price, book: q.book };
    });
    console.log(`  ${matchName.padEnd(38)} ${quoted} quotes`);
  }

  const matched = stats.exact + stats.initial;
  const total = matched + stats.unmatched + stats.ambiguous;
  console.log(`\nName matching: ${matched}/${total} quotes matched`);
  console.log(`  exact ${stats.exact} · via first initial ${stats.initial}`);
  console.log(`  unmatched ${stats.unmatched} · ambiguous ${stats.ambiguous}`);
  if (unmatchedNames.size) {
    console.log(`  unmatched names: ${[...unmatchedNames].slice(0, 12).join(', ')}${unmatchedNames.size > 12 ? ' …' : ''}`);
  }
  console.log(`\nCredits used ${creditsUsed}, remaining ${creditsRemaining ?? '?'}`);

  const payload = {
    fetchedAt: new Date().toISOString(),
    round: MATCHES[0]?.round ?? null,
    markets: MARKETS,
    regions: REGIONS,
    bookmakers: [...booksSeen].sort(),
    coverage: {
      players: Object.keys(out).length,
      quotes: matched,
      unmatched: stats.unmatched,
      ambiguous: stats.ambiguous,
      unmatchedNames: [...unmatchedNames].sort(),
    },
    odds: out,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'propOdds.js'),
    `// AUTO-GENERATED by scripts/fetch-odds.js - do not edit by hand.\n` +
      `// ${payload.bookmakers.length} bookmakers, ${payload.coverage.players} players, fetched ${payload.fetchedAt}\n\n` +
      `export const PROP_ODDS = ${JSON.stringify(payload, null, 2)};\n\nexport default PROP_ODDS;\n`,
  );
  console.log(`Wrote src/data/propOdds.js - ${payload.coverage.players} players priced by ${payload.bookmakers.length} books`);
}

main().catch((err) => {
  console.error('\nODDS FETCH FAILED:', err.response?.data?.message || err.message);
  process.exit(1);
});
