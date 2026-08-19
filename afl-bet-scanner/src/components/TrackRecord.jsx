import { BACKTEST } from '../data/backtest.js';
import { pct } from '../lib/edges.js';

const signedPct = (v, dp = 1) => `${v > 0 ? '+' : ''}${pct(v, dp)}`;
const tone = (v) => (v > 0.001 ? 'text-emerald-300' : v < -0.001 ? 'text-rose-300' : 'text-slate-300');

const Section = ({ title, subtitle, children }) => (
  <section className="panel">
    <header className="border-b border-slate-800 px-4 py-3">
      <h3 className="font-semibold text-slate-100">{title}</h3>
      {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
    </header>
    {children}
  </section>
);

/** Diverging bar centred on zero, for calibration error. */
function ErrorBar({ error, max = 0.12 }) {
  const width = Math.min(Math.abs(error) / max, 1) * 50;
  const positive = error >= 0;
  return (
    <div className="relative h-2 w-full rounded-full bg-slate-800">
      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
      <div
        className={`absolute inset-y-0 rounded-full ${positive ? 'bg-sky-400/70' : 'bg-amber-400/70'}`}
        style={
          positive
            ? { left: '50%', width: `${width}%` }
            : { right: '50%', width: `${width}%` }
        }
      />
    </div>
  );
}

export default function TrackRecord() {
  const { seasons, games, markets, tiers, guards, baselines, calibration, modelVsMarket } = BACKTEST;
  const span = `${seasons[0]}–${seasons[seasons.length - 1]}`;
  const headline = tiers.find((t) => t.key === 'strong') || tiers[0];
  const mvm = modelVsMarket;

  return (
    <div className="space-y-4">
      <div className="panel border-amber-500/25 bg-amber-500/5 px-4 py-4">
        <h2 className="font-semibold text-amber-200">What these edges have actually returned</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-100/80">
          Replaying {games.toLocaleString()} completed games from {span} through this same scanner,
          bets it flagged <strong>{headline.label}</strong> claimed{' '}
          <span className="num font-semibold">{signedPct(headline.claimedEv)}</span> expected value
          and returned{' '}
          <span className="num font-semibold">{signedPct(headline.roi)}</span> over{' '}
          {headline.bets.toLocaleString()} bets. The edge percentages are a ranking, not a forecast.
        </p>
        {headline.ci && (
          <p className="num mt-2 text-xs text-amber-200/60">
            95% confidence interval {signedPct(headline.ci.low)} to {signedPct(headline.ci.high)} · the
            model&rsquo;s own claim is rejected at p &lt; {Math.max(headline.ci.pMeetsClaim, 0.001).toFixed(3)}
          </p>
        )}
      </div>

      <Section
        title="By edge tier"
        subtitle={`${markets.toLocaleString()} markets replayed through the shipped pricing code`}
      >
        <div className="scroll-x">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Tier</th>
                <th className="px-2 py-2 text-right font-medium">Bets</th>
                <th className="px-2 py-2 text-right font-medium">Win %</th>
                <th className="px-2 py-2 text-right font-medium">Claimed</th>
                <th className="px-2 py-2 text-right font-medium">Realised</th>
                <th className="px-4 py-2 text-right font-medium">95% CI</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.key} className="border-b border-slate-800/50 last:border-0">
                  <td className="px-4 py-2 font-medium text-slate-200">
                    {t.label}
                    <span className="num ml-2 text-[11px] text-slate-500">EV ≥ {pct(t.min, 1)}</span>
                  </td>
                  <td className="num px-2 py-2 text-right text-slate-400">{t.bets.toLocaleString()}</td>
                  <td className="num px-2 py-2 text-right text-slate-400">{pct(t.winRate, 1)}</td>
                  <td className="num px-2 py-2 text-right text-slate-500">{signedPct(t.claimedEv)}</td>
                  <td className={`num px-2 py-2 text-right font-semibold ${tone(t.roi)}`}>
                    {signedPct(t.roi)}
                  </td>
                  <td className="num px-4 py-2 text-right text-[11px] text-slate-500">
                    {t.ci ? `${signedPct(t.ci.low)} … ${signedPct(t.ci.high)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Do the guards earn their keep?" subtitle="Markets the scanner refuses to rank">
          <div className="space-y-2 px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">
                Longshot filter
                <span className="ml-1.5 text-[11px] text-slate-600">market under 8%</span>
              </span>
              <span className="num text-right">
                <span className="font-semibold text-emerald-300">{signedPct(guards.longshot.roi)}</span>
                <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                  n={guards.longshot.bets}
                  {guards.longshot.ci &&
                    ` · CI ${signedPct(guards.longshot.ci.low, 0)} to ${signedPct(guards.longshot.ci.high, 0)}`}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">
                Wide-gap filter
                <span className="ml-1.5 text-[11px] text-slate-600">12+ pts apart</span>
              </span>
              <span className="num text-right">
                <span className="font-semibold text-amber-300">{signedPct(guards.wideGap.roi)}</span>
                <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                  n={guards.wideGap.bets}
                  {guards.wideGap.ci &&
                    ` · CI ${signedPct(guards.wideGap.ci.low, 0)} to ${signedPct(guards.wideGap.ci.high, 0)}`}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-slate-800 pt-2">
              <span className="text-slate-400">Kept and surfaced</span>
              <span className={`num font-semibold ${tone(guards.kept.roi)}`}>
                {signedPct(guards.kept.roi)}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              The two rules pull opposite ways, and neither interval excludes zero on its own.
              Dropping longshots is backed independently by the calibration data, where the model
              overstated sub-20% chances across {calibration[0].bets} games. The wide-gap rule has no
              such support — the bets it hides returned {signedPct(guards.wideGap.roi)} — but{' '}
              {guards.wideGap.bets} bets is not enough to justify moving it yet.
            </p>
          </div>
        </Section>

        <Section title="Against doing nothing clever" subtitle="Baselines over the same games">
          <div className="space-y-2 px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Bet every line market</span>
              <span className={`num font-semibold ${tone(baselines.blindLine.roi)}`}>
                {signedPct(baselines.blindLine.roi)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Back the market favourite</span>
              <span className={`num font-semibold ${tone(baselines.favourites.roi)}`}>
                {signedPct(baselines.favourites.roi)}
              </span>
            </div>
            <p className="border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
              The scanner beats blind line betting by{' '}
              {(Math.abs(headline.roi - baselines.blindLine.roi) * 100).toFixed(1)}pp, so the model
              carries some information — just not enough to clear the bookmaker&rsquo;s margin.
            </p>
          </div>
        </Section>
      </div>

      <Section
        title="Calibration"
        subtitle="When the model says 70%, does it happen 70% of the time?"
      >
        <div className="space-y-2 px-4 py-3">
          {calibration.map((b) => {
            const error = b.actual - b.predicted;
            return (
              <div key={b.lo} className="grid grid-cols-[5.5rem_2.5rem_1fr_5.5rem] items-center gap-3">
                <span className="num text-xs text-slate-400">
                  {pct(b.lo, 0)}–{pct(b.hi, 0)}
                </span>
                <span className="num text-[11px] text-slate-600">n={b.bets}</span>
                <ErrorBar error={error} />
                <span className="num text-right text-xs">
                  <span className="text-slate-500">{pct(b.predicted, 0)} → </span>
                  <span className="text-slate-300">{pct(b.actual, 0)}</span>
                </span>
              </div>
            );
          })}
          <p className="border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
            Every bucket now lands within about a point of its claim. Before calibration the model
            called longshots at 13.6% that won 6.2%, which is what produced its largest phantom edges.
          </p>
        </div>
      </Section>

      <Section title="Model versus the bookmaker" subtitle={`Head to head over ${mvm.games.toLocaleString()} games`}>
        <div className="scroll-x">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Metric</th>
                <th className="px-2 py-2 text-right font-medium">Model</th>
                <th className="px-2 py-2 text-right font-medium">Market</th>
                <th className="px-4 py-2 text-right font-medium">Winner</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Log loss', mvm.logLoss.model, mvm.logLoss.market, 4],
                ['Brier score', mvm.brier.model, mvm.brier.market, 4],
                ['Margin error (pts)', mvm.marginMae.model, mvm.marginMae.market, 2],
              ].map(([label, model, market, dp]) => (
                <tr key={label} className="border-b border-slate-800/50 last:border-0">
                  <td className="px-4 py-2 text-slate-300">{label}</td>
                  <td className="num px-2 py-2 text-right text-slate-400">{model.toFixed(dp)}</td>
                  <td className="num px-2 py-2 text-right text-slate-400">{market.toFixed(dp)}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium text-slate-400">
                    {model < market ? 'Model' : 'Market'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-800 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
          The bookmaker is sharper on all three, but narrowly. The one place the model holds up: when
          the two disagree by six points or more ({mvm.disagreement.games} games), the model&rsquo;s
          side covered {pct(mvm.disagreement.modelCoverRate, 1)} against a{' '}
          {pct(mvm.disagreement.breakEven, 1)} break-even — promising, but not proven at this sample
          size.
        </p>
      </Section>
    </div>
  );
}
