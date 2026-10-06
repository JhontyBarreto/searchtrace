# How searchtrace decides

This page is the long answer to "why does it say that?". Every number in a report comes from one of the methods below. The code lives in `src/analyze/`; each section names its file.

searchtrace answers two separate questions about every change:

1. **Is it real?** One of four labels: **Real change**, **Normal wobble**, **Not enough data yet**, **Can't separate the causes**.
2. **Why?** A cause with a confidence badge: **Measured** (a raw fact from an API), **Estimated** (a statistical estimate that passed every check), **Possible** (a lead, not a finding).

## 1. Windows and conventions (`windows.ts`)

All dates are Pacific Time calendar days, because that is how Search Console reports. D is the last finalised ("sealed") day, and L is the window length (28 days unless you change `analysis.windowDays`).

| Window | Days (L = 28) |
|---|---|
| Current | D-27 to D |
| Baseline | D-55 to D-28 (same weekdays as the current window) |
| Curve fit | D-209 to D-28 (182 days ending with the baseline, so the current window is never used to fit the curve) |
| Curve holdout | the last 28 days of the fit window |
| Placebo | D-111 to D-84 and D-83 to D-56 |
| Change points | D-181 to D |
| Seasonal | baseline and current shifted back 364 days, used only when your history reaches that far |

Randomness (bootstrap draws) comes from a generator seeded with `sha256(property | D | inputsHash)`, where `inputsHash` is the sha256 of every stored partition's path and checksum. The same data always gives the same report, byte for byte.

## 2. Brand searches (`brand.ts`)

`compact(s)` lowercases, strips accents and keeps only letters and digits. Brand terms are your `analysis.brandTerms`, the compacted domain label and the compacted site name. A brand token comes from the domain label with generic words (seo, plumbing, digital, london and so on) stripped from either end while at least 4 characters remain: `seoengico` gives `engico`, `pipewell-plumbing` gives `pipewell`.

A search is brand when its compact form contains a term, a token or your compacted domain, or when one of its words (5 or more letters) is one typo away from a token (Damerau-Levenshtein distance 1, so `engigo` and `engcio` count). `doctor` suggests extra brand words it sees acting like a brand on your homepage, but never applies them.

## 3. The click-rate curve (`ctr-curve.ts`)

The curve says what click rate a search would get at a given position, separately for desktop and mobile, brand and non-brand. It is fitted on named day-level cells in the fit window (positions 1 to 100), leaving out searches where an AI Overview cites you, because a citation counts as a position and would bend the curve.

1. **Bins.** Positions 1 to 10 one bin each (bin 1 is 1 to 1.5), then 10.5 to 15.5, 15.5 to 20.5, 20.5 to 30.5, 30.5 to 50.5 and 50.5 to 100. Per segment and bin: clicks x, impressions n, and the impression-weighted centre c.
2. **Prior.** A binomial GLM on the bins: `logit p = a + g*desktop + h*brand + k*desktop*brand - b*ln(c)`, fitted by IRLS (at most 25 iterations, tolerance 1e-8) with step halving. If b comes out negative it is refitted with b = 0, so the prior never rises with position. A weak normal prior (standard deviation 3 on the logit scale) on the non-intercept terms keeps sparse or perfectly separated data finite; with real volume it changes nothing.
3. **Prior strength m.** The value among 40 log-spaced points from 20 to 20,000 that maximises the beta-binomial marginal likelihood `sum log BetaBinomial(x; n, m*p, m*(1-p))`.
4. **Shrinkage.** Each bin's rate is `(x + m*p) / (n + m)`: bins with little data lean on the prior, bins with lots of data keep their own rate.
5. **Monotone.** Pool-adjacent-violators makes each segment non-increasing in position (weights n + m).
6. **Lookup.** Between bin centres the curve is linear in ln(position); beyond the first and last centres it is flat; it never drops below 0.00001.
7. **Mixed segments.** For anonymised searches the curve is a weighted average of the non-brand desktop and mobile curves, weighted by that day's impressions by device.
8. **Calibration.** The curve is refitted without the holdout and checked against it. A segment with at least 30 expected holdout clicks whose actual-to-expected ratio falls outside 0.8 to 1.25 is marked unstable, and ranking or same-spot explanations that rest on it are capped at "Can't separate the causes".
9. **Uncertainty.** A bootstrap replicate redraws every bin's clicks from a Poisson with the prior and m held fixed, then repeats steps 4 to 6.

