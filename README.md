<h1 align="center">searchtrace</h1>
<p align="center"><b>Why did my Google traffic change?</b><br>
A straight answer from your own Search Console data, with the evidence.<br>
And an honest "we can't tell yet" when that's the truth.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/searchtrace"><img alt="npm" src="https://img.shields.io/npm/v/searchtrace"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.13-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="servers" src="https://img.shields.io/badge/servers-none-black">
</p>

Your clicks dropped. Search Console shows you the line going down, but not why. Was it a Google update, something you changed, fewer people searching, or an AI Overview sitting above you? Or is it just a small site wobbling the way small sites do?

searchtrace is a command-line tool that works through those questions using your own data. It lines every change up against Google's confirmed updates and against changes on your site, splits the lost clicks into parts that add up exactly, and labels each finding with how sure it can honestly be. When the data can't support an answer, it says so, and tells you what it would take.

```bash
npx searchtrace demo
```

A full report on a made-up site, built offline in about 30 seconds. No login, nothing to install.

## What it tells you

- **Was it you or Google?** Each drop is checked against Google's confirmed updates and against changes on your site, dated from when Googlebot actually recrawled the page (from URL Inspection's `lastCrawlTime`). Pages you didn't change are the control group.
- **Where did the clicks go?** Every change splits into parts that add up exactly: fewer searches, a ranking move, and fewer clicks at the same position. Searches Google hides for privacy are counted too, as their own line.
- **Is it AI Overviews?** Optionally, it checks whether an AI Overview now sits above you and which sites it cites. Paid per check, capped, usually cents a month.
- **Is it even real?** Every finding says **Real change**, **Normal wobble**, **Not enough data yet** or **Can't separate the causes**, and how big a change would have to be before it could tell.
- **It remembers.** Run it daily and it keeps your history past Search Console's 16-month limit, as a knowledge graph you can question in Claude or Cursor.

Here is the kind of thing it writes (example output; the numbers are made up):

```text
The answer
  In the last 28 days Google sent you 80 clicks, 9 fewer than the 28 days before (-10%).
  Not enough data to tell yet. With about 20 clicks a week, only a change of roughly 45% or more
  stands out from normal ups and downs over 4 weeks, and this one was -10%. Impressions, which have
  far more data, didn't change meaningfully (+3%).

Also worth knowing
  · Real change: impressions on /blog/* dropped by 18% around 12 Sep 2026 (Estimated)
  · Google hides the exact searches behind 81% of your clicks. Page-level numbers include everything.
```

That second sentence is the point. A site with a few hundred clicks a month can't prove a 10% drop, and a tool that pretends otherwise sends you chasing noise.

## Use it on your site (about 6 minutes)

You need Node 22.13 or newer and access to a Search Console property. Adding the robot account as a user needs an owner of the property.

```bash
npx searchtrace setup
```

The wizard walks you through giving searchtrace read access, then writes everything to one folder, `searchtrace-data/`. There are two ways in:

- **A robot account (recommended).** You create a free Google Cloud service account, download its key, and add its email as a user on your property. It keeps working on a schedule. The wizard prints each link and waits for you; it never opens anything itself.
- **gcloud on this computer.** If you already use `gcloud auth application-default login`, searchtrace can use that credential.

Then:

```bash
npx searchtrace run       # collect, analyse, write the report and the graph
npx searchtrace why       # the evidence behind the headline
npx searchtrace why /pricing            # one page
npx searchtrace why "emergency plumber" # one search
npx searchtrace why 2026-09-14          # what happened that day
npx searchtrace doctor    # check the setup, with a one-line fix for anything wrong
```

The first run pulls the full 16 months Search Console keeps, which takes a few minutes for a small site. After that, a daily run only fetches what's new.

Setting it up from a script instead? `npx searchtrace setup --yes --property sc-domain:example.com --credentials ~/keys/searchtrace.json`. On an existing setup, `--yes` merges your flags into the config rather than replacing it. Full details are in [docs/SETUP.md](docs/SETUP.md).

### Record changes you made before you installed it

searchtrace snapshots your pages on every run, so from now on it can date your changes itself. For anything earlier, tell it:

```bash
npx searchtrace note "New title template on blog posts" --date 2026-09-09 --urls "/blog/*"
```

The next run tests that change against the pages you didn't touch.

## How it decides, and how we know it's honest

