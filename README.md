# model-eol

![npm](https://img.shields.io/npm/v/model-eol)
[![marketplace](https://img.shields.io/badge/marketplace-model--eol%20check-blue?logo=github)](https://github.com/marketplace/actions/model-eol-check)
![CI](https://github.com/thossullivan/model-eol/actions/workflows/ci.yml/badge.svg)
[![feed refresh](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml/badge.svg)](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml)
![spec](https://img.shields.io/badge/spec-model--eol%2F0.1-blue)
![deps](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**A machine-readable deprecation feed format for AI models, plus the reference
tooling that turns it into a Dependabot for models.**

![model-eol demo: retired models, distributor clocks, worst-case date](docs/img/demo.gif)

## The problem

On July 23, 2026, OpenAI shut down 15 model snapshots on schedule. One of my
tuned research workflows returned a model-not-found error that morning even though
the retirement had been documented for months. A model ID is the one dependency
my toolchain could not see. When an npm package is deprecated, the warning prints
at install, Dependabot opens the PR, and an advisory can fail CI. A model's
retirement date usually lives in an HTML docs page and an email.

Ordinary software solved this layer: endoflife.date for EOL data, OSV for
vulnerability feeds. This is the model version - a shared schema first, tooling
second, so the existing trackers can converge instead of each scraping alone.

## What's here

- **`SPEC.md`** - the feed format (model-eol/0.1): id, aliases, announced, shutdown,
  replacement, `distributions` for per-channel lifecycles, and publisher `policy`
  floors. Small enough that a provider could serve it at
  `/.well-known/model-eol.json` in an afternoon.
- **`feeds/`** - <!-- feeds-status -->Amazon (4 entries), Anthropic (29 entries), Google (86 entries) and OpenAI (194 entries), generated from the providers' live deprecation pages plus the AWS Bedrock and Google Vertex AI lifecycle pages, feed data generated 2026-08-18<!-- /feeds-status -->. Every
  dated entry carries a source URL.
- **`check.mjs`** - zero-dependency CLI: CI gate, PR diff gate, inventory, CycloneDX
  ML-BOM export, retirement schedule, alerts and badges, migration plan/apply.
- **`refresh/`** - regenerates the feeds from provider pages, models endpoints, and
  distributor lifecycle pages, with a semantic diff for human review.
- **`bot/`** - the Dependabot part: a cron GitHub workflow that maintains one
  migration PR or issue per retiring model, published as the `model-eol-bot`
  binary in the same npm package.
- **`scripts/feed-changelog.mjs`** - the feeds' git history as Atom/markdown, so
  "model retirements as they are announced" is a feed you can subscribe to.

## Try it

One command, no install, no API keys:

```sh
npx model-eol path/to/your/repo --days 90
```

That is the whole CI gate. Prefer not to touch npm? Clone and run - it is
identical, because there are no dependencies to install either way:

```sh
git clone https://github.com/thossullivan/model-eol && cd model-eol
node check.mjs path/to/your/repo --days 90
```

<details>
<summary><b>Every command</b> - PR gate, distributor clocks, SBOM, badges, migration plans</summary>

```sh
# PR gate: flag only lines THIS change adds relative to the base ref
node check.mjs check . --changed origin/main --days 90
# the same repo judged by a distributor's clock instead of the publisher's
node check.mjs path/to/your/repo --via aws-bedrock
# inventory, and a CycloneDX 1.6 ML-BOM for your SBOM pipeline
node check.mjs inventory path/to/your/repo
node check.mjs inventory path/to/your/repo --format cyclonedx > model-bom.json
# retirement schedule with the repo-level worst case
node check.mjs schedule path/to/your/repo
# GitHub Actions annotations, Markdown, or a shields.io badge
node check.mjs alert path/to/your/repo --format github
node check.mjs alert path/to/your/repo --format badge > model-eol-badge.json
# migration plan (only high-confidence direct API refs are patchable) and safe apply
node check.mjs plan path/to/your/repo --days 90 > plan.json
node check.mjs apply --plan plan.json --dry-run
```

</details>

Sample output against the test fixture (2026-08-01):

```
✗ app.py:2  o3-deep-research          RETIRED 2026-07-23 (9 days ago) -> gpt-5.6-sol
! app.py:3  claude-opus-4-1-20250805  RETIRES 2026-08-05 (4 days) -> claude-opus-4-8
· app.py:4  gpt-5.6-sol               no retirement scheduled
earliest risk: 2026-07-23 (o3-deep-research-2025-06-26)
```

Exit 1 on findings at or past the threshold - wire it into CI as-is. The badge JSON
plugs into the [shields endpoint](https://shields.io/endpoint) from any
CI-accessible URL.

**No API keys, no accounts.** Scanning is static analysis and the feeds are data
files, so the checker, PR gate, schedule, SBOM export, and badge all run with zero
credentials. The bot needs only a GitHub token (a fine-grained PAT if you want its
PRs to trigger checks), and provider API keys enter the picture in exactly two
optional places: your own eval hook command, and the feed-refresh models-endpoint
coverage.

Both command-line binaries ship in one zero-dependency npm artifact. The test
suite packs that artifact, installs it into an empty consumer directory with the
network disabled, and runs both bins; it also fails if runtime, development,
peer, or optional npm dependencies are introduced.

## Use it as a GitHub Action

The same gate as a composite action - no npm install, feeds bundled, pinned to
the `v0` line:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # --changed needs history to diff against the base ref
- uses: thossullivan/model-eol@v0
  with:
    command: check
    changed: origin/${{ github.base_ref }}
    days: 90
    scope: direct
```

That is the PR gate: fail only when *this* change adds a model that is retired
or retiring within the threshold. Add `via: aws-bedrock` (or `azure-ai-foundry`)
to judge by a distributor's clock. The copy-paste version with both gates - PR
diff plus a weekly full-repository check - is
[`examples/workflows/model-eol.yml`](examples/workflows/model-eol.yml). The
Action also exposes `inventory`, `schedule`, `alert`, and `plan`. Use
`format: cyclonedx` for an ML-BOM, or `output-file` to retain any report as a
workflow artifact while keeping the same output in the job log.

## One repository policy

The CLI, Action, and bot all discover a strict `.model-eol.json` at the target
Git repository root. CLI flags or Action inputs override configured values, and
`--config FILE` selects an explicit policy when auto-discovery is ambiguous:

```json
{
  "days": 90,
  "scope": "direct",
  "via": null,
  "ignore": {
    "models": ["o3-deep-research"],
    "paths": ["test/fixtures/**", "vendor"]
  },
  "issues": { "enabled": true },
  "eval": { "command": "npm test" }
}
```

Unknown keys and invalid values fail closed. A canonical model ID or any alias
in `ignore.models` suppresses the whole alias family; `ignore.paths` uses
repo-relative `*`, `**`, and `?` globs and excludes matching files before scan
coverage limits are counted. With no config the CLI keeps its historical
`scope: all`; once a config exists, omitted values use the shared bot defaults
(`days: 90`, `scope: direct`, and the publisher clock). The complete contract is
[`schema/model-eol.bot-config.schema.json`](schema/model-eol.bot-config.schema.json).

Mixed-provider monorepos can keep those top-level values as repository defaults,
then apply path policies and a lifecycle channel per reference:

```json
{
  "days": 90,
  "scope": "direct",
  "overrides": [
    { "paths": ["services/**"], "scope": "all" },
    { "paths": ["services/bedrock/**"], "days": 180, "via": "aws-bedrock" }
  ],
  "routes": [
    { "paths": ["services/vertex/**"], "via": "vertex-ai" },
    {
      "paths": ["services/bedrock/**"],
      "match": "chat-prod",
      "model": "claude-3-7-sonnet-20250219",
      "via": "aws-bedrock"
    }
  ]
}
```

Matching overrides apply in order: later scalar values win and ignore lists are
additive. The last matching route wins. Exact `match`/`model` pairs resolve a
repository deployment alias without making cloud or gateway references patchable.
Explicit CLI flags and Action inputs still take precedence. JSON inventory and
plan output records each reference's effective threshold, scope, requested
channel, and matching rule indexes, so a Bedrock service and a direct publisher
call in the same repository do not silently share one global clock.

## Same weights, different clocks

The same model retires on different dates per channel, and a checker that ignores
this is wrong in both directions: o3-deep-research died at OpenAI on July 23 but
lives on Azure AI Foundry until December 26; claude-opus-4-1 retires at Anthropic on
August 5 but lives on Amazon Bedrock until January 8, 2027. `distributions` in the
spec carries these per-channel clocks, `--via <distributor>` judges your repo by the
channel you actually call, and the distributor refresh keeps Bedrock and Vertex
clocks current from their lifecycle pages. Treat a distributor's later date as
runway for the same migration, not as a destination.

## Policy floors - a planning floor from absence

A feed entry with no `announced` and no `shutdown` is an affirmative "nothing
scheduled as of `generated`" - something scraping HTML can never say. Publishers
with a stated minimum notice period (Anthropic states >=60 days) carry a
`policy` floor, so the schedule can calculate a no-earlier-than planning date
from the feed refresh. Stated policy, not a contract. OpenAI
publishes no formal floor, so its feed makes no forward claim.

## Direct-first inventory

Direct API usage (OpenAI/Anthropic/Gemini/etc. SDK calls with real model IDs) is
scanned and checked immediately. Cloud providers and gateways - Azure Foundry,
Bedrock, Vertex, OpenRouter, LiteLLM, Portkey - often hide the model behind
deployment names or routing aliases, so those references stay in inventory as
resolver targets instead of pretending static code knows the deployed model:

```
? src/ai.ts:12  azure-ai-foundry  Azure Foundry/OpenAI deployment reference
? src/ai.ts:30  openrouter        OpenRouter gateway reference
```

Use `--scope direct` to fail CI only on what static analysis can prove. Model-like
strings absent from the feeds surface as non-failing **candidates**, so feed gaps
stay visible without generating false alarms.

The scanner covers code and configuration files with [`CODE_EXT`](lib/scanner.mjs)
as the source of truth - Python, TypeScript/JavaScript, JSON/YAML/TOML, shell,
Ruby, Go, Java, C#, Rust, C/C++, PHP, Swift, Kotlin, Terraform, SQL, Scala, and
Objective-C, including `.baml` sources. Publisher-compatible BAML provider/model
pairs are eligible plan targets; generated BAML clients and conservative
`DO NOT EDIT`/`@generated` sources are skipped. Model-eol's own JSON reports are
also skipped on reruns, while third-party CycloneDX files remain scannable unless
they carry explicit model-eol generator provenance. Terraform files (`.tf`,
`.tfvars`) are scanned while `.terraform` directories stay excluded.

## The bot

Copy `bot.yml.example` to `.github/workflows/model-eol-bot.yml` for a weekly run
that maintains exactly one labelled migration PR per retiring model (full feed
context in the body, never auto-merged) and one issue per finding that needs a
human. The workflow resolves `model-eol@0` from npm once and reuses that exact
version across its plan, read-only evaluation, and write-token publication jobs;
consumer repositories do not copy `check.mjs` or the `bot/` source directory.
Dismissals are respected, reintroduced retired models create fresh work, and
bot-owned PRs/issues close when their finding disappears. Preview everything with
no GitHub calls and without adding a project dependency:

```sh
npx --yes --package=model-eol@0 model-eol-bot --dry-run --target-dir . --repo OWNER/REPO
```

The workflow honors configured `days`, `scope`, and `via` values; without a config
it uses the bot defaults of 90 days and direct references. `eval.command` also
comes from the config unless the `MODEL_EOL_EVAL_COMMAND` repository variable is
set as an explicit workflow override. Each patchable model is applied in an
isolated checkout and evaluated independently with its own old/new IDs, timeout,
bounded report, and explicitly allowed environment. The content-bound result
manifest lets passing migrations proceed while a failing peer remains blocked.

On its first actionable run, the bot creates the `model-eol` label. If repository
policy prevents label creation or assignment, it fails closed rather than publish
work whose ownership cannot be authenticated. Existing work is trusted only when
the label, metadata, deterministic branch, repository, base, and Git lease agree.
For HTTPS remotes—including private repositories—the bot passes `GITHUB_TOKEN` to
temporary Git processes as a host-scoped authorization header and never places it
in a remote URL.

Two operational notes the hard way teaches: PRs created with `GITHUB_TOKEN` do not
trigger `pull_request` workflows (use a fine-grained PAT or GitHub App token when
checks must run, stored as the optional `MODEL_EOL_BOT_TOKEN` secret), and the
workflow splits privileges—provider keys live only in the read-only evaluation
job, while write tokens live only in the reconciliation job.

## Keeping the feeds honest

```sh
node refresh/refresh.mjs --check                      # semantic diff vs live pages; exit 3 = PR-worthy
node refresh/refresh.mjs --distributor aws-bedrock,vertex-ai # distributor lifecycle clocks
node scripts/feed-changelog.mjs                       # feeds' git history as an Atom feed
```

Parse failures fail loudly and never emit a guessed feed. This runs automatically:
a weekly workflow (`.github/workflows/feed-refresh.yml`, Mondays 05:23 UTC) checks
the live sources and opens a PR with the semantic diff - and an auto-updated
README freshness line - when anything material changed. The first live runs earned
their keep: they caught the hand-compiled feeds drifting from Anthropic's
recommendations within one week, and corrected a hand-compiled Bedrock date that
was three months wrong.

The refresh also travels in the other direction. On August 3, Google removed the
previously listed October 16 earliest shutdown dates for the Gemini 2.5 Pro,
Flash, and Flash-Lite GA models. The pipeline opened
[a PR with the semantic retraction](https://github.com/thossullivan/model-eol/pull/60),
and merging it published v0.2.3 so downstream checks stopped warning from dates
Google no longer listed. A lifecycle tracker has to retract stale alarms as well
as add new ones.

## The actual ask

The endgame is not "another checker"; it's the format. Providers already publish
deprecation *pages* because customers asked. A `retirement_date` field in the models
endpoint, or this feed at a well-known URL, turns every existing tracker into an
ecosystem. endoflife.date now tracks Claude with nearly this field set - the
convergence is already starting. If you maintain one of the community trackers:
converging on a shared schema - this one or a better one - is the highest-leverage
move any of us can make here.

## Status / honesty

- Feeds refresh automatically: the weekly feed-refresh workflow is live in this
  repo (parse failures fail the run; material changes become a reviewed PR), and
  CI runs the full suite on every push and PR. The copy-ready bot workflow ships
  as `bot.yml.example` and consumes the published package rather than local copies
  of the tooling.
- Current-model entries (and therefore policy-floor horizons) populate only when
  refresh runs with provider API keys for the models endpoints.
- The checker matches known IDs only - it will not discover models absent from the
  feeds. Deliberate: precision over discovery for a CI gate.
- Fetchers: OpenAI, Anthropic, Google, aws-bedrock, and vertex-ai are live. Azure
  clocks are carried where OpenAI's own page publishes them; a standalone Azure
  lifecycle fetcher is not built yet.
- On npm as [`model-eol`](https://www.npmjs.com/package/model-eol). Material feed
  changes republish automatically as patch versions (trusted publishing with
  provenance), while manual code releases require an explicit stable version, so
  `npx model-eol` always checks against current dates.
- Not yet: feed signing, gateway route resolvers.

## Contributing

The most valuable contribution is a feed correction with a source URL - and the
one rule is that `feeds/*.json` are generated, never hand-edited. See
[CONTRIBUTING.md](CONTRIBUTING.md) for that workflow, the zero-dependency
doctrine, and what a new publisher parser needs.
