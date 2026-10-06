# Data format

Everything searchtrace knows about your site lives in one folder, `searchtrace-data/` by default. This page describes what is in it, so you can read it with other tools, back it up with confidence, or debug a run.

The short version:

- The **partitions** (gzipped NDJSON files) are the source of truth. They are written once and never edited.
- The **ledger** files are append-only logs of runs, spend, index checks and data events.
- The **index** (`state/index.sqlite`) is a disposable cache built from the partitions. Delete it any time; the next run rebuilds it.
- Nothing in the folder holds a key or password. Every line is checked for registered secrets before it is written.

## The folder

```
searchtrace-data/
  config.json                            settings (no secrets)
  meta.json                              { schema: 1, property, createdAt, toolVersion }
  .gitignore
  gsc/2026/10/2026-10-03.ndjson.gz       one sealed Search Console day (all five slices)
  gsc/2026/10/2026-10-03.r2.ndjson.gz    a later revision of the same day, when Google changed its numbers
  google/2026/10/<runId>.ndjson.gz       Google events that were new or changed in that run
  crawl/2026/10/<runId>.ndjson.gz        page snapshots from that run
  inspect/2026/10/<runId>.ndjson.gz      URL Inspection results from that run
  serp/2026/10/<runId>.ndjson.gz         AI Overview checks collected in that run
  findings/2026/10/<runId>.ndjson.gz     findings, written only when they changed
  annotations.ndjson                     your notes from `searchtrace note`
  ledger/runs/2026-10.ndjson             run start and end records
  ledger/spend/2026-10.ndjson            DataForSEO design, intent, posted, failed, unknown, abandoned, collected
  ledger/inspect/2026-10.ndjson          index checks used per Pacific Time day
  ledger/events/2026-10.ndjson           revalidated, revision, truncated and deferred days
  reports/latest.html  latest.md  findings.json
  graphify-out/graph.json  graphify-out/searchtrace.meta.json
  state/                                 never committed: index.sqlite, gsc-fresh.ndjson.gz, lock, cache/
```

The folder is meant to be committed to a **private** repository (or kept on local disk). `state/` is ignored by git because everything in it can be rebuilt or is only useful on the machine that made it.

### Names and paths

Paths are only ever built from validated dates, fixed names and run ids. A URL never becomes part of a file name.

- **Days** are calendar days in Pacific Time (`America/Los_Angeles`), because that is the day Search Console reports. `2026-10-03` means the 24 hours starting at midnight in California.
- **Months** in `ledger/` file names and in the `YYYY/MM` folders of per-run partitions are UTC months, taken from the record's `at` time (ledger) or the run's start time (partitions).
- **Run ids** look like `r20261006t061700z-3f2a`: `r`, the UTC start time as `yyyymmddThhmmssZ` in lower case, a dash, and 4 hex digits.

## Partitions

A partition is a gzip file holding UTF-8 newline-delimited JSON:

```
{"_meta":{"kind":"gsc_day","schema":1,"property":"sc-domain:example.com","toolVersion":"0.1.0","runId":"r20261004t061700z-0a01","fetchedAt":"2026-10-04T06:17:00Z","day":"2026-10-03","revision":1,"dataState":"final","slices":{"qpd":{"rows":2,"truncated":false}}}}
{"s":"t","c":6,"i":531,"ps":5310}
{"s":"td","dv":"desktop","c":5,"i":400,"ps":3600}
...
```

- Line 1 is always `{"_meta": ...}`. Every following line is one JSON object (a row). Every line ends with `\n`.
- Files are written to a temporary name, flushed to disk, renamed into place, and then the folder itself is flushed. A crash leaves either the old state or the new file, never half a file. Leftover temporary files (`*.tmp-*`) older than an hour are removed the next time the folder is opened.
- Writing a partition that already exists is allowed only when the content is identical (nothing is rewritten). Different content is refused: changes get a new file name instead. The one exception is `state/gsc-fresh.ndjson.gz`, which is replaced on every run.
- The gzip header is pinned so the same content gives the same bytes on every operating system.

### `_meta` fields

| Field | Meaning |
|---|---|
| `kind` | `gsc_day`, `gsc_fresh`, `inspect`, `crawl`, `serp`, `google_events` or `findings` |
| `schema` | Always `1` in this version |
| `property` | The Search Console property, for example `sc-domain:example.com` |
| `toolVersion` | The searchtrace version that wrote the file |
| `runId` | The run that wrote it |
| `fetchedAt` | When the data was fetched (UTC) |
| `day` | `gsc_day`: the day the file holds. `findings`: optionally the day the findings report on |
| `revision` | `gsc_day`: 1 for the first seal, 2 or more after a revalidation found different numbers |
| `dataState` | `final` for sealed days, `all` for the provisional tail |
| `slices` | `gsc_day`: per slice, `{ rows, truncated }`. `truncated` is true when Search Console hit the 50,000-row cap for that slice and day |
| `keyframe` | `crawl`: true when every record carries its full page fields |

## Search Console rows

Search Console never reports click rate in our files: we store clicks (`c`), impressions (`i`) and **position times impressions** (`ps`). Average position over any group is `sum(ps) / sum(i)`, which adds up exactly; averaging averages would not.

Each sealed day file holds five slices, told apart by `s`:

