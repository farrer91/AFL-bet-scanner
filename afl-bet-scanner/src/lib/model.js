/**
 * Match pricing shared by the data pipeline and the backtest.
 *
 * Both must derive the model line the same way, or the backtest would be
 * scoring something the app never shipped.
 */

export const MARKET_SOURCE_ID = 5; // Squiggle's "Punters" - the bookmaker line
export const SQUIGGLE_SOURCE_ID = 1;

/** Historical std of the actual margin around a predicted margin. */
export const MARGIN_STD = 27;

/**
 * Log-odds sharpening applied to the pooled probability.
 *
 * Even after logit pooling, the tipster panel is under-confident at the
 * extremes: across 2021-2026 it called longshots at 13.6% that won 6.2% of the
 * time, and favourites at 86.4% that won 93.8%. Those errors are what generated
 * the scanner's largest phantom edges. Fitted by maximum likelihood over 1,247
 * completed games; re-fit with `npm run backtest -- --years 2021-2026`.
 */
export const CALIBRATION_K = 1.245;

/** Push a probability away from 50% in log-odds space. */
export const sharpen = (p, k = CALIBRATION_K) =>
  1 / (1 + Math.exp(-k * logit(clamp(p))));

export const logit = (p) => Math.log(p / (1 - p));
const clamp = (p) => Math.min(Math.max(p, 0.01), 0.99);

// The historical AFL relationship between log-odds and points.
export const probToMargin = (p) => (logit(clamp(p)) * 27) / 1.7;
export const marginToProb = (m) => 1 / (1 + Math.exp((-m * 1.7) / 27));

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Pool forecast probabilities in logit space. A plain average drags confident
 * forecasts toward 50%, which then contradicts the averaged margin on lopsided
 * games; the log-odds mean keeps the two consistent.
 */
export const poolProbs = (ps) =>
  ps.length ? 1 / (1 + Math.exp(-mean(ps.map((p) => logit(clamp(p)))))) : 0.5;

/** A tip's margin, oriented to the home side. */
export function tipHomeMargin(t) {
  if (t.hmargin != null && t.hmargin !== '') return Number(t.hmargin);
  if (t.margin != null && t.margin !== '') {
    const m = Number(t.margin);
    return Number(t.tipteamid) === Number(t.hteamid) ? m : -m;
  }
  return probToMargin(tipHomeProb(t));
}

/** A tip's win probability, oriented to the home side. */
export function tipHomeProb(t) {
  // hconfidence is already oriented to the home side; confidence is the tipped
  // team's, so flip it when the tip is against the home team.
  const h = Number(t.hconfidence) / 100;
  if (Number.isFinite(h) && h > 0 && h < 1) return h;
  const c = Number(t.confidence) / 100;
  if (Number.isFinite(c) && c > 0 && c < 1) {
    return Number(t.tipteamid) === Number(t.hteamid) ? c : 1 - c;
  }
  return marginToProb(Number(t.hmargin) || 0);
}

const round = (n, dp = 2) => Number(n.toFixed(dp));

/**
 * Turn one game's tip panel into a priced model line plus the market's.
 * Returns null when the panel is empty.
 */
export function priceGame(game, gameTips) {
  const marketTip = gameTips.find((t) => Number(t.sourceid) === MARKET_SOURCE_ID);
  const modelTips = gameTips.filter((t) => Number(t.sourceid) !== MARKET_SOURCE_ID);
  const squiggleTip = gameTips.find((t) => Number(t.sourceid) === SQUIGGLE_SOURCE_ID);
  if (!modelTips.length && !squiggleTip) return null;

  const modelMargins = modelTips.map(tipHomeMargin).filter(Number.isFinite);
  const modelProbs = modelTips.map(tipHomeProb).filter(Number.isFinite);

  const predictedMargin = modelMargins.length
    ? mean(modelMargins)
    : squiggleTip
      ? tipHomeMargin(squiggleTip)
      : 0;
  const pooled = modelProbs.length ? poolProbs(modelProbs) : marginToProb(predictedMargin);
  const homeWinProb = sharpen(pooled);

  const marketMargin = marketTip ? tipHomeMargin(marketTip) : null;
  const marketProb = marketTip ? tipHomeProb(marketTip) : null;

  return {
    home: game.hteam,
    away: game.ateam,
    predictedMargin: round(predictedMargin, 1),
    // Disagreement between models widens the credible range around the line.
    std: round(Math.sqrt(MARGIN_STD ** 2 + stdev(modelMargins) ** 2), 1),
    homeWinProb: round(homeWinProb, 4),
    pooledProb: round(pooled, 4),
    marketMargin: marketMargin == null ? null : round(marketMargin, 1),
    marketProb: marketProb == null ? null : round(marketProb, 4),
    tipsterCount: modelTips.length,
    tipsterSpread: round(stdev(modelMargins), 1),
    squiggleMargin: squiggleTip ? round(tipHomeMargin(squiggleTip), 1) : null,
  };
}
