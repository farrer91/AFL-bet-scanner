import { edgeTier, pct } from '../lib/edges.js';

/** Colour-coded expected-value pill used across both scanners. */
export default function EdgeBadge({ ev, suspect = false, compact = false }) {
  const tier = edgeTier(ev, suspect);
  return (
    <span
      className={`chip ring-1 ${tier.bg} ${tier.text} ${tier.ring}`}
      title={suspect && ev > 0 ? 'Model and market disagree sharply - verify team news first' : undefined}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tier.dot}`} />
      <span className="num">{ev > 0 ? '+' : ''}{pct(ev)}</span>
      {!compact && <span className="text-[10px] uppercase tracking-wide opacity-70">{tier.label}</span>}
    </span>
  );
}
