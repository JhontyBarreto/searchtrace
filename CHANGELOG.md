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

### Known limits

- The "Check it yourself" links pass page and search filters to Search Console with a parameter format that hasn't been confirmed against Google's documentation. If Search Console ignores them, the link still opens the right property and dates. This will be checked by hand before release and noted here.
