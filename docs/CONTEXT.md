# Context - read this first if you're picking the project up cold

*Written 2026-07-25, the week the problem bit. Everything in this file is
public-safe; the repo is private pre-publish but flips public later.*

## Origin

On July 23, 2026, OpenAI shut down 18 models in one scheduled wave, including
`o3-deep-research` - a model the author had a tuned research workflow on. The
companion essay ("The Model BOM," forthcoming on tomsullivan.dev) argues that the
model line in a software bill of materials is categorically different from every
other line: it can change behavior without changing version, it can vanish on the
provider's schedule regardless of pinning, and **nothing in your toolchain warns you
about either** - no npm-style install warning, no Dependabot PR, no advisory in CI.
The deprecation notice is an email and an HTML page; the first machine-visible
signal is the production 404.

This repo is the constructive half: a draft **feed format** (SPEC.md) that makes
model retirement dates machine-readable, seed **feeds** for OpenAI and Anthropic,
and a zero-dependency **reference CLI** (check.mjs) that can fail CI when a pinned
model is retired or retiring, emit a repo inventory, or build a deprecation
schedule.

## Positioning - why format-first

The niche has tools already (see LANDSCAPE below). All of them are scrapers with
private registry formats. Building a sixth scraper adds nothing; the missing layer
is the shared schema - the endoflife.date / OSV move. The endgame is providers
serving the feed themselves (`/.well-known/model-eol.json`, or a `retirement_date`
field in the models endpoint). Until then, community feeds in a common format let
N tools share data instead of N scrapers each rotting separately.

The one capability here that no existing tool has: **per-distributor lifecycles**
(`distributions` in the spec). The same model retires on different dates per channel
- o3-deep-research died at OpenAI on 2026-07-23 but lives on Azure AI Foundry until
2026-12-26; Claude 3.7 Sonnet retired at Anthropic 2026-02-19 but on Bedrock
2026-04-28. A checker ignorant of channels gives wrong answers in both directions.
`check.mjs --via azure-ai-foundry` demonstrates it working.

The product direction is **direct-first inventory**, not "CI catches everything."
Direct API usage can be scanned and checked from code. Cloud providers and gateways
often hide the exact model behind deployment names or aliases, so the scanner records
Azure/Bedrock/Vertex/OpenRouter/LiteLLM/etc. as resolver targets unless it can see a
real model ID. Model-like strings absent from the loaded feeds are emitted as
non-failing candidates so feed gaps are visible. See `docs/PRODUCT_PLAN.md`.

## LANDSCAPE (as of 2026-07-25)

| Tool | What it is | Gap |
|---|---|---|
| llm-model-deprecation (PyPI + GH Action, techdevsynergy) | directory scanner, weekly-updated registry | private registry format, no distributor clocks |
| llmstatus.ai | hosted tracker + CLI, refreshes 6h from models.dev/OpenRouter/provider APIs | own format; hosted dependency |
| llm-info (npm) | model metadata incl. deprecated mappings | metadata lib, not a CI gate |
| Khavel/ai-model-watch-data | open daily dataset (prices, context, deprecation dates) | own format |
| alexanderkatsovych/modelradar-data | open dataset, ~108 models with retirement dates/successors | own format |
| models.dev | open model-metadata registry several tools build on | capabilities-focused; not an EOL feed |
| endoflife.date | machine-readable EOL for hundreds of software products | started tracking Anthropic Claude (July 2026, `/api/anthropic-claude.json` with eol + recommendedReplacement) - one provider, no distributor clocks, no announced/shutdown split. Strongest convergence target; contribute OpenAI/Google there |

All small, all recent, all evidence of demand. The play is convergence, not
competition - see the outreach issue.

## Design decisions already made (and why)

1. **Match known IDs only, never discover.** The checker flags strings that exist in
   loaded feeds; it doesn't try to regex "anything model-shaped." Precision over
   recall for a CI gate - a false positive in CI erodes trust faster than a miss.
2. **`distributions` in the spec core, not an extension.** See above; it's the
   load-bearing novelty.
3. **Absence is data.** A feed entry with no `announced`/`shutdown` is an
   affirmative "nothing scheduled as of `generated`" - a scraper can never say that;
   a provider-served feed can. This is the strongest argument for provider adoption.
