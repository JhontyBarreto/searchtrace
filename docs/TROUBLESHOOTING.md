# Troubleshooting

Start with:

```bash
npx searchtrace doctor
```

It prints one line per check: `✓` fine, `!` a warning, `✗` a failure (followed by its fix), `i` information. This page explains each message.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok (a reached spending cap or a Search Console quota stop is only a warning) | nothing |
| 1 | internal error, or another run holds the lock | read the message; see "Another searchtrace run is in progress" below |
| 2 | configuration problem | fix the setting the message names, or run setup again |
| 3 | credential or permission problem | see the credential and permission sections below |
| 4 | partial: a step failed, but the report was still written from the data collected so far | the message names the step; the next run usually catches up |

## Node and config

**"searchtrace needs Node 22.13 or newer (you have X). Get it from nodejs.org."**
searchtrace uses features that arrived in Node 22.13 (the built-in SQLite module among them). Install a current LTS from nodejs.org, or use a version manager.

**"No config.json in ..." / "Run `npx searchtrace setup`, or pass --credentials <file>."**
There's no setup in this folder yet, or `--dir` points at the wrong place. Run `npx searchtrace setup`, or pass `--dir` with your data folder.

**"config.json has problems: ..."**
A value is out of range or misspelled. The message names the field. Fix it by hand or run setup again, which keeps your other settings.

**"This folder holds data for X, but config.json says Y."**
Each data folder holds one property. Put the original property back, or use a separate `--dir` for the new one.

## Credentials

**"Run `npx searchtrace setup`, or pass --credentials <file>."**
searchtrace couldn't find any credential. See [SETUP.md](SETUP.md) for the places it looks.

**"Google wants you to sign in again."**
Your Google account needs a fresh sign-in (Google calls this `invalid_rapt`). Run:

```bash
gcloud auth application-default login --client-id-file=<your OAuth client json> \
    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
```

or point searchtrace at a service-account key with `--credentials`. Robot accounts aren't affected.

**"! This credential can change Search Console settings (webmasters scope). searchtrace only needs read access."**
Your sign-in granted the full Search Console scope. searchtrace only reads, so this is safe, but a read-only credential is tidier. A robot account always uses the read-only scope.

**An activation URL ("API has not been used in project ... or it is disabled").**
The Search Console API is switched off in the Cloud project your credential belongs to. Open the URL doctor prints, click Enable, wait a minute and try again.

**"Move it to ~/.config/searchtrace/ and update auth.credentialsFile."**
Your key file is inside the data folder or inside a git repository, where it could be committed by accident. Move it, then update `auth.credentialsFile` in `config.json` (or run setup again with `--credentials`).

## Search Console access

**"Add <robot email> as a user on <property> in Search Console > Settings > Users and permissions."**
The credential works but can't see your property. Add the email shown as a user with Full permission. Only an owner can add users. It can take a minute to apply.

**"You typed seoengico.com; your property is sc-domain:seoengico.com."** (with your own site)
Search Console treats a Domain property (`sc-domain:example.com`) and a URL-prefix property (`https://www.example.com/`) as different things. Use the exact name the message gives.

**"Change the permission to Full."**
The robot has Restricted permission, and URL Inspection refused it. Edit the user in Search Console and choose Full. It still can't change anything: searchtrace only requests read access.

**"Search Console: stopped early (quota). Finished days are saved; the rest will be fetched next run."**
Google's per-site rate limit was hit. Finished days are kept and the rest are fetched next time. The run still exits 0.

**"today's checks for this property are used up"**
URL Inspection allows 2,000 checks a day per property, shared with every tool you use. searchtrace uses at most 200 a day by default and stops for the day when Google says no. Lower `inspection.dailyBudget` if other tools need more.

## Runs

**"Another searchtrace run is in progress (pid N). Wait for it, or delete state/lock if it crashed."**
Two runs can't write to the same folder at once. If no run is going, the lock is left over from a crash: delete `searchtrace-data/state/lock`. Locks older than three hours, or from a process that no longer exists, are cleared automatically.

**"The last run (<runId>) didn't finish. It's safe to run again."**
A run was interrupted (closed laptop, cancelled job). Every file is written atomically, so nothing half-written is left behind. Just run again.

**"Some steps didn't finish. The report uses everything collected so far."** (exit 4)
One step failed and the rest carried on. The line starting with `!` above it says which step and why.

**"graphify-out/graph.json here wasn't written by searchtrace (it looks like another graph). Use a different --dir, or pass --force-graph to replace it."**
searchtrace won't overwrite a graph it didn't write. If you're sure, pass `--force-graph` once.

**"No finished Search Console days yet."**
Search Console finalises data two to three days late. A brand-new property, or a first run that couldn't reach Google, has nothing to analyse yet. Run again tomorrow.

## AI Overview checks

**"DataForSEO: no login found in DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD"**
Set both environment variables (or the GitHub secrets of the same names). They're never stored in files.

**"DataForSEO: the login was refused" / "Check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD."**
Use the API login and API password from your DataForSEO dashboard, not your website password.

**"i AI Overview impact can't be measured at this size; we'll still list which searches show one and whether you're cited."**
Not an error. Your site doesn't have enough comparable searches yet to measure an effect, so searchtrace sticks to facts. See [COSTS.md](COSTS.md).

**A budget warning.**
The monthly or per-run cap was reached, or your balance is too low. Nothing more is posted until there's room. The run still exits 0.

## graphify

**"i graphify not found." / "Optional: pipx/uv install graphifyy to ask your history in Claude or Cursor."**
graphify is optional. Install it with `uv tool install graphifyy` or `pipx install graphifyy` if you want to question your history in Claude or Cursor.

**"! graphify found but its MCP server is not installed."**
Install the extra with `uv tool install --force "graphifyy[mcp]"`. Doctor then prints the exact `claude mcp add` command for your machine. See [GRAPHIFY.md](GRAPHIFY.md).

## Still stuck?

Open an issue at https://github.com/JhontyBarreto/searchtrace/issues with the output of `npx searchtrace doctor --json`. Doctor's output never includes keys, but check it before posting anyway.
