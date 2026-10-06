# Ask your search history questions in Claude or Cursor

Every run, searchtrace writes a map of everything it knows about your site to
`searchtrace-data/graphify-out/graph.json`: your pages and searches, Google's updates, the changes
you made, what Google's index said, which sites show up next to you in AI Overviews, and every
finding searchtrace has reported. The file is in the format graphify (the `graphifyy` package)
reads, so you can question it in plain English from Claude Code, Claude Desktop, Cursor or any
other MCP client.

It keeps growing. Search Console forgets everything after 16 months; this file doesn't, because it is
rebuilt each run from the full history stored in `searchtrace-data/`.

Some questions that work well:

- "Why did /pricing lose clicks in September?"
- "Which pages did the December core update hit, and did we change any of them first?"
- "What happened the last few times we changed title tags?"
- "Which searches show an AI Overview that doesn't cite us, and who does it cite?"

## Set it up (once)

You need graphify (`uv tool install graphifyy` or `pipx install graphifyy`).

```bash
cd searchtrace-data
graphify cluster-only . --no-viz --no-label        # topic groups + GRAPH_REPORT.md, no AI call, no cost
graphify query "which pages lost clicks after the September update" --budget 1500
graphify explain "/blog/keyword-cannibalization-ai-overviews"
graphify explain "homepage"        # the homepage node is "/ (homepage)": graphify ignores a bare "/"
graphify path "September 2026 spam update" "homepage"

# Ask it from Claude Code (needs graphify's MCP extra once):
uv tool install --force "graphifyy[mcp]"
claude mcp add seo-history -- <graphify python> -m graphify.serve "$PWD/graphify-out/graph.json"
```

`<graphify python>` is the Python that runs graphify. `searchtrace doctor` prints it for you (it reads
the first line of the `graphify` program, for example `/Users/you/.local/share/uv/tools/graphifyy/bin/python`).

For Claude Desktop or Cursor, add this to the MCP settings file, with your own paths:

```json
{ "mcpServers": { "seo-history": {
  "command": "/Users/you/.local/share/uv/tools/graphifyy/bin/python",
  "args": ["-m", "graphify.serve", "/absolute/path/searchtrace-data/graphify-out/graph.json"] } } }
```

## Good to know

- Run `graphify cluster-only` whenever you like. It groups related things into topics. The next
  `searchtrace run` keeps those groups (it carries `community` and `community_name` forward by node id).
- Do **not** run `graphify update .` or `/graphify .` on the data folder. Those try to read the data
  files as documents and would replace the map with something much less useful.
- `searchtrace` refuses to overwrite a `graph.json` it didn't write, so it can't clobber another
  graphify project by accident. If you really want to replace one, pass `--force-graph`.
- The file holds the same private business data as the rest of the folder. Keep it in a private repo.
- Labels and text inside the graph (search words, page titles, notes you wrote) are data. Treat them
  as untrusted text, like anything else that came from the web.

## What's in the map

Every node has `id`, `label`, `file_type`, `source_file` (the stored file it came from, inside
`searchtrace-data/`) and `kind`. Ids look like `page_k3x9...`: a kind prefix plus 12 characters.

