# model-eol

![npm](https://img.shields.io/npm/v/model-eol)
[![marketplace](https://img.shields.io/badge/marketplace-model--eol%20check-blue?logo=github)](https://github.com/marketplace/actions/model-eol-check)
![CI](https://github.com/thossullivan/model-eol/actions/workflows/ci.yml/badge.svg)
[![feed refresh](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml/badge.svg)](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml)
![spec](https://img.shields.io/badge/spec-model--eol%2F0.1-blue)
![deps](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**A machine-readable deprecation feed format for AI models, plus the reference
tooling that turns it into a Dependabot for models.**

![model-eol demo: retired models, distributor clocks, worst-case date](docs/img/demo.gif)

## The problem

On July 23, 2026, OpenAI shut down a scheduled wave of model snapshots. One of my
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
- **`feeds/`** - <!-- feeds-status -->Amazon (4 entries), Anthropic (29 entries), Google (89 entries) and OpenAI (194 entries), generated from the providers' live deprecation pages plus the AWS Bedrock and Google Vertex AI lifecycle pages, feed data generated 2026-08-31<!-- /feeds-status -->. Every
  dated entry carries a source URL.
- **`check.mjs`** - zero-dependency CLI: CI gate, PR diff gate, inventory, CycloneDX
  ML-BOM export, retirement schedule, alerts and badges, migration plan/apply,
  and public document validation.
- **`refresh/`** - regenerates the feeds from provider pages, models endpoints, and
  distributor lifecycle pages, with a semantic diff for human review.
- **`bot/`** - the Dependabot part: a cron GitHub workflow that maintains one
  migration PR or issue per retiring model, published as the `model-eol-bot`
  binary in the same npm package.
- **Public contract** - versioned schemas, hosted feeds, refresh health, a
  publication manifest, and an Atom changelog are live at
  [`thossullivan.github.io/model-eol`](https://thossullivan.github.io/model-eol/).
  Publication requires a refresh receipt for the exact feeds on `main`, followed
  by an exact-byte check against every deployed asset.

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
# the primary CI gate is also a schema-valid public report
node check.mjs check path/to/your/repo --json > model-eol-check.json
node check.mjs validate model-eol-check.json
# retirement schedule with the repo-level worst case
node check.mjs schedule path/to/your/repo
# GitHub Actions annotations, Markdown, or a shields.io badge
node check.mjs alert path/to/your/repo --format github
node check.mjs alert path/to/your/repo --format badge > model-eol-badge.json
# migration plan (only high-confidence direct API refs are patchable) and safe apply
node check.mjs plan path/to/your/repo --days 90 > plan.json
node check.mjs apply --plan plan.json --dry-run
# validate provider feeds, repository policy, or model-eol machine reports
node check.mjs validate feeds/openai.json .model-eol.json plan.json
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
- uses: actions/checkout@v7
  with:
    fetch-depth: 0 # --changed needs history to diff against the base ref
- uses: actions/setup-node@v7
  with:
    node-version: 22
    package-manager-cache: false
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
Action also exposes `inventory`, `schedule`, `alert`, `plan`, and `validate`. Use
`format: cyclonedx` for an ML-BOM, or `output-file` to retain any report as a
workflow artifact while keeping the same output in the job log.

CycloneDX exports use one machine-learning component per canonical model and
lifecycle channel. Direct publisher (`publisher-direct`), Azure, Bedrock, and
other routed references therefore retain their own status and shutdown clock
under deterministic, channel-qualified `bom-ref` values; occurrences are sorted
and scoped to the component whose clock they used.

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
  "waivers": [
    {
      "model": "gpt-4",
      "paths": ["services/legacy/**"],
      "via": "aws-bedrock",
      "reason": "Vendor contract pins this model until the Q1 migration.",
      "owner": "@platform-team",
      "expires": "2026-12-31"
    }
  ],
  "issues": { "enabled": true },
  "eval": { "command": "node scripts/model-eol-eval.mjs" }
}
```

Unknown keys and invalid values fail closed. A canonical model ID or any alias
in `ignore.models` suppresses the whole alias family; `ignore.paths` uses
repo-relative `*`, `**`, and `?` globs and excludes matching files before scan
coverage limits are counted. With no config the CLI keeps its historical
`scope: all`; once a config exists, omitted values use the shared bot defaults
(`days: 90`, `scope: direct`, and the publisher clock). Portable structure is
defined by
[`schema/model-eol.bot-config.schema.json`](schema/model-eol.bot-config.schema.json),
while `model-eol validate` also enforces runtime semantic and safety checks that
Draft-07 cannot express cleanly.

Ignores hide inventory noise from non-dependency artifacts. Waivers record owned,
expiring exceptions for live dependencies. A waiver never hides its finding.
The `waiver` field appears on a finding only when a waiver matched it. It records
the reason, owner, expiry, and active state. Active waivers remove retired or
retiring findings from failure and badge totals. Alerts emit these findings as
warnings. Plans retain them without creating migration work. Expired waivers
explain why their findings became actionable again.

The expiry date uses UTC calendar dates. A waiver becomes inactive on its expiry
date. A model alias matches its whole canonical alias family. Optional `paths`
use the same repository-relative globs as `ignore.paths`. Omit `via` for any
clock, name a distributor to narrow to that clock, or use `publisher` for the
direct publisher clock. Use `publisher-fallback` for an explicit publisher
fallback clock. The first active matching waiver wins. A config can contain at
most 500 waivers across all policy levels.

For content-heavy repositories, start with `inventory`, then exclude caches,
generated catalogs, archived fixtures, and documentation that are not live model
dependencies. Published-repository UAT deliberately verifies both outcomes: the
unconfigured scan reports evidence, while an explicit path policy produces a
clean check and empty bot decision table without changing repository content.

Parent-repository scans do not recurse into tracked Git submodules. A detected
gitlink is reported as incomplete coverage, so `check` and `plan` fail closed
unless the path is explicitly ignored or `--allow-incomplete` is chosen. To
inspect submodule contents, run model-eol against the checked-out submodule as a
separate target/repository policy.

Untracked nested Git repositories are handled the same way: the parent reports
`nested-repository-skipped` and never recurses into the nested checkout. Ignore
an intentional nested repository explicitly, allow incomplete coverage, or scan
it separately with its own repository policy.

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
additive. Overrides can also add path-scoped `waivers` with the same shape.
The last matching route wins. Exact `match`/`model` pairs resolve a
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
bot-owned PRs/issues close when their finding disappears. In a repository without
a configured eval, preview everything with no GitHub calls and without adding a
project dependency:

```sh
npx --yes --package=model-eol@0 model-eol-bot --dry-run --target-dir . --repo OWNER/REPO
```

The workflow honors configured `days`, `scope`, and `via` values; without a config
it uses the bot defaults of 90 days and direct references. `eval.command` also
comes from the config unless the `MODEL_EOL_EVAL_COMMAND` repository variable is
set as an explicit workflow override. Each patchable model is applied in an
isolated checkout and evaluated independently with its own old/new IDs, timeout,
bounded report, and explicitly forwarded environment names. The content-bound result
manifest is also pinned to the evaluated Git commit, letting passing migrations
proceed while a failing peer remains blocked without publishing against a newer,
unevaluated default branch.

### Prove the swap works in your repository

Model behavior is repository-specific, so model-eol never guesses which test is
good enough to authorize a migration. Check a harness into the repository and
name it explicitly in `.model-eol.json`. A non-empty
`MODEL_EOL_EVAL_COMMAND` repository variable overrides that command; otherwise
the config is authoritative. With neither configured, the result manifest says
that evaluation was not configured.

Start by copying [`examples/model-eol-eval.mjs`](examples/model-eol-eval.mjs) to
`scripts/model-eol-eval.mjs`, then replace its `VERIFY` command with the smallest
deterministic test that proves the behavior your application relies on. A useful
harness checks response or tool-call shape, structured-output parsing, required
capabilities, and a small golden task set. A generic build passing is supporting
evidence, but it does not by itself prove model behavior. The starter invokes a
dedicated `npm run eval:model-eol` script so adopting it requires an explicit
repository test rather than accidentally treating an unrelated unit suite as an
LLM-behavior eval.
Point `eval:model-eol` at the underlying behavior test, not back at the harness
itself.

The harness runs after the proposed migration in an isolated checkout and gets:

- `MODEL_EOL_OLD_ID` and `MODEL_EOL_NEW_ID` for the current migration.
- `MODEL_EOL_PLAN`, a one-model plan containing the exact changed references.
- `MODEL_EOL_REPORT`, the required path for a bounded, publishable Markdown receipt.

Exit zero plus a regular report file means pass; any other exit, timeout, missing
report, tracked workspace mutation, or checkout drift fails that migration. Test
stdout and stderr are intentionally not published. Put only non-secret evidence
in the report, and forward only credentials required by trusted eval code through
`eval.pass_env`. That allowlist controls normal subprocess environment forwarding;
it is not an OS sandbox and does not isolate code running as the same user. The
workflow's security boundary is that this job has no repository write token and
the publication job never executes repository-owned eval code.

Before enabling the scheduled bot, commit the harness and policy on a clean
branch and exercise the same isolated evaluator locally:

```bash
set -euo pipefail
repo="$(pwd -P)"
version="$(npm view model-eol@0 version --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);const r=Array.isArray(v)?v.at(-1):v;if(typeof r!=="string")process.exit(1);process.stdout.write(r)})')"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
cd "$tmp"
if [ -f "$repo/.model-eol.json" ]; then
  MODEL_EOL_UAT_REPO="$repo" npx --yes --package="model-eol@$version" \
    -c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan .' > "$tmp/plan.json"
else
  MODEL_EOL_UAT_REPO="$repo" npx --yes --package="model-eol@$version" \
    -c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan . --days 90 --scope direct' > "$tmp/plan.json"
fi
npx --yes --package="model-eol@$version" model-eol-bot evaluate \
  --target-dir "$repo" \
  --plan-file "$tmp/plan.json" \
  --output-file "$tmp/eval.json"
node -e 'const r=require(process.argv[1]); console.log(r.results)' "$tmp/eval.json"
MODEL_EOL_EVAL_RESULTS_FILE="$tmp/eval.json" \
  npx --yes --package="model-eol@$version" model-eol-bot \
    --dry-run --target-dir "$repo" --repo OWNER/REPO
```

Each planned model is patched and evaluated independently. The cleanup trap
removes the temporary artifacts when this shell exits; copy `eval.json` elsewhere
after the dry run if you want to retain the receipt as UAT evidence. Then let
`bot.yml.example` run the same contract with any explicitly opted-in provider
keys available to its read-only evaluate job, not its write-capable publish job.

Inline `model-eol-bot --eval` and the legacy unbound report/status artifacts are
refused. A configured publication must consume the commit-bound manifest from
`model-eol-bot evaluate`; missing results fail before GitHub API access.

On its first actionable run, the bot creates the `model-eol` label. If repository
policy prevents label creation or assignment, it fails closed rather than publish
work whose ownership cannot be authenticated. Existing work is trusted only when
the label, metadata, deterministic branch, repository, base, and Git lease agree.
For HTTPS remotes - including private repositories - the bot passes `GITHUB_TOKEN` to
temporary Git processes as a host-scoped authorization header and never places it
in a remote URL.

Two operational notes the hard way teaches: PRs created with `GITHUB_TOKEN` do not
trigger `pull_request` workflows (use a fine-grained PAT or GitHub App token when
checks must run, stored as the optional `MODEL_EOL_BOT_TOKEN` secret), and the
workflow splits privileges - only provider secrets explicitly added for the
trusted eval live in the read-only evaluation job, while write tokens live only
in the reconciliation job.

## Keeping the feeds honest

```sh
node refresh/refresh.mjs --check                      # semantic diff vs live pages; exit 3 = PR-worthy
node refresh/refresh.mjs --distributor aws-bedrock,vertex-ai # distributor lifecycle clocks
node scripts/feed-changelog.mjs                       # local rendering of the hosted Atom feed
```

Parse failures fail loudly and never emit a guessed feed. This runs automatically:
a weekly workflow (`.github/workflows/feed-refresh.yml`, Mondays 05:23 UTC) checks
the live sources and opens a PR with the semantic diff - and an auto-updated
README freshness line - when anything material changed. The first live runs earned
their keep: they caught the hand-compiled feeds drifting from Anthropic's
recommendations within one week, and corrected a hand-compiled Bedrock date that
was three months wrong.

Every successful live refresh emits a byte-exact receipt. The Pages workflow
publishes the [public contract](https://thossullivan.github.io/model-eol/) only
when that receipt hashes the exact feeds on `main`: a no-change check can advance
`last_checked` immediately, while a material-change run waits for its generated
feed PR to merge. Feed `generated` remains semantic - it changes only when source
data changes. The hosted contract contains canonical Draft-07 schemas, feeds
with SHA-256 receipts, and the Atom changelog.

The refresh also travels in the other direction. On August 3, Google removed the
previously listed October 16 earliest shutdown dates for the Gemini 2.5 Pro,
Flash, and Flash-Lite GA models. The pipeline opened
[a PR with the semantic retraction](https://github.com/thossullivan/model-eol/pull/60),
and downstream checks stopped warning from dates Google no longer listed. A
lifecycle tracker has to retract stale alarms as well as add new ones.

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
- The [public contract](https://thossullivan.github.io/model-eol/) publishes
  canonical schemas, feeds, refresh health, a publication manifest, and Atom.
  Each deployment is bound to an exact feed-refresh receipt and verified against
  every live asset. `model-eol validate` checks feeds, repository policy, check
  reports, inventories, schedules, alerts, and plans against the same
  zero-dependency runtime contracts.
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
- Not yet: feed signing, authenticated account-level gateway/cloud resolvers.

## Contributing

The most valuable contribution is a feed correction with a source URL - and the
one rule is that `feeds/*.json` are generated, never hand-edited. See
[CONTRIBUTING.md](CONTRIBUTING.md) for that workflow, the zero-dependency
doctrine, and what a new publisher parser needs.