- **An exact click waterfall.** Each page and search is split into demand, ranking and click-rate parts with a symmetric formula (the Shapley split), so the parts always add up to the real change and don't depend on the order you look at them.
- **Control groups.** A change on your site is compared with similar pages you didn't change, over the same days. If those fell just as much, your change is ruled out.
- **Dated by Googlebot, not by you.** A change only counts from when Google recrawled the page, using URL Inspection's `lastCrawlTime`.
- **False-discovery control.** Many series are scanned for change points at once, so searchtrace controls the false-discovery rate (Benjamini-Hochberg) instead of reporting every lucky blip.
- **Four labels, two axes.** "Is it real?" (Real change, Normal wobble, Not enough data yet, Can't separate the causes) is kept apart from "Why?" (the cause, badged Measured, Estimated or Possible).
- **Tested against made-up data with known answers.** The test suite plants effects in synthetic sites and checks they're recovered, and checks that pure noise rarely raises an alarm: across hundreds of null series, CUSUM p-values must stay roughly uniform and the share of runs with any false discovery must stay at or under 13%. The demo site is built the same way.

Every formula, threshold and known limit is written up in [docs/METHODOLOGY.md](docs/METHODOLOGY.md). The report keeps the statistics out of the main sentences and puts them behind "Show the maths" on each finding.

## What you get

All of it lands in `searchtrace-data/`:

- `reports/latest.html`: a single self-contained page. No scripts, no network requests, works offline, prints cleanly.
- `reports/latest.md`: the same report in Markdown (also used as the GitHub Actions step summary).
- `reports/findings.json`: every finding with its numbers, byte-identical when the data hasn't changed.
- `graphify-out/graph.json`: the knowledge graph (see below).
- The raw history: sealed Search Console days, page snapshots, index checks and Google's update list, as small gzipped files you can commit.

## Run it every day

searchtrace gets more useful each day it runs: page snapshots let it date your changes, URL Inspection records when Google saw them, and your history stops falling off Search Console's 16-month edge.

- **GitHub Actions in a private repo (free).** `npx searchtrace setup --github` writes `.github/workflows/searchtrace.yml`, pinned to the exact searchtrace version. It refuses to run in a public repo, commits only the files it lists, and never runs two at once. See [docs/GITHUB-ACTION.md](docs/GITHUB-ACTION.md).
- **Your own machine.** The wizard can print a cron line instead.

Exit codes are 0 ok, 1 internal error, 2 config, 3 auth or permission, 4 partial (a step failed but the report was still written), so a scheduler can tell them apart.

## Ask your search history questions in Claude or Cursor

Each run writes a graph in the format [graphify](https://pypi.org/project/graphifyy/) reads (install it with `uv tool install graphifyy` or `pipx install graphifyy`), covering your pages, searches, sections, Google updates, your changes and every finding, with dates on all of it. Point Claude Code, Claude Desktop or Cursor at it and ask things like:

- "Why did /pricing lose clicks in September?"
- "Which pages did the December core update hit, and did we change any of them first?"
- "What happened the last few times we changed title tags?"

```bash
cd searchtrace-data
graphify cluster-only . --no-viz --no-label
graphify query "which pages lost clicks after the September update" --budget 1500
```

`npx searchtrace doctor` prints the exact command to connect it to Claude. Setup for each app is in [docs/GRAPHIFY.md](docs/GRAPHIFY.md).

## Costs

Free by default. Search Console, URL Inspection, Google's update feed and fetching your own pages cost nothing.

AI Overview checks are optional and go through [DataForSEO](https://dataforseo.com/), which you pay directly. Each check costs at most $0.0012. searchtrace has a monthly cap (default $1.00) and a per-run cap (default $0.30), reconciles every charge against DataForSEO's free task list, and never retries a paid request it isn't sure about. A small site typically spends cents a month. See [docs/COSTS.md](docs/COSTS.md).

## Privacy and security

- Your data stays in your folder. There is no searchtrace server, no account and no telemetry.
- It talks only to Google's APIs, your own website (politely, honouring robots.txt), and DataForSEO if you turn AI Overview checks on. Those checks send DataForSEO the searches being checked.
- Keys never go in the data folder or the config. The wizard keeps its copy in `~/.config/searchtrace/` readable only by you, keys are scrubbed from logs, and every file write is checked for secrets.
- Reports escape every query, URL and title, carry a strict Content-Security-Policy and contain no scripts.
- The Action refuses to run in a public repo, because Search Console data is private business data.

More in [docs/PRIVACY.md](docs/PRIVACY.md).

## FAQ

**Is this a rank tracker?** No. It reads what Google already reports about your site and explains changes in it. The optional AI Overview checks look at a small, budget-capped sample of your own searches.

**Why does it keep saying "not enough data"?** Because on most small sites that's true. A site with 20 clicks a week needs a change of roughly 45% or more before it stands out from ordinary ups and downs over four weeks. searchtrace tells you that number, and when the data would be enough, rather than guessing. Impressions carry far more data, so it often can say something about those.

**Does it work with WordPress (or Shopify, Webflow, anything else)?** Yes. It doesn't need a plugin: it reads Search Console and fetches your public pages, so the CMS doesn't matter.

**What about big sites?** Search Console exports up to 50,000 rows per day and slice; past that, searchtrace marks the day as truncated rather than pretending it's complete. History grows by a few kilobytes a day for a small site and roughly 240 MB a year at around 35,000 rows a day, which a git repo handles for a couple of years.

**How is it different from GSC Insights, SEO Gets, GSC Wizard, AIOSEO or SEOTesting?** Those tools are good at making Search Console easier to browse, and some run deliberate SEO tests. searchtrace is narrower: it tries to say *why* a change happened, with control groups and recrawl dates, and it will tell you plainly when it can't. It's open source, runs on your machine or in your own private repo, and keeps the data with you. Plenty of people will want both.

## Roadmap

Not in v0.1, planned next:

- **v0.2:** importing a Search Console export, a GitHub issue for each new real change, `setup --github` creating the repo for you, a config printer for Claude Desktop and Cursor, a within-search AI Overview estimator once there are 8+ weeks of checks, seasonal bars, S3/R2 storage, and a verified OAuth client for a one-minute setup.
- **v0.3:** backfilling past page versions from the Wayback Machine, a WordPress revisions connector, mapping git commits to URLs, Bing and Search Console AI reports as evidence, GA4 annotations, and keyless GitHub Actions.
- **Later:** grouping index problems by template, cannibalisation over time, content decay, a Google Trends demand index, and multi-site setups for agencies.

## Contributing

```bash
npm ci
npm run lint && npm run typecheck && npm test
```

Tests run on synthetic data only. Please never add real client data, Search Console exports or credentials to the repo, in tests or anywhere else. The lint script also enforces a few house rules: no `child_process`, no `eval`, network access only through one module, injected clocks and random seeds in the analysis code, and no em or en dashes in any text.

## Licence

MIT. See [LICENSE](LICENSE).
