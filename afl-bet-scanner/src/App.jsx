import { useMemo, useState } from 'react';
import { MATCHES } from './data/matches.js';
import { PLAYERS } from './data/playerProps.js';
import { META } from './data/meta.js';
import { matchMarkets, playerMarkets, edgeTier, pct } from './lib/edges.js';
import MatchCard from './components/MatchCard.jsx';
import TeamStatsPanel from './components/TeamStatsPanel.jsx';
import PlayerPropsTable from './components/PlayerPropsTable.jsx';
import TrackRecord from './components/TrackRecord.jsx';
import { BACKTEST } from './data/backtest.js';

const TABS = [
  { key: 'matches', label: 'Matches' },
  { key: 'props', label: 'Player props' },
  { key: 'teams', label: 'Team form' },
  { key: 'record', label: 'Track record' },
];

const Stat = ({ label, value, tone = 'text-slate-100' }) => (
  <div className="panel px-3 py-2">
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`num text-lg font-semibold ${tone}`}>{value}</p>
  </div>
);

export default function App() {
  const [tab, setTab] = useState('matches');
  const [overround] = useState(1.05);
  const [bookPrice, setBookPrice] = useState(1.91);
  const [lineOffset, setLineOffset] = useState(0);

  // Only match markets are scored against a real bookmaker line, so only they
  // can produce a headline edge. Prop edges depend on a price the user supplies,
  // and are counted on their own tab instead.
  const summary = useMemo(() => {
    let propCount = 0;
    for (const p of PLAYERS) propCount += playerMarkets(p, bookPrice, lineOffset).length;

    let matchCount = 0;
    let live = 0;
    let flagged = 0;
    let best = null;

    for (const m of MATCHES) {
      let matchFlagged = false;
      for (const mk of matchMarkets(m, overround)) {
        matchCount += 1;
        if (mk.suspect) {
          matchFlagged = true;
          continue;
        }
        if (mk.ev >= 0.025) live += 1;
        if (!best || mk.ev > best.ev) best = { ...mk, context: `${m.home} v ${m.away}` };
      }
      if (matchFlagged) flagged += 1;
    }

    return { total: matchCount + propCount, live, flagged, best };
  }, [overround, bookPrice, lineOffset]);

  const playingTeams = useMemo(
    () => new Set(MATCHES.flatMap((m) => [m.home, m.away])),
    [],
  );

  const generated = new Date(META.generatedAt);
  const strongTier = BACKTEST.tiers.find((t) => t.key === 'strong') || BACKTEST.tiers[0];

  return (
    <div className="min-h-screen bg-slate-950">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-64 opacity-40"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, #0ea5e91a, transparent)' }}
      />

      <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header className="mb-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-100 sm:text-2xl">
                AFL Bet Edge Scanner
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Round {META.round}, {META.year} · {MATCHES.length} matches · data{' '}
                <time dateTime={META.generatedAt}>
                  {generated.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </time>
              </p>
            </div>
            <nav className="flex rounded-lg border border-slate-800 p-0.5">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    tab === t.key ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Markets scanned" value={summary.total.toLocaleString()} />
            <Stat
              label="Live match edges"
              value={summary.live}
              tone={summary.live ? 'text-emerald-300' : 'text-slate-100'}
            />
            <Stat
              label="Flagged matches"
              value={summary.flagged}
              tone={summary.flagged ? 'text-amber-300' : 'text-slate-100'}
            />
            <Stat
              label="Best match edge"
              value={summary.best && summary.best.ev > 0 ? `+${pct(summary.best.ev, 1)}` : '—'}
              tone={summary.best && summary.best.ev > 0 ? edgeTier(summary.best.ev).text : 'text-slate-100'}
            />
          </div>
        </header>

        <main className="space-y-6 pb-16">
          {tab === 'matches' && (
            <>
              <button
                type="button"
                onClick={() => setTab('record')}
                className="panel flex w-full items-start gap-3 border-amber-500/20 bg-amber-500/5 px-4 py-3 text-left transition hover:border-amber-500/40"
              >
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                <span className="text-[11px] leading-relaxed text-amber-100/80">
                  Tested on {BACKTEST.games.toLocaleString()} games ({BACKTEST.seasons[0]}–
                  {BACKTEST.seasons[BACKTEST.seasons.length - 1]}), edges flagged {strongTier.label}{' '}
                  returned{' '}
                  <span className="num font-semibold">
                    {strongTier.roi > 0 ? '+' : ''}
                    {pct(strongTier.roi, 1)}
                  </span>{' '}
                  against the{' '}
                  <span className="num">
                    +{pct(strongTier.claimedEv, 1)}
                  </span>{' '}
                  claimed. Use the badges as a ranking, not a forecast — see the track record.
                </span>
              </button>
            <div className="grid gap-4 md:grid-cols-2">
              {MATCHES.map((m) => (
                <MatchCard key={m.id} match={m} overround={overround} />
              ))}
            </div>
            </>
          )}

          {tab === 'record' && <TrackRecord />}

          {tab === 'props' && (
            <PlayerPropsTable
              matches={MATCHES}
              bookPrice={bookPrice}
              setBookPrice={setBookPrice}
              lineOffset={lineOffset}
              setLineOffset={setLineOffset}
            />
          )}

          {tab === 'teams' && <TeamStatsPanel playingTeams={playingTeams} />}

          <footer className="panel px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            <p>
              Match prices come from the Squiggle tipster consensus ({MATCHES[0]?.tipsterCount || 0}{' '}
              public models) measured against the Punters bookmaker line. Player prop lines are
              modelled from season averages rather than scraped from a book, so the fair price is
              the output: enter what your book actually pays to turn it into an edge. Matches whose
              model and market disagree by more than 12 points are flagged rather than ranked, since
              a gap that wide usually means the market has team news the models do not.
            </p>
            <p className="mt-1">
              Every claim here is checked against {BACKTEST.games.toLocaleString()} completed games on
              the track record tab. Gamble responsibly — this is a statistical tool, not betting
              advice.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
