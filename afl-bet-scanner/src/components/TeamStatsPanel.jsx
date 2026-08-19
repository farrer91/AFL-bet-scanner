import { useMemo, useState } from 'react';
import { TEAM_STATS } from '../data/teamStats.js';

const COLUMNS = [
  { key: 'avgScore', label: 'For', hint: 'Points scored, last 8' },
  { key: 'avgConceded', label: 'Against', hint: 'Points conceded, last 8' },
  { key: 'percentage', label: '%', hint: 'For / against, last 8' },
  { key: 'winsLast5', label: 'W5', hint: 'Wins in last 5' },
  { key: 'homeWinRate', label: 'Home', hint: 'Home win rate this season' },
];

const Form = ({ form }) => (
  <span className="num tracking-widest">
    {[...form].map((r, i) => (
      <span key={i} className={r === 'W' ? 'text-emerald-400' : 'text-rose-400/70'}>
        {r}
      </span>
    ))}
  </span>
);

// Shade a cell by where the value sits between the league's worst and best.
function heat(value, min, max, invert) {
  if (max === min) return 0;
  const t = (value - min) / (max - min);
  return invert ? 1 - t : t;
}

export default function TeamStatsPanel({ playingTeams }) {
  const [sort, setSort] = useState('percentage');
  const [onlyPlaying, setOnlyPlaying] = useState(true);

  const rows = useMemo(() => {
    const all = Object.entries(TEAM_STATS).map(([team, s]) => ({ team, ...s }));
    const filtered = onlyPlaying ? all.filter((r) => playingTeams.has(r.team)) : all;
    return filtered.sort((a, b) => b[sort] - a[sort]);
  }, [sort, onlyPlaying, playingTeams]);

  const ranges = useMemo(() => {
    const r = {};
    for (const c of COLUMNS) {
      const vals = rows.map((x) => x[c.key]);
      r[c.key] = [Math.min(...vals), Math.max(...vals)];
    }
    return r;
  }, [rows]);

  return (
    <section className="panel">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="font-semibold text-slate-100">Team form</h2>
          <p className="text-xs text-slate-500">Rolling averages over the last 8 games</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={onlyPlaying}
            onChange={(e) => setOnlyPlaying(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 accent-sky-500"
          />
          This round only
        </label>
      </header>

      <div className="scroll-x">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Team</th>
              <th className="px-2 py-2 text-left font-medium">Form</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-2 py-2 text-right font-medium">
                  <button
                    type="button"
                    title={c.hint}
                    onClick={() => setSort(c.key)}
                    className={`transition hover:text-slate-200 ${sort === c.key ? 'text-sky-400' : ''}`}
                  >
                    {c.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-200">{r.team}</td>
                <td className="px-2 py-2">
                  <Form form={r.form} />
                </td>
                {COLUMNS.map((c) => {
                  const [min, max] = ranges[c.key];
                  const t = heat(r[c.key], min, max, c.key === 'avgConceded');
                  const display =
                    c.key === 'homeWinRate'
                      ? `${Math.round(r[c.key] * 100)}%`
                      : c.key === 'winsLast5'
                        ? `${r[c.key]}/5`
                        : r[c.key];
                  return (
                    <td key={c.key} className="px-2 py-2 text-right">
                      <span
                        className="num rounded px-1.5 py-0.5"
                        style={{ backgroundColor: `rgba(56, 189, 248, ${(t * 0.28).toFixed(3)})` }}
                      >
                        {display}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
