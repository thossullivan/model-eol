# model-eol - a machine-readable model deprecation feed (draft spec v0.1)

> Status: sketch, 2026-07-25. The problem: model retirement dates live in HTML docs
> and emails, so every deprecation checker is a scraper with a private registry
> format. Ordinary software solved this layer - endoflife.date for EOL data, OSV for
> vulnerability feeds. This is the model version: small enough that a provider could
> ship it in an afternoon, useful enough that scrapers converge on it in the meantime.

## The format

A feed is a JSON document: metadata + a list of model entries.

```json
{
  "spec": "model-eol/0.1",
  "publisher": "openai",
  "generated": "2026-07-25T00:00:00Z",
  "source": "https://developers.openai.com/api/docs/deprecations",
  "models": [
    {
      "id": "o3-deep-research-2025-06-26",
      "aliases": ["o3-deep-research"],
      "announced": "2026-04-22",
      "shutdown": "2026-07-23",
      "replacement": "gpt-5.6-sol",
      "notes": "Deep-research post-trained agent; replacement is a general model + tools, not a structural successor.",
      "distributions": [
        { "via": "azure-ai-foundry", "shutdown": "2026-12-26",
          "source": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-retirements" }
      ]
    }
  ]
}
```

### Fields

| Field | Req | Meaning |
|---|---|---|
| `id` | yes | The exact model identifier as sent over the wire (dated snapshot preferred) |
| `aliases` | no | Other strings that resolve to this model (undated aliases, marketing names) |
| `announced` | no | Date the deprecation was announced (absent = not deprecated) |
| `shutdown` | no | Date calls stop working on the publisher's own API (absent = none scheduled) |
| `replacement` | no | The currently recommended migration target. **Treat as a snapshot in time, not a constant** - this field has changed mid-window in the wild |
| `notes` | no | Human context: structural differences, migration gotchas |
| `distributions` | no | Per-distributor lifecycles - the same weights on different clocks (Azure, Bedrock, Vertex). Each entry: `via`, optional `announced`/`shutdown`/`status`, `source` |

Dates are ISO 8601, UTC. A model with no `announced` and no `shutdown` is an
affirmative statement of "no retirement scheduled as of `generated`" - the absence
is data, which is exactly what scraping HTML can never give you.

### Why `distributions` is in the core and not an extension

The July 2026 evidence: OpenAI shut off `o3-deep-research` on July 23; Azure lists it
retiring December 26. Anthropic retired Claude 3.7 Sonnet on February 19; Bedrock
kept it to April 28. The same BOM entry has different sourcing terms per channel, and
a checker that doesn't know that will tell an Azure shop their model is dead five
months early - or tell an OpenAI-direct shop they're fine because Azure says so.

## Serving it

- **Providers** (the ask): serve the feed at `/.well-known/model-eol.json`, or add
  `announced`/`shutdown`/`replacement` to the existing models endpoint. Either kills
  the scraping industry overnight.
- **Aggregators** (the interim): community datasets re-publish provider pages in this
  format, with `source` on every entry so claims are auditable. Multiple feeds
  compose - a checker loads provider feeds where they exist and community feeds where
  they don't.
- **Consumers**: anything that can read JSON - a CI step, a dashboard, a Dependabot
  clone that opens migration PRs when `shutdown - today < threshold`.

## Non-goals (v0.1)

Pricing, capabilities, context windows (models.dev and friends already do this);
behavior-change tracking (that's an eval suite's job, not a manifest's); signing and
provenance (worth doing the moment anyone depends on this; premature today).

## Prior art, gratefully

endoflife.date (the shape of the solution), OSV (proof that a shared schema turns N
scrapers into an ecosystem), CycloneDX ML-BOM / SPDX AI profile (where an `eol` field
belongs once feeds exist), and the current scrapers - llm-model-deprecation,
llmstatus.ai, llm-info, ai-model-watch-data, modelradar-data - which are the demand
signal this spec is trying to give a common target.
