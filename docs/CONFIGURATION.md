# Configuration

The CLI, the GitHub Action, and the bot read one policy file, `.model-eol.json`,
from the root of the target Git repository. If you pass targets in several
repositories that each have their own `.model-eol.json`, the CLI stops and asks
you to choose one with `--config FILE`.

Command-line flags and Action inputs override the file. Unknown keys and
invalid values are errors, not warnings. The schema is
[`schema/model-eol.bot-config.schema.json`](../schema/model-eol.bot-config.schema.json),
and `model-eol validate .model-eol.json` also checks the rules that JSON Schema
can't express.

Adding a config file changes the CLI's defaults. Without one, the CLI fails on
cloud and gateway references too (`scope: all`). With one, any key you leave out
takes the bot's defaults: 90 days, `scope: direct`, and the publisher's dates.

## Keys

```json
{
  "days": 90,
  "scope": "direct",
  "via": null,
  "ignore": {
    "models": ["o3-deep-research"],
    "paths": ["test/fixtures/**", "data/catalog"]
  },
  "waivers": [],
  "overrides": [],
  "routes": [],
  "issues": { "enabled": true },
  "eval": { "command": "node scripts/model-eol-eval.mjs" },
  "feeds": { "allow_vendored_fallback": false }
}
```

| Key | Meaning |
|---|---|
| `days` | Threshold. A model retiring within this many days is a finding. |
| `scope` | `direct` fails only on references the scanner can prove. `all` also fails on cloud and gateway references. |
| `via` | Channel whose dates apply, for example `aws-bedrock`, `azure-ai-foundry`, or `vertex-ai`. `null` means the publisher's own API. The gateways `openrouter`, `litellm`, `portkey`, and `ai-gateway`, and any channel named in a feed, are also accepted. |
| `ignore` | Models and paths to leave out of every report. See below. |
| `waivers` | Accepted exceptions that stay visible but stop failing. See below. |
| `overrides`, `routes` | Per-path settings for monorepos. See below. |
| `issues.enabled` | Whether the bot opens issues for findings it can't patch and for unresolved cloud and gateway references. |
| `eval` | The bot's per-migration test command. See [BOT.md](BOT.md#the-eval-hook). |
| `feeds.allow_vendored_fallback` | When the bot is given remote feeds with `model-eol-bot --feeds-url URL[,URL...]` and the download fails, continue with the bundled feeds in report-only mode instead of stopping. |

## Ignores

`ignore` is for references that aren't live dependencies: test fixtures,
caches, generated catalogs, vendored code. Ignored references don't appear in
any report.

- `ignore.models` takes canonical IDs or aliases. Either one ignores the whole
  family, so `o3-deep-research` also covers `o3-deep-research-2025-06-26`.
- `ignore.paths` takes repository-relative globs with `*`, `**`, and `?`, or a
  plain directory path such as `data/catalog`, which covers everything under it.
  Matching files are excluded before scan coverage is counted. Outside a Git
  repository, an ignored directory is still walked, so an unreadable directory
  inside it still reports incomplete coverage.

Some directories are always skipped, so they don't need an ignore:
`node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`, `logs`, `tmp`,
`.git`, `.venv`, `venv`, `__pycache__`, `.next`, `.astro`, `.worktrees`,
`.terraform`, `.tox`, and the `.mypy_cache`, `.ruff_cache`, and `.pytest_cache`
directories.

## Waivers

A waiver records a decision to keep using a model on purpose. Unlike an ignore,
it never hides the finding.

```json
{
  "model": "o3-deep-research",
  "paths": ["research/**"],
  "reason": "Research pipeline pinned until the Q4 rerun.",
  "owner": "@research-platform",
  "expires": "2026-12-31"
}
```

The finding still appears in `check`, `inventory`, `schedule`, `alert`, `plan`,
and the CycloneDX export, with the waiver attached:

```
✗ research/app.py:2  o3-deep-research  RETIRED 2026-07-23 (92 days ago) -> gpt-5.6-sol  [still answers via azure-ai-foundry until 2026-11-19]  [waived until 2026-12-31 by @research-platform: Research pipeline pinned until the Q4 rerun.]
```

