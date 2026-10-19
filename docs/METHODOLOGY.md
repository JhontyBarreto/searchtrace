# How searchtrace decides

This page is the long answer to "why does it say that?". Every number in a report comes from one of the methods below. The code lives in `src/analyze/`; each section names its file.

searchtrace answers two separate questions about every change:

1. **Is it real?** One of four verdicts: **Real change**, **Normal wobble**, **Not enough data yet**, **Can't separate the causes**. Wobble splits into two labels: **Small change** (real, but smaller than the size worth acting on) and **Normal wobble** (not shown to be real, and any real change is that small). A raw observation (an AI Overview seen on a search, an index state) passed no test and is labelled **Measured fact**, never Real change.
2. **Why?** A cause with a confidence badge: **Measured** (a raw fact from an API), **Estimated** (a statistical estimate that passed every check), **Possible** (a lead, not a finding). A cause is only named next to a Real change or Can't separate: next to wobble, a small change or too little data, "Why?" is left out.

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

`compact(s)` lowercases, strips accents and keeps only letters and digits. Brand terms are your `analysis.brandTerms`, the compacted domain label and the compacted site name. A brand token comes from the domain label with generic words (seo, plumbing, digital, london and so on) stripped from either end while at least 4 characters remain: `seonorvico` gives `norvico` (a made-up brand; a brand ending in "co" keeps it), `pipewell-plumbing` gives `pipewell`.

A search is brand when its compact form contains a term, a token or your compacted domain, or when one of its words (5 or more letters) is one typo away from a token (Damerau-Levenshtein distance 1, so `norvigo` and `norvcio` count). `doctor` suggests extra brand words it sees acting like a brand on your homepage, but never applies them.

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

For daily totals y with weekday factors s, compare two windows of equal length: `R = (B / Sb) / (A / Sa)` where A and B are the window totals and Sa and Sb the summed weekday factors; the change is `R - 1`. The standard error is the larger of the quasi-Poisson one, `sqrt(phi * (1/A + 1/B))`, and an empirical one, `1.4826 * MAD` of the log ratios of every earlier pair of same-length windows (ending every 7 days, skipping Google update windows and the comparison itself) when there are at least 8 such pairs. Floors: 30 clicks or 1,000 impressions in the earlier window.

Three refinements, found on a small real site in October 2026:

- **Too many updates to skip.** Google shipped a core or spam update every few weeks in 2025 and 2026, and each one's window (plus 7 days either side) removes every 56-day pair it touches, so fewer than 8 ordinary pairs were left and the quasi-Poisson SE was used alone. That SE ignores how much a site's totals swing from month to month: on that site it was 2 to 8 times narrower than the spread of its own 28-day log ratios, so ordinary monthly swings were called real changes. When skipping update windows leaves fewer than 8 pairs, the SE now uses every pair. A robust (MAD) spread over that mixture widens only modestly from the update tails, so this mostly protects the SE when ordinary months are noisy.
- **The "1 in N" sentence uses ordinary periods only.** "Swings this size happen about 1 in N four-week periods" counts tails, and update periods are exactly the tails, so the frequency only ever comes from ordinary pairs, and there is no sentence when fewer than 8 of them exist (it used to count update pairs whenever the fallback kept them, so one core update could supply most of the "swings"). It is also only printed for a change whose range contains zero: next to a range that excludes zero it would contradict the range. Pairs end every 7 days and span twice the window, so K overlapping pairs are worth about `K * 7 / (2L)` independent ones; overlap does not bias a frequency, it only makes it noisier.
- **Comparable pairs only.** A historical pair counts only when both of its windows meet the comparison's own floor. Months from a much quieter era swing on counting noise alone and would inflate the spread.

Sections, pages and searches don't have enough history of their own, so their comparisons (clicks and impressions) add the site's period-to-period variance, `max(0, SE_emp^2 - phi * (1/A + 1/B))` from the headline comparison, to their own counting variance (section 5).

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

Section (template), page, search and site bars are plain sums of unit bars, so every scope adds up exactly with no "mix" term. A page's waterfall covers 100% of its clicks. The site scope sums page totals; the report checks them against the property total ("Check: your pages add up to the site total across both periods").

### Uncertainty

The ranges answer two different questions, and each has one source.

