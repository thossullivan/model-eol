# model-eol feed format, version 0.1

Status: public draft.

Model retirement dates are published as HTML pages and emails, so every tool
that tracks them scrapes those pages into its own private format. This document
defines a small JSON format for the same data. A publisher could serve it
directly; until then, aggregators can publish it on a publisher's behalf.

## Terms

- **Publisher**: the company that makes a model and serves it on its own API,
  such as OpenAI or Anthropic.
- **Distributor**: a cloud platform that serves another publisher's models,
  such as Amazon Bedrock, Azure AI Foundry, or Vertex AI.
- **Channel**: either of those, as a place a model can be called. The
  publisher's own API is one channel, and each distributor is another. A
  distributor channel is named by its `via` value.

## Example

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
        { "via": "azure-ai-foundry", "shutdown": "2026-11-19",
          "source": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule" }
      ]
    },
    {
      "id": "gpt-5.6-sol"
    }
  ]
}
```

A feed is a JSON object with metadata and a `models` array. The JSON Schema is
[`schema/model-eol.schema.json`](schema/model-eol.schema.json).

## Feed fields

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | `"model-eol/0.1"`. |
| `publisher` | yes | The publisher this feed describes, for example `openai`. |
| `generated` | yes | When the feed was generated, as an ISO 8601 timestamp. |
| `source` | no | URL for the feed's claims. Entries can override it with their own `source`. |
| `note` | no | Free text about the feed as a whole. |
| `policy` | no | The publisher's stated notice period. See [Notice policy](#notice-policy). |
| `models` | yes | The model entries. |

## Model fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The exact model identifier sent over the wire. A dated snapshot is preferred. |
| `aliases` | no | Other strings that resolve to this model, such as undated aliases. |
| `announced` | no | The date the deprecation was announced. Absent means not deprecated. |
| `shutdown` | no | The date calls stop working on the publisher's own API. Absent means none scheduled. |
| `date_precision` | no | How to read `shutdown`. See below. |
| `replacement` | no | One exact model ID that is a safe drop-in string substitution. See below. |
| `replacement_options` | no | An ordered list of exact model IDs when there is more than one choice, or when the choice isn't in this feed. |
| `replacement_note` | no | Free-text migration guidance. |
| `notes` | no | Context for people: structural differences, migration pitfalls. |
| `distributions` | no | Lifecycles on other channels (Azure, Bedrock, Vertex). See below. |
| `source` | no | URL for this entry's claims, when it differs from the feed's `source`. |

Model dates (`announced`, `shutdown`) are ISO 8601 calendar dates in UTC,
because publishers announce retirements by day. Only the feed's `generated` is a
full timestamp.

Every entry that states a date must have a `source` URL, its own or the feed's.
The reference validator rejects a dated entry with neither.

The reference validator accepts a model ID in `id`, `aliases`, `replacement`, or
`replacement_options` when it is at most 256 characters, starts with a letter or
digit, and contains only letters, digits, `.`, `_`, and `-`.

### No dates means nothing scheduled

An entry with neither `announced` nor `shutdown` states that no retirement was
scheduled as of `generated`. A scraper can't make that statement, because a
model missing from a deprecations page might simply be missing from the page. A
publisher serving its own feed can.

### `date_precision`

- Absent or `"exact"`: `shutdown` is the stated day.
- `"earliest"`: a scheduled shutdown that can't move earlier, but may happen
  later. The reference checker uses it as the shutdown date, so it can fail CI.
- `"tentative"`: the publisher lists a not-before date without announcing a
  deprecation. Tentative entries carry no `announced`. Consumers must not treat
  their dates as scheduled retirements. The reference checker reports them as
  `scheduled` and never fails on them.

### Replacements

`replacement` is one exact model ID that resolves to an `id` or alias in the
same feed and is safe as a plain string substitution. It is the only field the
reference `plan` and `apply` patch from. If no such ID exists, it is absent.

`replacement_options` is an ordered list of exact model IDs, in the order the
publisher gives them. Each option must pass the model ID grammar, but it need
not resolve in the feed, since the target may not be listed yet.

`replacement_note` carries guidance that isn't an ID, such as a required
parameter (`reasoning.mode: pro`) or a pointer to another platform.

Replacement options and notes are for issues only. The reference planner never
patches from them; it patches from `replacement` alone.

OpenAI changed the recommended replacement for its deep-research models during
their notice period. Consumers should read `replacement` again on each run
rather than cache it.

### `distributions`

The same model weights can retire on different dates on different channels.
OpenAI shut off `o3-deep-research` on 2026-07-23, while Azure AI Foundry
kept it for months longer. A checker that ignores channels tells an Azure user
their model is gone too early, or tells an OpenAI user they're fine because
Azure still serves it.

Each distribution entry has:

| Field | Required | Meaning |
|---|---|---|
| `via` | yes | The channel, for example `aws-bedrock`, `azure-ai-foundry`, or `vertex-ai`. |
| `announced` | no | As for the model. |
| `shutdown` | no | The date the channel stops serving the model. |
| `date_precision` | no | As for the model. |
| `status` | no | `active`, `legacy`, `extended-access`, or `retired`. |
| `source` | no | URL for the channel's claim. |

A model may contain at most one distribution for each `via`. Duplicate channel
records are ambiguous and fail validation. JSON Schema can't express uniqueness
by one field, so `model-eol validate` and feed loading enforce it in code.

How the reference checker reads distribution entries: an entry without
`shutdown` means nothing is scheduled on that channel and never inherits the
publisher's date, unless its `status` is `retired` (reported as retired) or it
has `announced` without a date (reported as `watch`). When a model has no entry
for the requested channel, the checker uses the publisher's date and labels the
result `publisher-fallback`.

`status` values:

- `active`: generally available.
- `legacy`: no new customers, but existing use keeps working.
- `extended-access`: the distributor has announced or entered a separate
  extended-access part of the lifecycle. It does not mean the model is
  available after `shutdown`.
- `retired`: the distributor says the model is no longer generally available,
  even if it published no exact date.

Notes on current distributors:

- On Amazon Bedrock, public extended access is a possibly higher-priced part of
  the Legacy period and ends at end of life, so `shutdown` stays the Bedrock
  end-of-life date. Bedrock still calls the whole state Legacy;
  `extended-access` is this feed's finer-grained signal. Private arrangements
  after end of life are not represented. "EOL no sooner than" dates from Bedrock
  model cards are recorded as `tentative`.
- Azure's GA, Preview, and Legacy map to `active`, Deprecated to `legacy`, and
  Retired to `retired`. Azure's Legacy still allows new deployments.

## Notice policy

A feed MAY state the publisher's minimum notice period:

```json
"policy": {
  "min_notice_days": 60,
  "source": "https://platform.claude.com/docs/en/about-claude/model-deprecations"
}
```

For an entry with neither `announced` nor `shutdown`, this means the model won't
become unavailable before `generated` plus `min_notice_days`, as long as the
publisher follows its own policy. The policy is the publisher's statement and
can change; it is not a contractual guarantee.

Leaving `policy` out means no forward claim can be made. OpenAI publishes no
fixed notice period, so the OpenAI feed has no `policy`.

## Serving a feed

A publisher can serve its feed at `/.well-known/model-eol.json`, or add
`announced`, `shutdown`, and `replacement` to its models endpoint.

Until publishers do, aggregators can publish feeds on their behalf, with a
`source` on every claim so it can be audited. A consumer can load a publisher's
own feed where one exists and a community feed where it doesn't.

Tools that export CycloneDX SHOULD write one component per model per channel,
with a deterministic `bom-ref` that includes the channel. That keeps the
publisher's dates and each distributor's dates separate, and ties each
occurrence in the code to the date it was checked against.

## Compatibility

The `model-eol/0.1` line changes only by addition. New optional fields and new
enum values (such as `date_precision: "tentative"`, added in September 2026)
can appear without a version change. A consumer that validates strictly against
a copy of the schemas should refresh that copy when it upgrades. A consumer
that reads loosely should ignore fields and values it doesn't recognize.
Removing a field or changing what an existing value means requires a new
version.

## Out of scope for 0.1

- Pricing, capabilities, and context windows. models.dev and similar projects
  already cover these.
- Behavior changes between model versions. See
  [docs/DESIGN_EVAL_BOUNDARY.md](docs/DESIGN_EVAL_BOUNDARY.md).
- Signing and provenance. These become worth doing once people depend on the
  feeds, which is premature today.

## Prior art

- [endoflife.date](https://endoflife.date/): end-of-life data for software
  products, and the model for this project's shape.
- [OSV](https://osv.dev/): a shared vulnerability schema that let many
  scrapers become one ecosystem.
- CycloneDX ML-BOM and the SPDX AI profile, which are where an end-of-life
  field belongs once feeds exist.
- Existing deprecation trackers: llm-model-deprecation, llmstatus.ai,
  llm-info, ai-model-watch-data, and modelradar-data. They show the demand, and
  this format is meant to give them a common target.
