/**
 * Edge maths shared by the match and player-prop scanners.
 *
 * Everything here works in probability space. Bookmaker prices are converted to
 * implied probability, the model's own probability is compared against it, and
 * the difference is expressed as expected value per unit staked.
 */

// Abramowitz & Stegun 7.1.26 - plenty accurate for pricing.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (x, mean, std) =>
  std <= 0 ? (x >= mean ? 1 : 0) : 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));

/** P(X > line) for a continuous approximation to a counting stat. */
export const probOver = (line, mean, std) => 1 - normalCdf(line, mean, std);

/** P(X >= k) for a Poisson count - used for goalscorer markets. */
export function poissonAtLeast(k, rate) {
  if (rate <= 0) return k <= 0 ? 1 : 0;
  let cumulative = 0;
  let term = Math.exp(-rate);
  for (let i = 0; i < k; i += 1) {
    cumulative += term;
    term = (term * rate) / (i + 1);
  }
  return Math.min(Math.max(1 - cumulative, 0), 1);
}

export const impliedProb = (decimalOdds) => (decimalOdds > 1 ? 1 / decimalOdds : 0);
export const probToOdds = (p) => (p > 0 && p < 1 ? 1 / p : Infinity);

/** Expected value per $1 staked at `odds` when the true chance is `p`. */
export const expectedValue = (p, odds) => p * odds - 1;

/** Strip the bookmaker's overround from a two-way market. */
export function devig(probA, probB) {
  const total = probA + probB;
  return total > 0 ? [probA / total, probB / total] : [0.5, 0.5];
}

/** The price you would need for a bet at probability `p` to break even. */
export const fairOdds = (p) => (p > 0 ? 1 / p : Infinity);

