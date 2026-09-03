# model-eol - a machine-readable model deprecation feed (public draft v0.1)

> Status: public draft, updated 2026-08-18. The problem: model retirement dates live in HTML docs
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
    },
    {
      "id": "gpt-5.6-sol"
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
| `replacement` | no | A single exact model ID that resolves against an id or alias in this feed and is safe as a drop-in string substitution. This is the only field plan/apply may patch from |
| `replacement_options` | no | An ordered array of exact model IDs for multiple or unresolved choices. These are issue-only and need not resolve in this feed |
| `replacement_note` | no | Free-text guidance such as parameter requirements or provider platform alternatives |
| `notes` | no | Human context: structural differences, migration gotchas |
| `distributions` | no | Per-distributor lifecycles - the same weights on different clocks (Azure, Bedrock, Vertex). Each entry: `via`, optional `announced`/`shutdown`/`status`/`date_precision`, `source` |
| `date_precision` | no | Qualifies `shutdown`: absent or `"exact"` means the stated day; `"earliest"` means the provider commits only that the event happens no sooner (Google's "earliest possible" dates). Consumers treat an earliest date as the scheduled date - it is the soonest legal death - and display it as a lower bound |

Publisher "tentative" or "not sooner than" dates for active models use `earliest`.
These entries can omit `announced` when the publisher gives no announcement date.

Dates are ISO 8601, UTC. A model with no `announced` and no `shutdown` is an
affirmative statement of "no retirement scheduled as of `generated`" - the absence
is data, which is exactly what scraping HTML can never give you.

`distributions[].status`, when present, is one of `active`, `legacy`,
`extended-access`, or `retired`. `legacy` means no new consumers but existing
usage works. `extended-access` means the distributor has announced or entered a
distinct extended-access portion of that lifecycle; it does not imply availability
after `shutdown`. On Amazon Bedrock, public extended access is a potentially
higher-priced portion of the Legacy period for active users and ends at EOL, so
`shutdown` remains the Bedrock EOL date. Bedrock still calls the encompassing
state Legacy; `extended-access` is this feed's finer-grained channel signal.
Private arrangements after EOL are not represented by this status. `retired`
means the distributor explicitly reports the model as no longer generally
available even when it does not publish an exact shutdown date.

A model may contain at most one distribution for each `via`. Duplicate channel
records are ambiguous and fail runtime semantic validation. Draft-07 can enforce
whole-object uniqueness, but cannot express uniqueness keyed by the `via` field,
so `model-eol validate` and feed loading enforce this constraint.

### Structured replacement contract

`replacement` is a single exact model ID that resolves against an id or alias in
the same feed and is safe as a drop-in string substitution. This is the ONLY
field plan/apply may patch from. Otherwise absent.

`replacement_options` is an optional array of exact model IDs. Each option must
pass the identifier grammar, but feed resolution is NOT required since a target
may not be carried yet. Options are ordered as the provider lists them.

`replacement_note` is optional free-text guidance. It can carry parameter
requirements such as `reasoning.mode: pro` or prose alternatives such as Google's
platform pointers.

Replacement options and notes are issue-only. The planner never auto-patches
from options; it patches `replacement` exclusively.

### Policy floors

A feed MAY include a publisher's stated minimum deprecation notice period:

```json
"policy": {
  "min_notice_days": 60,
  "source": "https://platform.claude.com/docs/en/about-claude/model-deprecations"
}
```

For an entry with neither `announced` nor `shutdown`, a policy floor means the
entry cannot become unavailable before `generated` + `min_notice_days` days,
provided the provider honors its stated policy. This is a stated policy, not a
contract or a guarantee that the provider will remain available.

The `policy` field is optional. Its absence means no forward claim can be made,
intentionally. OpenAI publishes no formal notice floor, so the OpenAI feed carries
no `policy` field.

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

Repository tools that export CycloneDX SHOULD represent a canonical model once
per lifecycle channel, with a deterministic channel-qualified `bom-ref`. This
keeps direct publisher and distributor clocks distinct and binds each source
occurrence to the lifecycle decision that evaluated it.

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
