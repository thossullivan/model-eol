# Design - the model-eol bot ("Dependabot for models")

*Status 2026-08-18: the architecture below is shipped, adversarially reviewed,
and proven through a hosted plan/evaluate/publish UAT. Current releases add
commit-bound evaluator artifacts, trusted ownership leases, stale-work
reconciliation, per-reference routing, and permanent published-consumer tests.
Retired generic model references remain issue-only (`not-direct-api`).*

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

- Cron workflow scans the default branch; per retiring model and distributor
  clock it maintains one open PR on a deterministic ref-safe branch
  (`model-eol/<publisher>/<via?>/<slug>-<hash>`).
- Lifecycle: trust work only when the `model-eol` label, valid metadata identity,
  target repository, and expected branch agree. Malformed or user-authored
  markers elsewhere never suppress findings. Before every skip or force-push,
  independently fetch the branch and verify the recorded head, bot committer,
  target default branch, and recorded base commit.
- Reconciliation: valid labelled bot PRs and issues are commented and closed
  when their findings disappear, become ignored/retracted, change clock or kind,
  or issue publication is disabled. A previously merged migration does not
  suppress a retired model that is later reintroduced; a deleted historical bot
  branch may be safely recreated after its recorded lease is checked.
- Workflow `concurrency` is keyed per repo. A machine-readable metadata block
  (HTML comment JSON: canonical id, shutdown, replacement, clock, feed digest,
  base/head commits) plus the label carries all state; the bot stays stateless.
- Dismissal: closed-unmerged PR with matching metadata means "don't reopen for
  this (id, shutdown)"; a changed shutdown date reopens.
- PR body: announced/shutdown dates, days remaining, sources, feed notes,
  distributor clock when configured, "replacement per feed as of <run date>"
  timestamp, explicit warning that checks may be skipped under `GITHUB_TOKEN`.
- **Ownership label**: label creation and assignment are fail-closed. Publishing
  unlabeled work would make future ownership decisions forgeable, so a label
  policy failure produces a blocked non-zero outcome instead.
- **Token reality**: PRs created with `GITHUB_TOKEN` do not trigger
  `on: pull_request` workflows. Document a fine-grained PAT / GitHub App token
  as the recommended path; degrade gracefully (PR still opens, body warns).
- **Feed freshness**: the copy-ready workflow resolves the moving npm `0.x` line
  once and carries that exact published package through all three jobs. Its
  schema-validated bundled feeds are the default. Explicit remote feed URLs are
  opt-in, fail closed, and may use a configured vendored fallback in degraded
  report-only mode.

### A4. Eval hook (security boundary, per Codex review - critical finding)

Contract: `{"eval": {"command": "..."}}` in `.model-eol.json`; env vars
`MODEL_EOL_OLD_ID`, `MODEL_EOL_NEW_ID`, `MODEL_EOL_PLAN`; exit 0 = pass;
a regular bounded Markdown report is required at the `MODEL_EOL_REPORT` path for
an exit-zero run to count as passing.

The command is intentionally explicit rather than inferred from package files:
model-eol cannot know whether a unit suite proves tool calling, structured output,
retrieval quality, or another repository-specific behavior. The checked-in
[`examples/model-eol-eval.mjs`](../examples/model-eol-eval.mjs) is the
dependency-free starter. Consumers should customize its verification command and
semantic assertions, always write a non-secret receipt to `MODEL_EOL_REPORT`, and
run the evaluator locally against a clean committed checkout before enabling the
hosted workflow. A non-empty `MODEL_EOL_EVAL_COMMAND` workflow variable takes
precedence over `eval.command`; an absent command is recorded as unconfigured,
not silently treated as a passing eval.

Execution rules: the workflow resolves the moving npm major once, validates and
records the exact version, and reuses it in all three jobs. The plan job emits a
versioned plan. A separate least-privilege evaluate job independently verifies
that plan, applies each migration in its own temporary checkout, then invokes
the configured command with its own old/new IDs and selected plan. It has no
write token; consumers add only the provider secrets their trusted eval needs,
and those names must also appear in `eval.pass_env`. Environment filtering controls
normal child-process forwarding, not same-user OS isolation; repository code and
its dependencies remain trusted inside the evaluate job. Timeout and report-size
limits apply per migration, and tracked eval workspace/history drift turns that
migration into a failure.

The evaluate job always uploads one bounded result manifest containing an exact
pass/fail/timeout record per migration. The manifest is bound to the evaluated
Git commit plus stable plan and eval-configuration digests. The publish job
refuses a newer default-branch head, receives no provider keys,
independently regenerates the plan, verifies both artifacts before any GitHub
operation, publishes passing migrations, records failed peers as blocked, and
returns non-zero if any conflict, eval failure, lease stand-down, label failure,
or degraded report-only decision remains. Reports are untrusted content: capped
and fenced when embedded in PR bodies. The publish process never executes
repository-owned eval code. When `eval.command` is configured, a missing bound
result manifest fails before GitHub API access.

The former inline `model-eol-bot --eval` mode and the unbound report/status
artifacts are intentionally refused: process-level environment scrubbing is not a
privilege boundary when evaluation and publication share a user and write token.
Consumers migrate to the plan/evaluate/publish workflow in `bot.yml.example`.

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