export const EDGE_TIERS = [
  { key: 'strong', min: 0.05, label: 'Strong', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-400/30', bg: 'bg-emerald-400/10' },
  { key: 'value', min: 0.025, label: 'Value', dot: 'bg-lime-400', text: 'text-lime-300', ring: 'ring-lime-400/25', bg: 'bg-lime-400/10' },
  { key: 'thin', min: 0.005, label: 'Thin', dot: 'bg-sky-400', text: 'text-sky-300', ring: 'ring-sky-400/20', bg: 'bg-sky-400/10' },
  { key: 'none', min: -Infinity, label: 'No edge', dot: 'bg-slate-600', text: 'text-slate-400', ring: 'ring-slate-700', bg: 'bg-slate-800/40' },
];

export const SUSPECT_TIER = {
  key: 'suspect',
  label: 'Check news',
  dot: 'bg-amber-400',
  text: 'text-amber-300',
  ring: 'ring-amber-400/30',
  bg: 'bg-amber-400/10',
};

/**
 * An edge is only as good as the model behind it. When the model and the market
 * are miles apart the market is usually the one holding late team news, so the
 * bet is flagged for review rather than dressed up as free money.
 */
export const edgeTier = (ev, suspect = false) =>
  suspect && ev > 0 ? SUSPECT_TIER : EDGE_TIERS.find((t) => ev >= t.min);

/** Points of model-vs-market disagreement beyond which we stop trusting the model. */
export const SUSPECT_GAP = 12;

/**
 * Below this probability the model is extrapolating rather than measuring. A
 * one-point error on a 3% shot doubles its expected value, so longshots are
 * flagged for review instead of being ranked as edges.
 */
export const LONGSHOT_FLOOR = 0.08;

export const pct = (v, dp = 1) => `${(v * 100).toFixed(dp)}%`;
export const signed = (v, dp = 1) => `${v > 0 ? '+' : ''}${v.toFixed(dp)}`;

/**
 * Head-to-head and line markets for one fixture.
 *
 * Squiggle's "Punters" source is the bookmaker consensus, already expressed as
 * a de-vigged probability, so the offered price is reconstructed by applying a
 * standard overround before pricing the bet.
 */
export function matchMarkets(match, overround = 1.05) {
  if (match.marketProb == null) return [];
  const markets = [];
  const wideGap = Math.abs(match.predictedMargin - match.marketMargin) >= SUSPECT_GAP;
  const longshot = Math.min(match.marketProb, 1 - match.marketProb) < LONGSHOT_FLOOR;
  const suspect = wideGap || longshot;

  const price = (fairProb) => probToOdds(Math.min(fairProb * overround, 0.99));

  const sides = [
    { side: match.home, label: 'Home', modelProb: match.homeWinProb, marketProb: match.marketProb },
    { side: match.away, label: 'Away', modelProb: 1 - match.homeWinProb, marketProb: 1 - match.marketProb },
  ];

  for (const s of sides) {
    const odds = price(s.marketProb);
    markets.push({
      type: 'H2H',
      market: `${s.side} to win`,
      selection: s.side,
      line: null,
      odds,
      modelProb: s.modelProb,
      marketProb: s.marketProb,
      ev: expectedValue(s.modelProb, odds),
      fair: fairOdds(s.modelProb),
      edgePts: null,
      suspect,
    });
  }

  // Line market: the bookmaker's handicap is their margin, laid at even money.
  const lineOdds = price(0.5);
  const line = -match.marketMargin;
  const coverProb = probOver(-line, match.predictedMargin, match.std);
  markets.push({
    type: 'LINE',
    market: `${match.home} ${signed(line)}`,
    selection: match.home,
    line,
    odds: lineOdds,
    modelProb: coverProb,
    marketProb: 0.5,
    ev: expectedValue(coverProb, lineOdds),
    fair: fairOdds(coverProb),
    edgePts: match.predictedMargin - match.marketMargin,
    suspect,
  });
  markets.push({
    type: 'LINE',
    market: `${match.away} ${signed(-line)}`,
    selection: match.away,
    line: -line,
    odds: lineOdds,
    modelProb: 1 - coverProb,
    marketProb: 0.5,
    ev: expectedValue(1 - coverProb, lineOdds),
    fair: fairOdds(1 - coverProb),
    edgePts: match.marketMargin - match.predictedMargin,
    suspect,
  });

  return markets;
}

/** Stat markets offered for player props, in table order. */
export const PROP_STATS = [
  { key: 'disposals', label: 'Disposals', short: 'DIS', minMean: 8 },
  { key: 'goals', label: 'Goals', short: 'GLS', minMean: 0.3, poisson: true },
  { key: 'marks', label: 'Marks', short: 'MRK', minMean: 2 },
  { key: 'tackles', label: 'Tackles', short: 'TKL', minMean: 1.5 },
  { key: 'clearances', label: 'Clearances', short: 'CLR', minMean: 1.5 },
  { key: 'inside50s', label: 'Inside 50s', short: 'I50', minMean: 1.5 },
  { key: 'kicks', label: 'Kicks', short: 'KCK', minMean: 6 },
  { key: 'handballs', label: 'Handballs', short: 'HBL', minMean: 5 },
  { key: 'hitouts', label: 'Hitouts', short: 'HIT', minMean: 5 },
  { key: 'dreamTeamPoints', label: 'Fantasy pts', short: 'FPT', minMean: 40 },
];

/**
 * Books hang counting-stat props on a half-line so the bet cannot push. Without
 * a live prop feed we cannot know the offered line, so it is placed at the half
 * nearest the season average and can be nudged to match a real book.
 *
 * Placing our own line means the model is, by construction, close to even money
 * on it - so the useful output here is the *fair price*, not a manufactured
 * edge. Real edge only appears once a genuine book price is supplied.
 */
export const modelledLine = (mean) => Math.round(mean - 0.5) + 0.5;

export function playerMarkets(player, bookPrice = 1.91, lineOffset = 0) {
  const out = [];
  for (const stat of PROP_STATS) {
    const s = player.stats[stat.key];
    if (!s) continue;

    let line;
    let over;
    if (stat.poisson) {
      if (s.rate < stat.minMean) continue;
      line = 0.5; // anytime goalscorer - the line is fixed, so no offset
      over = poissonAtLeast(1, s.rate);
    } else {
      if (s.mean < stat.minMean) continue;
      line = modelledLine(s.mean) + lineOffset;
      if (line <= 0) continue;
      over = probOver(line, s.mean, s.std);
    }

    for (const [dir, p] of [['Over', over], ['Under', 1 - over]]) {
      if (stat.poisson && dir === 'Under') continue; // anytime scorer is one-way
      out.push({
        statKey: stat.key,
        stat: stat.label,
        short: stat.short,
        direction: dir,
        line,
        market: stat.poisson ? 'Anytime goal' : `${dir} ${line} ${stat.label.toLowerCase()}`,
        odds: bookPrice,
        modelProb: p,
        marketProb: impliedProb(bookPrice),
        fair: fairOdds(p),
        ev: expectedValue(p, bookPrice),
      });
    }
  }
  return out;
}
