# model-eol

**A machine-readable deprecation feed format for AI models, plus the smallest useful
checker that consumes it.** Draft sketch, 2026-07-25.

## The problem

On July 23, 2026, OpenAI shut down 18 models on schedule. Teams that pinned dated
snapshots - the provider's own recommended practice - got production 404s, because a
model ID is the one dependency your toolchain can't see. When an npm package is
deprecated, the warning prints at install, Dependabot opens the PR, the advisory
fails CI. A model's retirement date lives in an HTML docs page and an email.

Community tools exist (llm-model-deprecation, llmstatus.ai, llm-info,
ai-model-watch-data, modelradar-data) and they're the right instinct - but every one
is a scraper with its own private registry format, and none models per-distributor
lifecycles, which the July evidence shows is load-bearing: o3-deep-research died at
OpenAI on July 23 and lives on Azure until December 26. Same weights, different
clocks.

Ordinary software solved this layer: endoflife.date for EOL data, OSV for
vulnerability feeds. This is the model version.

## What's here

- **`SPEC.md`** - the feed format (model-eol/0.1): id, aliases, announced, shutdown,
  replacement, and `distributions` for per-channel lifecycles. Small enough that a
  provider could serve it at `/.well-known/model-eol.json` in an afternoon.
- **`feeds/`** - seed datasets for OpenAI and Anthropic, compiled 2026-07-25 from the
  providers' deprecation pages, every entry with a source URL. Illustrative; verify
  before acting.
- **`check.mjs`** - zero-dependency reference checker (~170 lines of Node). Scans
  code/config for tracked model IDs and fails CI when one is retired or retiring
  within the threshold.

## Try it

```sh
node check.mjs path/to/your/repo --days 90
# distributor-aware: the same repo, judged by Azure's clock instead of OpenAI's
node check.mjs path/to/your/repo --days 90 --via azure-ai-foundry
# machine-readable output for CI annotations
node check.mjs . --json
```

Sample output against a fixture:

```
✗ app.py:1  o3-deep-research          RETIRED 2026-07-23 (2 days ago) -> gpt-5.6-sol
! app.py:2  claude-opus-4-1-20250805  RETIRES 2026-08-05 (11 days) -> claude-opus-4-6
· app.py:3  gpt-5.6-sol               no retirement scheduled
```

Exit 1 on findings at or past the threshold - wire it into CI as-is.

## The actual ask

This repo is a sketch, not a product. The endgame is not "another checker"; it's the
format. Providers already publish deprecation *pages* because customers asked. A
`retirement_date` field in the models endpoint, or this feed at a well-known URL,
turns every scraper above into an ecosystem and makes a Dependabot-for-models a
weekend project. If you maintain one of the existing tools: converging on a shared
schema - this one or a better one - is the highest-leverage move any of us can make
here.

## Status / honesty

- Feeds are hand-compiled from provider pages on one day; they will rot without a
  refresh mechanism (the fix is the whole point of the spec).
- The checker matches known IDs only - it will not discover models absent from the
  feeds. That's deliberate: precision over discovery for a CI gate.
- Not yet: signing, a published JSON Schema, provider coverage beyond
  OpenAI/Anthropic (Google/Bedrock/Vertex entries welcome), automation to
  re-generate feeds.
