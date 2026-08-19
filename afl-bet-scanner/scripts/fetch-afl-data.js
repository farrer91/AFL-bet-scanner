#!/usr/bin/env node
/**
 * AFL Bet Edge Scanner - data pipeline.
 *
 * Pulls fixtures, model tips and player season stats, then writes three
 * plain-JS data modules into src/data/ for the React app to import.
 *
 *   node scripts/fetch-afl-data.js [--round N] [--year YYYY]
 */
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { priceGame, mean } from '../src/lib/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'src', 'data');

const CONTACT = 'AFL-Bet-Edge-Scanner/1.0 (farrer91@gmail.com)';
const SQUIGGLE = 'https://api.squiggle.com.au/';
const AFL_API = 'https://api.afl.com.au/cfs/afl';

const MAX_PLAYERS = 450;
const FORM_WINDOW = 8; // rolling window for team averages

// AFL Stats API team names -> Squiggle team names.
const TEAM_NAME_MAP = {
  'Gold Coast SUNS': 'Gold Coast',
  'Gold Coast Suns': 'Gold Coast',
  'GWS GIANTS': 'Greater Western Sydney',
  'GWS Giants': 'Greater Western Sydney',
  'West Coast Eagles': 'West Coast',
  'North Melbourne Kangaroos': 'North Melbourne',
  'Adelaide Crows': 'Adelaide',
  'Geelong Cats': 'Geelong',
  'Sydney Swans': 'Sydney',
  'Western Bulldogs': 'Western Bulldogs',
  'Brisbane Lions': 'Brisbane Lions',
};

const normaliseTeam = (name) => (name ? TEAM_NAME_MAP[name] || name : name);

// Champion Data round ids are zero-padded to two digits. Rounds 10+ happen to
// work unpadded, so an unpadded id fails only for rounds 1-9 - silently, since
// both endpoints answer a bad round with an error rather than empty data.
const roundId = (year, round) => `CD_R${year}014${String(round).padStart(2, '0')}`;

// AFL Stats API position codes -> compact labels used in the props table.
const POSITION_MAP = {
  MIDFIELDER: 'MID',
  MIDFIELDER_FORWARD: 'MID',
  RUCK: 'RUC',
  KEY_FORWARD: 'FWD',
  MEDIUM_FORWARD: 'FWD',
  GENERAL_FORWARD: 'FWD',
  FORWARD: 'FWD',
  KEY_DEFENDER: 'DEF',
  MEDIUM_DEFENDER: 'DEF',
  GENERAL_DEFENDER: 'DEF',
  DEFENDER: 'DEF',
};

const normalisePosition = (pos) => POSITION_MAP[pos] || (pos ? pos.slice(0, 3) : 'MID');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const YEAR = Number(argValue('--year') || new Date().getFullYear());
const round = (n, dp = 2) => Number(n.toFixed(dp));

// Squiggle's query syntax is semicolon-delimited, which axios would percent-
// encode if passed through `params`, so the query string is appended raw.
const squiggle = axios.create({
  baseURL: SQUIGGLE,
  timeout: 30000,
  headers: { 'User-Agent': CONTACT },
  paramsSerializer: { serialize: (p) => p.q },
});

// ---------------------------------------------------------------------------
// Squiggle: fixtures, results and tips
// ---------------------------------------------------------------------------

async function fetchGames(year) {
  const { data } = await squiggle.get('', { params: { q: `q=games;year=${year}` } });
  if (!data || !data.games) throw new Error(`Squiggle returned no games for ${year}`);
  return data.games;
}

// A game only counts as played once Squiggle marks it 100% complete; upcoming
// fixtures come back with zeroed scores rather than nulls.
const isComplete = (g) => g.complete === 100 && g.hscore != null && g.ascore != null;
const isFixture = (g) => !isComplete(g) && g.hteam && g.ateam;

