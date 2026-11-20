# About this manual

This manual is for the IT professional who runs Silicon Valley Bicycle Coalition's (SVBC's)
custom systems. That means keeping them running, finding out why something stopped, and
changing or adding code when SVBC's needs change. It assumes you are comfortable with web
services, HTTP, JSON, Git and a terminal. It doesn't assume you know Cloudflare Workers or the
Monday.com API. [Chapter 2](02-architecture.md) and the [glossary](glossary.md) cover what you
need.

## What "SVBC's custom infrastructure" means

SVBC's donor, member and volunteer records live in **Monday.com**. That system of record
replaced Salesforce in late 2026. Monday doesn't talk to the other services SVBC uses
(Funraise, Eventbrite, Mailchimp, Benevity, Double the Donation and others) the way SVBC needs.
A set of small programs fills those gaps. They run on **Cloudflare Workers** and live in one
public GitHub repository, `Silicon-Valley-Bicycle-Coalition/monday-workers`. Each program,
called a **Worker**, has its own directory. This manual covers:

- every Worker in that repository and the two command-line tools beside them;
- the Cloudflare, GitHub and vendor accounts they depend on;
- the conventions that hold them together (sandbox, write switch, Monday token broker, retries,
  alerts);
- how to develop, test, deploy, operate, troubleshoot and extend them.

The following are out of scope: how staff use Monday day to day (see the staff UAT scripts in
[`docs/uat/`](../uat/README.md)), SVBC's public website (Squarespace), email marketing content,
and general office IT.

## How to read it

| If you want to… | Read |
|---|---|
| Get the big picture in an hour | [1. System overview](01-system-overview.md), then [2. Architecture](02-architecture.md) |
| Set up your accounts and laptop | [3. Accounts and access](03-accounts-and-access.md), [5. Development](05-development.md) |
| Respond to an alert or a staff report | [8. Troubleshooting](08-troubleshooting.md), then the Worker's chapter |
| Pause writes during an incident | [7. Operations](07-operations.md), "The write switch" |
| Ship a change | [5. Development](05-development.md), [6. CI and deploy](06-ci-and-deploy.md) |
| Add a Worker or an integration | [9. Extending the system](09-extending.md) |
| Look up a route, cron, queue or database | Appendix A, at the end. It's generated from the code. |

Part II has one chapter per Worker, in alphabetical order. Each uses the same nine headings:
what it does, trigger and data flow, Monday boards and columns, secrets, write switch, failure
modes, operator scripts, changing it, and further reading.

## Conventions

- `monospace` marks a file, command, identifier or value you can type.
- Commands run from the repository root unless the text says `cd <worker>` first.
- "Production" and "sandbox" are the two environments ([chapter 4](04-environments.md)).
  "Worker name" means the deployed Cloudflare name, for example `svbc-funraise-sync`. "Worker
  directory" means the repo folder, for example `funraise-sync/`.
- Monday column names appear without the 🔒 and 📜 markers that staff see. See
  [chapter 2](02-architecture.md#read-only-column-markers).
- **To verify:** marks a fact that couldn't be confirmed from the code when this manual was
  written, such as a vendor console's menu path. When you confirm one, fix the text and remove
  the marker.

## This manual and the repository

The manual's source is Markdown in [`docs/manual/`](README.md) in the repository, and that
source is authoritative. The PDF in Box is built from it. The PDF's footer gives the commit it
was built from, and every repository link in the PDF opens GitHub at that commit. If the PDF and
the repository disagree, the repository is right, and the PDF is probably out of date.

The manual describes how the system works. It doesn't track what has been deployed when. For
current deploy status, see the root README's
[Status at a glance](../../README.md#status-at-a-glance) table. Each Worker's own README is
the detailed specification and history, and the chapters here link into it.

## What's public and what isn't

The repository is public under the MIT license, so other nonprofits can reuse it. This manual
is public too, so it names **roles**, not people: "Cloudflare Super Administrator", "Monday
account admin", "the SVBC Integration user". It never contains a secret value.

A **private appendix** goes with the PDF in a restricted Box folder. Its source is
`docs/it-manual-private-appendix.md` in SVBC's private planning repository, `monday-migration`.
It records:

- who holds each role, and their backups;
- where each secret value is stored (the Secret Manager project, its owner and backup holder,
  the second copy of each `BACKUP_ENCRYPTION_KEY`, and the `.env` files operators keep);
- account recovery contacts and procedures for each vendor;
- vendor account numbers, billing owners and renewal dates.

If you don't have the private appendix, ask whoever gave you this manual.

The planning repository also holds the original migration plan and the Salesforce data survey.
Worker READMEs sometimes refer to it as `migration-plan.md` or `docs/NN-…`. You don't need it to
operate the system.