Calibration of the curve in the test suite (`test/unit/ctr-curve.test.ts`): a true curve of `0.3 * position^-1.2` is recovered within 10% at every position from 1 to 10 when each position has 50,000 impressions (worst case 7.9% across 100 seeds while tuning the test). With only 50,000 impressions in total, sampling noise at position 10 alone is about 10%, and the logit-linear prior cannot bend to a pure power law near position 1, so recovery there is only within about 20%. Data drawn with m = 500 gives an estimate between 200 and 1,250. A bootstrap replicate averages to within 2% of the fitted curve.

## 4. Period comparison (`stats.ts`, used for the headline and the update scorecard)

For daily totals y with weekday factors s, compare two windows of equal length: `R = (B / Sb) / (A / Sa)` where A and B are the window totals and Sa and Sb the summed weekday factors; the change is `R - 1`. The standard error is the larger of the quasi-Poisson one, `sqrt(phi * (1/A + 1/B))`, and an empirical one from every earlier pair of same-length windows (ending every 7 days, skipping Google update windows and the comparison itself) when there are at least 8 such pairs. The empirical pairs also give the "swings this size happen about 1 in N four-week periods" sentence. Floors: 30 clicks or 1,000 impressions in the earlier window.

## 5. Where the clicks went: the waterfall (`waterfall.ts`)

### Units

A named unit is one (page, search, device) from Search Console's query table. Every page also gets one **anonymised remainder** unit: the page's total (which includes searches Google hides for privacy) minus its named searches, per day, across all devices. Page totals are only complete without a device split (we measured this: adding device or country to a page breakdown silently drops the hidden searches), which is why the remainder is per page and not per device.

### The bars

For a unit with impressions I, clicks C and curve-expected click rate F in the baseline (b) and current (c) windows, with `r = C/I - F`:

```
demand  = (I_c - I_b) * (CTR_b + CTR_c) / 2
rank    = (I_b + I_c) / 2 * (F_c - F_b)
samePos = (I_b + I_c) / 2 * (r_c - r_b)
demand + rank + samePos = C_c - C_b   (exactly)
```

This is the Bennet midpoint split, which is also the 3-player Shapley value: it does not depend on the order of the factors, reversing time flips every sign, and it works when clicks are zero. F is computed day by day (`sum I * f(position that day) / sum I`), never at the window's average position: with half the days at position 3 and half at 9, the curve at the average (6) is not the average click rate (Jensen's inequality), and a window-average method would invent a same-spot change.

### Edge cases, in order

1. **Appeared or disappeared.** No impressions in one window: the whole change goes to `appeared` (or `disappeared`). The cause stays Possible: it could be ranking, demand or Google's privacy threshold.
2. **Page-1 crossing.** When the average position crosses 10.5, only the part of the impression change that stable searches also saw counts as demand. The demand index K is current over baseline impressions for stable named units (on page 1 in both windows, moved less than one position) in the same section and device, falling back to the whole site, then to the property's impression ratio (flagged). `demand = I_b * (K - 1) * mean CTR`; the rest of the impression change is `visibility`, shown with ranking.
3. **AI Overview citation flattening.** A search that is cited in at least half of its AI Overview checks now, was not before, and whose average position improved: Google counts the citation as a position, so the "ranking gain" is not real. Its rank and same-spot bars merge into one `aioCitation` bar, labelled Possible.

### The remainder

Per page and day: hidden impressions, clicks and position-weight are the page totals minus the named ones, clamped at zero (flagged when that happens). The remainder's position averages a shifting mix of searches, so its demand bar is sound but its rank and same-spot bars are Possible. Days with fewer than 5 hidden impressions borrow the page's named click-rate expectation for that day.

### Scopes

Section (template), page, search and site bars are plain sums of unit bars, so every scope adds up exactly with no "mix" term. A page's waterfall covers 100% of its clicks. The site scope sums page totals; the report shows it next to the property total ("Page totals 252 clicks, property total 252").

### Uncertainty

