# What searchtrace costs

searchtrace itself is free and open source. By default every source it uses is free too. The only thing that can cost money is the optional AI Overview check, which you pay to DataForSEO directly, under caps you set.

## Free sources

| Source | Cost | Limits worth knowing |
|---|---|---|
| Search Console performance data | free | about 1,200 requests a minute per site; searchtrace paces itself at 4 a second |
| URL Inspection | free | 2,000 inspections a day and 600 a minute per property, **shared with every other tool you use on that property**. searchtrace uses at most 200 a day (and never more than a quarter of the daily quota) unless you change `inspection.dailyBudget` |
| Google's update history | free | one small public file per run |
| Your own pages | free | fetched politely: robots.txt is honoured, at most 2 at a time, at least a second apart, skipped if the last crawl was under 20 hours ago |

A first run on a small site makes roughly a thousand Search Console requests (a few per day of history). A second run the same day makes two or three.

## AI Overview checks (optional, paid)

Search Console can't tell you whether an AI Overview appeared above your result. searchtrace can check by fetching the results page for some of your searches through [DataForSEO](https://dataforseo.com/)'s standard queue.

### Price per check

The worst case is **$0.0012 per check** (a standard-queue Google results page with the AI Overview loaded). searchtrace plans with that worst case, then reads back what each task actually cost.

A worked example: 200 searches checked once on desktop is 200 x $0.0012 = $0.24 at most. A small site typically spends between $0.05 and $0.30 a month.

### Caps

| Setting | Default | What it does |
|---|---|---|
| `serp.monthlyBudgetUsd` | $1.00 | the most searchtrace will spend in a calendar month (UTC) |
| `serp.maxPerRunUsd` | $0.30 | the most one run will spend |
| `run --budget USD` | none | overrides the per-run cap for one run |
| `run --no-paid` | off | skips paid checks entirely for one run |

Before posting anything, searchtrace works out what it can spend: the smallest of what's left this month, the per-run cap, and your DataForSEO balance. Reaching a cap is a warning, not an error, and the run still exits 0.

### Which searches get checked

searchtrace looks at searches where you rank on the first two pages with some impressions.

- **Census.** If checking all of them fits the budget, it checks all of them. That gives the cleanest comparison, because searches with and without an AI Overview become each other's controls.
- **Sample.** Otherwise it always checks the 20 searches that lost the most clicks and the 20 that matter most, then samples the rest with probabilities proportional to their expected clicks, and weights the results to correct for that. Picking only the biggest losers would bias the answer; the weighting removes that bias.

The choice is fixed for the whole ISO week and saved, and checks are spread across the weekdays.

### How spending is kept honest

- Every task is tagged with a searchtrace id. DataForSEO accounts are often shared with other tools, so only tasks with searchtrace's tag count towards its budget.
- Each run reconciles against DataForSEO's free task list, so the spend searchtrace believes in matches what DataForSEO recorded.
- searchtrace writes down its intent to post before posting. If a request times out after it was sent, it is **never retried**: the next run looks it up in the task list instead, so a flaky connection can't double-charge you.
- `npx searchtrace doctor` shows your balance, roughly how many checks it covers, your cap and what's been used this month.

### What it can and can't tell you

On a small site, AI Overview checks will mostly produce facts rather than verdicts: which of your searches show an AI Overview and whether it cites you. Measuring how many clicks an AI Overview costs you needs at least 20 comparable searches on each side with enough expected clicks, and checks across more than one week. searchtrace says plainly when that isn't possible yet.
