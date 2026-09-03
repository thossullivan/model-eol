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
research workflows failed that morning with a model-not-found error. The
retirement had been documented for months. I had not seen it, because a model ID
was the one dependency my toolchain could not track.

Other dependencies do not work this way. When an npm package is deprecated, the
warning prints at install, Dependabot opens a PR, and an advisory can fail CI. A
model's retirement date usually lives in an HTML docs page and an email.

Ordinary software already solved this layer: endoflife.date for end-of-life
dates, OSV for vulnerability feeds. This project is the model version. The
schema comes first and the tooling second, so existing trackers can share one
format instead of each scraping the same pages.

## What's here

- **`SPEC.md`** - the feed format (model-eol/0.1): id, aliases, announced, shutdown,
  replacement, `distributions` for per-channel lifecycles, and publisher `policy`
  floors. It is small enough that a provider could serve it at
  `/.well-known/model-eol.json` in an afternoon.
- **`feeds/`** - <!-- feeds-status -->Amazon (4 entries), Anthropic (30 entries), Google (93 entries) and OpenAI (194 entries), generated from the providers' live deprecation pages plus the AWS Bedrock and Google Vertex AI lifecycle pages, feed data generated 2026-09-03<!-- /feeds-status -->. Every
  dated entry carries a source URL. Anthropic's "not sooner than" dates for
  active models are included as `tentative` planning floors.
- **`check.mjs`** - zero-dependency CLI: CI gate, PR diff gate, inventory, CycloneDX
  ML-BOM export, retirement schedule, alerts and badges, migration plan/apply,
  and public document validation.
- **`refresh/`** - regenerates the feeds from provider pages, models endpoints, and
  distributor lifecycle pages, with a semantic diff for human review.
- **`bot/`** - the Dependabot part: a scheduled GitHub workflow that maintains one
  migration PR or issue per retiring model. It ships as the `model-eol-bot`
  binary in the same npm package.
