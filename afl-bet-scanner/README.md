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

## Deployment

`.github/workflows/fetch-afl-data.yml` refreshes data Thursday 08:00 UTC and
Friday 02:00 UTC, and can be run manually with optional `round` / `year` inputs.
It commits `src/data/` and deploys to Vercel.

Required repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

---

A statistical tool, not betting advice. Gamble responsibly.