**Is the scope's total change real?** Every scope is a census of its units, so its total has no sampling of units to model: its uncertainty is counting noise plus the period-to-period swing every series shows. One closed form, the same kind of interval the headline uses, gives it: `se = sqrt(phi * (1/Cb + 1/Cc) + v_extra)` on `ln(Cc / Cb)`, where phi comes from site daily clicks over the change-point window and `v_extra` is the site's period-to-period variance from section 4 (0.5 stands in for a zero total). The relative range is `exp(ln(Cc/Cb) +- 1.96 se) - 1`, never below -100%, and the range in clicks is the baseline times it, so the percent and the clicks always agree. For the whole site the headline's own comparison is used, centred on the raw change: `[B e^(-1.96 se) - A, B e^(1.96 se) - A]`; the table's Total row, the chart's Total whisker, `why` and `findings.json` all show this one range.

**How sure are we of the split, given these two windows?** A Poisson bootstrap with B = 1,000 replicates (reduced so that cells x B stays under 3e8, never below 200; the B used is in the diagnostics). Each replicate redraws the curve and every unit's clicks in both windows from a Poisson (a sum of independent cell Poissons is Poisson, so drawing per unit is the same distribution as per cell; clicks are capped at impressions per unit), keeping impressions fixed. Units are never resampled: resampling a census adds the spread of real effects across units, which is not uncertainty about this site's total, and it made a drop concentrated in a few units look less certain the more concentrated it was. One set of unit redraws is shared by every scope in a replicate. Replicates are widened for day-to-day overdispersion: `T_adj = T + sqrt(phi) * (T* - T)`. A part's 95% range is the 2.5% and 97.5% percentiles. The bars always sum to the total whatever the curve, so curve redraws move the split, never the total.

A scope's relative change is `delta clicks / baseline clicks`. Floors: 30 baseline clicks for sections, pages and the site (the waterfall is a claim about clicks, so 1,000 impressions does not stand in for it); 30 expected baseline clicks for a search. The smallest change worth acting on is 10% for the site and sections, 20% for pages and searches; the same unit gets the same bar in its change points.

**False discoveries (family 2).** The family is fixed before looking at the current window: every section, plus every page and search that meets its baseline floor, not only the 50 biggest movers that get a full breakdown. Ranking by the size of the change only chooses what is shown (the 25 biggest pages and searches), never what is tested: picking the top movers first enriches the family with small p-values and hands the rest q-values that are too small by up to the ratio of eligible to tested scopes. Benjamini-Hochberg runs at `analysis.fdrQ` (10% by default) over that whole family with the closed-form p of each scope. The lists are ranked by size of change; each range is for that page or search alone, not adjusted for it being picked as a top mover.

**Hidden searches.** When most of a part's ranking or same-spot movement (by absolute size, so named and hidden bars of opposite sign still count) comes from the anonymised remainder, that part is marked Possible in the table and in "Show the maths", and a cause resting on it is Possible: the remainder's average position mixes a changing set of searches, which no bootstrap can capture. A ranking sentence built on it quotes the page-level positions and says the move is mostly on searches Google doesn't name.

## 6. The verdict rules (`verdicts.ts`)

Applied in order:

1. **Floors not met:** Not enough data yet, with the smallest change that could be detected (MDE) and how many more weeks that would take.
2. **An identification check failed** (placebo, a reporting change, competing Google updates, too few comparable searches checked, a single SERP check, the same thing last year, an unstable curve): Can't separate the causes.
3. Then two questions. **Is it real?** The 95% range excludes zero and the change survives false-discovery control (q at most `analysis.fdrQ`). **Is it known to be small?** The whole range sits inside plus or minus the smallest change worth acting on (delta).

| | Known to be small | Not known to be small |
|---|---|---|
| **Real** | **Small change** (wobble verdict, reason `noise_small`): "Clicks fell 8% (likely 6.5% to 9.6%). That's a real drop, but smaller than the 10% we treat as worth acting on." | **Real change**. When the estimate itself is below delta, the sentence gives the range ("at least 5%, possibly 14%"). |
| **Not shown to be real** | **Normal wobble** (reason `noise_bounded`): "any real change is smaller than 10%". | **Not enough data yet** |

A range that excludes zero but fails false-discovery control is never called real. "Nothing to act on" and "normal ups and downs" are only ever said about Normal wobble, and the "1 in N four-week periods" frequency only when the range contains zero (section 4). The report never runs "Nothing important changed" for a small change: only when clicks are Normal wobble.

