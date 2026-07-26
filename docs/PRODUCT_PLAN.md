# Product plan - direct-first model retirement inventory

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
node check.mjs . --days 90 --via azure-ai-foundry
```

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

Useful first targets:

- GitHub issue per repo/service owner.
- Slack/Teams message for findings inside a configured window.
- CI artifact containing `model-inventory.json`.

For direct-first workflows, use `--scope direct` so cloud/gateway references remain
inventory hints until a resolver can prove the exact deployed model. The historical
`check` behavior remains available as `--scope all`.
