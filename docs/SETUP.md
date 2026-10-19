# Setting up searchtrace

searchtrace needs read access to your Search Console data. There are two ways to give it that, and one way to look around first.

## Install

searchtrace is installed from GitHub; it is not on the npm registry. You need Node 22.13 or newer.

```bash
npm install -g https://github.com/JhontyBarreto/searchtrace/releases/download/v0.1.0/searchtrace-0.1.0.tgz
```

That is the built release tarball (its SHA-256 is in the release's `SHA256SUMS`). On npm 12 or newer add `--allow-remote=all`; older npm versions accept the flag and ignore it. Don't use `npm install -g github:JhontyBarreto/searchtrace`: a global install from a git URL fails on npm 10 and 11 with "tsc: command not found".

To try it once without installing, run it straight from GitHub. This needs git, and the first run builds searchtrace, which takes about a minute (on npm 12, add `--allow-git=all` after `-y`):

```bash
npx -y "github:JhontyBarreto/searchtrace#v0.1.0" demo
```

Keep the quotes: zsh with `extendedglob` turned on treats an unquoted `#` as a pattern.

## Start

```bash
searchtrace setup      # the wizard (needs a terminal)
searchtrace demo       # a made-up site, no login, if you just want to see a report
```

Everything ends up in one folder, `searchtrace-data/` by default (change it with `--dir` or the `SEARCHTRACE_DIR` environment variable). Keys never go in that folder.

## Option 1: a robot account (recommended)

A robot account is a Google Cloud service account: a separate Google identity that only ever reads your Search Console data. It's the right choice if you want searchtrace to run every day on a schedule, because its key doesn't expire the way a personal sign-in does.

The wizard prints each link and waits for you. It never opens your browser.

### Step 1 of 4: create a free Google Cloud project

Open https://console.cloud.google.com/projectcreate, name the project "searchtrace" and click Create. No card is needed.

_Screenshot placeholder: the "New project" form with the name filled in._

**Using a company Google Workspace account?** Many Workspace organisations block service-account key creation with a policy. If step 3 tells you "Service account key creation is disabled", do steps 1 to 3 signed in with a personal Gmail account instead. The robot can still be given access to your company's site in step 4, because Search Console permissions are per user email, not per organisation.

### Step 2 of 4: turn on the Search Console API

Open https://console.cloud.google.com/apis/library/searchconsole.googleapis.com, check the project picker at the top says "searchtrace", and click Enable.

_Screenshot placeholder: the API page with the Enable button._

### Step 3 of 4: create the robot and download its key

Open https://console.cloud.google.com/iam-admin/serviceaccounts. Create service account, name it `searchtrace`, click Done (skip the optional roles). Then click the new account, open Keys, choose Add key, Create new key, JSON, Create.

_Screenshot placeholder: the Keys tab with "Add key" open._

Treat the downloaded file like a password. When the wizard asks, paste its path (or drag the file into the terminal). searchtrace copies it to `~/.config/searchtrace/google-key.json`, readable only by you, and offers to delete the original. It suggests deleting only when the original sits in Downloads; a key you keep somewhere else is left alone unless you say yes.

### Step 4 of 4: let the robot read your site

The wizard shows the robot's email, which looks like `searchtrace@your-project.iam.gserviceaccount.com`. Open https://search.google.com/search-console/users, pick your site, click "Add user", paste the email, choose **Full** and click Add. You must be an owner of the property to add users.

_Screenshot placeholder: the "Add user" dialog with Permission set to Full._

The wizard then checks every five seconds until the robot can see your site.

### Why "Full" and not "Restricted"?

Restricted users may only get "fetch only" access to URL Inspection, and searchtrace relies on URL Inspection to learn when Google last crawled each page. Full permission does not let the robot change anything through searchtrace: it only ever requests the read-only Search Console scope (`webmasters.readonly`). `searchtrace doctor` runs one live URL Inspection to prove the permission works.

If you can't get Full (an agency given Restricted access by a client, say), set `"inspection": {"enabled": false}` in `config.json`. Index checks then stop, so the daily run doesn't fail on them, but reports lose the crawl dates. setup warns you and offers this when it sees a Restricted user.

| Search Console permission | Reads performance data | URL Inspection | Recommended |
|---|---|---|---|
| Owner | yes | yes | not needed |
| Full | yes | yes | yes |
| Restricted | yes | may be refused | no |

## Option 2: gcloud on this computer

If you already use the Google Cloud CLI, searchtrace can use your Application Default Credentials. A plain `gcloud auth application-default login` won't work: gcloud's own sign-in client can't ask for the Search Console scope, so Google refuses with "insufficient authentication scopes". You sign in with an OAuth client of your own instead:

1. In your Cloud project, turn on the Search Console API (the link in Option 1, step 2).
2. Configure the consent screen under Google Auth Platform. Pick **Internal** if you're on Google Workspace. Otherwise pick **External** and add your own Google email under Audience, Test users.
3. An External app left in Testing expires the sign-in after 7 days ("Token has been expired or revoked"). To avoid that, publish the app to Production. You'll then see a "Google hasn't verified this app" screen when you sign in, which is fine for your own use (Advanced, then continue). Or use a robot account, whose key doesn't expire.
4. Create an OAuth client ID of type "Desktop app" (Google Auth Platform, Clients) and download its JSON.
5. Sign in with it:

```bash
gcloud auth application-default login --client-id-file=<your OAuth client json> \
    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
```

searchtrace finds the result at `~/.config/gcloud/application_default_credentials.json` (on Windows, `%APPDATA%\gcloud\application_default_credentials.json`).

**Quota project errors.** Some user credentials need a quota project for API calls. If you see one, either run `gcloud auth application-default set-quota-project <your project id>` (which writes `quota_project_id` into the ADC file, and searchtrace reads it from there), set `auth.quotaProject` in `searchtrace-data/config.json`, or set the `GOOGLE_CLOUD_QUOTA_PROJECT` environment variable. searchtrace only sends the `x-goog-user-project` header when one of these is set.

**"Google wants you to sign in again" (`invalid_rapt`).** Your organisation requires periodic re-authentication. Run the gcloud command above again, or switch to a robot account, which isn't affected.

A token file written by Google's Python auth library (`token.json` with `client_id`, `client_secret` and `refresh_token` but no `type`) also works. Point at it with `--credentials`.

## Where searchtrace looks for a credential

The first one that exists wins:

1. `--credentials FILE`
2. `auth.credentialsFile` in `config.json`
3. the environment variable named by `auth.credentialsEnv` (default `SEARCHTRACE_GOOGLE_KEY`), holding the key JSON itself (this is how the GitHub Action passes it)
4. `GOOGLE_APPLICATION_CREDENTIALS` (a path)
5. gcloud's Application Default Credentials file

It accepts a service-account key, an `authorized_user` file from gcloud, or a token file without a `type`.

## Setting up without prompts

For scripts and CI:

```bash
searchtrace setup --yes --property sc-domain:example.com --credentials ~/keys/searchtrace.json
```

- `--property` takes `sc-domain:example.com` for a Domain property or the full URL with a trailing slash (`https://www.example.com/`) for a URL-prefix property. A bare `example.com` is matched to whichever of your properties covers it.
- `--credentials` is stored as a path. The file is not copied, and it is refused if it sits inside the data folder. A key under your home folder is saved as `~/...`, so a `config.json` you commit doesn't carry your username; on a GitHub runner that path doesn't exist and the `SEARCHTRACE_GOOGLE_KEY` secret is used instead.
- `--dataforseo --monthly-budget 1 --max-per-run 0.30` turns on AI Overview checks (see [COSTS.md](COSTS.md)).
- `--github` also writes the GitHub Action (see [GITHUB-ACTION.md](GITHUB-ACTION.md)). The data folder has to sit at the top of a git clone, because GitHub only reads workflows at the repo root; otherwise setup stops before writing anything.
- Run it again on an existing folder and it merges the flags you pass into the current config instead of starting over.

setup checks the property against the list of sites the credential can see. If you typed a URL-prefix property but you have a Domain property for the same site, it stops and tells you which one to use.

## After setup

```bash
searchtrace doctor    # every check, with a one-line fix for anything wrong
searchtrace run       # the first run fetches up to 16 months
```

The first run takes about 10 minutes on a small site: roughly 4 minutes downloading Search Console data, 3 to 4 minutes reading your pages and 3 minutes of index checks. A bigger site takes longer. After that a daily run takes seconds.

To run it every day on this computer, pick the schedule option in the wizard. It prints a cron line that calls Node and searchtrace by their full paths (cron's PATH is only `/usr/bin:/bin`) and logs to `searchtrace-data/state/cron.log`. cron doesn't see your shell's environment, so if AI Overview checks are on, add `DATAFORSEO_LOGIN=...` and `DATAFORSEO_PASSWORD=...` lines above the schedule in the crontab.

If something goes wrong, [TROUBLESHOOTING.md](TROUBLESHOOTING.md) lists every doctor message and what to do about it.
