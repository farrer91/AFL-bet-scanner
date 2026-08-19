import { useState } from 'react';
import { TEAM_STATS, getModelReasoning } from '../data/teamStats.js';
import { matchMarkets, pct, signed } from '../lib/edges.js';
import EdgeBadge from './EdgeBadge.jsx';

const FormString = ({ form }) => (
  <span className="num tracking-wider">
    {[...(form || '')].map((r, i) => (
      <span key={i} className={r === 'W' ? 'text-emerald-400' : 'text-rose-400/80'}>
        {r}
      </span>
    ))}
  </span>
);

function ProbBar({ homeProb, home, away }) {
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-800">
        <div className="bg-sky-500/80" style={{ width: `${homeProb * 100}%` }} />
        <div className="flex-1 bg-fuchsia-500/50" />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span className="num">{home} {pct(homeProb, 0)}</span>
        <span className="num">{pct(1 - homeProb, 0)} {away}</span>
      </div>
    </div>
  );
}

export default function MatchCard({ match, overround }) {
  const [open, setOpen] = useState(false);
  const markets = matchMarkets(match, overround).sort((a, b) => b.ev - a.ev);
  const best = markets[0];
  const homeStats = TEAM_STATS[match.home];
  const awayStats = TEAM_STATS[match.away];
  const disagreement = match.marketMargin == null ? null : match.predictedMargin - match.marketMargin;

  return (
    <article className="panel overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-slate-100">
            {match.home} <span className="text-slate-500">v</span> {match.away}
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {match.day} · {match.venue}
          </p>
        </div>
        {best && <EdgeBadge ev={best.ev} suspect={best.suspect} />}
      </div>

      <div className="space-y-3 px-4 py-3">
        <ProbBar homeProb={match.homeWinProb} home={match.home} away={match.away} />

        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-800/40 px-2 py-2">
            <dt className="text-[10px] uppercase tracking-wide text-slate-500">Model</dt>
            <dd className="num text-sm font-semibold text-slate-100">{signed(match.predictedMargin)}</dd>
          </div>
          <div className="rounded-lg bg-slate-800/40 px-2 py-2">
            <dt className="text-[10px] uppercase tracking-wide text-slate-500">Market</dt>
            <dd className="num text-sm font-semibold text-slate-100">
              {match.marketMargin == null ? '—' : signed(match.marketMargin)}
            </dd>
          </div>
          <div className="rounded-lg bg-slate-800/40 px-2 py-2">
            <dt className="text-[10px] uppercase tracking-wide text-slate-500">Gap</dt>
            <dd
              className={`num text-sm font-semibold ${
                disagreement == null
                  ? 'text-slate-500'
                  : Math.abs(disagreement) >= 6
                    ? 'text-amber-300'
                    : 'text-slate-300'
              }`}
            >
              {disagreement == null ? '—' : `${signed(disagreement)} pts`}
            </dd>
          </div>
        </dl>

        {disagreement != null && Math.abs(disagreement) >= 12 && (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            Model and market disagree by {Math.abs(disagreement).toFixed(1)} points. Gaps this wide
            usually mean the market holds team news the models have not priced — check the late mail
            before backing it.
          </p>
        )}

        <div className="space-y-1">
          {markets.map((m) => (
            <div key={`${m.type}-${m.market}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/40">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-300">{m.market}</p>
                <p className="num text-[11px] text-slate-500">
                  model {pct(m.modelProb, 0)} · market {pct(m.marketProb, 0)} · fair $
                  {m.fair.toFixed(2)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="num text-sm text-slate-400">${m.odds.toFixed(2)}</span>
                <EdgeBadge ev={m.ev} suspect={m.suspect} compact />
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-400 transition hover:border-slate-700 hover:text-slate-200"
        >
          {open ? 'Hide' : 'Why the model leans this way'}
        </button>

        {open && (
          <div className="space-y-2 rounded-lg bg-slate-800/30 p-3">
            {homeStats && awayStats ? (
              <>
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>
                    {match.home} <FormString form={homeStats.form} />
                  </span>
                  <span>
                    <FormString form={awayStats.form} /> {match.away}
                  </span>
                </div>
                {getModelReasoning(match).map((r) => (
                  <div key={r.label} className="flex items-start gap-3">
                    <span
                      className={`num mt-0.5 w-12 shrink-0 text-right text-xs font-semibold ${
                        r.weight > 0 ? 'text-sky-400' : r.weight < 0 ? 'text-fuchsia-400' : 'text-slate-500'
                      }`}
                    >
                      {signed(r.weight)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-300">{r.label}</p>
                      <p className="text-[11px] leading-relaxed text-slate-500">{r.detail}</p>
                    </div>
                  </div>
                ))}
                <p className="border-t border-slate-800 pt-2 text-[11px] text-slate-600">
                  Consensus of {match.tipsterCount} public models, spread ±{match.tipsterSpread} pts.
                  Positive weights favour {match.home}.
                </p>
              </>
            ) : (
              <p className="text-xs text-slate-500">No rolling form available for these teams yet.</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
