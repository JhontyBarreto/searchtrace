# Running searchtrace every day with GitHub Actions

searchtrace gets more useful the longer it runs. A scheduled GitHub Action in a **private** repo is the easiest way to keep it going: it's free for this kind of workload, there's no server to look after, and your history lives in git.

## 1. Create a private repo

Create a new repository on GitHub and make sure it's **private**. Search Console data is private business data: it shows which searches find you and how many people click.

The workflow checks this itself. Its first step asks the GitHub API whether the repo is private and stops with an error if it isn't, before anything else runs.

## 2. Write the workflow

In a clone of that repo:

```bash
npx searchtrace setup --github --property sc-domain:example.com
```

(or choose option 1 under "Keep it running?" in the wizard). This writes `searchtrace-data/config.json` and `.github/workflows/searchtrace.yml` next to the data folder.

The workflow is pinned to the exact searchtrace version you ran, for example `npx -y searchtrace@0.1.0`, so an update never reaches your data without you choosing it. To upgrade later, run the new version's `setup --github` again: it only overwrites a workflow that searchtrace wrote.

## 3. Add the secrets

In the repo, open Settings, Secrets and variables, Actions, and add:

| Secret | What to paste | Needed |
|---|---|---|
| `SEARCHTRACE_GOOGLE_KEY` | the whole service-account key JSON (see [SETUP.md](SETUP.md)) | yes |
| `DATAFORSEO_LOGIN` | your DataForSEO API login | only for AI Overview checks |
| `DATAFORSEO_PASSWORD` | your DataForSEO API password | only for AI Overview checks |

A personal gcloud credential is not a good fit here: it can expire or demand a fresh sign-in. Use a robot account.

## 4. Commit and run

```bash
git add searchtrace-data/config.json .github/workflows/searchtrace.yml
git commit -m "Add searchtrace"
git push
```

Then open the Actions tab, pick "searchtrace" and click "Run workflow". The first run fetches up to 16 months of history and takes a few minutes. After that it runs daily at 06:17 UTC, a time picked to stay away from the busy top of the hour.

## What the workflow does

1. Refuses to run if the repo is public.
2. Checks out the repo and sets up Node 22.
3. Runs `searchtrace run --ci`, which writes the Markdown report to the run's summary page and turns problems into GitHub annotations.
4. Commits only these paths inside `searchtrace-data/`: `config.json`, `meta.json`, `.gitignore`, `gsc`, `google`, `crawl`, `inspect`, `serp`, `findings`, `ledger`, `annotations.ndjson`, `reports`, `graphify-out/graph.json` and `graphify-out/searchtrace.meta.json`. It never runs `git add -A`, so nothing else in the repo is swept in. The `state/` folder (the rebuildable index, lock and caches) is ignored.
5. Uploads `reports/latest.html` as an artifact, kept for 30 days.

Runs never overlap (a concurrency group queues the next one), and the job stops after 30 minutes. Nothing from the triggering event is ever pasted into a shell command.

## Reading the results

- **The step summary.** Each run's summary page shows the Markdown report: the answer, where the clicks went, the update scorecard and the rest.
- **The artifact.** Download `searchtrace-report` for the full HTML report with charts.
- **The repo.** `searchtrace-data/reports/latest.md` renders on GitHub, and `findings.json` only changes when the findings do, so the commit history doubles as a log of what changed.
- **Email.** GitHub emails you when a run fails. searchtrace exits 0 when all is well (a reached budget cap or a Search Console quota stop is only a warning), 3 for credential or permission problems, 2 for config problems and 4 when a step failed but the report was still written.

## Hardening

- **Pin the actions to commit SHAs.** The template uses `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4`. For extra safety, replace each tag with the full commit SHA of that release.
- **Keep the token narrow.** The workflow asks only for `contents: write`, which it needs to commit your history.
- **Repo size.** A small site adds a few kilobytes a day. The workflow checks out with GitHub's default shallow clone, so old history never slows a run down.

## Recording changes from the Action's repo

You can run `npx searchtrace note ...` in your clone, commit `searchtrace-data/annotations.ndjson` and push. The next scheduled run picks it up.
