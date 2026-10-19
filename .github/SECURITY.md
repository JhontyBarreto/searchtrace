# Security policy

searchtrace handles Google credentials, a DataForSEO login and private Search Console data, so security reports are very welcome.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a problem

Please report security problems privately, not in a public issue:

- open a private advisory at https://github.com/JhontyBarreto/searchtrace/security/advisories/new

Include what you found, how to reproduce it, and what it lets someone do. Please don't include real keys, client data or Search Console exports; synthetic examples are fine. You'll get an answer within 7 days, and a fix or a plan within 30 days for anything confirmed.

## In scope

- Credential handling: loading, copying and storing keys, secret scrubbing in logs and files, the `doctor --share` output.
- The reports: escaping of queries, URLs and titles, the Content-Security-Policy, Markdown injection.
- The crawler: staying on your own property, redirect checks, private address and port checks, size caps, robots.txt and sitemap parsing.
- The GitHub Action template: the public-repo guard, the split between the job with secrets and the job that pushes, pinning of searchtrace and every action.
- DataForSEO spending: the caps, at-most-once posting and reconciliation.
- The install path: anything that could make a documented command run code that isn't this project's.

## Out of scope

- Problems that need an attacker who already controls your machine, your Google account or your DataForSEO account.
- Google's, GitHub's or DataForSEO's own services.
