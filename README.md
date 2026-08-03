# model-eol

![spec](https://img.shields.io/badge/spec-model--eol%2F0.1-blue)
![deps](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**A machine-readable deprecation feed format for AI models, plus the reference
tooling that turns it into a Dependabot for models.** v0.2.1.

![model-eol demo: retired models, distributor clocks, worst-case date](docs/img/demo.gif)

## The problem

On July 23, 2026, OpenAI shut down 18 models on schedule. Teams that pinned dated
snapshots - the provider's own recommended practice - got production 404s, because a
model ID is the one dependency your toolchain can't see. When an npm package is
deprecated, the warning prints at install, Dependabot opens the PR, the advisory
fails CI. A model's retirement date lives in an HTML docs page and an email.

Ordinary software solved this layer: endoflife.date for EOL data, OSV for
vulnerability feeds. This is the model version - a shared schema first, tooling
second, so the existing trackers can converge instead of each scraping alone.

## What's here

- **`SPEC.md`** - the feed format (model-eol/0.1): id, aliases, announced, shutdown,
  replacement, `distributions` for per-channel lifecycles, and publisher `policy`
  floors. Small enough that a provider could serve it at
  `/.well-known/model-eol.json` in an afternoon.
- **`feeds/`** - <!-- feeds-status -->Amazon (4 entries), Anthropic (29 entries), Google (64 entries) and OpenAI (194 entries), generated from the providers' live deprecation pages plus the AWS Bedrock lifecycle page, last verified 2026-08-03<!-- /feeds-status -->. Every
  dated entry carries a source URL.
- **`check.mjs`** - zero-dependency CLI: CI gate, PR diff gate, inventory, CycloneDX
  ML-BOM export, retirement schedule, alerts and badges, migration plan/apply.
- **`refresh/`** - regenerates the feeds from provider pages, models endpoints, and
  distributor lifecycle pages, with a semantic diff for human review.
- **`bot/`** - the Dependabot part: a cron GitHub workflow that maintains one
  migration PR or issue per retiring model.
- **`scripts/feed-changelog.mjs`** - the feeds' git history as Atom/markdown, so
  "model retirements as they are announced" is a feed you can subscribe to.

## Try it

Two commands, no install, no dependencies:

```sh
git clone https://github.com/thossullivan/model-eol && cd model-eol
node check.mjs path/to/your/repo --days 90
```

That is the whole CI gate. (`npx model-eol` lands with the npm publish.)

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

## Same weights, different clocks

The same model retires on different dates per channel, and a checker that ignores
this is wrong in both directions: o3-deep-research died at OpenAI on July 23 but
lives on Azure AI Foundry until December 26; claude-opus-4-1 retires at Anthropic on
August 5 but lives on Amazon Bedrock until January 8, 2027. `distributions` in the
spec carries these per-channel clocks, `--via <distributor>` judges your repo by the
channel you actually call, and the bedrock distributor fetcher keeps the clocks
current from AWS's own lifecycle page. Treat a distributor's later date as runway
for the same migration, not as a destination.

## Policy floors - a forward guarantee from absence

A feed entry with no `announced` and no `shutdown` is an affirmative "nothing
scheduled as of `generated`" - something scraping HTML can never say. Publishers
with a stated minimum notice period (Anthropic commits to >=60 days) carry a
`policy` floor, so the schedule can say `guaranteed until <date> per anthropic
stated policy`. Stated policy, not a contract - the wording says so. OpenAI
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
Objective-C. Terraform files (`.tf`, `.tfvars`) are scanned while `.terraform`
directories stay excluded.

## The bot

Copy `bot.yml.example` to `.github/workflows/model-eol-bot.yml` for a weekly run
that maintains exactly one labelled migration PR per retiring model (full feed
context in the body, never auto-merged) and one issue per finding that needs a
human. Dismissals are respected; a changed shutdown date reopens. Configure via
`.model-eol.json`: thresholds, scope, ignores, and an optional eval hook that runs
your own regression command against the replacement before the PR opens. Preview
everything with no GitHub calls:

```sh
node bot/bot.mjs --dry-run --target-dir . --repo OWNER/REPO
```

Two operational notes the hard way teaches: PRs created with `GITHUB_TOKEN` do not
trigger `pull_request` workflows (use a fine-grained PAT or GitHub App token when
checks must run), and the workflow splits privileges - provider keys live only in
the read-only plan/eval job, write tokens only in the publish job.

## Keeping the feeds honest

```sh
node refresh/refresh.mjs --check                      # semantic diff vs live pages; exit 3 = PR-worthy
node refresh/refresh.mjs --distributor aws-bedrock    # distributor clocks from AWS's lifecycle page
node scripts/feed-changelog.mjs                       # feeds' git history as an Atom feed
```

Parse failures fail loudly and never emit a guessed feed. This runs automatically:
a weekly workflow (`.github/workflows/feed-refresh.yml`, Mondays 05:23 UTC) checks
the live sources and opens a PR with the semantic diff - and an auto-updated
README freshness line - when anything material changed. The first live runs earned
their keep: they caught the hand-compiled feeds drifting from Anthropic's
recommendations within one week, and corrected a hand-compiled Bedrock date that
was three months wrong.

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
  repo (parse failures fail the run; material changes become a reviewed PR). The
  CI and bot workflows still ship as `.example` files.
- Current-model entries (and therefore policy-floor horizons) populate only when
  refresh runs with provider API keys for the models endpoints.
- The checker matches known IDs only - it will not discover models absent from the
  feeds. Deliberate: precision over discovery for a CI gate.
- Not yet: feed signing, Google/Vertex/Azure fetchers (aws-bedrock is done; entries
  for the others welcome), gateway route resolvers, npm publish (prepped, pending).
