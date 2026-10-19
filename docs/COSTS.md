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

### Getting a DataForSEO account

(As of October 2026; check [dataforseo.com/pricing](https://dataforseo.com/pricing) for current terms.)

- New accounts get **$1 free**, which covers about 800 checks.
- After that you pay in advance, and DataForSEO's **smallest top-up is $50**.
- The balance never expires. At searchtrace's default $1.00 a month cap, $50 lasts over four years; at a few tens of cents a month, much longer.

searchtrace never spends more than your caps (below), whatever the balance.

### Price per check

The price is **$0.0012 per check** (a standard-queue Google results page with the AI Overview loaded). searchtrace plans with at least that much, even if `serp.costPerCheckUsd` says less, and reads back what each task actually cost. If DataForSEO starts charging more, the run notices from a small first batch and sizes the rest from the real price, so the caps still hold; later runs plan with the higher price.

### What a month costs

Each week searchtrace checks every qualifying search once. A qualifying search ranks in the top 20 with 10 or more impressions in the current window. With daily runs, a month costs about **$0.0012 x qualifying searches x 4.3**, and never more than your monthly cap:

| Qualifying searches | About a month |
|---|---|
| 50 | $0.26 |
| 100 | $0.52 |
| 165 (a very small site with about 80 clicks a month) | $0.86 |
| about 190 or more | the default $1.00 cap is reached every month, and checks pause until the 1st |
| about 250 or more | searchtrace samples instead, spending up to the per-run cap ($0.30) a week |

A worked example: 200 searches checked on desktop is 200 x $0.0012 = $0.24 a week, so that site reaches the $1.00 cap. If you'd rather it cost cents, lower `serp.monthlyBudgetUsd`. `searchtrace run --dry-run` shows how many searches qualify on your site and what this week's checks would cost.

Checks are spread over the weekdays, so run it daily: a site that only runs once a week checks only that weekday's share.

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
- If that list is too long to read in full (a busy shared account), a check searchtrace can't confirm stays reserved and is never sent again; once its week is over it is counted as spent.
- `searchtrace doctor` shows your balance, roughly how many checks it covers, your cap and what's been used this month.

### What it can and can't tell you

On a small site, AI Overview checks will mostly produce facts rather than verdicts: which of your searches show an AI Overview and whether it cites you. Measuring how many clicks an AI Overview costs you needs at least 20 comparable searches on each side with enough expected clicks, and checks across more than one week. searchtrace says plainly when that isn't possible yet.
