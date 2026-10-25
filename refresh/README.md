# refresh

This directory regenerates `feeds/*.json` from provider pages, models
endpoints, and distributor lifecycle pages. For what the feeds contain and how
the weekly workflow uses this code, see [docs/FEEDS.md](../docs/FEEDS.md).

| File | Role |
|---|---|
| `refresh.mjs` | Entry point. Fetches, parses, merges, writes, and prints the semantic diff. |
| `providers.mjs` | Publisher parsers: OpenAI, Anthropic, Google, Mistral, Cohere. |
| `distributors.mjs` | Distributor parsers: Bedrock, Vertex AI, Azure AI Foundry. |
| `fetch.mjs` | Bounded HTTP fetches (30-second deadline, 8 MiB limit) for Anthropic model pages and distributor pages. It re-exports `lib/fetch-bounded.mjs`, which the bot's `--feeds-url` download also uses. |
| `diff.mjs` | The semantic diff used for `--check` and for refresh PR bodies. |
| `test/` | Offline tests and recorded pages under `test/fixture/`. |

## The rule every parser follows

A parser that isn't sure must stop the run. It never returns a partial or
best-guess result, so the refresh either writes a complete, validated feed or
nothing:

- Every model ID that enters a feed passes the identifier grammar.
- Conflicting records for one model stop the run, unless a precedence rule
  below says which source wins.
- A row that would merge, through an alias, with an entry that an earlier row
  of the same run created or dated stops the run if the two lifecycles differ.
  Rows with the same lifecycle still merge into one entry, except OpenAI dated
  snapshots (below).
- A page on which no lifecycle table is recognized stops the run.
- A missing fixture page stops an offline run. It is never treated as empty.

A few rows are skipped rather than stopping the run, and the sections below
say which: OpenAI endpoint and product rows, Gemini cells without a usable ID,
and Vertex IDs with whitespace. A Cohere section with only prose yields nothing
without stopping.

How strictly tables are identified also differs. Mistral, Cohere, the Bedrock
model cards, and Azure check lifecycle headers exactly and stop on drift.
OpenAI, the Gemini API, the Bedrock legacy table, and Vertex AI find columns by
label patterns: tables without a matching header are skipped, and extra columns
are accepted.

Every fetch has a 30-second deadline over the request and body, and an 8 MiB
body limit (`fetch.mjs`). Requests that carry an API key (the models endpoints)
refuse redirects, so a key never follows a redirect to another origin; page
fetches follow redirects. Error messages include at most 300 characters of the
error body on one line, with request header values redacted. Paged models
endpoints stop the run if they still have more pages after 20; Mistral's is
read in one request.

A change that makes a parser accept more input has to show that the new input
can't produce a row bound to the wrong model. Add a fixture that would have
produced a misaligned row and assert that it is refused.

## Anthropic

The refresh reads the Anthropic model deprecations page for dates and the
model overview pages for IDs and aliases.

- Dates come only from the
  [model deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations).
  Its "not sooner than" dates for active models become `tentative` shutdowns.
- Model IDs and aliases come from the overview pages listed in
  `https://platform.claude.com/docs/llms.txt`. Only `Claude API` and
  `Claude API alias` rows are imported. Those pages supply no dates.
- The index may list at most 100 unique pages. Each fetch has a 30-second
  deadline and an 8 MiB limit.
- When an alias is attached to a model or moves to another one, the run emits a
  notice and the change appears in the semantic diff.
- A status row and an announcement for the same model must agree. An Active
  status row, or a different deprecated or retirement date, stops the run;
  otherwise the announcement is used. This also applies when one of the rows
  names an alias of the model, and two status rows that reach one model must
  give the same state and dates.
- Offline runs read `test/fixture/anthropic-llms.txt` and
  `test/fixture/anthropic-model-pages/<slug>.md`.

## OpenAI

