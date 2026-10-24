# Agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Its layout table, test rules,
conventions, list of docs that tests check, and design decisions all apply to
agents. This file adds what an agent needs on top of that.

## Before you finish a change

1. Run `npm test`. It must pass offline.
2. For refresh changes, run `node refresh/refresh.mjs --check` against the live
   sources and read the semantic diff. If you regenerated feeds, confirm
   `--check` then exits 0.
3. For scanner or `--changed` changes, run `scripts/e2e-changed.mjs` as shown
   in CONTRIBUTING.md.
4. Read your own diff for stacked `//` comment blocks, em-dashes, and tests that
   assert live feed values. These are the mistakes agents make most often here.

## Feeds

- Never edit `feeds/*.json` by hand.
- If you have no network access, prove a parser change against fixtures and
  leave the committed feeds untouched. Say in your report that the feeds need a
  live regeneration. Never commit feeds generated with `--fixtures`.

## Commits

- No `Co-Authored-By` or other model-attribution trailers. Put
  "Implemented by <model>; reviewed by <model>" in the commit body instead.
- Rationale goes in the commit body, not in code comments.
- Don't commit unless you were asked to.

## Releases and publishing

These steps are usually done by the maintainer, but agents are sometimes asked
to run them.

- A merge that changes only `feeds/` and the README freshness line releases a
  patch to npm automatically.
- Any other commit since the last tag makes the next release a manual dispatch
  of `npm-release.yml` with an explicit `release_version`. Choose the version
  from the diff of the published `files` in `package.json`, not from the whole
  repository diff. Changes to `docs/` count as code commits here.
- The Pages site publishes only feeds that match a feed-refresh receipt. After
  merging feeds regenerated outside the refresh workflow, run
  `gh workflow run feed-refresh.yml --ref main` so a matching receipt exists.