// Returns null when nothing is playable yet. Finals fixtures exist on the
// schedule for weeks before the ladder decides who is in them, so "no named
// fixtures" is a normal between-rounds state, not a failure.
function detectRound(games) {
  const upcoming = games.filter(isFixture);
  if (!upcoming.length) return null;
  return upcoming.sort((a, b) => a.round - b.round)[0].round;
}

async function fetchTips(year, roundNo) {
  try {
    const { data } = await squiggle.get('', {
      params: { q: `q=tips;year=${year};round=${roundNo}` },
    });
    return data.tips || [];
  } catch (err) {
    console.warn(`  ! tips unavailable for round ${roundNo}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// AFL Stats API
// ---------------------------------------------------------------------------

async function fetchToken() {
  const { data } = await axios.post(`${AFL_API}/WMCTok`, null, {
    timeout: 30000,
    headers: {
      // The edge in front of this endpoint rejects non-browser agents.
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Content-Length': '0',
    },
  });
  if (!data || !data.token) throw new Error('WMCTok returned no token');
  return data.token;
}

const aflClient = (token) =>
  axios.create({
    baseURL: AFL_API,
    timeout: 45000,
    headers: {
      'x-media-mis-token': token,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });

async function fetchPlayerStats(afl, year) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data } = await afl.get('/statsCentre/players', {
      params: { seasonId: `CD_S${year}014`, pageNum: page },
    });
    totalPages = data.totalPages || 1;
    out.push(...(data.lists || []));
    page += 1;
  } while (page <= totalPages);
  return out;
}

// Rosters drop ~24h before the first bounce, one match at a time. Returns the
// set of named playerIds together with the teams those rosters cover, so teams
// still awaiting selection can fall back to a season-long filter.
async function fetchNamedPlayers(afl, year, roundNo) {
  let matches;
  try {
    const { data } = await afl.get(`/matchRosters/round/${roundId(year, roundNo)}`, {
      params: { minimal: true },
    });
    matches = Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn(`  ! matchRosters unavailable: ${err.message}`);
    return null;
  }
  if (!matches) return null;

  const ids = new Set();
  const teams = new Set();
  for (const m of matches) {
    const roster = m.matchRoster;
    if (!roster || roster.status === 'SCHEDULED') continue;
    for (const side of [roster.homeTeam, roster.awayTeam]) {
      const sideIds = extractPlayerIds(side);
      if (!sideIds.length) continue;
      for (const id of sideIds) ids.add(String(id));
      // Rosters nest the name: teamName is { teamAbbr, teamName, teamNickname },
      // not the bare string the stats endpoint returns.
      const name = typeof side.teamName === 'object' && side.teamName
        ? side.teamName.teamName
        : side.teamName;
      if (name) teams.add(normaliseTeam(name));
    }
  }
  return ids.size ? { ids, teams } : null;
}

// `positions` arrives either as a flat array of slots or as an object keyed by
// position group; both carry `{ player: { playerId } }` leaves.
function extractPlayerIds(team) {
  if (!team || !team.positions) return [];
  const groups = Array.isArray(team.positions)
    ? [team.positions]
    : Object.values(team.positions);
  const ids = [];
  for (const group of groups) {
    for (const slot of Array.isArray(group) ? group : [group]) {
      const id = slot && slot.player && slot.player.playerId;
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Per-round totals for every player who took the field, keyed by round.
 *
 * The same statsCentre endpoint returns single-round figures in `totals` when
 * given a roundId, so a season of game logs costs one request per round rather
 * than one per match.
 */
async function fetchGameLogs(afl, year, throughRound) {
  const logs = new Map();
  let rounds = 0;
  for (let round = 0; round <= throughRound; round += 1) {
    let data;
    try {
      const res = await afl.get('/statsCentre/players', {
        params: { seasonId: `CD_S${year}014`, roundId: roundId(year, round), pageNum: 1 },
      });
      data = res.data;
    } catch {
      continue; // rounds that predate the season id format simply have no data
    }
    if (!data || !data.lists || !data.lists.length) continue;
    rounds += 1;
    for (const row of data.lists) {
      const id = String(row.player?.playerId || '');
      const t = row.stats?.totals;
      if (!id || !t) continue;
      if (!logs.has(id)) logs.set(id, []);
      logs.get(id).push({ round, totals: t });
    }
  }
  return { logs, rounds };
}

/**
 * Weight recent games more heavily than old ones.
 *
 * A season average cannot see a role change: Bradley Hill averaged 26.7
 * disposals across 2026 while posting 31 and 41 in his last two games, and the
 * books had moved to 33.5 while the model was still quoting the average.
 *
 * Be clear about the size of this: walk-forward over 4,441 player-games, an
 * eight-game half-life beat a plain running mean by 0.5% MAE (3.788 vs 3.807).
 * It is not a transformation. It matters for the handful of players whose role
 * has actually shifted, and is a wash for everyone else - which is precisely
 * the tail the prop lines diverge on. Half-lives of 3, 5 and 12 all did worse.
 */
const FORM_HALF_LIFE = 8;

function weightedMean(values) {
  // values arrive oldest-first; the most recent game carries weight 1.
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    const age = values.length - 1 - i;
    const w = Math.pow(0.5, age / FORM_HALF_LIFE);
    num += values[i] * w;
    den += w;
  }
  return den ? num / den : 0;
}

/** Sample standard deviation - the real spread, not a guess from the mean. */
function sampleStd(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

// ---------------------------------------------------------------------------
// Derived match model
// ---------------------------------------------------------------------------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function buildMatches(fixtures, tips) {
  return fixtures
    .map((game) => {
      const priced = priceGame(
        game,
        tips.filter((t) => Number(t.gameid) === Number(game.id)),
      );
      if (!priced) return null;

      return {
        id: game.id,
        round: game.round,
        day: DAYS[new Date(game.date.replace(' ', 'T')).getDay()],
        date: game.date,
        venue: game.venue,
        ...priced,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rolling team form
// ---------------------------------------------------------------------------

function buildTeamStats(results) {
  const byTeam = new Map();
  const push = (team, entry) => {
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(entry);
  };

  for (const g of results) {
    push(g.hteam, { scored: g.hscore, conceded: g.ascore, won: g.hscore > g.ascore, home: true, date: g.date });
    push(g.ateam, { scored: g.ascore, conceded: g.hscore, won: g.ascore > g.hscore, home: false, date: g.date });
  }

  const stats = {};
  for (const [team, all] of byTeam) {
    const games = all.sort((a, b) => a.date.localeCompare(b.date));
    const window = games.slice(-FORM_WINDOW);
    const last5 = games.slice(-5);
    const homeGames = games.filter((g) => g.home);

    stats[team] = {
      avgScore: round(mean(window.map((g) => g.scored)), 1),
      avgConceded: round(mean(window.map((g) => g.conceded)), 1),
      winsLast5: last5.filter((g) => g.won).length,
      // Most recent result first, so the string reads left-to-right as "latest back".
      form: last5.map((g) => (g.won ? 'W' : 'L')).reverse().join(''),
      homeWinRate: round(homeGames.length ? homeGames.filter((g) => g.won).length / homeGames.length : 0, 3),
      gamesPlayed: games.length,
      percentage: round(
        (mean(window.map((g) => g.scored)) / Math.max(mean(window.map((g) => g.conceded)), 1)) * 100,
        1,
      ),
    };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Player props
// ---------------------------------------------------------------------------

// Season averages come without a spread, so model dispersion from the mean.
// Counting stats are roughly over-dispersed Poisson; disposals are the tightest
// relative to their mean, goals the loosest.
const DISPERSION = {
  disposals: 0.28,
  kicks: 0.34,
  handballs: 0.4,
  marks: 0.45,
  tackles: 0.55,
  clearances: 0.6,
  inside50s: 0.55,
  hitouts: 0.35,
  dreamTeamPoints: 0.3,
};

const spread = (key, m) => round(Math.max(m * DISPERSION[key], Math.sqrt(Math.max(m, 0.5)) * 0.8), 2);

function buildPlayers(playerRows, matches, named, logs) {
  const teamToMatch = new Map();
  for (const m of matches) {
    teamToMatch.set(m.home, `${m.home} v ${m.away}`);
    teamToMatch.set(m.away, `${m.home} v ${m.away}`);
  }

  const rows = [];
  for (const row of playerRows) {
    const p = row.player || {};
    const s = row.stats || {};
    const a = s.averages || {};
    const team = normaliseTeam((row.team && (row.team.teamName || row.team.name)) || null);
    const match = teamToMatch.get(team);
    if (!match) continue; // team isn't playing this round

    const gamesPlayed = Number(s.gamesPlayed) || 0;
    const id = String(p.playerId || '');
    // Once a team's roster is out we can cut straight to the starting 22;
    // until then, keep anyone with a meaningful sample of games.
    const rosterKnown = Boolean(named && named.teams.has(team));
    const isNamed = rosterKnown ? named.ids.has(id) : null;
    if (rosterKnown ? !isNamed : gamesPlayed < 10) continue;

    // `clearances` is a nested breakdown, not a scalar.
    const clearances = typeof a.clearances === 'object' && a.clearances
      ? Number(a.clearances.totalClearances) || 0
      : Number(a.clearances) || 0;

    const num = (v) => Number(v) || 0;
    const counting = {
      disposals: num(a.disposals),
      kicks: num(a.kicks),
      handballs: num(a.handballs),
      marks: num(a.marks),
      tackles: num(a.tackles),
      clearances,
      inside50s: num(a.inside50s),
      hitouts: num(a.hitouts),
      dreamTeamPoints: num(a.dreamTeamPoints),
    };

    // Per-round totals, oldest first, for whichever stats we can measure.
    const games = (logs && logs.get(id)) || [];
    const series = (key) =>
      games
        .map((g) => {
          const t = g.totals;
          if (key === 'clearances') {
            const c = t.clearances;
            return typeof c === 'object' && c ? Number(c.totalClearances) || 0 : Number(c) || 0;
          }
          return Number(t[key]);
        })
        .filter((v) => Number.isFinite(v));

    const goalSeries = series('goals');
    const stats = {
      goals: {
        // A form-weighted rate, falling back to the season average when there
        // are too few games to say anything.
        rate: round(goalSeries.length >= 3 ? weightedMean(goalSeries) : num(a.goals), 2),
        seasonRate: round(num(a.goals), 2),
        // How often the player actually gets on the board, which is what an
        // anytime market pays on. Goals cluster - a 0.6-a-game forward is
        // usually held goalless and occasionally kicks two - so a Poisson draw
        // from the average overstates the chance of at least one. This is
        // measured instead of assumed.
        // Kept for display only - how often the player actually gets on the
        // board. Not used for pricing: it lost to Poisson in walk-forward.
        strike: goalSeries.length >= 5
          ? round(weightedMean(goalSeries.map((g) => (g >= 1 ? 1 : 0))), 4)
          : null,
        recent: goalSeries.slice(-5),
      },
    };

    // Recent scorelines are shown in the UI only for the stats books actually
    // quote; carrying them for all nine tripled the payload for no benefit.
    const SHOW_RECENT = new Set(['disposals', 'marks', 'tackles']);
    let logged = 0;

    for (const [key, seasonMean] of Object.entries(counting)) {
      const vals = series(key);
      const measured = vals.length >= 3;
      logged = Math.max(logged, vals.length);
      const mean = measured ? weightedMean(vals) : seasonMean;
      // Real game-to-game spread beats a fraction of the mean, but a short
      // series can understate it, so the heuristic acts as a floor.
      const std = measured ? Math.max(sampleStd(vals), spread(key, mean) * 0.6) : spread(key, seasonMean);
      stats[key] = {
        mean: round(mean, 2),
        std: round(std, 2),
        seasonMean: round(seasonMean, 2),
        ...(SHOW_RECENT.has(key) && vals.length ? { recent: vals.slice(-5) } : {}),
      };
    }

    rows.push({
      id,
      player: `${p.givenName || ''} ${p.surname || ''}`.trim(),
      team,
      match,
      position: normalisePosition(p.playerPosition),
      gamesPlayed,
      // One count per player rather than repeated inside every stat.
      loggedGames: logged,
      named: isNamed,
      timeOnGround: round(num(s.timeOnGroundPercentage), 1),
      stats,
    });
  }

  // Confirmed starters outrank everyone: a named low-usage defender is a real
  // market, while a high-usage player from an unnamed side may not even play.
  // Within each group, highest usage first so the cap keeps the liquid markets.
  rows.sort((a, b) => {
    if (Boolean(a.named) !== Boolean(b.named)) return a.named ? -1 : 1;
    return b.stats.disposals.mean - a.stats.disposals.mean;
  });
  return rows.slice(0, MAX_PLAYERS);
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

const banner = (meta) =>
  `// AUTO-GENERATED by scripts/fetch-afl-data.js - do not edit by hand.\n// ${meta}\n\n`;

function writeMatches(matches, meta) {
  const body = `${banner(meta)}export const MATCHES = ${JSON.stringify(matches, null, 2)};\n\nexport default MATCHES;\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'matches.js'), body);
}

// The reasoning helper is built with string concatenation rather than a
// template literal so `match` is not interpolated at generation time.
const MODEL_REASONING_FN = [
  'export function getModelReasoning(match) {',
  '  const home = TEAM_STATS[match.home];',
  '  const away = TEAM_STATS[match.away];',
  '  if (!home || !away) return [];',
  '',
  '  const reasons = [];',
  '  const attack = home.avgScore - away.avgScore;',
  '  const defence = away.avgConceded - home.avgConceded;',
  '',
  '  reasons.push({',
  "    label: 'Scoring',",
  "    detail: match.home + ' average ' + home.avgScore + ' pts vs ' + match.away + ' ' + away.avgScore + ' pts over the last 8.',",
  '    weight: Math.round(attack * 10) / 10,',
  '  });',
  '  reasons.push({',
  "    label: 'Defence',",
  "    detail: match.home + ' concede ' + home.avgConceded + ' pts vs ' + match.away + ' ' + away.avgConceded + ' pts.',",
  '    weight: Math.round(defence * 10) / 10,',
  '  });',
  '  reasons.push({',
  "    label: 'Recent form',",
  "    detail: match.home + ' ' + home.form + ' (' + home.winsLast5 + '/5), ' + match.away + ' ' + away.form + ' (' + away.winsLast5 + '/5).',",
  '    weight: (home.winsLast5 - away.winsLast5) * 3,',
  '  });',
  '  reasons.push({',
  "    label: 'Home ground',",
  "    detail: match.home + ' win ' + Math.round(home.homeWinRate * 100) + '% at home this season.',",
  '    weight: Math.round((home.homeWinRate - 0.5) * 20),',
  '  });',
  '  reasons.push({',
  "    label: 'Percentage',",
  "    detail: match.home + ' ' + home.percentage + '% vs ' + match.away + ' ' + away.percentage + '%.',",
  '    weight: Math.round((home.percentage - away.percentage) / 5),',
  '  });',
  '',
  '  return reasons.sort(function (a, b) { return Math.abs(b.weight) - Math.abs(a.weight); });',
  '}',
].join('\n');

function writeTeamStats(teamStats, meta) {
  const body =
    `${banner(meta)}export const TEAM_STATS = ${JSON.stringify(teamStats, null, 2)};\n\n` +
    `${MODEL_REASONING_FN}\n\nexport default TEAM_STATS;\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'teamStats.js'), body);
}

function writePlayers(players, meta) {
  const body = `${banner(meta)}export const PLAYERS = ${JSON.stringify(players, null, 2)};\n\nexport default PLAYERS;\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'playerProps.js'), body);
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`AFL Bet Edge Scanner - fetching ${YEAR} data`);

  console.log('> Squiggle: games');
  const games = await fetchGames(YEAR);
  const requested = argValue('--round');
  const detected = requested ? Number(requested) : detectRound(games);

  if (detected == null) {
    console.log(
      '\nNo fixtures with confirmed teams. Waiting on the next round to be set - existing data left as is.',
    );
    return;
  }
  const roundNo = detected;
  console.log(`  round ${roundNo} (${requested ? 'supplied' : 'auto-detected'})`);

  const fixtures = games.filter((g) => g.round === roundNo && isFixture(g));
  const results = games.filter(isComplete);
  console.log(`  ${fixtures.length} fixtures, ${results.length} completed results`);

  console.log('> Squiggle: tips');
  const tips = await fetchTips(YEAR, roundNo);
  console.log(`  ${tips.length} tips from ${new Set(tips.map((t) => t.sourceid)).size} sources`);

  console.log('> AFL: token');
  const token = await fetchToken();
  const afl = aflClient(token);

  console.log('> AFL: player season stats');
  const playerRows = await fetchPlayerStats(afl, YEAR);
  console.log(`  ${playerRows.length} players`);

  console.log('> AFL: game logs');
  const throughRound = Math.max(...results.filter((g) => g.year === YEAR).map((g) => g.round), 0);
  const { logs, rounds: logRounds } = await fetchGameLogs(afl, YEAR, throughRound);
  console.log(`  ${logRounds} rounds, ${logs.size} players with game logs`);

  console.log('> AFL: match rosters');
  const named = await fetchNamedPlayers(afl, YEAR, roundNo);
  console.log(
    named
      ? `  ${named.ids.size} players named across ${named.teams.size} teams`
      : '  teams not yet named - using 10+ game filter',
  );

  const matches = buildMatches(fixtures, tips);
  const teamStats = buildTeamStats(results);
  const players = buildPlayers(playerRows, matches, named, logs);

  // The generated files are committed and deployed, so bail out rather than
  // overwrite a good round with an empty one (finals rounds, for instance, have
  // fixtures long before the teams contesting them are known).
  if (!matches.length) {
    const message = `Round ${roundNo} has no fixtures with confirmed teams - leaving existing data untouched.`;
    if (requested) throw new Error(message);
    console.log(`\n${message}`);
    return;
  }
  if (!players.length) {
    throw new Error('No players matched this round\'s teams - leaving existing data untouched.');
  }

  const meta = `Round ${roundNo}, ${YEAR} - generated ${new Date().toISOString()}`;
  writeMatches(matches, meta);
  writeTeamStats(teamStats, meta);
  writePlayers(players, meta);

  fs.writeFileSync(
    path.join(DATA_DIR, 'meta.js'),
    `${banner(meta)}export const META = ${JSON.stringify(
      {
        round: roundNo,
        year: YEAR,
        generatedAt: new Date().toISOString(),
        teamsNamed: named ? [...named.teams].sort() : [],
        matchCount: matches.length,
        playerCount: players.length,
      },
      null,
      2,
    )};\n\nexport default META;\n`,
  );

  console.log(
    `\nWrote ${matches.length} matches, ${Object.keys(teamStats).length} teams, ${players.length} players to src/data/`,
  );
}

main().catch((err) => {
  console.error('\nFETCH FAILED:', err.message);
  if (err.response) console.error('  HTTP', err.response.status, err.config && err.config.url);
  process.exit(1);
});
