# The bot

`model-eol-bot` is a scheduled GitHub workflow that opens PRs and issues for
findings. For each retiring model it keeps one migration PR open. Findings it
can't patch are grouped into issues by model, shutdown date, and channel. It
never merges anything.

The bot ships in the same npm package as the CLI. Consumer repositories don't
copy any model-eol source; the workflow installs the published package.

## Setup

1. Copy [`bot.yml.example`](../bot.yml.example) to
   `.github/workflows/model-eol-bot.yml`. It runs every Monday and can also be
   started by hand. Each of its three jobs already declares the permissions it
   needs.
2. Optionally add `.model-eol.json` (see [CONFIGURATION.md](CONFIGURATION.md)).
   The bot reads the same policy as the CLI. Without a config it uses 90 days
   and `scope: direct`.
3. Optionally add an eval command (see [below](#the-eval-hook)).
4. Recommended: store a fine-grained PAT or a GitHub App token as the
   `MODEL_EOL_BOT_TOKEN` secret, with read and write access to contents, pull
   requests, and issues (the same access the publish job asks for). PRs opened
   with the default `GITHUB_TOKEN` don't trigger `pull_request` workflows, so
   your CI won't run on them. The PR body says so when that applies.

To preview what the bot would do, with no GitHub calls:

```sh
npx --yes --package=model-eol@0 model-eol-bot --dry-run --target-dir . --repo OWNER/REPO
```

That command works only when no eval command is configured. With an eval
configured, use the [local evaluation run](#run-the-evaluation-locally) instead.

The bot exits 0 when everything it planned was published or skipped, 1 when any
migration is blocked (a failed eval, a lease or label problem, a conflict, or a
report-only run), and 2 on errors.

The bot uses the feeds bundled in the npm package it runs, and the example
workflow relies on that. `model-eol-bot --feeds-url URL[,URL...]` downloads
feeds instead, but the publish job checks the plan and the eval results against
the feeds it loads. All three jobs must therefore use the same feed content: the
plan job would also need those feeds, passed to `model-eol plan` with
`--feeds DIR`. The example workflow sets
`concurrency: model-eol-bot` so two scheduled runs never overlap. If you start
the bot some other way as well, make sure those runs can't overlap either.

## What it opens

The bot runs `plan` and sorts findings into two kinds.

A finding becomes a **migration PR** only when all of these hold:

- The reference is a direct API call and the scanner is confident about it.
- The model is retired, or retires within the threshold.
- The feed names a `replacement` from the same publisher, that replacement is
  in the loaded feeds, and it isn't retiring itself.
- The date comes from the channel's own entry, not from `publisher-fallback`.

Other retired or retiring findings become **issues**: generic model
references, references whose date came from `publisher-fallback`, and models
whose feed entry offers only `replacement_options` or a `replacement_note`.

Cloud and gateway references also become issues, one per provider, whether or
not a retirement is known, because someone has to check which model is behind
the deployment name. A `routes` entry maps an alias on the line where it
appears, but the provider's other references stay, and so does the issue.
Ignore the path or set `issues.enabled: false` to stop them.

Waived findings, findings outside the threshold, and candidates (strings that
look like model IDs but aren't in any feed) never create work.

There is one PR per model and channel. Its branch name is deterministic:
`model-eol/<publisher>/<via>/<model-slug>-<hash>`, with the `<via>` part left
out for the publisher's own API. The PR body lists the announced and shutdown
dates, days remaining, sources, feed notes, the channel, and the date the
replacement was read from the feed. Replacements can change during a notice
period, so that date matters. When the model still answers on another channel,
the body also has a "Capture window" section with that channel and date, and it
says so when the feed gives no window.

## Keeping track of its own work

The bot keeps no state outside GitHub. Each PR and issue it owns carries the
`model-eol` label and a JSON metadata block in an HTML comment on the first line
of the body. The block holds the model, shutdown date, replacement, channel,
feed digest, and the base and head commits.

The bot trusts an existing PR or issue only when the label, the metadata, the
repository, the base branch, the branch name, and the recorded head commit all
agree. A hand-written comment that looks like the metadata block can't make the
bot skip a finding. Before it pushes to or skips an existing branch, the bot
fetches the branch again and checks it against the recorded lease: the head
commit it last pushed and its committer email,
`model-eol[bot]@users.noreply.github.com`. Anyone with push access can forge
both, so the lease guards against stale runs and accidental edits, not against
a collaborator acting in bad faith.

On its first run with something to open, the bot creates the `model-eol` label.
If repository policy stops it from creating or applying the label, the bot stops
and exits non-zero. Unlabeled work would let anyone forge ownership later.

Lifecycle rules:

- **Dismissal.** Closing a bot PR or issue without merging means "don't reopen
  this". The bot stays quiet until the shutdown date or the replacement changes.
- **Cleanup.** When a finding disappears, gets ignored or waived, or the feed
  retracts its date, the bot comments on its PR or issue and closes it.
- **Reintroduction.** A model that was migrated and then added back gets new
  work. A merged migration doesn't suppress it.
- **Expired waivers.** Work the bot closed because of a waiver comes back as new
  when the waiver expires. A PR or issue that a person closed before the waiver
  stays dismissed.

## The eval hook

A model swap can pass your unit tests and still change behavior, so the bot can
run a command you choose against each proposed migration. With an eval command
configured, only migrations that pass get a PR. Your command decides what counts as good enough; model-eol has
no scorer or judge model of its own.
[DESIGN_EVAL_BOUNDARY.md](DESIGN_EVAL_BOUNDARY.md) explains why.

### Configure it

```json
{
  "eval": {
    "command": "node scripts/model-eol-eval.mjs",
    "timeout_ms": 600000,
    "max_report_bytes": 65536,
    "pass_env": ["OPENAI_API_KEY"]
  }
}
```

A non-empty `MODEL_EOL_EVAL_COMMAND` repository variable overrides
`eval.command`. With neither set, the result manifest records that no eval was
configured, and PRs open without an eval result.

`timeout_ms` defaults to 600000 (10 minutes) and may be 1000 to 3600000.
`max_report_bytes` defaults to 65536 and may be up to 8388608.

Your command always gets `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, and `SHELL`,
plus the variables below. `pass_env` lists any others it may see. Names that
look like GitHub, Actions, SSH, or AWS secrets, or that contain `TOKEN`,
`SECRET`, `PASSWORD`, or `CREDENTIAL`, are refused. Any provider key you list
must also be added as a secret to the evaluate job in the workflow.

### What the command receives

The bot applies each migration in its own temporary checkout and runs the
command there with:

- `MODEL_EOL_OLD_ID` and `MODEL_EOL_NEW_ID`: the model being replaced and its
  replacement.
- `MODEL_EOL_PLAN`: a one-model plan with the exact references that changed.
- `MODEL_EOL_REPORT`: the path where the command must write a Markdown report.
- `MODEL_EOL_VIA`: the channel the plan was built for, or empty for the
  publisher's API. The feed's replacement is the publisher's model ID; on
  Bedrock or Azure your client may use a different string, and this tells you
  which mapping to apply.
- `MODEL_EOL_EVAL_MODE`: always `evaluate`. The value `capture` is reserved for
  a possible future run against the old model. The bot doesn't run it, and any
  other value is refused.

A migration passes when the command exits 0 and has written a regular file at
`MODEL_EOL_REPORT`. It fails on any other exit code, a timeout, a missing
report, a change to tracked files, a new untracked file that isn't gitignored,
a change to the `MODEL_EOL_PLAN` file, or a change to the checkout's commit.
The report is embedded in the PR body, so keep secrets out of it. The command's
stdout and stderr are never published.

A failed migration gets no PR. If an earlier PR for it is open, the bot closes
it, and it opens an issue with the failure when issues are enabled. Other
migrations in the same run still go ahead.

### Write a harness

Copy [`examples/model-eol-eval.mjs`](../examples/model-eol-eval.mjs) to
`scripts/model-eol-eval.mjs`. It calls `npm run eval:model-eol`, so you need to
add that script to `package.json` and point it at a test that exercises model
behavior. The separate script name is deliberate: it stops an unrelated unit
suite from passing as an LLM eval by accident. Don't point `eval:model-eol` back
at the harness, or it will call itself.

A useful test checks the response or tool-call shape, structured-output
parsing, any capability you depend on, and a few golden tasks. A green build is
supporting evidence, but it says little about how the new model behaves.

### Run the evaluation locally

Before you turn on the scheduled workflow, commit the harness and the policy on
a clean branch, then run the same evaluator locally. From the repository root,
the script below:

1. Finds the newest published `0.x` version and uses it for every step, as the
   workflow does.
2. Builds a plan with your `.model-eol.json`, or with the bot's defaults if you
   have none.
3. Runs `model-eol-bot evaluate`, which applies each migration in a temporary
   checkout and runs your eval command.
4. Prints the results, then runs the bot in dry-run mode with those results so
   you can see which PRs and issues it would open.

```bash
set -euo pipefail
repo="$(pwd -P)"
version="$(npm view model-eol@0 version --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);const r=Array.isArray(v)?v.at(-1):v;if(typeof r!=="string")process.exit(1);process.stdout.write(r)})')"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
cd "$tmp"
if [ -f "$repo/.model-eol.json" ]; then
  MODEL_EOL_UAT_REPO="$repo" npx --yes --package="model-eol@$version" \
    -c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan .' > "$tmp/plan.json"
else
  MODEL_EOL_UAT_REPO="$repo" npx --yes --package="model-eol@$version" \
    -c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan . --days 90 --scope direct' > "$tmp/plan.json"
fi
npx --yes --package="model-eol@$version" model-eol-bot evaluate \
  --target-dir "$repo" \
  --plan-file "$tmp/plan.json" \
  --output-file "$tmp/eval.json"
node -e 'const r=require(process.argv[1]); console.log(r.results)' "$tmp/eval.json"
MODEL_EOL_EVAL_RESULTS_FILE="$tmp/eval.json" \
  npx --yes --package="model-eol@$version" model-eol-bot \
    --dry-run --target-dir "$repo" --repo OWNER/REPO
```

The script runs `npx` from a temporary directory, so a local package that
happens to be named `model-eol` can't shadow the published one. The temporary
files are deleted when the shell exits; copy `eval.json` somewhere else first
if you want to keep it.

## Security model

The workflow has three jobs with different privileges:

| Job | Can write to the repo | Sees provider keys | Runs your eval code |
|---|---|---|---|
| plan | no | no | no |
| evaluate | no | only those you add | yes |
| publish | yes | no | never |

The evaluate job writes a result manifest with one pass, fail, or timeout
record per migration. The manifest is bound to the evaluated commit, the plan,
the eval settings, and the feeds by digest. The publish job rebuilds the plan,
checks the manifest against it, and refuses to publish if the default branch
has moved past the evaluated commit. It publishes the migrations that passed
and marks the rest as blocked. If an eval is configured and the manifest is
missing, it fails before any GitHub API call.

`pass_env` filters the environment that normal child processes get. It is not
an OS sandbox. Your eval code and its dependencies run as the same user as the
rest of the evaluate job and are trusted there. The privilege boundary is
between jobs: the job running your code has no write token, and the job holding
the write token never runs your code. Reports are treated as untrusted text: they
are size-limited and fenced when embedded in a PR.

For HTTPS remotes, including private repositories, the bot passes
`GITHUB_TOKEN` to Git as a host-scoped authorization header. It never puts the
token in a remote URL.

To report a security problem, see [SECURITY.md](../SECURITY.md).

## Upgrading from inline `--eval`

Older setups ran the eval inline with `model-eol-bot --eval` and wrote unbound
report and status files. Both are now refused, because separating environment
variables isn't a privilege boundary when evaluation and publication share a
user and a write token. Move to the plan, evaluate, and publish jobs in
`bot.yml.example`.
