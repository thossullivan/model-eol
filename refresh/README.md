# refresh

This directory regenerates `feeds/*.json` from provider pages, models
endpoints, and distributor lifecycle pages. For what the feeds contain and how
the weekly workflow uses this code, see [docs/FEEDS.md](../docs/FEEDS.md).

| File | Role |
|---|---|
| `refresh.mjs` | Entry point. Fetches, parses, merges, writes, and prints the semantic diff. |
| `providers.mjs` | Publisher parsers: OpenAI, Anthropic, Google, Mistral, Cohere. |
| `distributors.mjs` | Distributor parsers: Bedrock, Vertex AI, Azure AI Foundry. |
| `azure-models-api.mjs` | The Azure models API reader and its comparison with the Azure retirement page. |
| `bedrock-models-api.mjs` | The Bedrock `ListFoundationModels` reader and its comparison with the Bedrock lifecycle page. |
| `aws-sigv4.mjs` | AWS Signature Version 4 request signing with `node:crypto`, checked against the AWS SigV4 test suite. |
| `cross-checks.mjs` | Reads `MODEL_EOL_CROSS_CHECKS`, the policy for a failed cross-check, for the Anthropic, Azure, and Bedrock models API readers and for `refresh.mjs`, which refuses an unknown value before reading any source. |
| `markdown.mjs` | Strict reader for GitHub-flavored Markdown pipe tables, with an HTML rendering for the HTML row readers, and the line preparation and block checks the Markdown converters share. |
| `fetch.mjs` | Bounded HTTP fetches (30-second deadline, 8 MiB limit) for Anthropic model pages and distributor pages. It re-exports `lib/fetch-bounded.mjs`, which the bot's `--feeds-url` download also uses. |
| `diff.mjs` | The semantic diff used for `--check` and for refresh PR bodies. |
| `shapes.mjs` | The source structure check. Records the table header shapes of every source page in `source-shapes.json`. |
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

A failed source doesn't hide the others. The run still reads every selected
publisher and distributor, then fails with one error that lists each failed
source and its message, and writes no feed and no diff.

A few rows are skipped rather than stopping the run, and the sections below
say which: OpenAI endpoint and product rows, Gemini cells without a usable ID,
and Vertex IDs with whitespace. A Cohere section with only prose yields nothing
without stopping.

How strictly tables are identified also differs. Mistral, Cohere, the Bedrock
model cards, and Azure check lifecycle headers exactly and stop on drift.
OpenAI, the Gemini API, and Vertex AI find columns by label patterns: tables
without a matching header are skipped, and extra columns are accepted. The
Bedrock legacy page has no tables in its Markdown copy; each model is a labelled
list, and an unknown label stops the run.

