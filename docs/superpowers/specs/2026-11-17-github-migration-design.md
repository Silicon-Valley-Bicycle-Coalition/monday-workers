# Move monday-migration and monday-workers from GitLab to GitHub — design

IT Requests item 13456610373 (due 2026-12-31). Approved 2026-11-17.

## Intent

Work on GitHub, not mirror to it. Claude's GitHub integration (the GitHub app, `@claude` on
issues and PRs, PR Auto-fix in the desktop app) is much better than GitLab's, and that is the
whole reason for the move. GitLab stays behind as a read-only record.

## Targets

GitHub org `Silicon-Valley-Bicycle-Coalition` (Free plan, empty as of 2026-11-17):

| GitLab project | GitHub repo | Visibility |
|---|---|---|
| `silicon-valley-bicycle-coalition/svbc-monday-migration` (803 commits, 35 open issues, 2 open MRs) | `monday-migration` | private |
| `silicon-valley-bicycle-coalition/svbc-monday-workers` (2,343 commits, 9 open issues, 2 open MRs) | `monday-workers` | **public from day one** |

## Goals

- Both repos on GitHub with full history, all live branches and tags.
- Open issues continue on GitHub; closed issues and all MRs stay on GitLab as the record.
- CI on GitHub Actions does everything `.gitlab-ci.yml` does today.
- Production deploys that come from git (Workers Builds) track GitHub.
- Local checkouts, worktrees, CLAUDE.md files and Claude's memory follow the move.
- The Claude GitHub app is installed and works on both repos.

## Non-goals

- Migrating closed issues, MR discussions, or GitLab wiki/milestones.
- Moving `svbc-bike-lanes` or any other SVBC repo (separate decision).
- Changing how Workers are built or deployed beyond swapping the git host.

## Anti-goals (a failure even if everything "works")

- Donor PII, staff personal data, or a live secret becomes public through monday-workers history.
- A production Worker (`svbc-calendars`, `monday-backup`) stops redeploying on merge, or deploys
  from a non-`main` branch or a fork PR.
- An issue/PR number in the repo silently points at the wrong GitHub item.
- A worktree's gitignored `data/` or `.env` is destroyed by the folder move.

## Approaches considered

1. **Big-bang, both repos in one sitting** — shortest freeze, but every surprise lands on both
   repos at once, including the public one.
2. **monday-migration first as a rehearsal, then monday-workers (chosen)** — monday-migration is
   private, so it needs no history audit; its push, issue copy and tiny CI port shake out the
   scripts and runbook before the public repo, which carries the risk.
3. **Squashed fresh start for monday-workers** — avoids the audit entirely, but throws away 2,343
   commits of blame and the MR trail that commit messages reference. Kept only as the fallback if
   the audit finds something `git filter-repo` can't cleanly remove.

## Decisions

- **History audit gates the public push.** `gitleaks` over full history plus targeted scans
  (staff and donor email addresses, phone numbers, `data/` paths ever committed, `.env*`, token
  shapes). Board/column/workspace ids are config, already intended to be public, and are not a
  finding. Findings → `git filter-repo`; if that can't be made clean, fall back to approach 3.
- **Push heads and tags only**, from a fresh `git clone --mirror` of GitLab — not
  `push --mirror`, which would also push `refs/merge-requests/*` and `refs/keep-around/*`.
  Merged branches are pruned on GitLab first so GitHub starts clean.
- **References:** tracked files get bare `#NN` / `!NN` rewritten to explicit GitLab links by a
  tested script with a reviewed dry-run diff (it must skip CSS colours, markdown headings and code).
  Commit messages are left alone; the README says numbers in commits before the cutover date refer
  to GitLab.
- **Issues:** open issues are recreated by script (`glab` → `gh`) with title, body, labels and a
  back-link; the GitLab issue gets a forward link and is closed. Open MRs are merged or closed on
  GitLab before cutover; any still in progress becomes a GitHub PR from the same branch.
- **CI shape:** `checks.yml` runs every repo-level check (copy checks, bindings, preview URLs,
  rate-limit namespaces, log safety) on every PR and `main` push. They need no `npm ci` and are
  cheap, so they drop GitLab's per-check path rules. `workers.yml` has a `changes` job that
  builds the matrix of changed Worker directories (each Worker's extra paths, such as
  `scripts/lib/**`, are listed in one JSON file), then one test job per Worker. A final `ci-ok`
  job is the single required status check. Third-party actions are pinned by commit SHA.
- **Sandbox deploy fallback** is ported, still inert: on push to `main` only, `environment:
  sandbox`, and it skips unless the `CLOUDFLARE_API_TOKEN` environment secret exists. Fork PRs
  never get secrets. The member-portal → member-portal-writer ordering is kept.
- **Workers Builds:** `svbc-calendars` and `monday-backup` (production) are reconnected from
  GitLab to GitHub in one sitting each, with branch/PR builds left off, then verified by a real
  deploy from `main`. The dashboard is checked for any other connection.
- **Repo settings (monday-workers, public):** secret scanning + push protection, Dependabot alerts,
  a ruleset protecting `main` (PR required, `ci-ok` required, no force push), and Actions
  restricted to require approval for first-time fork contributors. monday-migration gets what
  the Free plan allows for private repos. GitHub for Nonprofits (free Team) is applied for
  separately; it isn't a blocker.
- **Local move last:** `~/Developer/gitlab.com/silicon-valley-bicycle-coalition` →
  `~/Developer/github.com/silicon-valley-bicycle-coalition`, after pruning merged worktrees (each
  checked for gitignored files first), then `git worktree repair`, and Claude project-memory folders
  copied to the new path names.
- **Claude GitHub app** installed on the org for both repos as the final acceptance check: an
  `@claude` mention on a test issue gets a response.

## Left to the builder

Exact gitleaks rule tuning, the reference-rewrite regex, the issue-copy script's label mapping,
and the order of jobs inside the workflows.