A Poisson-cluster bootstrap with B = 1,000 replicates (reduced so that cells x B stays under 3e8, never below 200; the B used is in the diagnostics). Each replicate redraws the curve and every unit's clicks in both windows from a Poisson (a sum of independent cell Poissons is Poisson, so drawing per unit is the same distribution as per cell; clicks are capped at impressions per unit), keeping impressions fixed. Scopes with 30 or more units also resample their units with replacement. One set of unit redraws is shared by every scope in a replicate. Replicates are widened for day-to-day overdispersion: `T_adj = T + sqrt(phi) * (T* - T)`, with phi from site daily clicks over the change-point window. The 95% range is the 2.5% and 97.5% percentiles; the p-value is `min(1, 2 * min((1 + #T_adj <= 0)/(B+1), (1 + #T_adj >= 0)/(B+1)))`.

A scope's relative change is `delta clicks / baseline clicks`, its range the total's range divided by baseline clicks. Floors: 30 baseline clicks or 1,000 baseline impressions for sections, pages and the site; 30 expected baseline clicks for a search. The smallest change worth acting on is 10% for the site and sections, 20% for pages and searches. Section, page and search totals form one false-discovery family (Benjamini-Hochberg at `analysis.fdrQ`, 10% by default).

## 6. The verdict rules (`verdicts.ts`)

Applied in order:

1. **Floors not met:** Not enough data yet, with the smallest change that could be detected (MDE) and how many more weeks that would take.
2. **An identification check failed** (placebo, a reporting change, competing Google updates, too few comparable searches checked, a single SERP check, the same thing last year, an unstable curve): Can't separate the causes.
3. **Real change:** the 95% range excludes zero, the change is at least the smallest change worth acting on, and it survives false-discovery control.
4. **Normal wobble:** the whole range sits inside plus or minus that smallest change, or it excludes zero but the change is smaller than it.
5. Otherwise: Not enough data yet.

Power: from a range, `SE = (ln(1+U) - ln(1+L)) / 3.92`; `MDE = 1 - exp(-2.8 * SE)` (80% power at the 5% level); weeks needed `= T * (2.8 * SE / ln(1 + delta))^2 - T`. More than 52 weeks is reported as not measurable at this traffic level.

Minimum data: unit or search verdicts need 30 expected clicks; page, section and site verdicts need 30 baseline clicks (or 1,000 impressions for impression claims); change points need a mean of 1 a day and 100 in total (60 in weekly mode); the AI Overview estimators need 20 searches and 30 expected clicks per group and period, 2 shared strata and 70% coverage; a site-change comparison needs 30 treated clicks and at least 5 control pages with 50 clicks.

## 7. Change points, the update scorecard, site changes and AI Overviews

These have their own modules; the methods are summarised here so the whole chain is in one place.

