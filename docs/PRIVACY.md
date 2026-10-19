# Privacy and security

searchtrace runs on your computer or in your own private GitHub repo. There's no searchtrace server, no account, no analytics and no telemetry. This page lists exactly what is stored, what is sent where, and how keys are handled.

## What is stored, and where

Everything lives in one folder, `searchtrace-data/` by default:

| Path | What it holds |
|---|---|
| `config.json` | your settings: the property name, budgets, the *path* to your key file. Never the key itself; searchtrace refuses to save a config that looks like it contains one |
| `meta.json` | when the folder was created and by which version |
| `gsc/` | one compressed file per finished day of Search Console data: totals, devices, countries, pages, and the searches Google names |
| `google/` | Google's public list of search updates and incidents |
| `crawl/` | snapshots of your own public pages: title, description, headings, canonical, links, word count and a fingerprint of the text (not the full HTML) |
| `inspect/` | URL Inspection results: index status and when Google last crawled each page |
| `serp/` | AI Overview checks, if you turned them on: which result types showed and which sites were cited |
| `findings/` | the findings, saved only when they change |
| `annotations.ndjson` | the notes you add with `searchtrace note` |
| `ledger/` | a log of runs, spending and inspection quota use |
| `reports/` | the HTML and Markdown reports and `findings.json` |
| `graphify-out/` | the knowledge graph |
| `state/` | a rebuildable index, a lock file and caches. Safe to delete; never committed |

## What is sent where

| To | What | When |
|---|---|---|
| `oauth2.googleapis.com` | your credential, to get a short-lived access token | each run |
| Search Console API | your property name and date ranges; it answers with your performance data | each run |
| URL Inspection API | page URLs on your property | each run, within the daily budget |
| `status.search.google.com` | nothing about you: it's a public file of Google's update history | each run |
| your own website | ordinary page requests, identified as `searchtrace/0.1`, honouring robots.txt | at most once every 20 hours |
| DataForSEO | the searches being checked, with country, language and device | only if you turn AI Overview checks on |

Nothing is sent to the people who make searchtrace.

## Keys and passwords

- **Never in the data folder.** setup refuses a key that sits inside the data folder, and `doctor` warns if your key is inside any git repository.
- **The wizard's copy** goes to `~/.config/searchtrace/google-key.json`, in a folder only you can open (mode 0700) and a file only you can read (mode 0600). With `--credentials`, searchtrace reads your file where it is and never copies it.
- **Read-only scope.** A robot account only ever asks Google for read-only Search Console access, even though you give it Full permission in Search Console (needed for URL Inspection).
- **Scrubbed from output.** Private keys, client secrets, refresh tokens, access tokens and DataForSEO passwords are registered as secrets the moment they're read. They are removed from every log line, and in GitHub Actions they're masked in the job log too.
- **Checked before every write.** Every line written to the data folder is checked for registered secrets and private keys. If one ever slipped through, searchtrace would stop rather than save it.
- **DataForSEO credentials** stay in environment variables (`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`) or GitHub secrets, never in files.

## Why the repo must be private

Your Search Console data shows which searches bring people to your site, how many click, which pages matter most and how that has changed. That's commercially sensitive. The GitHub Action's first step checks that the repo is private and refuses to run otherwise.

## Safe reports

- One escaping function is used for every query, URL, page title, note and domain in the HTML report, and the Markdown report escapes everything that could become a link, HTML, a table cell or a mention.
- The HTML report has no scripts and carries a Content-Security-Policy that blocks scripts, external styles, fonts, frames and network requests. It works offline.
- The only links are "Check it yourself" links to Search Console and links to this project's docs, and they open in a new tab with `rel="noopener noreferrer"`.
- Text shown in the terminal by `searchtrace why` has control characters removed, so a crafted search query can't move your cursor or change your terminal's title.

## Crawling your site

The crawler only fetches pages on your own property, and only on your site's own port (the default one, unless `siteOrigin` names another). Every redirect hop is re-checked. Private and reserved IP addresses (written as numbers, in any form) and internal names such as `localhost`, `.local` and `.internal` are refused. Each host name is also looked up before every request, and refused if it points at a private address, so a name on your own domain that resolves to 127.0.0.1 or 10.x is not fetched. If your site really does resolve to a private address from where you run searchtrace (split DNS at the office, or a hosts-file entry pointing at a local server), set `crawl.allowPrivateAddresses` to `true` in `config.json`.

One gap remains, as with any lookup-then-fetch check: someone who controls your domain's DNS could answer the lookup with a public address and the fetch a moment later with a private one (DNS rebinding). The fetch sends no cookies or credentials, non-HTML answers are thrown away, and the only thing saved is the page's title, headings, description and links, in your own data folder.

Page bodies are capped in size, sitemaps are read without expanding external entities, and only HTML is parsed. The crawler's user agent is `searchtrace/0.1 (+https://github.com/JhontyBarreto/searchtrace)`, and it honours robots.txt rules for `searchtrace`.

## Test data

The searchtrace repo contains only synthetic data. Real client data and credentials never go into it.
