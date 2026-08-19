import { useMemo, useState } from 'react';
import { PLAYERS } from '../data/playerProps.js';
import { PROP_STATS, playerMarkets, pct, edgeTier } from '../lib/edges.js';
import EdgeBadge from './EdgeBadge.jsx';

const POSITIONS = ['ALL', 'MID', 'FWD', 'DEF', 'RUC'];
const PAGE_SIZE = 40;

const posColour = {
  MID: 'bg-sky-500/15 text-sky-300',
  FWD: 'bg-rose-500/15 text-rose-300',
  DEF: 'bg-emerald-500/15 text-emerald-300',
  RUC: 'bg-amber-500/15 text-amber-300',
};

export default function PlayerPropsTable({ matches, bookPrice, setBookPrice, lineOffset, setLineOffset }) {
  const [position, setPosition] = useState('ALL');
  const [match, setMatch] = useState('ALL');
  const [stat, setStat] = useState('disposals');
  const [search, setSearch] = useState('');
  const [minEdge, setMinEdge] = useState(-1);
  const [sort, setSort] = useState('avg');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const activeStat = PROP_STATS.find((s) => s.key === stat);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = [];
    for (const p of PLAYERS) {
      if (position !== 'ALL' && p.position !== position) continue;
      if (match !== 'ALL' && p.match !== match) continue;
      if (q && !p.player.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) continue;

      const markets = playerMarkets(p, bookPrice, lineOffset).filter((m) => m.statKey === stat);
      if (!markets.length) continue;
      const best = markets.reduce((a, b) => (b.ev > a.ev ? b : a));
      if (best.ev < minEdge) continue;
      out.push({ player: p, best, markets });
    }
    const value = (r) =>
      sort === 'edge'
        ? r.best.ev
        : sort === 'model'
          ? r.best.modelProb
          : activeStat?.poisson
            ? r.player.stats[stat].rate
            : r.player.stats[stat].mean;
    return out.sort((a, b) => value(b) - value(a));
  }, [position, match, stat, search, minEdge, bookPrice, lineOffset, sort, activeStat]);

  const visible = rows.slice(0, limit);
  const resetLimit = (fn) => (v) => {
    setLimit(PAGE_SIZE);
    fn(v);
  };

  return (
    <section className="panel">
      <header className="space-y-3 border-b border-slate-800 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="font-semibold text-slate-100">Player props</h2>
            <p className="text-xs text-slate-500">
              Fair price is what the model needs at the line shown. Set your book&rsquo;s line and
              price to turn it into a real edge.
            </p>
          </div>
          <p className="num text-xs text-slate-500">
            {rows.length} of {PLAYERS.length} players
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-800 p-0.5">
            {POSITIONS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => resetLimit(setPosition)(p)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  position === p ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          <select
            value={match}
            onChange={(e) => resetLimit(setMatch)(e.target.value)}
            className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-600"
          >
            <option value="ALL">All matches</option>
            {matches.map((m) => (
              <option key={m.id} value={`${m.home} v ${m.away}`}>
                {m.home} v {m.away}
              </option>
            ))}
          </select>

          <select
            value={stat}
            onChange={(e) => resetLimit(setStat)(e.target.value)}
            className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-600"
          >
            {PROP_STATS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>

          <input
            type="search"
            value={search}
            onChange={(e) => resetLimit(setSearch)(e.target.value)}
            placeholder="Player or team"
            className="min-w-[9rem] flex-1 rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 outline-none placeholder:text-slate-600 focus:border-sky-600"
          />

          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            {activeStat?.poisson ? 'Anytime $' : 'Book $'}
            <input
              type="number"
              step="0.05"
              min="1.01"
              value={bookPrice}
              onChange={(e) => resetLimit(setBookPrice)(Number(e.target.value) || 1.91)}
              className="num w-20 rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
            />
          </label>

          {!activeStat?.poisson && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              Line
              <select
                value={lineOffset}
                onChange={(e) => resetLimit(setLineOffset)(Number(e.target.value))}
                className="num rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-600"
              >
                {[-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((o) => (
                  <option key={o} value={o}>
                    {o === 0 ? 'model' : `${o > 0 ? '+' : ''}${o}`}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Sort
            <select
              value={sort}
              onChange={(e) => resetLimit(setSort)(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-600"
            >
              <option value="avg">Average</option>
              <option value="edge">Edge</option>
              <option value="model">Model %</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-500">
            Min edge
            <select
              value={minEdge}
              onChange={(e) => resetLimit(setMinEdge)(Number(e.target.value))}
              className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-600"
            >
              <option value={-1}>Any</option>
              <option value={0}>0%</option>
              <option value={0.025}>2.5%</option>
              <option value={0.05}>5%</option>
            </select>
          </label>
        </div>
      </header>

      <div className="scroll-x">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Player</th>
              <th className="px-2 py-2 text-left font-medium">Match</th>
              <th className="px-2 py-2 text-right font-medium">Avg</th>
              <th className="px-2 py-2 text-right font-medium">Line</th>
              <th className="px-2 py-2 text-left font-medium">Best side</th>
              <th className="px-2 py-2 text-right font-medium">Model</th>
              <th className="px-2 py-2 text-right font-medium">Fair $</th>
              <th className="px-4 py-2 text-right font-medium">Edge</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ player, best }) => {
              const s = player.stats[stat];
              const tier = edgeTier(best.ev);
              return (
                <tr
                  key={`${player.id}-${stat}`}
                  className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30"
                >
                  <td className="whitespace-nowrap px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`chip ${posColour[player.position] || 'bg-slate-700 text-slate-300'}`}>
                        {player.position}
                      </span>
                      <span className="font-medium text-slate-200">{player.player}</span>
                      {player.named && (
                        <span className="chip bg-emerald-500/10 text-[10px] text-emerald-400" title="Named in the starting side">
                          named
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {player.team} · {player.gamesPlayed} games
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{player.match}</td>
                  <td className="num px-2 py-2 text-right text-slate-300">
                    {activeStat?.poisson ? s.rate.toFixed(2) : s.mean.toFixed(1)}
                  </td>
                  <td className="num px-2 py-2 text-right text-slate-400">{best.line}</td>
                  <td className="px-2 py-2">
                    <span className={`text-xs font-medium ${tier.text}`}>
                      {activeStat?.poisson ? 'Anytime' : best.direction}
                    </span>
                  </td>
                  <td className="num px-2 py-2 text-right text-slate-300">{pct(best.modelProb, 0)}</td>
                  <td
                    className={`num px-2 py-2 text-right ${
                      best.fair <= bookPrice ? 'text-emerald-300' : 'text-slate-500'
                    }`}
                    title={`Break-even price for ${best.direction} ${best.line}`}
                  >
                    {best.fair.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <EdgeBadge ev={best.ev} compact />
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                  No props clear that filter. Try a lower minimum edge or a different stat.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > visible.length && (
        <div className="border-t border-slate-800 px-4 py-3 text-center">
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            className="rounded-lg border border-slate-800 px-4 py-1.5 text-xs text-slate-400 transition hover:border-slate-700 hover:text-slate-200"
          >
            Show more ({rows.length - visible.length} remaining)
          </button>
        </div>
      )}
    </section>
  );
}
