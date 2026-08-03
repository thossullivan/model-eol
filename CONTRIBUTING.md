# Contributing to model-eol

Thanks for your interest in model-eol - a machine-readable deprecation feed
format for AI models, plus the tooling that turns it into a Dependabot for
models. This guide covers the contributions the project most needs and the
conventions it holds to.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

## The most valuable contribution: feed corrections

Found a wrong date, a missing model, or a retirement we don't carry? That is
exactly the signal this project runs on. One rule matters:

**Feeds are generated - never hand-edit `feeds/*.json`.** Every entry comes
from `refresh/` parsing a provider's live page or endpoint. A hand-edited date
would be silently overwritten by the next weekly refresh.

Instead:

- **Wrong or missing data, source exists** - open an issue with the model ID,
  the channel (publisher or distributor), the correct value, and the URL that
  states it. If the parser should have caught it, that URL is the failing case.
- **Parser gap** - fix it in `refresh/providers.mjs` or
  `refresh/distributors.mjs`, add a fixture under `refresh/test/fixture/`, and
  regenerate with `node refresh/refresh.mjs`. The semantic diff it prints is
  your PR description.
- **New publisher or distributor** - the highest-value PR there is. Copy the
  shape of an existing parser: strict table identity, model-ID grammar
  validation, refusal over guessing. A parser that cannot be certain must
  throw, not produce plausible data.

If you work at a model provider: you can make the scraping unnecessary by
serving your own feed at `/.well-known/model-eol.json`. `SPEC.md` is small on
purpose. Open an issue - that conversation is the whole point of the project.

## Development setup

Node 20+, nothing else. There are no dependencies to install - not for the
tool, not for development.

```bash
git clone https://github.com/thossullivan/model-eol
cd model-eol
npm test
```

## Quality gates

`npm test` composes all four suites (checker, refresh, bot, changelog) plus
feed validation - it must pass, offline, with no API keys. CI runs exactly
this. Every behavior change needs a regression test that fails on the old
code.

Two testing conventions that bite newcomers:

- **Content-stable assertions.** Feeds regenerate weekly, so never assert
  against a committed feed's specific values (counts, dates, the `generated`
  timestamp). Build a small fixture feed inside the test instead.
- **No network in tests.** Parsers are tested against recorded fixtures;
  fetch paths take an injectable `fetchImpl`.

## Conventions

- **Zero runtime dependencies** - Node builtins only. This is a feature, not
  an accident; PRs adding a dependency will be declined.
- **Fail loudly.** Malformed input is refused with a named reason, never
  coerced into plausible data. When in doubt, throw.
- Comments are single terse lines stating what the code cannot - no stacked
  comment blocks. Rationale goes in the commit body.
- Use " - " rather than em-dashes in prose.
- Spec changes (`SPEC.md`, `schema/`) start as an issue, not a PR. Settled
  design decisions live in `docs/CONTEXT.md` - read it first; it is the
  record of what has already been decided and why.

## AI-assisted contributions

Much of this codebase was written by AI under human direction and adversarial
review - the commit history says which. Contributions are welcome however you
author them, under the same terms: you own what you submit, you have verified
it yourself, and it arrives with tests. "The model wrote it" explains nothing
in review; the diff stands or falls on its own.

## Security

If you find a vulnerability - especially in the bot's trust boundaries (feed
ingestion, plan application, the eval hook) - please use GitHub's private
vulnerability reporting rather than a public issue. Two full adversarial
review cycles are dispositioned in the issue tracker (`adversarial-review`
label); reading them first will tell you what has already been considered.
