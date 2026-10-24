# What model-eol verifies, and what it doesn't

Decided 2026-09-09 in issue #98. This note records where the line sits, so a
future request for "evals inside model-eol" can start from the reasoning.

## The decision

model-eol owns two things around verifying a migration: the deadline and the
eval-hook contract.

### The deadline

The feeds carry the date a model stops answering on each channel: the
publisher's own API, and each distributor (Bedrock, Azure AI Foundry, Vertex AI).
An exact date is the last day you can record a baseline from the old model. A
tentative or earliest date only means "at least until": the old model may
answer past it, and the bot says so in those words.

On the channel being checked, that date is the finding's `shutdown`. When the
feed lists another channel where the model still answers, `check` adds
`[still answers via <channel> until <date>]` to the retired or retiring line,
and the bot adds a "Capture window" section to its migration PRs and issues.
The value comes only from the feed. When the feed has no date for any other
channel, `check` adds nothing, and for a retired model the bot's section says it
can't state a
capture window.

`check --json` doesn't include the capture window yet. Adding it would change
the published 0.1 report shape for default output, and that is a separate
contract decision.

### The eval-hook contract

The bot runs one repository-owned command on the
patched checkout and passes it `MODEL_EOL_OLD_ID`, `MODEL_EOL_NEW_ID`,
`MODEL_EOL_PLAN`, `MODEL_EOL_REPORT`, `MODEL_EOL_VIA`, and
`MODEL_EOL_EVAL_MODE`. Exit 0 with a report file is a pass. That is the whole
verification interface. [BOT.md](BOT.md#the-eval-hook) has the details.

model-eol does not do the verification itself. It has no comparator, no
per-case results schema, no starter case set, no scorer, and no judge model.
Those belong in the repository's own eval command and CI, or in tools built for
the job, such as promptfoo or Inspect AI.

## Why the line is here

Dependabot opens a PR and leaves the decision to the repository's CI, and
model-eol already works the same way through the eval hook. If model-eol scored
migrations itself, it would be guessing about behavior it can't observe.

A design pass on capturing and replaying golden outputs found that every hard
question was about evaluation: which cases to run, how to score prose, how many
runs make a stable baseline, how much API budget a run may spend, and how to
map a publisher's model ID to a distributor's. None of these has settled
answers in published research or vendor guidance, and model-eol's lifecycle
data doesn't help answer them.

Calling model APIs would also mean SDKs, keys, and per-vendor request formats,
which would end the zero-dependency rule that keeps the tool easy to audit. And
when this was decided, no consumer had a real set of eval cases to design
against, so a comparator would have been built without a user.

## What the feeds can and can't say

A feed says how long a model keeps answering on each channel. It says nothing
about how close the replacement is. A model retired on the publisher's API can
keep answering on Bedrock or Azure for months, and the capture window lists
those channels and dates. The capture window is the only verification fact the
feeds can supply, and it is the only one model-eol reports.

Distribution entries carry no replacement ID. The feed's `replacement` is the
publisher's ID, for example `claude-sonnet-4-6`, while a repository that calls
Bedrock uses a different string for the same model. An eval command that
replays against the replacement on a distributor has to map the publisher ID to
its own client ID. `MODEL_EOL_VIA` tells the command which channel the plan was
built for so it can do that.

## The reserved `capture` mode

`MODEL_EOL_EVAL_MODE` is always `evaluate` today. The value `capture` is
reserved for a run on the unpatched checkout against the old model, so a
command could record a baseline before the window closes. The bot doesn't run
capture mode, and the hook refuses any value other than `evaluate`. Reserving
the name now means a future opt-in won't need a contract change.

## What would reopen this

A consumer with a real case set, a regression gate they already use, and a
request for model-eol to schedule the capture run before the deadline, but not
to score it. Even then, scoring would stay in the consumer's command. The
likely addition is an opt-in capture run keyed by old model ID and case-set
hash, run at most once per key, with the existing timeout as the only limit
model-eol can enforce.
