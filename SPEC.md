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
| `generated` | yes | When the feed was generated, as a timestamp. See [Dates and timestamps](#dates-and-timestamps). |
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

Model dates (`announced`, `shutdown`) are calendar dates in UTC, because
publishers announce retirements by day. Only the feed's `generated` is a full
timestamp. `shutdown` must not be earlier than `announced`.

Every entry that states a date must have a `source` URL, its own or the feed's.
The reference validator rejects a dated entry with neither.

The reference validator accepts a model ID in `id`, `aliases`, `replacement`, or
`replacement_options` when it is at most 256 characters, starts with a letter or
digit, and contains only letters, digits, `.`, `_`, and `-`.

Each `id` and each alias is unique within a feed. An alias can't repeat its own
model's `id`, another model's `id`, or any other alias.

`aliases` and `replacement_options`, when present, are non-empty arrays.

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
  deprecation. A tentative entry has a `shutdown` and no `announced`, and a
  tentative distribution entry doesn't have `status: retired`. Consumers must
  not fail a build on a tentative date, and must show it as tentative. The
  reference checker reports it as `scheduled` and never fails on it.

### Replacements

`replacement` is one exact model ID that resolves to an `id` or alias in the
same feed and is safe as a plain string substitution. It is the only field the
reference `plan` and `apply` patch from. If no such ID exists, it is absent.

`replacement_options` is an ordered list of exact model IDs, in the order the
publisher gives them. Each option must pass the model ID grammar, but it need
not resolve in the feed, since the target may not be listed yet.

A model has `replacement` or `replacement_options`, never both.

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

A `via` is a non-empty string of at most 256 characters. A model may contain at
most one distribution for each `via`. Duplicate channel records are ambiguous
and fail validation. `via` values are compared exactly, so `aws-bedrock` and
`AWS-Bedrock` are two different channels. `publisher` and `publisher-fallback`
are reserved for the reference checker's own labels. A `via` is rejected when
its lower-case form, by the Unicode default lowercase mapping (JavaScript's
`toLowerCase()`), is one of those names. So `PUBLISHER` is rejected, and so is
`publisher-fallbac` followed by the Kelvin sign (U+212A), which lowercases to
`k`. `publiſher`, spelled with a long s (U+017F), is allowed, because ſ is
already lower case and stays ſ.

As for the model, a distribution's `shutdown` must not be earlier than its
`announced`, and a dated distribution entry needs a `source`: its own, the
model's, or the feed's.

A distribution entry without `shutdown` means nothing is scheduled on that
channel. It never inherits the publisher's date. Only a model with no entry for
a channel falls back to the publisher's dates. See
[Reference checker behavior](#reference-checker-behavior) for how the reference
checker reports each case.

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

`min_notice_days` is a whole number from 0 to 9007199254740991 (2^53 - 1), and
`source` is required.

For an entry with neither `announced` nor `shutdown`, this means the model won't
become unavailable before `generated` plus `min_notice_days`, as long as the
publisher follows its own policy. The policy is the publisher's statement and
can change; it is not a contractual guarantee.

Leaving `policy` out means no forward claim can be made. OpenAI publishes no
fixed notice period, so the OpenAI feed has no `policy`.

## Validation

A feed is valid when it matches the JSON Schema and follows the rules in this
document. `model-eol validate` checks both.

### Strings

No string in a feed may contain a control character, U+0000 to U+001F or U+007F
to U+009F. That includes newline and tab, so `notes`, `note`, and
`replacement_note` are a single line of text.

Lengths are counted in UTF-16 code units, the way JavaScript counts them, so a
character outside the Basic Multilingual Plane, such as an emoji, counts as two:

| Field | At most |
|---|---|
| `publisher`, `via`, and model IDs | 256 |
| `note`, `notes`, `replacement_note` | 4096 |
| every `source` URL | 4096 |
| `generated` | 64 |

### Dates and timestamps

Dates and timestamps use a profile of RFC 3339, not general ISO 8601.

- A date is `YYYY-MM-DD` and must be a real calendar day, such as
  `2026-07-25`.
- `generated` is `YYYY-MM-DDTHH:MM:SS`, optionally followed by `.` and one or
  more digits of fraction, then `Z` or an offset `+HH:MM` or `-HH:MM`. `T` and
  `Z` are upper case. Hours go up to 23, minutes and seconds up to 59. For
  example, `2026-07-25T00:00:00Z` or `2026-07-25T09:30:00.5+05:30`.

ISO 8601 also allows forms such as `2026-07-25T00:00Z` (no seconds),
`20260725T000000Z`, and `20270101`. They are not valid here.

### URLs

Every `source`, including `policy.source`, is an absolute `http` or `https`
URL, as parsed by the [WHATWG URL Standard](https://url.spec.whatwg.org/). The
scheme can be in any letter case. The URL must start with its scheme, with no
leading space.

### Rules the schema doesn't check

The JSON Schema doesn't check these rules, either because they compare one part
of a feed with another or because Draft-07 can't express them portably.
Validation code checks them, in `model-eol validate` and when the reference
tools load a feed:

- Each `id` and alias is unique within the feed. The schema catches only a
  repeated alias within one `aliases` list.
- `replacement` resolves to an `id` or alias in the same feed.
- `shutdown` is not earlier than `announced`, for models and for distribution
  entries.
- A model has at most one distribution entry for each `via`.
- A dated entry has a `source`. A model can use its own or the feed's. A
  distribution entry can use its own, the model's, or the feed's.
- `publisher` and `publisher-fallback` aren't valid `via` values, compared as
  described under [`distributions`](#distributions).
- A `source` parses as a URL under the WHATWG URL Standard. The schema checks
  only the scheme. `https://example.com/a b` is valid, because the parser
  encodes the space; `https://example.com:99999/` is not, because the port is
  out of range.
- Lengths count UTF-16 code units. JSON Schema's `maxLength` counts code points,
  so a schema validator accepts some strings of astral characters, such as
  emoji, that the code rejects.

The schema's own checks can also be looser in some validators. Patterns check
the shape of dates and timestamps, but only `format` checks that a date is a
real day, so `2026-02-30` passes a validator that skips `format`, as some do by
default. In some regular expression engines, such as Python's and Java's, `$`
also matches before a final newline, so those validators accept a value that
ends in a newline. Where a JSON Schema validator and the reference validator
disagree, the reference validator decides.

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

## Reference checker behavior

This section is not normative. It describes what the reference checker,
`model-eol check`, does with valid feeds, so other tools can match it if they
want to.

### Loading feeds

- The checker reads every `.json` file in the feeds directory. Each file must
  be strict UTF-8 with no byte order mark, and must pass validation.
- A feeds directory with no feed entries, including an empty one, stops the run
  with exit code 2.
- One invalid feed fails the whole run with exit code 2. The checker doesn't
  skip the feed and carry on.
- An `id` or alias that appears in two feed files stops the run.
- The checker is a strict consumer. It rejects fields and values that its copy
  of the schema doesn't define. The advice in [Compatibility](#compatibility)
  to ignore unknown fields is for loose readers. To read a feed that uses a
  newer addition, upgrade the checker.

### Choosing the dates

A channel can be requested with `--via`, with `via` in the config file, or with
`via` in an `overrides` or `routes` entry for some paths. For each model it
finds, the checker picks one set of dates:

- With no channel requested, it uses the publisher's own dates. A result with a
  `shutdown` is labeled `publisher`; one without has `via: null`.
- With a channel requested and a distribution entry whose `via` matches it
  exactly, it uses that entry's dates and labels the result with the channel.
  It never mixes in the publisher's dates.
- With a channel requested and no matching entry, it uses the publisher's dates
  and labels the result `publisher-fallback`, but only when the publisher has a
  `shutdown` or an `announced`. With neither, the result is `ok` with
  `via: null`.

### Statuses

The first rule that matches sets the status:

1. `retired` when the chosen distribution entry has `status: retired`, even if
   its `shutdown` is in the future.
2. `scheduled` when the date is tentative. It stays `scheduled` after the date
   has passed.
3. With a `shutdown`: `retired` once the date has passed, `retiring` when it is
   no more than `--days` days away (`days` in the config, 90 by default), and
   `scheduled` when it is further off. The shutdown day itself is `retiring`
   with 0 days left. Any
   `status` other than `retired` is ignored here, so a past `shutdown` is
   `retired` even with `status: active`.
4. With no `shutdown`: `watch` when the chosen dates include `announced`,
   otherwise `ok`.

Only `retired` and `retiring` can fail a check, and an active waiver stops
them from failing.

### Notice policy

The checker applies a feed's `policy` only when no channel is requested. A
model with neither `announced` nor `shutdown` then gets a `safe_until` of
`min_notice_days` after the UTC date of `generated`. For a tentative date,
`safe_until` is the later of the date and that floor. Distributor channels get
no policy floor, because the policy is the publisher's.

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
