# Receipts and `verify`

model-eol writes three kinds of receipt. Each one records what a step did and
binds it to exact inputs by digest, so someone else can check the claim later
without trusting the run that wrote it.

| Receipt | `schema` value | Written by (artifact name) | What it binds |
|---|---|---|---|
| [Eval results manifest](https://thossullivan.github.io/model-eol/schema/0.1/model-eol.eval.schema.json) | `model-eol.eval/0.1` | `model-eol-bot evaluate` (`model-eol-eval-results`) | One pass, fail, or timeout result per migration, tied to the evaluated base commit, the plan digest, the eval settings digest, and each migration's feed digest. |
| [Feed-refresh receipt](https://thossullivan.github.io/model-eol/schema/0.1/model-eol.feed-refresh-receipt.schema.json) | `model-eol/feed-refresh-receipt@0.1` | the weekly feed refresh (`feed-refresh-receipt`) | The run URL, the checked commit, and the check time, tied to the SHA-256 of every `feeds/*.json` file. A pending receipt also names the open feed PR. |
| [npm release result](https://thossullivan.github.io/model-eol/schema/0.1/model-eol.npm-release-result.schema.json) | `model-eol/npm-release-result@0.2` | the release workflow (`npm-release-result`) | The source commit, and either "no release" or the exact version, tag, release commit, and sha512 integrity of the registry tarball. |

Each receipt is uploaded as a workflow artifact with the name shown, so you can
fetch one with
`gh run download RUN_ID --repo OWNER/REPO --name ARTIFACT_NAME`.

There are two commands for receipts:

- `model-eol validate receipt.json` checks structure only. It picks the schema
  from the receipt's `schema` value.
- `model-eol verify receipt.json` checks what the receipt claims against files
  and values you supply.

## Examples

```bash
# a release result, against the exact tarball you hold (no registry lookup)
npm pack model-eol@X.Y.Z
model-eol verify npm-release-result.json --package model-eol-X.Y.Z.tgz \
  --commit RELEASE_SHA --source-commit SOURCE_SHA --version X.Y.Z --require-all

# a refresh receipt, against a checkout's feeds directory
model-eol verify feed-refresh-receipt.json --feeds-dir ./feeds \
  --commit REFRESH_SHA --run-url https://github.com/OWNER/REPO/actions/runs/ID

# an eval manifest, against the plan, config, and feeds the evaluator used
model-eol verify eval-results.json --commit BASE_SHA --plan plan.json \
  --config .model-eol.json --feeds-dir ./feeds
```

`verify` first validates the receipt's structure, then reports on each claim.
It never reads the current directory, Git state, or the network. Every input is
an explicit flag.

## Flags

| Flag | Checks |
|---|---|
| `--feeds-dir DIR` | Refresh receipts: the SHA-256 of every `DIR/*.json`, compared with the receipt's list as a set, so changed, missing, and extra files are all mismatches. `DIR` must be the feeds directory itself; a repository root is refused. Eval manifests: together with `--plan` and `--config`, recomputes each result's `feed_digest`. |
| `--commit SHA` | `refresh_commit`, `release_commit`, or the eval manifest's `base_sha`. |
| `--run-url URL` | `refresh_run`, after the same URL normalization the writer applies. |
| `--package FILE.tgz` | `registry_integrity`: the sha512 SRI of the tarball's bytes. |
| `--source-commit SHA` | `source_commit` of a release result. |
| `--version X.Y.Z` | `version` of a release result. `tag` must then be `vX.Y.Z`. |
| `--plan FILE` | The eval manifest's `plan_digest`, from a valid `model-eol.plan/0.1` document. |
| `--config FILE` | The eval manifest's `eval_config_digest` and `configured` value, resolved the same way the bot resolves settings. `MODEL_EOL_EVAL_COMMAND` in the environment overrides `eval.command`, and the output says when it did. For a repository with no `.model-eol.json`, pass a file containing `{}`. |
| `--require-all` | Exit 1 when the result is `partial`. |
| `--json` | Print a [`model-eol/verification@0.1`](https://thossullivan.github.io/model-eol/schema/0.1/model-eol.verification.schema.json) document. |

A SHA is 40 to 64 hex characters, and uppercase is accepted. A flag that
doesn't apply to the receipt's kind is a usage error.

## Results

Each claim comes back as one of:

- `verified`: the receipt matches what you supplied.
- `mismatch`: it doesn't. The output shows both values.
- `not-checked`: you didn't pass the flag that would check it. The output names
  the flag.
- `not-applicable`: the claim doesn't exist for this receipt. A release result
  with `released: false` makes no release claims, so only `source_commit`
  applies.

The overall result is `verified` when every applicable claim is verified, and
`mismatch` when any claim mismatched. It is `partial` when nothing mismatched
but something wasn't checked: the receipt agrees with what you gave it, but you
haven't proven all of it.

Some details matter if you build a gate on this:

- **Release gates** should pass `--package`, `--version`, `--commit`, and
  `--require-all`. If you pass `--commit`, `--version`, or `--package` for a
  `released: false` receipt, verify adds a `released` claim that mismatches,
  because those inputs say a release happened. Without them, a no-release
  receipt could verify through `--source-commit` alone.
- **Eval manifests**: `--plan` and `--config` together fix which results the
  evaluator had to produce. A missing result, a result nobody planned, and a
  duplicated result are each a mismatch. Without both flags the `results` claim
  is `not-checked`, so a manifest with results removed can't verify.
- **Refresh receipts** show their `state`, `checked_at`, and `pending_pr` for
  information. A pending receipt verifies by the same rules as a clean one.
- **Eval outcomes are not claims.** `verify` doesn't check `status`,
  `exit_code`, `report`, or `generated`, because an eval can't be rerun
  offline. A `verified` eval manifest is bound to the commit, plan, config, and
  feeds you supplied. It does not mean the evals passed. A gate that needs
  passing evals has to read the results itself.

Text output escapes control characters in every value it prints.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Nothing mismatched: `verified`, or `partial` without `--require-all`. |
| 1 | A claim mismatched, or the result was `partial` with `--require-all`. |
| 2 | Usage error, unreadable file, structurally invalid receipt, or an unsupported schema or version. No claims are reported. |
| 3 | Writing the output failed, when the result would otherwise have exited 0. |

## Versioning

Adding an optional field keeps a receipt's version. Anything that would make an
old receipt invalid, or that changes what a digest covers, gets a new version.
Validators reject versions they don't know.

A few rules can't be written in JSON Schema Draft-07, such as the sort order of
feeds or `tag` being `v` plus `version`. Each schema's `description` lists
them, and `validate` enforces them in code.
