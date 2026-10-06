# Changelog

All notable changes to searchtrace are listed here. Versions follow semantic versioning.

## 0.1.0 (unreleased)

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
- A GitHub Action template, pinned to the exact version, that refuses to run in a public repo and commits explicit paths only.

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
