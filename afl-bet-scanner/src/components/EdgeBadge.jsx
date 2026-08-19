import { edgeTier, pct } from '../lib/edges.js';
import { BACKTEST } from '../data/backtest.js';

/**
 * Colour-coded expected-value pill.
 *
 * `tracked` marks a market type the backtest actually measured - match markets.
 * Player props were never priced against a real book, so their badges carry no
 * track record and must not borrow one.
 */
export default function EdgeBadge({
  ev,
  suspect = false,
  compact = false,
  tracked = false,
  suspectLabel = 'Check news',
  suspectHint = 'Model and market disagree sharply - verify team news first',
}) {
  const base = edgeTier(ev, suspect);
  const tier = suspect && ev > 0 ? { ...base, label: suspectLabel } : base;
  const record = tracked && !suspect ? BACKTEST.tiers.find((t) => t.key === tier.key) : null;

  const title = suspect && ev > 0
    ? suspectHint
    : record
      ? `${record.label} edges returned ${record.roi > 0 ? '+' : ''}${pct(record.roi, 1)} over ${record.bets.toLocaleString()} historical bets`
      : undefined;

  return (
    <span className={`chip ring-1 ${tier.bg} ${tier.text} ${tier.ring}`} title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${tier.dot}`} />
      <span className="num">{ev > 0 ? '+' : ''}{pct(ev)}</span>
      {!compact && <span className="text-[10px] uppercase tracking-wide opacity-70">{tier.label}</span>}
      {record && !compact && (
        <span className="num text-[10px] opacity-60" title="realised, historically">
          ({record.roi > 0 ? '+' : ''}{pct(record.roi, 0)} hist)
        </span>
      )}
    </span>
  );
}