4. **`replacement` is explicitly a snapshot, not a constant.** OpenAI's recommended
   replacement for the deep-research models changed *during* the notice window
   (gpt-5.6-sol didn't GA until 2026-07-09, two weeks before the shutoff). The spec
   says so; tools should re-read, not cache forever.
5. **Zero-dependency Node for the reference checker.** The tool that guards against
   dependency rot should not itself be a dependency tree. Same reason the validator
   (PR #1) hand-rolls structural checks instead of pulling ajv.
6. **Dates are UTC ISO, day precision.** Providers announce days, not instants.
7. **Cloud/gateway references are inventory hints until resolved.** Static code can
   identify that a repo uses Azure Foundry, Bedrock, Vertex, OpenRouter, LiteLLM, or
   Portkey, but it usually cannot prove the deployed model behind an alias. Resolver
   integrations should enrich inventory output later.
8. **Alerting starts stateless.** `check.mjs alert` emits GitHub Actions annotations,
   Markdown, badge JSON, or JSON and exits nonzero on retired/retiring findings. The
   bot adapter (bot/) is the stateful consumer: it reads `plan --json` over a
   subprocess boundary and keeps all its state in GitHub PR/issue metadata blocks.
9. **Patch gating is strict.** Only high-confidence direct-api findings with a
   feed-resolvable, non-retiring replacement are auto-patchable; generic
   model-references, cloud/gateway hints, and publisher-fallback clocks are
   issue-only; candidates never generate work items at all.
10. **`--via` semantics.** A distribution entry without `shutdown` means "no
   retirement scheduled on that channel" - it never inherits the publisher clock.
   Only a missing distribution entry falls back, labelled `publisher-fallback`,
   which is never patchable. (The original conservative-fallback read told Azure
   shops their models were dead five months early.)
11. **Informational is not changed.** refresh `--check` exits 3 only when generated
   files materially differ; unconfirmed entries and no-publisher-feed rows render
   in the diff but do not trip it (a keyless weekly run would otherwise open a
   no-op PR forever - the first live workflow dispatch proved it).
12. **Policy floors are stated policy, not contracts** - the wording in SPEC.md and
   the schedule output says exactly that, and feeds without a stated floor make no
   forward claim.
13. **The eval hook is a security boundary.** Config-supplied command, so: separate
   least-privilege job, scrubbed env namespace, bounded runtime and report size,
   report treated as untrusted content in PR bodies.
14. **No model-attribution trailers on commits.** Implementation is a mix of Claude
   and Codex delegation; per-commit honesty lives in commit bodies ("Implemented by
   Codex (gpt-5.6-luna); reviewed by Claude"), never in Co-Authored-By trailers.
   History was rewritten 2026-08-01 to enforce this.
15. **Structured replacement fields are settled.** `replacement` is a single exact
   model ID that resolves against an id or alias in the same feed and is safe as a
   drop-in string substitution. This is the ONLY field plan/apply may patch from.
   Otherwise absent. `replacement_options` is an optional ordered array of exact
   model IDs that must pass the identifier grammar, but feed resolution is NOT
   required since a target may not be carried yet. `replacement_note` is optional
   free-text guidance for parameter requirements or prose alternatives. Options and
   notes are issue-only; the planner never auto-patches from options and patches
   `replacement` exclusively.

## Publish gates (do not flip public before)

1. The companion essay is live (this repo is its artifact; sequence matters).
2. ~~Feeds re-verified against provider pages on publish day~~ DONE and automated:
   feeds regenerated from live sources 2026-08-01; the weekly feed-refresh
   workflow keeps them verified.
3. ~~Name decision~~ RESOLVED 2026-08-01: keep "model-eol". npm name verified free,
   no GitHub collisions, and endoflife.date entering LLM tracking strengthens the
   lineage argument. package.json is publish-ready; npm publish is Tom's call.
4. Sweep this repo for anything non-public-safe (should be nothing; keep it that way
   - write every commit as if the repo were already public).

## State as of 2026-08-01 (v0.1.0 tagged, v0.1.1 in progress)

Shipped and field-tested: hardened scanner (git ls-files traversal), plan/apply
with strict gating, bot adapter (PR/issue lifecycle, sandboxed eval hook),
refresh tooling (OpenAI + Anthropic pages, models endpoints, aws-bedrock
distributor clocks), policy floors + safe_until/earliest-risk, --changed PR
gate, CycloneDX export, badge + Atom changelog outputs, strict parseArgs CLIs
with TTY colors, VHS demo, weekly feed-refresh workflow LIVE in this repo
(verified green on GitHub runners).

Field-test receipts: found claude-sonnet-4-20250514 dead 47 days in
hybrid-coach's promptfoo config; fleet sweep found ~230 retired refs across
Tom's repos (most are kew pricing-key noise - ignore-config material);
feed drift caught within one week of hand compilation; a hand-compiled Bedrock
date corrected by three months.

Remaining, Tom-side: npm publish (then the auto patch-release workflow -
caniuse-lite pattern), activating ci/bot workflows from their .example files,
provider API key secrets for models-endpoint coverage (this is what populates
current-model entries and policy-floor horizons), the essay, the public flip.
Remaining, backlog: Google/Vertex/Azure fetchers, gateway resolvers, monorepo
ownership groups, feed signing, feeds-dir self-scan exclusion.

## Conventions

- Prose in this repo uses " - " (space-hyphen-space), never em-dash glyphs.
- Every feed entry claiming a date must carry a `source` URL (feed-level or
  entry-level) so claims are auditable.
- check.mjs stays a thin dispatcher; logic lives in lib/. (The original "checker
  under ~200 lines" rule outgrew reality at v0.1.0 - the spirit survives as: the
  reference implementation stays small, readable, and zero-dependency; complexity
  goes in the spec discussion.)

## Related work by the author

- The companion essay draft and its research live in the author's content
  workspace; the essay's mitigation ladder (harness -> evals -> structural seams)
  is the strategic frame this tool slots into (rung two: "make retirement dates
  fail CI").
- `docs/RESEARCH.md` in this repo carries the public receipts - deprecation
  history, policy floors, drift evidence - so this repo argues for itself without
  external context.
