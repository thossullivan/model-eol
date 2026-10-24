# model-eol

![npm](https://img.shields.io/npm/v/model-eol)
[![marketplace](https://img.shields.io/badge/marketplace-model--eol%20check-blue?logo=github)](https://github.com/marketplace/actions/model-eol-check)
![CI](https://github.com/thossullivan/model-eol/actions/workflows/ci.yml/badge.svg)
[![feed refresh](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml/badge.svg)](https://github.com/thossullivan/model-eol/actions/workflows/feed-refresh.yml)
![spec](https://img.shields.io/badge/spec-model--eol%2F0.1-blue)
![deps](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

model-eol finds AI model IDs in your code and tells you which ones are retired
or about to be. It runs as a CLI, a GitHub Action, and a scheduled bot that
opens migration PRs. The retirement dates come from feeds in an open format
([`SPEC.md`](SPEC.md)) that any tool can read.

![Terminal recording: model-eol reports retired models, the same repo under Amazon Bedrock's dates, and the earliest retirement date](docs/img/demo.gif)

## Why this exists

On July 23, 2026, OpenAI shut down a batch of model snapshots, and one of my
research workflows started failing with model-not-found errors. The shutdown
had been announced three months earlier. I missed it because nothing in my
toolchain knew which models I used.

Package dependencies don't have this problem. npm prints a warning when a
package is deprecated, and Dependabot opens a PR. A model's retirement date sits
on a provider's docs page and in an email to whoever owns the account.

Ordinary software has shared data for this: endoflife.date for end-of-life
dates and OSV for vulnerabilities. model-eol is an attempt at the same thing for
models. The feed format came first, and the tooling is a reference consumer of
it.

## Quick start

It runs with `npx`, needs Node 22 or later, and needs no API key or account:

```sh
npx model-eol path/to/your/repo --days 90
```

Output looks like this:

```
✗ app.py:2  o3-deep-research  RETIRED 2026-07-23 (92 days ago) -> gpt-5.6-sol  [still answers via azure-ai-foundry until 2026-11-19]
✗ app.py:3  claude-opus-4-1-20250805  RETIRED 2026-08-05 (79 days ago) -> claude-opus-4-8  [still answers via aws-bedrock until 2027-01-08]
· app.py:4  gpt-5.6-sol  no retirement scheduled

model-eol: 2 finding(s) at or past the 90-day threshold
```

`✗` is retired, `!` retires within the `--days` threshold, `·` doesn't retire
within the threshold, and `?` means a retirement is announced but has no date
yet. A model can retire on one channel (the publisher's own API,
or a distributor such as Amazon Bedrock, Azure AI Foundry, or Vertex AI) and
keep answering on another, so the line says where and until when.

The exit code is 0 when the repo is clean, 1 when any finding is retired or
inside the threshold, and 2 for usage, feed, or scan errors, so you can use the
command directly as a CI step. A clean run that can't write its output exits 3.

When something fails, `plan` and `apply` make the safe edits for you:

```sh
npx model-eol plan path/to/your/repo --days 90 > plan.json
npx model-eol apply --plan plan.json --dry-run
```

There is nothing to install, so a clone runs the same way:

```sh
git clone https://github.com/thossullivan/model-eol && cd model-eol
node check.mjs path/to/your/repo --days 90
```

Feed coverage: <!-- feeds-status -->Amazon (4 entries), Anthropic (36 entries), Cohere (12 entries), Google (101 entries), Mistral (43 entries) and OpenAI (205 entries), generated from the providers' live deprecation pages plus the AWS Bedrock, Google Vertex AI, and Azure Foundry lifecycle pages, feed data generated 2026-10-24<!-- /feeds-status -->.

## Commands

| Command | What it does |
|---|---|
| `check` (default) | Fails on retired and retiring models. `--changed origin/main` reports only what a change adds. |
| `inventory` | Lists every model reference. `--format cyclonedx` writes a CycloneDX 1.6 ML-BOM with one component per model and channel. |
| `schedule` | Lists retirement dates and the earliest one in the repo. |
| `alert` | Writes GitHub annotations (`--format github`), Markdown, or a [shields.io endpoint](https://shields.io/endpoint) badge. |
| `plan` / `apply` | Builds a migration plan and applies it. `apply --dry-run` previews the edits. |
| `validate` | Checks a feed, a `.model-eol.json`, or any model-eol report against its schema. |
| `verify` | Checks a receipt's claims against files you supply. See [docs/RECEIPTS.md](docs/RECEIPTS.md). |

The flags you'll use most are `--json`, `--days N`, `--scope all|direct`, and
`--via DISTRIBUTOR`. `npx model-eol --help` lists which command takes which.

`plan` proposes only plain string swaps. The reference must be a direct API
call the scanner is sure about, and the feed must name a replacement that is
itself safe. Other retired or retiring references are left for manual review,
and the bot files those as issues.

Feed updates ship as patch releases, so `npx model-eol` and the `@v0` Action
tag pick up new dates with each release (see [docs/FEEDS.md](docs/FEEDS.md) for
when releases happen). Pinning an exact version, such as `npx model-eol@0.10.2`
or `thossullivan/model-eol@v0.10.2`, also pins the feeds to that release.

## GitHub Action

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

This is the PR gate. It fails when the change adds a reference to a retired or
retiring model. It also fails when the change makes an existing reference bad,
for example by editing `.model-eol.json`, renaming a file, or adding SDK code
next to an old model ID. References that were already bad on the base branch
don't fail the PR; the weekly full scan in the example workflow catches those.

[`examples/workflows/model-eol.yml`](examples/workflows/model-eol.yml) has both
jobs ready to copy. The Action also runs `inventory`, `schedule`, `alert`,
`plan`, and `validate`. Set `via: aws-bedrock` to use a distributor's dates,
`format: cyclonedx` for an ML-BOM, and `output-file` to save a report as a
workflow artifact.

## Configuration

The CLI, the Action, and the bot all read `.model-eol.json` from the root of the
repository:

```json
{
  "days": 90,
  "scope": "direct",
  "ignore": { "paths": ["test/fixtures/**", "data/catalog"] },
  "waivers": [
    {
      "model": "gpt-4",
      "paths": ["services/legacy/**"],
      "reason": "Vendor contract pins this model until the Q1 migration.",
      "owner": "@platform-team",
      "expires": "2026-12-31"
    }
  ]
}
```

`ignore` drops files and models that aren't live dependencies, such as fixtures
and vendored catalogs. A waiver keeps the finding in every report, with its
owner and expiry, but stops it failing CI until the expiry date. Monorepos can
set different thresholds and channels per path. Unknown keys are errors.

Adding a config file changes one default. Without one, the CLI also fails on
cloud and gateway references (`scope: all`). With one, any key you leave out
takes the bot's defaults: 90 days, `scope: direct`, and the publisher's dates.

[docs/CONFIGURATION.md](docs/CONFIGURATION.md) covers every key, monorepo
overrides and routes, and what the scanner reads and skips.

## How retirement dates work

### One model, several dates

A model can retire on different dates depending on where you call it.
`claude-opus-4-1` retired on Anthropic's API on August 5, 2026, but Amazon
Bedrock serves it until January 8, 2027. `o3-deep-research` left OpenAI's API on
July 23 and stays on Azure AI Foundry until November 19.

The feed records each channel's date under `distributions`. Pass
`--via aws-bedrock`, `--via azure-ai-foundry`, or `--via vertex-ai` to check the
repo against the channel it actually calls. If the feed has no entry for that
channel, the checker uses the publisher's date and labels the line
`publisher-fallback`.

The later date buys time for the migration, and it is also the last chance to
record the old model's outputs if your eval compares against them. When a
retired or retiring model still answers on another channel, `check` adds
`[still answers via CHANNEL until DATE]`, and the bot writes a "Capture window"
section in its PRs and issues. [docs/DESIGN_EVAL_BOUNDARY.md](docs/DESIGN_EVAL_BOUNDARY.md)
explains why model-eol reports this window but never runs the capture.

### Tentative dates and notice policies

Anthropic lists a "not sooner than" retirement date for every active model.
The feed records these with `date_precision: "tentative"` and no `announced`
date. The checker shows them in schedules so you can plan ahead, but a tentative
date never fails CI and the bot opens nothing for it:

```
· not sooner than 2026-10-15  app.py:1  claude-haiku-4-5-20251001  scheduled - tentative, not announced: not sooner than 2026-10-15, guaranteed until 2026-12-17 by anthropic policy  [model-reference]  [safe until 2026-12-17]
```

The "guaranteed until" part comes from the publisher's stated minimum notice
period, which the feed carries as `policy`. Anthropic states 60 days, so the
date is the feed's `generated` date plus 60 days. Anthropic can change that
policy, and the line reports it as stated. OpenAI states no fixed notice
period, so its feed has no `policy`.

Google's "earliest possible" shutdown dates are real announcements. The feed
marks them `earliest`, and the checker uses them as the shutdown date, so they
can fail CI.

To list only announced retirements:

```sh
npx model-eol schedule path/to/your/repo --json \
  | jq '.items |= map(select(.date_precision != "tentative"))'
```

### Direct calls versus clouds and gateways

When code calls OpenAI, Anthropic, Gemini, or another publisher SDK with a real
model ID, the scanner can check it. Azure AI Foundry, Bedrock, Vertex AI,
OpenRouter, LiteLLM, and Portkey often hide the model behind a deployment name
or a route alias, and static analysis can't see what is deployed behind
`chat-prod`. Those references appear in `inventory` and `schedule` as `?`
lines:

```
? src/ai.ts:12  azure-ai-foundry  Azure Foundry/OpenAI deployment reference  (needs provider/gateway resolver)
? src/ai.ts:30  openrouter  OpenRouter gateway reference  (needs provider/gateway resolver)
```

`--scope direct` fails CI only on references the scanner can prove. The bot
still opens one issue for each cloud or gateway provider it finds, so someone
checks which model is behind it. If you know, a `routes` entry in the config
maps an alias to a model. A routed reference still counts as cloud or gateway
usage, so it fails CI only where `scope` is `all`. Strings that look like model
IDs but aren't in any feed are listed as candidates and never fail.

## The bot

The bot is a scheduled workflow that keeps one PR open per retiring model, with
the dates, sources, and replacement in the PR body. It never merges. Findings it
can't patch safely, and cloud or gateway references it can't resolve, become
issues. Closing a PR without merging dismisses that
retirement, and the bot won't reopen it unless the shutdown date or the
replacement changes.

To set it up, copy [`bot.yml.example`](bot.yml.example) to
`.github/workflows/model-eol-bot.yml`. To see what it would do first, run this
in your repository:

```sh
npx --yes --package=model-eol@0 model-eol-bot --dry-run --target-dir . --repo OWNER/REPO
```

A model swap can change behavior, so the bot can run a test command of yours on
each migration before it opens the PR. That command runs in a job with no write
access, and the job that writes to GitHub never runs your code.
[docs/BOT.md](docs/BOT.md) covers the eval hook, tokens, and the security model.

## Where the data comes from

The publisher feeds are generated from each publisher's deprecation page and
model listings, plus the Amazon Bedrock, Vertex AI, and Azure AI Foundry
lifecycle pages, and each dated entry links to the page it came from. The
files are not edited by hand. (`amazon.json` is the exception: its entries are
carried forward, and only their Bedrock dates are refreshed.)

A weekly workflow regenerates the feeds and opens a PR whenever something
material changes, with a semantic diff of dates that moved, models that were
added, and replacements that changed. Withdrawn dates are removed too
([example](https://github.com/thossullivan/model-eol/pull/60)).

The feeds, the schemas, and an Atom changelog are published at
[thossullivan.github.io/model-eol](https://thossullivan.github.io/model-eol/).
[docs/FEEDS.md](docs/FEEDS.md) describes the refresh and publication pipeline.

## For providers and tracker maintainers

What I'd most like is for providers to publish this data themselves: a
`retirement_date` field in the models endpoint, or a feed at
`/.well-known/model-eol.json`. [`SPEC.md`](SPEC.md) is short enough to implement
in an afternoon. endoflife.date already tracks Claude with nearly the same
fields. If you maintain a model tracker, I'd rather we agree on one schema, this
one or a better one, than keep scraping the same pages separately.

## Limits

- The checker only knows the models in the feeds. A model missing from every
  feed can't fail CI until a feed adds it.
- model-eol doesn't query cloud accounts or gateways to find out which model is
  deployed; that is out of scope
  ([#79](https://github.com/thossullivan/model-eol/issues/79)). Those
  references stay in the inventory, and `routes` can map known aliases.
- xAI publishes no lifecycle index and its models API has no deprecation fields,
  so there is no xAI feed.
- New current models (entries with nothing scheduled) come from the OpenAI,
  Google, Mistral, and Cohere models endpoints, so the refresh adds them only
  when it has API keys. Without keys it keeps the entries already in the feeds.
- Feeds are not signed yet.

## Contributing

The most useful contribution is a feed correction with a source URL. Feed files
are generated, so a correction usually means fixing a parser.
[CONTRIBUTING.md](CONTRIBUTING.md) has the details.
