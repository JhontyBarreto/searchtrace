# Changelog

All notable changes to searchtrace are listed here. Versions follow semantic versioning.

## 0.1.0 (2026-10-06)

The first release.

### Collecting

- Credential loader for service-account keys, gcloud Application Default Credentials and google-auth token files, with a clear message when Google wants a fresh sign-in.
- Search Console: a 16-month backfill, daily sealing of finished days, a provisional tail for the chart only, one revalidation per day, paging, truncation flags, retries and pacing.
- Google's update history: a bundled list of past incidents merged with the live feed, classified as core, spam, Discover, other ranking, outage or reporting change.
- Page snapshots: robots.txt, sitemaps, a polite fetcher, field extraction and a text fingerprint, with monthly keyframes and deltas in between.
- URL Inspection: a priority queue within a daily budget, used to date changes by when Googlebot actually recrawled each page.
- Optional AI Overview checks through DataForSEO, with tagging, reconciliation, at-most-once posting and spending caps.

### Analysis

- An exact click waterfall (demand, ranking, click rate at the same position, plus the searches Google hides) at search, page, section and site level, with bootstrap ranges.
- A monotone click-rate curve by device and brand, change-point detection with false-discovery control, a Google update scorecard, a site-change comparison against untouched pages, and AI Overview comparisons.
- One verdict engine for everything: Real change, Normal wobble, Not enough data yet, or Can't separate the causes, with the smallest detectable change and the weeks of data needed.

### Output

- A self-contained HTML report (no scripts, strict Content-Security-Policy, dark mode, print styles), a Markdown report, and a byte-stable `findings.json`.
- `searchtrace why` for the evidence behind any page, search, date or finding.
- A graphify-compatible knowledge graph that keeps its communities between runs.

### Commands

- `setup` (wizard and `--yes`), `run` (with `--dry-run`, `--offline`, `--no-paid`, `--budget`, `--wait`, `--ci`, `--json`), `why`, `doctor`, `demo` and `note`.
- A GitHub Action template that refuses to run in a public repo, commits explicit paths only, builds searchtrace from GitHub at a fixed commit (dependencies pinned by the lockfile, every action pinned to a commit SHA), and keeps your secrets in a read-only job apart from the job that pushes.

### Install and supply chain

- searchtrace is installed from GitHub only: a release tarball attached to each GitHub release, or `npx -y "github:JhontyBarreto/searchtrace#v0.1.0"`, which now builds `dist/` through a `prepare` script. Nothing points at the npm registry name, which isn't ours, and a lint rule keeps it that way. Every hint the CLI prints names the command the way you started it.
- The Action no longer installs searchtrace from the npm registry by name, commits as GitHub's Actions bot instead of an unregistered account name, starts every run (and every re-run) from the latest saved data, and parks a save it can't push on a `searchtrace-unsaved-*` branch instead of losing it.
- The cron line the wizard prints calls Node and searchtrace by full path and writes a log, so cron's bare environment can't break it.
- The crawler's user agent points at this repo, and robots.txt is parsed in linear time (a hostile line used to block for minutes).
- The crawler refuses a host on your property that resolves to a private address, and any port but the site's own (`crawl.allowPrivateAddresses` for split DNS).

### AI Overview spending

- Checks another data folder already paid for (or a run whose save was lost) are adopted from DataForSEO's task list instead of being posted again.
- On a busy shared DataForSEO account, the task list is read newest first and capped; a check that can't be confirmed stays reserved and is never re-posted, and is counted as spent once its week ends.
- An unknown request is only given up after a fresh lookup 15 minutes on, never on a cached answer, and each new attempt gets its own 15 minutes.
- searchtrace plans with at least $0.0012 a check, learns the real price from recent charges, and sends a 10-check probe first, so a higher price can't overshoot the caps.
- A task DataForSEO answers with a final error (40102 No Search Results and the like) is settled instead of being fetched every run for 30 days, and `--wait` only waits for this run's checks.
- Only a real lack of money is reported as a low balance: rate limits, IP whitelists, cost limits and paused accounts get their own messages.
- A competitor's page title that quotes a private key header no longer sinks a whole batch of paid results.

### Setup and doctor

- The wizard defaults to "Not now" for scheduling unless the folder is at the top of a git repo and the credential is a robot key, never offers GitHub Actions for a personal sign-in, names credentials in plain words, and only suggests deleting a key's original when it sits in Downloads.
- A plain gcloud sign-in, which can't read Search Console, is recognised up front and gets the right fix ("insufficient authentication scopes" used to say "add yourself as a user").
- Key paths under your home folder are saved as `~/...`, so a committed `config.json` doesn't carry your username.
- `doctor --credentials FILE` works (its own fix line suggested it), and `doctor --share` hides your site, robot, project, folders and balance for pasting into a public issue.
- Setup and doctor say what DataForSEO costs to start ($1 free, then a $50 minimum top-up), and the cost docs give the real monthly figure.

### Robustness

- `searchtrace why` or `note` during a run no longer crashes the run's index load or loads a file twice: index loads take turns, and a run whose index still fails after a retry saves no findings, report or graph built on it.
- `run --wait` saves the refreshed findings under a fresh name instead of failing on the first run's partition.
- A first run that fails on the first day of data no longer loses that day for good.
- Each CI run reads only the first line of old Search Console days, and restores the search index from the Actions cache.

### Fixed during the real-property verification (6 Oct 2026, sc-domain:seoengico.com)

- Honest verdicts on small sites: when Google's frequent updates left fewer than 8 ordinary four-week pairs, the period comparison fell back to a counting-noise interval that was 2 to 8 times too narrow, so a -16% move in impressions was called a real change. The empirical interval now keeps update periods in that case, and only compares pairs that meet the same minimum data. Section, page and search impression comparisons carry the site's month-to-month swing too.
- A page or section click verdict no longer passes its minimum-data check on 1,000 impressions alone (that alternative is for impression claims), and a relative range never goes below -100%.
- "The same thing happened at this time last year" now needs last year to average at least 1 a day and to have moved the same way.
- The 16-month backfill starts on the 1st of that month, because Google still serves those days (the June 2025 core update was being skipped as "before your history").
- URL Inspection runs 8 checks in flight (still at most 4 a second): Google takes about 8 seconds per check, so 200 checks took 13 minutes. A first run now takes about 11 minutes instead of 21.
- AI Overview checks leave out searches with Google operators such as `site:`, which DataForSEO bills at 5 times the normal price.
- `run --wait` shows one "AI Overview results" row in the run ledger instead of one per 30-second poll.
- findings.json no longer changes when `state/` is cleared (the freshness notice counted days from the disposable provisional tail).
- Report copy: no "didn't change meaningfully" next to +221%, levels instead of "rose by 125,300%" for new pages, gradual changes in daily levels, "Why:" shown with the cause it rates, the smallest detectable change shown whenever it means something, outages and reporting changes labelled in the scorecard, no "n/a" in "Show the maths", and absolute paths when the data folder is outside the current folder.
- `doctor` accepts a key file that sits in a git repo whose `.gitignore` excludes it.
- The homepage's graph node is labelled "/ (homepage)": graphify ignores a query with no letters, so `graphify explain "/"` could never find it.

### Known limits

- The "Check it yourself" links pass page and search filters to Search Console with a parameter format that hasn't been confirmed against Google's documentation. If Search Console ignores them, the link still opens the right property and dates. On 6 Oct 2026 the verification session could not open one by hand (it needs a browser signed in to Search Console), so this is still unconfirmed.
