# Design - the eval boundary (what model-eol verifies, and what it does not)

Status: decided 2026-09-09 (issue #98). This note records the line so that
future requests for "evals inside model-eol" start from the reasoning, not from
scratch.

## The decision

model-eol owns two things around migration verification:

1. **The deadline.** The feeds carry the date a model stops answering on each
   clock: the publisher's API, and each distributor (Bedrock, Azure, Vertex).
   An exact date is the last day a baseline can be captured from the old
   model. A tentative or earliest floor is only "at least until": the old
   model may answer past it, and the bot words it that way. On the applied
   clock the date is the finding's `shutdown`. When the feed lists
   another clock on which the model still answers, `check` appends
   `[still answers via <channel> until <date>]` to the retiring or retired
   line, and the bot adds a `## Capture window` section to every PR and issue
   it opens. The value comes from the feed only. When the feed has no date,
   model-eol says nothing. The `check --json` document does not carry a
   `capture` field yet: the 0.1 report shape published by 0.5.2 is kept
   byte-compatible for default output, and adding the field is a separate
   contract decision.
2. **The eval-hook contract.** The bot runs one repository-owned command on the
   patched checkout and passes `MODEL_EOL_OLD_ID`, `MODEL_EOL_NEW_ID`,
   `MODEL_EOL_PLAN`, `MODEL_EOL_REPORT`, `MODEL_EOL_VIA`, and
   `MODEL_EOL_EVAL_MODE`. Exit zero plus a report file is a pass. That is the
   whole verification interface.

model-eol does not own verification itself. It ships no comparator, no
per-case results schema, no starter case set, no scorer, and no judge model.
Those live in the repository's own eval command and CI, or in tools built for
that job (promptfoo, Inspect AI, and the like).

## Why the line sits here

- **The Dependabot pattern.** Dependabot opens the PR; the repository's CI
  decides. model-eol already works that way through the eval hook. Moving the
  decision into model-eol would make it the first part of the tool that
  guesses.
- **The hard parts are verification-domain problems, not lifecycle-data
  problems.** A design pass on golden capture and replay found that every deep
  question belongs to the eval side: which cases to run, how to score prose,
  how many runs make a baseline stable, how much API budget a run may spend,
  and how to map a publisher's model ID to a distributor's client ID. None of
  those has settled numbers in the published literature or vendor guidance.
  model-eol has no data that would improve them.
- **Zero dependencies.** Calling model APIs from model-eol would need SDKs,
  keys, and per-vendor request formats. That ends the zero-dependency
  contract that keeps the tool auditable.
- **No customer with a case set.** As of the decision, no consumer had a real
  case set to design against. A comparator built without a user is
  speculation.

## What the feeds can say, and what they cannot

The feed answers "until when does this model answer on this clock". It does
not answer "how close is the replacement". A model retired on the publisher
clock can still answer on Bedrock or Azure for months; `capture.alternatives`
lists those clocks with their dates. That is the one verification-adjacent
fact only this data set gives, so it is the one model-eol reports.

Distribution rows carry no replacement ID. The feed's `replacement` is the
publisher's ID (for example `claude-sonnet-4-6`). A repository that calls
Bedrock holds a different string for the same weights. An eval command that
replays against the replacement on a distributor must map the publisher ID to
its own client ID. `MODEL_EOL_VIA` tells the command which channel the plan was
built for so it can do that mapping.

## The reserved `capture` mode

`MODEL_EOL_EVAL_MODE` is `evaluate` today. The value `capture` is reserved for
a run on the unpatched checkout against the old ID, so a command could record
a baseline before the capture window closes. The bot does not run capture
mode, and `runEvalHook` refuses any mode other than `evaluate`. The name is
reserved so that a future opt-in does not have to change the contract.

## What would reopen this

A consumer with a real case set, a concrete regressed-item gate they already
use, and a request for model-eol to schedule (not score) the capture run before
the deadline. Even then the scoring stays in the consumer's command. The
candidate addition would be an opt-in capture run keyed by old ID and case-set
hash, run at most once per key, with the existing timeout as the only cap
model-eol can enforce.