Power: from a range, `SE = (ln(1+U) - ln(1+L)) / 3.92`; `MDE = 1 - exp(-2.8 * SE)` (80% power at the 5% level); weeks needed `= T * (2.8 * SE / ln(1 + delta))^2 - T`. More than 52 weeks is reported as not measurable at this traffic level; the report still gives the smallest detectable change when it is under 95%, and adds that a much smaller change could not be confirmed even with a year of data.

Minimum data: unit or search verdicts need 30 expected clicks; page, section and site verdicts need 30 baseline clicks (or 1,000 impressions for impression claims); change points need a mean of 1 a day and 100 in total (60 in weekly mode), and any ratio claim needs at least 30 counts before the change; the AI Overview estimators need 20 searches and 30 expected clicks per group and period, 2 shared strata and 70% coverage; a site-change comparison needs 30 treated clicks and at least 5 control pages with 50 clicks.

## 7. Change points, the update scorecard, site changes and AI Overviews

These have their own modules; the methods are summarised here so the whole chain is in one place.

- **Change points** (`changepoint.ts`, `cp-history.ts`). Weekday-adjusted CUSUM with a long-run variance, one Kolmogorov p-value per series, Benjamini-Hochberg across all series (family 1), then exact optimal partitioning (penalty 3 ln n, minimum segment 14 days) to date the change, with an approximate date range. Changes within the last 14 days are "too recent"; two or more same-direction steps within 60 days are "gradual"; a matching move 364 days earlier fails the seasonal check. Refinements of the textbook recipe:
  - *Floor on the scale.* The long-run variance is floored at the overdispersed Poisson variance (`max(gamma0, phi * mean)`), because the Bartlett estimate on residuals around the best split made far-tail p-values about 3.6 times too likely on null series (with the floor, P(p < 0.05) is about 0.03 and the family-wise rate under Benjamini-Hochberg 0.03 to 0.08, while power for a -40% step at 3 a day only drops from 0.95 to 0.93).
  - *Period-to-period wander.* Day-level dispersion (a MAD around a +-7 day mean) cannot see a level that wanders over weeks, and on a real site that wander turned into strings of "Real change" steps. Each series now gets `v_extra`, the robust variance of its own 28-day log ratios minus their Poisson part, measured on its history before the window, using only pairs whose windows both hold at least half its current 28-day level (falling back to the whole site's, then to the headline's when there are fewer than 8 such pairs). It adds `L * m^2 * v_extra / 2` (L = 56 days) to the CUSUM scale and `L * m * v_extra / 2` to the dispersion used for the partition, the date ranges and each change's range, so change points carry the same kind of period variance as the headline. With AR(1) level wander and no events this cut P(p < 0.05) from 0.63 to about 0.01, while a -40% step with wander was still found in about half the series.
  - *Each change tested on its own.* A series that barely passes family 1 used to hand its q to every boundary located in it. Each boundary now gets its own p from the same calibrated CUSUM on the span between its neighbouring boundaries (which accounts for the scan over possible dates; a merge-versus-split likelihood ratio at a chosen split is not chi-square), and Benjamini-Hochberg runs across every located change (family 1b). Boundary dates and ranges are approximate after this selection.
  - *Temporary changes.* A step that comes back to its earlier level (within 15%) within 60 days is one "temporary" finding (a dip or a spike from d1, back around d2) rather than two opposite changes; it is real only when both edges pass their own tests, so real outages stay visible and wander episodes fail.
  - *New pages.* A page first seen inside the window (no value before that day in its whole stored history; without stored history, 14 empty days in a row) is zero and then positive, so "constant rate over the window" is false by construction. Births are tested only from 28 days after they appear, and the appearances are one Measured fact ("N pages started appearing in Google between X and Y; together about Z impressions and W clicks a day now"), never a percent change or an update cause. A rise from fewer than 30 counts joins that fact too. This also stopped near-zero p-values of births from loosening Benjamini-Hochberg for every other series. A page that stops appearing is still a finding.
  - *Same unit, same bar.* A change point uses its unit's delta (10% for the site and sections, 20% for pages and searches, the site's for brand and non-brand searches), the same as the unit's 28-day comparison.
  - *Timing names an update only when it is tight.* A change is put down to a Google update (or outage) only for a step whose date range is 14 days or less; a gradual slide or a wide range overlaps some update by chance.
  - *One change, listed once.* A section made almost entirely of one tested page (95% or more of its volume over the change-point window, such as the home page plus a few `?query` variants) is kept as a localisation segment but not tested itself.
  - *Too recent* is judged from the maximum-likelihood single split rather than the raw CUSUM peak, which lags a late step by weeks. Change points are searched over the last 182 sealed days only, so older events (such as a core update ten months ago) are measured by the update scorecard, not by a change point. A change point that can't be attributed says which check stopped it.
