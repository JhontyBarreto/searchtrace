# Running searchtrace every day with GitHub Actions

searchtrace gets more useful the longer it runs. A scheduled GitHub Action in a **private** repo is the easiest way to keep it going if you're comfortable with git: it's free for this kind of workload, there's no server to look after, and your history lives in git.

You need a robot account (a service-account key, see [SETUP.md](SETUP.md)). A personal gcloud sign-in is not a good fit here: it can expire or demand a fresh sign-in, and putting it in a GitHub secret hands GitHub a credential with broad Google Cloud access. setup refuses to write the workflow for one.

## 1. Create a private repo

Create a new repository on GitHub and make sure it's **private**. Search Console data is private business data: it shows which searches find you and how many people click.

The workflow checks this itself. Its first job asks the GitHub API whether the repo is private and stops with an error if it isn't, before anything else runs. An enterprise "internal" repo counts as private, since only members of your enterprise can see it.

## 2. Write the workflow

Clone the repo, then run setup from the top of the clone:

```bash
searchtrace setup --github --property sc-domain:example.com --credentials ~/.config/searchtrace/google-key.json
```

(or choose option 1 under "Keep it running?" in the wizard). This writes `searchtrace-data/` with its `config.json`, and `.github/workflows/searchtrace.yml` at the top of the clone. GitHub only reads workflows at the repo root, so setup stops, without writing anything, if the data folder isn't directly inside a git clone.

The workflow is pinned to searchtrace itself, not to a name on a package registry: it checks out `JhontyBarreto/searchtrace` at the exact commit you ran setup from (or the release tag `v0.1.0` when that commit isn't known) and builds it from its lockfile, so every dependency is pinned by its integrity hash too. An update never reaches your data unless you choose it. To upgrade later, install the new release and run `setup --github` again: it only overwrites a workflow that searchtrace wrote, and it refreshes the action pins as well.

## 3. Add the secrets

In the repo, open Settings, Secrets and variables, Actions, and add:

| Secret | What to paste | Needed |
|---|---|---|
| `SEARCHTRACE_GOOGLE_KEY` | the whole service-account key JSON. setup tells you where it is, for example `~/.config/searchtrace/google-key.json` (on a Mac: `pbcopy < ~/.config/searchtrace/google-key.json`) | yes |
| `DATAFORSEO_LOGIN` | your DataForSEO API login | only for AI Overview checks |
| `DATAFORSEO_PASSWORD` | your DataForSEO API password | only for AI Overview checks |

## 4. Commit and run

```bash
git add searchtrace-data/config.json searchtrace-data/meta.json searchtrace-data/.gitignore searchtrace-data/.gitattributes .github/workflows/searchtrace.yml
git commit -m "Add searchtrace"
git push
```

`config.json` holds no secrets. If it names a key file (`auth.credentialsFile`), that is a home-relative path from your laptop, like `~/.config/searchtrace/google-key.json`; on the runner it doesn't exist and the `SEARCHTRACE_GOOGLE_KEY` secret is used instead.

If you already ran searchtrace on your laptop with AI Overview checks on, commit `searchtrace-data/ledger/` too: it holds the spend records that stop a check being paid for twice. (searchtrace also adopts checks it finds at DataForSEO that its records don't know, so this is a second line of defence.)

Then open the Actions tab, pick "searchtrace" and click "Run workflow". The first run fetches up to 16 months of history and takes about 10 minutes for a small site; a big site takes longer. The job stops after 30 minutes, and a stopped run carries on from the days it already saved on the next run. After that it runs daily at 06:17 UTC, a time picked to stay away from the busy top of the hour, and a daily run takes seconds to a few minutes.

## What the workflow does

It has three jobs, so the code that sees your secrets never holds a token that can push:

1. **guard** asks the GitHub API whether the repo is private and stops everything if it isn't.
2. **collect** (read-only token) checks out your data at the tip of the branch, checks out searchtrace at its pinned commit, builds it from its lockfile with install scripts off, and runs `searchtrace run --ci`. That writes the Markdown report to the run's summary page and turns problems into GitHub annotations. The search index from the last run is restored from the Actions cache, so it isn't rebuilt from scratch each day. Then it packs the files the run changed and hands them on, and uploads `reports/latest.html` as an artifact, kept for 30 days.
3. **save** (the only job that can push) runs no downloaded code. It unpacks those files on top of the commit the run started from, commits only these paths inside `searchtrace-data/`: `config.json`, `meta.json`, `.gitignore`, `.gitattributes`, `gsc`, `google`, `crawl`, `inspect`, `serp`, `findings`, `ledger`, `annotations.ndjson`, `reports`, `graphify-out/graph.json` and `graphify-out/searchtrace.meta.json`. It never runs `git add -A`, so nothing else in the repo is swept in. The `state/` folder (the rebuildable index, lock and caches) is ignored. Then it rebases that commit onto the branch tip and pushes, so anything pushed while the run was going (a note, say) is merged rather than overwritten. Commits are made as GitHub's own Actions bot.

A run that stops part way (exit 3 or 4) still saves what it collected. Runs never overlap (a concurrency group queues the next one), and a queued run or a "Re-run jobs" always starts from the latest saved data, not from the commit it was queued on. If the push still can't land (someone pushed a conflicting change), the save job aborts the rebase cleanly and pushes the run's data, spend records included, to a branch named `searchtrace-unsaved-<run id>-<attempt>`, with an error pointing at it. Merge that branch, then delete it. Nothing from the triggering event is ever pasted into a shell command.

## Reading the results

- **The step summary.** Each run's summary page shows the Markdown report: the answer, where the clicks went, the update scorecard and the rest.
- **The artifact.** Download `searchtrace-report` for the full HTML report with charts.
- **The repo.** `searchtrace-data/reports/latest.md` renders on GitHub, and the commit history doubles as a log of what changed. `findings.json` changes on every run that brings a new day, because the date windows roll forward.
- **Email.** GitHub emails you when a run fails. searchtrace exits 0 when all is well (a reached budget cap or a Search Console quota stop is only a warning), 3 for credential or permission problems, 2 for config problems and 4 when a step failed but the report was still written.

## Hardening

- **Every action is pinned to a full commit SHA**, with its version in a comment, in the template setup writes. Re-running a newer searchtrace's `setup --github` refreshes the pins.
- **searchtrace itself is pinned to a commit** and built from its lockfile, never fetched from a package registry by name. To pin harder, put a commit you have reviewed in the `ref:` of the "Check out searchtrace" step.
- **Secrets and the push token are split.** The collect job has your Google key and DataForSEO login but only read access to the repo, and checks out without saving any credentials. The save job can push but never sees a secret and runs no downloaded code. The tool and its dependencies do see your Google key and DataForSEO login, as they must to do their job; that is why both are pinned.
- **Repo size.** Committed history grows by about 125 KB a day for a small site once git packs it (roughly 45 MB a year). Most of that is the daily findings snapshot, report and graph; the raw Search Console data is about 10 KB a day. Bigger sites grow faster. The workflow checks out with GitHub's default shallow clone, so old history never slows a run down.

## Recording changes from the Action's repo

You can run `searchtrace note ...` in your clone, commit `searchtrace-data/annotations.ndjson` and push. The next scheduled run picks it up. The data folder's `.gitattributes` marks the ledgers and `annotations.ndjson` as append-only (`merge=union`), so a note you push while a run is saving merges cleanly.
