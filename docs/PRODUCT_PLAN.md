# Product plan - direct-first model retirement inventory

*Status 2026-08-01: the MVP scope below shipped in v0.1.0, plus the bot adapter,
refresh automation, and the aws-bedrock distributor fetcher (feed-side clocks
from AWS's lifecycle page - account-level deployment resolvers remain future
work as described under "Next resolvers"). Current state lives in
docs/CONTEXT.md.*

## Thesis

The first useful product is not "one more CI check." It is a direct LLM dependency
inventory that can also fail CI when a visible model ID is near retirement.

Provider clouds and gateways usually have their own lifecycle surfaces, but those
signals often land with account admins or platform owners, not the repo owner. Static
repo scanning should not pretend it can resolve deployment aliases like `chat-prod`
or gateway routes like `smart-chat`. It should record them and hand them to resolvers.

## MVP scope

1. Direct API references are actionable.
   - Find tracked model IDs in code/config.
   - Classify nearby SDK/API signals such as OpenAI, Anthropic, Gemini, Mistral,
     Cohere, and xAI.
   - Fail CI only for tracked model IDs that are retired or inside the warning
     threshold.

2. Cloud and gateway references are inventory hints.
   - Detect Azure Foundry/OpenAI, Amazon Bedrock, Vertex AI, OpenRouter, LiteLLM,
     Portkey, and generic AI gateway signals.
   - Mark them as unresolved because static code usually only shows deployment names,
     env vars, provider paths, or aliases.
   - Keep them in `inventory` and `schedule` output so teams know where provider or
     gateway resolvers would add value.

3. Lifecycle data stays feed-first.
   - `feeds/` remains the source of truth for shutdown dates, replacements, aliases,
     and per-distributor clocks.
   - The scanner consumes feeds; it does not scrape provider pages at runtime.

## Commands

```sh
node check.mjs . --days 90
node check.mjs . --days 90 --scope direct
node check.mjs inventory . --json
node check.mjs schedule . --days 90
node check.mjs alert . --days 90 --scope direct
node check.mjs . --days 90 --via azure-ai-foundry
```

## Mixed repositories and generated code

Repository-level `days`, `scope`, and `via` values are defaults. A monorepo can
refine them with path-scoped `overrides` and route each reference through the
clock that actually serves it:

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

Path globs are repository-relative and support `*`, `**`, and `?`. Matching
overrides apply in array order: later scalar values win, while `ignore.models`
and `ignore.paths` remain additive. The last matching route wins. A route with
an exact `match` and canonical feed `model` turns a known deployment alias into
a tracked, non-direct reference without pretending it is safe to patch. Explicit
CLI flags still override repository and path policy. Machine reports carry the
effective threshold, scope, requested channel, and matching rule indexes when a
path rule or route changed behavior.

The scanner reads `.baml` source but skips conservative generated-code headers,
BAML-generated clients, and model-eol inventory/schedule/alert/plan artifacts.
CycloneDX is skipped only when its metadata carries model-eol generator
provenance, so third-party BOMs stay visible. Intentional artifact skips are
diagnostics, not incomplete-coverage warnings.

## Next resolvers

Add optional resolvers only when they can return exact deployed model/version data:

- Azure Foundry: resolve deployment name -> model/version/update policy.
- Amazon Bedrock: resolve model ID and lifecycle from Bedrock API/account context.
- Vertex AI: resolve endpoints, publisher model names, and lifecycle pages.
- Gateways: resolve route alias -> provider/model from config or gateway API.

Resolvers should enrich inventory output; they should not be required for the direct
API checker to work.

## Alerting

Alerting should consume `schedule --json`, not duplicate scanner logic.

The first built-in alert target is `node check.mjs alert`, which can emit GitHub
Actions annotations or Markdown. Anything stateful, such as opening GitHub issues or
sending Slack messages, should consume `alert --json` or `schedule --json`.

Useful first targets:

- GitHub Actions annotations for PR/build feedback.
- Markdown summary artifact for humans.
- GitHub issue per repo/service owner.
- Slack/Teams message for findings inside a configured window.
- CI artifact containing `model-inventory.json`.

For direct-first workflows, use `--scope direct` so cloud/gateway references remain
inventory hints until a resolver can prove the exact deployed model. The historical
`check` behavior remains available as `--scope all`.