The refresh reads the
[OpenAI deprecations page](https://developers.openai.com/api/docs/deprecations)
and expects tables with a shutdown date column, a model column, and a
replacement column, each under a heading that carries its announcement date.

- The URL fetched is the `source` of the committed `feeds/openai.json`. The
  constant in `providers.mjs` is used only when the feed has no `source`.
- `script`, `style`, `nav`, `header`, and `footer` elements are removed before
  headings and tables are read.
- The header is the first row with three labels: a shutdown, retirement,
  sunset, or removal date; a "model" or "system" label that doesn't mention a
  replacement; and a replacement, substitute, or successor label.
- A table whose date label sits beside an endpoint, product, service,
  operation, or capability label is skipped as an endpoint table.
- The announcement date comes from the nearest heading above the table, or the
  nearest earlier higher-level heading if that one has no date. A table with
  no dated heading above it stops the run.
- Model IDs come from the `code` elements in the model cell, or from the cell
  text when there are none. A token with a `YYYY-MM-DD` date or a valid `-MMDD`
  suffix (optionally followed by `-preview`) is a snapshot and becomes the
  record ID. The other tokens become its aliases.
- A cell with two or more snapshots plus an undated ID stops the run, because
  the alias can't be assigned to one snapshot.
- A row is skipped only when every token is endpoint- or product-shaped
  (`/vN/...`, `Name API`, `OpenAI-Beta: name=vN`). Any other token that fails
  the ID grammar, or a real model ID beside an endpoint token, stops the run.
- Every row needs a shutdown date no earlier than the announcement. OpenAI
  records never set `date_precision`.
- Replacement cells: `-`, `N/A`, and `none` give nothing. One code token becomes
  `replacement`, several become `replacement_options`, and leftover prose
  becomes `replacement_note`. A single replacement stays `replacement` only if
  it resolves to an ID or alias in the feed; otherwise it becomes a one-item
  `replacement_options`.
- Duplicate rows for one ID: identical dates merge aliases and replacements;
  different announcement dates keep the later announcement, unless the dropped
  row names an alias the kept row doesn't, which stops the run; the same
  announcement with different shutdown dates stops the run.
- A snapshot ending in `-YYYY-MM-DD` is always its own entry. A row that would
  merge it with another entry stops the run, and so does a row for a snapshot
  that the committed feed lists as another entry's alias.
- A row listed as `alias | snapshot`, where the snapshot ends in `-YYYY-MM-DD`
  and the alias is that ID without the date, gives both committed entries the
  row's lifecycle and merges neither. A row of this shape whose replacement is
  the alias or any of its dated snapshots stops the run, whether or not the
  alias is committed.
- When several such rows name one alias, each snapshot keeps its own row's
  lifecycle and the alias follows one row. If the rows differ in dates,
  precision, or replacement targets, that is the row with the earliest
  shutdown, and a tie on it stops the run. If they agree, it is the row for the
  newest snapshot. A committed alias entry takes that row's lifecycle. An alias
  that isn't committed is attached to that row's snapshot, and moves there from
  another of the snapshots if an earlier run put it there. A row for the alias
  itself stops the run, unless the alias is committed and the row agrees with
  the chosen one.
- The models endpoint (`https://api.openai.com/v1/models`, `OPENAI_API_KEY`) is
  paged for up to 20 pages. A repeated ID or a cursor that doesn't advance stops
  the run. Without the key, committed current-model entries are kept.
- Offline runs read `test/fixture/openai-deprecations.html` and
  `test/fixture/openai-models.json`.

## Google (Gemini API)

The refresh reads the
[Gemini API deprecations page](https://ai.google.dev/gemini-api/docs/deprecations)
and expects tables with a model column, a shutdown date column, and a
replacement column. The page has no announcement dates.

- The URL fetched is the `source` of the committed `feeds/google.json`, with the
  constant as a fallback.
- The header is the first row of a table, in `th` or `td` cells, with a
  shutdown date label, a "model" or "system" label, and a replacement or
  successor label. Endpoint tables are skipped as for OpenAI.
- The model ID is the first `code` element in the model cell, or the cell text
  when it has no spaces. Rows without a usable ID or without a shutdown cell are
  skipped. An ID that fails the grammar stops the run. The page supplies no
  aliases.
- An empty, `N/A`, dash, or "No shutdown date (announced)" cell gives no
  shutdown. Any other text must contain a date or the run stops.
- `date_precision` is `earliest` when "earliest possible", "not moved to an
  earlier date", "or later", or "no sooner than" appears in the shutdown cell,
  or in the prose of the table's section or any enclosing section (tables,
  comments, and scripts excluded). The page's single note sits under the h1, so
  today it covers every table.
- Replacement cells follow the OpenAI rules.
- Duplicate rows for one ID must agree on shutdown, precision, and replacement,
  or the run stops.
- The models endpoint
  (`https://generativelanguage.googleapis.com/v1beta/models`, `GEMINI_API_KEY`,
  or `GOOGLE_API_KEY` when running locally) is paged, up to 20 pages. Names
  must start with `models/`, which is stripped. A repeated page token stops the
  run.
- Offline runs read `test/fixture/google-deprecations.html` and
  `test/fixture/google-models.json`.

## Mistral

The refresh reads the [Mistral models page](https://docs.mistral.ai/models)
and expects lifecycle tables whose header is exactly five `th` cells (Model,
Version, API, Deprecation Retirement, Alternative), with each Deprecation
Retirement cell holding two M/D/YYYY dates.

- A lifecycle header row that contains data cells or unexpected labels stops
  the run.
- Mistral sometimes puts the header row in one table and the data rows in the
  next. A table with a valid header and no data rows holds its header for the
  next table. That table must come before any heading, have no header of its
  own, and contain only `td` cells, or the run stops. A held header that is
  never used also stops the run.
- A row counts as a lifecycle header when a label mentions deprecation or
  retirement, or when two or more labels are exactly Model, Version, API, or
  Alternative. In a table with `th` cells, every row with a `th` cell is
  checked. In a table without `th` cells that isn't receiving a held header,
  only the first row is checked, so a header written in `td` cells stops the
  run.

## Cohere

The refresh reads the
[Cohere deprecations page](https://docs.cohere.com/docs/deprecations) and
expects a `Deprecation History` heading whose subsections each start with a
`YYYY-MM-DD:` date. A subsection holds an "Effective <date>, the following
models will be retired:" list, a "Deprecated Models:" list, or tables headed
Shutdown Date, Deprecated Model, and Recommended Replacement.

- Identities and aliases are collected from every section first. Records are
  then merged in ascending order of the section's heading date.

## Amazon Bedrock

AWS changed its lifecycle policy on 2026-09-07. Models launched before then
stay in the
[legacy table](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html).
Newer models publish dates on individual
[model cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html).
The refresh reads both.

Precedence:

- When the legacy table and a card cover the same model, the legacy table wins.
  This also applies when two different Bedrock IDs resolve to the same
  publisher model through aliases.
- Conflicting exact dates are listed under "Source conflicts" in the diff, and
  the legacy table's date is used.
- A card's "EOL no sooner than" floor becomes a tentative `distributions` entry
  with no `announced` date. An exact Model EOL date stays exact.
- When one card gives two different floors, the later day-precision date
  applies. Two cards that disagree about the same model stop the run, including
  after alias resolution.

Card parsing:

- Each card must contain exactly one Model ID table. A table is that table when
  any cell in its first row, `th` or `td`, is exactly `Model ID`.
- HTML comments are removed before extraction.
- A lifecycle field is read only from a paragraph that starts with the
  exact-case label and a colon. A label found anywhere else on the card, matched
  as a whole label ignoring case and colon, stops the run.
- A standalone Model EOL date counts as lifecycle data. `N/A` and
  `Not announced` count as no date.
- The feed has no Region dimension, so a card whose lifecycle reads `Legacy in
  <regions>; Active in other Regions` is legacy, with the EOL date given as
  `<date> (<regions> only)`. The two Region lists must match. Every other
  region-qualified form stops the run.
- Cards with no lifecycle fields or no day-precision date are listed under
  "Model cards without lifecycle fields" and emit notices.
- Links from the card index resolve inside the index's directory after the
  query and fragment are removed. An invalid link stops the run.

Limits: at most 400 unique cards, fetched one at a time, each with a 30-second
deadline and an 8 MiB limit.

Offline runs read `bedrock-lifecycle.html`, `bedrock-model-cards.html`, and
`bedrock-model-cards/<basename>`. A missing card fixture stops the run.

## Vertex AI

The refresh reads the
[Vertex AI model versions page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)
and expects tables with a Model ID column and a retirement date column. It runs
only with `--distributor vertex-ai`.

- Row and column spans are expanded before columns are indexed.
- The header is the first row with a "model ID" or "model identifier" label and
  a retirement or discontinuation date label. Other tables are skipped and extra
  columns are accepted.
- The model ID is the first `code` element in the model cell, or the cell text,
  with trailing asterisks removed. Values containing whitespace are skipped.
  Vertex rows never create feed entries, so no other ID check runs.
- A row with no retirement cell stops the run. Empty, dash, `N/A`, `na`,
  `none`, "not available", "not applicable", and "no shutdown (or retirement)
  date announced" cells give no date. Any other
  text must contain a date or the run stops.
- `date_precision` is `earliest` under the same section-scoped test as the
  Gemini API, plus "retirement timelines may be extended". The walk up the
  sections stops at the retired-models archive (an `id` of `retired-models`, or
  a heading reading "Retired models" or "The following table lists the retired
  models"), so archive rows keep plain dates. Any other heading mentioning
  retirement beneath a qualifier stops the run.
- A model listed with the same date in an available table and the archive keeps
  the available row's precision. Any other conflict stops the run and names
  both rows.
- A `publishers/<name>/models/` prefix is stripped, and its namespace binds the
  row to that publisher's feed. A bare ID binds to whichever feed has it as an
  ID or alias. An ID shared by two feeds stops the run.
- Rows that match no feed entry are listed in the diff and create nothing. Two
  rows that resolve to one model with different dates stop the run.
- A matched model gets one `vertex-ai` distribution. Committed `vertex-ai`
  entries the page no longer confirms are kept and reported as unconfirmed. The
  merge may change only `vertex-ai` distributions; any other change stops the
  run.
- Offline runs read `test/fixture/vertex-model-versions.html`.

## Azure AI Foundry

- Rows bind to publisher feeds through the Azure OpenAI, Anthropic, Mistral AI,
  and Cohere section headings.
- OpenAI rows first try exact snapshot IDs and aliases. A bare model ID is used
  only for models with a single row and no dated snapshot candidate.
- For OpenAI, four-digit versions need an exact snapshot ID or alias, and
  versions `1`, `2`, `001`, and `-` use the bare ID. Mistral and Cohere
  integer versions, including four-digit ones, and `-` use the bare ID.
- Cohere binding strips one leading `Cohere-` or `cohere-` prefix and keeps the
  case of the rest.
- Model cells are counted before deduplication. Replacement cells are ignored.
- Rows that can't be bound stay unconfirmed. They appear in the diff but don't
  count as a material change.
- Matching rows for different hosting options collapse into one. For Azure
  OpenAI and Anthropic rows with two different retirement dates, the earlier
  date is kept and listed under "Source conflicts". Conflicting Mistral or
  Cohere rows stop the run.
- Fine-tuning tables and other unrelated tables are skipped. Header drift in a
  lifecycle table stops the run.
- Azure's status labels are mapped to `distributions[].status` as described in
  [SPEC.md](../SPEC.md#distributions).

## All distributor tables

- A span over 64 rows or columns, or a table over 10,000 cells, stops the run.
- When a refresh PR opens for another change, its body also lists source
  conflicts. Conflicts alone don't open a PR.

## Adding a source

Start from the closest existing parser and keep its shape: strict table
identity, ID grammar checks, and a thrown error whenever the page doesn't look
the way the parser expects.

1. Record the live page as a fixture under `test/fixture/`.
2. Write tests against the fixture. `node refresh/test/run.mjs` runs only the
   refresh tests.
3. Regenerate the feeds from the live pages with `node refresh/refresh.mjs`
   (add `--distributor ...` for a distributor parser), and include the semantic
   diff in the PR description. Don't commit feeds
   generated with `--fixtures`.

The test rules in [CONTRIBUTING.md](../CONTRIBUTING.md#tests) apply: no
network, and no assertions on live feed values.
