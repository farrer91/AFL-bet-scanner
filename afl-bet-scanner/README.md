# AFL Bet Edge Scanner

Scans AFL betting markets for statistical edges: fixtures and model tips from
[Squiggle](https://api.squiggle.com.au/), player season averages and match
rosters from the AFL Stats API.

## Running it

```bash
npm install
npm run fetch-data     # writes src/data/
npm run dev
```

`npm run build` produces `dist/`.

## Data pipeline

`scripts/fetch-afl-data.js [--round N] [--year YYYY]`

Without `--round` it takes the lowest-numbered round that still has unplayed
fixtures. It writes four modules into `src/data/`:

| File | Exports |
| --- | --- |
| `matches.js` | `MATCHES` — fixture, model margin, market margin, win probability |
| `teamStats.js` | `TEAM_STATS` (rolling last-8 averages) and `getModelReasoning(match)` |
| `playerProps.js` | `PLAYERS` — season averages with a modelled spread per stat |
| `meta.js` | `META` — round, generation time, counts |

Sources:

1. **Squiggle** `?q=games` for fixtures and results, `?q=tips` for the tipster
   panel. No auth; the contact address travels in the `User-Agent`. The query
   syntax is semicolon-delimited, so the query string is passed through raw
   rather than via axios `params` (which would percent-encode the separators).
2. **AFL Stats API** `statsCentre/players` for season averages, authorised with
   a token from `POST /cfs/afl/WMCTok`. That endpoint sits behind an edge that
   rejects non-browser user agents.
3. **AFL matchRosters** for named sides. Rosters drop per match roughly a day
   out, so teams whose roster is out are cut to the named side and the rest fall
   back to players with 10+ games.

The script exits non-zero rather than writing an empty round, so a scheduled run
cannot wipe good data.

## How an edge is calculated

Squiggle's **Punters** source is the bookmaker consensus, so it is treated as
the market rather than as another model. Everything else is pooled into the
model line, in log-odds space — a plain average of probabilities drags confident
forecasts toward 50% and then contradicts the averaged margin on lopsided games.

Edge is expected value per unit staked: `p × odds − 1`, where `p` is the model's
probability and `odds` is the market price with a 5% overround applied back on
top of Squiggle's de-vigged figure.

Two guards stop arithmetic artifacts being presented as free money:

- **Wide gaps.** When model and market disagree by 12+ points the market usually
  holds late team news the models have not seen. Those markets are flagged
  *Check news*, not ranked as edges.
- **Longshots.** Below an 8% market probability a one-point error doubles the
  expected value. The model is not calibrated that far into the tail, so those
  markets are flagged too.

**Player props carry no market feed.** Nothing publishes AFL prop lines for
free, so the line is modelled at the half-point nearest the season average.
Because the line is our own, the model sits near even money on it by
construction — so the table's output is the **fair price**, not an edge. Set the
line offset and book price to match a real market and the edge column becomes
meaningful.

## Bookmaker odds

```bash
npm run fetch-odds
```

Pulls AFL player props from [The Odds API](https://the-odds-api.com) and writes
`src/data/propOdds.js`. Needs `ODDS_API_KEY` in the environment or a local
`.env`; without it the script exits cleanly and the app falls back to modelled
lines, so nothing depends on the feed being reachable.

Quota is `[markets] x [regions]` per event against 500 free credits a month,
charged only on markets that actually return. The default pair — disposals and
anytime goalscorer — costs 10–18 credits for a full round.

Two things about coverage are worth knowing:

- **The player cap is 450**, raised from 396 once the odds feed showed 29
  players with 10+ games and live book prices were being cut by it. At 450 no
  player with a quoted market is dropped.
- **Books post lines close to the game.** A Thursday fetch found disposals for
  the Thursday match only; the other eight had anytime goalscorer alone. The
  Friday run picks up the rest.
- **Prices are the best of seven books**, which is how line shopping works, but
  it means the headline edge belongs to whichever book is most generous, and
  you need an account there to take it.

Fixtures are matched to events on UTC start time rather than team name, since
the feeds disagree ("St Kilda" vs "St Kilda Saints"). Players are matched on
exact name, then surname plus first initial, which reconciles Daniel/Dan and
Nicholas/Nick. Same-surname collisions are reported rather than guessed. The
script prints its own match rate so a silent drop in coverage is visible.

### Recent form

Player stats are built from per-round game logs, not just season averages. The
same statsCentre endpoint returns single-round figures in `totals` when given a
`roundId`, so a season of logs costs one request per round.

That yields two things: a form-weighted mean (exponential, eight-game half-life)
and a **measured** standard deviation per player, replacing a heuristic that
guessed spread as a fraction of the mean.

Be honest about the size of the win. Walk-forward over 4,441 player-games:

| Predictor | Disposals MAE |
| --- | --- |
| Plain running mean | 3.807 |
| Form-weighted, half-life 8 | **3.788** |

**0.5% better.** Not a transformation. Form weighting matters for the few
players whose role has actually shifted and is a wash for everyone else — but
that tail is exactly where book lines diverge, which is what it was added for.
Half-lives of 3, 5 and 12 all did worse.

An empirical anytime-goal strike rate was also tried, on the reasoning that
goals cluster and Poisson would overstate the chance of at least one. It lost
the same walk-forward test (log-loss 0.5356 vs Poisson's 0.5119) — at ~22 games
a per-player strike rate is too noisy, and shrinking it toward Poisson did not
help either. Pricing stayed on Poisson; the strike rate is kept for display.

Champion Data round ids are zero-padded to two digits. Rounds 10+ work unpadded,
so an unpadded id fails only for rounds 1–9 — silently, since a bad round id
returns an error rather than empty data. That affected the roster fetch too.

### Lines that diverge from the season average

Season averages go stale when a player's role changes, and books price the
current role. Bradley Hill, a rebounding defender averaging 26.7 disposals, was
quoted at 33.5 by two books independently — the model read that as a +49.8%
edge on the Under when it was really our input being six games behind.

Markets whose line sits `PROP_DIVERGENCE_Z` (0.75) model standard deviations
from the player's average are flagged *Check role* rather than ranked, the same
treatment wide-gap match markets get. The threshold is set on reasoning, not
fitted: with only 17 real lines available, every value between 0.7 and 0.9
flagged the same single market, so tuning it would have meant fitting to one
case. Revisit once coverage is broader.

### Earning a prop track record

```bash
npm run settle
```

The six-season backtest covers match markets only — historical prop odds are not
affordable to buy. So they are recorded instead: `scripts/settle-props.js`
snapshots the markets the app is currently showing, and settles any earlier
round against the per-round game logs once its results land. Every run the
record gets one round longer.

What is snapshotted is the output of `playerMarkets` — the same lines, prices
and probabilities the UI displayed — so the record scores what was shown rather
than a reconstruction. Snapshots live in `data/prop-snapshots.json`, outside
`src/` so they never reach the bundle; the settled summary is written to
`src/data/propRecord.js` and shown on the track record tab.

Until that record is substantial, treat prop edges as a shortlist, not a signal.
The match model needed a thousand bets before its interval stopped spanning zero,
and it overstated its edge by ~19 points until it was measured.

## Backtesting

```bash
npm run backtest -- --years 2021-2026 --write
```

Replays every completed game through the same `matchMarkets` code the app ships
— not a reimplementation — settles each bet against the final score, and writes
`src/data/backtest.js` for the track record tab. `--audit` re-verifies that
historical tips are pre-game forecasts.

That check matters: Squiggle stamps a tip's `updated` field when it *grades* the
tip, so every historical row looks post-game. It isn't leakage — all ~28
tipsters on a game share one timestamp landing seconds after the final score,
which is a bulk grading pass. The current round shows the contrast: ungraded,
with 27 distinct submission times.

### What it found

Over 1,260 games (2021–2026), bets the scanner flagged *Strong* claimed +16.0%
expected value and returned **−2.8%**. The data rejects the model's own claim at
p < 0.001.

The cause was under-confidence at the extremes: longshots called at 13.6% won
6.2%, favourites called at 86.4% won 93.8%. Those errors are what manufactured
the largest phantom edges. Sharpening the pooled probability in log-odds space
(`CALIBRATION_K`, fitted by maximum likelihood over 1,247 games) cuts
calibration error from ±7.5pp to ±1.2pp.

Calibration fixed the probabilities, not profitability — post-fix ROI is −2.5%,
with a 95% interval of −10.0% to +5.2%. Against the bookmaker line the model
loses narrowly on log loss, Brier score and margin error. The guards do earn
their keep: markets they suppress returned 3.2pp worse than those kept.

Treat the edge percentages as a ranking, not a forecast. The app says so too.

### Narrowing to model-vs-market disagreements

```bash
npm run study
```

`scripts/study-disagreement.js` tests whether betting the model's side of a
disagreement is profitable. The 6-point threshold looked promising at 55.5%
against a 52.5% break-even — but it does not survive scrutiny:

- Disjoint bands show no smooth structure. The 3–6pt band actually *loses*
  (47.6%); the apparent trend in a cumulative threshold sweep is overlap.
- Walk-forward, choosing the threshold only from earlier seasons, returns +9.6%
  over 113 bets with a 95% interval of −8.0% to +26.2%.
- A permutation test that repeats the threshold search against noise finds a
  result this good **14% of the time**. The effect does not clear multiplicity.

So the scanner was **not** narrowed. Doing so would be fitting to noise.

The study did surface one real thing: the two guards have opposite records.
Dropping longshots is corroborated by the calibration data, but the wide-gap
rule hides bets that returned +14.2% (n=71). Both are reported separately in the
UI rather than as one misleading average. 71 bets is not enough to change the
rule — it is enough to stop claiming it helps.

## Bundle shape

The props table carries ~800KB of player and odds data, so it and the track
record load only when their tab is opened:

| Chunk | Size | gzip |
| --- | --- | --- |
| initial | 169 KB | 54 KB |
| props table (on demand) | 370 KB | 62 KB |
| track record (on demand) | 10 KB | 3 KB |

Nothing in `App.jsx` may import `playerProps.js` or `propOdds.js` — doing so
pulls the whole payload back into the initial chunk. The market counts the
header needs are computed during the data build by `marketTotals()` in
`settle-props.js` and read from `propRecord.js` instead.

## Deployment

`.github/workflows/fetch-afl-data.yml` refreshes data Thursday 08:00 UTC and
Friday 02:00 UTC, and can be run manually with optional `round` / `year` inputs.
It commits `src/data/` and pushes.

Deployment is handled by Vercel's Git integration, which builds on that push.
The workflow holds no deploy step and no secrets, so there is no token to
expire — the failure mode of a CLI deploy is that it lapses months later and
scheduled deploys stop silently.

The Vercel project's root directory must be `afl-bet-scanner`, since the app is
a subfolder of the repository.

---

A statistical tool, not betting advice. Gamble responsibly.
