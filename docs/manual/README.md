# SVBC IT manual — source

This directory is the source of the **SVBC Infrastructure Technical Manual**, the handbook IT
uses to run, troubleshoot and extend SVBC's custom systems (the Cloudflare Workers in this repo
and the services around them). The Markdown here is the source of truth. A PDF built from it is
published to Box. Start reading at [00-about.md](00-about.md).

Design: [`docs/superpowers/specs/2026-11-19-it-manual-design.md`](../superpowers/specs/2026-11-19-it-manual-design.md).

## Layout

| Part | Files | What |
|---|---|---|
| I. Foundations | `00-about.md` … `07-operations.md` | Orientation, architecture, access, environments, development, CI and deploy, operations |
| II. Workers | `workers/<dir>.md` | One chapter per entry in `.github/workers.json` |
| III. When things go wrong, and growing | `08-troubleshooting.md`, `09-extending.md` | Symptom-first troubleshooting; adding Workers, columns, integrations |
| | `glossary.md` | Terms |
| Appendix A | `reference/<dir>.md` (generated, gitignored) | Each Worker's routes, crons, queues, D1, KV, R2, bindings and limits, from its `wrangler*.jsonc` |
| | `figures/` | SVG figures |
| | `print.css` | PDF print styles (the cover is pandoc's title block) |

The PDF order lives in `chapterOrder()` in `scripts/build-manual.mjs`.

## Keeping it current

**Change the manual in the same PR as the code.** In practice:

- **A new Worker:** add its `workers/<dir>.md`. CI's `manual` step (`scripts/check-manual.mjs`)
  fails until the chapter exists and carries the nine template headings.
- **A change to a Worker's behaviour, secrets, failure modes or scripts:** update its chapter.
- **A change to a binding, queue, cron or route:** nothing to do. Appendix A is generated from
  the Wrangler config.
- **Deploy status:** keep it out of the manual. It belongs in the root README's
  "Status at a glance" table, and the manual links there.

The `manual` CI step also checks that every relative link in these files resolves.

### Worker chapter template

Every `workers/<dir>.md` uses these `##` headings in this order. Extra `###` subsections are fine.

1. `What it does`: two or three sentences, in staff terms.
2. `Trigger and data flow`: webhook, cron, queue or RPC, and the path data takes.
3. `Monday boards and columns`: what it reads and writes, by bare column title, and where the ids live.
4. `Secrets`: names only, what each is for, where it is issued, how to rotate it.
5. `Write switch`: `on`, `hold` and `off` behaviour, or "no write switch".
6. `Failure modes`: what breaks, how it shows, what to do.
7. `Operator scripts`: the Worker's scripts and when to use them.
8. `Changing it`: the files that matter, gotchas, tests.
9. `Further reading`: README sections, runbooks, design specs, UAT script.

Open each chapter with a link to its Appendix A page: `[Appendix A](../reference/<dir>.md)`.

### Public repo rules

This repo is public. Name **roles** ("Cloudflare Super Administrator", "Monday account admin"),
never people. Never include personal email addresses, phone numbers or secret values. Who holds
each role, where secret values are stored, recovery contacts and vendor account numbers go in the
**private appendix**, `monday-migration/docs/it-manual-private-appendix.md`, which lives in the
private planning repo and is published beside the PDF in a restricted Box folder.

### "To verify"

Facts that couldn't be confirmed from the repo or from `wrangler` (console menu paths, recovery
flows, vendor-side settings) are marked **To verify:** in the text. When you confirm one, remove
the marker and update the count below.

<!-- to-verify-list: regenerate with  grep -c 'To verify' docs/manual/*.md docs/manual/workers/*.md -->
Open items, by file. Search each file for **To verify** to find them.

| File | Open items |
|---|---|
| [`workers/report-digests.md`](workers/report-digests.md) | 1 |

## Building the PDF

The build needs [pandoc](https://pandoc.org/) and Google Chrome or Chromium. Set `CHROME_PATH`
if Chrome isn't in a standard location. Run it from the repo root on a clean, committed tree:

```sh
node scripts/build-manual.mjs
```

This writes `dist/svbc-it-manual-<date>-<sha>.pdf`. Every repo link in the PDF opens GitHub at
that commit. `--allow-dirty` builds from uncommitted changes, and the cover then says so. Use it
only for previews.

The private appendix is built with the same styling:

```sh
node scripts/build-manual.mjs --input ../monday-migration/docs/it-manual-private-appendix.md
```

## Publishing to Box

1. Build from `main` after the PR merges.
2. In Box, open the existing manual file and choose **Upload New Version**, so the shared link
   stays the same. Upload a new file only the first time.
3. Build the private appendix and upload it as a new version in the restricted IT folder.
4. Put the commit's short sha in the version comment.