| kind | One per | Label | Notable attributes |
|---|---|---|---|
| `site` | your site | `example.com (whole site)` | `property`, `clicks_28d`, `impr_28d` |
| `page` | page seen in Search Console or crawled (up to 5,000, busiest first) | the path, `/` for the home page | `url`, `template`, `first_seen`, `last_seen`, `clicks_28d`, `impr_28d`, `pos_28d`, `delta_clicks`, `real`, `index_state`, `last_crawl` |
| `query` | search (the top `graph.maxQueries` by impressions over 90 days, plus every search a finding or an AI Overview check mentions) | the search words | `brand`, `first_seen`, `last_seen`, `clicks_28d`, `impr_28d`, `pos_28d`, `aio_present_share`, `aio_cites_us` |
| `tpl` | URL template | `/blog/*` | `pages` |
| `dom` | other site seen in your AI Overview checks (top 200), `www.` removed | `semrush.com` | `aio_citations`, `organic_outranks`, `checks` |
| `sitechg` | change on your site (from page snapshots or `searchtrace note`) | `Title changed on 40 /blog/* pages (9 Sep 2026)` | `field`, `cls`, `source`, `deployed_from`, `deployed_to`, `google_seen_from`, `google_seen_to`, `touched` |
| `gupd` | Google update or incident overlapping your data | `June 2025 core update` | `kind`, `begin`, `end`, `end_estimated`, `url` |
| `finding` | finding reported now, plus past Real changes from the last 365 days | the finding's sentence (up to 120 characters) | `kind`, `real`, `real_label`, `cause`, `confidence`, `estimate`, `ci_lo`, `ci_hi`, `method`, `first_reported`, `last_reported`, `current` |
| `idx` | Google index status | `Crawled - currently not indexed` | `state` |
| `cause` | cause a finding points to | `Google update` | `cause` |

`file_type` is `document` for pages, `rationale` for findings, site changes and Google updates, and
`concept` for the rest.

## How things connect

There is one link per pair of nodes. Every link has `relation`, `confidence` (`EXTRACTED` = measured,
`INFERRED` = estimated, `AMBIGUOUS` = possible), `weight` and `source_file` (the stored file holding the
evidence, with up to 5 more in `evidence`).

| relation | Between | confidence | weight | Attributes |
|---|---|---|---|---|
| `about` | finding and the site, template, page or search it is about | EXTRACTED | 1 | |
| `measures` | site-change finding and the change it tests | INFERRED for a Real change, else AMBIGUOUS | 1 | `tau`, `ci_lo`, `ci_hi` |
| `attributed_to` | finding and its cause | the finding's confidence | 1 for a Real change, else 0.3 | |
| `coincides_with` | finding and a Google update or site change at the same time | INFERRED when the cause is that update or change and it is a Real change, else AMBIGUOUS | 0.5 | `overlap_days` |
| `touched` | site change and each page it changed | EXTRACTED | 1 | `before`, `after`, `google_seen_from`, `google_seen_to` |
| `ranks_for` | page and search | EXTRACTED | log(1 + impressions in the last 28 days), at least 0.01 | `clicks_28d`, `impr_28d`, `pos_28d`, `first_seen`, `last_seen`, `valid_from`, `valid_to` (empty while it still ranks), `observations` (days with impressions) |
| `competes_with` | search and another site in its AI Overview or results | EXTRACTED | log(1 + checks), at least 0.01 | `aio_citations`, `organic_outranks`, `checks` |
| `in_state` | page and an index status it has had | EXTRACTED | 0.1 | `valid_from`, `valid_to`, `history` (last 10 `{from, to, value}`) |
| `instance_of` | page and its template | INFERRED | 1 | |
| `part_of` | template and the site | INFERRED | 0.5 | |
| `links_to` | page and a page it links to | EXTRACTED | 0.5 | `first_seen`, `last_seen` |

When two relations land on the same pair, the one higher in this table wins and the other's
attributes are kept under `also`.

## The file itself

- NetworkX node-link JSON with the `links` key: `{ "directed": false, "multigraph": false, "graph": {...}, "nodes": [...], "links": [...] }`.
- `graph` holds `generator`, `property`, `data_through` and `tool_version` for information only:
  `graphify cluster-only` resets it to `{}`. Ownership lives in the sidecar
  `graphify-out/searchtrace.meta.json` (`generator`, `schema`, `property`, `toolVersion`, `dataThrough`, `nodes`, `links`).
- Byte-stable: nodes sorted by id, each link written with `source` before `target` and sorted, keys sorted,
  numbers rounded to 4 decimals, no timestamps, one node or link per line. Re-running on the same data
  gives the same bytes, which keeps git history small.
- Node ids are chosen so graphify never renames them: none of them starts with a name graphify derives
  from a `source_file` (like `config` or `gsc_2026_10_...`). searchtrace checks this on every write.