- **Public contract** - versioned schemas, hosted feeds, refresh health, a
  publication manifest, and an Atom changelog at
  [`thossullivan.github.io/model-eol`](https://thossullivan.github.io/model-eol/).
  Publication requires a refresh receipt for the exact feeds on `main`, followed
  by an exact-byte check of every deployed asset.

## Try it

One command, no install, no API keys:

```sh
npx model-eol path/to/your/repo --days 90
```

That is the whole CI gate. If you prefer not to use npm, clone and run. The
result is identical, because there are no dependencies to install either way:

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

The command exits 1 when any finding is at or past the threshold, so it works
in CI as-is. The badge JSON works with the
[shields endpoint](https://shields.io/endpoint) from any URL your CI can reach.

**No API keys, no accounts.** Scanning is static analysis and the feeds are data
files. The checker, PR gate, schedule, SBOM export, and badge run with no
credentials at all. The bot needs a GitHub token, and a fine-grained PAT if you
want its PRs to trigger checks. Provider API keys are optional in exactly two
places: your own eval command, and the models-endpoint coverage in the feed
refresh.

Both command-line binaries ship in one zero-dependency npm package. The test
suite packs that package, installs it into an empty directory with the network
disabled, and runs both binaries. The suite also fails if any runtime,
development, peer, or optional npm dependency is added.

## Use it as a GitHub Action

The same gate as a composite action. No npm install, feeds bundled, pinned to
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

This is the PR gate. It fails only when *this* change adds a model that is
retired or retiring within the threshold. Add `via: aws-bedrock` (or
`azure-ai-foundry`) to judge by a distributor's clock.

A copy-paste workflow with both gates, the PR diff and a weekly full-repository
check, is in
[`examples/workflows/model-eol.yml`](examples/workflows/model-eol.yml). The
Action also exposes `inventory`, `schedule`, `alert`, `plan`, and `validate`.
Use `format: cyclonedx` for an ML-BOM. Use `output-file` to keep any report as
a workflow artifact while the same output still prints in the job log.

CycloneDX exports contain one machine-learning component per canonical model
and lifecycle channel. A direct publisher reference (`publisher-direct`), an
Azure reference, and a Bedrock reference to the same model therefore keep their
own status and shutdown date, under deterministic channel-qualified `bom-ref`
values. Occurrences are sorted and attached to the component whose clock judged
them.

## One repository policy

The CLI, the Action, and the bot all read a strict `.model-eol.json` at the
root of the target Git repository. CLI flags and Action inputs override
configured values. `--config FILE` selects an explicit policy when discovery
is ambiguous:

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

Unknown keys and invalid values are errors. A canonical model ID or any alias
in `ignore.models` suppresses the whole alias family. `ignore.paths` takes
repo-relative `*`, `**`, and `?` globs and excludes matching files before scan
coverage is counted.

With no config, the CLI keeps its historical `scope: all`. Once a config exists,
omitted values use the bot defaults: `days: 90`, `scope: direct`, and the
publisher clock. The portable structure is defined by
[`schema/model-eol.bot-config.schema.json`](schema/model-eol.bot-config.schema.json).
`model-eol validate` also enforces the runtime rules that Draft-07 cannot
express.

### Ignores and waivers

Ignores and waivers answer different questions.

`ignore` hides inventory noise: fixtures, caches, and vendored catalogs that are
not live dependencies. Ignored references do not appear in reports.

A **waiver** records a deliberate exception on a live dependency: which model,
why, who owns it, and the date it expires. A waiver never hides its finding.
The reference stays in `check`, `inventory`, `schedule`, `alert`, `plan`, and
the CycloneDX export, with its reason, owner, expiry, and active state attached.
The `waiver` field appears on a finding only when a waiver matched it:

```
✗ app.py:2  o3-deep-research  RETIRED 2026-07-23 (42 days ago) -> gpt-5.6-sol  [waived until 2026-12-31 by @research-platform: Research pipeline pinned until the Q4 rerun.]
```

While a waiver is active, that finding is left out of the exit-1 total, the
badge counts, and the alert errors, and the bot opens no migration work for it.
On the expiry date the finding is actionable again, and the report names the
waiver that lapsed and who owned it. Expiry uses UTC dates, and the expiry date
itself counts as expired.

The waiver fields work like this:

- `model` matches the whole alias family.
- `paths` takes the same repo-relative globs as `ignore.paths`.
- `via` narrows the waiver to one clock: a distributor id, or `publisher` for
  the direct publisher clock. Omit it to waive every clock.
- The first active matching waiver wins.
- A policy holds at most 500 waivers across the root and its overrides.

A malformed waiver, such as a missing owner, a relative duration, or an unknown
key, is a config error like any other. An expired waiver is not an error. It is
simply no longer active. The CycloneDX export records each component's waiver
state as active, partial, or expired.

### Coverage limits

For content-heavy repositories, start with `inventory`. Then exclude caches,
generated catalogs, archived fixtures, and documentation that are not live
model dependencies. The published-repository tests verify both outcomes: an
unconfigured scan reports the evidence, and an explicit path policy produces a
clean check and an empty bot decision table without changing repository
content.

Scans do not recurse into tracked Git submodules. A detected gitlink is
reported as incomplete coverage, so `check` and `plan` fail unless the path is
ignored or `--allow-incomplete` is set. To inspect a submodule, run model-eol
against its checkout as a separate target with its own policy.

Untracked nested Git repositories work the same way. The parent reports
`nested-repository-skipped` and never recurses into the nested checkout. Ignore
an intentional nested repository, allow incomplete coverage, or scan it
separately.

### Monorepos

Mixed-provider monorepos keep the top-level values as defaults, then apply path
policies and a lifecycle channel per reference:

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

Matching overrides apply in order. Later scalar values win. Ignore and waiver
lists add up, so an override can carry path-scoped `waivers` with the same shape
as the root. The last matching route wins. An exact `match`/`model` pair
resolves a deployment alias without making cloud or gateway references
patchable. Explicit CLI flags and Action inputs still take precedence.

JSON inventory and plan output record each reference's effective threshold,
scope, requested channel, and matching rule indexes. A Bedrock service and a
direct publisher call in the same repository therefore never share one global
clock by accident.

## One model, several retirement dates

The same model retires on different dates on different channels. A checker that
ignores this is wrong in both directions. o3-deep-research retired at OpenAI on
July 23 but stays available on Azure AI Foundry until December 26.
claude-opus-4-1 retires at Anthropic on August 5 but stays on Amazon Bedrock
until January 8, 2027.

`distributions` in the spec carries these per-channel dates. `--via <distributor>`
judges your repo by the channel you call. The distributor refresh keeps the
Bedrock and Vertex dates current from their lifecycle pages. A distributor's
later date gives you more time for the same migration. It is not a reason to
skip it.

## Policy floors

A feed entry with no `announced` and no `shutdown` means "nothing scheduled as
of `generated`". That is a positive statement, and it is one that scraping HTML
cannot make on its own.

Publishers with a stated minimum notice period carry a `policy` floor. Anthropic
states at least 60 days. The schedule uses that floor to compute a
no-earlier-than planning date from the feed refresh. This is stated policy, not
a contract. OpenAI publishes no formal notice period, so its feed makes no
forward claim.

Anthropic also lists a tentative retirement date, "not sooner than", for every
active model. The feed carries those as `shutdown` with
`date_precision: "tentative"` and no `announced` date, because nothing has been
announced. The checker treats a tentative date as a floor, not a schedule. The
finding is `scheduled`, never `retiring` or `retired`. `safe_until` is the later
of the floor and the policy date. A tentative floor cannot fail CI, and the bot
opens no work for it. It does appear in every schedule, so planning can start
before the announcement:

```
· app.py:1  claude-sonnet-4-5-20250929  scheduled - tentative, not announced: not sooner than 2026-09-29, guaranteed until 2026-10-17 by anthropic policy
```

When Anthropic announces the retirement, the announcement wins. The entry
becomes an ordinary exact date with an `announced` date.

`earliest` is different. Google's "earliest possible" shutdown dates are
announced deprecations, and the checker treats them as the scheduled date.

A repository that uses many active Claude models gets one floor line per
reference. To read only announced retirements, filter on `date_precision`:

```sh
node check.mjs schedule path/to/your/repo --json \
  | jq '.items |= map(select(.date_precision != "tentative"))'
```

## Direct-first inventory

Direct API usage, meaning OpenAI, Anthropic, Gemini, or similar SDK calls with
real model IDs, is scanned and checked immediately. Cloud providers and
gateways such as Azure Foundry, Bedrock, Vertex, OpenRouter, LiteLLM, and
Portkey often hide the model behind a deployment name or a routing alias. Those
references stay in the inventory as resolver targets, because static analysis
cannot know which model is deployed behind them:

```
? src/ai.ts:12  azure-ai-foundry  Azure Foundry/OpenAI deployment reference
? src/ai.ts:30  openrouter        OpenRouter gateway reference
```

Use `--scope direct` to fail CI only on what static analysis can prove.
Model-like strings that are absent from the feeds are reported as non-failing
**candidates**, so feed gaps stay visible without false alarms.

The scanner covers code and configuration files. The list in
[`CODE_EXT`](lib/scanner.mjs) is the source of truth: Python,
TypeScript/JavaScript, JSON/YAML/TOML, shell, Ruby, Go, Java, C#, Rust, C/C++,
PHP, Swift, Kotlin, Terraform, SQL, Scala, and Objective-C, including `.baml`
sources. Publisher-compatible BAML provider/model pairs can be plan targets.
Generated BAML clients and sources marked `DO NOT EDIT` or `@generated` are
skipped. Model-eol's own JSON reports are skipped on reruns. Third-party
CycloneDX files are scanned unless they carry explicit model-eol generator
provenance. Terraform files (`.tf`, `.tfvars`) are scanned, and `.terraform`
directories are excluded.

## The bot

Copy `bot.yml.example` to `.github/workflows/model-eol-bot.yml` for a weekly
run. It maintains exactly one labelled migration PR per retiring model, with
the full feed context in the body and never auto-merged, and one issue per
finding that needs a human.

The workflow resolves `model-eol@0` from npm once and uses that exact version
across its plan, read-only evaluation, and write-token publication jobs.
Consumer repositories do not copy `check.mjs` or the `bot/` source directory.

Dismissals are respected. A reintroduced retired model creates fresh work.
Bot-owned PRs and issues close when their finding disappears or is waived. When
a waiver expires, the bot treats the finding as new rather than inheriting the
earlier dismissal.

In a repository without a configured eval, preview everything with no GitHub
calls and no project dependency:

```sh
npx --yes --package=model-eol@0 model-eol-bot --dry-run --target-dir . --repo OWNER/REPO
```

The workflow honors configured `days`, `scope`, and `via` values. Without a
config it uses the bot defaults of 90 days and direct references. `eval.command`
also comes from the config, unless the `MODEL_EOL_EVAL_COMMAND` repository
variable is set as an explicit override.

Each patchable model is applied in an isolated checkout and evaluated on its
own, with its own old and new IDs, timeout, bounded report, and explicitly
forwarded environment names. The result manifest is bound to its content and
pinned to the evaluated Git commit. A passing migration can proceed while a
failing one stays blocked, and nothing is published against a newer,
unevaluated default branch.

### Prove the swap works in your repository

Model behavior is specific to your repository, so model-eol never guesses which
test is good enough to authorize a migration. Check a harness into the
repository and name it in `.model-eol.json`. A non-empty
`MODEL_EOL_EVAL_COMMAND` repository variable overrides that command. Otherwise
the config is authoritative. With neither configured, the result manifest
records that evaluation was not configured.

Start by copying [`examples/model-eol-eval.mjs`](examples/model-eol-eval.mjs) to
`scripts/model-eol-eval.mjs`. Replace its `VERIFY` command with the smallest
deterministic test that proves the behavior your application relies on. A good
harness checks response or tool-call shape, structured-output parsing, required
capabilities, and a small set of golden tasks. A passing build is supporting
evidence, but it does not prove model behavior by itself.

The starter calls a dedicated `npm run eval:model-eol` script, so adopting it
requires an explicit repository test. That prevents an unrelated unit suite from
being treated as an LLM-behavior eval by accident. Point `eval:model-eol` at the
behavior test, not back at the harness.

The harness runs after the proposed migration, in an isolated checkout, and
receives:

- `MODEL_EOL_OLD_ID` and `MODEL_EOL_NEW_ID` for the current migration.
- `MODEL_EOL_PLAN`, a one-model plan containing the exact changed references.
- `MODEL_EOL_REPORT`, the required path for a bounded, publishable Markdown receipt.

Exit zero plus a regular report file means pass. Any other exit, a timeout, a
missing report, a tracked workspace change, or checkout drift fails that
migration. Test stdout and stderr are not published. Put only non-secret
evidence in the report. Forward only the credentials the eval code needs,
through `eval.pass_env`. That allowlist controls normal subprocess environment
forwarding. It is not an OS sandbox and does not isolate code running as the
same user. The security boundary is that the evaluation job has no repository
write token, and the publication job never runs repository-owned eval code.

Before enabling the scheduled bot, commit the harness and policy on a clean
branch and run the same isolated evaluator locally:

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

Each planned model is patched and evaluated on its own. The cleanup trap
removes the temporary files when the shell exits. Copy `eval.json` elsewhere
after the dry run if you want to keep it as evidence. Then let
`bot.yml.example` run the same contract, with any provider keys you opt in
available only to its read-only evaluate job, never to its publish job.

Inline `model-eol-bot --eval` and the older unbound report and status artifacts
are refused. A configured publication must consume the commit-bound manifest
from `model-eol-bot evaluate`. Missing results fail before any GitHub API call.

On its first actionable run, the bot creates the `model-eol` label. If
repository policy prevents label creation or assignment, the bot stops rather
than publish work whose ownership cannot be verified. Existing work is trusted
only when the label, metadata, deterministic branch, repository, base, and Git
lease all agree. For HTTPS remotes, including private repositories, the bot
passes `GITHUB_TOKEN` to temporary Git processes as a host-scoped authorization
header and never puts it in a remote URL.

Two operational notes. PRs created with `GITHUB_TOKEN` do not trigger
`pull_request` workflows; store a fine-grained PAT or GitHub App token as the
optional `MODEL_EOL_BOT_TOKEN` secret when checks must run. And the workflow
splits privileges: only the provider secrets you add for the eval live in the
read-only evaluation job, and write tokens live only in the reconciliation job.

## Keeping the feeds honest

```sh
node refresh/refresh.mjs --check                      # semantic diff vs live pages; exit 3 = PR-worthy
node refresh/refresh.mjs --distributor aws-bedrock,vertex-ai # distributor lifecycle clocks
node scripts/feed-changelog.mjs                       # local rendering of the hosted Atom feed
```

A parse failure stops the run. The refresh never writes a guessed feed.

This runs automatically. A weekly workflow
(`.github/workflows/feed-refresh.yml`, Mondays 05:23 UTC) checks the live
sources and opens a PR with the semantic diff, plus an updated README freshness
line, whenever something material changed. If an earlier refresh PR is still
open and no human has touched it, the run updates that PR instead of opening
another one.

The first live runs found real errors. They caught the hand-compiled feeds
drifting from Anthropic's recommendations within one week, and corrected a
hand-compiled Bedrock date that was three months wrong.

Every successful live refresh produces a byte-exact receipt. The Pages workflow
publishes the [public contract](https://thossullivan.github.io/model-eol/) only
when that receipt matches the exact feeds on `main`. A no-change check advances
`last_checked` immediately. A material-change run waits for its feed PR to
merge. The feed's `generated` date changes only when source data changes. The
hosted contract contains canonical Draft-07 schemas, feeds with SHA-256
receipts, and the Atom changelog.

The refresh also removes dates. On August 3, Google removed the October 16
earliest shutdown dates it had listed for the Gemini 2.5 Pro, Flash, and
Flash-Lite GA models. The pipeline opened
[a PR with the semantic retraction](https://github.com/thossullivan/model-eol/pull/60),
and downstream checks stopped warning about dates Google no longer listed. A
lifecycle tracker has to retract stale alarms as well as add new ones.

## The actual ask

The goal is the format, not another checker. Providers already publish
deprecation *pages* because customers asked for them. A `retirement_date` field
in the models endpoint, or this feed at a well-known URL, would let every
existing tracker read the same data. endoflife.date now tracks Claude with
nearly this field set, so the convergence has started. If you maintain one of
the community trackers, agreeing on a shared schema, this one or a better one,
is the most useful thing any of us can do here.

## Status

- Feeds refresh automatically. The weekly feed-refresh workflow is live in this
  repo. Parse failures fail the run, and material changes become a reviewed PR.
  CI runs the full suite on every push and PR. The copy-ready bot workflow ships
  as `bot.yml.example` and uses the published package, not local copies of the
  tooling.
- The [public contract](https://thossullivan.github.io/model-eol/) publishes
  canonical schemas, feeds, refresh health, a publication manifest, and Atom.
  Each deployment is bound to an exact feed-refresh receipt and verified against
  every live asset. `model-eol validate` checks feeds, repository policy, check
  reports, inventories, schedules, alerts, and plans against the same
  zero-dependency runtime contracts.
- Current-model entries, and therefore policy-floor horizons, populate only when
  the refresh runs with provider API keys for the models endpoints. Anthropic's
  tentative dates come from its public deprecations page and need no key.
- The checker matches known IDs only. It does not discover models that are
  absent from the feeds. This is deliberate: a CI gate needs precision more than
  discovery.
- Fetchers: OpenAI, Anthropic, Google, aws-bedrock, and vertex-ai are live.
  Azure dates are carried where OpenAI's own page publishes them. A standalone
  Azure lifecycle fetcher is not built yet.
- On npm as [`model-eol`](https://www.npmjs.com/package/model-eol). Material
  feed changes republish automatically as patch versions, with trusted
  publishing and provenance. Code releases require an explicit stable version.
  `npx model-eol` therefore always checks against current dates.
- Not yet: feed signing, and authenticated account-level gateway or cloud
  resolvers.

## Contributing

The most valuable contribution is a feed correction with a source URL. The one
rule is that `feeds/*.json` are generated, never hand-edited. See
[CONTRIBUTING.md](CONTRIBUTING.md) for that workflow, the zero-dependency rule,
and what a new publisher parser needs.