- **Change points** (`changepoint.ts`). Weekday-adjusted CUSUM with a long-run variance, one Kolmogorov p-value per series, Benjamini-Hochberg across all series, then exact optimal partitioning (penalty 3 ln n, minimum segment 14 days) to date the change, with an approximate date range. Changes within the last 14 days are "too recent"; two or more same-direction steps within 60 days are "gradual"; a matching move 364 days earlier fails the seasonal check.
- **Localisation** (`localise.ts`). A G-squared test of whether a site-level change is spread proportionally across sections and devices (pointing at demand or Google) or concentrated in one.
- **Update scorecard** (`scorecard.ts`). For each confirmed Google update, the period comparison of section 4 over equal windows either side of the rollout. Another core or spam update within 7 days fails the competing-events check; a reporting change (such as Google's num=100 change in September 2025) caps the impressions row.
- **Site changes** (`site-change.ts`). Each changed page is dated by when Googlebot actually recrawled it (URL Inspection `lastCrawlTime`), not when you deployed. A stacked difference-in-differences compares the changed pages with unchanged pages of the same section over calendar-matched windows, with a placebo 28 days earlier. Title and description changes are judged on click rate at the same position; content changes on impressions; technical changes on index status.
- **AI Overviews** (`aio.ts`). Searches are checked on a fixed weekly design (a census when the budget allows, otherwise certainty units plus Poisson sampling with Horvitz-Thompson weights). A cross-section compares searches that show an uncited AI Overview with similar searches that show none, stratified by baseline position and device; a difference-in-differences compares the same groups before and after, with a placebo. The cross-section is "a comparison, not proof"; the difference-in-differences is "estimated, not measured, and likely understated".

## 8. Putting it together: the synthesis (`attribute.ts`)

The **headline** compares site clicks and impressions over the current and baseline windows (section 4). Its second sentence follows the click verdict: a Real change shows the site's cause; Normal wobble, Not enough data and Can't separate each have their own sentence. When clicks are wobble, impressions are wobble or thin, no change point is real in the current window and no new real finding appeared, the report says only "Nothing important changed".

**Cause for a scope.** The display groups are demand, ranking (rank plus visibility), same spot, AI Overview citation and churn (appeared plus disappeared). A group counts when its range excludes zero, it points the same way as the change, and it is at least a quarter of it. One group names the cause (same spot becomes "AI Overview" when the difference-in-differences is real and uncited AI Overview searches hold at least half of the scope's same-spot loss, "checked" when searches with SERP checks hold at least half, and "unchecked" otherwise); two or more give "several things at once"; none gives "unclear". Then, in order:

1. A site change with a real effect on pages in the scope, whose comparison window overlaps the current window, makes the cause "your change" (or "several things at once" when an update hit at the same time).
2. Otherwise, a change point on the scope near the current window that overlaps a core or spam update makes it a Google update.
3. A reporting change touching the windows caps demand and ranking explanations at "Can't separate the causes".
4. A demand cause with last year's data says whether the same weeks last year moved the same way.

The cause is Estimated only when the change is real, the cause is a single named one and no fallback was used; otherwise Possible. Every finding lists the other explanations it considered (fewer searches, ranking, your change, a Google update, the season, AI Overviews, reporting changes, outages) with whether each was ruled out, and one thing that would prove it wrong.

**Order.** The headline first; then `tier x max(1, |clicks|)`, with tiers Real change 1,000, Can't separate 100, Not enough data 10, Normal wobble 1 and facts 5, plus 0.5 for update rows; ties by id.

## 9. Known limits

- **Hidden searches.** Google hides the searches behind most clicks on small sites (about 80% on the site we tested). Page-level numbers include them; search-level explanations cannot. The coverage line in every report says how much is hidden.
- **Block flattening.** An AI Overview citation counts as a position, so "average position" can improve while clicks fall. searchtrace merges those bars instead of calling it a ranking gain, but it can only do so for searches it has checked.
- **num=100.** In September 2025 Google stopped honouring the `&num=100` parameter, which removed many bot impressions at deep positions: desktop impressions fell and average position improved with no change in real traffic. Demand and position claims whose windows touch it are capped.
- **Jensen.** Expected click rates are computed per day, never at a window's average position (section 5).
- **Small sites.** A site with 20 clicks a week cannot see a 20% change for months. searchtrace says so, with the smallest change it could see and when it will know more, instead of guessing.
- **Annotations.** Changes you record with `searchtrace note` have no recrawl date unless URL Inspection supplies one, so they are never better than Possible.

## 10. Proof on planted data

`searchtrace demo` builds "Pipewell Plumbing", a made-up site with 16 months of history and a planted story (`src/demo/fixture.ts`, expectations in `truth.json`), and `test/e2e/demo.test.ts` checks the story comes back:

| Planted | Expected finding |
|---|---|
| December 2025 core update: the services section slips about 2 positions | the scorecard row for that update is a Real change (clicks about -18% to -25%) |
| A 10% dip during the March 2026 spam and core updates | Can't separate the causes (competing updates) |
| New title template on 40 of 90 blog posts, recrawled 12 to 15 Sep 2026, click rate -30% at the same position | the site-change comparison: "your change", effect between -40% and -20% |
| AI Overviews on 30 uncited how-to searches from 1 Sep 2026, click rate x0.7 | the difference-in-differences is a Real change between -45% and -15% |
| A one-week bump in brand searches on the homepage | Normal wobble |
| A thin page with 29 clicks a window losing 41% | Not enough data yet, with an MDE |

While tuning the fixture the analysis was run on 12 different random seeds of the same story: the December update was a Real change and March was Can't separate in 12 of 12; the AI Overview difference-in-differences was a Real change in 12 of 12, with estimates between -21% and -33% (planted: about -26% once the five affected baseline days are counted); the homepage was Normal wobble and the thin page Not enough data in 12 of 12.

The blog title change is recrawled 12 to 15 Sep and the data ends on 3 Oct, so each changed page has 18 to 21 days after its recrawl. The site-change comparison only measures it once it accepts a post-change window shorter than 28 days; until then it reports the change as too recent, with a date to check again.