Every fetch has a 30-second deadline over the request and body, and an 8 MiB
body limit (`fetch.mjs`). Requests that carry a credential header refuse
redirects, so a key never follows a redirect to another origin. Credential
headers are `Authorization`, `Proxy-Authorization`, `Cookie`, `x-api-key`,
`api-key`, `x-goog-api-key`, any name containing auth, key, token, secret,
session, cookie, password, signature, or credential, and any name the caller
lists in `secretHeaders`. Other headers, such as the Azure page's `Accept:
text/markdown` or `anthropic-version`, don't stop a fetch from following
redirects. Such a fetch follows them one hop at a time, at most 5, resolving a
relative `Location` against the hop that sent it, and stops the run on any hop
to a URL that isn't `https`, so an `https` to `http` to `https` chain is
refused before the `http` request. The deadline covers every hop, and only the
final body is read. Error messages include at most 300 characters of the error body on one
line, with credential header values (and each word of them, such as a bearer
token without its scheme) redacted. Paged models
endpoints stop the run if they still have more pages after 20; Mistral's is
read in one request.

A change that makes a parser accept more input has to show that the new input
can't produce a row bound to the wrong model. Add a fixture that would have
produced a misaligned row and assert that it is refused.

## Markdown pipe tables

`markdown.mjs` reads GitHub-flavored pipe tables for parsers whose source is a
Markdown page. It is stricter than GitHub, which pads or truncates rows:

- A table is a header row, a delimiter row of `---`, `:--`, `--:`, or `:-:`
  cells, then body rows up to a blank line or the start of another block.
  Outer pipes are optional.
- A delimiter or body row whose cell count differs from the header stops the
  run with its line number, so a date can never land in the wrong column. So
  does a delimiter row with no header, a second delimiter row, a line without a
  pipe directly after a row, and a row cut off from its table by a blank line.
- `\|` is a literal pipe, and a pipe inside a code span doesn't split a cell.
  Fenced code, HTML comments, and YAML front matter are ignored. Tables inside
  block quotes are read.
- Content the rendered page shows as code or hides is never read as live
  rows. A fence inside a block quote ends with the quote, a backtick fence
  whose info string holds a backtick is not a fence, and a closing fence
  indented 4 or more spaces past its opening fence is code. Where the
  indentation could belong to a list item, so CommonMark's reading depends on
  context the reader doesn't track, the run stops: an opening fence indented 4
  or more spaces, a closing fence indented differently from its opening fence
  past column 3, and fenced content indented less than its fence. So does a
  table header indented 4 or more spaces, an unclosed `<!--`, an HTML comment
  marker inside a code span, and an element with a `hidden` attribute or
  `display: none` style.
- A line that would end a table because it starts like another block (a
  heading, list item, thematic break, or HTML tag) but still carries a pipe
  stops the run, since GitHub reads it as a row.
- Each table records its header, rows of trimmed cell source, the line of its
  header row, and the nearest preceding ATX heading.
- `markdownPipeTableToHtml` renders a table as HTML for the HTML row readers.
  Its default cell rendering keeps code spans, links with a safe target, and
  `<br>`, and escapes any other markup. A table cell that ends in a lone
  backslash stops the run.
- Cells and prose go through the same inline reader. Emphasis is matched by
  the CommonMark delimiter rules and dropped; an unmatched `*` or `_`, such as
  a footnote marker after a date, stays as text, so the date reader refuses
  it. Strikethrough (`~x~`, `~~x~~`, `<s>`, `<del>`, `<strike>`) stops the
  run, because the struck words would otherwise be read as live. A bare
  phrasing tag (`<b>`, `<em>`, `<span>`, and similar, without attributes) is
  kept as that tag, so the HTML readers see the words inside it the way they
  do on an HTML page. A backslash at the end of a line is a hard line break
  and reads as a space.
- `markdownPage` returns the prepared source lines together with the tables,
  keyed by header line, so a converter that walks the page sees the same lines
  the table reader numbered. The converters for OpenAI, Anthropic, Cohere,
  Vertex AI, and Azure share it, along with the ATX heading, setext underline,
  thematic break, raw HTML table, and HTML body checks. Rules that belong to
  one source, such as Anthropic's components or Azure's footnote markers, stay
  in that source's parser.

## Source structure check

A parser that finds columns by label can keep working while it ignores a new
column or a new kind of table. `shapes.mjs` catches that. It reads each
provider deprecations page and each distributor lifecycle page, and records
every distinct table header in `source-shapes.json`. Anthropic's `llms.txt`
and model pages, the Bedrock model-card index and cards, and the models
endpoints aren't checked.

- A header shape is the header cells of one table in column order, lowercased,
  with whitespace collapsed, invisible characters removed, and `<sup>`
  footnote markers dropped. HTML tables use their `thead` rows, or else their
  leading rows of `th` cells. A table with neither is recorded as having no
  header row. Google's Markdoc tables use their first row, and Markdown pipe
  tables use their header row, read with emphasis, links, code marks, and
  `^N^` and `[^N]` footnote markers removed.
- A page whose first markup, after any leading comments, is a tag is HTML;
  anything else is Markdown. A Markdown page contributes its Markdoc, pipe,
  and raw HTML tables outside fenced code, and its labelled lists.
- A labelled list is a run of indented list items that each start with a bold
  label and colon (`  - **EOL date:** ...`), such as one model on the Bedrock
  legacy page. Its shape is `labelled list: ` and the run's distinct item
  labels in first-seen order, normalized like header cells and joined with
  ` | `. An item with several `**Label:**` segments separated by ` / ` (a
  Bedrock regional line) is one item, its labels joined with ` / `. Values,
  the parent item, and how often an item repeats aren't recorded, so a new
  model or another regional line with familiar labels doesn't change the
  snapshot; a new, renamed, or reordered label does.
- Each shape ends with the table's width, such as `[5 cols]`: the widest row,
  header or body, with `colspan` counted. A wider body or a changed `colspan`
  under an unchanged header changes the shape.
- Each source keeps only distinct shapes, so a new dated section with a
  familiar table doesn't change the snapshot. Headings and dates aren't
  recorded.
- `node refresh/shapes.mjs --check` exits 0 when every page matches the
  snapshot, 3 when any differs (it prints the shapes added and removed per
  source), and 1 when a page can't be fetched, has neither tables nor labelled
  lists, or has a malformed table. It names every failing page, not only the first.
- `node refresh/shapes.mjs --write` regenerates the snapshot from the live
  pages. With `--fixtures DIR` it reads the recorded pages instead, and then
  needs `--snapshot FILE` so it never overwrites the committed snapshot.
- A provider's `deprecationsFetchHeaders` or a distributor's `sourceHeaders`
  adds request headers to its page fetch, such as `Accept: text/markdown`. A
  fetch with extra headers refuses redirects, like a models endpoint fetch.

The daily `source-check` workflow runs this check; see
[docs/FEEDS.md](../docs/FEEDS.md#the-daily-source-check).

## Anthropic

The refresh reads the Anthropic model deprecations page for dates, the model
overview pages for IDs and aliases, and, with a key, the models API for
current IDs and a lifecycle cross-check.

- Dates come only from the
  [model deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations),
  fetched as its Markdown copy at
  `https://platform.claude.com/docs/en/about-claude/model-deprecations.md`
  (listed in the site's `llms.txt`). Records and the feed cite the human page
  as `source`. Its "not sooner than" dates for active models become
  `tentative` shutdowns.
- The page has a model status table (API model name, Current state,
  Deprecated, Tentative retirement date) and a `### YYYY-MM-DD: ...` section
  per announcement, each with a Retirement date, Deprecated model, Recommended
  replacement table. Tables are read with the strict pipe-table reader above,
  then rendered as HTML for the row readers, so every rule below applies to
  the Markdown page as it did to the HTML one.
- An announcement's date is its section heading's date. A heading without one
  falls back to the dates in the prose between it and the table, which must
  hold exactly one; a `<Note>` saying when the model retired counts as prose,
  so a section with both a retirement note and a notification date stops the
  run.
- `<Note>`, `<Warning>`, `<Tip>`, and `<Info>` tags are read as prose. Any
  other tag at the start or end of a line, an HTML table or heading, a setext
  heading (including a one-dash underline), a heading inside a list item or
  inside one of those components, or an unbalanced comment marker stops the
  run. So does an announcement table whose section heading has no date when
  the only date before it is inside a component. Front matter, HTML comments,
  and fenced code are ignored.
- A pipe table must be the status table, an announcement table, an endpoint
  table, or a table whose header names neither a model nor a retirement,
  deprecation, shutdown, or sunset, such as the API parameter table, which
  yields no records. Any other table stops the run instead of being skipped.
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
- With `ANTHROPIC_API_KEY`, the refresh lists
  `https://api.anthropic.com/v1/models` with `lifecycle[]=active`,
  `lifecycle[]=deprecated`, `lifecycle[]=retired` (the array encoding the
  official SDKs send; the API rejects a plain `lifecycle=` with "the parameter
  name is `lifecycle[]`") and `limit=1000`, following `after_id` for up to 20
  pages. Active and deprecated IDs are the current IDs, the same set the list
  returns without a `lifecycle` filter; retired IDs are only compared. On
  2026-11-17 the API listed no retired models for the project's key, so in
  practice the cross-check covers active and deprecated models only.
- Every listed model must carry `lifecycle` (`active`, `deprecated`, or
  `retired`), `deprecated_at`, and `retires_at`, each date an RFC 3339
  date-time with a `Z` or numeric offset, or null. An active model must have a
  null `deprecated_at` and may have a tentative `retires_at`, a deprecated or
  retired model must have `deprecated_at`, and `retires_at` can't precede it.
  Anything else is a lifecycle cross-check failure (see below).
- The page stays authoritative. The API's lifecycle is compared with the
  page's stated state, `deprecated_at` (as a UTC calendar date) with the
  page's deprecated date, and `retires_at` (as a UTC calendar date) with the
  page's exact retirement date. A tentative page date matches a null
  `retires_at` and is compared with the `retires_at` of an active model.
  Conflict lines show the API's raw timestamp, so an offset is visible. Each
  disagreement, each deprecated or retired API model the page doesn't list,
  and each Active or Deprecated page model the API doesn't return becomes a
  `Source conflicts` line in the semantic diff and a `notice:` line on stderr.
  Neither fails the run, puts an API date or state in the feed, or counts as a
  material change. A deprecated model the page doesn't list is still a current
  ID, as it was before the lifecycle fields were read, so it can enter the
  feed with no dates. The
  run then prints `notice: anthropic models API lifecycle: N active, N
  deprecated, N retired; N conflicts with the deprecations page`. Without the
  key, none of this runs.
- The listed IDs change feed data, so a failure to list them always stops
  the run: an HTTP or network error, a body that isn't JSON, a missing `data`
  array or boolean `has_more`, `has_more` without a `last_id`, an ID that
  fails the ID check, or an ID repeated within a page or across pages. The key
  is redacted from the message.
- The lifecycle fields only feed the comparison, so a lifecycle rule above
  that fails on any entry doesn't fail the run by default. Every listed ID
  except an entry whose `lifecycle` is `retired` stays a current ID, the
  comparison is skipped, and the run prints
  `warning: anthropic models API cross-check failed: <message>` (the first
  failing entry, and how many more failed) and adds a `cross-check-failed`
  line to `Source conflicts`. `MODEL_EOL_CROSS_CHECKS=strict` makes such a
  failure stop the run instead; `warn` or an empty value keeps the default,
  and any other value stops every refresh run as a configuration error before
  any source is read. A failure of the deprecations page itself always stops
  the run.
- Offline runs read `test/fixture/anthropic-deprecations.md`,
  `test/fixture/anthropic-models.json` (with the lifecycle fields),
  `test/fixture/anthropic-llms.txt`, and
  `test/fixture/anthropic-model-pages/<slug>.md`.

## OpenAI

The refresh reads the Markdown copy of the
[OpenAI deprecations page](https://developers.openai.com/api/docs/deprecations),
fetched from `https://developers.openai.com/api/docs/deprecations.md`. Records
cite the page itself. It expects tables with a shutdown date column, a model
column, and a replacement column. Each row's announcement date comes from the
table's notice date column, or, in a table without one, from the heading above
it.

- The URL fetched is the constant in `providers.mjs`. The committed feed's
  `source` is used only when a provider has no constant.
- The Markdown's ATX headings and pipe tables are rendered as HTML in page
  order and read by the HTML parser, so every rule below applies to both. Pipe
  tables follow the [Markdown pipe table](#markdown-pipe-tables) rules: a row
  whose cell count differs from its header stops the run with its line number.
  An HTML `<table>` or heading, a setext heading, and a heading inside a list
  item stop the run, since any of them could put a table under the wrong
  date. A page without a recognised table has no deprecations content and
  stops it too.
- A shutdown cell holds exactly one date. The page's own `Earliest estimate`
  label after it makes the date `earliest`; any other text in the cell stops
  the run. Two rows for one model with the same announcement must agree on
  the date and its precision.
- When the HTML parser reads a rendered page directly, `script`, `style`,
  `nav`, `header`, and `footer` elements are removed first. The rendered page
  curls apostrophes that the Markdown keeps straight, so a replacement note
  can differ by that character.
- The header is the first row with three labels: a shutdown, retirement,
  sunset, or removal date; a "model" or "system" label that doesn't mention a
  replacement; and a replacement, substitute, or successor label.
- A table whose date label sits beside an endpoint, product, service,
  operation, or capability label is skipped as an endpoint table.
- The notice column is the one labelled exactly `Notice date` or
  `Announcement date` (case-insensitive). Any other header label that mentions
  a notice or an announcement, such as `Notice date (UTC)` or `Date announced`,
  stops the run.
- A table with a notice column takes each row's announcement date from that
  row. A model row whose notice cell is empty, has no date, or has more than
  one date stops the run. Every row must have as many cells as the header and
  no `colspan` or `rowspan` cell, so a cell can't be read from the wrong
  column.
- A table without a notice column takes its announcement date from the nearest
  heading above it, or the nearest earlier higher-level heading if that one has
  no date. A table with neither stops the run.
- A status column is any header label containing the word `status`. A table
  with more than one, or with a status column but no notice column, stops the
  run. The feed has no publisher status field, so a model row's status must
  agree with its dates: `Deprecated` is accepted, and so is `Shut down` or
  `Shutdown` when the row's shutdown date is on or before the refresh day.
  Any other value stops the run. The refresh day is the UTC date of
  `MODEL_EOL_GENERATED` when it is set, and of the current time otherwise.
- Model IDs come from the `code` elements in the model cell, or from the cell
  text when there are none. A token with a `YYYY-MM-DD` date or a valid `-MMDD`
  suffix (optionally followed by `-preview`) is a snapshot and becomes the
  record ID. The other tokens become its aliases.
- A cell with two or more snapshots plus an undated ID stops the run, because
  the alias can't be assigned to one snapshot. The exception is a cell whose
  snapshots all end in `-YYYY-MM-DD` and whose undated ID is each of them
  without the date: it is read as one `alias | snapshot` row per snapshot, and
  the family alias rules below decide which entry keeps the alias.
- A row is skipped only when every token is endpoint- or product-shaped
  (`/vN/...`, `Name API`, `OpenAI-Beta: name=vN`). Any other token that fails
  the ID grammar, or a real model ID beside an endpoint token, stops the run.
- Every row needs a shutdown date no earlier than the announcement. OpenAI
  records never set `date_precision`.
- Replacement cells: `-`, `N/A`, and `none` give nothing. One code token becomes
  `replacement`, several become `replacement_options`, and leftover prose
  becomes `replacement_note`. A cell with no code elements is read as IDs only
  when it is one ID, or a list split by `,`, `/`, `or`, or `and` whose parts are
  all IDs containing a digit or hyphen (`gpt-5 or gpt-4.1`). Any other such
  cell is all `replacement_note`, so prose such as "No one-to-one replacement"
  never becomes an ID. A single replacement stays `replacement` only if it
  resolves to an ID or alias in the feed; otherwise it becomes a one-item
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
- Offline runs read `test/fixture/openai-deprecations.md` and
  `test/fixture/openai-models.json`.

## Google (Gemini API)

The refresh reads the Markdown source of the
[Gemini API deprecations page](https://aistudio.google.com/docs/deprecations),
fetched from `https://aistudio.google.com/docs/deprecations.md` because the
page itself is a JavaScript app with no tables in its HTML. Records and the
feed cite the human page as `source`. The page has no announcement dates.

- The page is Markdoc. Each `{% table %}` block has a header row, then rows
  separated by `---`, with one `* ` list item per cell. A cell may be empty and
  may continue on more deeply indented lines. Headings keep their
  `{% id="..." %}` as an anchor id. Markdoc tags elsewhere are removed and the
  text around them is read as prose. Matched emphasis markers and backslash
  escapes are removed from prose and cells; an unmatched `*` or `_` stays as
  text, and strikethrough stops the run.
- The header must be exactly Model (or Agent), Release date, Shutdown date,
  Recommended replacement. Any other layout stops the run, as do a row whose
  cell count differs from the header, a model cell that is not exactly one
  code span (optionally inside a link) or one bare ID that passes the grammar
  and carries no emphasis markup,
  a nested list, text outside a cell, a `---` indented deeper than the cells,
  an unbalanced code span, a Markdoc tag inside a cell, an unclosed table, a
  table with no rows, and a pipe table (with or without outer pipes, also
  inside a blockquote) or HTML table.
- The model ID is that code span or bare ID. An ID that fails the grammar
  stops the run. The page supplies no aliases.
- An empty, `N/A`, dash, or "No shutdown date (announced)" cell gives no
  shutdown. Any other text must contain a date or the run stops.
- `date_precision` is `earliest` when "earliest possible", "not moved to an
  earlier date", "or later", or "no sooner than" appears in the shutdown cell,
  or in the prose of the table's section or any enclosing section (tables
  excluded). The page's single note callout sits under the h1, so today it
  covers every table, including the Deprecated models and Deprecated agents
  sections. Only a heading with the `retired-models` id or the text "Retired
  models" is treated as an archive. If that prose or a shutdown cell says
  "earliest", "no sooner", "not earlier", "no earlier", "not before", "on or
  after", or "soonest" without one of those phrases, the run stops rather than
  reading the dates as exact.
- Replacement cells follow the OpenAI rules, except that the row's own model
  ID is never a replacement. When every code span in the cell names the row's
  own ID, only the note is kept. Otherwise those spans are read as prose and the
  ID is removed from `replacement` and `replacement_options`. The page writes
  "`gemini-3.8-flash` (`gemini-3.7-flash` ... routes API requests to
  `gemini-3.8-flash`)". Only the exact ID is removed, so `gemini-a-002` stays a
  replacement on the `gemini-a` row.
- Duplicate rows for one ID must agree on shutdown, precision, and replacement,
  or the run stops.
- The models endpoint
  (`https://generativelanguage.googleapis.com/v1beta/models`, `GEMINI_API_KEY`,
  or `GOOGLE_API_KEY` when running locally) is paged, up to 20 pages. Names
  must start with `models/`, which is stripped. A repeated page token stops the
  run.
- Offline runs read `test/fixture/google-deprecations.md` and
  `test/fixture/google-models.json`.

## Mistral

The refresh reads the Markdown copy of the
[Mistral models page](https://docs.mistral.ai/models), fetched from
`https://docs.mistral.ai/models.md`. Records cite the page itself. It reads the
page's pipe tables directly, following the
[Markdown pipe table](#markdown-pipe-tables) rules, so a misaligned row stops
the run with its line number.

- The lifecycle table's header is exactly Model, API name, Status, Context,
  Summary, Deprecation, Retirement, Replacement. The overview table's header is
  exactly the first five of those. Any other table whose labels mention
  deprecation, retirement, replacement, or alternative, or that has two or more
  of the labels Model, Version, API, API name, or Status, stops the run.
- A lifecycle row's Status is Deprecated or Retired. Any other status stops the
  run, and so does a Retired row whose retirement date is after the run's date.
  An overview row whose status mentions deprecation or retirement stops the
  run, because it has no dates.
- Deprecation and Retirement each hold one date, `YYYY-MM-DD` or a written
  date such as `April 30, 2026`. The deprecation date is the announcement date
  and the retirement date is the shutdown date.
- The Replacement cell names a product, not an API ID, so it becomes a note:
  "Mistral lists <name> as the alternative".
- A row without an API name is skipped and reported as a notice and in the
  diff. The page has no version column, so the version shows as not listed.
- Identical rows for one API name collapse into one record. Rows that differ
  in dates or replacement stop the run.
- An HTML body, an HTML `<table>` in the Markdown, or a page without a
  lifecycle table with rows stops the run.

## Cohere

The refresh reads the Markdown copy of the
[Cohere deprecations page](https://docs.cohere.com/docs/deprecations), fetched
from `https://docs.cohere.com/docs/deprecations.md`. Records cite the page
itself. It expects a `Deprecation History` heading whose subsections each start
with a `YYYY-MM-DD:` date. A subsection holds an "Effective <date>, the
following models will be retired:" list, a "Deprecated Models:" list, or tables
headed Shutdown Date, Deprecated Model, and Recommended Replacement.

- The Markdown's ATX headings, paragraphs, bullet and numbered lists (nested
  by indentation), and pipe tables are rendered as HTML in page order and read
  by the HTML parser, so every rule here applies to both. Block quotes are read
  as their contents.
- A raw HTML block or `<table>`, a setext heading, an indented code block
  (checked before the line is read as a table), tab indentation, a list item
  indented between two list levels, a change of bullet or numbering character
  within a list (GitHub starts a new list there), a table or heading inside a
  list item, an HTML body, and a misaligned pipe table row each stop the run
  with a line number where there is one.
- Identities and aliases are collected from every section first. Records are
  then merged in ascending order of the section's heading date.

## Amazon Bedrock

AWS changed its lifecycle policy on 2026-09-07. Models launched before then
stay in the
[legacy table](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html).
Newer models publish dates on individual
[model cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html).
The refresh reads both from the Markdown copies the user guide serves next to
each page (the same path ending in `.md`, as its `llms.txt` lists them): the
legacy page from `sourceFetchUrl`, the card index from `indexFetchUrl`, and
each card from its own `.md` URL. Records, notices, and the feed cite the human
`.html` pages. A body that is HTML rather than Markdown stops the run.

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

Legacy page parsing:

- Each model is a top-level list item that is only a bold provider name
  (`- **Anthropic**`), followed directly by indented items that each start with
  a bold label and colon (`  - **Model ID:** ...`). A blank line ends the
  entry. Other lists and prose are ignored.
- The labels are `Model name`, `Model ID`, `Regions`, `Legacy date`,
  `EOL date`, `Public extended access start date`, and an optional status
  (`Status`, `Model status`, or `Lifecycle status`). Any other label, a label
  given twice, an entry without a Model ID, Legacy date, EOL date, or Public
  extended access start date, an unlabelled line inside an entry, a labelled
  item outside an entry, a labelled item at a different list depth from the
  entry's first one (a deeper sub-bullet is a note on the item above it, not an
  entry field), or one of these labels followed by a colon anywhere else on the
  page or inside another label's value stops the run. Bold, underscore,
  `<b>`, and `<strong>` emphasis, or none, all count as the same label. So does a pipe table whose header mentions a model ID, legacy, or
  EOL, a raw HTML table, or a page with no entries.
- A model whose dates differ by Region has one regional line per Region group:
  `**Regions:** ... / **Legacy date:** ... / **EOL date:** ... / **Public
  extended access start date:** ...`. Each line is one row; the entry's own
  labels apply to every line, and may not repeat on one. Model ID and Model
  name may not appear on a regional line.
- A Model ID is one Bedrock ID, or a list of IDs each qualified by its endpoint
  (`deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-mantle)`), which
  gives one record per ID. Anything else stops the run.
- Each date value must be exactly one day-precision date (`January 8, 2027`).
  A qualifier ("No sooner than", "or later", "(tentative)"), a second date, or
  a struck-through date stops the run; the live page uses none of them, so
  there is no precision rule for them yet. Empty, dash, and `N/A` dates give
  no date; "To be announced" is accepted only for the extended access start. EOL before Legacy, or an extended access start
  outside the Legacy period, stops the run.
- Status is `extended-access` when an extended access start date is given and
  `legacy` otherwise, unless a status label says otherwise. An extended access
  status without a start date stops the run.
- Rows for one Model ID, from regional lines or repeated entries, merge when
  their dates agree. Rows with different dates merge only when each lists only
  Region codes and the Region groups are disjoint: each date takes its earliest
  value and the status the furthest phase, so no Region is warned late. Any
  other disagreement stops the run.

Card parsing:

- Each card must contain exactly one Model ID table: a pipe table with a header
  cell that is exactly `Model ID` once emphasis is removed. Every pipe table on
  the card is read with [`markdown.mjs`](#markdown-pipe-tables), so a
  misaligned table stops the run, and so does a raw HTML table.
- HTML comments are removed before extraction, and an unbalanced comment
  marker stops the run.
- A lifecycle field is read only from a line, with any list marker, emphasis,
  and inline tags removed, that starts with the exact-case label and a colon
  (`+ **Model EOL date:** ...`). Fenced code is not read for fields. A label
  found anywhere else on the card, fenced code included, matched as a whole
  label ignoring case and colon, stops the run.
- A standalone Model EOL date counts as lifecycle data. `N/A` and
  `Not announced` count as no date.
- Any table cell that mentions Legacy, EOL, retirement, or end of life must read
  exactly `Legacy (EOL: <date>)` or `EOL: <date>` and match the Model EOL date.
  Image alt text, link titles, and raw tags and their attributes count as cell
  text; Bedrock IDs and URLs don't.
- The feed has no Region dimension, so a card whose lifecycle reads `Legacy in
  <regions>; Active in other Regions` is legacy, with the EOL date given as
  `<date> (<regions> only)`. The two Region lists must match. Every other
  region-qualified form stops the run.
- Cards with no lifecycle fields or no day-precision date are listed under
  "Model cards without lifecycle fields" and emit notices.
- Links from the card index, as Markdown links, reference definitions, or
  `href` attributes outside fenced code and comments, resolve inside the
  index's directory after the query and fragment are removed. A card link may
  end in `.md` or `.html`; both name the same card. An invalid link stops the
  run.

Limits: at most 400 unique cards, fetched one at a time, each with a 30-second
deadline and an 8 MiB limit.

Offline runs read `bedrock-lifecycle.md` (or `aws-bedrock.md` or
`aws-bedrock-lifecycle.md`), `bedrock-model-cards.md`, and
`bedrock-model-cards/<card>.md`. A missing card fixture stops the run.

### Bedrock models API cross-check

When `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and optionally
`AWS_SESSION_TOKEN`) are set, the refresh also calls
`GET https://bedrock.{region}.amazonaws.com/foundation-models`
(`ListFoundationModels`) in each of 17 Regions: `ap-northeast-1`,
`ap-northeast-2`, `ap-northeast-3`, `ap-south-1`, `ap-southeast-1`,
`ap-southeast-2`, `ca-central-1`, `eu-central-1`, `eu-north-1`, `eu-west-1`,
`eu-west-2`, `eu-west-3`, `sa-east-1`, `us-east-1`, `us-east-2`, `us-west-1`,
and `us-west-2`. These are the commercial Regions the lifecycle page names that
an account has without opting in. In November 2026 the page also named
GovCloud Regions, which need separate credentials, and 14 opt-in Regions
(`af-south-1`, `ap-east-2`, `ap-south-2`, `ap-southeast-3` through
`ap-southeast-7`, `ca-west-1`, `eu-central-2`, `eu-south-1`, `eu-south-2`,
`il-central-1`, `mx-central-1`), which all answered HTTP 403
`UnrecognizedClientException` for an account that had not enabled them. Since
that is also the answer to a bad key, opt-in Regions are not configured.
Requests are signed with AWS Signature Version 4 (`aws-sigv4.mjs`, no SDK),
checked against the AWS SigV4 test suite and against `@smithy/signature-v4`
for the request this check sends. Fixture runs never read the API.

- Neither key set: the cross-check is skipped with a notice and the run is
  unchanged. Only one of the two keys, or a session token without them, is a
  cross-check failure.
- The cross-check can't change feed data, so its failure is not fatal by
  default, exactly as for the Azure models API: it prints `warning: bedrock
  models API cross-check failed: <message>`, adds a `cross-check-failed`
  source conflict, and the page is used without the cross-check. With
  `MODEL_EOL_CROSS_CHECKS=strict` the same failures stop the Bedrock source. A
  failure to read the page or a card always stops the run.
- Any HTTP error from any configured Region, `UnrecognizedClientException`
  included, is a cross-check failure. No partial comparison is reported.
- An HTTP error reports only `HTTP <status> <error type>`, from the
  `x-amzn-ErrorType` header or the body's `__type`. The body, which for
  `AccessDeniedException` names the caller's ARN and account, is never printed.
  Requests mark `Authorization` and `X-Amz-Security-Token` as credentials, so
  they refuse redirects, and every message from the cross-check has the key
  id, secret, session token, any signature, and any 12-digit number removed.
- A response without a `modelSummaries` array, with a `nextToken`, with an
  invalid or repeated `modelId`, without a `modelLifecycle`, with a `status`
  other than `ACTIVE` or `LEGACY`, or with a `legacyTime`, `endOfLifeTime`, or
  `publicExtendedAccessTime` that isn't null or a whole-hour midnight between
  UTC and UTC-8 (`T00:00:00Z` through `T08:00:00Z`) stops the cross-check.
  Each such time is read as its UTC calendar date. In November 2026 every
  lifecycle time was `T08:00:00Z`, midnight at UTC-8 even for dates in
  summer, and the UTC date matched the page's date for all three fields in
  every one of the 101 Region rows where both listed the model.
- Entries match the page by model ID and Region: each Region is compared with
  the regional line that names it, not with the merged record, which keeps
  only the earliest dates. A context-length variant (`...:128k`, `...:1m`) is
  compared with its base model when the page lists the base. Model IDs the
  page marks `(bedrock-mantle)` are not on the `bedrock-runtime` endpoint that
  `ListFoundationModels` lists, so they are not compared. An ID the page
  doesn't list but a model card does is compared with the card's EOL date.
- Any other page line whose Regions value is missing or isn't a list of Region
  codes (`All commercial Regions`, `us-west-2*`, `US East (N. Virginia)`) is a
  cross-check failure that names the model and the raw value, because none of
  its Regions could be compared. The page itself is still read.
- The page stays authoritative and the API creates no records. A source
  conflict is listed, with a notice, when:
  - the API's legacy, EOL, or public extended access date differs from the
    page's line for that Region, or the API's EOL date differs from a model
    card's (`date`);
  - the page line has any date, or a model card has an exact EOL date, and the
    API calls the model `ACTIVE` with no dates (`undated`). A card's "EOL no
    sooner than" date says the model is active, so it is not compared;
  - the API lists a `LEGACY` or dated entry that neither the page names in
    that Region nor a card covers (`unlisted`);
  - the page names a Region the API was read in, but the API doesn't return
    that exact model ID there and its EOL date hasn't passed (`absent`). A
    context-length variant doesn't stand in for its missing base model. A
    model card with an exact EOL date that hasn't passed is `absent` when the
    API returns it in none of the Regions read. A card with only an "EOL no
    sooner than" date is not: in November 2026 the API returned none of nine
    such cards, four of them served only on the `bedrock-mantle` endpoint and
    five in limited preview or for eligible customers only.

  Each distinct page line or card, API status, and set of dates is one
  conflict that names its Regions. Conflicts never fail the run. No constant
  date offset was seen, so none is grouped.
- One summary notice follows: `bedrock models API: N entries in R regions; N
  legacy; N conflicts with the lifecycle page`.
- The comparison is `reconcileBedrockModelsApi` in `bedrock-models-api.mjs`.
  It returns the page records unchanged, so letting API dates win later is a
  change to that one function.

## Vertex AI

The refresh reads the Markdown copy of the
[Vertex AI model versions page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions),
fetched from `sourceFetchUrl`
(`https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions.md.txt`,
which the page advertises as its `text/markdown` alternate). Records and the
feed cite the human page (`sourceUrl`). It expects tables with a Model ID column
and a retirement date column, and runs only with `--distributor vertex-ai`.

The Markdown is rendered as HTML and read by the HTML page parser, so both
sources follow the rules below. Each pipe table is read with
[`markdown.mjs`](#markdown-pipe-tables) and rendered with
`markdownPipeTableToHtml`; ATX headings and prose lines become headings and
paragraphs so the section rules see the same text as on the HTML page.

- The body must be Markdown. An HTML page, a raw HTML `<table>` outside fenced
  code, a setext heading, or a misaligned pipe table stops the run. Fenced
  code, HTML comments, and front matter add no prose.
- Google escapes punctuation inside code spans (`` `textembedding-gecko@003\*` ``),
  so a backslash before ASCII punctuation in a code span is dropped. Model IDs
  never contain a backslash.
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
- `date_precision` is `earliest` when the retirement cell has a qualifier
  phrase (the Gemini API's list plus "retirement timelines may be extended").
  Otherwise the sections are walked from the table's own heading up, and the
  first section whose own prose speaks about its dates decides: a qualifier
  phrase gives `earliest`, and "fixed date" or "fixed retirement dates", not
  negated in the 40 characters before it, gives an exact date even beneath a
  qualified parent. "Models available for shorter availability periods" ("we
  post a fixed date") is exact this way although "Latest available models"
  above it is qualified. A section stating both stops the run. The page intro
  before the first heading can only add a qualifier. The walk stops at the
  retired-models archive (an `id` of `retired-models`, or a heading reading
  "Retired models" or "The following table lists the retired models"), so
  archive rows keep plain dates. Any other heading mentioning retirement
  beneath a qualifier stops the run.
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
- Offline runs read `test/fixture/vertex-model-versions.md`, or `vertex-ai.md`
  or `vertex-ai-lifecycle.md` in the fixtures directory. The recorded HTML page
  `test/fixture/vertex-model-versions.html` is kept for the HTML parser tests.

## Azure AI Foundry

The refresh reads the
[Azure retirement schedule](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule)
with `Accept: text/markdown` (`sourceHeaders`), which makes Microsoft Learn
return the page's Markdown source instead of HTML. This content negotiation is
undocumented. `Accept` is not a credential, so the fetch follows a redirect,
but only to another `https` URL, and the body must still be Markdown. Records
and the feed cite the same URL.
It runs only with `--distributor azure-ai-foundry`.

The Markdown is rendered as HTML and read by the HTML page parser, so the
footnote, section, and binding rules below apply to both. Pipe tables are read
with [`markdown.mjs`](#markdown-pipe-tables); ATX headings become headings;
consecutive prose lines become one paragraph, and a list item becomes an `li`.
A `^N^` footnote marker outside a code span becomes `<sup>N</sup>`, so a cell
`2027-04-14^3^` and a paragraph starting `^3^` read exactly as on the HTML page.

- The body must be Markdown. An HTML body (content negotiation stopped working),
  a raw HTML `<table>` outside fenced code, a setext heading, a misaligned pipe
  table, or the private-use characters U+E000 and U+E001 (reserved for the
  marker conversion) stop the run.
- An escaped marker (`\^3\^`) or one inside a code span stays literal text, so
  a retirement cell holding it is an invalid date. A footnote written as a list
  item is not a footnote paragraph and doesn't define the marker.
- Offline runs read `test/fixture/azure-model-retirement-schedule.md`, or
  `azure-ai-foundry.md` or `azure-ai-foundry-lifecycle.md` in the fixtures
  directory. `test/fixture/azure-model-retirement-schedule-paired.html` is the
  HTML page recorded with it, and the older
  `test/fixture/azure-model-retirement-schedule.html` is kept for the HTML
  parser tests.

Page rules:

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
- A retirement date may carry one `<sup>N</sup>` footnote marker. The footnote
  must be a `<p><sup>N</sup>` paragraph after the same table and before the
  next heading or table. Commented-out footnotes don't count. A footnote may
  say which offers the date covers, and its own paragraph must state the cell's
  date. Any other date in the footnote, or in notes before the first footnote
  or after the last one, must be earlier than the cell's date and already past
  on the refresh day (offers that have already retired). The refresh day is the
  UTC date of `MODEL_EOL_GENERATED` when it is set, and of the current time
  otherwise. The run stops on a later date, an earlier date that isn't past
  yet, a year outside a recognised date ("Q3 2027", "05/01/2027"), a missing or
  repeated footnote, and any other text after the cell's date.
- Any dated row, with or without a footnote, stops the run when wording that
  makes a date approximate ("no earlier than", "or later", "planned", "TBD",
  "until further notice", "tentative") appears in the notes after its table
  (up to the next heading or table) or in the section prose before it: the
  table's own section up to the table, and the intro of each enclosing section
  down from the `##` level. The page intro under the `#` title is not read,
  because it says the Replacement column is "the target for automatic
  upgrades". Rows without a date are not affected.
- Footnote markers in the version and lifecycle columns stop the run, and so do
  model-column markers in publisher sections.
- Fine-tuning tables and other unrelated tables are skipped. Header drift in a
  lifecycle table stops the run.
- Azure's status labels are mapped to `distributions[].status` as described in
  [SPEC.md](../SPEC.md#distributions).

### Azure models API cross-check

When `AZURE_MANAGEMENT_TOKEN` (a bearer token for
`https://management.azure.com`) and `AZURE_SUBSCRIPTION_ID` are both set, the
refresh also reads `GET /subscriptions/{id}/providers/Microsoft.CognitiveServices/locations/{location}/models?api-version=2026-11-01`
for `eastus`, `eastus2`, `swedencentral`, and `westus`. In November 2026 those
four locations together listed every OpenAI, Anthropic, Mistral, and Cohere
entry seen in twelve sampled locations; `eastus` alone missed 37 of them.
Fixture runs never read the API.

- Neither variable set: the cross-check is skipped with a notice and the run is
  unchanged.
- The cross-check can't change feed data, so its failure is not fatal by
  default: only one variable set, a subscription that isn't a GUID, a token
  with whitespace, any HTTP error (including 401 and 403), and any response the
  rules below reject print `warning: azure models API cross-check failed:
  <message>`, add a `cross-check-failed` source conflict to "Source conflicts",
  and the page is used without the cross-check. With
  `MODEL_EOL_CROSS_CHECKS=strict` the same failures stop the Azure source. Any
  value other than `strict`, `warn`, or empty stops the run. A failure to read
  the page always stops the run.
- An HTTP error reports only `HTTP <status> <error.code>`; the error body,
  which names the caller's client, object, and tenant IDs, is never printed.
  Every message from the cross-check shows the subscription as
  `{subscriptionId}`, any other GUID as `{guid}`, in any letter case, and never
  includes the token.
- Requests carry the token and refuse redirects. `nextLink` is followed up to
  20 pages per location; a link that leaves the models endpoint for that
  location, carries a username or password, repeats, or asks for a 21st page
  stops the run.
- A response without a `value` array, an entry without `model.format`, `name`,
  or `version`, a `lifecycleStatus` other than GenerallyAvailable, Preview,
  Deprecating, Deprecated, or Legacy, or a `deprecation.inference` that isn't a
  date at midnight UTC stops the run. OpenAI, Anthropic, Mistral AI, and Cohere
  entries must also have names and versions that pass the identifier grammar.
  A `deprecation.inference` in 2099 or later is Azure's placeholder for "no
  retirement date" and counts as no date.
- Entries bind by `format` (OpenAI, Anthropic, Mistral AI, Cohere) and name the
  way page rows do: OpenAI dated and four-digit versions use the snapshot ID,
  and every other version and publisher uses the bare name, so hosting versions
  collapse. Names are compared case-sensitively. Other formats are counted but
  not compared. An entry is compared with the page row for its own version when
  the page lists one (the page keeps only the earliest row per model, so
  `claude-haiku-4-5` version 2 is compared with the version 2 row, not version
  1), and with the kept record otherwise.
- The page stays authoritative and the API creates no records. A source
  conflict is listed, with a notice, when an API date differs from the page
  row's date (including a page row with no date), when the page has a date and
  the API calls the model GenerallyAvailable or Preview with no date, or when
  the API lists an entry the page doesn't and that entry is Deprecating,
  Deprecated, or Legacy, or has a date. Each distinct page row, status, and
  date is one conflict that names its API versions and locations. Conflicts
  never fail the run.
- A date that differs from the page by exactly one day is still a conflict,
  but these share one notice (`N entries differ from the retirement page by
  exactly one day`) and one bullet in "Source conflicts" with a nested list of
  the entries. In November 2026 six entries (`claude-sonnet-4-5` and five
  Cohere models) were one day after the page's date, a steady offset that
  would otherwise sit among the conflicts that need a look.
- One summary notice follows: `azure models API: N entries in L locations; N
  deprecating/deprecated/legacy; N conflicts with the retirement page; N
  entries differ by exactly one day`. The conflict count excludes the one-day
  differences.
- The comparison is `reconcileAzureModelsApi` in `azure-models-api.mjs`. It
  returns the page records unchanged, so letting API dates win later is a
  change to that one function.

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
3. Run `node refresh/shapes.mjs --write` so the structure snapshot covers the
   new page. The check reads every provider's deprecations URL and every
   distributor's `sourceFetchUrl` (or `sourceUrl` when it has none), and the
   tests fail until the snapshot matches.
4. Regenerate the feeds from the live pages with `node refresh/refresh.mjs`
   (add `--distributor ...` for a distributor parser), and include the semantic
   diff in the PR description. Don't commit feeds
   generated with `--fixtures`.

The test rules in [CONTRIBUTING.md](../CONTRIBUTING.md#tests) apply: no
network, and no assertions on live feed values.