- **Localisation** (`localise.ts`). A G-squared test of a site-level change across sections and devices, with four outcomes: concentrated (rejected at 5%, with the sections that moved most); in proportion, only when every section's change relative to the whole is shown to sit within 15% (an equivalence check, which small sites rarely pass, and that is the honest answer); no single section stood out (not rejected, but not shown to be proportional either, with each section's own change listed); and untestable (fewer than 2 sections with data). Failing to reject is never read as "in proportion", and a section with its own real change around the same dates overrules it.
- **Update scorecard** (`scorecard.ts`). For each confirmed Google update, the period comparison of section 4 over equal windows either side of the rollout. Another core or spam update within 7 days fails the competing-events check; a reporting change (such as Google's num=100 change in September 2025) caps the impressions row.
- **Site changes** (`site-change.ts`). Each changed page is dated by when Googlebot actually recrawled it (URL Inspection `lastCrawlTime`), not when you deployed. A stacked difference-in-differences compares the changed pages with unchanged pages of the same section over calendar-matched windows, with a placebo 28 days earlier. Title and description changes are judged on click rate at the same position; content changes on impressions; technical changes on index status.
  - **Windows.** For a page first seen by Google on day d: 28 days before (d-28 to d-1), a 3-day gap, then 28 days after (d+3 to d+30). When the data ends before d+30, both windows shrink to the number of days the post window has, as long as that is at least 14 (two full weeks, so every weekday is seen twice); with fewer, the change is "too recent" and the report gives the day it first has 14 (d+16). Keeping the two windows the same length makes every ratio a like-for-like comparison: the effect, the untouched pages' own change and the placebo. Shorter windows only cost precision, which the bootstrap intervals and the weeks observed (used for the smallest detectable change) carry. Changed and untouched pages always share each page's calendar dates, so weekdays and seasons cancel.
  - **The sentence.** "{k} of the {n} pages you changed lost clicks" counts the changed pages measured (n) and those with fewer clicks a day after than before (k). The spec's draft wording ("k of the n pages that lost clicks changed") would need a count of untouched pages that lost clicks, and on small pages half of them dip by noise alone, so the sentence would mislead.
- **AI Overviews** (`aio.ts`). Searches are checked on a fixed weekly design (a census when the budget allows, otherwise certainty units plus Poisson sampling). A search enters the estimators only as present or absent, which needs 2 or more checks, so its weight is not one week's inclusion probability: under coordinated weekly sampling (one permanent random number per search) it has 2 or more checks exactly when that number is below the second-largest weekly pi, so the Horvitz-Thompson weight is 1 / (the second-largest pi among its own checks), and 1 / (its largest pi) for a single check. The ratio estimators are approximately, not exactly, unbiased. A cross-section compares searches that show an uncited AI Overview with similar searches that show none, stratified by baseline position and device; a difference-in-differences compares the same groups before and after, with a placebo. The cross-section is "a comparison, not proof"; the difference-in-differences is "estimated, not measured, and likely understated". When an estimate can't be made, the report says what failed: one check per search so far, too few searches at comparable positions, too few searches in a group, or too few clicks.
  - *Apportioning.* Each uncited search in a kept stratum gets `a_q = CF_q * |tau|`, with `CF_q = E_q,c * R_U,s,b * R_N,s,c / R_N,s,b` its own counterfactual, so the weighted sum is exactly the estimate's missing clicks. Per search it is capped at its own same-position loss, so the per-search numbers are shares that need not add up to the site estimate. The click breakdown never counts the AI Overview loss as its own bar (it sits inside "Same position, fewer clicks"); when the difference-in-differences is real, a line under the table quotes its missing clicks and range.
  - *Devices.* Checks run on a search's main device only, so the other device of a checked search takes the checked device's AI Overview status instead of counting as "no AI Overview" when the report asks whether uncited AI Overviews hold most of a scope's same-spot loss.
  - *Cited sites.* The sites an AI Overview cites are ranked by how many checks cite them, then how many of their pages are cited, then where they are first cited, never alphabetically.

## 8. Putting it together: the synthesis (`attribute.ts`)

The **headline** compares site clicks and impressions over the current and baseline windows (section 4). Its second sentence follows the click verdict: a Real change shows the site's cause; Small change, Normal wobble, Not enough data and Can't separate each have their own sentence. When the site total is wobble or small but a section, page or search really changed, the sentence names the biggest one with its own clicks. When clicks are Normal wobble, impressions are wobble or thin, no change point is real in the current window and no new real finding appeared, the report says only "Nothing important changed".

**Cause for a scope.** The display groups are demand, ranking (rank plus visibility), same position, AI Overview citation and churn (started or stopped showing). A group counts when its range excludes zero, it points the same way as the change, and it is at least a quarter of it. One group names the cause (same position becomes "AI Overview" when the difference-in-differences is real and uncited AI Overview searches hold at least half of the scope's same-spot loss, never for a gain; "checked" when searches with SERP checks on any device hold at least half of the same-spot movement in the direction of the change, and "unchecked" otherwise); two or more give "several things at once"; none gives "unclear". A section, page or search that gets "AI Overview" borrows the site-wide estimate, so its cause is Possible and its sentence gives its own share of the loss ("about 42 of the 78 clicks lost"). Then, in order:

1. A change point on the scope near the current window that overlaps a core or spam update makes it a Google update.
2. A site change with a real effect on pages in the scope, whose comparison window overlaps the current window, is weighed by its attributable share of the scope's change: over the changed pages in the scope, clicks after minus clicks before times (1 + the untouched pages' change), divided by the scope's change. At least half makes the cause "your change" (or "several things at once" when an update hit at the same time); a quarter to a half names it alongside the other cause ("several things at once", Possible); less leaves the other cause standing, with "your change" as a possible alternative. A minor edit on two pages is never blamed for a site-wide drop that an update or demand explains.
3. A reporting change touching the windows caps demand and ranking explanations at "Can't separate the causes".
4. A demand cause with last year's data says whether the same weeks last year moved the same way.

The cause is Estimated only when the change is real, the cause is a single named one and no fallback was used; otherwise Possible. Every finding lists the other explanations it considered (fewer searches, ranking, your change, a Google update, the season, AI Overviews, reporting changes, outages) with whether each was ruled out, and one thing that would prove it wrong. That line is a real falsifier: for a wobble or small verdict it is the new level holding (or the change growing), never "if it reverts, it was a blip", which would confirm it; "When we'll know" and "Next step" lines are labelled as such. Fewer searches and ranking are ruled out when their range contains zero and they are under a quarter of the change (the spec rule), and also when their whole range sits inside a quarter of the change either way: a part measured precisely as tiny ("average position 4.0 to 4.0") is not a meaningful explanation even if it is not exactly zero. The season is only offered as an explanation when impressions moved by at least 5%, since it works through demand.

**One story, told once.** When a page's 28-day comparison is wobble or thin but a real change point on the same page falls inside the current window, the report shows one item led by the change point, with how much the full period dilutes it ("Over the full 28 days it's -20%, because the first 9 days were still at the old level") and any linked site change as Possible. Lists group what one cause or one estimate explains (searches losing clicks to the same AI Overview estimate, pages moved by the same site change, everything too thin to judge, small changes, wobble), with each finding still listed, with its own maths, under the summary.

**Boring.** "Nothing important changed" also needs that no real finding is new. New means first reported for this data day or later: the pipeline saves each run's findings with the data day, so analysing the same data again (a second run the same day, `why`, `run --offline`) gives the same answer and byte-identical `findings.json`. An AI Overview seen on a search is a record, not a change in traffic, so it never makes a run interesting on its own; a page leaving Google's index does.

**Order.** The headline first; then `tier x max(1, |clicks|)`, with tiers Real change 1,000, Can't separate 100, Not enough data 10, Normal wobble and Small change 1 and facts 5, plus 0.5 for update rows; ties by id. "Also worth knowing" takes real changes about the compared period only (sections, pages and searches before whole-site series), one item per unit with its change point and site-change impact folded in, ranked by clicks and then by date.

## 9. Known limits

- **Hidden searches.** Google hides the searches behind most clicks on small sites (about 80% on the site we tested). Page-level numbers include them; search-level explanations cannot. The coverage line in every report says how much is hidden.
- **Block flattening.** An AI Overview citation counts as a position, so "average position" can improve while clicks fall. searchtrace merges those bars instead of calling it a ranking gain, but it can only do so for searches it has checked.
- **num=100.** In September 2025 Google stopped honouring the `&num=100` parameter, which removed many bot impressions at deep positions: desktop impressions fell and average position improved with no change in real traffic. Demand and position claims whose windows touch it are capped.
- **Jensen.** Expected click rates are computed per day, never at a window's average position (section 5).
- **Small sites.** A site with 20 clicks a week cannot see a 20% change for months. searchtrace says so, with the smallest change it could see and when it will know more, instead of guessing.
- **Annotations.** Changes you record with `searchtrace note` have no recrawl date unless URL Inspection supplies one, so they are never better than Possible.

## 10. Proof on planted data

`searchtrace demo` builds "Pipewell Plumbing", a made-up site with 16 months of history and a planted story (`src/demo/fixture.ts`, expectations in `truth.json`), and `test/e2e/demo.test.ts` checks the story comes back, through the real `demo`, `run --offline` and `why` commands, with golden files for the terminal output:

| Planted | Expected finding | Default seed |
|---|---|---|
| December 2025 core update: the services section slips about 2 positions | the scorecard row for that update is a Real change | clicks -24% (-25% to -22%) |
| A 10% dip during the March 2026 spam and core updates | Can't separate the causes (competing updates) | Can't separate |
| New title template on 40 of 90 blog posts, recrawled 12 to 15 Sep 2026, click rate x0.7 at the same position | the site-change comparison says "your change", effect between -40% and -20% | -32% (-35% to -26%), placebo -0.8% |
| AI Overviews on 30 uncited how-to searches from 6 Sep 2026, click rate x0.7 | the difference-in-differences is a Real change between -45% and -15% | -29% (-34% to -24%) |
| A one-week bump in brand searches on the homepage | Normal wobble | Normal wobble, +4.7% |
| A thin page with 29 clicks a window losing 41% | Not enough data yet, with the smallest detectable change | Not enough data, MDE 63% |

**Robustness.** On 10 random seeds of the same story every planted expectation comes back in 10 of 10: the December update is a Real change and March is Can't separate; the AI Overview difference-in-differences is a Real change (estimates from -26% to -33% when last measured, planted -30%); the blog title change is "your change" (effects from -25% to -39%, planted -30%); the homepage is Normal wobble and the thin page Not enough data. The whole site's -6% to -8% is a Small change in 9 of 10 seeds and a Real change in one, whose range reached past 10%. (An earlier version called the blog "several things at once" on one seed, where the untouched blog pages happened to rise 11% inside the September 2026 spam update.)

**How the fixture was made robust.** Three things in the first version of the fixture made the story fragile, and each was a modelling problem in the fixture, not a tolerance to loosen:
- *AI Overview start date.* The spec placed the AI Overviews from 1 Sep, which is inside the baseline window (9 Aug to 5 Sep), so five treated days diluted the baseline and the estimate sat near -16% to -26%, at the edge of its band. The AI Overviews now start on 6 Sep, the first day of the current window: a clean before-and-after, as the difference-in-differences assumes.
- *Shared search texts.* Some blog searches had exactly the same text as an AI Overview search ("how to stop a dripping tap"), but the planted AI Overview only touched the services page, so the "AI Overview" group mixed affected and unaffected clicks. Every search text now belongs to one page.
- *Comparison pages.* Almost all blog traffic sat on four changed posts and three unchanged ones, so the comparison for the title change rested on three pages and swung by 10% between seeds. Twelve popular posts (seven changed, five not) now carry most blog traffic, and the quiet pages elsewhere were made quieter so the thin page still ranks among the 25 pages that moved most (it can only get a finding there; 5.12 reports the top 25 pages).

The December update's change point on the services section, in the spec's story table, is not expected: change points are searched over the last 182 days (5.6), and December 2025 is ten months before the data ends. The update scorecard measures it instead.

The blog title change is recrawled 12 to 15 Sep and the data ends on 3 Oct, so each changed page has 16 to 19 days after its 3-day gap. It is measured on those shorter windows (section 7), which is why its interval is wider than the AI Overview one.
