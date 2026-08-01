# Design - the model-eol bot ("Dependabot for models")

*Status: agreed 2026-08-01 after two adversarial design reviews (Claude + Codex)
and a first field test of the core against real repos. SHIPPED same day in
v0.1.0: all tracks below are implemented (see docs/CONTEXT.md "State as of
2026-08-01"). One deviation earned by field testing: retired generic
model-references file issues too (reason not-direct-api) - the original issue
allowlist accidentally made them invisible.*

## Decisions locked

1. **Form factor**: cron-mode GitHub Action, no hosted app. Zero ops, installable
   by anyone, builds on the existing composite action.
2. **Remediation unit**: a migration PR with full context, never auto-merged,
   with a user-configurable eval hook seam. An npm bump is presumed safe until CI
   fails; a model swap is presumed unsafe until evals pass.
3. **Tracks run in parallel**: Track A (repo-side bot) and Track B (feed refresh)
   are independent and share only the schema.
4. **Language**: zero-dependency Node for the core, unchanged. Track B tooling
   may carry its own dependencies (the zero-dep rule is scoped to the reference
   checker). Rust is a possible v2 distribution story, not a v1 concern.

## Architecture - three layers

```
core (zero-dep, this repo)     bot adapter (zero-dep Node)      feed refresh (Track B)
check/inventory/schedule/  ->  GitHub REST orchestration,   <-  provider models endpoints
alert/plan/apply               PR lifecycle, eval runner        + deprecation pages -> feed PRs
```

The core stays executable spec documentation: scanning, lifecycle math, plan
generation, deterministic apply. All GitHub orchestration lives in a separate
bot adapter consuming versioned `plan --json`. Nothing stateful in the core.

## Track A - repo-side bot

### A1. Scanner hardening (prerequisite, found by field test 2026-08-01)

- **Traversal**: use `git ls-files` (tracked + untracked-unignored) when the
  target is inside a git work tree; fall back to a bounded walk (lstat, never
  follow symlinks, expanded skip list, per-file size cap, file-count cap) for
  non-git directories. Field test: a real repo had 414k files outside
  node_modules/.git and hung the scanner for 2+ minutes.
- **Bad targets warn, not abort**: a missing path skips with a stderr warning;
  exit 2 only when no valid target remains.
- **Dotfile extensions**: `path.extname('.env')` is `''`, so `.env` in CODE_EXT
  is dead code today. Match dotfile basenames (`.env`, `.env.*`) explicitly.
- **Feed composition safety**: `loadFeeds` currently lets the last feed silently
  win on id/alias collisions. Cross-feed duplicates become a hard load error
  naming both files.
- **`--via` semantics**: a distribution entry for the requested distributor with
  no `shutdown` means "no retirement scheduled on that channel" - it must not
  inherit the publisher clock. Only when no distribution entry exists for the
  requested distributor may the publisher clock apply, labelled
  `publisher-fallback`. Fallback findings are never patchable.

### A2. `plan` and `apply` (core commands)

- `plan` emits a versioned plan document (`model-eol.plan/0.1`): patchable items
  plus non-patchable issues, each with full feed context (dates, sources, notes).
- **Patch gating** (tightened per Codex review): an item is patchable only if
  ALL hold - usage is `direct-api` at high confidence; status is retired or
  retiring within threshold; the feed names a `replacement`; the replacement
  resolves in the loaded feeds and is not itself retired/retiring; the lifecycle
  date is not a `publisher-fallback`. Generic `model-reference`, cloud/gateway
  hints, and candidates are issue-only. Candidates NEVER generate work items.
- **Apply safety**: each plan item carries the expected line content hash and
  occurrence index. `apply` verifies before writing and refuses on any mismatch
  (line drift, changed checkout, duplicate ambiguity). Idempotent re-runs.

### A3. Bot adapter (separate task, after A1/A2 integrate)

- Cron workflow scans the default branch; per retiring model maintains exactly
  one PR on a ref-safe slugged branch (`model-eol/<publisher>/<slug>`).
- Lifecycle: refuse to force-push a branch that diverged from bot-only history;
  workflow `concurrency` keyed per repo; machine-readable metadata block
  (HTML comment JSON: canonical id, shutdown, feed digest) in the PR body plus a
  `model-eol` label carry all state - the bot itself stays stateless.
- Dismissal: closed-unmerged PR with matching metadata means "don't reopen for
  this (id, shutdown)"; a changed shutdown date reopens.
- PR body: announced/shutdown dates, days remaining, sources, feed notes,
  distributor clock when configured, "replacement per feed as of <run date>"
  timestamp, explicit warning that checks may be skipped under `GITHUB_TOKEN`.
- **Token reality**: PRs created with `GITHUB_TOKEN` do not trigger
  `on: pull_request` workflows. Document a fine-grained PAT / GitHub App token
  as the recommended path; degrade gracefully (PR still opens, body warns).
- **Feed freshness**: the adapter fetches feeds from this repo's main branch at
  runtime (schema-validated), with the vendored copy as offline fallback and
  `--feeds` as override. A pinned action must not mean pinned data.

### A4. Eval hook (security boundary, per Codex review - critical finding)

Contract: `{"eval": {"command": "..."}}` in `.model-eol.json`; env vars
`MODEL_EOL_OLD_ID`, `MODEL_EOL_NEW_ID`, `MODEL_EOL_PLAN`; exit 0 = pass;
optional markdown report via `MODEL_EOL_REPORT` path.

Execution rules: the eval runs in a separate least-privilege job - no write
token, no secrets beyond the provider API key, bounded runtime and output size,
explicit opt-in. The report is untrusted content: capped and fenced when
embedded in the PR body. Evals only run when the patch changed since the last
bot push (they cost real API spend).

### Config - `.model-eol.json` in the consuming repo

Threshold days, scope, `via`, ignore list (canonical id ignores its aliases;
repo-relative globs), PR-vs-issue preferences, eval hook.

## Track B - feed refresh (supply side)

- Scheduled job regenerates `feeds/*.json` from two source classes per provider:
  the **models endpoint** (live list of current models - this is what makes
  absence-is-data real; field test showed the Anthropic feed carries only
  deprecated models, so healthy repos get "unknown candidate" instead of
  "you're clear") and the **deprecations page** (dates, replacements).
- Output: schema-valid feeds where current models appear as entries with no
  `announced`/`shutdown`, every dated entry carries a `source` URL.
- Parse failures fail loudly and never emit a guessed feed or drop existing
  entries. Human review stays in the loop: the job opens a PR only when
  something changed, with a semantic diff (models added, dates moved,
  replacements changed) in the body.
- Tests run offline against recorded fixtures.
- Workflow ships as `refresh.yml.example` (workflow-scoped-credential
  constraint, same convention as ci.yml.example).

## Spec questions raised (v0.2 candidates, not blocking)

- Distribution entry without `shutdown`: define as "no retirement scheduled on
  that channel as of `generated`" (matches absence-is-data).
- Model ids need a documented git-ref-safe slug rule for branch names.
- Plan document schema joins the published schemas.

## Backlog (accepted, not gating v1)

Monorepo ownership groups (per-path reviewers, per-component eval commands),
ignore-semantics precision (expiry dates, audit reasons), feed signing.