While the waiver is active, the finding doesn't count toward the exit code,
badge counts, or alert errors, and the bot opens no work for it. On the expiry
date the finding fails again, and the report names the waiver that lapsed and
its owner. Expiry is compared in UTC, and a waiver is already expired on its
`expires` date.

- `model` covers the whole alias family, like `ignore.models`.
- `paths` works like `ignore.paths`, including plain directory paths.
- `via` limits the waiver to one channel. Use `publisher` for the publisher's
  own API, and `publisher-fallback` for findings that fell back to the
  publisher's date under `--via` (a `publisher` waiver doesn't cover those).
  Leave `via` out to waive every channel.
- When several waivers match, the first active one applies.
- A policy can hold at most 500 waivers, counting the root and all overrides.

`reason`, `owner`, and an absolute `expires` date are required. A missing owner
or a relative date such as `90d` is a config error. An expired waiver is not an
error; it just stops applying. The CycloneDX export records each component's
waiver state in the `model-eol:waiver_active` property as `true`, `partial`, or
`false`.

When a waiver expires, the bot opens new work for findings it had closed
because of the waiver. See [BOT.md](BOT.md#keeping-track-of-its-own-work).

## Monorepos

Top-level values are defaults. `overrides` change settings by path, and
`routes` choose a channel per reference:

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

- `paths` in overrides and routes are globs only. A plain directory path such
  as `services/bedrock` matches nothing there; write `services/bedrock/**`.
- Every matching override applies, in order. For single values like `days`,
  the last match wins.
- `ignore` and `waivers` inside overrides add to the root lists rather than
  replacing them.
- For routes, the last match wins.
- A route with `match` and `model` tells the scanner that a deployment alias
  (here `chat-prod`) serves a known model, so the reference is reported with
  that model's dates. A routed reference still counts as cloud or gateway
  usage: it fails CI only where `scope` is `all` (in the example, through the
  `services/**` override), and the bot never patches it, because the string in
  the code is the alias, not the model ID.
- Command-line flags and Action inputs still override everything here.

JSON output from `inventory` and `plan` records the threshold, scope, channel,
and matching override and route indexes for each reference, so you can see
which rule applied.

## What the scanner reads

The scanner reads source and config files. [`CODE_EXT` in
`lib/scanner.mjs`](../lib/scanner.mjs) is the exact list. It includes Python,
TypeScript and JavaScript, JSON, YAML, TOML, shell, Ruby, Go, Java, C#, Rust,
C and C++, PHP, Swift, Kotlin, Scala, Objective-C, SQL, Terraform (`.tf`,
`.tfvars`), BAML, and `.env` files.

It skips:

- Markdown, text, and reStructuredText files, unless you pass `--include-docs`.
- Generated files: those whose first 8 KiB contain a `Code generated ... DO NOT
  EDIT` or `AUTO-GENERATED FILE ... DO NOT EDIT` header, a line starting with
  `@generated`, or the BAML generator banner.
- model-eol's own JSON reports, so a rerun doesn't find the previous run's
  output. Third-party CycloneDX files are scanned unless their metadata names
  model-eol as the generator.
- The always-skipped directories listed under [Ignores](#ignores).

A BAML client whose `provider` is a publisher's own API, such as
`provider openai`, counts as a direct API call, so `plan` can patch its model
ID.

## Incomplete coverage

When the scanner can't read part of the target, it reports incomplete
coverage, and `check` and `plan` exit 2. The causes are:

| Reason | What happened |
|---|---|
| `submodule-skipped` | A Git submodule. The scanner doesn't enter it. |
| `nested-repository-skipped` | A nested Git repository that isn't a submodule. |
| `file-too-large` | A file over 2 MiB. |
| `invalid-utf8` | A file that isn't valid UTF-8. |
| `symlink-skipped` | A symbolic link. Links are never followed. |
| `unreadable-file`, `unreadable-path`, `unreadable-directory` | A permissions or I/O error. |
| `file-count-cap` | More than 100,000 files. |
| `git-listing-failure` | `git ls-files` failed. |

For each one, ignore the path, pass `--allow-incomplete`, or (for submodules
and nested repositories) scan that checkout as its own target with its own
policy.

For a repository with a lot of content, start with `inventory` to see what the
scanner finds. Then add `ignore.paths` for caches, catalogs, archived fixtures,
and docs that aren't live dependencies.