| `s` | Search Console request | Fields | Notes |
|---|---|---|---|
| `t` | `[date]`, by property | `c, i, ps` | Site totals |
| `td` | `[date, device]`, by property | `dv, c, i, ps` | `dv` is `desktop` or `mobile`. Tablet is added to mobile |
| `tc` | `[date, country]`, by property | `cc, c, i, ps` | `cc` is the ISO 3166 alpha-3 code in lower case, for example `gbr` |
| `p` | `[page]`, by page, one day | `p, c, i, ps` | Complete page totals, including clicks from queries Google hides |
| `qpd` | `[query, page, device]`, by page, one day | `q, p, dv, c, i, ps` | Named queries only. Google hides rare queries, so these add up to less than `p` |

Rows in a day file carry no date: the date is the file's day. Page URLs are normalised (lower-case host, no fragment, query string and trailing slash kept as Google reports them), so they join cleanly with crawl and inspection data.

A day on which Search Console reported nothing is still sealed: its file has the `_meta` line and no rows. That is how we tell "zero" from "not fetched yet".

**Revisions.** Recent days are checked again once (revalidation). When the stored totals differ from Google's by more than 0.5%, the day is fetched again and written as `<day>.r2.ndjson.gz` (then `r3`, and so on), and a `revision` event goes into `ledger/events/`. Readers always use the highest revision of each day. Older revisions stay in the folder as history.

### The provisional tail

`state/gsc-fresh.ndjson.gz` holds the most recent days that Google has not finalised yet (`dataState: "all"`). It contains `t` and `td` rows only, and because it spans several days **each row carries its own `date`**:

```
{"s":"t","date":"2026-10-04","c":1,"i":50,"ps":400}
{"s":"td","date":"2026-10-04","dv":"desktop","c":1,"i":40,"ps":300}
```

These numbers change from run to run. They are drawn as the dashed end of the timeline and are never used in analysis.

## Other partitions

Each row is one JSON object with the shape named below. The full type definitions are in `src/core/types.ts`.

| Folder | Row type | One row per |
|---|---|---|
| `inspect/` | `InspectionRecord` | URL Inspection call: verdict, coverage state, last crawl time, canonicals, rich results |
| `crawl/` | `SnapshotRecord` | page fetch: outcome, status, redirects, `fieldsHash`, and sometimes `fields` |
| `serp/` | `SerpObservation` | DataForSEO check: whether an AI Overview showed, whether it cited you, the top 10 results |
| `google/` | `GoogleEvent` | Google update or incident that was new or changed in that run |
| `findings/` | `Finding` | finding from the analysis, as reported in that run |

**Crawl keyframes and deltas.** Each snapshot record has a `fieldsHash` (sha256 of the page's extracted fields). The full `fields` object is included only when the hash differs from that URL's previous snapshot, or when the partition is a keyframe (`keyframe: true`, the first crawl of each calendar month). To read the fields of any snapshot, look up its `fieldsHash` among the records that carried `fields`. A 304 Not Modified response keeps the previous hash.

**Google events.** The same event can appear in several partitions as Google edits it. The copy with the latest `modified` time wins.

**Findings history.** Findings partitions are replayed in path order (run ids sort by time). A finding's first and last reported days come from the partitions it appears in: `_meta.day` when set, otherwise the Pacific Time date of `_meta.fetchedAt`.

## Annotations

`annotations.ndjson` is plain (not gzipped) NDJSON, one `Annotation` per line:

```
{"id":"...","at":"2026-10-05T08:00:00Z","date":"2026-09-09","text":"New title template on blog posts","urls":["https://example.com/blog/first-post"],"field":"title"}
```

`date` is the day you say the change happened; `at` is when you recorded it. The text is your own words and is always escaped when shown in a report.

## Ledgers

Ledger files are append-only NDJSON, one file per stream per UTC month (`ledger/<stream>/YYYY-MM.ndjson`). Each append writes one line and flushes it to disk. If a crash cut the last line short, the next append starts on a fresh line, and readers skip any line that does not parse.

| Stream | Records |
|---|---|
| `runs` | `RunRecord`: a `start` and an `end` per run, with phase results and the exit status. A start without an end means a run crashed |
| `spend` | `SpendEvent`: the weekly sampling design, then `intent` (written before every paid request), `posted`, `failed`, `unknown`, `abandoned` and `collected` |
| `inspect` | `{ ptDay, count, runId }`: URL Inspection calls used, for the daily quota |
| `events` | `{ type: 'revalidated' \| 'revision' \| 'truncated' \| 'deferred', day, detail }` |

## The index (`state/index.sqlite`)

The index is a SQLite database built from the files above so analysis can ask quick questions. It is safe to delete.

- Each run hashes every partition (sha256) and loads only files that are new or changed. Files that disappeared have their rows removed.
- For each day only the highest revision is loaded; a new revision replaces that day's rows.
- `state/gsc-fresh.ndjson.gz` is reloaded on every run.
- A schema change in a new version of searchtrace drops the index and rebuilds it from the partitions. A damaged index file is deleted and rebuilt the same way.

What the index returns to analysis:

- Site totals come back as one row per sealed day, with zeros on days Search Console reported nothing, so series have no gaps. Page and query rows come back only where data exists.
- Positions are never averaged in the database; analysis receives `ps` and `i`.
- The list of partitions used for an analysis (which seeds its random draws, so re-runs on the same data give identical results) leaves out the provisional tail and the findings partitions, because both change as a result of running.

## The lock

`state/lock` exists while a run is in progress. It holds `{ pid, host, runId, startedAt }`. A lock is stale, and is taken over, when its process is no longer running on this machine or when it is more than 3 hours old. If a run crashed and you are sure nothing else is running, deleting `state/lock` is safe.
